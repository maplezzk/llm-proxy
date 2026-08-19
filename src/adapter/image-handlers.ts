import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { maskUrl, sanitizeApiBase } from '../lib/http-utils.js'
import type { PipelineContext } from '../proxy/pipeline.js'
import { AdapterError, resolveAdapterRoute } from './router.js'

const ADAPTER_IMAGE_PATH_RE = /^\/([a-zA-Z0-9_-]+)\/v1\/images\/(generations|edits)(\?.*)?$/
const HEADER_SEPARATOR = Buffer.from('\r\n\r\n')
const LINE_SEPARATOR = Buffer.from('\r\n')

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(body))
}

function authenticateProxyRequest(
  ctx: PipelineContext,
  req: IncomingMessage,
  res: ServerResponse,
  logLabel: string
): boolean {
  const { config } = ctx.store.getConfig()
  if (!config.proxyKey) return true

  const auth = req.headers.authorization ?? req.headers['x-api-key'] ?? ''
  const key = String(auth).replace(/^Bearer\s+/i, '').trim()
  if (key === config.proxyKey) return true

  ctx.logger.log('request', `${logLabel} auth failed`, { auth: key ? 'sk-***' : '(empty)' }, 'warn')
  writeJson(res, 401, { error: { message: '代理 API Key 无效' } })
  return false
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function multipartBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)
  return match?.[1] ?? match?.[2] ?? null
}

