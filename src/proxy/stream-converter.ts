import type { ServerResponse } from 'node:http'
import type { Logger } from '../log/logger.js'
import type { CaptureBuffer } from './capture.js'
import { createHash } from 'node:crypto'

export interface StreamUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface Accumulator {
  role: string
  content: string
  thinkingSignature: string
  toolCalls: Map<number, { id?: string; type?: string; function?: { name?: string; arguments: string } }>
}

function newAccumulator(): Accumulator {
  return { role: 'assistant', content: '', thinkingSignature: '', toolCalls: new Map() }
}

function ts(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`
}

/** 从 thinking 内容生成确定性伪签名 */
function makeSignature(thinkingText: string): string {
  return createHash('sha256').update(thinkingText).digest('hex').slice(0, 16)
}

// --- Anthropic SSE → OpenAI SSE ---

export async function convertAnthropicStreamToOpenAI(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: ServerResponse,
  logger?: Logger,
  capture?: CaptureBuffer,
  pairId?: number
): Promise<StreamUsage | null> {
  const decoder = new TextDecoder()
  const acc = newAccumulator()
  let buffer = ''
  let totalChunks = 0
  let thinkingChunks: string[] = []
  let rawLines: string[] = []
  let outLines: string[] = []
  let anthropicUsage: Record<string, unknown> = {}
  let thinkingText = ''
  let reasoningSignature = ''

  const write = (data: Record<string, unknown>): void => {
    const line = JSON.stringify(data)
    outLines.push(`[${ts()}] data: ${line}\n\n`)
    res.write(`data: ${line}\n\n`)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    totalChunks += blocks.length

    for (const block of blocks) {
      if (!block.trim()) continue
      const eventLine = block.split('\n').find((l) => l.startsWith('event: '))
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
      if (!dataLine) continue
      const dataStr = dataLine.slice(6)
      const eventType = eventLine?.slice(7) ?? ''
      let parsed: Record<string, unknown> | undefined
      try { parsed = JSON.parse(dataStr) } catch { continue }
      rawLines.push(`[${ts()}] data: ${dataStr}`)

      const innerType = (parsed?.type as string) ?? ''

      if (eventType === 'ping' || innerType === 'ping') continue
      if (eventType === 'error' || innerType === 'error') {
        write({ choices: [{ delta: { content: `\n\n[代理错误: 上游返回错误]` }, finish_reason: 'error', index: 0 }] })
        continue
      }

      if (eventType === 'message_start' || innerType === 'message_start') {
        write({ choices: [{ delta: { role: 'assistant' }, index: 0 }] })
        continue
      }

      if (innerType === 'content_block_start') {
        const cblock = parsed?.content_block as Record<string, unknown> | undefined
        if (cblock?.type === 'tool_use') {
          const index = (parsed?.index as number) ?? acc.toolCalls.size
          acc.toolCalls.set(index, { id: cblock.id as string, type: 'function', function: { name: cblock.name as string, arguments: '' } })
          write({ choices: [{ delta: { tool_calls: [{ index, id: cblock.id as string, type: 'function', function: { name: cblock.name as string, arguments: '' } }] }, index: 0 }] })
        }
        continue
      }

      if (innerType === 'content_block_delta') {
        const delta = parsed?.delta as Record<string, unknown> | undefined
        if (!delta) continue
        const deltaType = delta.type as string

        if (deltaType === 'text_delta') {
          acc.content += (delta.text as string) ?? ''
          write({ choices: [{ delta: { content: delta.text as string }, index: 0 }] })
        } else if (deltaType === 'input_json_delta') {
          const index = (parsed?.index as number) ?? 0
          const tc = acc.toolCalls.get(index)
          const partial = (delta.partial_json as string) ?? ''
          if (tc?.function) tc.function.arguments += partial
          write({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: partial } }] }, index: 0 }] })
        } else if (deltaType === 'thinking_delta') {
          const chunk = (delta.thinking as string) ?? ''
          thinkingChunks.push(chunk)
          thinkingText += chunk
          acc.content += chunk
          write({ choices: [{ delta: { reasoning_content: chunk }, index: 0 }] })
        } else if (deltaType === 'signature_delta') {
          reasoningSignature += (delta.signature as string) ?? ''
          acc.thinkingSignature += (delta.signature as string) ?? ''
        }
        continue
      }

      if (innerType === 'content_block_stop') continue

      if (eventType === 'message_delta' || innerType === 'message_delta') {
        const msgDelta = parsed?.delta as Record<string, unknown> | undefined
        const msgUsage = parsed?.usage as Record<string, unknown> | undefined
        if (msgUsage) anthropicUsage = msgUsage
        const stopReason = msgDelta?.stop_reason as string | undefined
        if (stopReason) {
          const finishMap: Record<string, string> = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls' }
          const finish = finishMap[stopReason] ?? stopReason
          const chunk: Record<string, unknown> = { choices: [{ delta: {}, finish_reason: finish, index: 0 }] }
          if (Object.keys(anthropicUsage).length > 0) {
            const usage: Record<string, unknown> = {
              prompt_tokens: anthropicUsage.input_tokens ?? 0,
              completion_tokens: anthropicUsage.output_tokens ?? 0,
              total_tokens: ((anthropicUsage.input_tokens as number) ?? 0) + ((anthropicUsage.output_tokens as number) ?? 0),
            }
            const promptDetails = (anthropicUsage.prompt_tokens_details ?? anthropicUsage.prompt_cache_details) as Record<string, unknown> | undefined
            if (promptDetails?.cached_tokens != null) usage.prompt_tokens_details = { cached_tokens: promptDetails.cached_tokens }
            if (anthropicUsage.prompt_cache_miss_tokens != null) usage.prompt_cache_miss_tokens = anthropicUsage.prompt_cache_miss_tokens
            ;(chunk as Record<string, unknown>).usage = usage
          }
          write(chunk)
        }
        continue
      }

      if (eventType === 'message_stop' || innerType === 'message_stop') continue
    }
  }

  if (acc.thinkingSignature) {
    write({ choices: [{ delta: { reasoning_signature: acc.thinkingSignature }, index: 0 }] })
  }
  res.write('data: [DONE]\n\n')
  res.end()

  logger?.log('request', `流式响应完成 (Anthropic→OpenAI)`, {
    chunks: totalChunks,
    textLength: acc.content.length - thinkingText.length,
    thinkingLength: thinkingText.length,
    thinkingChunks: thinkingChunks.length > 0 ? thinkingChunks : undefined,
    toolCalls: acc.toolCalls.size,
    textPreview: acc.content.slice(0, 200),
    thinkingPreview: thinkingText.slice(0, 200),
    rawLines: rawLines.length > 0 ? rawLines : undefined,
    outLines: outLines.length > 0 ? outLines : undefined,
  }, 'debug')

  if (capture && pairId !== undefined) {
    const sseIn = rawLines.join('\n\n')
    capture.updateRequest(pairId, 'responseIn', sseIn)
    capture.updateRequest(pairId, 'responseOut', outLines.join(''))
  }

  if (Object.keys(anthropicUsage).length > 0) {
    return {
      input_tokens: (anthropicUsage.input_tokens ?? 0) as number,
      output_tokens: (anthropicUsage.output_tokens ?? 0) as number,
      cache_read_input_tokens: anthropicUsage.cache_read_input_tokens as number | undefined,
      cache_creation_input_tokens: anthropicUsage.cache_creation_input_tokens as number | undefined,
    }
  }
  return null
}

// --- OpenAI SSE → Anthropic SSE ---

export async function convertOpenAIStreamToAnthropic(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: ServerResponse,
  logger?: Logger,
  capture?: CaptureBuffer,
  pairId?: number
): Promise<StreamUsage | null> {
  const decoder = new TextDecoder()
  let buffer = ''
  let totalText = ''
  let totalChunks = 0
  let thinkingSignature = ''
  let thinkingBlockStarted = false
  let thinkingBlockIndex = -1
  let thinkingText = ''
  let thinkingChunks: string[] = []
  let rawLines: string[] = []
  let outLines: string[] = []
  let lastUsage: Record<string, unknown> = {}

  const writeEvent = (eventType: string, data: Record<string, unknown>): void => {
    const json = JSON.stringify(data)
    outLines.push(`[${ts()}] event: ${eventType}\ndata: ${json}\n\n`)
    res.write(`event: ${eventType}\ndata: ${json}\n\n`)
  }

  let contentBlockIndex = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const dataStr = line.slice(6).trim()
      if (dataStr === '[DONE]') {
        writeEvent('message_stop', { type: 'message_stop' })
        res.end()
        logger?.log('request', `流式响应完成 (OpenAI→Anthropic)`, {
          chunks: totalChunks,
          textLength: totalText.length - thinkingText.length,
          thinkingLength: thinkingText.length,
          thinkingChunks: thinkingChunks.length > 0 ? thinkingChunks : undefined,
          rawLines: rawLines.length > 0 ? rawLines : undefined,
          outLines: outLines.length > 0 ? outLines : undefined,
          textPreview: totalText.slice(0, 200),
          thinkingPreview: thinkingText.slice(0, 200),
        }, 'debug')

        if (capture && pairId !== undefined) {
          const sseIn = rawLines.join('\n\n')
          capture.updateRequest(pairId, 'responseIn', sseIn)
          capture.updateRequest(pairId, 'responseOut', outLines.join(''))
        }

        if (Object.keys(lastUsage).length > 0) {
          return {
            input_tokens: (lastUsage.input_tokens ?? 0) as number,
            output_tokens: (lastUsage.output_tokens ?? 0) as number,
            cache_read_input_tokens: lastUsage.cache_read_input_tokens as number | undefined,
            cache_creation_input_tokens: lastUsage.cache_creation_input_tokens as number | undefined,
          }
        }
        return null
      }

      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(dataStr) } catch { continue }
      rawLines.push(`[${ts()}] data: ${dataStr}`)

      const choices = parsed.choices as Array<Record<string, unknown>> | undefined
      if (!choices || choices.length === 0) continue
      const choice = choices[0]
      const delta = choice.delta as Record<string, unknown> | undefined
      const finishReason = choice.finish_reason as string | undefined

      // On first message: thinking (index=0) + text (index=1) per Anthropic spec
      if (delta?.role === 'assistant') {
        writeEvent('message_start', {
          type: 'message_start',
          message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', content: [], model: '', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
        })
        contentBlockIndex = 1
        thinkingBlockIndex = 0
        thinkingBlockStarted = true
        writeEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
        writeEvent('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
        continue
      }

      // Tool call start
      const toolCalls = delta?.tool_calls as Array<Record<string, unknown>> | undefined
      if (toolCalls && toolCalls.length > 0) {
        const tc = toolCalls[0]
        if (tc.id && tc.type === 'function') {
          contentBlockIndex++
          const fn = tc.function as Record<string, unknown> | undefined
          writeEvent('content_block_start', { type: 'content_block_start', index: contentBlockIndex, content_block: { type: 'tool_use', id: tc.id, name: fn?.name ?? '', input: {} } })
          writeEvent('content_block_delta', { type: 'content_block_delta', index: contentBlockIndex, delta: { type: 'input_json_delta', partial_json: (fn?.arguments as string) ?? '' } })
        } else if (tc.function && (tc.function as Record<string, unknown>).arguments) {
          writeEvent('content_block_delta', { type: 'content_block_delta', index: contentBlockIndex, delta: { type: 'input_json_delta', partial_json: (tc.function as Record<string, unknown>).arguments as string } })
        }
        continue
      }

      // reasoning_signature → signature_delta
      if (delta?.reasoning_signature) {
        thinkingSignature += delta.reasoning_signature as string
        writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: delta.reasoning_signature as string } })
        continue
      }

      // reasoning_content → thinking_delta
      if (delta?.reasoning_content) {
        const chunk = delta.reasoning_content as string
        thinkingChunks.push(chunk)
        thinkingText += chunk
        writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: chunk } })
        totalText += chunk
        totalChunks++
        continue
      }

      // Regular text delta — close thinking block first per Anthropic spec
      if (delta?.content) {
        if (thinkingBlockStarted) {
          const sig = thinkingSignature || makeSignature(thinkingText)
          if (sig) writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: sig } })
          writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
          thinkingBlockStarted = false
        }
        totalText += delta.content as string
        totalChunks++
        writeEvent('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: delta.content as string } })
        continue
      }

      // Finish reason
      if (finishReason) {
        const chunkUsage = parsed.usage as Record<string, unknown> | undefined
        if (chunkUsage) lastUsage = chunkUsage
        const reasonMap: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' }
        const anthropicReason = reasonMap[finishReason] ?? finishReason
        if (thinkingBlockStarted) {
          const sig = thinkingSignature || makeSignature(thinkingText)
          if (sig) writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: sig } })
          writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
          thinkingBlockStarted = false
        }
        writeEvent('content_block_stop', { type: 'content_block_stop', index: contentBlockIndex })
        const usage: Record<string, unknown> = {
          input_tokens: (lastUsage.prompt_tokens ?? lastUsage.input_tokens ?? 0) as number,
          output_tokens: (lastUsage.completion_tokens ?? lastUsage.output_tokens ?? 0) as number,
        }
        const promptDetails = (lastUsage.prompt_tokens_details ?? lastUsage.prompt_cache_details) as Record<string, unknown> | undefined
        if (promptDetails?.cached_tokens != null) usage.cache_read_input_tokens = promptDetails.cached_tokens
        if (lastUsage.prompt_cache_miss_tokens != null) usage.cache_creation_input_tokens = lastUsage.prompt_cache_miss_tokens
        writeEvent('message_delta', { type: 'message_delta', delta: { stop_reason: anthropicReason, stop_sequence: null }, usage })
        lastUsage = usage
        continue
      }
    }
  }

  res.end()
  return null
}

// --- OpenAI Responses SSE → Anthropic SSE ---

export async function convertOpenAIResponsesStreamToAnthropic(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: ServerResponse,
  logger?: Logger,
  capture?: CaptureBuffer,
  pairId?: number
): Promise<StreamUsage | null> {
  const decoder = new TextDecoder()
  const acc = newAccumulator()
  let buffer = ''
  let totalChunks = 0
  let currentBlockIndex = 0
  let currentBlockType = ''
  let thinkingBlockStarted = false
  let thinkingText = ''
  let thinkingSignature = ''
  let thinkingChunks: string[] = []
  let rawLines: string[] = []
  let outLines: string[] = []
  let lastUsage: StreamUsage | null = null
  let responsesHasToolCalls = false

  const writeEvent = (eventType: string, data: Record<string, unknown>): void => {
    const json = JSON.stringify(data)
    outLines.push(`[${ts()}] event: ${eventType}\ndata: ${json}\n\n`)
    res.write(`event: ${eventType}\ndata: ${json}\n\n`)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    totalChunks += blocks.length

    for (const block of blocks) {
      if (!block.trim()) continue
      const eventLine = block.split('\n').find((l) => l.startsWith('event: '))
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
      if (!dataLine) continue
      const eventType = eventLine?.slice(7) ?? ''
      const dataStr = dataLine.slice(6)

      let parsed: Record<string, unknown> | undefined
      try { parsed = JSON.parse(dataStr) } catch { continue }
      rawLines.push(`[${ts()}] data: ${dataStr}`)

      const innerType = (parsed?.type as string) ?? ''

      if (innerType === 'response.created' || innerType === 'response.in_progress') continue

      // output_item.added — message
      if (innerType === 'response.output_item.added') {
        const item = parsed?.item as Record<string, unknown> | undefined
        if (item?.type === 'message') {
          currentBlockIndex = 1
          currentBlockType = 'text'
          writeEvent('message_start', {
            type: 'message_start',
            message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', content: [], model: '', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
          })
          thinkingBlockStarted = true
          writeEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
          writeEvent('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
        } else if (item?.type === 'function_call') {
          currentBlockIndex++
          currentBlockType = 'tool_use'
          responsesHasToolCalls = true
          acc.toolCalls.set(currentBlockIndex, { id: item.call_id as string, type: 'function', function: { name: item.name as string, arguments: '' } })
          writeEvent('content_block_start', {
            type: 'content_block_start', index: currentBlockIndex,
            content_block: { type: 'tool_use', id: item.call_id, name: item.name, input: {} },
          })
        }
        continue
      }

      if (innerType === 'response.content_part.added') {
        const part = parsed?.part as Record<string, unknown> | undefined
        if (part?.type === 'output_text') currentBlockType = 'text'
        continue
      }

      // output_text.delta → text_delta
      if (innerType === 'response.output_text.delta') {
        const delta = parsed?.delta as string | undefined
        if (delta) {
          if (thinkingBlockStarted) {
          const sig = thinkingSignature || makeSignature(thinkingText)
          if (sig) writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: sig } })
            writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
            thinkingBlockStarted = false
          }
          acc.content += delta
          writeEvent('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: delta } })
        }
        continue
      }

      // output_text.done
      if (innerType === 'response.output_text.done') {
        if (thinkingBlockStarted) {
          const sig = thinkingSignature || makeSignature(thinkingText)
          if (sig) writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: sig } })
          writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
          thinkingBlockStarted = false
        }
        writeEvent('content_block_stop', { type: 'content_block_stop', index: 1 })
        continue
      }

      // reasoning_text.delta → thinking_delta
      if (innerType === 'response.reasoning_text.delta') {
        const delta = parsed?.delta as string | undefined
        if (delta) {
          thinkingChunks.push(delta)
          thinkingText += delta
          if (!thinkingBlockStarted) {
            writeEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
            thinkingBlockStarted = true
            currentBlockType = 'thinking'
          }
          writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: delta } })
        }
        continue
      }

      // reasoning_text.done
      if (innerType === 'response.reasoning_text.done') {
        if (thinkingBlockStarted) {
          const sig = thinkingSignature || makeSignature(thinkingText)
          if (sig) writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: sig } })
          writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
          thinkingBlockStarted = false
        }
        continue
      }

      // function_call_arguments.delta
      if (innerType === 'response.function_call_arguments.delta') {
        const delta = parsed?.delta as string | undefined
        if (delta) {
          writeEvent('content_block_delta', { type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'input_json_delta', partial_json: delta } })
        }
        continue
      }

      if (innerType === 'response.function_call_arguments.done') {
        writeEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex })
        continue
      }

      // response.completed
      if (innerType === 'response.completed' || eventType === 'response.completed') {
        const resp = parsed?.response as Record<string, unknown> | undefined
        const status = (resp?.status as string) ?? 'completed'
        const statusMap: Record<string, string> = { completed: 'end_turn', incomplete: 'max_tokens' }
        let stopReason = statusMap[status] ?? 'end_turn'
        // If function_calls were emitted, stop_reason should be "tool_use"
        if (responsesHasToolCalls) stopReason = 'tool_use'
        const respUsage = resp?.usage as Record<string, unknown> | undefined

        const usage: Record<string, unknown> = {
          input_tokens: (respUsage?.input_tokens ?? 0) as number,
          output_tokens: (respUsage?.output_tokens ?? 0) as number,
        }
        lastUsage = {
          input_tokens: usage.input_tokens as number,
          output_tokens: usage.output_tokens as number,
        }

        if (thinkingBlockStarted) {
          const sig = thinkingSignature || makeSignature(thinkingText)
          if (sig) writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: sig } })
          writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
          thinkingBlockStarted = false
        }
        writeEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex })
        writeEvent('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage })
        writeEvent('message_stop', { type: 'message_stop' })
        res.end()

        logger?.log('request', `流式响应完成 (Responses→Anthropic)`, {
          chunks: totalChunks,
          textLength: acc.content.length,
          thinkingLength: thinkingText.length,
          thinkingChunks: thinkingChunks.length > 0 ? thinkingChunks : undefined,
          rawLines: rawLines.length > 0 ? rawLines : undefined,
          outLines: outLines.length > 0 ? outLines : undefined,
          textPreview: acc.content.slice(0, 200),
          thinkingPreview: thinkingText.slice(0, 200),
        }, 'debug')

        if (capture && pairId !== undefined) {
          const sseIn = rawLines.join('\n\n')
          capture.updateRequest(pairId, 'responseIn', sseIn)
          capture.updateRequest(pairId, 'responseOut', outLines.join(''))
        }

        return lastUsage
      }
    }
  }

  writeEvent('message_stop', { type: 'message_stop' })
  res.end()
  return lastUsage
}

// --- Anthropic SSE → OpenAI Responses SSE ---

let _respIdCounter = 0
function respId(): string { return `resp_${Date.now().toString(36)}_${(_respIdCounter++).toString(36)}` }
let _msgIdCounter = 0
function msgId(): string { return `msg_${Date.now().toString(36)}_${(_msgIdCounter++).toString(36)}` }

export async function convertAnthropicStreamToOpenAIResponses(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: ServerResponse,
  logger?: Logger,
  capture?: CaptureBuffer,
  pairId?: number
): Promise<StreamUsage | null> {
  const decoder = new TextDecoder()
  const acc = newAccumulator()
  let buffer = ''
  let totalChunks = 0
  let currentBlockIndex = 0
  let currentBlockType = ''
  let fnCallId = ''
  let fnCallName = ''
  let currentRespId = ''
  let currentMsgId = ''
  let completed = false
  let thinkingText = ''
  let thinkingChunks: string[] = []
  let rawLines: string[] = []
  let outLines: string[] = []
  let anthropicUsage: Record<string, unknown> = {}

  const makeUsage = (u: Record<string, unknown>): StreamUsage | null => {
    if (Object.keys(u).length > 0) {
      return {
        input_tokens: (u.input_tokens ?? 0) as number,
        output_tokens: (u.output_tokens ?? 0) as number,
        cache_read_input_tokens: u.cache_read_input_tokens as number | undefined,
        cache_creation_input_tokens: u.cache_creation_input_tokens as number | undefined,
      }
    }
    return null
  }

  const writeRaw = (data: string): void => {
    outLines.push(`[${ts()}] ${data}`)
    res.write(data)
  }

  const processBlock = (block: string): boolean => {
    if (!block.trim()) return false
    const eventLine = block.split('\n').find((l) => l.startsWith('event: '))
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
    if (!dataLine) return false
    const eventType = eventLine?.slice(7) ?? ''
    const dataStr = dataLine.slice(6)

    let parsed: Record<string, unknown> | undefined
    try { parsed = JSON.parse(dataStr) } catch { return false }
    rawLines.push(`[${ts()}] data: ${dataStr}`)

    const innerType = (parsed?.type as string) ?? ''

    if (eventType === 'ping' || innerType === 'ping') return false

    if (eventType === 'message_start' || innerType === 'message_start') {
      currentRespId = respId()
      currentMsgId = msgId()
      writeRaw(`event: response.created\ndata: {"type":"response.created","response":{"id":"${currentRespId}","object":"response","status":"in_progress","output":[]}}\n\n`)
      writeRaw(`event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"${currentRespId}","object":"response","status":"in_progress","output":[]}}\n\n`)
      writeRaw(`event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"${currentMsgId}","status":"in_progress","role":"assistant","content":[]}}\n\n`)
      writeRaw(`event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n`)
      currentBlockIndex = 0
      currentBlockType = 'text'
      return false
    }

    if (innerType === 'content_block_start') {
      const cblock = parsed?.content_block as Record<string, unknown> | undefined
      if (cblock?.type === 'tool_use') {
        currentBlockIndex++
        currentBlockType = 'tool_use'
        fnCallId = (cblock.id as string) ?? ''
        fnCallName = (cblock.name as string) ?? ''
        writeRaw(`event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":${currentBlockIndex},"item":{"type":"function_call","id":"fc_${fnCallId}","call_id":"${fnCallId}","name":"${fnCallName}","arguments":""}}\n\n`)
      }
      return false
    }

    if (innerType === 'content_block_delta') {
      const delta = parsed?.delta as Record<string, unknown> | undefined
      if (!delta) return false
      const deltaType = delta.type as string

      if (deltaType === 'text_delta') {
        const text = (delta.text as string) ?? ''
        acc.content += text
        writeRaw(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":${JSON.stringify(text)}}\n\n`)
      } else if (deltaType === 'input_json_delta') {
        const partialJson = (delta.partial_json as string) ?? ''
        writeRaw(`event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":${currentBlockIndex},"delta":${JSON.stringify(partialJson)}}\n\n`)
      } else if (deltaType === 'thinking_delta') {
        const chunk = (delta.thinking as string) ?? ''
        thinkingChunks.push(chunk)
        thinkingText += chunk
        acc.content += chunk
        // Don't stream reasoning to Responses client - it doesn't track reasoning for passthrough
      }
      return false
    }

    if (innerType === 'content_block_stop') {
      if (currentBlockType === 'text') {
        writeRaw(`event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":${JSON.stringify(acc.content)}}\n\n`)
      } else if (currentBlockType === 'tool_use') {
        writeRaw(`event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","output_index":${currentBlockIndex},"arguments":""}\n\n`)
      }
      return false
    }

    if (eventType === 'message_delta' || innerType === 'message_delta') {
      const msgUsage = parsed?.usage as Record<string, unknown> | undefined
      if (msgUsage) anthropicUsage = msgUsage
      return false
    }

    if (eventType === 'message_stop' || innerType === 'message_stop') {
      const respData: Record<string, unknown> = { id: currentRespId, object: 'response', status: 'completed', output: [] }
      if (Object.keys(anthropicUsage).length > 0) {
        respData.usage = { input_tokens: anthropicUsage.input_tokens ?? 0, output_tokens: anthropicUsage.output_tokens ?? 0, total_tokens: ((anthropicUsage.input_tokens as number) ?? 0) + ((anthropicUsage.output_tokens as number) ?? 0) }
      }
      writeRaw('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: respData }) + '\n\n')
      res.end()
      logger?.log('request', `流式响应完成 (Anthropic→Responses)`, {
        chunks: totalChunks,
        textLength: acc.content.length - thinkingText.length,
        thinkingLength: thinkingText.length,
        thinkingChunks: thinkingChunks.length > 0 ? thinkingChunks : undefined,
        rawLines: rawLines.length > 0 ? rawLines : undefined,
        outLines: outLines.length > 0 ? outLines : undefined,
        textPreview: acc.content.slice(0, 200),
        thinkingPreview: thinkingText.slice(0, 200),
      }, 'debug')

      if (capture && pairId !== undefined) {
        const sseIn = rawLines.join('\n\n')
        capture.updateRequest(pairId, 'responseIn', sseIn)
        capture.updateRequest(pairId, 'responseOut', outLines.join(''))
      }

      return true
    }

    return false
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      if (buffer.trim()) {
        const shouldEnd = processBlock(buffer.trim())
        if (shouldEnd) { completed = true; return makeUsage(anthropicUsage) }
      }
      break
    }
    buffer += decoder.decode(value, { stream: true })

    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    totalChunks += blocks.length

    for (const block of blocks) {
      const shouldEnd = processBlock(block)
      if (shouldEnd) { completed = true; return makeUsage(anthropicUsage) }
    }
  }

  if (!completed) {
    if (currentRespId) {
      const respData: Record<string, unknown> = { id: currentRespId, object: 'response', status: 'completed', output: [] }
      if (Object.keys(anthropicUsage).length > 0) {
        respData.usage = { input_tokens: anthropicUsage.input_tokens ?? 0, output_tokens: anthropicUsage.output_tokens ?? 0, total_tokens: ((anthropicUsage.input_tokens as number) ?? 0) + ((anthropicUsage.output_tokens as number) ?? 0) }
      }
      writeRaw('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: respData }) + '\n\n')
    }
    res.end()
  }

  return makeUsage(anthropicUsage)
}

