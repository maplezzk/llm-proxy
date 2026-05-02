import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerContext } from '../server.js'
import { readBody, getDefaultApiBase } from '../../lib/http-utils.js'
import { resolveAdapterRoute, AdapterError } from '../../adapter/router.js'
import { json } from './index.js'
import { t } from '../../lib/i18n.js'

const API_KEY_PATTERN = /sk-[a-zA-Z0-9-]+/g

function sanitizeError(msg: string): string {
  return msg.replace(API_KEY_PATTERN, 'sk-***')
}

export async function handleTestModel(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    json(res, 400, { success: false, error: '请求体不是有效 JSON' })
    return
  }

  const _type = body.type
  const type = typeof _type === 'string' ? _type : undefined
  const _apiKey = body.api_key ?? body.apiKey
  const rawApiKey = typeof _apiKey === 'string' ? _apiKey : undefined
  let apiKey = rawApiKey
  if (apiKey === '***' || !apiKey) {
    const providerName = body.providerName as string | undefined
    if (providerName) {
      const { config } = ctx.store.getConfig()
      const provider = config.providers.find((p) => p.name === providerName)
      if (provider?.apiKey) apiKey = provider.apiKey
    }
  }
  const apiBase = typeof (body.api_base ?? body.apiBase) === 'string' ? (body.api_base ?? body.apiBase) as string : undefined
  const model = typeof body.model === 'string' ? body.model : undefined

  if (!type || !apiKey || !model) {
    json(res, 400, { success: false, error: '缺少必填字段: type, api_key, model' })
    return
  }

  ctx.logger.log('system', 'Model test request received', { type, model, providerName: body.providerName })

  if (type !== 'openai' && type !== 'anthropic' && type !== 'openai-responses') {
    json(res, 400, { success: false, error: 'type 必须为 openai、anthropic 或 openai-responses' })
    return
  }

  const useResponses = (type === 'openai-responses') || (type === 'openai' && body.endpoint === 'responses')

  const baseUrl = apiBase || getDefaultApiBase(type)
  let url: string
  if (type === 'anthropic') {
    url = `${baseUrl}/v1/messages`
  } else if (useResponses) {
    url = `${baseUrl}/v1/responses`
  } else {
    url = `${baseUrl}/v1/chat/completions`
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (type === 'anthropic') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const requestBody = type === 'anthropic'
    ? { model, messages: [{ role: 'user' as const, content: 'hi' }], max_tokens: 10 }
    : useResponses
      ? { model, input: 'hi' }
      : { model, messages: [{ role: 'user' as const, content: 'hi' }] }

  const startTime = Date.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(15000),
    })

    const latency = Date.now() - startTime
    const reachable = response.ok

    let error: string | undefined
    if (!reachable) {
      const text = await response.text().catch(() => '')
      error = sanitizeError(`HTTP ${response.status}: ${text.slice(0, 200)}`)
    }

    const providerName = (body.providerName as string) || ''
    ctx.logger.log('system', 'Model test', { type, model, reachable, latency, provider: providerName }, reachable ? 'info' : 'warn')
    json(res, 200, { success: true, data: { reachable, latency, model, error } })
  } catch (err) {
    const latency = Date.now() - startTime
    const message = sanitizeError(err instanceof Error ? err.message : String(err))
    ctx.logger.log('system', 'Model test failed', { type, model, latency, error: message }, 'error')
    json(res, 200, { success: true, data: { reachable: false, latency, model, error: message } })
  }
}

