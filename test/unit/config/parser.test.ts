// P1.12 阶段 A：从 legacy-test/config/parser.test.ts 机械迁移（node:test → vitest）
// P1.15 切流：被测对象改指 src 新模块（src/config/parser.ts），断言语义不变。
import { describe, it, expect, beforeAll } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfigFromYaml, serializeConfigToYaml } from '../../../src/config/parser.ts'

let tmpDir: string

function writeConfig(content: string): string {
  const path = join(tmpDir, `config-${Date.now()}-${Math.random()}.yaml`)
  writeFileSync(path, content, 'utf-8')
  return path
}

describe('config/parser', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'llm-proxy-test-'))
  })

  it('解析有效 YAML 配置', () => {
    process.env.TEST_API_KEY = 'sk-test-123'
    const path = writeConfig(`
providers:
  - name: test-provider
    type: anthropic
    api_key: \${TEST_API_KEY}
    models:
      - id: claude-test-model
    `)
    const config = loadConfigFromYaml(path)
    expect(config.providers.length).toBe(1)
    expect(config.providers[0].name).toBe('test-provider')
    expect(config.providers[0].type).toBe('anthropic')
    expect(config.providers[0].apiKey).toBe('sk-test-123')
    expect(config.providers[0].models.length).toBe(1)
    expect(config.providers[0].models[0].id).toBe('claude-test-model')
  })

  it('环境变量插值正确替换', () => {
    process.env.ANTHRO_KEY = 'sk-ant-xxx'
    process.env.OPENAI_KEY = 'sk-openai-yyy'
    const path = writeConfig(`
providers:
  - name: p1
    type: anthropic
    api_key: \${ANTHRO_KEY}
    models:
      - id: m1v1
  - name: p2
    type: openai
    api_key: \${OPENAI_KEY}
    models:
      - id: m2v1
    `)
    const config = loadConfigFromYaml(path)
    expect(config.providers[0].apiKey).toBe('sk-ant-xxx')
    expect(config.providers[1].apiKey).toBe('sk-openai-yyy')
  })

  it('未定义环境变量抛错', () => {
    const path = writeConfig(`
providers:
  - name: test
    type: openai
    api_key: \${UNDEFINED_VAR_XYZ}
    models:
      - id: mv
    `)
    expect(() => loadConfigFromYaml(path)).toThrow('环境变量 UNDEFINED_VAR_XYZ 未定义')
  })

  it('YAML 语法错误抛错', () => {
    const path = writeConfig(`invalid: [yaml: broken`)
    expect(() => loadConfigFromYaml(path)).toThrow()
  })

  it('缺失必要字段正常解析（校验交由 validator 处理）', () => {
    process.env.K = 'v'
    const path = writeConfig(`
providers:
  - name: minimal
    type: openai
    api_key: \${K}
    models:
      - id: mv
    `)
    const config = loadConfigFromYaml(path)
    expect(config.providers.length).toBe(1)
    expect(config.providers[0].name).toBe('minimal')
  })

  it('解析 Anthropic thinking 配置', () => {
    process.env.K = 'sk-ant-1'
    const path = writeConfig(`
providers:
  - name: p1
    type: anthropic
    api_key: \${K}
    models:
      - id: claude-sonnet-4
        thinking:
          budget_tokens: 8192
    `)
    const config = loadConfigFromYaml(path)
    expect(config.providers[0].models[0].thinking?.budget_tokens).toBe(8192)
    expect(config.providers[0].models[0].thinking?.reasoning_effort).toBe(undefined)
  })

  it('解析 OpenAI reasoning_effort 配置', () => {
    process.env.K = 'sk-openai-1'
    const path = writeConfig(`
providers:
  - name: p1
    type: openai
    api_key: \${K}
    models:
      - id: o3-mini
        reasoning_effort: high
    `)
    const config = loadConfigFromYaml(path)
    expect(config.providers[0].models[0].thinking?.reasoning_effort).toBe('high')
    expect(config.providers[0].models[0].thinking?.budget_tokens).toBe(undefined)
  })

  it('解析适配器 thinking 配置', () => {
    process.env.K = 'sk-ant-1'
    const path = writeConfig(`
providers:
  - name: p1
    type: anthropic
    api_key: \${K}
    models:
      - id: claude-sonnet-4

adapters:
  - name: my-tool
    type: anthropic
    models:
      - source_model_id: claude-sonnet-4
        provider: p1
        target_model_id: claude-sonnet-4-20250514
        thinking:
          budget_tokens: 4096
    `)
    const config = loadConfigFromYaml(path)
    expect(config.adapters![0].models[0].thinking?.budget_tokens).toBe(4096)
  })

  it('解析 thinking.type 配置（MiniMax adaptive）', () => {
    process.env.K = 'sk-minimax-1'
    const path = writeConfig(`
providers:
  - name: minimax
    type: anthropic
    api_key: \${K}
    models:
      - id: MiniMax-M3
        thinking:
          type: adaptive
    `)
    const config = loadConfigFromYaml(path)
    expect(config.providers[0].models[0].thinking?.type).toBe('adaptive')
    expect(config.providers[0].models[0].thinking?.budget_tokens).toBe(undefined)
  })

  it('解析 model_groups section + 渠道绑定', () => {
    process.env.K = 'sk-1'
    const path = writeConfig(`
providers:
  - name: deepseek
    type: openai
    api_key: \${K}
    models:
      - id: deepseek-chat
  - name: kiro
    type: anthropic
    api_key: \${K}
    models:
      - id: claude-sonnet-4

model_groups:
  - id: sonnet
    context_window: 200000
    max_output_tokens: 8192
    channels:
      - provider: kiro
        model: claude-sonnet-4
        priority: 1
      - provider: deepseek
        model: deepseek-chat
        priority: 2
        context_window: 128000
    `)
    const config = loadConfigFromYaml(path)
    expect(config.modelGroups?.length).toBe(1)
    const group = config.modelGroups![0]
    expect(group.id).toBe('sonnet')
    expect(group.contextWindow).toBe(200000)
    expect(group.maxOutputTokens).toBe(8192)
    expect(group.channels.length).toBe(2)
    expect(group.channels[0].provider).toBe('kiro')
    expect(group.channels[0].model).toBe('claude-sonnet-4')
    expect(group.channels[0].priority).toBe(1)
    expect(group.channels[1].provider).toBe('deepseek')
    expect(group.channels[1].contextWindow).toBe(128000)
  })

  it('解析仅一对一 adapter mapping 的 legacy 配置', () => {
    process.env.K = 'sk-1'
    const path = writeConfig(`
providers:
  - name: p1
    type: anthropic
    api_key: \${K}
    models:
      - id: m1

adapters:
  - name: legacy-tool
    type: anthropic
    models:
      - source_model_id: m1
        provider: p1
        target_model_id: m1-real
    `)
    const config = loadConfigFromYaml(path)
    expect(config.adapters![0].models[0].sourceModelId).toBe('m1')
    expect(config.adapters![0].models[0].provider).toBe('p1')
    expect(config.adapters![0].models[0].targetModelId).toBe('m1-real')
    expect(config.adapters![0].models[0].model).toBe(undefined)
    expect(config.adapters![0].models[0].channel).toBe(undefined)
  })

  it('解析 adapter 别名带 model 引用 + 钉死 channel', () => {
    process.env.K = 'sk-1'
    const path = writeConfig(`
providers:
  - name: p1
    type: openai
    api_key: \${K}
    models:
      - id: gpt-4o

model_groups:
  - id: gpt-4o-group
    channels:
      - provider: p1
        model: gpt-4o

adapters:
  - name: my-tool
    type: openai
    on_failure: fallback
    models:
      - source_model_id: smart
        model: gpt-4o-group
        channel: p1/gpt-4o
    `)
    const config = loadConfigFromYaml(path)
    expect(config.adapters![0].onFailure).toBe('fallback')
    expect(config.adapters![0].models[0].sourceModelId).toBe('smart')
    expect(config.adapters![0].models[0].model).toBe('gpt-4o-group')
    expect(config.adapters![0].models[0].channel).toBe('p1/gpt-4o')
  })

  it('解析 override rule 带 body+header ops + when 条件', () => {
    process.env.K = 'sk-1'
    const path = writeConfig(`
providers:
  - name: p1
    type: openai
    api_key: \${K}
    models:
      - id: m1

model_groups:
  - id: g1
    channels:
      - provider: p1
        model: m1

adapters:
  - name: tool
    type: openai
    models:
      - source_model_id: alias
        model: g1
        overrides:
          - scope: adapter-alias
            when: '{{model}} == "alias"'
            body:
              - op: set
                path: temperature
                value: 0.3
              - op: set_if_absent
                path: top_p
                value: 0.9
              - op: delete
                path: metadata.debug
            headers:
              - op: set
                name: X-Channel
                value: p1
              - op: delete
                name: X-Internal
    `)
    const config = loadConfigFromYaml(path)
    const overrides = config.adapters![0].models[0].overrides
    expect(overrides?.length).toBe(1)
    const rule = overrides![0]
    expect(rule.scope).toBe('adapter-alias')
    expect(rule.when).toBe('{{model}} == "alias"')
    expect(rule.body?.length).toBe(3)
    expect(rule.body![0]).toEqual({ op: 'set', path: 'temperature', value: 0.3 })
    expect(rule.body![1]).toEqual({ op: 'set_if_absent', path: 'top_p', value: 0.9 })
    expect(rule.body![2]).toEqual({ op: 'delete', path: 'metadata.debug' })
    expect(rule.headers?.length).toBe(2)
    expect(rule.headers![0]).toEqual({ op: 'set', name: 'X-Channel', value: 'p1' })
    expect(rule.headers![1]).toEqual({ op: 'delete', name: 'X-Internal' })
  })

  it('解析 provider 的 priority/enabled 与 model 的 context_window', () => {
    process.env.K = 'sk-1'
    const path = writeConfig(`
providers:
  - name: p1
    type: openai
    api_key: \${K}
    priority: 10
    enabled: true
    models:
      - id: m1
        context_window: 128000
  - name: p2
    type: openai
    api_key: \${K}
    enabled: false
    models:
      - id: m2
    `)
    const config = loadConfigFromYaml(path)
    expect(config.providers[0].priority).toBe(10)
    expect(config.providers[0].enabled).toBe(true)
    expect(config.providers[0].models[0].contextWindow).toBe(128000)
    expect(config.providers[1].enabled).toBe(false)
    expect(config.providers[1].priority).toBe(undefined)
  })

  it('序列化 model_groups section 保持对称', () => {
    process.env.K = 'sk-1'
    const path = writeConfig(`
providers:
  - name: p1
    type: openai
    api_key: \${K}
    models:
      - id: m1

model_groups:
  - id: g1
    channels:
      - provider: p1
        model: m1
        priority: 1

adapters:
  - name: tool
    type: openai
    models:
      - source_model_id: alias
        model: g1
        overrides:
          - scope: channel
            body:
              - op: set
                path: temperature
                value: 0.5
    `)
    const config = loadConfigFromYaml(path)
    const yaml = serializeConfigToYaml(config)
    expect(yaml).toContain('model_groups:')
    expect(yaml).toContain('id: g1')
    expect(yaml).toContain('model: g1')
    expect(yaml).toContain('overrides:')
    expect(yaml).toContain('scope: channel')
    expect(yaml).toContain('op: set')
    expect(yaml).toContain('path: temperature')
  })
})
