import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleTestModel, handleTestAdapter, handlePullModels } from '../../src/api/handlers/model-handlers.js'
import type { ServerContext } from '../../src/api/server.js'
import { ConfigStore } from '../../src/config/store.js'
import type { ProviderType } from '../../src/config/types.js'
import { Logger } from '../../src/log/logger.js'

function createContext(type: ProviderType = 'openai', apiBase?: string): ServerContext {
  return {
    store: new ConfigStore('/unused', {
      providers: [{
        name: 'upstream',
        apiKey: 'sk-upstream',
        protocols: [{ type, apiBase }],
        models: [{ id: 'upstream-model' }],
      }],
      adapters: [{
        name: 'client',
        models: [{ sourceModelId: 'client-model', provider: 'upstream', targetModelId: 'upstream-model' }],
      }],
    }),
    logger: new Logger(),
  } as ServerContext
}

function request(body: Record<string, unknown>, url?: string): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url }) as IncomingMessage
}

function mockRes() {
  let status = 0
  let body = ''
  const res = {
    writeHead: (code: number) => { status = code },
    end: (data: string) => { body = data },
  } as unknown as ServerResponse
  return { res, getStatus: () => status, getBody: () => JSON.parse(body) }
}

function mockUpstream(t: TestContext, responseBody: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  // TestContext restores the mock after each test, including assertion failures.
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return Response.json(responseBody)
  })
  return calls
}

function assertAuth(init: RequestInit, type: ProviderType): void {
  const headers = new Headers(init.headers)
  if (type === 'anthropic') {
    assert.strictEqual(headers.get('x-api-key'), 'sk-upstream')
    assert.strictEqual(headers.get('anthropic-version'), '2023-06-01')
  } else {
    assert.strictEqual(headers.get('authorization'), 'Bearer sk-upstream')
  }
}

