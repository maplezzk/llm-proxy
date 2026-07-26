import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
const DEFAULT_DATA_DIR = `${process.env.HOME ?? '/tmp'}/.llm-proxy`
/**
 * 默认 PID 文件路径：正式服务使用 `/tmp/llm-proxy.pid`。
 * dev wrapper 必须通过显式 `--pid-path`（而非 env）传递自己的 PID 文件，
 * 保证正式 CLI 不会被任意环境变量污染。
 */
const DEFAULT_PID_PATH = '/tmp/llm-proxy.pid'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9000

interface StartOptions {
  config?: string
  host?: string
  port?: number
  logLevel?: string
  /** 运行时数据目录（日志、usage.db、vision-cache 等）。默认 ~/.llm-proxy */
  dataDir?: string
  /**
   * PID 文件路径。仅接受显式参数；不读取 `LLM_PROXY_PID_PATH` 环境变量，
   * 避免任意 shell env 污染正式服务。dev wrapper 通过 `--pid-path` 传入。
   */
  pidPath?: string
}

interface ProxyState {
  pid: number
  port: number
  /** Present for state files written by current versions; absent in legacy files. */
  startedAt?: number
}

function getState(pidPath = DEFAULT_PID_PATH): ProxyState | null {
  try {
    const raw = readFileSync(pidPath, 'utf-8').trim()
    const parsed = JSON.parse(raw)
    if (typeof parsed.pid === 'number' && typeof parsed.port === 'number') {
      return {
        pid: parsed.pid,
        port: parsed.port,
        ...(typeof parsed.startedAt === 'number' ? { startedAt: parsed.startedAt } : {}),
      }
    }
    // 兼容旧格式（纯 PID）
    const pid = parseInt(raw, 10)
    return isNaN(pid) ? null : { pid, port: DEFAULT_PORT }
  } catch {
    return null
  }
}

function stateMatches(a: ProxyState | null, b: ProxyState): boolean {
  if (a === null || a.pid !== b.pid || a.port !== b.port) return false
  // Legacy PID files have no startedAt. PID + port is the strongest identity
  // available for those files; current files also guard against PID reuse.
  return b.startedAt === undefined || a.startedAt === b.startedAt
}

/** Remove a PID file only if it still belongs to the process that created it. */
function removeStateIfOwned(pidPath: string, pid: number): void {
  const state = getState(pidPath)
  if (state?.pid !== pid) return
  try { unlinkSync(pidPath) } catch { /* ignore */ }
}

/** Remove a state file without deleting a newer instance's state. */
function removeStateIfMatches(expected: ProxyState, pidPath = DEFAULT_PID_PATH): void {
  if (!stateMatches(getState(pidPath), expected)) return
  try { unlinkSync(pidPath) } catch { /* ignore */ }
}

