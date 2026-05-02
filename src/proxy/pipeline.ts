import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConfigStore } from '../config/store.js'
import type { Logger } from '../log/logger.js'
import type { TokenTracker } from '../status/token-tracker.js'
import type { CaptureBuffer } from './capture.js'
import type { StatusTracker } from '../status/tracker.js'
import type { RouterResult } from './types.js'
import type { InboundType } from './translation.js'
import { readBody } from '../lib/http-utils.js'
import { transformInboundRequest } from './translation.js'
import { forwardRequest } from './provider.js'

export interface ParseResult {
  body: Record<string, unknown>
  rawBody: string
  modelName: string
}

/**
 * 解析请求 Body、JSON 解析、代理认证、提取 model。
 * 成功返回 { body, rawBody, modelName }，失败直接写响应并返回 null。
 */
export async function parseAndAuth(
  req: IncomingMessage,
  res: ServerResponse,
  store: ConfigStore,
  logger: Logger,
  logLabel: string,
  maxBodyBytes?: number
): Promise<ParseResult | null> {
  // 1. 读取 Body（含大小限制）
  const effectiveMaxBytes = maxBodyBytes ?? store.getConfig().config.maxBodySize ?? 10_000_000
  let rawBody: string
  try {
    rawBody = await readBody(req, effectiveMaxBytes)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('超过大小限制')) {
      logger.log('request', `${logLabel} 请求体超限`, { logLabel }, 'warn')
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '请求体超过大小限制' } }))
      return null
    }
    logger.log('request', `${logLabel} 读取请求体失败`, { logLabel, error: message }, 'warn')
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '读取请求体失败' } }))
    return null
  }

  // 2. JSON 解析
  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody)
  } catch {
    logger.log('request', `${logLabel} 入站 JSON 解析失败`, { rawBody: rawBody.slice(0, 200) }, 'warn')
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '请求体不是有效的 JSON' } }))
    return null
  }

  // 3. 代理认证
  const { config } = store.getConfig()
  if (config.proxyKey) {
    const auth = req.headers['authorization'] ?? req.headers['x-api-key'] ?? ''
    const key = String(auth).replace(/^Bearer\s+/i, '').trim()
    if (key !== config.proxyKey) {
      logger.log('request', `${logLabel} 认证失败`, { auth: key ? 'sk-***' : '(空)' }, 'warn')
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '代理 API Key 无效' } }))
      return null
    }
  }

  // 4. 提取 model
  const modelName = body.model as string | undefined
  if (!modelName) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '请求缺少 model 字段' } }))
    return null
  }

  return { body, rawBody, modelName }
}

/** 流水线上下文——与 ServerContext/ProxyContext 结构相同 */
export interface PipelineContext {
  store: ConfigStore
  tracker: StatusTracker
  logger: Logger
  tokenTracker: TokenTracker
  capture?: CaptureBuffer
}

/**
 * 执行代理转发流水线：transformInboundRequest → forwardRequest → capture → token 统计 → 计时。
 * 响应由 forwardRequest 直接写入 res。
 */
export async function forwardPipeline(
  ctx: PipelineContext,
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  rawBody: string,
  route: RouterResult,
  inboundType: InboundType,
  logLabel: string,
  /** 适配器名称（适配器请求时传入） */
  adapterName?: string
): Promise<void> {
  const isStream = body.stream === true
  const startTime = Date.now()
  const modelName = String(body.model ?? '')

  ctx.logger.log('request', `入站: ${logLabel}`, {
    type: inboundType,
    model: body.model,
    stream: isStream,
  }, 'debug')

  try {
    const upstream = await transformInboundRequest(inboundType, route, body, ctx.logger)

    let pairId: number | undefined
    if (ctx.capture) {
      const source = adapterName ?? 'proxy'
      pairId = ctx.capture.startRequest(source, inboundType, modelName, {
        adapterName,
        upstreamProvider: route.providerName,
        upstreamProtocol: route.providerType,
        upstreamModel: route.modelId,
      })
      ctx.capture.updateRequest(pairId, 'requestIn', rawBody)
      ctx.capture.updateRequest(pairId, 'requestOut', JSON.stringify(upstream.body))
    }

    await forwardRequest(
      {
        url: upstream.url,
        method: 'POST',
        headers: upstream.headers,
        body: upstream.body,
        crossProtocol: upstream.crossProtocol,
        inboundType,
        upstreamType: route.providerType,
        logger: ctx.logger,
        tokenTracker: ctx.tokenTracker,
        providerName: route.providerName,
        capture: ctx.capture,
        pairId,
      },
      res
    )

    const latency = Date.now() - startTime
    ctx.tracker.recordRequest(route.providerName, latency, true)
    ctx.logger.log('request', `${logLabel} 完成 → ${route.providerName}/${route.providerType}`, {
      model: modelName,
      modelId: route.modelId,
      provider: route.providerName,
      type: inboundType,
      crossProtocol: upstream.crossProtocol,
      stream: isStream,
      latency,
      tokenUsage: ctx.tokenTracker.getStats().today,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.tracker.recordRequest(route.providerName, 0, false)
    ctx.logger.log('request', `${logLabel} 失败 → ${route.providerName}`, {
      model: modelName,
      provider: route.providerName,
      type: inboundType,
      error: message,
    }, 'error')
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message } }))
    }
  }
}
