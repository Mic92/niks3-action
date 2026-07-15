// niks3 GitHub Action: configures a Nix substituter and pushes built store
// paths to a niks3 binary cache via the niks3-hook upload daemon.
//
// All GitHub-specific orchestration lives here. niks3 itself only provides
// the upload daemon (niks3-hook serve), the post-build-hook client
// (niks3-hook send), the one-shot push CLI (niks3 push), and the server's
// /api/cache-config endpoint.

import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Baked at bundle time via esbuild --define. Matches the git tag and the
// goreleaser release name so `Mic92/niks3-action@v1.6.0` downloads
// `niks3_<plat>.tar.gz` from the v1.6.0 release of Mic92/niks3.
declare const NIKS3_VERSION: string

// GitHub Actions' OIDC issuer — a well-known constant.
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'

const isPost = !!core.getState('isPost')

async function main(): Promise<void> {
  if (isPost) {
    await post()
  } else {
    core.saveState('isPost', 'true')
    await setup()
  }
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

interface CacheConfig {
  substituter_url: string
  public_keys: string[]
  oidc_audience: string
}

interface ResolvedConfig {
  serverURL: string
  substituter: string
  publicKeys: string[]
  audience: string
  skipPush: boolean
  debug: boolean
}

async function setup(): Promise<void> {
  const binDir = await resolveBinDir()
  const workDir = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'niks3')
  fs.mkdirSync(workDir, { recursive: true })

  const cfg = await resolveConfig()

  writeNixConf(workDir, cfg)

  const mode = await pickMode(cfg)
  core.info(`Push mode: ${mode}`)

  switch (mode) {
    case 'daemon':
      await startDaemon(binDir, workDir, cfg)
      break
    case 'storescan':
      writeStoreSnapshot(path.join(workDir, 'store-pre'))
      break
    case 'none':
      break
  }

  core.saveState('mode', mode)
  core.saveState('workDir', workDir)
  core.saveState('binDir', binDir)
  core.saveState('serverURL', cfg.serverURL)
  core.saveState('audience', cfg.audience)
  core.saveState('debug', String(cfg.debug))
}

async function resolveConfig(): Promise<ResolvedConfig> {
  const serverURL = core.getInput('server-url', { required: true })

  const fetched = await fetchCacheConfig(serverURL)

  // The substituter override exists to point pulls at a CDN/mirror in front
  // of the cache. Public keys and OIDC audience are tied to the server and
  // have no sensible override.
  const substituter = core.getInput('substituter') || fetched?.substituter_url || ''

  return {
    serverURL,
    substituter,
    publicKeys: fetched?.public_keys ?? [],
    audience: fetched?.oidc_audience ?? '',
    skipPush: core.getBooleanInput('skip-push'),
    debug: core.getBooleanInput('debug'),
  }
}

async function fetchCacheConfig(serverURL: string): Promise<CacheConfig | null> {
  const u = new URL('/api/cache-config', serverURL)

  if (process.env.FORGEJO_SERVER_URL) {
    // Forgejo's OIDC issuer URL
    // https://forgejo.org/docs/next/user/actions/security-openid-connect/#standard-claims
    u.searchParams.set('issuer', `${process.env.FORGEJO_SERVER_URL}/api/actions`)
  } else {
    u.searchParams.set('issuer', GITHUB_ISSUER)
  }

  // Configurable so slow-to-start servers have time to boot.
  const timeoutMs = positiveIntInput('cache-config-timeout', 15) * 1000
  const retries = positiveIntInput('cache-config-retries', 3)

  let lastErr: unknown
  let retryAfterMs: number | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = retryAfterMs ?? Math.min(1000 * 2 ** (attempt - 1), 30000)
      core.info(
        `retrying cache-config in ${delay / 1000}s (attempt ${attempt + 1}/${retries + 1})`,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
    retryAfterMs = null
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) })
      if (res.ok) return (await res.json()) as CacheConfig
      lastErr = new Error(`server returned ${res.status}`)
      // Client errors (except 429) won't resolve on retry.
      if (res.status < 500 && res.status !== 429) break
      retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
    } catch (err) {
      lastErr = err
    }
  }
  core.warning(`could not fetch cache-config from server: ${lastErr}`)
  return null
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const secs = Number(value)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60000)
  const date = Date.parse(value)
  if (Number.isNaN(date)) return null
  return Math.min(Math.max(date - Date.now(), 0), 60000)
}

