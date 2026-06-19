import type { ThinkingConfig } from '../config/types.js'

export interface RouterResult {
  providerName: string
  providerType: 'anthropic' | 'openai' | 'openai-responses'
  apiKey: string
  apiBase: string
  modelId: string
  thinking?: ThinkingConfig
  /** 模型支持的输入模态，未配置时为 undefined（视为仅支持文本） */
  input?: string[]
  /** 默认 max_tokens，客户端没传或传 0 时使用 */
  max_tokens?: number
}
