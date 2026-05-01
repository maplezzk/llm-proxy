import { describe, it } from 'node:test'
import assert from 'node:assert'
import { ConfigStore } from '../../src/config/store.js'
import { StatusTracker } from '../../src/status/tracker.js'
import { Logger } from '../../src/log/logger.js'
import type { Config } from '../../src/config/types.js'
import { handleGetConfig, handleReload, handleHealth, handleStatus } from '../../src/api/handlers/index.js'
import type { OutgoingHttpHeaders } from 'node:http'

function createConfig(): Config {
  return {
    providers: [
      { name: 'p1', type: 'openai', apiKey: 'sk-123', models: [{ id: 'mv1' }] },
    ],
  }
}

function mockRes() {
  let body = ''
  let status = 200
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    writeHead: (s: number, _headers?: OutgoingHttpHeaders) => {
      status = s
    },
    end: (data: string) => {
      body = data
    },
    setHeader: () => {},
    getHeader: () => undefined,
    getStatus: () => status,
    getBody: () => body,
  }
}

type MockRes = ReturnType<typeof mockRes>

describe('api/handlers', () => {
  it('GET /admin/config 返回脱敏配置', () => {
    const store = new ConfigStore('/fake', createConfig())
    const tracker = new StatusTracker()
    const ctx = { store, tracker, logger: new Logger() }
    const res = mockRes()
    handleGetConfig(ctx, {} as never, res as never)
    const data = JSON.parse(res.getBody())
    assert.strictEqual(data.success, true)
    assert.strictEqual(data.data.providers[0].api_key, 'sk-123')
  })

  it('GET /admin/health 返回 ok', () => {
    const store = new ConfigStore('/fake', createConfig())
    const tracker = new StatusTracker()
    const ctx = { store, tracker, logger: new Logger() }
    const res = mockRes()
    handleHealth(ctx, {} as never, res as never)
    const data = JSON.parse(res.getBody())
    assert.strictEqual(data.data.status, 'ok')
  })

  it('POST /admin/config/reload 失败时返回错误', async () => {
    const store = new ConfigStore('/nonexistent', createConfig())
    const tracker = new StatusTracker()
    const ctx = { store, tracker, logger: new Logger() }
    const res = mockRes()
    await handleReload(ctx, {} as never, res as never)
    const data = JSON.parse(res.getBody())
    assert.strictEqual(data.success, false)
  })

  it('GET /admin/status/providers 返回结构', () => {
    const store = new ConfigStore('/fake', createConfig())
    const tracker = new StatusTracker()
    const ctx = { store, tracker, logger: new Logger() }
    const res = mockRes()
    handleStatus(ctx, {} as never, res as never)
    const data = JSON.parse(res.getBody())
    assert.strictEqual(data.success, true)
    assert.ok(Array.isArray(data.data.providers))
    assert.strictEqual(data.data.providers.length, 1)
    assert.strictEqual(data.data.providers[0].name, 'p1')
  })
})
