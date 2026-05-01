import type { ThinkingConfig } from '../config/types.js'

export interface RouterResult {
  providerName: string
  providerType: 'anthropic' | 'openai' | 'openai-responses'
  apiKey: string
  apiBase: string
  modelId: string
  thinking?: ThinkingConfig
}
