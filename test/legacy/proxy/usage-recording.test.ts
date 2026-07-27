// P1.12 阶段 B：从 legacy-test/proxy/usage-recording.test.ts 机械迁移（node:test → vitest）
// 断言语义保持不变，仅替换测试栈与断言 API。
// global.fetch mock 按 §7.1 规则改为 vi.stubGlobal('fetch', fn) + afterEach(vi.unstubAllGlobals)。
/**
 * 端到端测试：验证 forwardRequest 在 mock 上游响应后正确写入 UsageStore。
 * 同时验证 adapter 维度的数据被正确记录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { forwardRequest } from '../../../legacy-src/proxy/provider.js'
import { UsageStore } from '../../../legacy-src/status/usage-store.js'

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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-e2e-'))
    dbPath = join(dir, 'usage.db')
    store = new UsageStore(dbPath)
  })

  afterEach(() => {
    store.close()
    vi.unstubAllGlobals()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('非流式响应：Anthropic 协议 usage 被归一化后写入 UsageStore', async () => {
    // mock 上游 Anthropic 响应
    vi.stubGlobal('fetch', async () => {
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
    })

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
    // DB 统一语义：input_tokens = 计费部分（Anthropic API 返回的 22 已是计费）
    expect(stats.today.input_tokens, 'Anthropic 应存计费部分，不预加缓存').toBe(22)
    expect(stats.today.cache_read_input_tokens).toBe(58000)
    expect(stats.today.output_tokens).toBe(100)
    expect(stats.today.request_count).toBe(1)
  })

  it('非流式响应：OpenAI 协议 usage 直接写入', async () => {
    vi.stubGlobal('fetch', async () => {
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
    })

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
    // DB 统一语义：input_tokens = 计费部分 = prompt_tokens - cached_tokens = 200 - 140 = 60
    expect(stats.today.input_tokens).toBe(60)
    expect(stats.today.cache_read_input_tokens).toBe(140)
    expect(stats.today.output_tokens).toBe(50)
    expect(stats.today.request_count).toBe(1)
  })

  it('非流式响应：OpenAI Responses 标准缓存字段写入 UsageStore', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response(JSON.stringify({
        id: 'resp_123',
        object: 'response',
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: 5,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    await forwardRequest({
      url: 'https://api.openai.com/v1/responses',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { model: 'gpt-5', input: 'hi', stream: false },
      crossProtocol: false,
      inboundType: 'openai-responses',
      upstreamType: 'openai-responses',
      usageStore: store,
      providerName: 'openai-responses',
      upstreamModel: 'gpt-5',
      clientModel: 'gpt-5',
    }, makeMockRes())

    const stats = store.getStats()
    expect(stats.today.input_tokens).toBe(20)
    expect(stats.today.cache_read_input_tokens).toBe(80)
    expect(stats.today.output_tokens).toBe(5)
  })

  it('adapter 请求：adapterName 被正确持久化', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response(JSON.stringify({
        id: 'msg_123',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

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

    const byAdapter = store.getBreakdown('adapter', { range: 'today' })
    expect(byAdapter.length).toBe(1)
    expect(byAdapter[0].key).toBe('my-tool')
    expect(byAdapter[0].input_tokens).toBe(10)
    expect(byAdapter[0].request_count).toBe(1)
  })

  it('直接代理 vs 适配器：两条请求分别记录', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async () => {
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
    })

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

    const byAdapter = store.getBreakdown('adapter', { range: 'today' })
    expect(byAdapter.length).toBe(2)
    // 排序：input_tokens DESC。tool-a: 200, (direct proxy): 100
    expect(byAdapter[0].key).toBe('tool-a')
    expect(byAdapter[0].input_tokens).toBe(200)
    expect(byAdapter[1].key).toBe('(direct proxy)')
    expect(byAdapter[1].input_tokens).toBe(100)
  })

  it('持久化：关闭后重开数据仍在', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response(JSON.stringify({
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

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

    expect(store.getStats().today.input_tokens).toBe(1000)

    // 模拟重启
    store.close()
    const store2 = new UsageStore(dbPath)
    try {
      const stats = store2.getStats()
      expect(stats.today.input_tokens, '重启后数据应保留').toBe(1000)
      expect(stats.today.request_count).toBe(1)
    } finally {
      store2.close()
    }
  })
})
