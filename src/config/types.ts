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
  type: ProviderType
  apiKey: string
  apiBase?: string
  models: Model[]
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
  models: AdapterModelMapping[]
}

export interface Config {
  providers: Provider[]
  adapters?: AdapterConfig[]
  /** 外挂多模态识图配置，为不支持图片的模型提供自动识图能力 */
  vision?: VisionConfig
  proxyKey?: string
  logLevel?: LogLevel
  locale?: string
  /** 端口号，不设则默认 9000 */
  port?: number
  /** 请求体大小限制（字节），不设则默认 10MB */
  maxBodySize?: number
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
  type: ProviderType
  api_key: string
  api_base?: string
  models: { id: string; thinking?: ThinkingConfigFile; reasoning_effort?: string; input?: string[] }[]
}

export interface AdapterConfigFile {
  name: string
  type: ProviderType
  max_tokens?: number
  models: { source_model_id: string; provider: string; target_model_id: string; thinking?: ThinkingConfigFile; reasoning_effort?: string }[]
}

export interface ConfigFile {
  providers: ProviderConfigFile[]
  adapters?: AdapterConfigFile[]
  vision?: { provider: string; model: string; prompt?: string }
  proxy_key?: string
  log_level?: string
  locale?: string
  port?: number
  max_body_size?: number
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
