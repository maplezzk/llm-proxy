import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import type { ConfigStore } from '../config/store.js'
import type { StatusTracker } from '../status/tracker.js'
import type { TokenTracker } from '../status/token-tracker.js'
import type { CaptureBuffer } from '../proxy/capture.js'
import type { Logger } from '../log/logger.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { handleGetConfig, handleReload, handleHealth, handleStatus, handleGetLogs, handleGetLogLevel, handleSetLogLevel, handleGetAdapters, handleCreateProvider, handleUpdateProvider, handleDeleteProvider, handleCreateAdapter, handleUpdateAdapter, handleDeleteAdapter, handleTestModel, handleTestAdapter, handleListModels, handlePullModels, handleGetProxyKey, handleSetProxyKey, handleGetTokenStats, handleDebugCaptures, handleDebugCapturesStream } from './handlers/index.js'
import { handleAnthropicMessages, handleOpenAIChat, handleOpenAIResponses } from '../proxy/handlers.js'
import { handleAdapterRequest, handleAdapterModels } from '../adapter/handlers.js'

export interface ServerContext {
  store: ConfigStore
  tracker: StatusTracker
  tokenTracker: TokenTracker
  logger: Logger
  capture?: CaptureBuffer
}

export interface ServerOptions {
  adminHost: string
  adminPort: number
  proxyHost: string
  proxyPort: number
  store: ConfigStore
  tracker: StatusTracker
  tokenTracker: TokenTracker
  logger: Logger
  capture?: CaptureBuffer
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

let adminAppJs: string | null = null
function getAdminAppJs(): string {
  if (adminAppJs) return adminAppJs
  const __dirname = dirname(fileURLToPath(import.meta.url))
  // Also check CWD for bun compiled binary
  try { adminAppJs = readFileSync(join(process.cwd(), 'admin-app.js'), 'utf-8'); return adminAppJs } catch {}
  for (const dir of [__dirname, join(__dirname, '..', '..', 'dist', 'api')]) {
    try { adminAppJs = readFileSync(join(dir, 'admin-app.js'), 'utf-8'); return adminAppJs } catch {}
  }
  adminAppJs = 'console.warn("admin-app.js not found")'
  return adminAppJs
}

const handleAdminAppJs: RouteHandler = (_ctx, _req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
  res.end(getAdminAppJs())
}

const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/admin\/?$/, handler: handleAdminUI },
  { method: 'GET', pattern: /^\/admin-app\.js$/, handler: handleAdminAppJs },
  { method: 'GET', pattern: /^\/admin\/config$/, handler: handleGetConfig },
  { method: 'POST', pattern: /^\/admin\/config\/reload$/, handler: handleReload },
  { method: 'GET', pattern: /^\/admin\/health$/, handler: handleHealth },
  { method: 'GET', pattern: /^\/admin\/status\/providers$/, handler: handleStatus },
  { method: 'GET', pattern: /^\/admin\/logs(\?.*)?$/, handler: handleGetLogs },
  { method: 'GET', pattern: /^\/admin\/log-level$/, handler: handleGetLogLevel },
  { method: 'PUT', pattern: /^\/admin\/log-level$/, handler: handleSetLogLevel },
  { method: 'GET', pattern: /^\/admin\/proxy-key$/, handler: handleGetProxyKey },
  { method: 'PUT', pattern: /^\/admin\/proxy-key$/, handler: handleSetProxyKey },
  { method: 'GET', pattern: /^\/admin\/token-stats$/, handler: handleGetTokenStats },
  { method: 'GET', pattern: /^\/admin\/debug\/captures$/, handler: handleDebugCaptures },
  { method: 'GET', pattern: /^\/admin\/debug\/captures\/stream$/, handler: handleDebugCapturesStream },
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

export function createProxyServer(opts: ServerOptions): Server {
  const ctx: ServerContext = { store: opts.store, tracker: opts.tracker, tokenTracker: opts.tokenTracker, logger: opts.logger, capture: opts.capture }

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    corsHeaders(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    for (const route of ROUTES) {
      if (route.method === method && route.pattern.test(url)) {
        try {
          await route.handler(ctx, req, res)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          ctx.logger.log('request', `处理异常`, { url, method, error: message }, 'error')
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message } }))
          }
        }
        return
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Not found' } }))
  })

  return server
}
