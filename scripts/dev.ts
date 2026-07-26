import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..')
const HOME = process.env.HOME ?? '/tmp'
const DEV_ROOT = join(HOME, '.llm-proxy', 'dev')
const SOURCE_CONFIG_PATHS = [
  join(HOME, '.llm-proxy', 'config.mirror.yaml'),
  join(HOME, '.llm-proxy', 'config.yaml.migrated'),
  join(HOME, '.llm-proxy', 'config.yaml'),
]
const DEFAULT_CONFIG_PATH = join(DEV_ROOT, 'config.yaml')
const DEFAULT_DATA_DIR = DEV_ROOT
const DEFAULT_PID_PATH = '/tmp/llm-proxy-dev.pid'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9004
const START_TIMEOUT_MS = 10_000

/** 默认 dev 数据目录下的日志路径；显式 --data-dir 时跟随用户路径，保证 verification 中 usage/log/cache 不写默认目录。 */
const DEFAULT_LOG_PATH = join(DEFAULT_DATA_DIR, 'server.log')

interface DevState {
  pid: number
  port: number
}

interface DevOptions {
  configPath: string
  dataDir: string
  host: string
  port: number
  foreground: boolean
}

function usage(): never {
  console.error(`用法:
  npm run dev -- init [--config <path>]
  npm run dev -- start [--config <path>] [--data-dir <path>] [--port <port>] [--host <host>]
  npm run dev -- stop
  npm run dev -- restart [--config <path>] [--data-dir <path>] [--port <port>] [--host <host>]
  npm run dev -- status

默认配置: ${DEFAULT_CONFIG_PATH}
初始化来源（仅首次初始化时读取）: config.mirror.yaml > config.yaml.migrated > config.yaml
默认数据目录: ${DEFAULT_DATA_DIR}
默认地址: http://${DEFAULT_HOST}:${DEFAULT_PORT}
默认日志: ${DEFAULT_LOG_PATH}`)
  process.exit(1)
}

function expandHome(value: string): string {
  if (value === '~') return HOME
  if (value.startsWith('~/')) return join(HOME, value.slice(2))
  return value
}

function getOption(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)

  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    console.error(`参数 ${name} 缺少值`)
    usage()
  }
  return value
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`无效端口: ${value}`)
    process.exit(1)
  }
  return port
}

function initializeDevConfig(configPath: string): void {
  if (existsSync(configPath)) return

  if (configPath !== DEFAULT_CONFIG_PATH) {
    console.error(`配置文件不存在: ${configPath}`)
    process.exit(1)
  }

  mkdirSync(dirname(configPath), { recursive: true })
  const sourceConfigPath = SOURCE_CONFIG_PATHS.find((path) => existsSync(path))
  if (sourceConfigPath) {
    copyFileSync(sourceConfigPath, configPath)
    console.log(`已从本机配置初始化开发配置: ${configPath}`)
    return
  }

  writeFileSync(configPath, 'log_level: debug\nproviders: []\nadapters: []\nreasoning_templates: []\n', 'utf8')
  console.log(`未找到可复用的本机配置，已创建空的开发配置: ${configPath}`)
}

function resolveOptions(args: string[]): DevOptions {
  const configPath = resolve(expandHome(getOption(args, '--config') ?? DEFAULT_CONFIG_PATH))
  if (!existsSync(configPath)) {
    console.error(`配置文件不存在: ${configPath}`)
    process.exit(1)
  }

  const dataDir = resolve(expandHome(getOption(args, '--data-dir') ?? DEFAULT_DATA_DIR))
  const port = parsePort(getOption(args, '--port')) ?? DEFAULT_PORT
  const host = getOption(args, '--host') ?? DEFAULT_HOST

  return {
    configPath,
    dataDir,
    host,
    port,
    foreground: args.includes('--foreground'),
  }
}

function readState(): DevState | null {
  try {
    const state = JSON.parse(readFileSync(DEFAULT_PID_PATH, 'utf8')) as Partial<DevState>
    if (typeof state.pid !== 'number' || typeof state.port !== 'number') return null
    return { pid: state.pid, port: state.port }
  } catch {
    return null
  }
}

