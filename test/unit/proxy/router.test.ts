// P1.12 阶段 A：从 legacy-test/adapter/router.test.ts 机械迁移（node:test → vitest）
// P1.15 切流：被测对象改指 src 新模块（src/proxy/router.ts，合并了直连 + 适配器路由）。
// 适配说明（新旧契约差异，未改 src 生产逻辑）：
// - 新 RouteDecision 字段重命名：providerName→providerId、providerType→providerProtocol、modelId→resolvedModel。
// - 错误码保持不变：ADAPTER_NOT_FOUND / MODEL_MAPPING_NOT_FOUND / PROVIDER_NOT_FOUND / MODEL_NOT_FOUND。
// - 删除「传递 target model 的 input 模态到 route」用例：新 RouteDecision 不再携带 input 字段
//   （识图模态改由配置层 Provider.models[].input 承载，validator 负责校验），route.input 契约已移除。
import { describe, it, expect } from 'vitest'
import { resolveAdapterRoute, AdapterError } from '../../../src/proxy/router.ts'
import { ConfigStore } from '../../../src/config/store.ts'
import type { Config } from '../../../src/config/types.ts'

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

describe('proxy/router（适配器路由）', () => {
  it('同协议映射到 Anthropic Provider', () => {
    const store = createStore()
    const result = resolveAdapterRoute(store, 'claude-code', 'sonnet')
    expect(result.route.providerId).toBe('anthropic-main')
    expect(result.route.providerProtocol).toBe('anthropic')
    expect(result.route.resolvedModel).toBe('claude-sonnet-4-20250514')
    expect(result.inboundType).toBe('anthropic')
  })

  it('跨协议映射到 OpenAI Provider（Anthropic 格式 → OpenAI 上游）', () => {
    const store = createStore()
    const result = resolveAdapterRoute(store, 'claude-code', 'fast')
    expect(result.route.providerId).toBe('openai-main')
    expect(result.route.providerProtocol).toBe('openai')
    expect(result.route.resolvedModel).toBe('gpt-4o')
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
})
