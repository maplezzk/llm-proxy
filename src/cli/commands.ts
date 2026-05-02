import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { createProxyServer } from '../api/server.js'
import { ConfigStore } from '../config/store.js'
import { StatusTracker } from '../status/tracker.js'
import { TokenTracker } from '../status/token-tracker.js'
import { CaptureBuffer } from '../proxy/capture.js'
import { Logger, type LogLevel } from '../log/logger.js'
import { createI18n, detectLang } from '../lib/i18n.js'
import type { Server } from 'node:http'

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

function getPid(): number | null {
  try {
    const pid = parseInt(readFileSync(DEFAULT_PID_PATH, 'utf-8').trim(), 10)
    return isNaN(pid) ? null : pid
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

export async function cmdStart(opts: StartOptions): Promise<void> {
  // Initialize i18n from env before config is loaded
  let { t } = createI18n(detectLang(process.env.LANG))

  const configPath = opts.config ?? DEFAULT_CONFIG_PATH

  if (!existsSync(configPath)) {
    console.error(t('cli.start.configNotFound', { path: configPath }))
    process.exit(1)
  }

  const existingPid = getPid()
  if (existingPid !== null && isProcessRunning(existingPid)) {
    console.error(t('cli.start.alreadyRunning', { pid: String(existingPid) }))
    process.exit(1)
  }

  let store: ConfigStore
  try {
    store = await ConfigStore.create(configPath)
    console.error(t('cli.start.configLoaded'))
  } catch (err) {
    console.error(t('cli.start.configLoadFailed', { error: err instanceof Error ? err.message : String(err) }))
    process.exit(1)
  }

  // Re-init i18n if config specifies a locale
  const configLocale = store.getConfig().config.locale
  if (configLocale && ['zh', 'en'].includes(configLocale)) {
    const result = createI18n(configLocale)
    t = result.t
  } else {
    // Re-init with env lang in case ConfigStore already loaded
    t = createI18n(detectLang(process.env.LANG)).t
  }

  const tracker = new StatusTracker()
  const tokenTracker = new TokenTracker()
  const capture = new CaptureBuffer(200)
  const logDir = `${process.env.HOME ?? '/tmp'}/.llm-proxy`
  const persistedLevel = store.getConfig().config.logLevel
  const defaultLevel = (opts.logLevel && ['debug', 'info', 'warn', 'error'].includes(opts.logLevel))
    ? opts.logLevel as LogLevel
    : 'info'
  const level = persistedLevel ?? defaultLevel
  const logger = new Logger(1000, logDir, level)
  const host = opts.host ?? DEFAULT_HOST
  const port = opts.port ?? DEFAULT_PORT

  const server = createProxyServer({
    adminHost: host,
    adminPort: port,
    proxyHost: host,
    proxyPort: port,
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

  logger.log('system', t('cli.start.started', { host, port, config: configPath }), { host, port, config: configPath })

  server.listen(port, host, () => {
    writeFileSync(DEFAULT_PID_PATH, String(process.pid))
    console.error(t('cli.start.started', { host, port }))
    console.error(t('cli.start.adminApi', { host, port }))
    console.error(t('cli.start.aiApi', { host, port }))
    console.error(t('cli.start.pid', { pid: String(process.pid) }))
    console.error(t('cli.start.configFile', { configPath }))
  })
}

export async function cmdStop(): Promise<void> {
  // Initialize i18n from env (no config loaded yet)
  const { t } = createI18n(detectLang(process.env.LANG))

  const pid = getPid()
  if (pid === null) {
    console.error(t('cli.stop.notRunning'))
    return
  }

  if (!isProcessRunning(pid)) {
    console.error(t('cli.stop.stalePid'))
    try { unlinkSync(DEFAULT_PID_PATH) } catch { /* ignore */ }
    return
  }

  console.error(t('cli.stop.stopping', { pid: String(pid) }))
  process.kill(pid, 'SIGTERM')
}

export async function cmdStatus(): Promise<void> {
  const { t } = createI18n(detectLang(process.env.LANG))

  const pid = getPid()
  if (pid === null || !isProcessRunning(pid)) {
    if (pid !== null) {
      try { unlinkSync(DEFAULT_PID_PATH) } catch { /* ignore */ }
    }
    console.error(t('cli.status.notRunning'))
    return
  }
  console.error(t('cli.status.running', { pid: String(pid) }))
}

export async function cmdRestart(opts: StartOptions): Promise<void> {
  const { t } = createI18n(detectLang(process.env.LANG))

  const pid = getPid()
  if (pid !== null && isProcessRunning(pid)) {
    console.error(t('cli.restart.stopping', { pid: String(pid) }))
    process.kill(pid, 'SIGTERM')
    // Wait for process to exit
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!isProcessRunning(pid)) {
          clearInterval(check)
          resolve()
        }
      }, 200)
      setTimeout(() => { clearInterval(check); resolve() }, 5000)
    })
    console.error(t('cli.restart.restarting'))
  } else if (pid !== null) {
    console.error(t('cli.restart.stalePid'))
    try { unlinkSync(DEFAULT_PID_PATH) } catch { /* ignore */ }
  }
  await cmdStart(opts)
}

export async function cmdReload(opts: { port?: number }): Promise<void> {
  const { t } = createI18n(detectLang(process.env.LANG))

  const port = opts.port ?? DEFAULT_PORT
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
