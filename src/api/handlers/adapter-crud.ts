import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerContext } from '../server.js'
import type { Config, AdapterConfig } from '../../config/types.js'
import { validateConfig } from '../../config/validator.js'
import { readBody } from '../../lib/http-utils.js'
import { json } from './index.js'
import { t } from '../../lib/i18n.js'

const ADAPTER_PATH_RE = /^\/admin\/adapters\/([a-zA-Z0-9_-]+)$/

export function handleGetAdapters(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): void {
  const { config } = ctx.store.getConfig()
  const host = req.headers.host ?? '127.0.0.1:9000'

  const adapters = (config.adapters ?? []).map((a) => {
    return {
      name: a.name,
      type: a.type,
      max_tokens: a.max_tokens,
      baseUrl: `http://${host}/${a.name}/v1`,
      models: a.models.map((m) => {
        const provider = config.providers.find((p) => p.name === m.provider)
        let status = 'ok' as string
        if (!provider) {
          status = 'provider_not_found'
        } else if (!provider.models.find((pm) => pm.id === m.targetModelId)) {
          status = 'model_not_found'
        }
        const base: Record<string, unknown> = { sourceModelId: m.sourceModelId, provider: m.provider, targetModelId: m.targetModelId, status }
        if (m.thinking) base.thinking = m.thinking
        return base
      }),
    }
  })

  json(res, 200, { success: true, data: { adapters } })
}

export async function handleCreateAdapter(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req))
  const { name, type, max_tokens, models } = body

  if (!name || !type || !models || !Array.isArray(models)) {
    json(res, 400, { success: false, error: '缺少必填字段: name, type, models（models 需为数组）' })
    return
  }

  if (!['anthropic', 'openai'].includes(type)) {
    json(res, 400, { success: false, error: 'type 必须为 anthropic 或 openai' })
    return
  }

  const { config } = ctx.store.getConfig()
  if ((config.adapters ?? []).find((a) => a.name === name)) {
    json(res, 400, { success: false, error: `适配器 "${name}" 已存在` })
    return
  }

  const newAdapter: AdapterConfig = { name, type, max_tokens, models }
  const errs = validateConfig({ providers: config.providers, adapters: [newAdapter] })
  if (errs.length > 0) {
    json(res, 400, { success: false, error: '校验失败', errors: errs })
    return
  }

  const newConfig: Config = structuredClone(config)
  if (!newConfig.adapters) newConfig.adapters = []
  newConfig.adapters.push(newAdapter)
  await ctx.store.writeConfig(newConfig)
  ctx.logger.log('system', '收到创建适配器请求', { name, type, modelCount: models.length })
  ctx.logger.log('system', '适配器已创建', { name, type })
  json(res, 200, { success: true, data: { name } })
}

export async function handleUpdateAdapter(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const match = req.url?.match(ADAPTER_PATH_RE)
  if (!match) { json(res, 404, { success: false, error: '无效路径' }); return }
  const adapterName = match[1]

  const body = JSON.parse(await readBody(req))
  const { name: newName, type, max_tokens, models } = body

  const { config } = ctx.store.getConfig()
  const idx = (config.adapters ?? []).findIndex((a) => a.name === adapterName)
  if (idx === -1) {
    json(res, 404, { success: false, error: `适配器 "${adapterName}" 不存在` })
    return
  }

  const finalName = newName && newName !== adapterName ? newName : adapterName
  if (finalName !== adapterName && (config.adapters ?? []).find((a) => a.name === finalName)) {
    json(res, 400, { success: false, error: `适配器 "${finalName}" 已存在` })
    return
  }

  const newConfig: Config = structuredClone(config)
  if (!newConfig.adapters) { json(res, 500, { success: false, error: '服务器状态异常' }); return }
  newConfig.adapters[idx] = {
    name: finalName,
    type: type ?? newConfig.adapters[idx].type,
    max_tokens: max_tokens,
    models: models ?? newConfig.adapters[idx].models,
  }
  await ctx.store.writeConfig(newConfig)
  ctx.logger.log('system', '收到更新适配器请求', { name: adapterName, newName: finalName, type: type ?? '', modelCount: models?.length })
  ctx.logger.log('system', '适配器已更新', { name: adapterName })
  json(res, 200, { success: true, data: { name: adapterName } })
}

export async function handleDeleteAdapter(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const match = req.url?.match(ADAPTER_PATH_RE)
  if (!match) { json(res, 404, { success: false, error: '无效路径' }); return }
  const adapterName = match[1]

  const { config } = ctx.store.getConfig()
  const idx = (config.adapters ?? []).findIndex((a) => a.name === adapterName)
  if (idx === -1) {
    json(res, 404, { success: false, error: `适配器 "${adapterName}" 不存在` })
    return
  }

  const newConfig: Config = structuredClone(config)
  if (!newConfig.adapters) { json(res, 500, { success: false, error: '服务器状态异常' }); return }
  newConfig.adapters.splice(idx, 1)
  await ctx.store.writeConfig(newConfig)
  ctx.logger.log('system', '收到删除适配器请求', { name: adapterName })
  ctx.logger.log('system', '适配器已删除', { name: adapterName })
  json(res, 200, { success: true, data: { name: adapterName } })
}
