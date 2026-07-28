// P1.12 阶段 A：从 legacy-test/config/validator.test.ts 机械迁移（node:test → vitest）
// P1.15 切流：被测对象改指 src 新模块（src/config/validator.ts），断言语义不变。
import { describe, it, expect } from 'vitest'
import { validateConfig } from '../../../src/config/validator.ts'
import type { Config } from '../../../src/config/types.ts'

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
    expect(errors.length).toBe(0)
  })

  it('重复 Provider name 报错', () => {
    const config: Config = {
      providers: [
        { name: 'dup', type: 'openai', apiKey: 'k1', models: [{ id: 'mv1' }] },
        { name: 'dup', type: 'anthropic', apiKey: 'k2', models: [{ id: 'mv2' }] },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.some((e) => e.message.includes('重复'))).toBeTruthy()
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
    expect(errors.some((e) => e.message.includes('重复'))).toBeTruthy()
  })

  it('空 API Key 报错', () => {
    const config: Config = {
      providers: [
        { name: 'p1', type: 'openai', apiKey: '', models: [{ id: 'mv1' }] },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.some((e) => e.message.includes('不能为空'))).toBeTruthy()
  })

  it('无效 Provider type 报错', () => {
    const config = {
      providers: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { name: 'p1', type: 'invalid-type', apiKey: 'k1', models: [{ id: 'mv1' }] } as any,
      ],
    }
    const errors = validateConfig(config)
    expect(errors.some((e) => e.message.includes('无效'))).toBeTruthy()
  })

  it('同时多个错误返回所有错误', () => {
    const config = {
      providers: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { name: 'p1', type: 'bogus' as any, apiKey: '', models: [] },
      ],
    }
    const errors = validateConfig(config as Config)
    expect(errors.length >= 2, `预期至少 2 个错误，实际 ${errors.length}: ${JSON.stringify(errors)}`).toBeTruthy()
  })

  it('Provider name 非法字符报错', () => {
    const config: Config = {
      providers: [
        { name: 'bad name!@#', type: 'openai', apiKey: 'k1', models: [{ id: 'mv1' }] },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.some((e) => e.message.includes('非法字符'))).toBeTruthy()
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
    expect(errors.length).toBe(0)
  })

  it('空 providers 数组应报错', () => {
    const errors = validateConfig({ providers: [] })
    expect(errors.length).toBe(0) // 空数组不报错，是有效配置
  })

  it('providers 非数组应报错', () => {
    const errors = validateConfig({ providers: 'not-an-array' as unknown as [] })
    expect(errors.some((e) => e.message.includes('数组'))).toBeTruthy()
  })

  it('Model 对象缺失 id 字段应报错', () => {
    const config: Config = {
      providers: [
        { name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: '' }] },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.some((e) => e.message.includes('不能为空')), '空 id 字段应报错').toBeTruthy()
  })

  it('Anthropic 模型 valid thinking 配置通过', () => {
    const config: Config = {
      providers: [
        {
          name: 'p1',
          type: 'anthropic',
          apiKey: 'sk-ant-1',
          models: [{ id: 'claude-sonnet-4', thinking: { budget_tokens: 8192 } }],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.length).toBe(0)
  })

  it('Anthropic 模型 budget_tokens 为 0 报错', () => {
    const config: Config = {
      providers: [
        {
          name: 'p1',
          type: 'anthropic',
          apiKey: 'sk-ant-1',
          models: [{ id: 'claude-sonnet-4', thinking: { budget_tokens: 0 } }],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.some((e) => e.message.includes('budget_tokens、reasoning_effort 或 type'))).toBeTruthy()
  })

  it('Anthropic 模型仅 type 配置通过', () => {
    const config: Config = {
      providers: [
        {
          name: 'p1',
          type: 'anthropic',
          apiKey: 'sk-ant-1',
          models: [{ id: 'MiniMax-M3', thinking: { type: 'adaptive' } }],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.length).toBe(0)
  })

  it('Anthropic 模型无效 type 报错', () => {
    const config: Config = {
      providers: [
        {
          name: 'p1',
          type: 'anthropic',
          apiKey: 'sk-ant-1',
          models: [{ id: 'MiniMax-M3', thinking: { type: 'invalid' } }],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.some((e) => e.message.includes('thinking.type'))).toBeTruthy()
  })

  it('Anthropic 模型设置 reasoning_effort 通过', () => {
    const config: Config = {
      providers: [
        {
          name: 'p1',
          type: 'anthropic',
          apiKey: 'sk-ant-1',
          models: [{ id: 'claude-sonnet-4', thinking: { reasoning_effort: 'medium' as any } }],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.length).toBe(0)
  })

  it('OpenAI 模型 valid reasoning_effort 通过', () => {
    const config: Config = {
      providers: [
        {
          name: 'p1',
          type: 'openai',
          apiKey: 'sk-openai-1',
          models: [{ id: 'o3-mini', thinking: { reasoning_effort: 'medium' } }],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.length).toBe(0)
  })

  it('reasoning_effort 支持 xhigh 和 max', () => {
    for (const value of ['xhigh', 'max']) {
      const config: Config = {
        providers: [
          {
            name: 'p1',
            type: 'openai',
            apiKey: 'sk-openai-1',
            models: [{ id: 'o3-mini', thinking: { reasoning_effort: value as any } }],
          },
        ],
      }
      const errors = validateConfig(config)
      expect(errors.length, `${value} should be valid`).toBe(0)
    }
  })

  it('OpenAI 模型无效 reasoning_effort 报错', () => {
    const config: Config = {
      providers: [
        {
          name: 'p1',
          type: 'openai',
          apiKey: 'sk-openai-1',
          models: [{ id: 'o3-mini', thinking: { reasoning_effort: 'super-high' as any } }],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.some((e) => e.message.includes('reasoning_effort 必须是 low、medium、high、xhigh 或 max'))).toBeTruthy()
  })

  it('OpenAI 模型不能设置 budget_tokens', () => {
    const config: Config = {
      providers: [
        {
          name: 'p1',
          type: 'openai',
          apiKey: 'sk-openai-1',
          models: [{ id: 'gpt-4o', thinking: { budget_tokens: 8192 } }],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.some((e) => e.message.includes('不支持 budget_tokens'))).toBeTruthy()
  })

  // --- U1 model groups + override rules ---

  it('有效 model_groups 配置通过校验', () => {
    const config: Config = {
      providers: [
        { name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: 'm1' }] },
        { name: 'p2', type: 'anthropic', apiKey: 'k2', models: [{ id: 'm2' }] },
      ],
      modelGroups: [
        {
          id: 'g1',
          channels: [
            { provider: 'p1', model: 'm1', priority: 1 },
            { provider: 'p2', model: 'm2', priority: 2 },
          ],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.length).toBe(0)
  })

  it('model_groups 渠道引用未知 provider 报错', () => {
    const config: Config = {
      providers: [{ name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: 'm1' }] }],
      modelGroups: [
        {
          id: 'g1',
          channels: [{ provider: 'unknown-p', model: 'm1' }],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.some((e) => e.message.includes('不存在的 Provider'))).toBeTruthy()
  })

  it('model_groups 渠道引用未知 model 报错', () => {
    const config: Config = {
      providers: [{ name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: 'm1' }] }],
      modelGroups: [
        {
          id: 'g1',
          channels: [{ provider: 'p1', model: 'unknown-m' }],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.some((e) => e.message.includes('不存在的模型'))).toBeTruthy()
  })

  it('adapter mapping 同时带 model 引用和 legacy 对报错', () => {
    const config: Config = {
      providers: [{ name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: 'm1' }] }],
      modelGroups: [{ id: 'g1', channels: [{ provider: 'p1', model: 'm1' }] }],
      adapters: [
        {
          name: 'a1',
          type: 'openai',
          models: [
            {
              sourceModelId: 'alias',
              model: 'g1',
              provider: 'p1',
              targetModelId: 'm1',
            },
          ],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(
      errors.some((e) => e.message.includes('不能同时指定 model 引用和 legacy provider+targetModelId')),
    ).toBeTruthy()
  })

  it('adapter mapping 仅 model 引用通过校验', () => {
    const config: Config = {
      providers: [{ name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: 'm1' }] }],
      modelGroups: [{ id: 'g1', channels: [{ provider: 'p1', model: 'm1' }] }],
      adapters: [
        {
          name: 'a1',
          type: 'openai',
          models: [
            {
              sourceModelId: 'alias',
              model: 'g1',
            },
          ],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.length).toBe(0)
  })

  it('adapter mapping 仅 legacy 对通过校验（兼容）', () => {
    const config: Config = {
      providers: [{ name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: 'm1' }] }],
      adapters: [
        {
          name: 'a1',
          type: 'openai',
          models: [
            {
              sourceModelId: 'alias',
              provider: 'p1',
              targetModelId: 'm1',
            },
          ],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.length).toBe(0)
  })

  it('override rule targeting 保护字段 model 报错', () => {
    const config: Config = {
      providers: [{ name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: 'm1' }] }],
      modelGroups: [{ id: 'g1', channels: [{ provider: 'p1', model: 'm1' }] }],
      adapters: [
        {
          name: 'a1',
          type: 'openai',
          models: [
            {
              sourceModelId: 'alias',
              model: 'g1',
              overrides: [
                {
                  scope: 'adapter-alias',
                  body: [{ op: 'set', path: 'model', value: 'hijack' }],
                },
              ],
            },
          ],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(
      errors.some((e) => e.message.includes('受保护字段') && e.message.includes('model')),
    ).toBeTruthy()
  })

  it('override rule targeting 保护字段 messages 报错', () => {
    const config: Config = {
      providers: [{ name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: 'm1' }] }],
      modelGroups: [{ id: 'g1', channels: [{ provider: 'p1', model: 'm1' }] }],
      adapters: [
        {
          name: 'a1',
          type: 'openai',
          models: [
            {
              sourceModelId: 'alias',
              model: 'g1',
              overrides: [
                {
                  scope: 'channel',
                  body: [{ op: 'delete', path: 'messages' }],
                },
              ],
            },
          ],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(
      errors.some((e) => e.message.includes('受保护字段') && e.message.includes('messages')),
    ).toBeTruthy()
  })

  it('override rule 合法字段通过校验', () => {
    const config: Config = {
      providers: [{ name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: 'm1' }] }],
      modelGroups: [{ id: 'g1', channels: [{ provider: 'p1', model: 'm1' }] }],
      adapters: [
        {
          name: 'a1',
          type: 'openai',
          models: [
            {
              sourceModelId: 'alias',
              model: 'g1',
              overrides: [
                {
                  scope: 'adapter-alias',
                  when: '{{model}} == "alias"',
                  body: [
                    { op: 'set', path: 'temperature', value: 0.3 },
                    { op: 'set_if_absent', path: 'top_p', value: 0.9 },
                    { op: 'delete', path: 'metadata.debug' },
                  ],
                  headers: [
                    { op: 'set', name: 'X-Channel', value: 'p1' },
                    { op: 'delete', name: 'X-Internal' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.length).toBe(0)
  })

  it('adapter on_failure: fallback 解析通过，非法值报错', () => {
    const validConfig: Config = {
      providers: [{ name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: 'm1' }] }],
      adapters: [
        {
          name: 'a1',
          type: 'openai',
          onFailure: 'fallback',
          models: [{ sourceModelId: 'alias', provider: 'p1', targetModelId: 'm1' }],
        },
      ],
    }
    expect(validateConfig(validConfig).length).toBe(0)

    const invalidConfig: Config = {
      providers: [{ name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: 'm1' }] }],
      adapters: [
        {
          name: 'a1',
          type: 'openai',
          onFailure: 'invalid-mode' as 'hard_fail',
          models: [{ sourceModelId: 'alias', provider: 'p1', targetModelId: 'm1' }],
        },
      ],
    }
    const errors = validateConfig(invalidConfig)
    expect(errors.some((e) => e.message.includes('onFailure'))).toBeTruthy()
  })

  it('override rule 非法 scope 报错', () => {
    const config: Config = {
      providers: [{ name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: 'm1' }] }],
      modelGroups: [{ id: 'g1', channels: [{ provider: 'p1', model: 'm1' }] }],
      adapters: [
        {
          name: 'a1',
          type: 'openai',
          models: [
            {
              sourceModelId: 'alias',
              model: 'g1',
              overrides: [
                {
                  scope: 'everywhere' as 'adapter-alias',
                  body: [{ op: 'set', path: 'temperature', value: 0.3 }],
                },
              ],
            },
          ],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.some((e) => e.message.includes('scope'))).toBeTruthy()
  })

  it('override rule 非法 body op 报错', () => {
    const config: Config = {
      providers: [{ name: 'p1', type: 'openai', apiKey: 'k1', models: [{ id: 'm1' }] }],
      modelGroups: [{ id: 'g1', channels: [{ provider: 'p1', model: 'm1' }] }],
      adapters: [
        {
          name: 'a1',
          type: 'openai',
          models: [
            {
              sourceModelId: 'alias',
              model: 'g1',
              overrides: [
                {
                  scope: 'adapter-alias',
                  body: [
                    { op: 'rename' as 'set', path: 'temperature', value: 0.3 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    const errors = validateConfig(config)
    expect(errors.some((e) => e.message.includes('op'))).toBeTruthy()
  })
})
