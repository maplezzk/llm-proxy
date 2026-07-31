import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import type { ConfigStore } from '../config/store.js'
import type { StatusTracker } from '../status/tracker.js'
import type { UsageStore } from '../status/usage-store.js'
import type { CaptureBuffer } from '../proxy/capture.js'
import type { VisionCache } from '../proxy/vision-cache.js'
import type { Logger } from '../log/logger.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { handleGetConfig, handleReload, handleHealth, handleStatus, handleGetLogs, handleGetLogLevel, handleSetLogLevel, handleGetLocale, handleSetLocale, handleGetPort, handleSetPort, handleGetAdapters, handleCreateProvider, handleUpdateProvider, handleDeleteProvider, handleCreateAdapter, handleUpdateAdapter, handleDeleteAdapter, handleTestModel, handleTestAdapter, handleListModels, handlePullModels, handleGetProxyKey, handleSetProxyKey, handleGetTokenStats, handleGetTokenTimeline, handleGetTokenBreakdown, handleGetTokenDbInfo, handlePostTokenCleanup, handleDebugCapturesStatus, handleDebugCaptures, handleDebugCapturesControl, handleDebugCapturesStream, handleGetVision, handleSetVision, handleGetVisionCacheStats, handleClearVisionCache } from './handlers/index.js'
import { handleAnthropicMessages, handleOpenAIChat, handleOpenAIResponses } from '../proxy/handlers.js'
import { handleAdapterRequest, handleAdapterModels } from '../adapter/handlers.js'

export interface ServerContext {
  store: ConfigStore
  tracker: StatusTracker
  usageStore: UsageStore
  logger: Logger
  capture?: CaptureBuffer
  visionCache?: VisionCache
  /** 配置端口变化后的服务内重绑定。 */
  rebindPort?: (port: number) => Promise<void>
  /** 配置语言变化后的后端运行时同步。 */
  changeLocale?: (locale: string) => void
}

export interface ServerOptions {
  adminHost: string
  adminPort: number
  proxyHost: string
  proxyPort: number
  store: ConfigStore
  tracker: StatusTracker
  usageStore: UsageStore
  logger: Logger
  capture?: CaptureBuffer
  visionCache?: VisionCache
  onPortChanged?: (port: number) => void
  changeLocale?: (locale: string) => void
}

type RouteHandler = (
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse
) => void | Promise<void>

interface Route {
  method: string
  pattern: RegExp
  handler: RouteHandler
}

let adminUIHtml: string | null = null
function getAdminUIHtml(): string {
  if (adminUIHtml) return adminUIHtml
  const __dirname = dirname(fileURLToPath(import.meta.url))
  // Also check CWD (bun compiled binary might be launched with cwd set to assets dir)
  const cwdPath = join(process.cwd(), 'admin-ui.html')
  try { adminUIHtml = readFileSync(cwdPath, 'utf-8'); return adminUIHtml } catch {}
  const htmlPath = join(__dirname, 'admin-ui.html')
  try { adminUIHtml = readFileSync(htmlPath, 'utf-8') } catch { adminUIHtml = '<h1>Admin UI not found</h1>' }
  return adminUIHtml
}

const handleAdminUI: RouteHandler = (_ctx, _req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(getAdminUIHtml())
}

