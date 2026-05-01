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
      })),
    })),
    adapters: (interpolated.adapters ?? []).map((a) => ({
      name: a.name,
      type: a.type,
      models: (a.models ?? []).map((m) => ({
        sourceModelId: m.source_model_id,
        provider: m.provider,
        targetModelId: m.target_model_id,
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
      models: p.models.map((m) => ({ id: m.id })),
    })),
    adapters: (config.adapters ?? []).map((a) => ({
      name: a.name,
      type: a.type,
      models: a.models.map((m) => ({ source_model_id: m.sourceModelId, provider: m.provider, target_model_id: m.targetModelId })),
    })),
    proxy_key: config.proxyKey,
    log_level: config.logLevel,
  }
  return stringifyYaml(file)
}