function positiveIntInput(name: string, fallback: number): number {
  const raw = core.getInput(name)
  if (raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`input '${name}' must be a non-negative integer, got '${raw}'`)
  }
  return n
}

// writeNixConf drops a nix.conf snippet and registers it via
// NIX_USER_CONF_FILES so subsequent `nix` invocations pick it up without a
// daemon restart. The post-build-hook line is added by startDaemon once
// daemon mode is confirmed.
function writeNixConf(workDir: string, cfg: ResolvedConfig): void {
  let body = ''
  if (cfg.substituter) body += `extra-substituters = ${cfg.substituter}\n`
  if (cfg.publicKeys.length > 0)
    body += `extra-trusted-public-keys = ${cfg.publicKeys.join(' ')}\n`

  const confPath = path.join(workDir, 'nix.conf')
  // World-readable: the nix daemon reads it as a different user.
  fs.writeFileSync(confPath, body, { mode: 0o644 })

  // Prepend to the existing search path so we don't mask ~/.config/nix/nix.conf.
  const existing = process.env.NIX_USER_CONF_FILES ?? defaultUserConfFiles()
  core.exportVariable('NIX_USER_CONF_FILES', `${confPath}:${existing}`)
}

function defaultUserConfFiles(): string {
  const home = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
  const dirs = (process.env.XDG_CONFIG_DIRS ?? '/etc/xdg').split(':')
  return [home, ...dirs].map((d) => path.join(d, 'nix', 'nix.conf')).join(':')
}

// pickMode decides daemon vs storescan vs none.
//   none:      skip-push set, OR no OIDC available (fork PR), OR no audience
//   storescan: OIDC available but runner user can't set post-build-hook
//   daemon:    OIDC available and user is trusted (the happy path)
async function pickMode(cfg: ResolvedConfig): Promise<'daemon' | 'storescan' | 'none'> {
  if (cfg.skipPush) {
    core.info('skip-push set; configuring substituter only')
    return 'none'
  }

  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    core.info('No OIDC token available (fork PR or missing id-token:write); configuring substituter only')
    return 'none'
  }

  if (!cfg.audience) {
    core.warning(
      `no OIDC audience configured — configure an OIDC provider with issuer ${GITHUB_ISSUER} on the server`,
    )
    return 'none'
  }

  if (!isTrustedUser()) {
    core.warning(
      "runner user is not in Nix trusted-users; falling back to store-scan push (intermediate derivations won't be cached on build failure)",
    )
    return 'storescan'
  }

  return 'daemon'
}

// isTrustedUser reports whether the current user can set post-build-hook.
// A trusted user (or a writable store, i.e. single-user Nix) is required for
// the hook to fire. Mirrors Nix's own check.
function isTrustedUser(): boolean {
  // Single-user install: store is directly writable, no daemon, hooks
  // run unconditionally.
  try {
    fs.accessSync('/nix/store', fs.constants.W_OK)
    return true
  } catch {
    /* multi-user; check trusted-users */
  }

  const username = os.userInfo().username
  let trusted: string[]
  try {
    const out = execFileSync('nix', ['config', 'show'], { encoding: 'utf8', timeout: 10000 })
    const line = out.split('\n').find((l) => l.startsWith('trusted-users = '))
    trusted = line ? line.slice('trusted-users = '.length).trim().split(/\s+/) : []
  } catch {
    return false
  }

  return trusted.includes(username) || trusted.includes('*')
}

