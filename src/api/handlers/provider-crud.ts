import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerContext } from '../server.js'
import type { Config, Provider } from '../../config/types.js'
import { validateConfig } from '../../config/validator.js'
import { readBody } from '../../lib/http-utils.js'
import { json } from './index.js'
import { t } from '../../lib/i18n.js'

function configFromProvider(provider: Provider): Config {
  return { providers: [provider], adapters: [] }
}

const PROVIDER_PATH_RE = /^\/admin\/providers\/([a-zA-Z0-9_-]+)$/

export async function handleCreateProvider(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req))
  const { name, type, api_key, api_base, models } = body

  if (!name || !type || !api_key || !models) {
    json(res, 400, { success: false, error: '缺少必填字段: name, type, api_key, models' })
    return
  }

  const newProvider: Provider = { name, type, apiKey: api_key, apiBase: api_base, models }

  const errs = validateConfig(configFromProvider(newProvider))
  if (errs.length > 0) {
    json(res, 400, { success: false, error: '校验失败', errors: errs })
    return
  }

  const { config } = ctx.store.getConfig()
  if (config.providers.find((p) => p.name === name)) {
    json(res, 400, { success: false, error: `模型供应商 "${name}" 已存在` })
    return
  }

  const newConfig: Config = structuredClone(config)
  newConfig.providers.push(newProvider)
  await ctx.store.writeConfig(newConfig)
  ctx.logger.log('system', 'Create provider request received', { name, type, apiBase: api_base })
  ctx.logger.log('system', 'Provider created', { name, type })
  json(res, 200, { success: true, data: { name } })
}

export async function handleUpdateProvider(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const match = req.url?.match(PROVIDER_PATH_RE)
  if (!match) { json(res, 404, { success: false, error: '无效路径' }); return }
  const providerName = match[1]

  const body = JSON.parse(await readBody(req))
  const { name: newName, type, api_key, api_base, models } = body

  const { config } = ctx.store.getConfig()
  const idx = config.providers.findIndex((p) => p.name === providerName)
  if (idx === -1) {
    json(res, 404, { success: false, error: `模型供应商 "${providerName}" 不存在` })
    return
  }

  const finalName = newName && newName !== providerName ? newName : providerName
  if (finalName !== providerName && config.providers.find((p) => p.name === finalName)) {
    json(res, 400, { success: false, error: `模型供应商 "${finalName}" 已存在` })
    return
  }

  const updated: Provider = {
    name: finalName,
    type: type ?? config.providers[idx].type,
    apiKey: api_key || config.providers[idx].apiKey,
    apiBase: api_base || config.providers[idx].apiBase,
    models: models ?? config.providers[idx].models,
  }

  const errs = validateConfig(configFromProvider(updated))
  if (errs.length > 0) {
    json(res, 400, { success: false, error: '校验失败', errors: errs })
    return
  }

  const newConfig: Config = structuredClone(config)
  newConfig.providers[idx] = updated

  // 若重命名，更新所有 adapter 中引用旧名称的 provider 字段
  if (finalName !== providerName && newConfig.adapters) {
    for (const a of newConfig.adapters) {
      for (const m of a.models) {
        if (m.provider === providerName) m.provider = finalName
      }
    }
  }

  await ctx.store.writeConfig(newConfig)
  ctx.logger.log('system', 'Update provider request received', { name: providerName, newName: finalName, type: type ?? '', apiBase: api_base })
  ctx.logger.log('system', 'Provider updated', { name: finalName, previously: providerName !== finalName ? providerName : undefined })
  json(res, 200, { success: true, data: { name: finalName } })
}

export async function handleDeleteProvider(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const match = req.url?.match(PROVIDER_PATH_RE)
  if (!match) { json(res, 404, { success: false, error: '无效路径' }); return }
  const providerName = match[1]

  const { config } = ctx.store.getConfig()
  const idx = config.providers.findIndex((p) => p.name === providerName)
  if (idx === -1) {
    json(res, 404, { success: false, error: `模型供应商 "${providerName}" 不存在` })
    return
  }

  const refAdapter = (config.adapters ?? []).find((a) => a.models.some((m) => m.provider === providerName))
  if (refAdapter) {
    json(res, 400, { success: false, error: `模型供应商 "${providerName}" 被适配器 "${refAdapter.name}" 引用，无法删除` })
    return
  }

  const newConfig: Config = structuredClone(config)
  newConfig.providers.splice(idx, 1)
  await ctx.store.writeConfig(newConfig)
  ctx.logger.log('system', 'Delete provider request received', { name: providerName })
  ctx.logger.log('system', 'Provider deleted', { name: providerName })
  json(res, 200, { success: true, data: { name: providerName } })
}
