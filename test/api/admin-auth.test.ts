import { after, before, describe, it } from 'node:test'
import assert from 'node:assert'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProxyServer } from '../../src/api/server.js'
import { ConfigStore } from '../../src/config/store.js'
import { StatusTracker } from '../../src/status/tracker.js'
import { UsageStore } from '../../src/status/usage-store.js'
import { Logger } from '../../src/log/logger.js'
import { AdminHandoffStore } from '../../src/api/handlers/admin-handoff.js'

describe('admin API authentication', () => {
  let server: Server
  let usageStore: UsageStore
  let baseURL: string

  before(async () => {
    const store = new ConfigStore('/fake/admin-auth-test', {
      adminKey: 'admin-secret',
      providers: [],
    })
    usageStore = new UsageStore(join(mkdtempSync(join(tmpdir(), 'admin-auth-')), 'usage.db'))
    server = createProxyServer({
      adminHost: '127.0.0.1',
      adminPort: 0,
      proxyHost: '127.0.0.1',
      proxyPort: 0,
      store,
      tracker: new StatusTracker(),
      usageStore,
      logger: new Logger(20),
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    usageStore.close()
  })

  it('rejects missing or invalid admin credentials', async () => {
    const missing = await fetch(`${baseURL}/admin/health`)
    assert.strictEqual(missing.status, 401)
    assert.match(await missing.text(), /管理 API Key 无效/)

    const invalid = await fetch(`${baseURL}/admin/health`, {
      headers: { 'x-api-key': 'wrong-secret' },
    })
    assert.strictEqual(invalid.status, 401)
  })

  it('accepts Bearer and x-api-key admin credentials', async () => {
    const bearer = await fetch(`${baseURL}/admin/health`, {
      headers: { Authorization: 'Bearer admin-secret' },
    })
    assert.strictEqual(bearer.status, 200)

    const apiKey = await fetch(`${baseURL}/admin/health`, {
      headers: { 'x-api-key': 'admin-secret' },
    })
    assert.strictEqual(apiKey.status, 200)
  })

  it('serves the admin UI shell without credentials so a browser can enter its key', async () => {
    const page = await fetch(`${baseURL}/admin`)
    assert.strictEqual(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /text\/html/)
    assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer')

    const trailingSlash = await fetch(`${baseURL}/admin/`)
    assert.strictEqual(trailingSlash.status, 200)
  })

  it('does not apply admin authentication to proxy routes or CORS preflight', async () => {
    const models = await fetch(`${baseURL}/v1/models`)
    assert.strictEqual(models.status, 200)

    const preflight = await fetch(`${baseURL}/admin/health`, { method: 'OPTIONS' })
    assert.strictEqual(preflight.status, 204)
  })

  it('issues an authenticated one-time handoff and exchanges it without putting the key in the URL', async () => {
    const missing = await fetch(`${baseURL}/admin/auth/handoff`, { method: 'POST' })
    assert.strictEqual(missing.status, 401)

    const issued = await fetch(`${baseURL}/admin/auth/handoff`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret' },
    })
    assert.strictEqual(issued.status, 200)
    assert.strictEqual(issued.headers.get('cache-control'), 'no-store')
    const issueBody = await issued.json() as any
    const code = issueBody.data.code as string
    assert.ok(code.length >= 40)
    assert.ok(!code.includes('admin-secret'))

    const exchanged = await fetch(`${baseURL}/admin/auth/handoff/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.test' },
      body: JSON.stringify({ code }),
    })
    assert.strictEqual(exchanged.status, 200)
    assert.strictEqual(exchanged.headers.get('cache-control'), 'no-store')
    assert.strictEqual(exchanged.headers.get('access-control-allow-origin'), null)
    assert.strictEqual(((await exchanged.json()) as any).data.key, 'admin-secret')

    const replay = await fetch(`${baseURL}/admin/auth/handoff/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    assert.strictEqual(replay.status, 401)
  })

  it('expires handoff codes and invalidates them after key rotation', () => {
    let now = 1_000
    const expiring = new AdminHandoffStore(50, () => now)
    const expiredCode = expiring.issue('admin-secret').code
    now += 51
    assert.strictEqual(expiring.exchange(expiredCode, 'admin-secret'), null)

    const rotating = new AdminHandoffStore()
    const rotatedCode = rotating.issue('old-secret').code
    assert.strictEqual(rotating.exchange(rotatedCode, 'new-secret'), null)
  })
})
