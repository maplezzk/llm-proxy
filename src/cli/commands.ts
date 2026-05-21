import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { createProxyServer } from '../api/server.js'
import { ConfigStore } from '../config/store.js'
import { StatusTracker } from '../status/tracker.js'
import { TokenTracker } from '../status/token-tracker.js'
import { CaptureBuffer } from '../proxy/capture.js'
import { Logger, type LogLevel } from '../log/logger.js'
import { createI18n } from '../lib/i18n.js'
import type { Server } from 'node:http'
import type { Config } from '../config/types.js'

const DEFAULT_CONFIG_PATH = `${process.env.HOME ?? '/tmp'}/.llm-proxy/config.yaml`
const DEFAULT_PID_PATH = '/tmp/llm-proxy.pid'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9000
const MAX_PORT_RETRIES = 10

interface StartOptions {
  config?: string
  host?: string
  port?: number
  logLevel?: string
}

interface ProxyState {
  pid: number
  port: number
}

function getState(): ProxyState | null {
  try {
    const raw = readFileSync(DEFAULT_PID_PATH, 'utf-8').trim()
    // Try JSON format first (pid,port), fallback to plain PID for backwards compat
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed.pid === 'number' && typeof parsed.port === 'number') {
        return { pid: parsed.pid, port: parsed.port }
      }
    } catch { /* not JSON, try legacy format */ }
    const pid = parseInt(raw, 10)
    if (isNaN(pid)) return null
    // Legacy: port unknown, use default
    return { pid, port: DEFAULT_PORT }
  } catch {
    return null
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

/**
 * Determine the target port: CLI --port > config port > DEFAULT_PORT
 */
function resolvePort(cliPort: number | undefined, configPort: number | undefined): number {
  if (cliPort !== undefined) return cliPort
  if (configPort !== undefined) return configPort
  return DEFAULT_PORT
}

/**
 * Try to listen on a port, auto-incrementing if busy.
 * Returns the actual port that was bound.
 */
function listenWithRetry(
  server: Server,
  host: string,
  startPort: number,
  logger: Logger,
  t: (key: string, opts?: Record<string, unknown>) => string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    function tryPort(port: number, attempt: number) {
      server.listen(port, host, () => {
        resolve(port)
      })
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_RETRIES) {
          const nextPort = port + 1
          console.error(t('cli.start.portConflict', { port: String(port), nextPort: String(nextPort) }))
          logger.log('system', `Port ${port} in use, trying ${nextPort}`, { port, nextPort })
          tryPort(nextPort, attempt + 1)
        } else if (err.code === 'EADDRINUSE') {
          reject(new Error(t('cli.start.portExhausted', { startPort: String(startPort), endPort: String(startPort + MAX_PORT_RETRIES - 1) })))
        } else {
          reject(err)
        }
      })
    }
    tryPort(startPort, 0)
  })
}