export async function handleTestAdapter(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    json(res, 400, { success: false, error: '请求体不是有效 JSON' })
    return
  }

  const adapterName = typeof body.adapterName === 'string' ? body.adapterName : ''
  const modelId = typeof body.modelId === 'string' ? body.modelId : ''

  if (!adapterName || !modelId) {
    json(res, 400, { success: false, error: '缺少必填字段: adapterName, modelId' })
    return
  }

  ctx.logger.log('system', 'Adapter test request received', { adapter: adapterName, model: modelId })

  let route
  try {
    route = resolveAdapterRoute(ctx.store, adapterName, modelId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = err instanceof AdapterError ? err.code : 'UNKNOWN'
    ctx.logger.log('system', 'Adapter test route resolution failed', { adapter: adapterName, model: modelId, error: message, code }, 'warn')
    json(res, 400, { success: false, error: message })
    return
  }

  const type = route.inboundType
  const providerType = route.route.providerType
  const baseUrl = route.route.apiBase
  const targetModel = route.route.modelId
  const url = providerType === 'anthropic'
    ? `${baseUrl}/v1/messages`
    : `${baseUrl}/v1/chat/completions`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (providerType === 'anthropic') {
    headers['x-api-key'] = route.route.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers['Authorization'] = `Bearer ${route.route.apiKey}`
  }

  const requestBody = providerType === 'anthropic'
    ? { model: targetModel, messages: [{ role: 'user' as const, content: 'hi' }], max_tokens: 10 }
    : { model: targetModel, messages: [{ role: 'user' as const, content: 'hi' }] }

  const startTime = Date.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(15000),
    })

    const latency = Date.now() - startTime
    const reachable = response.ok

    let error: string | undefined
    if (!reachable) {
      const text = await response.text().catch(() => '')
      error = sanitizeError(`HTTP ${response.status}: ${text.slice(0, 200)}`)
    }

    ctx.logger.log('system', 'Adapter test', {
      adapter: adapterName,
      model: modelId,
      targetModel,
      provider: route.route.providerName,
      reachable,
      latency,
    }, reachable ? 'info' : 'warn')
    json(res, 200, { success: true, data: { reachable, latency, model: modelId, error } })
  } catch (err) {
    const latency = Date.now() - startTime
    const message = sanitizeError(err instanceof Error ? err.message : String(err))
    ctx.logger.log('system', 'Adapter test failed', { adapter: adapterName, model: modelId, targetModel, provider: route.route.providerName, latency, error: message }, 'error')
    json(res, 200, { success: true, data: { reachable: false, latency, model: modelId, error: message } })
  }
}

export function handleListModels(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  const { config } = ctx.store.getConfig()
  const now = Math.floor(Date.now() / 1000)
  const models: { id: string; object: string; created: number; owned_by: string }[] = []
  for (const provider of config.providers) {
    for (const model of provider.models) {
      models.push({ id: model.id, object: 'model', created: now, owned_by: provider.name })
    }
  }
  json(res, 200, { object: 'list', data: models })
}

const PULL_MODELS_PATH_RE = /^\/admin\/providers\/([a-zA-Z0-9_-]+)\/pull-models$/

export async function handlePullModels(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const match = req.url?.match(PULL_MODELS_PATH_RE)
  if (!match) { json(res, 404, { success: false, error: '无效路径' }); return }
  const providerName = match[1]

  const body = JSON.parse(await readBody(req).catch(() => '{}'))
  const { config } = ctx.store.getConfig()
  const provider = config.providers.find((p) => p.name === providerName)

  const type = typeof body.type === 'string' ? body.type : provider?.type
  const apiKey = (typeof body.api_key === 'string' && body.api_key) ? body.api_key : (provider?.apiKey ?? '')
  const apiBase = typeof body.api_base === 'string' ? body.api_base : (provider?.apiBase ?? (type ? getDefaultApiBase(type) : ''))

  if (!type || !apiKey) {
    json(res, 400, { success: false, error: '缺少 type 或 api_key' })
    return
  }

  ctx.logger.log('system', 'Model pull request received', { provider: providerName, type, apiBase })

  const headers: Record<string, string> = {}
  if (type === 'anthropic') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const url = `${apiBase}/v1/models`

  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      json(res, 400, { success: false, error: sanitizeError(`上游返回 ${response.status}: ${text.slice(0, 200)}`) })
      return
    }

    const remoteBody = await response.json() as { data?: unknown[] }
    const rawModels = (remoteBody.data ?? []) as Record<string, unknown>[]

    const existingSet = new Set((provider?.models ?? []).map((m) => m.id))

    let models: { id: string; description: string | null }[]
    if (type === 'anthropic') {
      models = rawModels
        .filter((m) => m.type === 'model')
        .map((m) => ({ id: String(m.id ?? ''), description: m.display_name ? String(m.display_name) : null }))
        .filter((m) => m.id)
    } else {
      models = rawModels.map((m) => ({ id: String(m.id ?? ''), description: m.owned_by ? String(m.owned_by) : null }))
    }

    const existing = models.filter((m) => existingSet.has(m.id)).map((m) => m.id)

    ctx.logger.log('system', 'Remote models pulled', { provider: providerName, count: models.length, existing: existing.length })
    json(res, 200, { success: true, data: { models, existing } })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.log('system', 'Remote model pull failed', { provider: providerName, error: message }, 'error')
    json(res, 400, { success: false, error: sanitizeError(message) })
  }
}
