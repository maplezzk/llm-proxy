import type { ConfigStore } from '../config/store.js'
import type { ProviderType } from '../config/types.js'
import type { RouterResult } from '../proxy/types.js'
import { getDefaultApiBase } from '../lib/http-utils.js'
import { resolveProviderProtocol } from '../proxy/router.js'

export interface AdapterRouteResult {
  route: RouterResult
  inboundType: 'anthropic' | 'openai' | 'openai-responses'
}

export function resolveAdapterRoute(
  store: ConfigStore,
  adapterName: string,
  toolModelName: string,
  preferredProtocol?: ProviderType
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

  // 适配器不再绑定入口协议。实际请求路径（或测试面板选择）决定入站协议；
  // 未指定时使用目标供应商/模型的首个可用协议，兼容旧客户端调用。
  const protocol = resolveProviderProtocol(provider, model, preferredProtocol)
  const inboundType = preferredProtocol ?? protocol.type
  const apiBase = protocol.apiBase ?? getDefaultApiBase(protocol.type)

  // Thinking config: 优先使用适配器映射上的配置，否则使用目标模型的配置
  const thinking = mapping.thinking ?? model.thinking

  return {
    route: {
      providerName: provider.name,
      providerType: protocol.type,
      apiKey: provider.apiKey,
      apiBase,
      modelId: model.id,
      thinking,
      input: model.input,
      max_tokens: adapter.max_tokens,
      stream: adapter.stream ?? null,  // 未配置时为 null（跟随/不注入）
    },
    inboundType,
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
