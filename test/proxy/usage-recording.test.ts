/**
 * 端到端测试：验证 forwardRequest 在 mock 上游响应后正确写入 UsageStore。
 * 同时验证 adapter 维度的数据被正确记录。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { forwardRequest } from '../../src/proxy/provider.js'
import { UsageStore } from '../../src/status/usage-store.js'

// 最小化的 ServerResponse mock：forwardRequest 用到的接口
function makeMockRes(): ServerResponse {
  const emitter = new EventEmitter()
  const headers: Record<string, string> = {}
  const res: any = emitter
  res.writeHead = (status: number, hdrs?: Record<string, string>) => {
    res.statusCode = status
    res.headersSent = true
    if (hdrs) Object.assign(headers, hdrs)
  }
  res.setHeader = (k: string, v: string) => { headers[k] = v }
  res.getHeader = (k: string) => headers[k]
  res.write = (_chunk: unknown) => true
  res.end = (_chunk?: unknown) => {
    res.writableEnded = true
    emitter.emit('close')
  }
  res.headersSent = false
  res.writableEnded = false
  res.statusCode = 200
  return res as ServerResponse
}

describe('proxy/forwardRequest → UsageStore 集成', () => {
  let dir: string
  let dbPath: string
  let store: UsageStore
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-e2e-'))
    dbPath = join(dir, 'usage.db')
    store = new UsageStore(dbPath)
    originalFetch = global.fetch
  })

  afterEach(() => {
    store.close()
    global.fetch = originalFetch
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('非流式响应：Anthropic 协议 usage 被归一化后写入 UsageStore', async () => {
    // mock 上游 Anthropic 响应
    global.fetch = (async () => {
      return new Response(JSON.stringify({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 22,           // 计费部分
          output_tokens: 100,
          cache_read_input_tokens: 58000,
          cache_creation_input_tokens: 0,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof global.fetch

    const res = makeMockRes()
    await forwardRequest({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] },
      crossProtocol: false,
      inboundType: 'anthropic',
      upstreamType: 'anthropic',
      usageStore: store,
      providerName: 'anthropic',
      upstreamModel: 'claude-sonnet-4-20250514',
      clientModel: 'claude-sonnet-4',
      adapterName: undefined,
    }, res)

    const stats = store.getStats()
    // Anthropic 归一化后 input = billable + cache_read + cache_create = 22 + 58000 + 0 = 58022
    assert.strictEqual(stats.today.input_tokens, 58022, 'Anthropic 应归一化为总输入')
    assert.strictEqual(stats.today.cache_read_input_tokens, 58000)
    assert.strictEqual(stats.today.output_tokens, 100)
    assert.strictEqual(stats.today.request_count, 1)
  })

  it('非流式响应：OpenAI 协议 usage 直接写入', async () => {
    global.fetch = (async () => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-123',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: {
          prompt_tokens: 200,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 140 },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof global.fetch

    const res = makeMockRes()
    await forwardRequest({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
      crossProtocol: false,
      inboundType: 'openai',
      upstreamType: 'openai',
      usageStore: store,
      providerName: 'openai',
      upstreamModel: 'gpt-4-0613',
      clientModel: 'gpt-4',
      adapterName: undefined,
    }, res)

    const stats = store.getStats()
    assert.strictEqual(stats.today.input_tokens, 200)
    assert.strictEqual(stats.today.cache_read_input_tokens, 140)
    assert.strictEqual(stats.today.output_tokens, 50)
    assert.strictEqual(stats.today.request_count, 1)
  })

  it('adapter 请求：adapterName 被正确持久化', async () => {
    global.fetch = (async () => {
      return new Response(JSON.stringify({
        id: 'msg_123',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof global.fetch

    const res = makeMockRes()
    await forwardRequest({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] },
      crossProtocol: false,
      inboundType: 'anthropic',
      upstreamType: 'anthropic',
      usageStore: store,
      providerName: 'anthropic',
      upstreamModel: 'claude-sonnet-4-20250514',
      clientModel: 'claude-sonnet-4',
      adapterName: 'my-tool',  // 关键：适配器名称
    }, res)

    const byAdapter = store.getBreakdown('adapter', 'today')
    assert.strictEqual(byAdapter.length, 1)
    assert.strictEqual(byAdapter[0].key, 'my-tool')
    assert.strictEqual(byAdapter[0].input_tokens, 10)
    assert.strictEqual(byAdapter[0].request_count, 1)
  })

  it('直接代理 vs 适配器：两条请求分别记录', async () => {
    let callCount = 0
    global.fetch = (async () => {
      callCount++
      return new Response(JSON.stringify({
        id: 'msg_' + callCount,
        usage: {
          input_tokens: 100 * callCount,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof global.fetch

    // 1. 直接 /v1/messages 调用（无 adapterName）
    await forwardRequest({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {},
      body: { model: 'claude-sonnet-4', messages: [] },
      crossProtocol: false,
      inboundType: 'anthropic',
      upstreamType: 'anthropic',
      usageStore: store,
      providerName: 'anthropic',
      upstreamModel: 'claude-sonnet-4-20250514',
      clientModel: 'claude-sonnet-4',
      adapterName: undefined,
    }, makeMockRes())

    // 2. 通过适配器 tool-a 调用
    await forwardRequest({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {},
      body: { model: 'claude-sonnet-4', messages: [] },
      crossProtocol: false,
      inboundType: 'anthropic',
      upstreamType: 'anthropic',
      usageStore: store,
      providerName: 'anthropic',
      upstreamModel: 'claude-sonnet-4-20250514',
      clientModel: 'claude-sonnet-4',
      adapterName: 'tool-a',
    }, makeMockRes())

    const byAdapter = store.getBreakdown('adapter', 'today')
    assert.strictEqual(byAdapter.length, 2)
    // 排序：input_tokens DESC。tool-a: 200, (direct proxy): 100
    assert.strictEqual(byAdapter[0].key, 'tool-a')
    assert.strictEqual(byAdapter[0].input_tokens, 200)
    assert.strictEqual(byAdapter[1].key, '(direct proxy)')
    assert.strictEqual(byAdapter[1].input_tokens, 100)
  })

  it('持久化：关闭后重开数据仍在', async () => {
    global.fetch = (async () => {
      return new Response(JSON.stringify({
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof global.fetch

    await forwardRequest({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: {},
      body: { model: 'gpt-4', messages: [] },
      crossProtocol: false,
      inboundType: 'openai',
      upstreamType: 'openai',
      usageStore: store,
      providerName: 'openai',
      upstreamModel: 'gpt-4-0613',
      clientModel: 'gpt-4',
      adapterName: undefined,
    }, makeMockRes())

    assert.strictEqual(store.getStats().today.input_tokens, 1000)

    // 模拟重启
    store.close()
    const store2 = new UsageStore(dbPath)
    try {
      const stats = store2.getStats()
      assert.strictEqual(stats.today.input_tokens, 1000, '重启后数据应保留')
      assert.strictEqual(stats.today.request_count, 1)
    } finally {
      store2.close()
    }
  })
})