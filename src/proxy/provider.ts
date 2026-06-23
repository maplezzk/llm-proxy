import type { ServerResponse } from 'node:http'
import { maskUrl, maskHeaders } from '../lib/http-utils.js'
import { convertAnthropicStreamToOpenAI, convertOpenAIStreamToAnthropic, convertOpenAIResponsesStreamToAnthropic, convertAnthropicStreamToOpenAIResponses, convertOpenAIStreamToOpenAIResponses, convertOpenAIResponsesStreamToOpenAI, type StreamUsage } from './stream-converter.js'
import { convertOpenAIResponseToAnthropic, convertAnthropicResponseToOpenAI, convertOpenAIResponsesToAnthropic, convertAnthropicResponseToOpenAIResponses, convertOpenAIResponseToOpenAIResponses, convertOpenAIResponsesResponseToOpenAI, buildNamespaceToolContext, remapNamespaceFunctionCalls } from './translation.js'
import type { Logger } from '../log/logger.js'
import type { TokenTracker } from '../status/token-tracker.js'

import type { CaptureBuffer } from './capture.js'

interface ProviderRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
  originalBody?: Record<string, unknown>  // Original request body for response post-processing
  crossProtocol: boolean
  inboundType: 'anthropic' | 'openai' | 'openai-responses'
  upstreamType: 'anthropic' | 'openai' | 'openai-responses'
  logger?: Logger
  tokenTracker?: TokenTracker
  providerName?: string
  capture?: CaptureBuffer
  pairId?: number
}

function writeJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(data))
}

/**
 * 直通流式响应：转发的同时解析 SSE 事件提取 token 用量。
 * 支持 Anthropic、OpenAI Chat、OpenAI Responses 三种协议。
 */
async function forwardPassthroughStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: ServerResponse,
  upstreamType: 'anthropic' | 'openai' | 'openai-responses',
  logger?: Logger,
  capture?: CaptureBuffer,
  pairId?: number,
  signal?: AbortSignal
): Promise<StreamUsage | null> {
  const decoder = new TextDecoder()
  let buffer = ''
  let rawChunks: string[] = []
  // 协议专用累计器
  let anthropicUsage: Record<string, unknown> = {}
  let openaiUsage: Record<string, unknown> | null = null

  while (true) {
    if (signal?.aborted) {
      try { await reader.cancel() } catch { /* best effort */ }
      break
    }
    const { done, value } = await reader.read()
    if (done) {
      res.end()
      break
    }
    // 原样转发给客户端
    res.write(value)

    const text = decoder.decode(value, { stream: true })
    rawChunks.push(text)

    // 按协议解析 SSE 事件提取 usage
    if (upstreamType === 'anthropic') {
      buffer += text
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        if (!block.trim()) continue
        const eventLine = block.split('\n').find(l => l.startsWith('event: '))
        const dataLine = block.split('\n').find(l => l.startsWith('data: '))
        if (!dataLine) continue
        const eventType = eventLine?.slice(7) ?? ''
        const dataStr = dataLine.slice(6)
        let parsed: Record<string, unknown> | undefined
        try { parsed = JSON.parse(dataStr) } catch { continue }
        if (eventType === 'message_start') {
          const msgUsage = (parsed?.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined
          if (msgUsage) anthropicUsage = msgUsage
        } else if (eventType === 'message_delta') {
          const msgUsage = parsed?.usage as Record<string, unknown> | undefined
          if (msgUsage) Object.assign(anthropicUsage, msgUsage)
        }
      }
    } else if (upstreamType === 'openai') {
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const parsed = JSON.parse(line.slice(6))
            const chunkUsage = parsed.usage as Record<string, unknown> | undefined
            if (chunkUsage) openaiUsage = chunkUsage
          } catch { /* 忽略解析失败的行 */ }
        }
      }
    } else if (upstreamType === 'openai-responses') {
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.type === 'response.completed') {
              const resp = parsed.response as Record<string, unknown> | undefined
              const respUsage = resp?.usage as Record<string, unknown> | undefined
              if (respUsage) openaiUsage = respUsage
            }
          } catch { /* 忽略解析失败的行 */ }
        }
      }
    }
  }

  // 构造 StreamUsage
  let usage: StreamUsage | null = null
  if (upstreamType === 'anthropic' && Object.keys(anthropicUsage).length > 0) {
    usage = {
      input_tokens: (anthropicUsage.input_tokens ?? 0) as number,
      output_tokens: (anthropicUsage.output_tokens ?? 0) as number,
      cache_read_input_tokens: anthropicUsage.cache_read_input_tokens as number | undefined,
      cache_creation_input_tokens: anthropicUsage.cache_creation_input_tokens as number | undefined,
    }
    logger?.log('request', '直通流式 (Anthropic) token 统计', {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read: usage.cache_read_input_tokens,
      cache_create: usage.cache_creation_input_tokens,
    }, 'debug')
  } else if (upstreamType === 'openai' && openaiUsage) {
    const details = openaiUsage.prompt_tokens_details as Record<string, unknown> | undefined
    usage = {
      input_tokens: (openaiUsage.prompt_tokens ?? openaiUsage.input_tokens ?? 0) as number,
      output_tokens: (openaiUsage.completion_tokens ?? openaiUsage.output_tokens ?? 0) as number,
      cache_read_input_tokens: (details?.cached_tokens ?? openaiUsage.cache_read_input_tokens) as number | undefined,
      cache_creation_input_tokens: (openaiUsage.cache_creation_input_tokens ?? openaiUsage.prompt_cache_miss_tokens) as number | undefined,
    }
    logger?.log('request', '直通流式 (OpenAI Chat) token 统计', {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read: usage.cache_read_input_tokens,
      cache_create: usage.cache_creation_input_tokens,
    }, 'debug')
  } else if (upstreamType === 'openai-responses' && openaiUsage) {
    usage = {
      input_tokens: (openaiUsage.input_tokens ?? 0) as number,
      output_tokens: (openaiUsage.output_tokens ?? 0) as number,
      cache_read_input_tokens: openaiUsage.cache_read_input_tokens as number | undefined,
      cache_creation_input_tokens: openaiUsage.cache_creation_input_tokens as number | undefined,
    }
    logger?.log('request', '直通流式 (OpenAI Responses) token 统计', {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read: usage.cache_read_input_tokens,
      cache_create: usage.cache_creation_input_tokens,
    }, 'debug')
  }

  if (capture && pairId !== undefined) {
    capture.updateRequest(pairId, 'responseIn', rawChunks.join(''))
    capture.updateRequest(pairId, 'responseOut', rawChunks.join(''))
  }

  return usage
}

