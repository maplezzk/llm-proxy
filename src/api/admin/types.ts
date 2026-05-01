export interface ApiResponse<T = any> {
  success: boolean
  data?: T
  error?: string
}

export type ProviderType = 'openai' | 'anthropic' | 'openai-responses'

export interface ProviderModel {
  id: string
}

export interface ProviderConfig {
  name: string
  type: ProviderType
  api_key?: string
  api_base?: string
  models: ProviderModel[]
}

export interface ProviderStatus extends ProviderConfig {
  available: boolean
}

export interface AdapterMapping {
  sourceModelId: string
  provider: string
  targetModelId: string
  status?: 'ok' | 'error'
}

export interface AdapterConfig {
  name: string
  type: ProviderType
  models: AdapterMapping[]
}

export interface AppConfig {
  providers: ProviderConfig[]
  adapters: AdapterConfig[]
}

export interface LogEntry {
  timestamp: string
  type: 'request' | 'system'
  message: string
  details?: any
}
