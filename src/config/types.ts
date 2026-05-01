export type ProviderType = 'anthropic' | 'openai' | 'openai-responses'

export interface Model {
  id: string
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
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ProviderConfigFile {
  name: string
  type: ProviderType
  api_key: string
  api_base?: string
  models: { id: string }[]
}

export interface AdapterConfigFile {
  name: string
  type: ProviderType
  models: { source_model_id: string; provider: string; target_model_id: string }[]
}

export interface ConfigFile {
  providers: ProviderConfigFile[]
  adapters?: AdapterConfigFile[]
  proxy_key?: string
  log_level?: string
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
