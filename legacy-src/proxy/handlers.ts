import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PipelineContext } from './pipeline.js'
import { parseAndAuth, forwardPipeline } from './pipeline.js'
import { routeModel } from './router.js'

export async function handleAnthropicMessages(
  ctx: PipelineContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  await handleRequest(ctx, req, res, 'anthropic', '/v1/messages')
}

export async function handleOpenAIChat(
  ctx: PipelineContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  await handleRequest(ctx, req, res, 'openai', '/v1/chat/completions')
}

export async function handleOpenAIResponses(
  ctx: PipelineContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  await handleRequest(ctx, req, res, 'openai-responses', '/v1/responses')
}

async function handleRequest(
  ctx: PipelineContext,
  req: IncomingMessage,
  res: ServerResponse,
  inboundType: 'anthropic' | 'openai' | 'openai-responses',
  logLabel: string
): Promise<void> {
  const pre = await parseAndAuth(req, res, ctx.store, ctx.logger, logLabel)
  if (!pre) return

  let route
  try {
    route = routeModel(ctx.store, pre.modelName)
  } catch (err) {
    ctx.logger.log('request', `Model not found: ${pre.modelName}`, { model: pre.modelName, type: inboundType }, 'warn')
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      error: { message: err instanceof Error ? err.message : String(err) },
    }))
    return
  }

  await forwardPipeline(ctx, req, res, pre.body, pre.rawBody, route, inboundType, logLabel)
}
