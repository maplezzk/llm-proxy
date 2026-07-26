import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
/** 默认 dev 数据目录下的日志路径；显式 --data-dir 时跟随用户路径，保证 verification 中 usage/log/cache 不写默认目录。 */
const DEFAULT_LOG_PATH = join(DEFAULT_DATA_DIR, 'server.log')
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9004
const DEFAULT_BACKEND_PORT = 9014
const START_TIMEOUT_MS = 10_000



/**
 * dev PID/state 元数据：
 * - pid/port/startedAt：cmdStart 写入的最小集（与正式 service 兼容）
 * - host/configPath/dataDir/logPath：dev wrapper 在 health check 通过后补充，
 *   用于 status 展示实际启动参数，并作为 PID 身份校验的可验证元数据。
 * - vitePid/vitePort/backendPort：dev wrapper 启动 Vite 后补充，用于停止双进程、status 展示、
 *   以及信号处理中精确识别 Vite 进程。
 */
interface DevState {
  pid: number
  port: number
  startedAt?: number
  host?: string
  configPath?: string
  dataDir?: string
  logPath?: string
  vitePid?: number
  /**
   * dev wrapper 启动 Vite 时使用的端口（与 options.port 一致），
   * 用于 stopDev / 信号处理中精确校验 Vite 进程身份并按 pid 兜底终止，
   * 替代之前脆弱的 `cmd.includes('admin-ui')` 字符串匹配。
   */
  vitePort?: number
  backendPort?: number
}

interface DevOptions {
  configPath: string
  dataDir: string
  host: string
  port: number
  /**
   * 运行模式：false=前台（默认，stdio inherit + Ctrl-C 退出），true=后台 detach（logFd 重定向 + unref）。
   * --foreground 兼容旧调用，等价于默认前台；-d/--background 显式后台。
   */
  background: boolean
}

function usage(): never {
  console.error(`用法:
  npm run dev -- init [--config <path>]
  npm run dev -- start   [--config <path>] [--data-dir <path>] [--port <port>] [--host <host>] [-d|--background]
  npm run dev -- stop
  npm run dev -- restart [--config <path>] [--data-dir <path>] [--port <port>] [--host <host>] [-d|--background]
  npm run dev -- status

默认前台运行（与 npm run dev 业界惯例一致：阻塞终端、实时日志、Ctrl-C 终止）。
  -d / --background   切换为后台 detach（秒返回，日志写 server.log，用 stop / restart 关闭）。
  --foreground        兼容旧调用，等价于默认前台；与 -d/--background 同时给出时报错。

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

  const foreground = args.includes('--foreground')
  const background = args.includes('-d') || args.includes('--background')
  // --foreground 是兼容旧调用的同义词：单独出现时默认就是前台（background=false），
  // 与 -d/--background 同时给出时报错，避免用户以为两个开关会“叠加”。
  if (foreground && background) {
    console.error('参数冲突: --foreground 与 -d/--background 不能同时使用（二选一）')
    usage()
  }

  return {
    configPath,
    dataDir,
    host,
    port,
    background,
  }
}

type ParseOutcome =
  | { kind: 'ok'; state: DevState }
  | { kind: 'json-error'; reason: string }
  | { kind: 'invalid-shape' }

/**
 * 把 PID JSON 解析为 DevState。纯函数：无 IO、无日志、无外部可变状态。
 * 返回可辨识联合区分三种结果，调用方决定是否上报。
 */
function parseState(raw: string): ParseOutcome {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    return { kind: 'json-error', reason: err instanceof Error ? err.message : String(err) }
  }
  if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') {
    return { kind: 'invalid-shape' }
  }
  const state: DevState = { pid: parsed.pid, port: parsed.port }
  if (typeof parsed.startedAt === 'number') state.startedAt = parsed.startedAt
  if (typeof parsed.host === 'string') state.host = parsed.host
  if (typeof parsed.configPath === 'string') state.configPath = parsed.configPath
  if (typeof parsed.dataDir === 'string') state.dataDir = parsed.dataDir
  if (typeof parsed.logPath === 'string') state.logPath = parsed.logPath
  if (typeof parsed.vitePid === 'number') state.vitePid = parsed.vitePid
  if (typeof parsed.vitePort === 'number') state.vitePort = parsed.vitePort
  if (typeof parsed.backendPort === 'number') state.backendPort = parsed.backendPort
  return { kind: 'ok', state }
}

function readState(): DevState | null {
  // 文件不存在是正常空状态（首次启动 / 已清理）。
  if (!existsSync(DEFAULT_PID_PATH)) return null
  let raw: string
  try {
    raw = readFileSync(DEFAULT_PID_PATH, 'utf8').trim()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[dev] PID 文件读取失败 (${DEFAULT_PID_PATH}): ${reason}`)
    return null
  }
  if (raw.length === 0) return null
  const outcome = parseState(raw)
  if (outcome.kind === 'json-error') {
    console.error(`[dev] PID 文件 JSON 解析失败 (${DEFAULT_PID_PATH}): ${outcome.reason}`)
    return null
  }
  if (outcome.kind === 'invalid-shape') {
    console.error(`[dev] PID 文件结构不合法 (${DEFAULT_PID_PATH}): 缺少 pid/port`)
    return null
  }
  return outcome.state
}

