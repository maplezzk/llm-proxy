#!/usr/bin/env node
import { cmdStart, cmdStop, cmdStatus, cmdReload, cmdRestart } from './cli/commands.js'

const COMMANDS: Record<string, () => Promise<void>> = {
  start: () => {
    const configIndex = process.argv.indexOf('--config')
    const config = configIndex !== -1 ? process.argv[configIndex + 1] : undefined
    const hostIndex = process.argv.indexOf('--host')
    const host = hostIndex !== -1 ? process.argv[hostIndex + 1] : undefined
    const portIndex = process.argv.indexOf('--port')
    const port = portIndex !== -1 ? parseInt(process.argv[portIndex + 1], 10) : undefined
    const logLevelIndex = process.argv.indexOf('--log-level')
    const logLevel = logLevelIndex !== -1 ? process.argv[logLevelIndex + 1] : undefined
    return cmdStart({ config, host, port: isNaN(port as number) ? undefined : port, logLevel })
  },
  stop: cmdStop,
  status: cmdStatus,
  restart: () => {
    const configIndex = process.argv.indexOf('--config')
    const config = configIndex !== -1 ? process.argv[configIndex + 1] : undefined
    const hostIndex = process.argv.indexOf('--host')
    const host = hostIndex !== -1 ? process.argv[hostIndex + 1] : undefined
    const portIndex = process.argv.indexOf('--port')
    const port = portIndex !== -1 ? parseInt(process.argv[portIndex + 1], 10) : undefined
    const logLevelIndex = process.argv.indexOf('--log-level')
    const logLevel = logLevelIndex !== -1 ? process.argv[logLevelIndex + 1] : undefined
    return cmdRestart({ config, host, port: isNaN(port as number) ? undefined : port, logLevel })
  },
  reload: () => {
    const portIndex = process.argv.indexOf('--port')
    const port = portIndex !== -1 ? parseInt(process.argv[portIndex + 1], 10) : undefined
    return cmdReload({ port: isNaN(port as number) ? undefined : port })
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
  --port <port>        端口 (默认: 9000)
  --log-level <level>  日志级别: debug, info, warn, error (默认: info)
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
    console.error(`未知命令: ${command}`)
    printHelp()
    process.exit(1)
  }

  await handler()
}

main()
