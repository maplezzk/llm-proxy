import { describe, it } from 'node:test'
import assert from 'node:assert'
import { routeModel } from '../../src/proxy/router.js'
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
          { id: 'claude-3-haiku-20240307' },
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
  }
  return new ConfigStore('/fake', config)
}

describe('proxy/router', () => {
  it('通过 model name 匹配到 Anthropic Provider', () => {
    const store = createStore()
    const result = routeModel(store, 'claude-sonnet-4-20250514')
    assert.strictEqual(result.providerName, 'anthropic-main')
    assert.strictEqual(result.providerType, 'anthropic')
    assert.strictEqual(result.modelId, 'claude-sonnet-4-20250514')
    assert.strictEqual(result.apiKey, 'sk-ant-1')
    assert.strictEqual(result.apiBase, 'https://api.anthropic.com')
  })

  it('通过 model name 匹配到 OpenAI Provider', () => {
    const store = createStore()
    const result = routeModel(store, 'gpt-4o')
    assert.strictEqual(result.providerName, 'openai-main')
    assert.strictEqual(result.providerType, 'openai')
    assert.strictEqual(result.modelId, 'gpt-4o')
    assert.strictEqual(result.apiBase, 'https://api.openai.com')
  })

  it('使用自定义 apiBase', () => {
    const config: Config = {
      providers: [
        { name: 'custom', type: 'openai', apiKey: 'k', apiBase: 'https://custom.example.com', models: [{ id: 'mv' }] },
      ],
    }
    const store = new ConfigStore('/fake', config)
    const result = routeModel(store, 'mv')
    assert.strictEqual(result.apiBase, 'https://custom.example.com')
  })

  it('不存在的 model name 抛错', () => {
    const store = createStore()
    assert.throws(() => routeModel(store, 'nonexistent-model'), { message: /未找到/ })
  })

  it('模型包含 thinking 配置时正确传递', () => {
    const config: Config = {
      providers: [
        { name: 'p1', type: 'anthropic', apiKey: 'k1', models: [{ id: 'm1', thinking: { budget_tokens: 8192 } }] },
        { name: 'p2', type: 'openai', apiKey: 'k2', models: [{ id: 'm2', thinking: { reasoning_effort: 'medium' } }] },
      ],
    }
    const store = new ConfigStore('/fake', config)

    const r1 = routeModel(store, 'm1')
    assert.strictEqual(r1.thinking?.budget_tokens, 8192)

    const r2 = routeModel(store, 'm2')
    assert.strictEqual(r2.thinking?.reasoning_effort, 'medium')
  })

  it('模型无 thinking 配置时返回 undefined', () => {
    const config: Config = {
      providers: [
        { name: 'p1', type: 'anthropic', apiKey: 'k1', models: [{ id: 'm1' }] },
      ],
    }
    const store = new ConfigStore('/fake', config)
    const result = routeModel(store, 'm1')
    assert.strictEqual(result.thinking, undefined)
  })
})