function writeState(state: DevState): void {
  writeFileSync(DEFAULT_PID_PATH, JSON.stringify(state), 'utf-8')
}

function removeState(): void {
  try { unlinkSync(DEFAULT_PID_PATH) } catch { /* stale or missing PID file */ }
}

/** 用 cmdStart 已写入的最小集覆盖 host/configPath/dataDir/logPath，保留 startedAt。 */
function addDevMetadata(extra: Partial<DevState> & Required<Pick<DevState, 'host' | 'configPath' | 'dataDir' | 'logPath'>>): void {
  const current = readState()
  if (!current) return
  writeState({ ...current, ...extra })
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 校验 PID 文件中的 pid 是否仍是 dev wrapper 启动的同一进程。
 * 通过 `/bin/ps -o command=` 读取命令行，匹配 tsx 启动 + `--config <configPath>` 标记。
 * 用于防止 PID 复用或 PID 文件被替换时误杀/误清理。
 * 读取失败时返回 false（保守拒绝），编排层 validateState 据此归类为 mismatch。
 */
function isDevProcess(pid: number, configPath: string): boolean {
  try {
    const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return /tsx/.test(cmd) && cmd.includes(`--config ${configPath}`)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[dev] 无法读取 pid=${pid} 的命令行（${reason}）；保守判定为身份不匹配。`)
    return false
  }
}

type StateValidation = 'stale' | 'mismatch' | 'valid'

/**
 * 综合判定 PID/state 是否仍代表 dev 服务：
 * - stale：pid 进程已不存在，PID 文件可清理
 * - mismatch：pid 进程存活但身份不匹配 dev（PID 复用 / PID 文件被替换 / 无法验证），保留状态并报错
 * - valid：pid 进程存活且身份匹配
 */
function validateState(state: DevState): StateValidation {
  if (!isProcessRunning(state.pid)) return 'stale'
  if (!state.configPath) return 'mismatch'
  if (!isDevProcess(state.pid, state.configPath)) return 'mismatch'
  return 'valid'
}

async function isHealthy(host: string, port: number): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 800)
  try {
    const response = await fetch(`http://${host}:${port}/api/admin/health`, {
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

function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const check = () => {
      if (predicate() || Date.now() >= deadline) return resolve(predicate())
      setTimeout(check, 100)
    }
    check()
  })
}

/**
 * 校验 PID 进程是否为我们 spawn 的 Vite。
 * 条件：命令行包含 `vite` 且包含 `--port <expectedPort>`（dev wrapper 记录的精确端口）。
 * 比之前的 `cmd.includes('admin-ui')` 更鲁棒：只靠 `--port` 数字匹配即可唯一锁定本次启动的 Vite。
 * ps 不可用时返回 false（验证失败），调用方应使用 killViteIfOurs 提供的 pid 兜底。
 */
