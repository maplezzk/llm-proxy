import { describe, it } from 'node:test'
import assert from 'node:assert'
import { ConfigStore } from '../../src/config/store.js'
import { StatusTracker } from '../../src/status/tracker.js'
import { Logger } from '../../src/log/logger.js'
import type { Config } from '../../src/config/types.js'
import { handleGetConfig, handleReload, handleHealth, handleStatus, handleGetLocale, handleSetLocale, handleSetProxyKey, handleCreateProvider, handleUpdateProvider, handleCreateAdapter } from '../../src/api/handlers/index.js'
import type { OutgoingHttpHeaders } from 'node:http'

function createConfig(): Config {
  return {
    providers: [
      { name: 'p1', type: 'openai', apiKey: 'sk-123', models: [{ id: 'mv1' }] },
    ],
  }
}

function mockRes() {
  let body = ''
  let status = 200
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    writeHead: (s: number, _headers?: OutgoingHttpHeaders) => {
      status = s
    },
    end: (data: string) => {
      body = data
    },
    setHeader: () => {},
    getHeader: () => undefined,
    getStatus: () => status,
    getBody: () => body,
  }
}

type MockRes = ReturnType<typeof mockRes>

describe('api/handlers', () => {
  it('GET /admin/config 返回脱敏配置', () => {
    const store = new ConfigStore('/fake', createConfig())
    const tracker = new StatusTracker()
    const ctx = { store, tracker, logger: new Logger() }
    const res = mockRes()
    handleGetConfig(ctx, {} as never, res as never)
    const data = JSON.parse(res.getBody())
    assert.strictEqual(data.success, true)
    assert.strictEqual(data.data.providers[0].api_key, 'sk-123')
  })

  it('POST /admin/providers 支持创建多协议供应商', async () => {
    const tmpDir = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/llm-proxy-test-')
    const store = new ConfigStore(`${tmpDir}/config.yaml`, { providers: [] })
    const ctx = { store, tracker: new StatusTracker(), logger: new Logger() }
    const req = new (await import('stream')).Readable()
    req.push(JSON.stringify({
      name: 'multi',
      api_key: 'k1',
      protocols: [
        { type: 'openai', api_base: 'https://example.test/openai' },
        { type: 'anthropic', api_base: 'https://example.test/anthropic' },
      ],
      models: [
        { id: 'chat', protocols: ['openai', 'anthropic'] },
        { id: 'messages', protocols: ['anthropic'] },
      ],
    }))
    req.push(null)
    const res = mockRes()
    await handleCreateProvider(ctx, req as never, res as never)
    assert.strictEqual(res.getStatus(), 200)
    const provider = store.getConfig().config.providers[0]
    assert.deepStrictEqual(provider.protocols?.map((p) => p.type), ['openai', 'anthropic'])
    assert.deepStrictEqual(provider.models[0].protocols, ['openai', 'anthropic'])
  })

  it('保存多协议供应商时清除旧版 type 和 api_base', async () => {
    const tmpDir = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/llm-proxy-test-')
    const store = new ConfigStore(`${tmpDir}/config.yaml`, {
      providers: [{
        name: 'multi',
        type: 'openai',
        apiKey: 'k1',
        apiBase: 'https://legacy.example',
        models: [{ id: 'chat', protocol: 'openai' }],
      }],
    })
    const ctx = { store, tracker: new StatusTracker(), logger: new Logger() }
    const req = new(await import('stream')).Readable()
    req.push(JSON.stringify({
      name: 'multi',
      api_key: 'k1',
      type: 'openai',
      api_base: 'https://legacy.example',
      protocols: [
        { type: 'openai', api_base: 'https://example.test/openai' },
        { type: 'anthropic', api_base: 'https://example.test/anthropic' },
      ],
      models: [{ id: 'chat', protocols: ['openai', 'anthropic'], protocol: 'openai' }],
    }))
    req.push(null)
    Object.assign(req, { url: '/admin/providers/multi' })
    const res = mockRes()
    await handleUpdateProvider(ctx, req as never, res as never)
    assert.strictEqual(res.getStatus(), 200)
    const provider = store.getConfig().config.providers[0]
    assert.strictEqual(provider.type, undefined)
    assert.strictEqual(provider.apiBase, undefined)
    assert.deepStrictEqual(provider.protocols?.map((p) => p.type), ['openai', 'anthropic'])
    assert.strictEqual(provider.models[0].protocols?.length, 2)
    assert.strictEqual(provider.models[0].protocol, 'openai')
    const savedYaml = (await import('node:fs')).readFileSync(`${tmpDir}/config.yaml`, 'utf-8')
    assert.doesNotMatch(savedYaml, /  type: openai\n    api_key:/)
    assert.doesNotMatch(savedYaml, /api_base: https:\/\/legacy\.example/)
    assert.doesNotMatch(savedYaml, /\n\s+protocol: openai\n/)
  })

  it('POST /admin/adapters 不需要协议字段且保存时不写入协议', async () => {
    const tmpDir = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/llm-proxy-test-')
    const configPath = `${tmpDir}/config.yaml`
    const store = new ConfigStore(configPath, createConfig())
    const ctx = { store, tracker: new StatusTracker(), logger: new Logger() }
    const req = new (await import('stream')).Readable()
    req.push(JSON.stringify({
      name: 'tool',
      models: [{ sourceModelId: 'source', provider: 'p1', targetModelId: 'mv1' }],
    }))
    req.push(null)
    const res = mockRes()

    await handleCreateAdapter(ctx, req as never, res as never)

    assert.strictEqual(res.getStatus(), 200)
    const adapter = store.getConfig().config.adapters?.[0]
    assert.ok(adapter)
    assert.strictEqual(Object.hasOwn(adapter, 'type'), false)
    const savedYaml = (await import('node:fs')).readFileSync(configPath, 'utf-8')
    assert.doesNotMatch(savedYaml, /adapters:\n\s+- name: tool\n\s+type:/)
  })

  it('GET /admin/health 返回 ok', () => {
    const store = new ConfigStore('/fake', createConfig())
    const tracker = new StatusTracker()
    const ctx = { store, tracker, logger: new Logger() }
    const res = mockRes()
    handleHealth(ctx, {} as never, res as never)
    const data = JSON.parse(res.getBody())
    assert.strictEqual(data.data.status, 'ok')
  })

  it('POST /admin/config/reload 失败时返回错误', async () => {
    const store = new ConfigStore('/nonexistent', createConfig())
    const tracker = new StatusTracker()
    const ctx = { store, tracker, logger: new Logger() }
    const res = mockRes()
    await handleReload(ctx, {} as never, res as never)
    const data = JSON.parse(res.getBody())
    assert.strictEqual(data.success, false)
  })

  it('GET /admin/status/providers 返回结构', () => {
    const store = new ConfigStore('/fake', createConfig())
    const tracker = new StatusTracker()
    const ctx = { store, tracker, logger: new Logger() }
    const res = mockRes()
    handleStatus(ctx, {} as never, res as never)
    const data = JSON.parse(res.getBody())
    assert.strictEqual(data.success, true)
    assert.ok(Array.isArray(data.data.providers))
    assert.strictEqual(data.data.providers.length, 1)
    assert.strictEqual(data.data.providers[0].name, 'p1')
  })

  it('GET /admin/locale 返回默认 locale en', () => {
    const store = new ConfigStore('/fake', createConfig())
    const ctx = { store, tracker: new StatusTracker(), logger: new Logger() }
    const res = mockRes()
    handleGetLocale(ctx, {} as never, res as never)
    const data = JSON.parse(res.getBody())
    assert.strictEqual(data.success, true)
    assert.strictEqual(data.data.locale, 'en')
  })

  it('GET /admin/locale 返回配置中的 locale', () => {
    const config = createConfig()
    config.locale = 'zh'
    const store = new ConfigStore('/fake', config)
    const ctx = { store, tracker: new StatusTracker(), logger: new Logger() }
    const res = mockRes()
    handleGetLocale(ctx, {} as never, res as never)
    const data = JSON.parse(res.getBody())
    assert.strictEqual(data.success, true)
    assert.strictEqual(data.data.locale, 'zh')
  })

  it('PUT /admin/locale 设置 locale 为 zh', async () => {
    const tmpDir = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/llm-proxy-test-')
    const configPath = tmpDir + '/config.yaml'
    const store = new ConfigStore(configPath, createConfig())
    const ctx = { store, tracker: new StatusTracker(), logger: new Logger() }
    const req = new(await import('stream')).Readable()
    req.push(JSON.stringify({ locale: 'zh' }))
    req.push(null)
    const res = mockRes()
    await handleSetLocale(ctx, req as never, res as never)
    const data = JSON.parse(res.getBody())
    assert.strictEqual(data.success, true)
    assert.strictEqual(data.data.locale, 'zh')
    // 验证配置已更新
    const res2 = mockRes()
    handleGetLocale(ctx, {} as never, res2 as never)
    const data2 = JSON.parse(res2.getBody())
    assert.strictEqual(data2.data.locale, 'zh')
  })

  it('PUT /admin/proxy-key 热更新运行时配置且保留其他配置', async () => {
    const tmpDir = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/llm-proxy-test-')
    const configPath = tmpDir + '/config.yaml'
    const config: Config = {
      ...createConfig(),
      providers: [{ ...createConfig().providers[0], models: [{ id: 'mv1', input: ['image'] }] }],
      adapters: [{ name: 'adapter', models: [{ sourceModelId: 'source', provider: 'p1', targetModelId: 'mv1' }] }],
      vision: { provider: 'p1', model: 'mv1' },
      locale: 'zh',
      port: 9100,
      captureMaxSize: 42,
      logLevel: 'debug',
    }
    const store = new ConfigStore(configPath, config)
    const ctx = { store, tracker: new StatusTracker(), logger: new Logger() }
    const req = new(await import('stream')).Readable()
    req.push(JSON.stringify({ key: '  proxy-secret  ' }))
    req.push(null)
    const res = mockRes()

    await handleSetProxyKey(ctx, req as never, res as never)

    assert.strictEqual(res.getStatus(), 200)
    const current = store.getConfig().config
    assert.strictEqual(current.proxyKey, 'proxy-secret')
    assert.deepStrictEqual(current.adapters, config.adapters)
    assert.deepStrictEqual(current.vision, config.vision)
    assert.strictEqual(current.locale, 'zh')
    assert.strictEqual(current.port, 9100)
    assert.strictEqual(current.captureMaxSize, 42)
    assert.strictEqual(current.logLevel, 'debug')
  })

  it('PUT /admin/locale 无效参数返回 400', async () => {
    const tmpDir = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/llm-proxy-test-')
    const configPath = tmpDir + '/config.yaml'
    const store = new ConfigStore(configPath, createConfig())
    const ctx = { store, tracker: new StatusTracker(), logger: new Logger() }
    const req = new(await import('stream')).Readable()
    req.push(JSON.stringify({ locale: 'fr' }))
    req.push(null)
    const res = mockRes()
    await handleSetLocale(ctx, req, res as never)
    assert.strictEqual(res.getStatus(), 400)
  })
})
