import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { createServer as createHttpServer } from 'node:http'
import type { Server } from 'node:http'
import { createProxyServer } from '../../src/api/server.js'
import { ConfigStore } from '../../src/config/store.js'
import { StatusTracker } from '../../src/status/tracker.js'
import { Logger } from '../../src/log/logger.js'
import type { Config } from '../../src/config/types.js'

const MOCK_PORT = 19789
const PROXY_PORT = 19790

// --- Mock upstream server ---
const mockRequests: { method: string; url: string; body: Record<string, unknown> }[] = []
let mockServer: Server

function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    mockRequests.length = 0
    mockServer = createHttpServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c))
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}')
        const url = req.url ?? '/'
        mockRequests.push({ method: req.method ?? 'GET', url, body: parsed })

        const isStream = parsed.stream === true
        const model = parsed.model ?? 'unknown'

        // --- /v1/responses (OpenAI Responses API) ---
        if (url === '/v1/responses') {
          if (isStream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            res.write(`event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","status":"in_progress"}}\n\n`)
            res.write(`event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_test","status":"in_progress","role":"assistant","content":[]}}\n\n`)
            res.write(`event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n`)
            res.write(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello from ${model}"}\n\n`)
            res.write(`event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Hello from ${model}"}\n\n`)
            res.write(`event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","status":"completed"}}\n\n`)
            res.end()
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              id: 'resp_test',
              object: 'response',
              created_at: 1234567890,
              status: 'completed',
              model,
              output: [{
                type: 'message',
                id: 'msg_test',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: `Hello from ${model}`, annotations: [] }],
              }],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            }))
          }
          return
        }

        // --- /v1/messages (Anthropic) ---
        if (url === '/v1/messages') {
          if (isStream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"${model}"}}\n\n`)
            res.write(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`)
            res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from ${model}"}}\n\n`)
            res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`)
            res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n`)
            res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)
            res.end()
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              id: 'msg_test',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: `Hello from ${model}` }],
              model,
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 5 },
            }))
          }
          return
        }

        // --- /v1/chat/completions (OpenAI Chat) ---
        if (isStream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(`data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n`)
          res.write(`data: {"choices":[{"delta":{"content":"Hello from ${model}"},"index":0}]}\n\n`)
          res.write(`data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1234567890,
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: `Hello from ${model}` }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }))
        }
      })
    })
    mockServer.listen(MOCK_PORT, '127.0.0.1', resolve)
  })
}

function createTestConfig(): Config {
  return {
    providers: [
      {
        name: 'test-openai',
        type: 'openai',
        apiKey: 'sk-test',
        apiBase: `http://127.0.0.1:${MOCK_PORT}`,
        models: [{ id: 'gpt-4o-test' }],
      },
      {
        name: 'test-responses',
        type: 'openai-responses',
        apiKey: 'sk-test',
        apiBase: `http://127.0.0.1:${MOCK_PORT}`,
        models: [{ id: 'gpt-4o-resp' }],
      },
      {
        name: 'test-anthropic',
        type: 'anthropic',
        apiKey: 'sk-ant-test',
        apiBase: `http://127.0.0.1:${MOCK_PORT}`,
        models: [{ id: 'gpt-4o-test' }, { id: 'claude-test' }, { id: 'gpt-4o-resp' }],
      },
    ],
    adapters: [
      { name: 'my-tool', type: 'openai', models: [{ sourceModelId: 'gpt-test', provider: 'test-openai', targetModelId: 'gpt-4o-test' }] },
      { name: 'resp-adapter', type: 'openai-responses', models: [{ sourceModelId: 'resp-test', provider: 'test-responses', targetModelId: 'gpt-4o-resp' }] },
    ],
  }
}

