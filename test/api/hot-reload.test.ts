import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createServer as createHttpServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from '../../src/config/store.js'
import { StatusTracker } from '../../src/status/tracker.js'
import { UsageStore } from '../../src/status/usage-store.js'
import { Logger } from '../../src/log/logger.js'
import { createProxyServer } from '../../src/api/server.js'
import type { Config } from '../../src/config/types.js'
import { serializeConfigToYaml } from '../../src/config/parser.js'
import { CaptureBuffer } from '../../src/proxy/capture.js'
import { cmdReload } from '../../src/cli/commands.js'

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function freePort(): Promise<number> {
  const server = createHttpServer()
  await listen(server, 0)
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await close(server)
  return port
}

async function waitForHealth(port: number): Promise<boolean> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/admin/health`)
      if (response.ok) return true
    } catch {
      // 重绑定有一个短暂窗口，继续轮询。
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

function config(): Config {
  return {
    providers: [{ name: 'p1', type: 'openai', apiKey: 'sk-test', models: [{ id: 'm1' }] }],
  }
}

describe('config hot reload', () => {
  it('修改端口后服务自动重绑定，无需重启进程', async () => {
    const oldPort = await freePort()
    const newPort = await freePort()
    const usageStore = new UsageStore(join(mkdtempSync(join(tmpdir(), 'hot-reload-')), 'usage.db'))
    const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), 'hot-reload-')), 'config.yaml'), config())
    const server = createProxyServer({
      adminHost: '127.0.0.1',
      adminPort: oldPort,
      proxyHost: '127.0.0.1',
      proxyPort: oldPort,
      store,
      tracker: new StatusTracker(),
      usageStore,
      logger: new Logger(),
    })

    await listen(server, oldPort)
    try {
      const response = await fetch(`http://127.0.0.1:${oldPort}/admin/port`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: newPort }),
      })

      assert.strictEqual(response.status, 200)
      assert.strictEqual(await waitForHealth(newPort), true)
      assert.strictEqual(store.getConfig().config.port, newPort)
    } finally {
      await close(server)
      usageStore.close()
    }
  })

  it('重载配置后同步日志级别、语言和抓包容量', async () => {
    const port = await freePort()
    const configPath = join(mkdtempSync(join(tmpdir(), 'hot-reload-')), 'config.yaml')
    const usageStore = new UsageStore(join(mkdtempSync(join(tmpdir(), 'hot-reload-')), 'usage.db'))
    const capture = new CaptureBuffer(3)
    capture.startRequest('test', 'openai', 'm1')
    capture.startRequest('test', 'openai', 'm2')
    const initialConfig = config()
    const store = new ConfigStore(configPath, initialConfig)
    const changedLocales: string[] = []
    const logger = new Logger()
    const server = createProxyServer({
      adminHost: '127.0.0.1',
      adminPort: port,
      proxyHost: '127.0.0.1',
      proxyPort: port,
      store,
      tracker: new StatusTracker(),
      usageStore,
      capture,
      logger,
      changeLocale: (locale) => changedLocales.push(locale),
    })

    await listen(server, port)
    try {
      const updatedConfig: Config = {
        ...initialConfig,
        logLevel: 'debug',
        locale: 'zh',
        captureMaxSize: 1,
      }
      writeFileSync(configPath, serializeConfigToYaml(updatedConfig), 'utf-8')

      const response = await fetch(`http://127.0.0.1:${port}/admin/config/reload`, { method: 'POST' })

      assert.strictEqual(response.status, 200)
      assert.strictEqual(logger.getLevel(), 'debug')
      assert.deepStrictEqual(changedLocales, ['zh'])
      assert.strictEqual(capture.getAll().length, 1)
    } finally {
      await close(server)
      usageStore.close()
    }
  })

  it('CLI reload 可使用当前密钥轮换并删除 admin_key', async () => {
    const port = await freePort()
    const configPath = join(mkdtempSync(join(tmpdir(), 'hot-reload-auth-')), 'config.yaml')
    const usageStore = new UsageStore(join(mkdtempSync(join(tmpdir(), 'hot-reload-auth-')), 'usage.db'))
    const initialConfig: Config = { ...config(), port, adminKey: 'old-secret' }
    const savedReloadAdminKey = process.env.LLM_PROXY_ADMIN_KEY
    writeFileSync(configPath, serializeConfigToYaml(initialConfig), 'utf-8')
    const store = new ConfigStore(configPath, initialConfig)
    const server = createProxyServer({
      adminHost: '127.0.0.1',
      adminPort: port,
      proxyHost: '127.0.0.1',
      proxyPort: port,
      store,
      tracker: new StatusTracker(),
      usageStore,
      logger: new Logger(),
    })

    await listen(server, port)
    try {
      writeFileSync(
        configPath,
        serializeConfigToYaml({ ...initialConfig, adminKey: 'new-secret' }),
        'utf-8',
      )
      await cmdReload({ port, config: configPath, adminKey: 'old-secret' })
      assert.strictEqual(store.getConfig().config.adminKey, 'new-secret')

      const { adminKey: _removed, ...withoutAdminKey } = initialConfig
      writeFileSync(configPath, serializeConfigToYaml(withoutAdminKey), 'utf-8')
      process.env.LLM_PROXY_ADMIN_KEY = 'new-secret'
      await cmdReload({ port, config: configPath })
      assert.strictEqual(store.getConfig().config.adminKey, undefined)
    } finally {
      if (savedReloadAdminKey === undefined) delete process.env.LLM_PROXY_ADMIN_KEY
      else process.env.LLM_PROXY_ADMIN_KEY = savedReloadAdminKey
      await close(server)
      usageStore.close()
    }
  })
})
