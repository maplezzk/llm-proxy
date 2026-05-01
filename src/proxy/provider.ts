import type { ServerResponse } from 'node:http'
import { convertAnthropicStreamToOpenAI, convertOpenAIStreamToAnthropic, convertOpenAIResponsesStreamToAnthropic, convertAnthropicStreamToOpenAIResponses, convertOpenAIStreamToOpenAIResponses, convertOpenAIResponsesStreamToOpenAI, type StreamUsage } from './stream-converter.js'
import { convertOpenAIResponseToAnthropic, convertAnthropicResponseToOpenAI, convertOpenAIResponsesToAnthropic, convertAnthropicResponseToOpenAIResponses, convertOpenAIResponseToOpenAIResponses, convertOpenAIResponsesResponseToOpenAI } from './translation.js'
import type { Logger } from '../log/logger.js'
import type { TokenTracker } from '../status/token-tracker.js'

import type { CaptureBuffer } from './capture.js'

interface ProviderRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
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

function maskUrl(url: string): string {
  return url.replace(/\/\/[^@]+@/, '//***@')
}

function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    h[k] = k.toLowerCase() === 'authorization'
      ? v.replace(/Bearer\s+\S+/i, 'Bearer sk-***')
      : k.toLowerCase() === 'x-api-key'
        ? 'sk-***'
        : v
  }
  return h
}

function truncateObj(obj: Record<string, unknown>, maxLen = 500): Record<string, unknown> {
  const json = JSON.stringify(obj)
  if (json.length <= maxLen) return obj
  const truncated: Record<string, unknown> = { __truncated: `${json.length}b > ${maxLen}b limit` }
  if (obj.usage) truncated.usage = obj.usage
  if (obj.stop_reason) truncated.stop_reason = obj.stop_reason
  return truncated
}

function generateCurlCommand(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): string {
  const parts: string[] = ['curl']
  if (method !== 'GET') parts.push(`-X ${method}`)
  for (const [key, val] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    let safeVal = val
    if (lower === 'authorization') safeVal = 'Bearer sk-***'
    else if (lower === 'x-api-key') safeVal = 'sk-***'
    parts.push(`-H '${key}: ${safeVal}'`)
  }
  const bodyStr = JSON.stringify(body)
  parts.push(`-d '${bodyStr.slice(0, 500)}'`)
  parts.push(`'${maskUrl(url)}'`)
  return parts.join(' \\\n  ')
}

export async function forwardRequest(
  req: ProviderRequest,
  res: ServerResponse,
): Promise<void> {
  const isStream = req.body.stream === true
  const needsConversion = req.crossProtocol && isStream
  const bodyStr = JSON.stringify(req.body)

  const curl = generateCurlCommand(req.method, req.url, req.headers, req.body)
  req.logger?.log('request', `上游请求: ${req.method} ${maskUrl(req.url)}`, {
    method: req.method,
    url: maskUrl(req.url),
    headers: maskHeaders(req.headers),
    body: req.body,
    bodySize: bodyStr.length,
    crossProtocol: req.crossProtocol,
    stream: isStream,
  }, 'debug', curl)

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
        responseBody: errorBody,
      }, 'warn', curl)
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
          const inputTokens = (usage.input_tokens ?? usage.prompt_tokens ?? 0) as number
          const outputTokens = (usage.output_tokens ?? usage.completion_tokens ?? 0) as number
          const details = usage.prompt_tokens_details as Record<string, unknown> | undefined
          const cacheRead = (usage.cache_read_input_tokens ?? details?.cached_tokens) as number | undefined
          const cacheCreate = (usage.cache_creation_input_tokens ?? usage.prompt_cache_miss_tokens) as number | undefined
          req.tokenTracker.record(req.providerName, inputTokens, outputTokens, cacheRead, cacheCreate)
        }
      }

      // Record capture
      req.capture?.updateRequest(req.pairId!, 'responseIn', text)

      req.logger?.log('request', `上游响应: ${response.status}`, {
        status: response.status,
        url: maskUrl(req.url),
        body: parsed ?? text,
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
          usage = await convertAnthropicStreamToOpenAI(reader, res, req.logger, req.capture, req.pairId)
        } else if (req.inboundType === 'openai-responses') {
          usage = await convertAnthropicStreamToOpenAIResponses(reader, res, req.logger, req.capture, req.pairId)
        }
      } else if (req.upstreamType === 'openai') {
        if (req.inboundType === 'anthropic') {
          usage = await convertOpenAIStreamToAnthropic(reader, res, req.logger, req.capture, req.pairId)
        } else if (req.inboundType === 'openai-responses') {
          usage = await convertOpenAIStreamToOpenAIResponses(reader, res, req.logger, req.capture, req.pairId)
        }
      } else { // openai-responses
        if (req.inboundType === 'anthropic') {
          usage = await convertOpenAIResponsesStreamToAnthropic(reader, res, req.logger, req.capture, req.pairId)
        } else if (req.inboundType === 'openai') {
          usage = await convertOpenAIResponsesStreamToOpenAI(reader, res, req.logger, req.capture, req.pairId)
        }
      }
      // Record token usage from streaming response
      if (usage && req.tokenTracker && req.providerName) {
        req.tokenTracker.record(req.providerName, usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens)
      }
    } else {
      const contentType = response.headers.get('content-type') ?? 'text/event-stream'
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })

      const chunks: string[] = []
      const decoder = new TextDecoder()
      const pump = async (): Promise<void> => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            res.end()
            return
          }
          const chunk = decoder.decode(value, { stream: true })
          chunks.push(chunk)
          res.write(value)
        }
      }
      await pump()
      if (req.capture && req.pairId !== undefined) {
        req.capture.updateRequest(req.pairId, 'responseIn', chunks.join(''))
        req.capture.updateRequest(req.pairId, 'responseOut', chunks.join(''))
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    req.logger?.log('request', `上游请求异常`, { url: maskUrl(req.url), error: message }, 'error', curl)
    if (!res.headersSent) {
      writeJson(res, 502, { error: { message: `上游请求失败: ${message}` } })
    }
    throw err
  }
}