function removeState(): void {
  try { unlinkSync(DEFAULT_PID_PATH) } catch { /* stale or missing PID file */ }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function isHealthy(host: string, port: number): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 800)
  try {
    const response = await fetch(`http://${host}:${port}/admin/health`, {
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForHealth(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isHealthy(host, port)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

function printLogTail(logPath: string): void {
  try {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    console.error(lines.slice(-20).join('\n'))
  } catch {
    console.error(`服务日志: ${logPath}`)
  }
}

async function stopDev(): Promise<void> {
  const state = readState()
  if (!state) {
    console.log('dev 服务未运行（没有 PID 文件）')
    return
  }

  if (!isProcessRunning(state.pid)) {
    removeState()
    console.log(`dev 服务已停止（清理过期 PID ${state.pid}）`)
    return
  }

  console.log(`正在停止 dev 服务: pid=${state.pid}, port=${state.port}`)
  process.kill(state.pid, 'SIGTERM')
  const stopped = await waitUntil(() => !isProcessRunning(state.pid), 5000)
  if (!stopped && isProcessRunning(state.pid)) {
    console.error(`优雅停止超时，发送 SIGKILL: pid=${state.pid}`)
    process.kill(state.pid, 'SIGKILL')
    await waitUntil(() => !isProcessRunning(state.pid), 1000)
  }
  removeState()
  console.log('dev 服务已停止')
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return predicate()
}

async function startDev(options: DevOptions): Promise<void> {
  const current = readState()
  if (current && isProcessRunning(current.pid)) {
    console.error(`dev 服务已在运行: http://${DEFAULT_HOST}:${current.port} (pid=${current.pid})`)
    process.exit(1)
  }
  if (current) removeState()

  mkdirSync(options.dataDir, { recursive: true })
  // 日志跟随 dataDir：与 cmdStart 中 usage.db/vision-cache/log 统一落在 dataDir 内。
  const logPath = join(options.dataDir, 'server.log')
  const logFd = openSync(logPath, 'a')
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    join(PROJECT_ROOT, 'src/index.ts'),
    'start',
    '--config',
    options.configPath,
    '--data-dir',
    options.dataDir,
    '--host',
    options.host,
    '--port',
    String(options.port),
  ], {
    cwd: PROJECT_ROOT,
    detached: !options.foreground,
    env: {
      ...process.env,
      LLM_PROXY_PID_PATH: DEFAULT_PID_PATH,
    },
    stdio: options.foreground ? 'inherit' : ['ignore', logFd, logFd],
  })

  if (options.foreground) {
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })
    return
  }

  const started = await waitForHealth(options.host, options.port, START_TIMEOUT_MS)
  if (!started) {
    console.error(`dev 服务启动失败或超时: http://${options.host}:${options.port}`)
    printLogTail(logPath)
    if (child.pid && isProcessRunning(child.pid)) process.kill(child.pid, 'SIGTERM')
    removeState()
    process.exit(1)
  }

  child.unref()
  const state = readState()
  console.log(`dev 服务已启动: http://${options.host}:${options.port}`)
  console.log(`管理界面: http://${options.host}:${options.port}/admin/`)
  console.log(`配置文件: ${options.configPath}`)
  console.log(`数据目录: ${options.dataDir}`)
  console.log(`PID: ${state?.pid ?? child.pid ?? 'unknown'}`)
  console.log(`日志文件: ${logPath}`)
}

async function showStatus(): Promise<void> {
  const state = readState()
  if (!state || !isProcessRunning(state.pid)) {
    if (state) removeState()
    console.log('dev 服务未运行')
    return
  }

  const healthy = await isHealthy(DEFAULT_HOST, state.port)
  console.log(`dev 服务运行中: ${healthy ? 'healthy' : '进程存在但健康检查失败'}`)
  console.log(`地址: http://${DEFAULT_HOST}:${state.port}`)
  console.log(`PID: ${state.pid}`)
  console.log(`配置文件: ${DEFAULT_CONFIG_PATH}`)
  console.log(`数据目录: ${DEFAULT_DATA_DIR}`)
  console.log(`日志文件: ${DEFAULT_LOG_PATH}`)
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (!command || !['init', 'start', 'stop', 'restart', 'status'].includes(command)) usage()

  if (command === 'init') {
    const configPath = resolve(expandHome(getOption(args, '--config') ?? DEFAULT_CONFIG_PATH))
    initializeDevConfig(configPath)
    return
  }
  if (command === 'stop') {
    await stopDev()
    return
  }
  if (command === 'status') {
    await showStatus()
    return
  }

  const configPath = resolve(expandHome(getOption(args, '--config') ?? DEFAULT_CONFIG_PATH))
  initializeDevConfig(configPath)
  const options = resolveOptions(args)
  if (command === 'restart') await stopDev()
  await startDev(options)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})