describe('model handlers upstream URLs', () => {
  describe('handleTestModel', () => {
    const cases: { name: string; type: ProviderType; apiBase?: string; endpoint?: string; expectedUrl: string }[] = [
      { name: 'OpenAI 默认地址', type: 'openai', expectedUrl: 'https://api.openai.com/v1/chat/completions' },
      { name: 'Anthropic 默认地址', type: 'anthropic', expectedUrl: 'https://api.anthropic.com/v1/messages' },
      { name: 'Responses 显式 /v1/', type: 'openai-responses', apiBase: 'https://upstream.test/v1/', expectedUrl: 'https://upstream.test/v1/responses' },
      { name: '火山方舟 /api/v3', type: 'openai', apiBase: 'https://ark.cn-beijing.volces.com/api/v3', expectedUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions' },
      { name: 'Responses /api/v3', type: 'openai-responses', apiBase: 'https://upstream.test/api/v3', expectedUrl: 'https://upstream.test/api/v3/responses' },
      { name: 'OpenAI responses endpoint 和尾斜杠', type: 'openai', endpoint: 'responses', apiBase: 'https://upstream.test/api/v3///', expectedUrl: 'https://upstream.test/api/v3/responses' },
      { name: 'Anthropic 显式 /v2/', type: 'anthropic', apiBase: 'https://upstream.test/v2/', expectedUrl: 'https://upstream.test/v2/messages' },
      { name: 'OpenAI 网关前缀', type: 'openai', apiBase: 'https://upstream.test/openai', expectedUrl: 'https://upstream.test/openai/v1/chat/completions' },
      { name: 'Anthropic 网关前缀', type: 'anthropic', apiBase: 'https://upstream.test/anthropic/', expectedUrl: 'https://upstream.test/anthropic/v1/messages' },
    ]

    for (const { name, type, apiBase, endpoint, expectedUrl } of cases) {
      it(name, async (t) => {
        const calls = mockUpstream(t)
        const response = mockRes()
        await handleTestModel(createContext(), request({
          type, api_key: 'sk-upstream', api_base: apiBase, endpoint, model: 'upstream-model',
        }), response.res)

        assert.strictEqual(response.getStatus(), 200)
        assert.strictEqual(calls.length, 1)
        assert.strictEqual(calls[0].url, expectedUrl)
        assert.strictEqual(calls[0].init.method, 'POST')
        assertAuth(calls[0].init, type)
        const body = JSON.parse(String(calls[0].init.body))
        assert.strictEqual(body.model, 'upstream-model')
        assert.strictEqual(body.stream, false)
        if (type === 'openai-responses' || endpoint === 'responses') assert.strictEqual(body.input, 'hi')
        const result = response.getBody()
        assert.strictEqual(result.success, true)
        assert.strictEqual(result.data.reachable, true)
        assert.strictEqual(result.data.requestUrl, expectedUrl)
      })
    }

    it('使用供应商保存的 /api/v3 和密钥测试模型', async (t) => {
      const calls = mockUpstream(t)
      const response = mockRes()
      await handleTestModel(createContext('openai', 'https://upstream.test/api/v3/'), request({
        type: 'openai', providerName: 'upstream', api_key: '***', model: 'upstream-model',
      }), response.res)

      assert.strictEqual(calls.length, 1)
      assert.strictEqual(calls[0].url, 'https://upstream.test/api/v3/chat/completions')
      assertAuth(calls[0].init, 'openai')
      assert.strictEqual(response.getBody().data.reachable, true)
    })
  })

  describe('handleTestAdapter', () => {
    const cases: { name: string; type: ProviderType; apiBase?: string; inboundType: ProviderType; expectedUrl: string; adapterUrl: string }[] = [
      { name: 'OpenAI 默认地址', type: 'openai', inboundType: 'openai', expectedUrl: 'https://api.openai.com/v1/chat/completions', adapterUrl: '/client/v1/chat/completions' },
      { name: 'OpenAI /api/v3/', type: 'openai', apiBase: 'https://upstream.test/api/v3/', inboundType: 'openai', expectedUrl: 'https://upstream.test/api/v3/chat/completions', adapterUrl: '/client/v1/chat/completions' },
      { name: 'Responses /api/v3', type: 'openai-responses', apiBase: 'https://upstream.test/api/v3', inboundType: 'openai-responses', expectedUrl: 'https://upstream.test/api/v3/responses', adapterUrl: '/client/v1/responses' },
      { name: 'Anthropic 显式 /v1/', type: 'anthropic', apiBase: 'https://upstream.test/v1/', inboundType: 'anthropic', expectedUrl: 'https://upstream.test/v1/messages', adapterUrl: '/client/v1/messages' },
      { name: '跨协议使用上游端点且保留适配器 /v1 入口', type: 'openai', apiBase: 'https://upstream.test/api/v3', inboundType: 'anthropic', expectedUrl: 'https://upstream.test/api/v3/chat/completions', adapterUrl: '/client/v1/messages' },
    ]

    for (const { name, type, apiBase, inboundType, expectedUrl, adapterUrl } of cases) {
      it(name, async (t) => {
        const calls = mockUpstream(t)
        const response = mockRes()
        await handleTestAdapter(createContext(type, apiBase), request({
          adapterName: 'client', modelId: 'client-model', protocol: inboundType,
        }), response.res)

        assert.strictEqual(response.getStatus(), 200)
        assert.strictEqual(calls.length, 1)
        assert.strictEqual(calls[0].url, expectedUrl)
        assert.strictEqual(calls[0].init.method, 'POST')
        assertAuth(calls[0].init, type)
        assert.strictEqual(JSON.parse(String(calls[0].init.body)).model, 'upstream-model')
        const result = response.getBody()
        assert.strictEqual(result.success, true)
        assert.strictEqual(result.data.reachable, true)
        assert.strictEqual(result.data.model, 'client-model')
        assert.strictEqual(result.data.requestUrl, expectedUrl)
        assert.strictEqual(result.data.adapterUrl, adapterUrl)
      })
    }
  })

  describe('handlePullModels', () => {
    const cases: { name: string; type: ProviderType; apiBase?: string; expectedUrl: string }[] = [
      { name: 'OpenAI 默认地址', type: 'openai', expectedUrl: 'https://api.openai.com/v1/models' },
      { name: 'OpenAI 显式 /v1/', type: 'openai', apiBase: 'https://upstream.test/v1/', expectedUrl: 'https://upstream.test/v1/models' },
      { name: 'OpenAI /api/v3/', type: 'openai', apiBase: 'https://upstream.test/api/v3/', expectedUrl: 'https://upstream.test/api/v3/models' },
      { name: 'Responses /api/v3', type: 'openai-responses', apiBase: 'https://upstream.test/api/v3', expectedUrl: 'https://upstream.test/api/v3/models' },
      { name: 'Anthropic 网关前缀', type: 'anthropic', apiBase: 'https://upstream.test/anthropic', expectedUrl: 'https://upstream.test/anthropic/v1/models' },
    ]

    for (const { name, type, apiBase, expectedUrl } of cases) {
      it(name, async (t) => {
        const calls = mockUpstream(t, {
          data: [{ id: 'upstream-model', type: 'model', display_name: 'Test model', owned_by: 'Test model' }],
        })
        const response = mockRes()
        await handlePullModels(createContext(type, apiBase), request({}, '/admin/providers/upstream/pull-models'), response.res)

        assert.strictEqual(response.getStatus(), 200)
        assert.strictEqual(calls.length, 1)
        assert.strictEqual(calls[0].url, expectedUrl)
        assert.strictEqual(calls[0].init.method ?? 'GET', 'GET')
        assertAuth(calls[0].init, type)
        assert.deepStrictEqual(response.getBody(), {
          success: true,
          data: { models: [{ id: 'upstream-model', description: 'Test model' }], existing: ['upstream-model'] },
        })
      })
    }
  })
})
