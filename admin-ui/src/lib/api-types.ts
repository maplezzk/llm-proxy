/** 后端 /api/admin/* JSON 的统一响应结构。 */
export interface ApiRes<T> {
  success?: boolean
  data?: T
  error?: unknown
  errors?: Array<{ field?: string; message?: string }>
}

export type ProviderType = 'openai' | 'anthropic' | 'openai-responses'