function isProcessRunning(pid: number): boolean {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

function isProxyProcess(pid: number): boolean {
  if (!isProcessRunning(pid)) return false
  try {
    const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return /llm-proxy/i.test(command)
  } catch {
    return false
  }
}

/**
 * Recover from a legacy/missing PID file using the requested listening port.
 * The command line is checked as well, so `stop --port 9000` cannot terminate
 * an unrelated application that happens to listen on the same port.
 */
function findProxyPidByPort(port: number): number | null {
  try {
    const output = execFileSync('/usr/sbin/lsof', [
      '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const pids = output.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)
    for (const pid of pids) {
      if (isProxyProcess(pid)) return pid
    }
  } catch {
    // lsof is macOS-specific and may be unavailable in non-macOS installs.
  }
  return null
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
  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    try { console.error(opts.t('cli.start.sigterm')) } catch { /* ignore */ }
    // A previous instance can still be finishing shutdown after a restart.
    // Never let that old process remove the new instance's PID file.
    removeStateIfOwned(pidPath, process.pid)
    try { opts.visionCache.flushSync() } catch { /* ignore */ }
    try { opts.onShutdown?.() } catch { /* ignore */ }
    try { opts.server.close() } catch { /* ignore */ }
    process.exit(0)
  }
  const target = opts.signalTarget ?? ['SIGTERM', 'SIGINT']
  if (target === '*' || target.includes('SIGTERM')) process.on('SIGTERM', shutdown)
  if (target === '*' || target.includes('SIGINT')) process.on('SIGINT', shutdown)
}

/** 启动阶段 Logger 尚未创建，写配置加载错误到 dataDir/startup-errors.log */
function writeConfigErrorLog(dataDir: string, configPath: string, error: string): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    const logFile = `${dataDir}/startup-errors.log`
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
  /**
   * 运行时数据目录：opts.dataDir 显式 > 默认 ~/.llm-proxy。
   * dev wrapper 通过 --data-dir 指向 ~/.llm-proxy/dev，避免污染正式实例。
   */
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR
  // PID 文件路径：仅 opts.pidPath 显式传入，否则默认 /tmp/llm-proxy.pid。
  // 不读取 LLM_PROXY_PID_PATH 环境变量，防止任意 shell env 污染正式服务。
  const pidPath = opts.pidPath ?? DEFAULT_PID_PATH

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
      // 启动阶段 Logger 尚未创建，手动写错误日志到 dataDir
      writeConfigErrorLog(dataDir, configPath, errorMessage)
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
  // 日志、SQLite、识图缓存等所有运行时数据都落入 dataDir，保证 dev/正式隔离
  mkdirSync(dataDir, { recursive: true })
  const usageStore = new UsageStore(`${dataDir}/usage.db`, undefined /* Logger 在下面创建后再注入 */)
  const capture = new CaptureBuffer(store.getConfig().config.captureMaxSize ?? 100)
  const persistedLevel = store.getConfig().config.logLevel
  const defaultLevel = (opts.logLevel && ['debug', 'info', 'warn', 'error'].includes(opts.logLevel))
    ? opts.logLevel as LogLevel
    : 'info'
  const level = persistedLevel ?? defaultLevel
  const logger = new Logger(1000, dataDir, level)
  const host = opts.host ?? DEFAULT_HOST
  const configPort = store.getConfig().config.port
  const port = opts.port ?? configPort ?? DEFAULT_PORT

  // 外挂识图缓存：图片内容 hash → 描述
  const visionCache = new VisionCache({ filePath: `${dataDir}/vision-cache.json` })
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
  installShutdownHandlers({ server, visionCache, t, pidPath, onShutdown: () => usageStore.close() })

  logger.log('system', t('cli.start.started', { host, port, config: configPath }), { host, port, config: configPath })

  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ❌ 端口 ${port} 已被占用`)
      console.error(`  请用 --port 参数指定其他端口，或在配置文件中设置 port 字段\n`)
      process.exit(1)
    }
  })
  server.listen(port, host, () => {
    // PID 文件写入 resolvePidPath() 的结果，而非固定 DEFAULT_PID_PATH
    writeFileSync(pidPath, JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }))
    console.error(t('cli.start.started', { host, port }))
    console.error(t('cli.start.adminApi', { host, port }))
    console.error(t('cli.start.aiApi', { host, port }))
    console.error(t('cli.start.pid', { pid: String(process.pid) }))
    console.error(t('cli.start.configFile', { configPath }))
  })
}

export async function cmdStop(opts: { port?: number } = {}): Promise<void> {
  const { t } = createI18n('en')

  const pidFileState = getState()
  let state = pidFileState
  if (state === null || !isProxyProcess(state.pid)) {
    const recoveredPid = opts.port ? findProxyPidByPort(opts.port) : null
    if (recoveredPid !== null) {
      state = { pid: recoveredPid, port: opts.port! }
      console.error(t('cli.stop.recovered', { pid: String(recoveredPid), port: String(opts.port) }))
    }
  }

  if (state === null) {
    console.error(t('cli.stop.notRunning'))
    return
  }

  if (!isProxyProcess(state.pid)) {
    console.error(t('cli.stop.stalePid'))
    if (pidFileState !== null) removeStateIfMatches(pidFileState)
    return
  }

  console.error(t('cli.stop.stopping', { pid: String(state.pid) }))
  await stopProcess(state, t)
  if (pidFileState !== null) removeStateIfMatches(pidFileState)
  else removeStateIfMatches(state)
}

async function stopProcess(state: ProxyState, t: (key: string, vars?: Record<string, string>) => string): Promise<void> {
  try {
    process.kill(state.pid, 'SIGTERM')
  } catch {
    // The process may have exited between the liveness check and SIGTERM.
    return
  }

  // Wait for the target to disappear before returning. This is important for
  // both the menu-bar quit path and restart: starting a replacement while the
  // old listener is still alive is a common source of intermittent failures.
  const exited = await waitForProcessExit(state.pid, 5000)
  if (exited || !isProxyProcess(state.pid)) return

  try { process.kill(state.pid, 'SIGKILL') } catch { /* ignore */ }
  console.error(t('cli.stop.forceKill', { pid: String(state.pid) }))
  // Give the OS a short window to reap the process before the caller starts
  // a replacement. The state file is still removed conditionally by caller.
  await waitForProcessExit(state.pid, 1000)
}

function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const check = () => {
      if (!isProcessRunning(pid)) {
        resolve(true)
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(check, 100)
    }
    check()
  })
}

export async function cmdStatus(): Promise<void> {
  const { t } = createI18n('en')

  const state = getState()
  if (state === null || !isProxyProcess(state.pid)) {
    if (state !== null) {
      removeStateIfMatches(state)
    }
    console.error(t('cli.status.notRunning'))
    return
  }
  console.error(t('cli.status.running', { pid: String(state.pid) }))
  console.error(`  ${t('cli.status.port', { port: String(state.port) })}`)
}

export async function cmdRestart(opts: StartOptions): Promise<void> {
  const { t } = createI18n('en')

  const pidFileState = getState()
  let state = pidFileState
  if (state === null || !isProxyProcess(state.pid)) {
    const recoveredPid = opts.port ? findProxyPidByPort(opts.port) : null
    if (recoveredPid !== null) {
      state = { pid: recoveredPid, port: opts.port! }
      console.error(t('cli.stop.recovered', { pid: String(recoveredPid), port: String(opts.port) }))
    }
  }

  if (state !== null && isProxyProcess(state.pid)) {
    console.error(t('cli.restart.stopping', { pid: String(state.pid) }))
    await stopProcess(state, t)
    if (pidFileState !== null) removeStateIfMatches(pidFileState)
    else removeStateIfMatches(state)
    console.error(t('cli.restart.restarting'))
  } else if (pidFileState !== null) {
    console.error(t('cli.restart.stalePid'))
    removeStateIfMatches(pidFileState)
  }
  await cmdStart(opts)
}

export async function cmdReload(opts: { port?: number }): Promise<void> {
  const { t } = createI18n('en')

  const state = getState()
  const port = opts.port ?? state?.port ?? DEFAULT_PORT
  const url = `http://${DEFAULT_HOST}:${port}/api/admin/config/reload`

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