function truncateObj(obj: Record<string, unknown>, maxLen = 500): Record<string, unknown> {
  const json = JSON.stringify(obj)
  if (json.length <= maxLen) return obj
  const truncated: Record<string, unknown> = { __truncated: `${json.length}b > ${maxLen}b limit` }
  if (obj.usage) truncated.usage = obj.usage
  if (obj.stop_reason) truncated.stop_reason = obj.stop_reason
  return truncated
}

export async function forwardRequest(
  req: ProviderRequest,
  res: ServerResponse,
): Promise<void> {
  const isStream = req.body.stream === true
  const needsConversion = req.crossProtocol && isStream
  const bodyStr = JSON.stringify(req.body)

  req.logger?.log('request', `上游请求: ${req.method} ${maskUrl(req.url)}`, {
    method: req.method,
    url: maskUrl(req.url),
    headers: maskHeaders(req.headers),
    bodySize: bodyStr.length,
    crossProtocol: req.crossProtocol,
    stream: isStream,
  }, 'debug')

  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: {
        ...req.headers,
        'Accept': isStream ? 'text/event-stream' : 'application/json',
      },
      body: bodyStr,
    })

    if (!response.ok) {
      const errorBody = await response.text()
      req.logger?.log('request', `上游返回错误: ${response.status}`, {
        status: response.status,
        url: maskUrl(req.url),
        responseBody: errorBody.slice(0, 500),
      }, 'warn')
      let parsedError: Record<string, unknown>
      try { parsedError = JSON.parse(errorBody) } catch { parsedError = { raw: errorBody } }
      const upstreamError = (parsedError as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`
      throw new Error(`上游 API 错误 (${response.status}): ${upstreamError}`)
    }

    if (!isStream || !response.body) {
      const text = await response.text()
      let parsed: Record<string, unknown> | undefined
      try { parsed = JSON.parse(text) } catch { /* ignore */ }

      // Record token usage from non-streaming response
      if (parsed && req.tokenTracker && req.providerName) {
        const usage = parsed.usage as Record<string, unknown> | undefined
        if (usage) {
          let inputTokens = (usage.input_tokens ?? usage.prompt_tokens ?? 0) as number
          const outputTokens = (usage.output_tokens ?? usage.completion_tokens ?? 0) as number
          const details = usage.prompt_tokens_details as Record<string, unknown> | undefined
          const cacheRead = (usage.cache_read_input_tokens ?? details?.cached_tokens) as number | undefined
          const cacheCreate = (usage.cache_creation_input_tokens ?? usage.prompt_cache_miss_tokens) as number | undefined
          // 归一化：Anthropic 的 input_tokens 是计费部分（不含缓存），统一存为总输入
          if (req.upstreamType === 'anthropic') {
            inputTokens += (cacheRead ?? 0) + (cacheCreate ?? 0)
          }
          req.tokenTracker.record(req.providerName, inputTokens, outputTokens, cacheRead, cacheCreate)
        }
      }

      // Record capture
      req.capture?.updateRequest(req.pairId!, 'responseIn', text)

      req.logger?.log('request', `上游响应: ${response.status}`, {
        status: response.status,
        url: maskUrl(req.url),
        bodySize: text.length,
      })
      let outBody: unknown = text
      if (req.crossProtocol) {
        let converted: Record<string, unknown>
        if (req.upstreamType === 'anthropic') {
          converted = req.inboundType === 'openai-responses'
            ? convertAnthropicResponseToOpenAIResponses(parsed ?? {})
            : convertAnthropicResponseToOpenAI(parsed ?? {})
        } else if (req.upstreamType === 'openai') {
          converted = req.inboundType === 'openai-responses'
            ? convertOpenAIResponseToOpenAIResponses(parsed ?? {})
            : convertOpenAIResponseToAnthropic(parsed ?? {})
        } else { // openai-responses
          converted = req.inboundType === 'openai'
            ? convertOpenAIResponsesResponseToOpenAI(parsed ?? {})
            : convertOpenAIResponsesToAnthropic(parsed ?? {})
        }
        // Post-process: CCX-style namespace remapping (Response → Anthropic only)
        if (req.originalBody && req.inboundType === 'openai-responses') {
          const rawTools = req.originalBody.tools as unknown[] | undefined
          if (rawTools) {
            const namespaceCtx = buildNamespaceToolContext(rawTools)
            if (namespaceCtx.size > 0) {
              const output = converted.output as Array<Record<string, unknown>> | undefined
              if (output) {
                remapNamespaceFunctionCalls(output, namespaceCtx)
              }
            }
          }
        }

        outBody = converted
        req.logger?.log('request', `非流式跨协议转换: ${req.inboundType} ← ${parsed?.model ?? '?'}`, {
          outBody: truncateObj(converted),
        }, 'debug')
        // Record converted response
        req.capture?.updateRequest(req.pairId!, 'responseOut', JSON.stringify(converted))
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify(converted))
        return
      }
      res.writeHead(200, {
        'Content-Type': response.headers.get('content-type') ?? 'application/json',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(text)
      return
    }

    const reader = response.body.getReader()

    // 客户端断连防护：监听 res.close 事件，在客户端提前断开时主动 cancel 上游 reader，
    // 释放上游 HTTP 连接 + 防止 converter 循环持续占用内存。
    // 仅在 res 未由我们自己 end 的情况下触发（避免正常结束时误 cancel）。
    const abortController = new AbortController()
    let clientDisconnected = false
    res.on('close', () => {
      if (!res.writableEnded && !clientDisconnected) {
        clientDisconnected = true
        req.logger?.log('request', `客户端断连，取消上游流`, { url: maskUrl(req.url) }, 'debug')
        abortController.abort()
        reader.cancel().catch(() => { /* best effort */ })
      }
    })

    if (needsConversion) {
      let usage: StreamUsage | null = null
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      if (req.upstreamType === 'anthropic') {
        if (req.inboundType === 'openai') {
          usage = await convertAnthropicStreamToOpenAI(reader, res, req.logger, req.capture, req.pairId, abortController.signal)
        } else if (req.inboundType === 'openai-responses') {
          const originalTools = req.originalBody?.tools as unknown[] | undefined
          usage = await convertAnthropicStreamToOpenAIResponses(reader, res, req.logger, req.capture, req.pairId, originalTools, abortController.signal)
        }
      } else if (req.upstreamType === 'openai') {
        if (req.inboundType === 'anthropic') {
          usage = await convertOpenAIStreamToAnthropic(reader, res, req.logger, req.capture, req.pairId, abortController.signal)
        } else if (req.inboundType === 'openai-responses') {
          const originalTools = req.originalBody?.tools as unknown[] | undefined
          usage = await convertOpenAIStreamToOpenAIResponses(reader, res, req.logger, req.capture, req.pairId, originalTools, abortController.signal)
        }
      } else { // openai-responses
        if (req.inboundType === 'anthropic') {
          usage = await convertOpenAIResponsesStreamToAnthropic(reader, res, req.logger, req.capture, req.pairId, abortController.signal)
        } else if (req.inboundType === 'openai') {
          usage = await convertOpenAIResponsesStreamToOpenAI(reader, res, req.logger, req.capture, req.pairId, abortController.signal)
        }
      }
      // Record token usage from streaming response
      if (usage && req.tokenTracker && req.providerName) {
        let inputTokens = usage.input_tokens
        // 归一化：Anthropic 的 input_tokens 是计费部分（不含缓存），统一存为总输入
        if (req.upstreamType === 'anthropic') {
          inputTokens += (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        }
        req.tokenTracker.record(req.providerName, inputTokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens)
      }
    } else {
      const contentType = response.headers.get('content-type') ?? 'text/event-stream'
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })

      const usage = await forwardPassthroughStream(
        reader, res, req.upstreamType, req.logger, req.capture, req.pairId, abortController.signal
      )
      // Record token usage from passthrough streaming response
      if (usage && req.tokenTracker && req.providerName) {
        let inputTokens = usage.input_tokens
        // 归一化：Anthropic 的 input_tokens 是计费部分（不含缓存），统一存为总输入
        if (req.upstreamType === 'anthropic') {
          inputTokens += (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        }
        req.tokenTracker.record(req.providerName, inputTokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens)
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    req.logger?.log('request', `上游请求异常`, { url: maskUrl(req.url), error: message }, 'error')
    if (!res.headersSent) {
      writeJson(res, 502, { error: { message: `上游请求失败: ${message}` } })
    }
    throw err
  }
}