const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/admin\/?(\?.*)?$/, handler: handleAdminUI },
  { method: 'GET', pattern: /^\/admin\/config$/, handler: handleGetConfig },
  { method: 'POST', pattern: /^\/admin\/config\/reload$/, handler: handleReload },
  { method: 'GET', pattern: /^\/admin\/health$/, handler: handleHealth },
  { method: 'GET', pattern: /^\/admin\/status\/providers$/, handler: handleStatus },
  { method: 'GET', pattern: /^\/admin\/logs(\?.*)?$/, handler: handleGetLogs },
  { method: 'GET', pattern: /^\/admin\/log-level$/, handler: handleGetLogLevel },
  { method: 'PUT', pattern: /^\/admin\/log-level$/, handler: handleSetLogLevel },
  { method: 'GET', pattern: /^\/admin\/locale$/, handler: handleGetLocale },
  { method: 'PUT', pattern: /^\/admin\/locale$/, handler: handleSetLocale },
  { method: 'GET', pattern: /^\/admin\/port$/, handler: handleGetPort },
  { method: 'PUT', pattern: /^\/admin\/port$/, handler: handleSetPort },
  { method: 'GET', pattern: /^\/admin\/vision$/, handler: handleGetVision },
  { method: 'PUT', pattern: /^\/admin\/vision$/, handler: handleSetVision },
  { method: 'GET', pattern: /^\/admin\/vision-cache\/stats$/, handler: handleGetVisionCacheStats },
  { method: 'POST', pattern: /^\/admin\/vision-cache\/clear$/, handler: handleClearVisionCache },
  { method: 'GET', pattern: /^\/admin\/proxy-key$/, handler: handleGetProxyKey },
  { method: 'PUT', pattern: /^\/admin\/proxy-key$/, handler: handleSetProxyKey },
  { method: 'GET', pattern: /^\/admin\/token-stats$/, handler: handleGetTokenStats },
  { method: 'GET', pattern: /^\/admin\/token-stats\/timeline(\?.*)?$/, handler: handleGetTokenTimeline },
  { method: 'GET', pattern: /^\/admin\/token-stats\/breakdown(\?.*)?$/, handler: handleGetTokenBreakdown },
  { method: 'GET', pattern: /^\/admin\/token-stats\/db-info$/, handler: handleGetTokenDbInfo },
  { method: 'POST', pattern: /^\/admin\/token-stats\/cleanup$/, handler: handlePostTokenCleanup },
  { method: 'GET', pattern: /^\/admin\/debug\/captures$/, handler: handleDebugCaptures },
  { method: 'GET', pattern: /^\/admin\/debug\/captures\/status$/, handler: handleDebugCapturesStatus },
  { method: 'GET', pattern: /^\/admin\/debug\/captures\/stream$/, handler: handleDebugCapturesStream },
  { method: 'POST', pattern: /^\/admin\/debug\/captures\/control$/, handler: handleDebugCapturesControl },
  { method: 'GET', pattern: /^\/admin\/adapters(\?.*)?$/, handler: handleGetAdapters },
  { method: 'POST', pattern: /^\/admin\/providers$/, handler: handleCreateProvider },
  { method: 'PUT', pattern: /^\/admin\/providers\/([a-zA-Z0-9_-]+)$/, handler: handleUpdateProvider },
  { method: 'DELETE', pattern: /^\/admin\/providers\/([a-zA-Z0-9_-]+)$/, handler: handleDeleteProvider },
  { method: 'POST', pattern: /^\/admin\/adapters$/, handler: handleCreateAdapter },
  { method: 'PUT', pattern: /^\/admin\/adapters\/([a-zA-Z0-9_-]+)$/, handler: handleUpdateAdapter },
  { method: 'DELETE', pattern: /^\/admin\/adapters\/([a-zA-Z0-9_-]+)$/, handler: handleDeleteAdapter },
  { method: 'POST', pattern: /^\/admin\/test-model$/, handler: handleTestModel },
  { method: 'POST', pattern: /^\/admin\/test-adapter$/, handler: handleTestAdapter },
  { method: 'GET', pattern: /^\/v1\/models(\?.*)?$/, handler: handleListModels },
  { method: 'POST', pattern: /^\/admin\/providers\/([a-zA-Z0-9_-]+)\/pull-models$/, handler: handlePullModels },
  { method: 'GET', pattern: /^\/([a-zA-Z0-9_-]+)\/v1\/models(\?.*)?$/, handler: handleAdapterModels },
  { method: 'POST', pattern: /^\/v1\/messages$/, handler: handleAnthropicMessages },
  { method: 'POST', pattern: /^\/v1\/chat\/completions$/, handler: handleOpenAIChat },
  { method: 'POST', pattern: /^\/v1\/responses$/, handler: handleOpenAIResponses },
  { method: 'POST', pattern: /^\/([a-zA-Z0-9_-]+)\/v1\/(messages|chat\/completions|responses)(\?.*)?$/, handler: handleAdapterRequest },
]

function corsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version')
}

function isAdminRequest(url: string): boolean {
  return url === '/admin' || url.startsWith('/admin?') || url.startsWith('/admin/')
}

function isAdminUIShellRequest(url: string, method: string): boolean {
  return method === 'GET' && /^\/admin\/?(\?.*)?$/.test(url)
}

