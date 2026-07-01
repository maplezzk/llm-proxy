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
          ...(m.thinking ? { thinking: {
            ...(m.thinking.budget_tokens ? { budget_tokens: m.thinking.budget_tokens } : {}),
            ...(m.thinking.type ? { type: m.thinking.type } : {}),
          } } : {}),
          ...(m.thinking?.reasoning_effort ? { reasoning_effort: m.thinking.reasoning_effort } : {}),
          ...(m.input?.length ? { input: m.input } : {}),
        })),
      })),
      vision: config.vision ?? null,
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
  const newConfig = { providers: config.providers, adapters: config.adapters, proxyKey: config.proxyKey, logLevel: level }
  await ctx.store.writeConfig(newConfig)
  ctx.logger.setLevel(level)
  ctx.logger.log('system', `Log level changed to ${level} (persisted)`, { level })
  json(res, 200, { success: true, data: { level } })
}

export function handleGetLocale(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  const { config } = ctx.store.getConfig()
  json(res, 200, { success: true, data: { locale: config.locale || 'en' } })
}

export async function handleSetLocale(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await (await import('../../lib/http-utils.js')).readBody(req))
  const locale = body.locale
  if (locale !== 'zh' && locale !== 'en') {
    json(res, 400, { success: false, error: 'Invalid locale, must be "zh" or "en"' })
    return
  }
  const { config } = ctx.store.getConfig()
  const newConfig = {
    providers: config.providers,
    adapters: config.adapters,
    proxyKey: config.proxyKey,
    logLevel: config.logLevel,
    locale,
  }
  await ctx.store.writeConfig(newConfig)
  ctx.logger.log('system', `Locale changed to ${locale} (persisted)`, { locale })
  json(res, 200, { success: true, data: { locale } })
}

export function handleGetPort(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  const { config } = ctx.store.getConfig()
  json(res, 200, { success: true, data: { port: config.port } })
}

export async function handleSetPort(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await (await import('../../lib/http-utils.js')).readBody(req))
  const port = body.port
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    json(res, 400, { success: false, error: 'Port must be between 1 and 65535' })
    return
  }
  const { config } = ctx.store.getConfig()
  const newConfig: import('../../config/types.js').Config = {
    providers: config.providers,
    adapters: config.adapters,
    proxyKey: config.proxyKey,
    logLevel: config.logLevel,
    locale: config.locale,
    port: port || undefined,
    captureMaxSize: config.captureMaxSize,
  }
  await ctx.store.writeConfig(newConfig)
  ctx.logger.log('system', `Port changed to ${port ?? 'default (9000)'} (persisted, restart to take effect)`)
  json(res, 200, { success: true, data: { port: newConfig.port } })
}

export function handleGetProxyKey(_ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  const { config } = _ctx.store.getConfig()
  json(res, 200, { success: true, data: { set: !!config.proxyKey, key: config.proxyKey ? '***' : null } })
}

export async function handleSetProxyKey(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await (await import('../../lib/http-utils.js')).readBody(req))
  const { config } = ctx.store.getConfig()
  const newConfig = { providers: config.providers, adapters: config.adapters, proxyKey: body.key || undefined, logLevel: config.logLevel }
  await ctx.store.writeConfig(newConfig)
  const verb = body.key ? 'set' : 'removed'
  ctx.logger.log('system', `Proxy API key ${verb}`)
  json(res, 200, { success: true, data: { set: !!body.key } })
}

// Vision (外挂识图) 配置
export function handleGetVision(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  const { config } = ctx.store.getConfig()
  json(res, 200, { success: true, data: config.vision ?? null })
}

export async function handleSetVision(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await (await import('../../lib/http-utils.js')).readBody(req))
  const { config } = ctx.store.getConfig()
  // body.provider / body.model / body.prompt；传 provider 或 model 为空表示清除 vision 配置
  const provider = (body.provider ?? '').toString().trim()
  const model = (body.model ?? '').toString().trim()
  const prompt = (body.prompt ?? '').toString().trim() || undefined
  const newVision = (provider && model) ? { provider, model, prompt } : undefined

  const { validateConfig } = await import('../../config/validator.js')
  const trial = { ...config, vision: newVision }
  const errs = validateConfig(trial)
  if (errs.length > 0) {
    json(res, 400, { success: false, error: '校验失败', errors: errs })
    return
  }

  const newConfig = {
    providers: config.providers,
    adapters: config.adapters,
    proxyKey: config.proxyKey,
    vision: newVision,
    logLevel: config.logLevel,
    locale: config.locale,
    port: config.port,
    captureMaxSize: config.captureMaxSize,
  }
  await ctx.store.writeConfig(newConfig)
  ctx.logger.log('system', newVision ? `Vision fallback configured: ${newVision.provider}/${newVision.model}` : 'Vision fallback removed')
  json(res, 200, { success: true, data: newVision ?? null })
}

export function handleGetTokenStats(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, { success: true, data: ctx.usageStore.getStats() })
}

