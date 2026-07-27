// P1.12 阶段 A：从 legacy-test/config/parser.test.ts 机械迁移（node:test → vitest）
// P1.15 切流：被测对象改指 src 新模块（src/config/parser.ts），断言语义不变。
import { describe, it, expect, beforeAll } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfigFromYaml } from '../../../src/config/parser.ts'

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
})
