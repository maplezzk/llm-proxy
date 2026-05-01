import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { createServer as createHttpServer } from 'node:http'
import type { Server } from 'node:http'
import { createProxyServer } from '../../src/api/server.js'
import { ConfigStore } from '../../src/config/store.js'
import { StatusTracker } from '../../src/status/tracker.js'
import { Logger } from '../../src/log/logger.js'
import type { Config } from '../../src/config/types.js'

const PORT = 19800

let mockServer: Server
const mockRequests: { method: string; url: string; body: Record<string, unknown> }[] = []

function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    mockRequests.length = 0
    mockServer = createHttpServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c))
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}')
        mockRequests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body: parsed })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1234567890,
          model: parsed.model ?? 'unknown',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }))
      })
    })
    mockServer.listen(PORT, '127.0.0.1', resolve)
  })
}

function createTestConfig(): Config {
  return {
    providers: [
      { name: 'test-openai', type: 'openai', apiKey: 'sk-test', apiBase: `http://127.0.0.1:${PORT}`, models: [{ id: 'gpt-4o-test' }] },
    ],
    adapters: [
      { name: 'my-tool', type: 'openai', models: [{ sourceModelId: 'my-model', provider: 'test-openai', targetModelId: 'gpt-4o-test' }] },
    ],
  }
}

describe('adapter/handlers', { timeout: 10000 }, () => {
  let server: Server
  let mockCleanup: () => void

  before(async () => {
    await startMockServer()
    mockCleanup = () => { mockServer?.close() }

    const store = new ConfigStore('/fake', createTestConfig())
    const tracker = new StatusTracker()
    const logger = new Logger()
    server = createProxyServer({
      adminHost: '127.0.0.1', adminPort: PORT + 1,
      proxyHost: '127.0.0.1', proxyPort: PORT + 1,
      store, tracker, logger,
    })
    await new Promise<void>((resolve) => server.listen(PORT + 1, '127.0.0.1', resolve))
  })

  after(() => {
    server?.close()
    mockCleanup?.()
  })

  it('通过适配器端点转发请求成功', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT + 1}/my-tool/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'my-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const data = await resp.json()
    assert.strictEqual(data.object, 'chat.completion')
    assert.ok((data.choices[0].message.content as string).includes('ok'))
  })

  it('适配器名称不存在返回 404', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT + 1}/nonexistent/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'my-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.strictEqual(resp.status, 404)
    const data = await resp.json()
    assert.ok((data.error.message as string).includes('未找到'))
  })

  it('模型映射不存在返回 404', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT + 1}/my-tool/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nonexistent', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.strictEqual(resp.status, 404)
  })

  it('非 JSON 请求体返回 400', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT + 1}/my-tool/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not-json',
    })
    assert.strictEqual(resp.status, 400)
  })

  it('Anthropic 格式适配器端点', async () => {
    const config: Config = {
      providers: [
        { name: 'test-openai', type: 'openai', apiKey: 'sk-test', apiBase: `http://127.0.0.1:${PORT}`, models: [{ id: 'gpt-4o-test' }] },
      ],
      adapters: [
        { name: 'cli-tool', type: 'anthropic', models: [{ sourceModelId: 'sonnet', provider: 'test-openai', targetModelId: 'gpt-4o-test' }] },
      ],
    }
    const store = new ConfigStore('/fake', config)
    const tracker = new StatusTracker()
    const logger = new Logger()
    const s = createProxyServer({
      adminHost: '127.0.0.1', adminPort: PORT + 2,
      proxyHost: '127.0.0.1', proxyPort: PORT + 2,
      store, tracker, logger,
    })
    await new Promise<void>((resolve) => s.listen(PORT + 2, '127.0.0.1', resolve))

    try {
      const resp = await fetch(`http://127.0.0.1:${PORT + 2}/cli-tool/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.strictEqual(resp.status, 200)
      const data = await resp.json()
      // 跨协议响应转换：OpenAI → Anthropic 格式
      assert.strictEqual(data.type, 'message')
      assert.strictEqual(data.role, 'assistant')
    } finally {
      s.close()
    }
  })

  it('请求体缺少 model 字段返回 400', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT + 1}/my-tool/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.strictEqual(resp.status, 400)
    const data = await resp.json()
    assert.ok((data.error.message as string).includes('model'))
  })

  it('映射的 Provider 不存在返回 502', async () => {
    const config: Config = {
      providers: [],
      adapters: [
        { name: 'broken', type: 'openai', models: [{ sourceModelId: 'm', provider: 'nonexistent-p', targetModelId: 'x' }] },
      ],
    }
    const store = new ConfigStore('/fake', config)
    const tracker = new StatusTracker()
    const logger = new Logger()
    const s = createProxyServer({
      adminHost: '127.0.0.1', adminPort: PORT + 3,
      proxyHost: '127.0.0.1', proxyPort: PORT + 3,
      store, tracker, logger,
    })
    await new Promise<void>((resolve) => s.listen(PORT + 3, '127.0.0.1', resolve))
    try {
      const resp = await fetch(`http://127.0.0.1:${PORT + 3}/broken/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.strictEqual(resp.status, 502)
    } finally {
      s.close()
    }
  })
})