// --- OpenAI Chat SSE → OpenAI Responses SSE ---

export async function convertOpenAIStreamToOpenAIResponses(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: ServerResponse,
  logger?: Logger,
  capture?: CaptureBuffer,
  pairId?: number
): Promise<StreamUsage | null> {
  const decoder = new TextDecoder()
  let buffer = ''
  let totalChunks = 0
  let rawLines: string[] = []
  let outLines: string[] = []
  let lastUsage: Record<string, unknown> = {}
  let textContent = ''
  let thinkingText = ''

  let currentRespId = ''
  let currentMsgId = ''
  let messageStarted = false
  let currentBlockType = 'text'
  let currentBlockIndex = 0
  let fnCallId = ''
  let fnCallName = ''
  let fnCallArgsAcc = ''        // accumulated args from deltas
  let outputItems: Record<string, unknown>[] = [] // accumulated for response.completed

  const writeRaw = (data: string): void => {
    outLines.push(`[${ts()}] ${data}`)
    res.write(data)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const dataStr = line.slice(6).trim()
      if (dataStr === '[DONE]') {
        // If output_items not yet emitted (no finish_reason before [DONE]), emit them now
        if (outputItems.length === 0 && messageStarted) {
          const msgContent: unknown[] = []
          if (thinkingText) {
            // Don't include reasoning in Responses output - Responses clients don't track reasoning for passthrough
          }
          if (textContent) {
            msgContent.push({ type: 'output_text', text: textContent, annotations: [] })
          }
          writeRaw(`event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"${currentMsgId}","type":"message","status":"completed","role":"assistant","content":${JSON.stringify(msgContent)}}}\n\n`)
          outputItems.unshift({ type: 'message', id: currentMsgId, status: 'completed', role: 'assistant', content: msgContent })
        }
        // Close any open text block
        if (messageStarted && currentBlockType === 'text') {
          writeRaw(`event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":${JSON.stringify(textContent)}}\n\n`)
        }
        // Emit completed
        const respData: Record<string, unknown> = { id: currentRespId, object: 'response', status: 'completed', output: outputItems.length > 0 ? outputItems : [] }
        if (Object.keys(lastUsage).length > 0) {
          respData.usage = { input_tokens: lastUsage.input_tokens ?? 0, output_tokens: lastUsage.output_tokens ?? 0, total_tokens: ((lastUsage.input_tokens as number) ?? 0) + ((lastUsage.output_tokens as number) ?? 0) }
        }
        writeRaw('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: respData }) + '\n\n')
        res.end()

        logger?.log('request', `流式响应完成 (OpenAI→Responses)`, {
          chunks: totalChunks,
          textLength: textContent.length,
          thinkingLength: thinkingText.length,
          rawLines: rawLines.length > 0 ? rawLines : undefined,
          outLines: outLines.length > 0 ? outLines : undefined,
          textPreview: textContent.slice(0, 200),
          thinkingPreview: thinkingText.slice(0, 200),
        }, 'debug')

        if (capture && pairId !== undefined) {
          const sseIn = rawLines.join('\n\n')
          capture.updateRequest(pairId, 'responseIn', sseIn)
          capture.updateRequest(pairId, 'responseOut', outLines.join(''))
        }

        if (Object.keys(lastUsage).length > 0) {
          return {
            input_tokens: (lastUsage.input_tokens ?? 0) as number,
            output_tokens: (lastUsage.output_tokens ?? 0) as number,
          }
        }
        return null
      }

      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(dataStr) } catch { continue }
      rawLines.push(`[${ts()}] data: ${dataStr}`)
      totalChunks++

      const choices = parsed.choices as Array<Record<string, unknown>> | undefined
      if (!choices || choices.length === 0) continue
      const choice = choices[0]
      const delta = choice.delta as Record<string, unknown> | undefined
      const finishReason = choice.finish_reason as string | undefined
      const chunkUsage = parsed.usage as Record<string, unknown> | undefined

      // First message with role → init Responses stream
      if (delta?.role === 'assistant' && !messageStarted) {
        messageStarted = true
        currentRespId = respId()
        currentMsgId = msgId()
        writeRaw(`event: response.created\ndata: {"type":"response.created","response":{"id":"${currentRespId}","object":"response","status":"in_progress","output":[]}}\n\n`)
        writeRaw(`event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"${currentRespId}","object":"response","status":"in_progress","output":[]}}\n\n`)
        writeRaw(`event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"${currentMsgId}","status":"in_progress","role":"assistant","content":[]}}\n\n`)
        writeRaw(`event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n`)
        currentBlockIndex = 0
        currentBlockType = 'text'
        continue
      }

      if (!messageStarted) continue

      // reasoning_content → skip (Responses client doesn't track reasoning for passthrough)
      if (delta?.reasoning_content) {
        // Still track thinkingText for output_item.done stats but don't stream to client
        const chunk = delta.reasoning_content as string
        thinkingText += chunk
        continue
      }

      // tool_calls start
      if (delta?.tool_calls) {
        const tc = (delta.tool_calls as Array<Record<string, unknown>>)[0]
        if (tc.id && tc.type === 'function') {
          currentBlockIndex++
          currentBlockType = 'tool_use'
          fnCallId = tc.id as string
          fnCallName = ((tc.function as Record<string, unknown>)?.name as string) ?? ''
          const fnArgs = ((tc.function as Record<string, unknown>)?.arguments as string) ?? ''
          fnCallArgsAcc = fnArgs  // Initialize accumulator with initial arguments
          writeRaw(`event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":${currentBlockIndex},"item":{"type":"function_call","id":"fc_${fnCallId}","call_id":"${fnCallId}","name":"${fnCallName}","arguments":${JSON.stringify(fnArgs)}}}\n\n`)
        } else if (tc.function && (tc.function as Record<string, unknown>).arguments) {
          const partialArgs = (tc.function as Record<string, unknown>).arguments as string
          fnCallArgsAcc += partialArgs
          writeRaw(`event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":${currentBlockIndex},"delta":${JSON.stringify(partialArgs)}}\n\n`)
        }
        continue
      }

      // text content
      if (delta?.content) {
        const chunk = delta.content as string
        textContent += chunk
        writeRaw(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":${JSON.stringify(chunk)}}\n\n`)
        continue
      }

      // Finish reason
      if (finishReason) {
        if (chunkUsage) lastUsage = { input_tokens: chunkUsage.prompt_tokens ?? 0, output_tokens: chunkUsage.completion_tokens ?? 0 }
        // Close text block
        writeRaw(`event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":${JSON.stringify(textContent)}}\n\n`)
        // Close function_call block if any
        if (currentBlockType === 'tool_use') {
          writeRaw(`event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","output_index":${currentBlockIndex},"arguments":${JSON.stringify(fnCallArgsAcc)}}\n\n`)
          // Emit response.output_item.done for the function_call
          writeRaw(`event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":${currentBlockIndex},"item":{"type":"function_call","id":"fc_${fnCallId}","call_id":"${fnCallId}","name":"${fnCallName}","arguments":${JSON.stringify(fnCallArgsAcc)},"status":"completed"}}\n\n`)
          // Record for response.completed output
          outputItems.push({
            type: 'function_call', id: `fc_${fnCallId}`, call_id: fnCallId,
            name: fnCallName, arguments: fnCallArgsAcc, status: 'completed',
          })
        }
        // Emit response.output_item.done for the message
        const msgContent: unknown[] = []
        // Don't include reasoning in Responses output
        if (textContent) {
          msgContent.push({ type: 'output_text', text: textContent, annotations: [] })
        }
        writeRaw(`event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"${currentMsgId}","type":"message","status":"completed","role":"assistant","content":${JSON.stringify(msgContent)}}}\n\n`)
        outputItems.unshift({
          type: 'message', id: currentMsgId, status: 'completed', role: 'assistant', content: msgContent,
        })
        continue
      }
    }
  }

  // Emit completed if not already
  if (messageStarted) {
    if (outputItems.length === 0) {
      const msgContent: unknown[] = []
      // Don't include reasoning in Responses output
      if (textContent) {
        msgContent.push({ type: 'output_text', text: textContent, annotations: [] })
      }
      writeRaw(`event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"${currentMsgId}","type":"message","status":"completed","role":"assistant","content":${JSON.stringify(msgContent)}}}\n\n`)
      outputItems.unshift({ type: 'message', id: currentMsgId, status: 'completed', role: 'assistant', content: msgContent })
    }
    writeRaw(`event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":${JSON.stringify(textContent)}}\n\n`)
    const respData: Record<string, unknown> = { id: currentRespId, object: 'response', status: 'completed', output: outputItems.length > 0 ? outputItems : [] }
    if (Object.keys(lastUsage).length > 0) {
      respData.usage = { input_tokens: lastUsage.input_tokens ?? 0, output_tokens: lastUsage.output_tokens ?? 0, total_tokens: ((lastUsage.input_tokens as number) ?? 0) + ((lastUsage.output_tokens as number) ?? 0) }
    }
    writeRaw('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: respData }) + '\n\n')
  }
  res.end()

  if (Object.keys(lastUsage).length > 0) {
    return { input_tokens: (lastUsage.input_tokens ?? 0) as number, output_tokens: (lastUsage.output_tokens ?? 0) as number }
  }
  return null
}

// --- OpenAI Responses SSE → OpenAI Chat SSE ---

export async function convertOpenAIResponsesStreamToOpenAI(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: ServerResponse,
  logger?: Logger,
  capture?: CaptureBuffer,
  pairId?: number
): Promise<StreamUsage | null> {
  const decoder = new TextDecoder()
  let buffer = ''
  let totalChunks = 0
  let rawLines: string[] = []
  let outLines: string[] = []
  let lastUsage: Record<string, unknown> = {}
  let thinkingText = ''

  let currentFnCallIndex = -1
  let hasFunctionCalls = false
  let firstFnCallOutputIndex = -1

  const write = (data: Record<string, unknown>): void => {
    const line = JSON.stringify(data)
    outLines.push(`[${ts()}] data: ${line}\n\n`)
    res.write(`data: ${line}\n\n`)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    totalChunks += blocks.length

    for (const block of blocks) {
      if (!block.trim()) continue
      const eventLine = block.split('\n').find((l) => l.startsWith('event: '))
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
      if (!dataLine) continue
      const eventType = eventLine?.slice(7) ?? ''
      const dataStr = dataLine.slice(6)

      let parsed: Record<string, unknown> | undefined
      try { parsed = JSON.parse(dataStr) } catch { continue }
      rawLines.push(`[${ts()}] data: ${dataStr}`)

      const innerType = (parsed?.type as string) ?? ''

      if (innerType === 'response.created' || innerType === 'response.in_progress') continue

      // output_item.added → role delta + tool_calls start
      if (innerType === 'response.output_item.added') {
        const item = parsed?.item as Record<string, unknown> | undefined
        if (item?.type === 'message') {
          write({ choices: [{ delta: { role: 'assistant' }, index: 0 }] })
        } else if (item?.type === 'function_call') {
          currentFnCallIndex = ((parsed?.output_index as number) ?? 1) - 1
          if (!hasFunctionCalls) {
            hasFunctionCalls = true
            firstFnCallOutputIndex = (parsed?.output_index as number) ?? 1
          }
          write({ choices: [{ delta: { tool_calls: [{ index: currentFnCallIndex, id: item?.call_id ?? item?.id, type: 'function', function: { name: item?.name ?? '', arguments: (item?.arguments as string) ?? '' } }] }, index: 0 }] })
        }
        continue
      }

      // output_text.delta → content delta
      if (innerType === 'response.output_text.delta') {
        const delta = parsed?.delta as string | undefined
        if (delta) {
          write({ choices: [{ delta: { content: delta }, index: 0 }] })
        }
        continue
      }

      // reasoning_text.delta → reasoning_content delta
      if (innerType === 'response.reasoning_text.delta') {
        const delta = parsed?.delta as string | undefined
        if (delta) {
          thinkingText += delta
          write({ choices: [{ delta: { reasoning_content: delta }, index: 0 }] })
        }
        continue
      }

      // output_text.done - nothing to emit for Chat format
      if (innerType === 'response.output_text.done') continue

      // function_call_arguments.delta
      if (innerType === 'response.function_call_arguments.delta') {
        const delta = parsed?.delta as string | undefined
        if (delta) {
          write({ choices: [{ delta: { tool_calls: [{ index: currentFnCallIndex >= 0 ? currentFnCallIndex : 0, function: { arguments: delta } }] }, index: 0 }] })
        }
        continue
      }

      if (innerType === 'response.function_call_arguments.done') continue

      // response.completed → finish_reason + usage + [DONE]
      if (innerType === 'response.completed') {
        const resp = parsed?.response as Record<string, unknown> | undefined
        const status = (resp?.status as string) ?? 'completed'
        const statusMap: Record<string, string> = { completed: 'stop', incomplete: 'length' }
        let finishReason = statusMap[status] ?? 'stop'
        // If function_calls were emitted, finish_reason should be "tool_calls"
        if (hasFunctionCalls) finishReason = 'tool_calls'
        const respUsage = resp?.usage as Record<string, unknown> | undefined

        const finalChunk: Record<string, unknown> = {
          choices: [{ delta: {}, finish_reason: finishReason, index: 0 }],
        }
        if (respUsage) {
          lastUsage = {
            input_tokens: (respUsage.input_tokens ?? 0) as number,
            output_tokens: (respUsage.output_tokens ?? 0) as number,
          }
          finalChunk.usage = {
            prompt_tokens: respUsage.input_tokens ?? 0,
            completion_tokens: respUsage.output_tokens ?? 0,
            total_tokens: ((respUsage.input_tokens as number) ?? 0) + ((respUsage.output_tokens as number) ?? 0),
          }
        }
        write(finalChunk)
        res.write('data: [DONE]\n\n')
        res.end()

        logger?.log('request', `流式响应完成 (Responses→OpenAI)`, {
          chunks: totalChunks,
          thinkingLength: thinkingText.length,
          rawLines: rawLines.length > 0 ? rawLines : undefined,
          outLines: outLines.length > 0 ? outLines : undefined,
          thinkingPreview: thinkingText.slice(0, 200),
        }, 'debug')

        if (capture && pairId !== undefined) {
          const sseIn = rawLines.join('\n\n')
          capture.updateRequest(pairId, 'responseIn', sseIn)
          capture.updateRequest(pairId, 'responseOut', outLines.join(''))
        }

        return Object.keys(lastUsage).length > 0 ? { input_tokens: (lastUsage.input_tokens ?? 0) as number, output_tokens: (lastUsage.output_tokens ?? 0) as number } : null
      }
    }
  }

  res.write('data: [DONE]\n\n')
  res.end()
  return Object.keys(lastUsage).length > 0 ? { input_tokens: (lastUsage.input_tokens ?? 0) as number, output_tokens: (lastUsage.output_tokens ?? 0) as number } : null
}