/**
 * 趋势折线图数据。
 * GET /admin/token-stats/timeline?days=30
 * GET /admin/token-stats/timeline?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * 自定义日期范围优先；缺失/无效时回退到 days（默认 30，封顶 365）。
 */
export function handleGetTokenTimeline(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const startDate = url.searchParams.get('startDate')
  const endDate = url.searchParams.get('endDate')
  if (startDate && endDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    if (startDate > endDate) {
      json(res, 400, { success: false, error: 'startDate 不能晚于 endDate' })
      return
    }
    json(res, 200, { success: true, data: ctx.usageStore.getTimeline({ startDate, endDate }) })
    return
  }
  const daysRaw = url.searchParams.get('days')
  let days = parseInt(daysRaw ?? '30', 10)
  if (!Number.isFinite(days) || days <= 0) days = 30
  if (days > 365) days = 365
  json(res, 200, { success: true, data: ctx.usageStore.getTimeline({ days }) })
}

/**
 * 按维度分桶：'provider' | 'adapter' | 'model'。
 * GET /admin/token-stats/breakdown?dimension=provider&range=today|7d|30d|all
 * GET /admin/token-stats/breakdown?dimension=provider&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * 自定义日期范围优先；否则按 range（默认 'today'）。
 */
export function handleGetTokenBreakdown(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const dimension = (url.searchParams.get('dimension') ?? 'provider') as 'provider' | 'adapter' | 'model'
  if (!['provider', 'adapter', 'model'].includes(dimension)) {
    json(res, 400, { success: false, error: 'dimension 必须是 provider/adapter/model' })
    return
  }
  const startDate = url.searchParams.get('startDate')
  const endDate = url.searchParams.get('endDate')
  if (startDate && endDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    if (startDate > endDate) {
      json(res, 400, { success: false, error: 'startDate 不能晚于 endDate' })
      return
    }
    json(res, 200, { success: true, data: ctx.usageStore.getBreakdown(dimension, { startDate, endDate }) })
    return
  }
  const range = (url.searchParams.get('range') ?? 'today') as 'today' | '7d' | '30d' | 'all'
  if (!['today', '7d', '30d', 'all'].includes(range)) {
    json(res, 400, { success: false, error: 'range 必须是 today/7d/30d/all' })
    return
  }
  json(res, 200, { success: true, data: ctx.usageStore.getBreakdown(dimension, { range }) })
}

/**
 * 数据库概况：条目数 + 文件大小。
 * GET /admin/token-stats/db-info
 */
export function handleGetTokenDbInfo(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, { success: true, data: ctx.usageStore.stats() })
}

/**
 * 清理 N 天前的历史数据。body: { days: 90 }。
 * POST /admin/token-stats/cleanup
 */
export async function handlePostTokenCleanup(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { days?: number } = {}
  try {
    body = JSON.parse(await (await import('../../lib/http-utils.js')).readBody(req))
  } catch { /* 允许空 body，默认 90 天 */ }
  const days = typeof body.days === 'number' && body.days > 0 ? body.days : 90
  const result = ctx.usageStore.cleanup(days)
  ctx.logger.log('system', `Usage store cleaned: ${days}d`, { days, ...result })
  json(res, 200, { success: true, data: { days, ...result } })
}

// Vision 缓存统计
export function handleGetVisionCacheStats(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  if (!ctx.visionCache) {
    json(res, 200, { success: true, data: { enabled: false, hits: 0, misses: 0, size: 0, maxEntries: 0, hitRate: 0 } })
    return
  }
  const stats = ctx.visionCache.getStats()
  json(res, 200, { success: true, data: { enabled: true, ...stats } })
}

// Vision 缓存清空
export async function handleClearVisionCache(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ctx.visionCache) {
    json(res, 404, { success: false, error: 'Vision cache not enabled' })
    return
  }
  await ctx.visionCache.clear()
  ctx.logger.log('system', 'Vision cache cleared')
  json(res, 200, { success: true, data: ctx.visionCache.getStats() })
}

export function handleDebugCapturesStatus(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, { success: true, data: { enabled: ctx.capture?.isEnabled() ?? false } })
}

export function handleDebugCaptures(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, { success: true, data: ctx.capture?.getAll() ?? [] })
}

export async function handleDebugCapturesControl(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ctx.capture) {
    json(res, 404, { success: false, error: 'Capture not enabled' })
    return
  }
  const body = JSON.parse(await (await import('../../lib/http-utils.js')).readBody(req))
  const { enabled, clear: shouldClear } = body

  if (enabled === true) {
    ctx.capture.enable()
    ctx.logger.log('system', 'Capture enabled')
  } else if (enabled === false) {
    ctx.capture.disable()
    ctx.logger.log('system', 'Capture disabled')
  }

  if (shouldClear) {
    ctx.capture.clear()
    ctx.logger.log('system', 'Capture buffer cleared')
  }

  json(res, 200, { success: true, data: { enabled: ctx.capture.isEnabled() } })
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
