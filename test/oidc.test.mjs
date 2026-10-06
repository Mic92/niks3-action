import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const EXP = 2000000000

async function run(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (err += d))
  const [code] = await once(child, 'close')
  assert.equal(code, 0, err + out)
  return out
}

// Fake niks3 server and GitHub OIDC endpoint in one.
async function startServer(t) {
  let requests = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/api/cache-config') {
      res.end(JSON.stringify({ oidc_audience: 'test-cache', public_keys: [] }))
      return
    }
    assert.equal(req.headers.authorization, 'Bearer request-token')
    assert.equal(url.searchParams.get('audience'), 'test-cache')
    // jti makes every token distinct so tests can tell refreshes apart.
    const payload = { exp: EXP, jti: ++requests }
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    res.end(JSON.stringify({ value: `header.${body}.signature` }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${server.address().port}` }
}

test('skip-push still provides a refreshing OIDC helper', async (t) => {
  const server = await startServer(t)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'niks3-test-'))
  t.after(() => fs.rm(tmp, { recursive: true, force: true }))

  const output = path.join(tmp, 'output')
  const files = [output, path.join(tmp, 'state'), path.join(tmp, 'env')]
  await Promise.all(files.map((f) => fs.writeFile(f, '')))

  const env = {
    ...process.env,
    RUNNER_TEMP: tmp,
    GITHUB_OUTPUT: output,
    GITHUB_STATE: files[1],
    GITHUB_ENV: files[2],
    'INPUT_SERVER-URL': server.url,
    'INPUT_SKIP-PUSH': 'true',
    'INPUT_NIKS3-BIN': '/unused/niks3',
    INPUT_DEBUG: 'false',
    ACTIONS_ID_TOKEN_REQUEST_URL: `${server.url}/token`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
  }
  delete env.STATE_isPost
  await run(['dist/index.cjs'], env)

  const workDir = path.join(tmp, 'niks3')
  assert.doesNotMatch(await fs.readFile(path.join(workDir, 'nix.conf'), 'utf8'), /post-build-hook/)
  assert.match(await fs.readFile(output, 'utf8'), /auth-token-script<</)

  const helper = path.join(workDir, 'fetch-oidc-token.mjs')
  const first = JSON.parse(await run([helper], env))
  const second = JSON.parse(await run([helper], env))
  assert.notEqual(first.token, second.token)
  assert.equal(first.expires_at, new Date(EXP * 1000).toISOString())
})
