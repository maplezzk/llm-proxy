import type { ConfigStore } from '../config/store.js'
import type { RouterResult } from './types.js'
import { getDefaultApiBase } from '../lib/http-utils.js'

export function routeModel(
  store: ConfigStore,
  modelName: string
): RouterResult {
  const { config } = store.getConfig()

  for (const provider of config.providers) {
    for (const model of provider.models) {
      if (model.id === modelName) {
        const apiBase = provider.apiBase ?? getDefaultApiBase(provider.type)

        return {
          providerName: provider.name,
          providerType: provider.type,
          apiKey: provider.apiKey,
          apiBase,
          modelId: model.id,
        }
      }
    }
  }

  throw new Error(`未找到模型 ID "${modelName}" 对应的 Provider`)
}
