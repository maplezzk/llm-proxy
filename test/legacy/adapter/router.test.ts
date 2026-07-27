// P1.12 阶段 A：从 legacy-test/adapter/router.test.ts 机械迁移（node:test → vitest）
// 断言语义保持不变，仅替换测试栈与断言 API。
// 注意：node:test 的 assert.throws(fn, predicate) 在 vitest 无对应 predicate 形式，
// 改用 try/catch 捕获后断言 err.code，完整保留“错误码等于某值”的原测试意图。
import { describe, it, expect } from 'vitest'
import { resolveAdapterRoute, AdapterError } from '../../../legacy-src/adapter/router.js'
import { ConfigStore } from '../../../legacy-src/config/store.js'
import type { Config } from '../../../legacy-src/config/types.js'

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

// 捕获 fn 抛出的错误，便于断言其错误码（等价于原 assert.throws 的 predicate 校验）
function catchError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('adapter/router', () => {
  it('同协议映射到 Anthropic Provider', () => {
    const store = createStore()
    const result = resolveAdapterRoute(store, 'claude-code', 'sonnet')
    expect(result.route.providerName).toBe('anthropic-main')
    expect(result.route.providerType).toBe('anthropic')
    expect(result.route.modelId).toBe('claude-sonnet-4-20250514')
    expect(result.inboundType).toBe('anthropic')
  })

  it('跨协议映射到 OpenAI Provider（Anthropic 格式 → OpenAI 上游）', () => {
    const store = createStore()
    const result = resolveAdapterRoute(store, 'claude-code', 'fast')
    expect(result.route.providerName).toBe('openai-main')
    expect(result.route.providerType).toBe('openai')
    expect(result.route.modelId).toBe('gpt-4o')
    expect(result.inboundType).toBe('anthropic')  // 适配器格式不变
  })

  it('适配器名称不存在时抛错', () => {
    const store = createStore()
    const err = catchError(() => resolveAdapterRoute(store, 'nonexistent', 'sonnet')) as AdapterError
    expect(err?.code).toBe('ADAPTER_NOT_FOUND')
  })

  it('工具模型名在适配器映射中不存在时抛错', () => {
    const store = createStore()
    const err = catchError(() => resolveAdapterRoute(store, 'claude-code', 'nonexistent')) as AdapterError
    expect(err?.code).toBe('MODEL_MAPPING_NOT_FOUND')
  })

  it('映射的 Provider 不存在时抛错', () => {
    const config: Config = {
      providers: [],
      adapters: [
        { name: 'test-adapter', type: 'openai', models: [{ sourceModelId: 'm', provider: 'nonexistent-provider', targetModelId: 'm' }] },
      ],
    }
    const store = new ConfigStore('/fake', config)
    const err = catchError(() => resolveAdapterRoute(store, 'test-adapter', 'm')) as AdapterError
    expect(err?.code).toBe('PROVIDER_NOT_FOUND')
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
    const err = catchError(() => resolveAdapterRoute(store, 'a', 'm')) as AdapterError
    expect(err?.code).toBe('MODEL_NOT_FOUND')
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
    expect(mmResult.route.input).toEqual(['text', 'image'])

    // 纯文本模型：input 应为 undefined（向后兼容，默认视为仅文本）
    const txtResult = resolveAdapterRoute(store, 'a', 'txt')
    expect(txtResult.route.input).toBe(undefined)
  })
})