// startDaemon writes the post-build-hook shim, the OIDC token script, and
// forks `niks3-hook serve` detached in its own process group so the runner's
// step-end cleanup doesn't take it down early.
async function startDaemon(binDir: string, workDir: string, cfg: ResolvedConfig): Promise<void> {
  const hookBin = path.join(binDir, 'niks3-hook')
  const socket = socketPath(workDir)
  const tokenScript = writeTokenScript(workDir, cfg.audience)

  // post-build-hook runs with a stripped env (only DRV_PATH + OUT_PATHS per
  // `man nix.conf`); the shim bakes in absolute paths resolved now.
  const shim = path.join(workDir, 'post-build-hook')
  fs.writeFileSync(shim, `#!/bin/sh\nexec ${q(hookBin)} send --socket ${q(socket)}\n`, { mode: 0o755 })

  // Append the hook line to the nix.conf we already wrote.
  fs.appendFileSync(path.join(workDir, 'nix.conf'), `post-build-hook = ${shim}\n`)

  const dbPath = path.join(workDir, 'queue.db')
  const logPath = path.join(workDir, 'daemon.log')
  const logFD = fs.openSync(logPath, 'w')

  const args = [
    'serve',
    '--socket', socket,
    '--db-path', dbPath,
    '--server-url', cfg.serverURL,
    '--auth-token-script', tokenScript,
    '--idle-exit-timeout', '0',
  ]
  if (cfg.debug) args.push('--debug')

  // Resolve the binary up front so a missing file is a synchronous error
  // here, not an async 'error' event after spawn returns.
  fs.accessSync(hookBin, fs.constants.X_OK)

  const child = spawn(hookBin, args, {
    detached: true,
    stdio: ['ignore', logFD, logFD],
  })
  // Spawn-time errors (race after the access check) crash the process if
  // unhandled. Log and let the post step's missing-pid warning explain.
  child.on('error', (e) => core.warning(`niks3-hook serve spawn error: ${e}`))
  child.unref()
  fs.closeSync(logFD)

  if (!child.pid) throw new Error('failed to start niks3-hook serve: no pid')

  // serve binds the socket late (after sqlite + `nix eval`); send swallows
  // connect errors. Block until the socket exists so fast builds aren't lost.
  const deadline = Date.now() + 10000
  while (!fs.existsSync(socket)) {
    try { process.kill(child.pid, 0) } catch { throw new Error('niks3-hook serve exited before binding socket') }
    if (Date.now() > deadline) throw new Error(`niks3-hook serve did not bind ${socket} within 10s`)
    await sleep(50)
  }

  core.info(`niks3-hook serve started (pid ${child.pid}, socket ${socket})`)
  core.setOutput('auth-token-script', tokenScript)
  core.setOutput('socket', socket)
  core.saveState('daemonPid', String(child.pid))
  core.saveState('daemonLog', logPath)
}

// writeTokenScript drops a self-contained node script that prints
// {"token","expires_at"} JSON. niks3-hook serve runs it via
// --auth-token-script; the audience is baked in at write time because the
// daemon runs detached and inherits a stripped env.
function writeTokenScript(workDir: string, audience: string): string {
  const reqURL = process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? ''
  const reqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? ''

  const file = path.join(workDir, 'fetch-oidc-token.mjs')
  fs.writeFileSync(
    file,
    `const u = new URL(${JSON.stringify(reqURL)})
u.searchParams.set('audience', ${JSON.stringify(audience)})
const res = await fetch(u, { headers: { Authorization: 'Bearer ' + ${JSON.stringify(reqToken)} } })
if (!res.ok) { process.stderr.write('OIDC endpoint returned ' + res.status + '\\n'); process.exit(1) }
const { value } = await res.json()
const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString())
const out = { token: value }
if (payload.exp) out.expires_at = new Date(payload.exp * 1000).toISOString()
process.stdout.write(JSON.stringify(out))
`,
    { mode: 0o600 },
  )

  return `${process.execPath} ${file}`
}

// writeStoreSnapshot lists store paths one-per-line. Used in storescan mode.
function writeStoreSnapshot(file: string): void {
  fs.writeFileSync(file, listStorePaths().join('\n') + '\n')
}

// listStorePaths returns absolute store paths, filtering out non-path entries
// like .links/ and .lock files.
function listStorePaths(): string[] {
  const dir = '/nix/store'
  return fs
    .readdirSync(dir)
    .filter((n) => !n.startsWith('.') && n.length > 32 && n[32] === '-')
    .map((n) => path.join(dir, n))
    .sort()
}

// socketPath: Unix socket paths are limited to 104 (darwin) / 108 (linux)
// bytes including the null terminator. Fall back to os.tmpdir() if too long.
function socketPath(workDir: string): string {
  // sockaddr_un.sun_path is 104 bytes on darwin, 108 on linux — including
  // the null terminator, so the path itself must be shorter by one.
  const limit = (os.platform() === 'darwin' ? 104 : 108) - 1
  const candidate = path.join(workDir, 'daemon.sock')
  return candidate.length <= limit ? candidate : path.join(os.tmpdir(), 'niks3-daemon.sock')
}

// ---------------------------------------------------------------------------
// Post step
// ---------------------------------------------------------------------------

async function post(): Promise<void> {
  const mode = core.getState('mode')

  switch (mode) {
    case 'daemon':
      await stopDaemon()
      break
    case 'storescan':
      pushStoreDiff()
      break
    default:
      // 'none' or empty (setup failed before saving state): nothing to do.
      break
  }
}

