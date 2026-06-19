import type { ConfigStore } from '../config/store.js'
import type { RouterResult } from './types.js'
import { getDefaultApiBase } from '../lib/http-utils.js'

export function routeModel(
  store: ConfigStore,
  modelName: string
): RouterResult {
  const { config } = store.getConfig()

  for (const provider of config.providers) {
    for (const model of provider.models) {
      if (model.id === modelName) {
        const apiBase = provider.apiBase ?? getDefaultApiBase(provider.type)

        return {
          providerName: provider.name,
          providerType: provider.type,
          apiKey: provider.apiKey,
          apiBase,
          modelId: model.id,
          thinking: model.thinking,
          input: model.input,
        }
      }
    }
  }

  throw new Error(`未找到模型 ID "${modelName}" 对应的 Provider`)
}

/**
 * 按 provider 名称 + 模型 ID 精确路由。
 * 解决不同 provider 下同名模型的歧义问题（如多个 openai 中转站都配了 gpt-4o）。
 */
export function routeModelInProvider(
  store: ConfigStore,
  providerName: string,
  modelName: string
): RouterResult {
  const { config } = store.getConfig()

  const provider = config.providers.find((p) => p.name === providerName)
  if (!provider) {
    throw new Error(`Provider "${providerName}" 不存在`)
  }

  const model = provider.models.find((m) => m.id === modelName)
  if (!model) {
    throw new Error(`Provider "${providerName}" 下未找到模型 ID "${modelName}"`)
  }

  const apiBase = provider.apiBase ?? getDefaultApiBase(provider.type)

  return {
    providerName: provider.name,
    providerType: provider.type,
    apiKey: provider.apiKey,
    apiBase,
    modelId: model.id,
    thinking: model.thinking,
    input: model.input,
  }
}
