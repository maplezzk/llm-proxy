export type ProviderType = 'anthropic' | 'openai' | 'openai-responses'

export interface ThinkingConfig {
  /** Anthropic: thinking budget tokens (启用 thinking 模式时必填) */
  budget_tokens?: number
  /** OpenAI: reasoning_effort (low | medium | high) */
  reasoning_effort?: 'low' | 'medium' | 'high'
}

export interface Model {
  id: string
  thinking?: ThinkingConfig
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
  models: AdapterModelMapping[]
}

export interface Config {
  providers: Provider[]
  adapters?: AdapterConfig[]
  proxyKey?: string
  logLevel?: LogLevel
  locale?: string
  /** 请求体大小限制（字节），不设则默认 10MB */
  maxBodySize?: number
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ThinkingConfigFile {
  budget_tokens?: number
  reasoning_effort?: string
}

export interface ProviderConfigFile {
  name: string
  type: ProviderType
  api_key: string
  api_base?: string
  models: { id: string; thinking?: ThinkingConfigFile; reasoning_effort?: string }[]
}

export interface AdapterConfigFile {
  name: string
  type: ProviderType
  models: { source_model_id: string; provider: string; target_model_id: string; thinking?: ThinkingConfigFile; reasoning_effort?: string }[]
}

export interface ConfigFile {
  providers: ProviderConfigFile[]
  adapters?: AdapterConfigFile[]
  proxy_key?: string
  log_level?: string
  locale?: string
  max_body_size?: number
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
