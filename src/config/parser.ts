import { readFileSync, writeFileSync } from 'node:fs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Config, ConfigFile } from './types.js'

const ENV_VAR_PATTERN = /\$\{(\w+)\}/g

function interpolateEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName: string) => {
    const envVal = process.env[varName]
    if (envVal === undefined) {
      throw new Error(`环境变量 ${varName} 未定义`)
    }
    return envVal
  })
}

function parseThinkingConfig(m: { thinking?: { budget_tokens?: number }; reasoning_effort?: string }): import('./types.js').ThinkingConfig | undefined {
  const tc: import('./types.js').ThinkingConfig = {}
  if (m.thinking?.budget_tokens && m.thinking.budget_tokens > 0) {
    tc.budget_tokens = m.thinking.budget_tokens
  }
  if (m.reasoning_effort && ['low', 'medium', 'high'].includes(m.reasoning_effort)) {
    tc.reasoning_effort = m.reasoning_effort as 'low' | 'medium' | 'high'
  }
  if (tc.budget_tokens === undefined && tc.reasoning_effort === undefined) return undefined
  return tc
}

function interpolateAll(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return interpolateEnvVars(obj)
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateAll)
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateAll(value)
    }
    return result
  }
  return obj
}

export function loadConfigFromYaml(filePath: string): Config {
  const raw = readFileSync(filePath, 'utf-8')
  const parsed = parseYaml(raw) as ConfigFile
  const interpolated = interpolateAll(parsed) as ConfigFile

  return {
    providers: interpolated.providers.map((p) => ({
      name: p.name,
      type: p.type,
      apiKey: p.api_key,
      apiBase: p.api_base,
      models: p.models.map((m) => ({
        id: m.id,
        thinking: parseThinkingConfig(m),
      })),
    })),
    adapters: (interpolated.adapters ?? []).map((a) => ({
      name: a.name,
      type: a.type,
      models: (a.models ?? []).map((m) => ({
        sourceModelId: m.source_model_id,
        provider: m.provider,
        targetModelId: m.target_model_id,
        thinking: parseThinkingConfig(m),
      })),
    })),
    proxyKey: interpolated.proxy_key,
    logLevel: (['debug','info','warn','error'].includes(interpolated.log_level as string) ? interpolated.log_level : undefined) as Config['logLevel'],
  }
}

export function serializeConfigToYaml(config: Config): string {
  const file: ConfigFile = {
    providers: config.providers.map((p) => ({
      name: p.name,
      type: p.type,
      api_key: p.apiKey,
      api_base: p.apiBase,
      models: p.models.map((m) => ({
        id: m.id,
        ...(m.thinking?.budget_tokens ? { thinking: { budget_tokens: m.thinking.budget_tokens } } : {}),
        ...(m.thinking?.reasoning_effort ? { reasoning_effort: m.thinking.reasoning_effort } : {}),
      })),
    })),
    adapters: (config.adapters ?? []).map((a) => ({
      name: a.name,
      type: a.type,
      models: a.models.map((m) => ({
        source_model_id: m.sourceModelId,
        provider: m.provider,
        target_model_id: m.targetModelId,
        ...(m.thinking?.budget_tokens ? { thinking: { budget_tokens: m.thinking.budget_tokens } } : {}),
        ...(m.thinking?.reasoning_effort ? { reasoning_effort: m.thinking.reasoning_effort } : {}),
      })),
    })),
    proxy_key: config.proxyKey,
    log_level: config.logLevel,
  }
  return stringifyYaml(file)
}
