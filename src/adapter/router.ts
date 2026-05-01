import type { ConfigStore } from '../config/store.js'
import type { RouterResult } from '../proxy/types.js'
import { getDefaultApiBase } from '../lib/http-utils.js'

export interface AdapterRouteResult {
  route: RouterResult
  inboundType: 'anthropic' | 'openai' | 'openai-responses'
}

export function resolveAdapterRoute(
  store: ConfigStore,
  adapterName: string,
  toolModelName: string
): AdapterRouteResult {
  const { config } = store.getConfig()

  const adapter = config.adapters?.find((a) => a.name === adapterName)
  if (!adapter) {
    throw new AdapterError(`适配器 "${adapterName}" 未找到`, 'ADAPTER_NOT_FOUND')
  }

  const mapping = adapter.models.find((m) => m.sourceModelId === toolModelName)
  if (!mapping) {
    throw new AdapterError(
      `适配器 "${adapterName}" 中未找到模型映射 "${toolModelName}"`,
      'MODEL_MAPPING_NOT_FOUND'
    )
  }

  const provider = config.providers.find((p) => p.name === mapping.provider)
  if (!provider) {
    throw new AdapterError(
      `适配器 "${adapterName}" 引用的模型供应商 "${mapping.provider}" 不存在`,
      'PROVIDER_NOT_FOUND'
    )
  }

  const model = provider.models.find((m) => m.id === mapping.targetModelId)
  if (!model) {
    throw new AdapterError(
      `模型供应商 "${mapping.provider}" 中未找到模型 "${mapping.targetModelId}"（适配器 "${adapterName}" 引用）`,
      'MODEL_NOT_FOUND'
    )
  }

  const apiBase = provider.apiBase ?? getDefaultApiBase(provider.type)

  return {
    route: {
      providerName: provider.name,
      providerType: provider.type,
      apiKey: provider.apiKey,
      apiBase,
      modelId: model.id,
    },
    inboundType: adapter.type,
  }
}

export class AdapterError extends Error {
  code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'AdapterError'
    this.code = code
  }
}
