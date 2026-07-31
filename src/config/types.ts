export type ProviderType = 'anthropic' | 'openai' | 'openai-responses'

/** 模型支持的输入模态。未配置时视为仅支持文本（向后兼容） */
export type InputModality = 'text' | 'image' | 'audio' | 'video' | 'file'

export interface ThinkingConfig {
  /** Anthropic: thinking budget tokens (启用 thinking 模式时必填) */
  budget_tokens?: number
  /** OpenAI: reasoning_effort (low | medium | high | xhigh | max) */
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** thinking.type 透传值（如 MiniMax adaptive），优先级低于 budget_tokens/reasoning_effort */
  type?: string
}

export interface Model {
  id: string
  /** 模型支持的上游协议；未配置时继承供应商的全部协议 */
  protocols?: ProviderType[]
  /** 上一版本的单协议字段，保留兼容 */
  protocol?: ProviderType
  thinking?: ThinkingConfig
  /** 模型支持的输入模态列表，如 ["text", "image"]。未配置时默认 ["text"] */
  input?: InputModality[]
}

/** 外挂多模态识图配置 */
export interface VisionConfig {
  /** 识图模型所在的 provider 名称（必须） */
  provider: string
  /** 识图模型 ID（必须） */
  model: string
  /** 自定义识图提示词，未配置时使用默认值 */
  prompt?: string
}

export interface Provider {
  name: string
  apiKey: string
  /** 新格式：同一供应商可配置多个协议及各自的 API Base。 */
  protocols?: ProviderProtocol[]
  /** 旧格式字段，保留用于兼容已有配置。 */
  type?: ProviderType
  apiBase?: string
  models: Model[]
}

export interface ProviderProtocol {
  type: ProviderType
  apiBase?: string
}

/** 将新旧两种配置格式统一为协议列表。 */
export function getProviderProtocols(provider: Provider): ProviderProtocol[] {
  if (provider.protocols !== undefined) return provider.protocols
  return provider.type ? [{ type: provider.type, apiBase: provider.apiBase }] : []
}

/** 返回供应商在状态列表等只需要一个类型的场景下使用的主协议。 */
export function getProviderPrimaryType(provider: Provider): ProviderType {
  const protocol = getProviderProtocols(provider)[0]
  if (!protocol) throw new Error(`供应商 "${provider.name}" 未配置协议`)
  return protocol.type
}

/** 返回模型支持的协议。旧模型默认支持其供应商配置的全部协议。 */
export function getModelProtocols(provider: Provider, model: Model): ProviderType[] {
  if (model.protocols?.length) return model.protocols
  if (model.protocol) return [model.protocol]
  return getProviderProtocols(provider).map((protocol) => protocol.type)
}

export interface AdapterModelMapping {
  sourceModelId: string
  provider: string
  targetModelId: string
  thinking?: ThinkingConfig
}

export interface AdapterConfig {
  name: string
  type: ProviderType
  /** 默认 max_tokens，客户端没传时使用 */
  max_tokens?: number
  /** 下游未传 stream 时的默认值。未配置（undefined）时沿用内置默认 true（流式） */
  stream?: boolean
  models: AdapterModelMapping[]
}

export interface Config {
  providers: Provider[]
  adapters?: AdapterConfig[]
  /** 外挂多模态识图配置，为不支持图片的模型提供自动识图能力 */
  vision?: VisionConfig
  /** 管理接口认证密钥；设置后除 Web UI 外壳外的 /admin* 请求必须携带该密钥 */
  adminKey?: string
  proxyKey?: string
  logLevel?: LogLevel
  locale?: string
  /** 端口号，不设则默认 9000 */
  port?: number
  /** 抓包缓冲区最大条数，默认 100 */
  captureMaxSize?: number
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ThinkingConfigFile {
  budget_tokens?: number
  reasoning_effort?: string
  type?: string
}

export interface ProviderConfigFile {
  name: string
  type?: ProviderType
  api_key: string
  api_base?: string
  protocols?: { type: ProviderType; api_base?: string }[]
  models: { id: string; protocols?: ProviderType[]; protocol?: ProviderType; thinking?: ThinkingConfigFile; reasoning_effort?: string; input?: string[] }[]
}

export interface AdapterConfigFile {
  name: string
  type: ProviderType
  max_tokens?: number
  stream?: boolean
  models: { source_model_id: string; provider: string; target_model_id: string; thinking?: ThinkingConfigFile; reasoning_effort?: string }[]
}

export interface ConfigFile {
  providers: ProviderConfigFile[]
  adapters?: AdapterConfigFile[]
  vision?: { provider: string; model: string; prompt?: string }
  admin_key?: string
  proxy_key?: string
  log_level?: string
  locale?: string
  port?: number
  capture_max_size?: number
}

export interface ValidationError {
  field: string
  message: string
}

export type ReloadResult =
  | { success: true; version: number }
  | { success: false; errors: ValidationError[] }

export interface ProviderStatus {
  name: string
  type: ProviderType
  avgLatency: number
  errorRate: number
  totalRequests: number
  available: boolean
}