function hasValidAdminKey(req: IncomingMessage, expectedKey: string): boolean {
  const auth = req.headers.authorization ?? req.headers['x-api-key'] ?? ''
  const providedKey = String(auth).replace(/^Bearer\s+/i, '').trim()
  const provided = Buffer.from(providedKey)
  const expected = Buffer.from(expectedKey)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

export function createProxyServer(opts: ServerOptions): Server {
  let server: Server
  let currentPort = opts.proxyPort
  let rebindQueue: Promise<void> = Promise.resolve()

  const listen = (port: number): Promise<void> => new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, opts.proxyHost)
  })

  const close = (): Promise<void> => new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close((err) => err ? reject(err) : resolve())
    server.closeIdleConnections?.()
  })

  const rebindPort = (port: number): Promise<void> => {
    const task = rebindQueue.then(async () => {
      if (currentPort === port && server.listening) return
      const previousPort = currentPort
      await close()
      try {
        await listen(port)
        currentPort = port
        opts.onPortChanged?.(port)
      } catch (error) {
        // 新端口不可用时尽力恢复旧端口，避免服务因配置错误完全离线。
        try {
          await listen(previousPort)
          currentPort = previousPort
        } catch {
          // 保留原始错误，交由调用方记录。
        }
        throw error
      }
    })
    rebindQueue = task.catch(() => {})
    return task
  }

  const ctx: ServerContext = {
    store: opts.store,
    tracker: opts.tracker,
    usageStore: opts.usageStore,
    logger: opts.logger,
    capture: opts.capture,
    visionCache: opts.visionCache,
    rebindPort,
    changeLocale: opts.changeLocale,
  }

  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    corsHeaders(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // 归一化入站路径：将 /v1/v1/ 折叠为 /v1/（兼容某些 client 在 base_url 后追加 /v1 导致的双重路径）
    if (req.url) {
      const qi = req.url.indexOf('?')
      const path = qi >= 0 ? req.url.substring(0, qi) : req.url
      const qs = qi >= 0 ? req.url.substring(qi) : ''
      req.url = path.replace(/\/v1\/v1(\/|$)/g, '/v1$1') + qs
    }
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    const { config } = ctx.store.getConfig()
    // Web UI 外壳不包含管理数据，保持公开才能让首次访问者输入管理密钥；其余管理 API 均鉴权。
    const requiresAdminAuth = isAdminRequest(url) && !isAdminUIShellRequest(url, method)
    if (requiresAdminAuth && config.adminKey && !hasValidAdminKey(req, config.adminKey)) {
      ctx.logger.log('request', 'Admin API auth failed', { url, method }, 'warn')
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '管理 API Key 无效' } }))
      return
    }

    // 跳过高频健康检查和 SSE 长连接，避免日志刷屏
    const skipLog = url === '/admin/health' || url.startsWith('/admin/capture/stream') || url === '/v1/models'

    // Dashboard 相关端点默认记 info，其他端点 debug（避免 log 刷屏）
    const isDashboard = url.startsWith('/admin/') && !skipLog
    const baseLevel: 'info' | 'debug' = isDashboard ? 'info' : 'debug'

    const startedAt = process.hrtime.bigint()

    for (const route of ROUTES) {
      if (route.method === method && route.pattern.test(url)) {
        try {
          await route.handler(ctx, req, res)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          ctx.logger.log('request', `Request error`, { url, method, error: message }, 'error')
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message } }))
          }
        }
        if (!skipLog) {
          const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
          const status = res.statusCode || 200
          const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : baseLevel
          ctx.logger.log('request', `${method} ${url}`, { method, url, status, durationMs: Math.round(elapsedMs * 100) / 100 }, level)
        }
        return
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Not found' } }))
    if (!skipLog) {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      ctx.logger.log('request', `${method} ${url}`, { method, url, status: 404, durationMs: Math.round(elapsedMs * 100) / 100 }, 'warn')
    }
  })

  // 超时配置：防止空闲 socket/请求无限期占用堆、防止句柄累积泄漏。
  // - keepAliveTimeout: keep-alive 连接上两个请求之间的最大间隔（默认 5000ms）
  // - headersTimeout: 从 TCP 建连到接收完请求头的最大时长（默认 60000ms）
  // - requestTimeout: 接收完整请求（头 + body）的最大时长（默认 300000ms）
  // - timeout: socket 空闲超时，0 = 不超时（LLM 代理需支持长流式响应，不能在此处设上限）
  // 取值参考 Node.js 默认值并显式声明，贴合 LLM 代理场景。
  server.keepAliveTimeout = 30_000   // 30s
  server.headersTimeout = 60_000     // 60s
  server.requestTimeout = 300_000    // 5min
  server.timeout = 0                 // 不限时（流式响应可能持续数分钟）

  return server
}
