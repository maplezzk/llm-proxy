import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { createProxyServer } from '../api/server.js'
import { ConfigStore } from '../config/store.js'
import { StatusTracker } from '../status/tracker.js'
import { TokenTracker } from '../status/token-tracker.js'
import { CaptureBuffer } from '../proxy/capture.js'
import { Logger, type LogLevel } from '../log/logger.js'
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
  const configPath = opts.config ?? DEFAULT_CONFIG_PATH

  if (!existsSync(configPath)) {
    console.error(`错误: 配置文件不存在: ${configPath}`)
    process.exit(1)
  }

  const existingPid = getPid()
  if (existingPid !== null && isProcessRunning(existingPid)) {
    console.error(`错误: 代理已在运行 (PID: ${existingPid})`)
    process.exit(1)
  }

  let store: ConfigStore
  try {
    store = await ConfigStore.create(configPath)
    console.error('配置加载成功')
  } catch (err) {
    console.error(`配置加载失败: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
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
    console.error('\n收到 SIGTERM，正在关闭...')
    try { unlinkSync(DEFAULT_PID_PATH) } catch { /* ignore */ }
    server.close()
    process.exit(0)
  })

  logger.log('system', '代理启动', { host, port, config: configPath })

  server.listen(port, host, () => {
    writeFileSync(DEFAULT_PID_PATH, String(process.pid))
    console.error(`代理已启动: http://${host}:${port}`)
    console.error(`  管理 API:  http://${host}:${port}/admin/`)
    console.error(`  AI API:    http://${host}:${port}/v1/`)
    console.error(`PID: ${process.pid}`)
    console.error(`配置文件: ${configPath}`)
  })
}

export async function cmdStop(): Promise<void> {
  const pid = getPid()
  if (pid === null) {
    console.error('未找到运行中的代理')
    return
  }

  if (!isProcessRunning(pid)) {
    console.error('发现残留 PID 文件，清理中...')
    try { unlinkSync(DEFAULT_PID_PATH) } catch { /* ignore */ }
    return
  }

  console.error(`正在停止代理 (PID: ${pid})...`)
  process.kill(pid, 'SIGTERM')
}

export async function cmdStatus(): Promise<void> {
  const pid = getPid()
  if (pid === null || !isProcessRunning(pid)) {
    if (pid !== null) {
      try { unlinkSync(DEFAULT_PID_PATH) } catch { /* ignore */ }
    }
    console.error('代理未运行')
    return
  }
  console.error(`代理正在运行 (PID: ${pid})`)
}

export async function cmdRestart(opts: StartOptions): Promise<void> {
  const pid = getPid()
  if (pid !== null && isProcessRunning(pid)) {
    console.error(`正在停止代理 (PID: ${pid})...`)
    process.kill(pid, 'SIGTERM')
    // 等待进程退出
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!isProcessRunning(pid)) {
          clearInterval(check)
          resolve()
        }
      }, 200)
      setTimeout(() => { clearInterval(check); resolve() }, 5000)
    })
    console.error('代理已停止，正在重启...')
  }
  await cmdStart(opts)
}

export async function cmdReload(opts: { port?: number }): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT
  const url = `http://${DEFAULT_HOST}:${port}/admin/config/reload`

  try {
    const response = await fetch(url, { method: 'POST' })
    const data = await response.json()
    if (data.success) {
      console.log(`配置重载成功 (版本: ${data.data.version})`)
    } else {
      console.error(`配置重载失败: ${data.error}`)
      if (data.errors) {
        for (const e of data.errors) {
          console.error(`  - ${e.message}`)
        }
      }
      process.exit(1)
    }
  } catch (err) {
    console.error(`无法连接到代理: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
