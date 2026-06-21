import { describe, it } from 'node:test'
import assert from 'node:assert'
import { ConfigStore } from '../../src/config/store.js'
import { StatusTracker } from '../../src/status/tracker.js'
import { TokenTracker } from '../../src/status/token-tracker.js'
import { Logger } from '../../src/log/logger.js'
import { createProxyServer } from '../../src/api/server.js'
import type { Config } from '../../src/config/types.js'

function createConfig(): Config {
  return {
    providers: [
      { name: 'p1', type: 'openai', apiKey: 'sk-123', models: [{ id: 'mv1' }] },
    ],
  }
}

describe('api/server 超时配置（防止 socket 累积）', () => {
  it('createProxyServer 设置了 keepAliveTimeout / headersTimeout / requestTimeout / timeout', () => {
    const store = new ConfigStore('/fake/server-timeout-test', createConfig())
    const server = createProxyServer({
      adminHost: '127.0.0.1',
      adminPort: 0,
      proxyHost: '127.0.0.1',
      proxyPort: 0,
      store,
      tracker: new StatusTracker(),
      tokenTracker: new TokenTracker(),
      logger: new Logger(10),
    })

    try {
      // 显式检查关键超时值是否被设置（防止 Node 默认行为变更时静默变化）
      assert.strictEqual(server.keepAliveTimeout, 30_000, 'keepAliveTimeout 应为 30s')
      assert.strictEqual(server.headersTimeout, 60_000, 'headersTimeout 应为 60s')
      assert.strictEqual(server.requestTimeout, 300_000, 'requestTimeout 应为 5min')
      assert.strictEqual(server.timeout, 0, 'socket timeout 应为 0（不限时，允许长流式响应）')
    } finally {
      server.close()
    }
  })

  it('server.timeout = 0 允许流式响应持续数分钟不被 kill', () => {
    // 流式 LLM 响应可能持续 1-5 分钟，socket timeout 必须为 0
    // 否则长流会在到达超时阈值时被强制关闭，破坏客户端体验
    const store = new ConfigStore('/fake/server-timeout-test-2', createConfig())
    const server = createProxyServer({
      adminHost: '127.0.0.1',
      adminPort: 0,
      proxyHost: '127.0.0.1',
      proxyPort: 0,
      store,
      tracker: new StatusTracker(),
      tokenTracker: new TokenTracker(),
      logger: new Logger(10),
    })

    try {
      assert.strictEqual(server.timeout, 0)
    } finally {
      server.close()
    }
  })
})