function isViteProcess(pid: number, expectedPort: number): boolean {
  try {
    const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return /vite/.test(cmd) && cmd.includes(`--port ${expectedPort}`)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[dev] 无法读取 pid=${pid} 的命令行（${reason}）；保守判定为身份不匹配。`)
    return false
  }
}

/**
 * 终止 dev wrapper 启动的 Vite 进程。
 * - vitePort 已记录 + ps 验证通过：精确终止
 * - vitePort 未记录 / ps 验证失败：按 pid 终止以避免孤儿（带 warning）
 * 这样即使 ps 不可用或 PID 文件中缺少 vitePort，也不会留下孤儿进程。
 * 调用方需保证 vitePid 已存在（dev PID 文件中的 vitePid 是 number | undefined，调用前应 if 守卫）。
 */
async function killViteIfOurs(vitePid: number, vitePort: number | undefined): Promise<void> {
  if (!isProcessRunning(vitePid)) return
  const verified = vitePort !== undefined && isViteProcess(vitePid, vitePort)
  if (verified) {
    await stopProcess(vitePid, 'Vite')
    return
  }
  console.error(`[dev] Vite pid=${vitePid} 验证不完整（port=${vitePort ?? '未记录'}）；按 pid 终止以避免孤儿。`)
  await stopProcess(vitePid, 'Vite')
}

function terminateProcess(pid: number, label: string): void {
  if (!isProcessRunning(pid)) return
  console.log(`正在停止 ${label}: pid=${pid}`)
  process.kill(pid, 'SIGTERM')
}

async function stopProcess(pid: number, label: string): Promise<void> {
  terminateProcess(pid, label)
  const stopped = await waitUntil(() => !isProcessRunning(pid), 5000)
  if (!stopped && isProcessRunning(pid)) {
    console.error(`${label} 优雅停止超时，发送 SIGKILL: pid=${pid}`)
    process.kill(pid, 'SIGKILL')
    await waitUntil(() => !isProcessRunning(pid), 1000)
  }
}




function printLogTail(logPath: string): void {
  try {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    console.error(lines.slice(-20).join('\n'))
  } catch {
    console.error(`服务日志: ${logPath}`)
  }
}

/** 报告 PID/state 冲突并保留状态退出；start/stop/status 通用。 */
function reportMismatch(state: DevState): never {
  console.error(`冲突：dev PID/state 与实际进程身份不匹配。`)
  console.error(`  PID 文件指向 pid=${state.pid}，但该进程不是由 dev wrapper 启动的 tsx 实例。`)
  if (state.configPath) console.error(`  PID/configPath=${state.configPath}`)
  if (state.port) console.error(`  PID/port=${state.port}`)
  console.error(`  可能原因：PID 被复用 / PID 文件被替换 / 进程被替换为其他 llm-proxy 进程。`)
  console.error(`  未执行 stop 操作；请人工检查后清理。`)
  process.exit(1)
}

async function stopDev(): Promise<void> {
  const state = readState()
  if (!state) {
    console.log('dev 服务未运行（没有 PID 文件）')
    return
  }

  const validation = validateState(state)
  if (validation === 'stale') {
    // stale 路径：后端已死但 Vite 可能仍存活；用 killViteIfOurs 精确终止（含 ps 失败兜底）
    if (state.vitePid) await killViteIfOurs(state.vitePid, state.vitePort)
    removeState()
    console.log(`dev 服务已停止（清理过期 PID ${state.pid}）`)
    return
  }
  if (validation === 'mismatch') reportMismatch(state)

  console.log(`正在停止 dev 服务: backend pid=${state.pid}, vite pid=${state.vitePid ?? 'unknown'}`)
  await stopProcess(state.pid, '后端')
  if (state.vitePid) await killViteIfOurs(state.vitePid, state.vitePort)
  removeState()
  console.log('dev 服务已停止')
}


async function runForeground(children: Array<{ child: ReturnType<typeof spawn>; label: string }>, options: DevOptions): Promise<never> {
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    let settled = false
    const finish = (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
      if (settled) return
      settled = true
      for (const { child } of children) if (child.pid && isProcessRunning(child.pid)) child.kill('SIGTERM')
      resolve(result)
    }
    for (const { child } of children) {
      child.once('exit', (code, signal) => finish({ code, signal }))
      child.once('error', (error) => finish({ code: null, signal: null, error }))
    }
  })
  if (result.error) {
    console.error(`dev 子进程启动失败 (config=${options.configPath}, port=${options.port}, data-dir=${options.dataDir}): ${result.error.message}`)
    process.exit(1)
  }
  process.exit(result.code ?? 1)
}


async function startDev(options: DevOptions): Promise<void> {
  const current = readState()
  if (current) {
    const validation = validateState(current)
    if (validation === 'valid') {
      const host = current.host ?? DEFAULT_HOST
      console.error(`dev 服务已在运行: http://${host}:${current.port} (pid=${current.pid})`)
      process.exit(1)
    }
    if (validation === 'mismatch') reportMismatch(current)
    if (validation === 'stale') removeState()
  }

  const backendPort = parsePort(process.env.LLM_PROXY_DEV_BACKEND_PORT) ?? DEFAULT_BACKEND_PORT
  mkdirSync(options.dataDir, { recursive: true })
  const logPath = join(options.dataDir, 'server.log')
  const logFd = openSync(logPath, 'a')
  /**
   * 内部判定：默认前台，-d/--background 显式后台。`--foreground` 兼容旧调用，等价于前台。
   * - 前台：stdio: 'inherit'（实时日志）+ detached: false（共享进程组，Ctrl-C 一次清场）
   * - 后台：stdio 重定向到 logFd + detached: true（独立进程组），PID 文件供 stop 使用
   */
  const runInBackground = options.background
  const backendArgs = [
    '--import', 'tsx', join(PROJECT_ROOT, 'src/index.ts'), 'start',
    '--config', options.configPath, '--data-dir', options.dataDir,
    '--host', '127.0.0.1', '--port', String(backendPort), '--pid-path', DEFAULT_PID_PATH,
  ] as const
  const viteArgs = [
    'admin-ui', '--port', String(options.port), '--host', options.host,
  ] as const
  // stdio 在 spawn 的重载 union 下，三元表达式会推为 'inherit' | array 的混合类型，
  // 分支传参让 TS 各自精确匹配重载，避免 cast。
  const child = runInBackground
    ? spawn(process.execPath, [...backendArgs], {
        cwd: PROJECT_ROOT, detached: true, env: process.env,
        stdio: ['ignore', logFd, logFd],
      })
    : spawn(process.execPath, [...backendArgs], {
        cwd: PROJECT_ROOT, detached: false, env: process.env,
        stdio: 'inherit',
      })
  const vite = runInBackground
    ? spawn(join(PROJECT_ROOT, 'node_modules/.bin/vite'), [...viteArgs], {
        cwd: PROJECT_ROOT, detached: true, env: {
          ...process.env, LLM_PROXY_DEV_BACKEND_PORT: String(backendPort),
        },
        stdio: ['ignore', logFd, logFd],
      })
    : spawn(join(PROJECT_ROOT, 'node_modules/.bin/vite'), [...viteArgs], {
        cwd: PROJECT_ROOT, detached: false, env: {
          ...process.env, LLM_PROXY_DEV_BACKEND_PORT: String(backendPort),
        },
        stdio: 'inherit',
      })

  if (!runInBackground) {
    // 前台：wrapper 阻塞直到任一子进程退出；runForeground 内部会向其他子进程发 SIGTERM 并传播退出码。
    // 不写 PID 元数据（前台模式下 stop 不可用；用户用 Ctrl-C / 进程组 SIGINT 终止）。
    await runForeground([{ child, label: '后端' }, { child: vite, label: 'Vite' }], options)
    return
  }

  // strictPort / 配置错误等场景下 Vite 会立即 exit，非零退出码；
  // 与 waitForHealth 并发 race，一旦 Vite 退出带错误就立即报错，不要等到 10s 超时。
  const healthPromise = waitForHealth(options.host, options.port, START_TIMEOUT_MS)
  const viteExitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null } | null>((resolve) => {
    vite.once('exit', (code, signal) => resolve({ code, signal }))
  })
  let viteExitStatus: { code: number | null; signal: NodeJS.Signals | null } | null = null
  let healthOk = false
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve() } }
    healthPromise.then(
      (ok) => { if (!settled) { healthOk = ok; finish() } },
      (err) => { console.error(`[dev][stage=waitForStartup] waitForHealth 抛错 (${err instanceof Error ? err.message : String(err)})`); finish() },
    )
    viteExitPromise.then(
      (status) => { if (!settled) { viteExitStatus = status; finish() } },
      (err) => { console.error(`[dev][stage=viteExitWatch] vite exit 监听抛错 (${err instanceof Error ? err.message : String(err)})`); finish() },
    )
  })

  const abortStartup = (reason: string): never => {
    console.error(reason)
    printLogTail(logPath)
    if (child.pid && isProcessRunning(child.pid)) process.kill(child.pid, 'SIGTERM')
    if (vite.pid && isProcessRunning(vite.pid)) process.kill(vite.pid, 'SIGTERM')
    removeState()
    process.exit(1)
  }

  if (viteExitStatus && viteExitStatus.code !== null && viteExitStatus.code !== 0 && viteExitStatus.signal === null) {
    abortStartup(`Vite 启动失败 (exit code=${viteExitStatus.code}, port=${options.port})；常见原因：端口被占用 / strictPort 冲突 / 配置错误。`)
  }
  if (!healthOk) {
    abortStartup(`dev 服务启动失败或超时: http://${options.host}:${options.port}`)
  }

  child.unref()
  vite.unref()
  addDevMetadata({
    host: options.host, configPath: options.configPath, dataDir: options.dataDir,
    logPath, vitePid: vite.pid, vitePort: options.port, backendPort,
  })

  const state = readState()
  console.log(`dev 服务已启动: http://${options.host}:${options.port}`)
  console.log(`管理界面: http://${options.host}:${options.port}/admin/`)
  console.log(`后端内部端口: 127.0.0.1:${backendPort}`)
  console.log(`配置文件: ${options.configPath}`)
  console.log(`数据目录: ${options.dataDir}`)
  console.log(`PID: ${state?.pid ?? child.pid ?? 'unknown'} (Vite: ${vite.pid ?? 'unknown'} port=${options.port})`)
  console.log(`日志文件: ${logPath}`)
  // detached 模式下子进程已 unref，wrapper 启动成功、打印信息后自然退出，
  // 停止服务靠 `npm run dev -- stop`（PID 文件 + 精确杀进程）。
  // foreground 模式不在此处返回（已在前面 runForeground 中 await 住）。
}

