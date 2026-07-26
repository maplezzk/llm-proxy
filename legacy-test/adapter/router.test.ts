import { describe, it } from 'node:test'
import assert from 'node:assert'
import { resolveAdapterRoute, AdapterError } from '../../src/adapter/router.js'
import { ConfigStore } from '../../src/config/store.js'
import type { Config } from '../../src/config/types.js'

function createStore(): ConfigStore {
  const config: Config = {
    providers: [
      {
        name: 'anthropic-main',
        type: 'anthropic',
        apiKey: 'sk-ant-1',
        models: [
          { id: 'claude-sonnet-4-20250514' },
        ],
      },
      {
        name: 'openai-main',
        type: 'openai',
        apiKey: 'sk-openai-1',
        apiBase: 'https://api.openai.com',
        models: [
          { id: 'gpt-4o' },
        ],
      },
    ],
    adapters: [
      {
        name: 'claude-code',
        type: 'anthropic',
        models: [
          { sourceModelId: 'sonnet', provider: 'anthropic-main', targetModelId: 'claude-sonnet-4-20250514' },
          { sourceModelId: 'fast', provider: 'openai-main', targetModelId: 'gpt-4o' },
        ],
      },
    ],
  }
  return new ConfigStore('/fake', config)
}

describe('adapter/router', () => {
  it('同协议映射到 Anthropic Provider', () => {
    const store = createStore()
    const result = resolveAdapterRoute(store, 'claude-code', 'sonnet')
    assert.strictEqual(result.route.providerName, 'anthropic-main')
    assert.strictEqual(result.route.providerType, 'anthropic')
    assert.strictEqual(result.route.modelId, 'claude-sonnet-4-20250514')
    assert.strictEqual(result.inboundType, 'anthropic')
  })

  it('跨协议映射到 OpenAI Provider（Anthropic 格式 → OpenAI 上游）', () => {
    const store = createStore()
    const result = resolveAdapterRoute(store, 'claude-code', 'fast')
    assert.strictEqual(result.route.providerName, 'openai-main')
    assert.strictEqual(result.route.providerType, 'openai')
    assert.strictEqual(result.route.modelId, 'gpt-4o')
    assert.strictEqual(result.inboundType, 'anthropic')  // 适配器格式不变
  })

  it('适配器名称不存在时抛错', () => {
    const store = createStore()
    assert.throws(
      () => resolveAdapterRoute(store, 'nonexistent', 'sonnet'),
      (err: AdapterError) => err.code === 'ADAPTER_NOT_FOUND'
    )
  })

  it('工具模型名在适配器映射中不存在时抛错', () => {
    const store = createStore()
    assert.throws(
      () => resolveAdapterRoute(store, 'claude-code', 'nonexistent'),
      (err: AdapterError) => err.code === 'MODEL_MAPPING_NOT_FOUND'
    )
  })

  it('映射的 Provider 不存在时抛错', () => {
    const config: Config = {
      providers: [],
      adapters: [
        { name: 'test-adapter', type: 'openai', models: [{ sourceModelId: 'm', provider: 'nonexistent-provider', targetModelId: 'm' }] },
      ],
    }
    const store = new ConfigStore('/fake', config)
    assert.throws(
      () => resolveAdapterRoute(store, 'test-adapter', 'm'),
      (err: AdapterError) => err.code === 'PROVIDER_NOT_FOUND'
    )
  })

  it('映射的 Model 在 Provider 中不存在时抛错', () => {
    const config: Config = {
      providers: [
        { name: 'p', type: 'openai', apiKey: 'k', models: [{ id: 'real' }] },
      ],
      adapters: [
        { name: 'a', type: 'openai', models: [{ sourceModelId: 'm', provider: 'p', targetModelId: 'nonexistent-model' }] },
      ],
    }
    const store = new ConfigStore('/fake', config)
    assert.throws(
      () => resolveAdapterRoute(store, 'a', 'm'),
      (err: AdapterError) => err.code === 'MODEL_NOT_FOUND'
    )
  })

  it('传递 target model 的 input 模态到 route（用于外挂识图判断）', () => {
    // 回归测试：修复前 adapter router 漏传 input 字段，导致 modelSupportsImage(route) 永远返回 false，
    // 即使 provider 里正确声明了 input: [text, image]，走 adapter 路由时仍会触发外挂识图。
    const config: Config = {
      providers: [
        {
          name: 'vision-provider',
          type: 'anthropic',
          apiKey: 'sk-1',
          models: [
            { id: 'multimodal-model', input: ['text', 'image'] },
            { id: 'text-only-model' },
          ],
        },
      ],
      adapters: [
        {
          name: 'a',
          type: 'openai',
          models: [
            { sourceModelId: 'mm', provider: 'vision-provider', targetModelId: 'multimodal-model' },
            { sourceModelId: 'txt', provider: 'vision-provider', targetModelId: 'text-only-model' },
          ],
        },
      ],
    }
    const store = new ConfigStore('/fake', config)

    // 多模态模型：input 字段必须原样传递，否则会触发外挂识图
    const mmResult = resolveAdapterRoute(store, 'a', 'mm')
    assert.deepStrictEqual(mmResult.route.input, ['text', 'image'])

    // 纯文本模型：input 应为 undefined（向后兼容，默认视为仅文本）
    const txtResult = resolveAdapterRoute(store, 'a', 'txt')
    assert.strictEqual(txtResult.route.input, undefined)
  })
})
