import type { Config, ValidationError } from './types.js'

const VALID_PROVIDER_NAMES = /^[a-zA-Z0-9_-]+$/
const VALID_MODEL_NAMES = /^[a-zA-Z0-9_.\-\/:]+$/
const VALID_ADAPTER_NAMES = /^[a-zA-Z][a-zA-Z0-9_-]*$/
const VALID_PROVIDER_TYPES: readonly string[] = ['anthropic', 'openai', 'openai-responses']
const RESERVED_ADAPTER_NAMES = new Set(['admin', 'v1', 'messages', 'chat', 'completions'])

export function validateConfig(config: Config): ValidationError[] {
  const errors = validateProviders(config)
  errors.push(...validateAdapters(config))
  errors.push(...validateVision(config))
  if (config.port != null) {
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      errors.push({ field: 'port', message: 'port 必须为 1-65535 之间的整数' })
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
      errors.push({ field: `providers.${provider.name}.name`, message: `模型供应商名称 "${provider.name}" 包含非法字符，仅支持字母、数字、下划线、中划线` })
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
        errors.push({ field: `providers.${provider.name}.models.${model.id}.id`, message: `模型 ID "${model.id}" 包含非法字符，仅支持字母、数字、下划线、点、中划线、斜杠、冒号` })
      }

      // 校验 thinking 配置
      if (model.thinking) {
        if (provider.type === 'anthropic') {
          if (!model.thinking.budget_tokens && !model.thinking.type && !model.thinking.reasoning_effort) {
            errors.push({ field: `providers.${provider.name}.models.${model.id}.thinking`, message: `Anthropic thinking 模式需要 budget_tokens、reasoning_effort 或 type（如 MiniMax adaptive）` })
          }
          if (model.thinking.budget_tokens && model.thinking.budget_tokens < 0) {
            errors.push({ field: `providers.${provider.name}.models.${model.id}.thinking.budget_tokens`, message: `Anthropic thinking budget_tokens 必须为正整数` })
          }
          if (model.thinking.type && !['adaptive', 'auto', 'enabled', 'disabled'].includes(model.thinking.type)) {
            errors.push({ field: `providers.${provider.name}.models.${model.id}.thinking.type`, message: `thinking.type 必须是 adaptive、auto、enabled 或 disabled` })
          }
          // reasoning_effort 对 Anthropic 也允许：运行时自动查表映射成 budget_tokens
          if (model.thinking.reasoning_effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(model.thinking.reasoning_effort)) {
            errors.push({ field: `providers.${provider.name}.models.${model.id}.thinking.reasoning_effort`, message: `reasoning_effort 必须是 low、medium、high、xhigh 或 max` })
          }
        } else if (provider.type === 'openai' || provider.type === 'openai-responses') {
          if (model.thinking.reasoning_effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(model.thinking.reasoning_effort)) {
            errors.push({ field: `providers.${provider.name}.models.${model.id}.thinking.reasoning_effort`, message: `OpenAI reasoning_effort 必须是 low、medium、high、xhigh 或 max` })
          }
          if (model.thinking.budget_tokens) {
            errors.push({ field: `providers.${provider.name}.models.${model.id}.thinking.budget_tokens`, message: `OpenAI 模型不支持 budget_tokens，请使用 reasoning_effort` })
          }
        }
      }

      // 校验 input 模态配置
      if (model.input !== undefined) {
        if (!Array.isArray(model.input) || model.input.length === 0) {
          errors.push({ field: `providers.${provider.name}.models.${model.id}.input`, message: `input 必须是非空数组，如 ["text", "image"]` })
        } else {
          const validModalities = ['text', 'image']
          for (const mod of model.input) {
            if (!validModalities.includes(mod)) {
              errors.push({ field: `providers.${provider.name}.models.${model.id}.input`, message: `input 模态 "${mod}" 无效，支持: ${validModalities.join(', ')}` })
            }
          }
        }
      }
    }
  }

  return errors
}

/** 校验 vision（外挂识图）配置：provider + model 必须存在且支持图片 */
function validateVision(config: Config): ValidationError[] {
  const errors: ValidationError[] = []
  if (!config.vision) return errors

  if (!config.vision.provider || typeof config.vision.provider !== 'string') {
    errors.push({ field: 'vision.provider', message: '识图模型的 provider 名称不能为空' })
    return errors
  }
  if (!config.vision.model || typeof config.vision.model !== 'string') {
    errors.push({ field: 'vision.model', message: '识图模型 ID 不能为空' })
    return errors
  }

  // 精确定位 provider
  const provider = config.providers.find((p) => p.name === config.vision!.provider)
  if (!provider) {
    errors.push({ field: 'vision.provider', message: `Provider "${config.vision.provider}" 不存在` })
    return errors
  }

  // 精确定位 model
  const model = provider.models.find((m) => m.id === config.vision!.model)
  if (!model) {
    errors.push({ field: 'vision.model', message: `模型 "${config.vision.model}" 不在 provider "${config.vision.provider}" 下` })
    return errors
  }

  // 校验识图模型本身支持图片输入
  if (!model.input?.includes('image')) {
    errors.push({ field: `vision.model`, message: `识图模型 "${config.vision.model}" 未声明 input: ["image"]，识图模型必须支持图片输入` })
  }

  if (config.vision.prompt !== undefined && (typeof config.vision.prompt !== 'string' || config.vision.prompt.trim() === '')) {
    errors.push({ field: 'vision.prompt', message: 'vision.prompt 必须是非空字符串' })
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
      errors.push({ field: `adapters.${adapter.name}.name`, message: `适配器名称 "${adapter.name}" 包含非法字符，必须以字母开头，仅支持字母、数字、下划线、中划线` })
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