async function showStatus(): Promise<void> {
  const state = readState()
  if (!state) {
    console.log('dev 服务未运行')
    return
  }

  const validation = validateState(state)
  if (validation === 'stale') {
    removeState()
    console.log('dev 服务未运行')
    return
  }
  if (validation === 'mismatch') reportMismatch(state)

  const host = state.host ?? DEFAULT_HOST
  const configPath = state.configPath ?? DEFAULT_CONFIG_PATH
  const dataDir = state.dataDir ?? DEFAULT_DATA_DIR
  const logPath = state.logPath ?? DEFAULT_LOG_PATH
  const backendPort = state.backendPort ?? DEFAULT_BACKEND_PORT
  const viteLabel = state.vitePid
    ? `${state.vitePid}${state.vitePort !== undefined ? ` (port ${state.vitePort})` : ''}`
    : 'unknown'

  const healthy = await isHealthy(host, state.port)
  console.log(`dev 服务运行中: ${healthy ? 'healthy' : '进程存在但健康检查失败'}`)
  console.log(`地址: http://${host}:${state.port}`)
  console.log(`后端内部地址: http://127.0.0.1:${backendPort}`)
  console.log(`PID: ${state.pid} (Vite: ${viteLabel})`)
  console.log(`配置文件: ${configPath}`)
  console.log(`数据目录: ${dataDir}`)
  console.log(`日志文件: ${logPath}`)
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