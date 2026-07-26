#!/usr/bin/env node
import { cmdStart, cmdStop, cmdStatus, cmdReload, cmdRestart } from './cli/commands.js'

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : undefined
}

function readIntArg(name: string): number | undefined {
  const v = readArg(name)
  if (v === undefined) return undefined
  const n = parseInt(v, 10)
  return isNaN(n) ? undefined : n
}

const COMMANDS: Record<string, () => Promise<void>> = {
  start: () => {
    const config = readArg('--config')
    const host = readArg('--host')
    const port = readIntArg('--port')
    const logLevel = readArg('--log-level')
    // --data-dir 让 dev wrapper 可以把日志/usage.db/vision-cache 等运行时数据
    // 隔离到独立目录，避免污染正式 ~/.llm-proxy。默认仍是 ~/.llm-proxy。
    const dataDir = readArg('--data-dir')
    return cmdStart({ config, host, port, logLevel, dataDir })
  },
  stop: () => {
    const port = readIntArg('--port')
    return cmdStop({ port })
  },
  status: cmdStatus,
  restart: () => {
    const config = readArg('--config')
    const host = readArg('--host')
    const port = readIntArg('--port')
    const logLevel = readArg('--log-level')
    const dataDir = readArg('--data-dir')
    return cmdRestart({ config, host, port, logLevel, dataDir })
  },
  reload: () => {
    const port = readIntArg('--port')
    return cmdReload({ port })
  },
}

function printHelp(): void {
  console.log(`
llm-proxy — 本地统一 LLM 模型代理

用法:
  llm-proxy start      启动代理
  llm-proxy stop       停止代理
  llm-proxy restart    重启代理
  llm-proxy status     查看代理状态
  llm-proxy reload     重新加载配置
  llm-proxy --help     显示帮助

选项:
  --config <path>      配置文件路径 (默认: ~/.llm-proxy/config.yaml)
  --host <host>        绑定地址 (默认: 127.0.0.1)
  --port <port>        端口 (默认: 9000，也可在 config.yaml 中设置 port)
  --log-level <level>  日志级别: debug, info, warn, error (默认: info)
  --data-dir <path>    运行时数据目录（日志、usage.db、vision-cache，默认 ~/.llm-proxy）
`)
}

async function main(): Promise<void> {
  const command = process.argv[2]

  if (!command || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  const handler = COMMANDS[command]
  if (!handler) {
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exit(1)
  }

  await handler()
}

main()
