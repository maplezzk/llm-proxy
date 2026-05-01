export interface RouterResult {
  providerName: string
  providerType: 'anthropic' | 'openai' | 'openai-responses'
  apiKey: string
  apiBase: string
  modelId: string
}