describe('integration', { timeout: 15000 }, () => {
  let server: Server
  let mockCleanup: () => void

  before(async () => {
    await startMockServer()
    mockCleanup = () => { mockServer?.close() }

    const store = new ConfigStore('/fake', createTestConfig())
    const tracker = new StatusTracker()
    const logger = new Logger()
    server = createProxyServer({
      adminHost: '127.0.0.1', adminPort: PROXY_PORT,
      proxyHost: '127.0.0.1', proxyPort: PROXY_PORT,
      store, tracker, logger,
    })
    await new Promise<void>((resolve) => server.listen(PROXY_PORT, '127.0.0.1', resolve))
  })

  after(() => {
    server?.close()
    mockCleanup?.()
  })

  // --- OpenAI format (same protocol) ---

  it('OpenAI 格式 → 非流式 → 同协议转发', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const data = await resp.json()
    assert.strictEqual(data.object, 'chat.completion')
    const msg = (data.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>
    assert.ok((msg.content as string).includes('gpt-4o-test'), 'model 应替换为上游模型名')
  })

  it('OpenAI 格式 → 流式 → 同协议', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    const text = await resp.text()
    assert.ok(text.includes('content'), '流式应含 content')
    assert.ok(text.includes('[DONE]'), '流式应以 [DONE] 结束')
  })

  // --- Anthropic format → OpenAI backend (cross-protocol) ---

  it('Anthropic 格式 → 非流式 → 跨协议响应转换', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', max_tokens: 512, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const data = await resp.json()
    assert.strictEqual(data.type, 'message')
    assert.strictEqual(data.role, 'assistant')
    assert.strictEqual((data.content as Array<Record<string, unknown>>)[0].type, 'text')
  })

  it('Anthropic 格式 → 流式 → 跨协议 SSE 转换', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', max_tokens: 512, messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    const text = await resp.text()
    assert.ok(text.includes('event: content_block_start'), '应含 content_block_start')
    assert.ok(text.includes('event: message_stop'), '应含 message_stop')
    assert.ok(text.includes('text_delta'), '应含 text_delta')
  })

  // --- Admin API ---

  it('管理 API: GET /admin/health', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/admin/health`)
    const data = await resp.json()
    assert.strictEqual(data.success, true)
    assert.strictEqual(data.data.status, 'ok')
  })

  it('管理 API: GET /admin/config 返回原始 Key', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/admin/config`)
    const data = await resp.json()
    assert.strictEqual(data.success, true)
    assert.strictEqual(data.data.providers[0].api_key, 'sk-test')
  })

  it('不存在的 model name 返回 404', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nonexistent', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.strictEqual(resp.status, 404)
    const data = await resp.json()
    assert.ok((data.error?.message as string).includes('未找到'))
  })

  // --- Adapter endpoints ---

  it('适配器端点同协议转发成功', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/my-tool/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const data = await resp.json()
    assert.strictEqual(data.object, 'chat.completion')
    assert.ok((data.choices[0].message.content as string).includes('gpt-4o-test'))
  })

  it('适配器名称不存在返回 404', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/nonexistent/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.strictEqual(resp.status, 404)
  })

  it('管理 API: GET /admin/adapters 返回适配器列表', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/admin/adapters`)
    const data = await resp.json()
    assert.strictEqual(data.success, true)
    assert.ok(data.data.adapters.length > 0)
    assert.strictEqual(data.data.adapters[0].name, 'my-tool')
    assert.strictEqual(data.data.adapters[0].type, 'openai')
    assert.strictEqual(data.data.adapters[0].models[0].sourceModelId, 'gpt-test')
    assert.strictEqual(data.data.adapters[0].models[0].targetModelId, 'gpt-4o-test')
    assert.strictEqual(data.data.adapters[0].models[0].status, 'ok')
  })

  // --- OpenAI Responses API ---

  it('POST /v1/responses → 非流式 → 同协议返回 Responses 格式', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-resp', input: 'hi', instructions: 'Be helpful.' }),
    })
    const data = await resp.json()
    // 验证返回 Responses 格式
    assert.strictEqual(data.object, 'response')
    assert.strictEqual(data.status, 'completed')
    assert.ok(Array.isArray(data.output))
    const msg = data.output[0]
    assert.strictEqual(msg.type, 'message')
    assert.strictEqual(msg.role, 'assistant')
    assert.strictEqual(msg.content[0].type, 'output_text')
    assert.ok((msg.content[0].text as string).includes('gpt-4o-resp'))
    // 验证上游收到了 /v1/responses 请求
    const req = mockRequests[mockRequests.length - 1]
    assert.strictEqual(req.url, '/v1/responses')
    assert.strictEqual(req.body.model, 'gpt-4o-resp')
    assert.strictEqual(req.body.input, 'hi')
    assert.strictEqual(req.body.instructions, 'Be helpful.')
  })

  it('POST /v1/responses → 流式 → 同协议 SSE 穿透', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-resp', input: 'hi', stream: true }),
    })
    const text = await resp.text()
    assert.ok(text.includes('event: response.created'), '应有 response.created')
    assert.ok(text.includes('event: response.output_text.delta'), '应有 output_text.delta')
    assert.ok(text.includes('event: response.completed'), '应有 response.completed')
    assert.ok(text.includes('gpt-4o-resp'), '内容应含模型名')
    const req = mockRequests[mockRequests.length - 1]
    assert.strictEqual(req.url, '/v1/responses')
  })

  it('POST /v1/responses → 跨协议 → Anthropic 格式返回', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', input: 'hi' }),
    })
    const data = await resp.json()
    // 跨协议：Responses 入站 → Anthropic 上游 → 响应转换为 Responses 格式
    assert.strictEqual(data.object, 'response')
    assert.strictEqual(data.status, 'completed')
    assert.ok(Array.isArray(data.output))
    assert.strictEqual(data.output[0].type, 'message')
    // 验证上游请求是 Anthropic 格式
    const req = mockRequests[mockRequests.length - 1]
    assert.strictEqual(req.url, '/v1/messages')
    assert.strictEqual(req.body.model, 'claude-test')
    assert.ok(Array.isArray(req.body.messages))
  })

  it('POST /v1/responses → 跨协议 → 流式 SSE 转换', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', input: 'hi', stream: true }),
    })
    const text = await resp.text()
    // 跨协议流式：Anthropic SSE → Responses SSE
    assert.ok(text.includes('event: response.created'), '应有 response.created')
    assert.ok(text.includes('event: response.output_text.delta'), '应有 output_text.delta')
    assert.ok(text.includes('event: response.completed'), '应有 response.completed')
    const req = mockRequests[mockRequests.length - 1]
    assert.strictEqual(req.url, '/v1/messages')
  })

  it('/v1/responses 不存在的 model 返回 404', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nonexistent', input: 'hi' }),
    })
    assert.strictEqual(resp.status, 404)
  })

  it('/v1/responses 缺少 model 返回 400', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    })
    assert.strictEqual(resp.status, 400)
  })

  it('适配器端点 /my-tool/v1/responses 转发成功', async () => {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/resp-adapter/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'resp-test', input: 'hi' }),
    })
    const data = await resp.json()
    assert.strictEqual(data.object, 'response')
    assert.ok((data.output[0].content[0].text as string).includes('gpt-4o-resp'))
    const req = mockRequests[mockRequests.length - 1]
    assert.strictEqual(req.url, '/v1/responses')
    assert.strictEqual(req.body.model, 'gpt-4o-resp')
  })

  it('Mock 上游收到正确的 Responses/Chat/Messages 请求', () => {
    const resReqs = mockRequests.filter((r) => r.url === '/v1/responses')
    assert.ok(resReqs.length > 0, '/v1/responses 应有请求')
    const msgReqs = mockRequests.filter((r) => r.url === '/v1/messages')
    assert.ok(msgReqs.length > 0, '跨协议应有 /v1/messages 请求')
    const chatReqs = mockRequests.filter((r) => r.url === '/v1/chat/completions')
    assert.ok(chatReqs.length > 0, '/v1/chat/completions 应有请求')
  })
})
