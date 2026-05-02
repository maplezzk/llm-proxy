import type { Config, ValidationError } from './types.js'

const VALID_PROVIDER_NAMES = /^[a-zA-Z0-9_-]+$/
const VALID_MODEL_NAMES = /^[a-zA-Z0-9_.\-\/:]+$/
const VALID_ADAPTER_NAMES = /^[a-zA-Z][a-zA-Z0-9_-]*$/
const VALID_PROVIDER_TYPES: readonly string[] = ['anthropic', 'openai', 'openai-responses']
const RESERVED_ADAPTER_NAMES = new Set(['admin', 'v1', 'messages', 'chat', 'completions'])

export function validateConfig(config: Config): ValidationError[] {
  const errors = validateProviders(config)
  errors.push(...validateAdapters(config))
  if (config.maxBodySize != null) {
    if (!Number.isInteger(config.maxBodySize) || config.maxBodySize < 1) {
      errors.push({ field: 'max_body_size', message: 'max_body_size 必须为正整数（字节数）' })
    }
  }
  return errors
}

function validateProviders(config: Config): ValidationError[] {
  const errors: ValidationError[] = []

  if (!config.providers || !Array.isArray(config.providers)) {
    errors.push({ field: 'providers', message: 'providers 必须是一个数组' })
    return errors
  }

  const providerNames = new Set<string>()

  for (const provider of config.providers) {
    if (!provider.name || typeof provider.name !== 'string') {
      errors.push({ field: 'providers[].name', message: '模型供应商名称不能为空' })
      continue
    }

    if (!VALID_PROVIDER_NAMES.test(provider.name)) {
      errors.push({ field: `providers.${provider.name}.name`, message: `模型供应商名称 "${provider.name}" 包含非法字符` })
    }

    if (providerNames.has(provider.name)) {
      errors.push({ field: `providers.${provider.name}.name`, message: `模型供应商名称 "${provider.name}" 重复` })
    }
    providerNames.add(provider.name)

    if (!VALID_PROVIDER_TYPES.includes(provider.type)) {
      errors.push({ field: `providers.${provider.name}.type`, message: `模型供应商类型 "${provider.type}" 无效，仅支持 anthropic 和 openai` })
    }

    if (!provider.apiKey || typeof provider.apiKey !== 'string' || provider.apiKey.trim() === '') {
      errors.push({ field: `providers.${provider.name}.api_key`, message: 'API Key 不能为空' })
    }

    if (!provider.models || !Array.isArray(provider.models) || provider.models.length === 0) {
      errors.push({ field: `providers.${provider.name}.models`, message: '每个模型供应商至少需要一个模型 ID' })
      continue
    }

    const modelIds = new Set<string>()
    for (const model of provider.models) {
      if (!model.id || typeof model.id !== 'string') {
        errors.push({ field: `providers.${provider.name}.models[].id`, message: '模型 ID 不能为空' })
        continue
      }

      if (modelIds.has(model.id)) {
        errors.push({ field: `providers.${provider.name}.models.${model.id}.id`, message: `模型 ID "${model.id}" 在模型供应商 "${provider.name}" 中重复` })
      }
      modelIds.add(model.id)

      if (!VALID_MODEL_NAMES.test(model.id)) {
        errors.push({ field: `providers.${provider.name}.models.${model.id}.id`, message: `模型 ID "${model.id}" 包含非法字符` })
      }

      // 校验 thinking 配置
      if (model.thinking) {
        if (provider.type === 'anthropic') {
          if (!model.thinking.budget_tokens || model.thinking.budget_tokens < 0) {
            errors.push({ field: `providers.${provider.name}.models.${model.id}.thinking.budget_tokens`, message: `Anthropic thinking 模式需要有效的 budget_tokens（正整数）` })
          }
          if (model.thinking.reasoning_effort) {
            errors.push({ field: `providers.${provider.name}.models.${model.id}.thinking.reasoning_effort`, message: `Anthropic 模型不支持 reasoning_effort` })
          }
        } else if (provider.type === 'openai' || provider.type === 'openai-responses') {
          if (model.thinking.reasoning_effort && !['low', 'medium', 'high'].includes(model.thinking.reasoning_effort)) {
            errors.push({ field: `providers.${provider.name}.models.${model.id}.thinking.reasoning_effort`, message: `OpenAI reasoning_effort 必须是 low、medium 或 high` })
          }
          if (model.thinking.budget_tokens) {
            errors.push({ field: `providers.${provider.name}.models.${model.id}.thinking.budget_tokens`, message: `OpenAI 模型不支持 budget_tokens，请使用 reasoning_effort` })
          }
        }
      }
    }
  }

  return errors
}

function validateAdapters(config: Config): ValidationError[] {
  const errors: ValidationError[] = []

  if (!config.adapters || config.adapters.length === 0) {
    return errors
  }

  const adapterNames = new Set<string>()
  const providerNames = new Set(config.providers.map((p) => p.name))

  for (const adapter of config.adapters) {
    if (!adapter.name || typeof adapter.name !== 'string') {
      errors.push({ field: 'adapters[].name', message: '适配器名称不能为空' })
      continue
    }

    if (!VALID_ADAPTER_NAMES.test(adapter.name)) {
      errors.push({ field: `adapters.${adapter.name}.name`, message: `适配器名称 "${adapter.name}" 包含非法字符（必须以字母开头）` })
    }

    if (RESERVED_ADAPTER_NAMES.has(adapter.name)) {
      errors.push({ field: `adapters.${adapter.name}.name`, message: `适配器名称 "${adapter.name}" 是保留字` })
    }

    if (adapterNames.has(adapter.name)) {
      errors.push({ field: `adapters.${adapter.name}.name`, message: `适配器名称 "${adapter.name}" 重复` })
    }
    adapterNames.add(adapter.name)

    if (providerNames.has(adapter.name)) {
      errors.push({ field: `adapters.${adapter.name}.name`, message: `适配器名称 "${adapter.name}" 与模型供应商名称冲突` })
    }

    if (!VALID_PROVIDER_TYPES.includes(adapter.type)) {
      errors.push({ field: `adapters.${adapter.name}.type`, message: `适配器类型 "${adapter.type}" 无效，仅支持 anthropic 和 openai` })
    }

    if (!adapter.models || !Array.isArray(adapter.models) || adapter.models.length === 0) {
      errors.push({ field: `adapters.${adapter.name}.models`, message: '每个适配器至少需要一个模型映射' })
      continue
    }

    const mappingSourceIds = new Set<string>()
    for (const mapping of adapter.models) {
      if (!mapping.sourceModelId || typeof mapping.sourceModelId !== 'string') {
        errors.push({ field: `adapters.${adapter.name}.models[].sourceModelId`, message: '适配前模型 ID 不能为空' })
        continue
      }

      if (mappingSourceIds.has(mapping.sourceModelId)) {
        errors.push({ field: `adapters.${adapter.name}.models.${mapping.sourceModelId}.sourceModelId`, message: `适配前模型 ID "${mapping.sourceModelId}" 在适配器 "${adapter.name}" 中重复` })
      }
      mappingSourceIds.add(mapping.sourceModelId)

      if (!mapping.provider || typeof mapping.provider !== 'string') {
        errors.push({ field: `adapters.${adapter.name}.models.${mapping.sourceModelId}.provider`, message: '供应商不能为空' })
      }

      if (!mapping.targetModelId || typeof mapping.targetModelId !== 'string') {
        errors.push({ field: `adapters.${adapter.name}.models.${mapping.sourceModelId}.targetModelId`, message: '适配后模型 ID 不能为空' })
      }
    }
  }

  return errors
}
