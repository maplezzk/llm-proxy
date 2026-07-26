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
  /** 下游未传 stream 时的默认值。null=不注入（跟随/透传），true/false=注入对应值，undefined=内置默认(true) */
  stream?: boolean | null
}
