import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

async function run(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, stderr + stdout)
  return stdout
}

test('skip-push exposes a refreshing OIDC helper without enabling automatic uploads', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'niks3-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  let requests = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/api/cache-config') {
      res.end(JSON.stringify({ oidc_audience: 'test-cache', public_keys: [] }))
    } else {
      assert.equal(req.headers.authorization, 'Bearer request-token')
      assert.equal(url.searchParams.get('audience'), 'test-cache')
      const payload = Buffer.from(JSON.stringify({ exp: 2000000000, jti: ++requests })).toString('base64url')
      res.end(JSON.stringify({ value: `header.${payload}.signature` }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}`
  for (const oidc of [true, false]) {
    const temp = path.join(dir, String(oidc))
    await fs.mkdir(temp)
    const output = path.join(temp, 'output'), state = path.join(temp, 'state'), envFile = path.join(temp, 'env')
    await Promise.all([output, state, envFile].map(file => fs.writeFile(file, '')))
    const env = { ...process.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: output, GITHUB_STATE: state, GITHUB_ENV: envFile,
      'INPUT_SERVER-URL': url, 'INPUT_SKIP-PUSH': 'true', 'INPUT_NIKS3-BIN': '/unused/niks3', INPUT_DEBUG: 'false',
      ACTIONS_ID_TOKEN_REQUEST_URL: `${url}/token`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: oidc ? 'request-token' : '' }
    delete env.STATE_isPost
    await run(['dist/index.cjs'], env)
    const outputs = await fs.readFile(output, 'utf8')
    assert.match(await fs.readFile(state, 'utf8'), /mode<<[^\n]+\nnone\n/)
    assert.doesNotMatch(await fs.readFile(path.join(temp, 'niks3/nix.conf'), 'utf8'), /post-build-hook/)
    assert.equal(outputs.includes('auth-token-script<<'), oidc)
    if (oidc) {
      const helper = path.join(temp, 'niks3/fetch-oidc-token.mjs')
      assert.equal((await fs.stat(helper)).mode & 0o777, 0o600)
      const first = JSON.parse(await run([helper], env))
      const second = JSON.parse(await run([helper], env))
      assert.notEqual(first.token, second.token)
      assert.equal(first.expires_at, new Date(2000000000 * 1000).toISOString())
      assert.equal(requests, 2)
    }
  }
})