// stopDaemon SIGTERMs the niks3-hook daemon and waits for it to drain.
async function stopDaemon(): Promise<void> {
  const pid = parseInt(core.getState('daemonPid') || '0', 10)
  if (!pid) {
    core.warning('niks3-hook daemon pid not recorded; nothing to stop')
    return
  }

  const timeoutSec = parseInt(core.getInput('drain-timeout') || '600', 10)
  const logPath = core.getState('daemonLog')

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already dead.
    return
  }

  const deadline = Date.now() + timeoutSec * 1000
  let lastBeat = Date.now()
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      core.notice('niks3: upload daemon drained')
      return
    }
    // Heartbeat so the runner's no-output watchdog doesn't kill the job.
    if (Date.now() - lastBeat > 30000) {
      core.info('waiting for upload daemon to drain...')
      lastBeat = Date.now()
    }
    await sleep(500)
  }

  core.warning(`niks3-hook daemon did not drain within ${timeoutSec}s; killing (log: ${logPath})`)
  try {
    process.kill(-pid, 'SIGKILL') // negative pid = process group
  } catch {
    /* already gone */
  }
}

// alive reports whether pid is still running. kill(pid, 0) alone is
// insufficient: it succeeds for unreaped zombies, which occur on container
// runners whose PID 1 is not a reaping init (act/Forgejo docker, #18).
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      // /proc/pid/stat: "pid (comm) S ..." — comm may contain ')', so the
      // state char is the first char after the last ')'.
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
      if (state === 'Z') return false
    } catch {
      return false // raced with exit
    }
  }
  return true
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// pushStoreDiff lists store paths added since setup's snapshot and pushes
// them in one shot via `niks3 push`.
function pushStoreDiff(): void {
  const workDir = core.getState('workDir')
  const binDir = core.getState('binDir')
  const before = new Set(
    fs
      .readFileSync(path.join(workDir, 'store-pre'), 'utf8')
      .split('\n')
      .filter(Boolean),
  )
  const added = listStorePaths().filter((p) => !before.has(p))

  if (added.length === 0) {
    core.notice('niks3: no new store paths to push')
    return
  }

  core.startGroup(`niks3: pushing ${added.length} paths`)
  try {
    const tokenScript = writeTokenScript(workDir, core.getState('audience'))
    const args = [
      'push',
      '--server-url', core.getState('serverURL'),
      '--auth-token-script', tokenScript,
    ]
    if (core.getState('debug') === 'true') args.push('--debug')
    args.push(...added)

    const r = spawnSync(path.join(binDir, 'niks3'), args, { stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`niks3 push exited ${r.status}`)
    core.notice(`niks3: pushed ${added.length} paths`)
  } catch (err) {
    core.warning(`niks3: storescan push failed: ${err}`)
  } finally {
    core.endGroup()
  }
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

async function resolveBinDir(): Promise<string> {
  const override = core.getInput('niks3-bin')
  if (override) {
    core.info(`Using niks3 binary from input: ${override}`)
    return path.dirname(override)
  }

  const plat = platformTuple()
  const cached = tc.find('niks3', NIKS3_VERSION, plat)
  if (cached) {
    core.info(`Found cached niks3 ${NIKS3_VERSION} (${plat})`)
    return cached
  }

  const url = `https://github.com/Mic92/niks3/releases/download/${NIKS3_VERSION}/niks3_${plat}.tar.gz`
  core.info(`Downloading niks3 ${NIKS3_VERSION} from ${url}`)

  const tarball = await tc.downloadTool(url)
  const extracted = await tc.extractTar(tarball)
  return tc.cacheDir(extracted, 'niks3', NIKS3_VERSION, plat)
}

// platformTuple returns the goreleaser archive suffix (e.g. "Linux_x86_64").
function platformTuple(): string {
  const sys: Record<string, string> = { linux: 'Linux', darwin: 'Darwin' }
  const arch: Record<string, string> = { x64: 'x86_64', arm64: 'arm64' }
  const s = sys[os.platform()]
  const a = arch[os.arch()]
  if (!s || !a) throw new Error(`unsupported platform: ${os.platform()}/${os.arch()}`)
  return `${s}_${a}`
}

// q shell-quotes a single argument for the post-build-hook shim.
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

main().catch((err: Error) => {
  if (isPost) {
    core.warning(`post step failed: ${err.message}`)
  } else {
    core.setFailed(err.message)
  }
})
