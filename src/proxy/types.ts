import type { ThinkingConfig } from '../config/types.js'

export interface RouterResult {
  providerName: string
  providerType: 'anthropic' | 'openai' | 'openai-responses'
  apiKey: string
  apiBase: string
  modelId: string
  thinking?: ThinkingConfig
  /** 默认 max_tokens，客户端没传或传 0 时使用 */
  max_tokens?: number
}
