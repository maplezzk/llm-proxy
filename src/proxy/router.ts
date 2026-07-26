import type { ConfigStore } from '../config/store.js'
import type { RouterResult } from './types.js'
import { getDefaultApiBase } from '../lib/http-utils.js'
import { getModelProtocols, getProviderProtocols, type Model, type Provider, type ProviderType } from '../config/types.js'

export function resolveProviderProtocol(provider: Provider, model: Model, preferredProtocol?: ProviderType) {
  const protocols = getProviderProtocols(provider)
  const supported = new Set(getModelProtocols(provider, model))
  const protocol = (preferredProtocol && supported.has(preferredProtocol)
    ? protocols.find((item) => item.type === preferredProtocol)
    : undefined) ?? protocols.find((item) => supported.has(item.type))
  if (!protocol) {
    throw new Error(`供应商 "${provider.name}" 未配置模型所需的协议`)
  }
  return protocol
}

export function routeModel(
  store: ConfigStore,
  modelName: string,
  preferredProtocol?: ProviderType
): RouterResult {
  const { config } = store.getConfig()
  let fallback: RouterResult | undefined

  for (const provider of config.providers) {
    for (const model of provider.models) {
      if (model.id === modelName) {
        const protocol = resolveProviderProtocol(provider, model, preferredProtocol)
        const apiBase = protocol.apiBase ?? getDefaultApiBase(protocol.type)

        const result: RouterResult = {
          providerName: provider.name,
          providerType: protocol.type,
          apiKey: provider.apiKey,
          apiBase,
          modelId: model.id,
          thinking: model.thinking,
          input: model.input,
        }
        if (!fallback) fallback = result
        if (preferredProtocol && result.providerType === preferredProtocol) return result
      }
    }
  }

  if (fallback) return fallback
  throw new Error(`未找到模型 ID "${modelName}" 对应的 Provider`)
}

/**
 * 按 provider 名称 + 模型 ID 精确路由。
 * 解决不同 provider 下同名模型的歧义问题（如多个 openai 中转站都配了 gpt-4o）。
 */
export function routeModelInProvider(
  store: ConfigStore,
  providerName: string,
  modelName: string,
  preferredProtocol?: ProviderType
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

  const protocol = resolveProviderProtocol(provider, model, preferredProtocol)
  const apiBase = protocol.apiBase ?? getDefaultApiBase(protocol.type)

  return {
    providerName: provider.name,
    providerType: protocol.type,
    apiKey: provider.apiKey,
    apiBase,
    modelId: model.id,
    thinking: model.thinking,
    input: model.input,
  }
}