export async function cmdStart(opts: StartOptions): Promise<void> {
  // Default to English; config file's locale field can override to 'zh'
  let { t } = createI18n('en')

  const configPath = opts.config ?? DEFAULT_CONFIG_PATH

  let store: ConfigStore
  // Determine config port before loading store for default display
  let configPort: number | undefined
  if (!existsSync(configPath)) {
    const configDir = configPath.substring(0, configPath.lastIndexOf('/'))
    mkdirSync(configDir, { recursive: true })
    const defaultConfig: Config = { providers: [], logLevel: 'info' }
    store = new ConfigStore(configPath, defaultConfig)
    configPort = undefined
    const intendedPort = resolvePort(opts.port, configPort)
    console.error('\n  🆕  First time? Open the admin UI to set up your first AI provider:')
    console.error(`      http://${DEFAULT_HOST}:${intendedPort}/admin/\n`)
  } else {
    try {
      store = await ConfigStore.create(configPath)
      configPort = store.getConfig().config.port
      console.error(t('cli.start.configLoaded'))
    } catch (err) {
      console.error(t('cli.start.configLoadFailed', { error: err instanceof Error ? err.message : String(err) }))
      process.exit(1)
    }
  }

  // Re-init i18n if config specifies a locale
  const configLocale = store.getConfig().config.locale
  if (configLocale && ['zh', 'en'].includes(configLocale)) {
    const result = createI18n(configLocale)
    t = result.t
  }

  const tracker = new StatusTracker()
  const tokenTracker = new TokenTracker()
  const capture = new CaptureBuffer(store.getConfig().config.captureMaxSize ?? 100)
  const logDir = `${process.env.HOME ?? '/tmp'}/.llm-proxy`
  const persistedLevel = store.getConfig().config.logLevel
  const defaultLevel = (opts.logLevel && ['debug', 'info', 'warn', 'error'].includes(opts.logLevel))
    ? opts.logLevel as LogLevel
    : 'info'
  const level = persistedLevel ?? defaultLevel
  const logger = new Logger(1000, logDir, level)
  const host = opts.host ?? DEFAULT_HOST

  // Priority: CLI --port > config port > default 9000
  const intendedPort = resolvePort(opts.port, configPort)

  const server = createProxyServer({
    adminHost: host,
    adminPort: intendedPort,
    proxyHost: host,
    proxyPort: intendedPort,
    store,
    tracker,
    tokenTracker,
    capture,
    logger,
  })

  process.on('SIGTERM', () => {
    console.error(t('cli.start.sigterm'))
    try { unlinkSync(DEFAULT_PID_PATH) } catch { /* ignore */ }
    server.close()
    process.exit(0)
  })

  // Try to listen with auto-increment on port conflict
  try {
    const actualPort = await listenWithRetry(server, host, intendedPort, logger, t)
    const portSuffix = actualPort !== intendedPort ? t('cli.start.portFallbackSuffix', { port: String(actualPort) }) : ''
    writeFileSync(DEFAULT_PID_PATH, JSON.stringify({ pid: process.pid, port: actualPort }))
    logger.log('system', t('cli.start.started', { host, port: actualPort, config: configPath }), { host, port: actualPort, config: configPath })
    console.error(t('cli.start.started', { host, port: actualPort }))
    console.error(t('cli.start.adminApi', { host, port: actualPort }))
    console.error(t('cli.start.aiApi', { host, port: actualPort }))
    console.error(t('cli.start.pid', { pid: String(process.pid) }))
    console.error(t('cli.start.configFile', { configPath }))
    if (portSuffix) console.error(portSuffix)
  } catch (err) {
    console.error(t('cli.start.portConflictError', { error: err instanceof Error ? err.message : String(err) }))
    process.exit(1)
  }
}

export async function cmdStop(): Promise<void> {
  const { t } = createI18n('en')

  const state = getState()
  if (state === null) {
    console.error(t('cli.stop.notRunning'))
    return
  }

  if (!isProcessRunning(state.pid)) {
    console.error(t('cli.stop.stalePid'))
    try { unlinkSync(DEFAULT_PID_PATH) } catch { /* ignore */ }
    return
  }

  console.error(t('cli.stop.stopping', { pid: String(state.pid) }))
  process.kill(state.pid, 'SIGTERM')
}

export async function cmdStatus(): Promise<void> {
  const { t } = createI18n('en')

  const state = getState()
  if (state === null || !isProcessRunning(state.pid)) {
    if (state !== null) {
      try { unlinkSync(DEFAULT_PID_PATH) } catch { /* ignore */ }
    }
    console.error(t('cli.status.notRunning'))
    return
  }
  console.error(t('cli.status.running', { pid: String(state.pid) }))
  console.error(t('cli.status.port', { port: String(state.port) }))
}

export async function cmdRestart(opts: StartOptions): Promise<void> {
  const { t } = createI18n('en')

  const state = getState()
  if (state !== null && isProcessRunning(state.pid)) {
    console.error(t('cli.restart.stopping', { pid: String(state.pid) }))
    process.kill(state.pid, 'SIGTERM')
    // Wait for process to exit
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!isProcessRunning(state.pid)) {
          clearInterval(check)
          resolve()
        }
      }, 200)
      setTimeout(() => { clearInterval(check); resolve() }, 5000)
    })
    console.error(t('cli.restart.restarting'))
  } else if (state !== null) {
    console.error(t('cli.restart.stalePid'))
    try { unlinkSync(DEFAULT_PID_PATH) } catch { /* ignore */ }
  }
  await cmdStart(opts)
}

export async function cmdReload(opts: { port?: number }): Promise<void> {
  const { t } = createI18n('en')

  // Try PID file first for actual port, fallback to CLI arg, then default
  const state = getState()
  const port = opts.port ?? state?.port ?? DEFAULT_PORT
  const url = `http://${DEFAULT_HOST}:${port}/admin/config/reload`

  try {
    const response = await fetch(url, { method: 'POST' })
    const data = await response.json()
    if (data.success) {
      console.log(t('cli.reload.success', { version: data.data.version }))
    } else {
      console.error(t('cli.reload.failed', { error: data.error }))
      if (data.errors) {
        for (const e of data.errors) {
          console.error(t('cli.reload.errorItem', { message: e.message }))
        }
      }
      process.exit(1)
    }
  } catch (err) {
    console.error(t('cli.reload.connectionFailed', { error: err instanceof Error ? err.message : String(err) }))
    process.exit(1)
  }
}