function findMultipartField(
  rawBody: Buffer,
  boundary: string,
  fieldName: string
): { start: number; end: number } | null {
  const delimiter = Buffer.from(`--${boundary}`)
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`)
  let cursor = 0

  while (cursor < rawBody.length) {
    const delimiterStart = rawBody.indexOf(delimiter, cursor)
    if (delimiterStart < 0) return null

    let headerStart = delimiterStart + delimiter.length
    if (rawBody.subarray(headerStart, headerStart + 2).equals(Buffer.from('--'))) return null
    if (rawBody.subarray(headerStart, headerStart + 2).equals(LINE_SEPARATOR)) headerStart += 2

    const headerEnd = rawBody.indexOf(HEADER_SEPARATOR, headerStart)
    if (headerEnd < 0) return null
    const valueStart = headerEnd + HEADER_SEPARATOR.length
    const valueEnd = rawBody.indexOf(nextDelimiter, valueStart)
    if (valueEnd < 0) return null

    const headers = rawBody.subarray(headerStart, headerEnd).toString('latin1')
    const disposition = headers.split('\r\n').find((line) => /^content-disposition:/i.test(line))
    if (disposition?.match(new RegExp(`(?:^|;)\\s*name="${fieldName}"(?:;|$)`, 'i'))) {
      return { start: valueStart, end: valueEnd }
    }

    cursor = valueEnd + LINE_SEPARATOR.length
  }

  return null
}

function readMultipartField(rawBody: Buffer, boundary: string, fieldName: string): string | null {
  const range = findMultipartField(rawBody, boundary, fieldName)
  return range ? rawBody.subarray(range.start, range.end).toString('utf8') : null
}

function rewriteMultipartField(rawBody: Buffer, boundary: string, fieldName: string, value: string): Buffer | null {
  const range = findMultipartField(rawBody, boundary, fieldName)
  if (!range) return null
  return Buffer.concat([
    rawBody.subarray(0, range.start),
    Buffer.from(value, 'utf8'),
    rawBody.subarray(range.end),
  ])
}

function adapterErrorStatus(error: unknown): number {
  if (!(error instanceof AdapterError)) return 502
  return error.code === 'ADAPTER_NOT_FOUND' || error.code === 'MODEL_MAPPING_NOT_FOUND' ? 404 : 502
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': response.headers.get('content-type') ?? 'application/json',
    'Access-Control-Allow-Origin': '*',
  }
  for (const name of ['x-request-id', 'ah-request-id', 'openai-processing-ms', 'retry-after']) {
    const value = response.headers.get(name)
    if (value) headers[name] = value
  }
  return headers
}

async function relayResponse(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, responseHeaders(response))
  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) await once(res, 'drain')
    }
    res.end()
  } finally {
    reader.releaseLock()
  }
}

export async function handleAdapterImageRequest(
  ctx: PipelineContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const match = req.url?.match(ADAPTER_IMAGE_PATH_RE)
  if (!match) {
    writeJson(res, 404, { error: { message: '无效的适配器图片路径' } })
    return
  }

  const adapterName = match[1]
  const operation = match[2] as 'generations' | 'edits'
  const query = match[3] ?? ''
  const logLabel = `/${adapterName}/images/${operation}`
  if (!authenticateProxyRequest(ctx, req, res, logLabel)) return

  let rawBody: Buffer
  try {
    rawBody = await readRawBody(req)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.log('request', `${logLabel} failed to read request body`, { error: message }, 'warn')
    writeJson(res, 400, { error: { message: '读取请求体失败' } })
    return
  }

  let clientModel: string
  let upstreamBody: string | Blob
  let contentType: string
  let boundary: string | null = null

  if (operation === 'generations') {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
    } catch {
      writeJson(res, 400, { error: { message: '请求体不是有效 JSON' } })
      return
    }
    if (typeof body.model !== 'string' || !body.model) {
      writeJson(res, 400, { error: { message: '请求缺少 model 字段' } })
      return
    }
    clientModel = body.model
    upstreamBody = JSON.stringify(body)
    contentType = 'application/json'
  } else {
    contentType = String(req.headers['content-type'] ?? '')
    boundary = multipartBoundary(contentType)
    if (!/^multipart\/form-data;/i.test(contentType) || !boundary) {
      writeJson(res, 400, { error: { message: '图片编辑请求必须使用 multipart/form-data' } })
      return
    }
    const model = readMultipartField(rawBody, boundary, 'model')
    if (!model) {
      writeJson(res, 400, { error: { message: '请求缺少 model 字段' } })
      return
    }
    clientModel = model
    upstreamBody = new Blob([Uint8Array.from(rawBody)])
  }

  let route
  try {
    route = resolveAdapterRoute(ctx.store, adapterName, clientModel, 'openai').route
  } catch (error) {
    const status = adapterErrorStatus(error)
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.log('request', `Adapter image route failed: ${adapterName}`, {
      adapter: adapterName,
      model: clientModel,
      operation,
      error: message,
    }, 'warn')
    writeJson(res, status, { error: { message } })
    return
  }

  if (operation === 'generations') {
    const body = JSON.parse(String(upstreamBody)) as Record<string, unknown>
    body.model = route.modelId
    upstreamBody = JSON.stringify(body)
  } else {
    const rewritten = rewriteMultipartField(rawBody, boundary!, 'model', route.modelId)
    if (!rewritten) {
      writeJson(res, 400, { error: { message: '无法解析 multipart model 字段' } })
      return
    }
    upstreamBody = new Blob([Uint8Array.from(rewritten)])
  }

  const url = `${sanitizeApiBase(route.apiBase)}/v1/images/${operation}${query}`
  const startedAt = Date.now()
  const abortController = new AbortController()
  const abortOnDisconnect = (): void => {
    if (!res.writableEnded) abortController.abort()
  }
  res.once('close', abortOnDisconnect)

  try {
    ctx.logger.log('request', `Image upstream request: POST ${maskUrl(url)}`, {
      adapter: adapterName,
      clientModel,
      upstreamModel: route.modelId,
      provider: route.providerName,
      operation,
      bodySize: typeof upstreamBody === 'string' ? Buffer.byteLength(upstreamBody) : upstreamBody.size,
    }, 'debug')

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${route.apiKey}`,
        Accept: String(req.headers.accept ?? 'application/json'),
        'Content-Type': contentType,
      },
      body: upstreamBody,
      signal: abortController.signal,
    })
    await relayResponse(response, res)

    const latency = Date.now() - startedAt
    ctx.tracker.recordRequest(route.providerName, latency, response.ok)
    ctx.logger.log('request', `${logLabel} done → ${route.providerName}`, {
      adapter: adapterName,
      model: clientModel,
      modelId: route.modelId,
      provider: route.providerName,
      operation,
      status: response.status,
      latency,
    }, response.ok ? 'info' : 'warn')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.tracker.recordRequest(route.providerName, 0, false)
    ctx.logger.log('request', `${logLabel} failed → ${route.providerName}`, {
      adapter: adapterName,
      model: clientModel,
      provider: route.providerName,
      operation,
      error: message,
    }, 'error')
    if (!res.headersSent) writeJson(res, 502, { error: { message } })
  } finally {
    res.off('close', abortOnDisconnect)
  }
}
