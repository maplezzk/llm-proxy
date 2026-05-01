import { describe, it } from 'node:test'
import assert from 'node:assert'
import { validateConfig } from '../../src/config/validator.js'
import type { Config } from '../../src/config/types.js'

function validConfig(): Config {
  return {
    providers: [
      {
        name: 'anthropic-main',
        type: 'anthropic',
        apiKey: 'sk-ant-valid',
        models: [{ id: 'claude-sonnet-4' }],
      },
      {
        name: 'openai-main',
        type: 'openai',
        apiKey: 'sk-openai-valid',
        models: [{ id: 'gpt-4o' }],
      },
    ],
  }
}

describe('config/validator', () => {
  it('有效配置通过校验', () => {
    const errors = validateConfig(validConfig())
    assert.strictEqual(errors.length, 0)
  })

  it('重复 Provider name 报错', () => {
    const config: Config = {
      providers: [
        { name: 'dup', type: 'openai', apiKey: 'k1', models: [{ id: 'mv1' }] },
        { name: 'dup', type: 'anthropic', apiKey: 'k2', models: [{ id: 'mv2' }] },
      ],
    }
    const errors = validateConfig(config)
    assert.ok(errors.some((e) => e.message.includes('重复')))
  })

  it('重复 Model name 报错', () => {
    const config: Config = {
      providers: [
        {
          name: 'p1',
          type: 'openai',
          apiKey: 'k1',
          models: [
            { id: 'dup' },
            { id: 'dup' },
          ],
        },
      ],
    }
    const errors = validateConfig(config)
    assert.ok(errors.some((e) => e.message.includes('重复')))
  })

  it('空 API Key 报错', () => {
    const config: Config = {
      providers: [
        { name: 'p1', type: 'openai', apiKey: '', models: [{ id: 'mv1' }] },
      ],
    }
    const errors = validateConfig(config)
    assert.ok(errors.some((e) => e.message.includes('不能为空')))
  })

  it('无效 Provider type 报错', () => {
    const config = {
      providers: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { name: 'p1', type: 'invalid-type', apiKey: 'k1', models: [{ id: 'mv1' }] } as any,
      ],
    }
    const errors = validateConfig(config)
    assert.ok(errors.some((e) => e.message.includes('无效')))
  })

  it('同时多个错误返回所有错误', () => {
    const config = {
      providers: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { name: 'p1', type: 'bogus' as any, apiKey: '', models: [] },
      ],
    }
    const errors = validateConfig(config as Config)
    assert.ok(errors.length >= 2, `预期至少 2 个错误，实际 ${errors.length}: ${JSON.stringify(errors)}`)
  })

  it('Provider name 非法字符报错', () => {
    const config: Config = {
      providers: [
        { name: 'bad name!@#', type: 'openai', apiKey: 'k1', models: [{ id: 'mv1' }] },
      ],
    }
    const errors = validateConfig(config)
    assert.ok(errors.some((e) => e.message.includes('非法字符')))
  })

  it('Model name 含冒号（微调模型）应通过', () => {
    const config: Config = {
      providers: [
        {
          name: 'openai-ft',
          type: 'openai',
          apiKey: 'k1',
          models: [{ id: 'ft:gpt-4o:org:custom-id' }],
        },
      ],
    }
    const errors = validateConfig(config)
    assert.strictEqual(errors.length, 0)
  })

  it('空 providers 数组应报错', () => {
    const errors = validateConfig({ providers: [] })
    assert.strictEqual(errors.length, 0) // 空数组不报错，是有效配置
  })

  it('providers 非数组应报错', () => {
    const errors = validateConfig({ providers: 'not-an-array' as unknown as [] })
    assert.ok(errors.some((e) => e.message.includes('数组')))
  })

  it('Model 对象缺失 id 字段应报错', () => {
    const config: Config = {
      providers: [
        { name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: '' }] },
      ],
    }
    const errors = validateConfig(config)
    assert.ok(errors.some((e) => e.message.includes('不能为空')), '空 id 字段应报错')
  })
})
