import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { createProxyServer } from '../api/server.js'
import { ConfigStore } from '../config/store.js'
import { StatusTracker } from '../status/tracker.js'
import { UsageStore } from '../status/usage-store.js'
import { CaptureBuffer } from '../proxy/capture.js'
import { Logger, type LogLevel } from '../log/logger.js'
import { createI18n } from '../lib/i18n.js'
import type { Server } from 'node:http'
import type { Config } from '../config/types.js'
import { VisionCache } from '../proxy/vision-cache.js'

const DEFAULT_CONFIG_PATH = `${process.env.HOME ?? '/tmp'}/.llm-proxy/config.yaml`
const DEFAULT_PID_PATH = '/tmp/llm-proxy.pid'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9000

interface StartOptions {
  config?: string
  host?: string
  port?: number
  logLevel?: string
}

function getState(): { pid: number; port: number } | null {
  try {
    const raw = readFileSync(DEFAULT_PID_PATH, 'utf-8').trim()
    const parsed = JSON.parse(raw)
    if (typeof parsed.pid === 'number' && typeof parsed.port === 'number') {
      return { pid: parsed.pid, port: parsed.port }
    }
    // 兼容旧格式（纯 PID）
    const pid = parseInt(raw, 10)
    return isNaN(pid) ? null : { pid, port: DEFAULT_PORT }
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
 * 注册 SIGTERM/SIGINT 关闭 handler。
 * 关键约束：Node.js 注册 signal listener 后，默认自动退出行为被移除。
 * 每一步必须 try-catch，保证最后 process.exit(0) 一定执行，
 * 否则进程残留（菜单栏 stopSync 退出后，Node.js 进程会变成孤儿）。
 *
 * 抽成独立函数便于单测：验证即使中间步骤抛错，仍会调用 process.exit。
 */
export function installShutdownHandlers(opts: {
  server: Server
  visionCache: { flushSync(): void }
  t: (key: string) => string
  pidPath?: string
  signalTarget?: NodeJS.Signals[] | '*'
  /** 可选：需要 graceful close 的资源（如 SQLite store） */
  onShutdown?: () => void
}): void {
  const pidPath = opts.pidPath ?? DEFAULT_PID_PATH
  const shutdown = () => {
    try { console.error(opts.t('cli.start.sigterm')) } catch { /* ignore */ }
    try { unlinkSync(pidPath) } catch { /* ignore */ }
    try { opts.visionCache.flushSync() } catch { /* ignore */ }
    try { opts.onShutdown?.() } catch { /* ignore */ }
    try { opts.server.close() } catch { /* ignore */ }
    process.exit(0)
  }
  const target = opts.signalTarget ?? ['SIGTERM', 'SIGINT']
  if (target === '*' || target.includes('SIGTERM')) process.on('SIGTERM', shutdown)
  if (target === '*' || target.includes('SIGINT')) process.on('SIGINT', shutdown)
}

/** 启动阶段 Logger 尚未创建，写配置加载错误到 ~/.llm-proxy/startup-errors.log */
function writeConfigErrorLog(configPath: string, error: string): void {
  try {
    const logDir = `${process.env.HOME ?? '/tmp'}/.llm-proxy`
    mkdirSync(logDir, { recursive: true })
    const logFile = `${logDir}/startup-errors.log`
    const ts = new Date().toISOString()
    const line = `[${ts}] 配置加载失败 config=${configPath}\n${error}\n${'─'.repeat(60)}\n`
    appendFileSync(logFile, line, 'utf-8')
  } catch {
    // 写日志失败不阻塞启动流程
  }
}

export async function cmdStart(opts: StartOptions): Promise<void> {
  // Default to English; config file's locale field can override to 'zh'
  let { t } = createI18n('en')

  const configPath = opts.config ?? DEFAULT_CONFIG_PATH

  let store: ConfigStore
  if (!existsSync(configPath)) {
    const configDir = configPath.substring(0, configPath.lastIndexOf('/'))
    mkdirSync(configDir, { recursive: true })
    const defaultConfig: Config = { providers: [], logLevel: 'info' }
    store = new ConfigStore(configPath, defaultConfig)
    console.error('\n  🆕  First time? Open the admin UI to set up your first AI provider:')
    console.error(`      http://${DEFAULT_HOST}:${DEFAULT_PORT}/admin/\n`)
  } else {
    try {
      store = await ConfigStore.create(configPath)
      console.error(t('cli.start.configLoaded'))
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error(t('cli.start.configLoadFailed', { error: errorMessage }))
      // 启动阶段 Logger 尚未创建，手动写错误日志到 ~/.llm-proxy/
      writeConfigErrorLog(configPath, errorMessage)
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
  const logDir = `${process.env.HOME ?? '/tmp'}/.llm-proxy`
  const usageStore = new UsageStore(`${logDir}/usage.db`, undefined /* Logger 在下面创建后再注入 */)
  const capture = new CaptureBuffer(store.getConfig().config.captureMaxSize ?? 100)
  const persistedLevel = store.getConfig().config.logLevel
  const defaultLevel = (opts.logLevel && ['debug', 'info', 'warn', 'error'].includes(opts.logLevel))
    ? opts.logLevel as LogLevel
    : 'info'
  const level = persistedLevel ?? defaultLevel
  const logger = new Logger(1000, logDir, level)
  const host = opts.host ?? DEFAULT_HOST
  const configPort = store.getConfig().config.port
  const port = opts.port ?? configPort ?? DEFAULT_PORT

  // 外挂识图缓存：图片内容 hash → 描述
  const visionCache = new VisionCache({ filePath: `${logDir}/vision-cache.json` })
  visionCache.load()

  const server = createProxyServer({
    adminHost: host,
    adminPort: port,
    proxyHost: host,
    proxyPort: port,
    store,
    tracker,
    usageStore,
    capture,
    logger,
    visionCache,
  })

// Node.js 文档：注册 SIGTERM/SIGINT listener 后，默认自动退出行为被移除，
  // 进程能否退出完全取决于 handler 是否调用 process.exit。
  // 因此每一步都必须 try-catch 包住，保证最后 process.exit(0) 一定执行，
  // 否则进程残留（菜单栏 stopSync 退出后，Node.js 进程会变成孤儿）。
  installShutdownHandlers({ server, visionCache, t, onShutdown: () => usageStore.close() })

  logger.log('system', t('cli.start.started', { host, port, config: configPath }), { host, port, config: configPath })

  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ❌ 端口 ${port} 已被占用`)
      console.error(`  请用 --port 参数指定其他端口，或在配置文件中设置 port 字段\n`)
      process.exit(1)
    }
  })
  server.listen(port, host, () => {
    writeFileSync(DEFAULT_PID_PATH, JSON.stringify({ pid: process.pid, port }))
    console.error(t('cli.start.started', { host, port }))
    console.error(t('cli.start.adminApi', { host, port }))
    console.error(t('cli.start.aiApi', { host, port }))
    console.error(t('cli.start.pid', { pid: String(process.pid) }))
    console.error(t('cli.start.configFile', { configPath }))
  })
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
  console.error(`  ${t('cli.status.port', { port: String(state.port) })}`)
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
