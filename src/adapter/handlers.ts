import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PipelineContext } from '../proxy/pipeline.js'
import { resolveAdapterRoute, AdapterError } from './router.js'
import { parseAndAuth, forwardPipeline } from '../proxy/pipeline.js'

const ADAPTER_PATH_RE = /^\/([a-zA-Z0-9_-]+)\/v1\/(messages|chat\/completions|responses)(\?.*)?$/
const ADAPTER_MODELS_PATH_RE = /^\/([a-zA-Z0-9_-]+)\/v1\/models(\?.*)?$/

export async function handleAdapterModels(
  ctx: PipelineContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const match = req.url?.match(ADAPTER_MODELS_PATH_RE)
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '无效路径' } }))
    return
  }
  const adapterName = match[1]
  const { config } = ctx.store.getConfig()
  const adapter = config.adapters?.find((a) => a.name === adapterName)
  if (!adapter) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `适配器 "${adapterName}" 未找到` } }))
    return
  }

  const now = Math.floor(Date.now() / 1000)
  const models = adapter.models.map((m) => ({
    id: m.sourceModelId,
    object: 'model',
    created: now,
    owned_by: adapterName,
  }))
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ object: 'list', data: models }))
}

export async function handleAdapterRequest(
  ctx: PipelineContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const match = req.url?.match(ADAPTER_PATH_RE)
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '无效的适配器路径' } }))
    return
  }

  const adapterName = match[1]
  const pathTypeRaw = match[2]
  const inboundType: 'anthropic' | 'openai' | 'openai-responses' =
    pathTypeRaw === 'messages' ? 'anthropic' : pathTypeRaw === 'responses' ? 'openai-responses' : 'openai'
  const logLabel = `/${adapterName}`

  const pre = await parseAndAuth(req, res, ctx.store, ctx.logger, logLabel)
  if (!pre) return

  let adapterResult
  try {
    adapterResult = resolveAdapterRoute(ctx.store, adapterName, pre.modelName)
  } catch (err) {
    const status = err instanceof AdapterError
      ? (err.code === 'ADAPTER_NOT_FOUND' || err.code === 'MODEL_MAPPING_NOT_FOUND' ? 404 : 502)
      : 502
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.log('request', `Adapter route failed: ${adapterName}`, { adapter: adapterName, model: pre.modelName, error: message }, 'warn')
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message } }))
    return
  }

  await forwardPipeline(ctx, req, res, pre.body, pre.rawBody, adapterResult.route, inboundType, logLabel, adapterName)
}
