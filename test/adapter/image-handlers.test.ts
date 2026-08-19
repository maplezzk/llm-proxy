import { after, before, describe, it } from 'node:test'
import assert from 'node:assert'
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import { createProxyServer } from '../../src/api/server.js'
import { ConfigStore } from '../../src/config/store.js'
import type { Config } from '../../src/config/types.js'
import { Logger } from '../../src/log/logger.js'
import { StatusTracker } from '../../src/status/tracker.js'

const UPSTREAM_PORT = 19820
const PROXY_PORT = 19821

interface CapturedRequest {
  url: string
  authorization?: string
  contentType?: string
  json?: Record<string, unknown>
  form?: {
    model: string | null
    prompt: string | null
    imageName: string | null
    imageType: string | null
    imageBytes: number[]
  }
}

const captured: CapturedRequest[] = []
let upstream: Server
let proxy: Server

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function createConfig(): Config {
  return {
    proxyKey: 'proxy-secret',
    providers: [{
      name: 'images-upstream',
      apiKey: 'upstream-secret',
      protocols: [
        { type: 'openai-responses', apiBase: 'http://127.0.0.1:1' },
        { type: 'openai', apiBase: `http://127.0.0.1:${UPSTREAM_PORT}` },
      ],
      models: [{ id: 'upstream-image-model', protocols: ['openai-responses', 'openai'] }],
    }],
    adapters: [{
      name: 'amztracker',
      models: [{
        sourceModelId: 'client-image-model',
        provider: 'images-upstream',
        targetModelId: 'upstream-image-model',
      }],
    }],
  }
}

describe('adapter image handlers', { timeout: 15_000 }, () => {
  before(async () => {
    upstream = createHttpServer(async (req, res) => {
      const raw = await readRawBody(req)
      const item: CapturedRequest = {
        url: req.url ?? '/',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
      }

      if ((req.url ?? '').startsWith('/v1/images/edits')) {
        const request = new Request('http://upstream.test', {
          method: 'POST',
          headers: { 'content-type': req.headers['content-type'] ?? '' },
          body: raw,
        })
        const form = await request.formData()
        const image = form.get('image')
        item.form = {
          model: form.get('model')?.toString() ?? null,
          prompt: form.get('prompt')?.toString() ?? null,
          imageName: image instanceof File ? image.name : null,
          imageType: image instanceof File ? image.type : null,
          imageBytes: image instanceof File ? [...new Uint8Array(await image.arrayBuffer())] : [],
        }
      } else {
        item.json = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>
      }
      captured.push(item)

      if (item.json?.prompt === 'rate-limit') {
        res.writeHead(429, { 'Content-Type': 'application/json', 'x-request-id': 'upstream-429' })
        res.end(JSON.stringify({ error: { message: 'slow down' } }))
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': 'upstream-ok' })
      res.end(JSON.stringify({ created: 123, data: [{ b64_json: 'aW1hZ2U=' }] }))
    })
    await new Promise<void>((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve))

    proxy = createProxyServer({
      adminHost: '127.0.0.1',
      adminPort: PROXY_PORT,
      proxyHost: '127.0.0.1',
      proxyPort: PROXY_PORT,
      store: new ConfigStore('/fake', createConfig()),
      tracker: new StatusTracker(),
      logger: new Logger(),
    })
    await new Promise<void>((resolve) => proxy.listen(PROXY_PORT, '127.0.0.1', resolve))
  })

  after(async () => {
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ])
  })

  it('generation 选择 OpenAI 协议、重写模型并保留查询参数', async () => {
    captured.length = 0
    const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/amztracker/v1/images/generations?trace=1`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer proxy-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'client-image-model', prompt: 'draw a box', size: '1024x1024' }),
    })

    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.headers.get('x-request-id'), 'upstream-ok')
    assert.deepStrictEqual(await response.json(), { created: 123, data: [{ b64_json: 'aW1hZ2U=' }] })
    assert.strictEqual(captured.length, 1)
    assert.strictEqual(captured[0].url, '/v1/images/generations?trace=1')
    assert.strictEqual(captured[0].authorization, 'Bearer upstream-secret')
    assert.deepStrictEqual(captured[0].json, {
      model: 'upstream-image-model',
      prompt: 'draw a box',
      size: '1024x1024',
    })
  })

  it('edit 保留 multipart 文件并只重写 model 字段', async () => {
    captured.length = 0
    const imageBytes = [137, 80, 78, 71, ...Buffer.from('name="model"\r\n\r\nnot-the-form-field')]
    const form = new FormData()
    form.set('image', new File([Uint8Array.from(imageBytes)], 'input.png', { type: 'image/png' }))
    form.set('model', 'client-image-model')
    form.set('prompt', 'make it blue')

    const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/amztracker/v1/images/edits`, {
      method: 'POST',
      headers: { authorization: 'Bearer proxy-secret' },
      body: form,
    })

    assert.strictEqual(response.status, 200)
    assert.strictEqual(captured.length, 1)
    assert.strictEqual(captured[0].url, '/v1/images/edits')
    assert.strictEqual(captured[0].authorization, 'Bearer upstream-secret')
    assert.ok(captured[0].contentType?.startsWith('multipart/form-data; boundary='))
    assert.deepStrictEqual(captured[0].form, {
      model: 'upstream-image-model',
      prompt: 'make it blue',
      imageName: 'input.png',
      imageType: 'image/png',
      imageBytes,
    })
  })

  it('缺少代理密钥时在访问上游前返回 401', async () => {
    captured.length = 0
    const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/amztracker/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'client-image-model', prompt: 'draw' }),
    })
    assert.strictEqual(response.status, 401)
    assert.strictEqual(captured.length, 0)
  })

  it('generation 非法 JSON 返回 400', async () => {
    captured.length = 0
    const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/amztracker/v1/images/generations`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer proxy-secret',
        'content-type': 'application/json',
      },
      body: 'not-json',
    })
    assert.strictEqual(response.status, 400)
    assert.strictEqual(captured.length, 0)
  })

  it('edit 非 multipart 请求返回 400', async () => {
    captured.length = 0
    const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/amztracker/v1/images/edits`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer proxy-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'client-image-model' }),
    })
    assert.strictEqual(response.status, 400)
    assert.strictEqual(captured.length, 0)
  })

  it('未知 adapter 模型返回 404', async () => {
    captured.length = 0
    const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/amztracker/v1/images/generations`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer proxy-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'missing-model', prompt: 'draw' }),
    })
    assert.strictEqual(response.status, 404)
    assert.strictEqual(captured.length, 0)
  })

  it('完整透传上游 4xx 状态、响应体和请求 ID', async () => {
    const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/amztracker/v1/images/generations`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer proxy-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'client-image-model', prompt: 'rate-limit' }),
    })
    assert.strictEqual(response.status, 429)
    assert.strictEqual(response.headers.get('x-request-id'), 'upstream-429')
    assert.deepStrictEqual(await response.json(), { error: { message: 'slow down' } })
  })
})
