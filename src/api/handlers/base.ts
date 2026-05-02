import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerContext } from '../server.js'
import { t } from '../../lib/i18n.js'
import { json } from './index.js'

export function handleGetConfig(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  const { config } = ctx.store.getConfig()
  json(res, 200, {
    success: true,
    data: {
      providers: config.providers.map((p) => ({
        name: p.name,
        type: p.type,
        api_key: p.apiKey,
        api_base: p.apiBase,
        models: p.models.map((m) => ({
          id: m.id,
          ...(m.thinking?.budget_tokens ? { thinking: { budget_tokens: m.thinking.budget_tokens } } : {}),
          ...(m.thinking?.reasoning_effort ? { reasoning_effort: m.thinking.reasoning_effort } : {}),
        })),
      })),
      max_body_size: config.maxBodySize,
      adapters: (config.adapters ?? []).map((a) => ({
        name: a.name,
        type: a.type,
        models: a.models,
      })),
    },
  })
}

export async function handleReload(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const result = await ctx.store.reload()
  if (result.success) {
    ctx.logger.log('system', t('backend.config.reloadSuccess'), { version: result.version })
    json(res, 200, { success: true, data: { version: result.version } })
  } else {
    ctx.logger.log('system', t('backend.config.reloadFailed'), { errors: result.errors })
    json(res, 400, { success: false, error: t('backend.config.validationFailed'), errors: result.errors })
  }
}

export function handleHealth(_ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, { success: true, data: { status: 'ok' } })
}

export function handleStatus(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  const { config } = ctx.store.getConfig()
  const providers = config.providers.map((p) => ({ name: p.name, type: p.type }))
  json(res, 200, { success: true, data: { providers: ctx.tracker.getAllStatuses(providers) } })
}

export function handleGetLogs(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const limit = parseInt(url.searchParams.get('limit') ?? '200', 10)
  const before = url.searchParams.get('before') ? parseInt(url.searchParams.get('before')!, 10) : undefined
  const level = url.searchParams.get('level') || undefined
  const type = url.searchParams.get('type') || undefined
  const date = url.searchParams.get('date') || undefined
  json(res, 200, { success: true, data: { logs: ctx.logger.getLogs(limit, before, level as any, type, date), stats: ctx.logger.getStats() } })
}

export function handleGetLogLevel(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, { success: true, data: { level: ctx.logger.getLevel() } })
}

export async function handleSetLogLevel(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await (await import('../../lib/http-utils.js')).readBody(req))
  const level = body.level
  if (!['debug', 'info', 'warn', 'error'].includes(level)) {
    json(res, 400, { success: false, error: t('backend.config.validationFailed') })
    return
  }
  const { config } = ctx.store.getConfig()
  const newConfig = { providers: config.providers, adapters: config.adapters, proxyKey: config.proxyKey, logLevel: level, maxBodySize: config.maxBodySize }
  await ctx.store.writeConfig(newConfig)
  ctx.logger.setLevel(level)
  ctx.logger.log('system', `Log level changed to ${level} (persisted)`, { level })
  json(res, 200, { success: true, data: { level } })
}

export function handleGetProxyKey(_ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  const { config } = _ctx.store.getConfig()
  json(res, 200, { success: true, data: { set: !!config.proxyKey, key: config.proxyKey ? '***' : null } })
}

export async function handleSetProxyKey(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await (await import('../../lib/http-utils.js')).readBody(req))
  const { config } = ctx.store.getConfig()
  const newConfig = { providers: config.providers, adapters: config.adapters, proxyKey: body.key || undefined, logLevel: config.logLevel, maxBodySize: config.maxBodySize }
  await ctx.store.writeConfig(newConfig)
  const verb = body.key ? 'set' : 'removed'
  ctx.logger.log('system', `Proxy API key ${verb}`)
  json(res, 200, { success: true, data: { set: !!body.key } })
}

export function handleGetTokenStats(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, { success: true, data: ctx.tokenTracker.getStats() })
}

export function handleDebugCaptures(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, { success: true, data: ctx.capture?.getAll() ?? [] })
}

export function handleDebugCapturesStream(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  if (!ctx.capture) {
    json(res, 404, { success: false, error: 'Capture not enabled' })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const all = ctx.capture.getAll()
  for (const entry of all) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`)
  }
  ctx.capture.subscribe(res)
}
