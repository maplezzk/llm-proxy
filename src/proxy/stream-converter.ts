import type { ServerResponse } from 'node:http'
import type { Logger } from '../log/logger.js'
import type { CaptureBuffer } from './capture.js'
import { createHash } from 'node:crypto'
import { convertActionToAnthropic, convertActionToOpenAI, buildNamespaceToolContext, remapNamespaceFunctionCalls } from './translation.js'

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
        const message = parsed?.message as Record<string, unknown> | undefined
        const msgUsage = message?.usage as Record<string, unknown> | undefined
        if (msgUsage) anthropicUsage = msgUsage
        write({ choices: [{ delta: { role: 'assistant', reasoning_content: '' }, index: 0 }] })
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
        if (msgUsage) Object.assign(anthropicUsage, msgUsage)
        const stopReason = msgDelta?.stop_reason as string | undefined
        if (stopReason) {
          const finishMap: Record<string, string> = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls' }
          const finish = finishMap[stopReason] ?? stopReason
          const chunk: Record<string, unknown> = { choices: [{ delta: {}, finish_reason: finish, index: 0 }] }
          if (Object.keys(anthropicUsage).length > 0) {
            // Anthropic input_tokens = 计费 token（不含缓存命中），
            // OpenAI prompt_tokens = 总输入 token（含缓存命中）
            const ai = (anthropicUsage.input_tokens as number) ?? 0
            const cr = (anthropicUsage.cache_read_input_tokens as number) ?? 0
            const co = (anthropicUsage.output_tokens as number) ?? 0
            const promptTokens = ai + cr
            const usage: Record<string, unknown> = {
              prompt_tokens: promptTokens,
              completion_tokens: co,
              total_tokens: promptTokens + co,
            }
            const promptDetails = (anthropicUsage.prompt_tokens_details ?? anthropicUsage.prompt_cache_details) as Record<string, unknown> | undefined
            const promptDetailsOut: Record<string, unknown> = {}
            if (promptDetails?.cached_tokens != null) {
              promptDetailsOut.cached_tokens = promptDetails.cached_tokens
            } else if (cr > 0) {
              promptDetailsOut.cached_tokens = cr
            }
            if (anthropicUsage.cache_creation_input_tokens != null) {
              promptDetailsOut.cache_creation_input_tokens = anthropicUsage.cache_creation_input_tokens
            }
            if (Object.keys(promptDetailsOut).length > 0) usage.prompt_tokens_details = promptDetailsOut
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
    toolCalls: acc.toolCalls.size,
    textPreview: acc.content.slice(0, 200),
    thinkingPreview: thinkingText.slice(0, 200),
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
        } else if (item?.type === 'computer_call') {
          currentBlockIndex++
          currentBlockType = 'tool_use'
          responsesHasToolCalls = true
          const action = item.action as Record<string, unknown> | undefined
          const anthropicInput = convertActionToAnthropic(action ?? {})
          writeEvent('content_block_start', {
            type: 'content_block_start', index: currentBlockIndex,
            content_block: { type: 'tool_use', id: item.call_id, name: 'computer', input: anthropicInput },
          })
          // computer_call has no delta events — action is complete at start
          writeEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex })
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
        // 兜底：如果 reasoning 未通过 delta 事件传输，尝试从顶层 reasoning.summary 提取
        if (!thinkingText) {
          const topReasoning = resp?.reasoning as Record<string, unknown> | undefined
          if (topReasoning?.summary) {
            const summaryItems = topReasoning.summary as Array<Record<string, unknown>>
            const summaryText = summaryItems.map((s) => s.text ?? '').join('')
            if (summaryText) {
              thinkingChunks.push(summaryText)
              thinkingText = summaryText
              // 在 text block 关闭之后补发 thinking block
              writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: summaryText } })
              const sig = makeSignature(summaryText)
              if (sig) writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: sig } })
              writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
            }
          }
        }
        writeEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex })
        writeEvent('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage })
        writeEvent('message_stop', { type: 'message_stop' })
        res.end()

        logger?.log('request', `流式响应完成 (Responses→Anthropic)`, {
          chunks: totalChunks,
          textLength: acc.content.length,
          thinkingLength: thinkingText.length,
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
  pairId?: number,
  originalTools?: unknown[]
): Promise<StreamUsage | null> {
  const decoder = new TextDecoder()
  const acc = newAccumulator()
  let buffer = ''
  let totalChunks = 0
  let currentBlockIndex = 0
  let currentBlockType = ''
  let fnCallId = ''
  let fnCallName = ''
  let fnCallArgsAcc = ''
  let fnCallNamespace = ''
  let fnCallComputerAction: Record<string, unknown> | null = null
  let currentRespId = ''
  let currentMsgId = ''
  let completed = false
  let thinkingText = ''
  let thinkingChunks: string[] = []
  let thinkingStarted = false
  let rawLines: string[] = []
  let outLines: string[] = []
  let anthropicUsage: Record<string, unknown> = {}
  // 用于 output_item.done 和 response.completed 中的 output 数组
  let respToolCallOutputs: Record<string, unknown>[] = []

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
      const message = parsed?.message as Record<string, unknown> | undefined
      const msgUsage = message?.usage as Record<string, unknown> | undefined
      if (msgUsage) anthropicUsage = msgUsage
      currentRespId = respId()
      currentMsgId = msgId()
      const createdAt = Math.floor(Date.now() / 1000)
      const model = message?.model ?? ''
      writeRaw(`event: response.created\ndata: {"type":"response.created","response":{"id":"${currentRespId}","object":"response","created_at":${createdAt},"model":"${model}","status":"in_progress","output":[]}}\n\n`)
      writeRaw(`event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"${currentRespId}","object":"response","created_at":${createdAt},"model":"${model}","status":"in_progress","output":[]}}\n\n`)
      writeRaw(`event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"${currentMsgId}","status":"in_progress","role":"assistant","content":[]}}\n\n`)
      writeRaw(`event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n`)
      currentBlockIndex = 0
      currentBlockType = 'text'
      return false
    }

    if (innerType === 'content_block_start') {
      const cblock = parsed?.content_block as Record<string, unknown> | undefined
      if (cblock?.type === 'thinking') {
        thinkingStarted = true
        currentBlockType = 'thinking'
        currentBlockIndex = (parsed?.index as number) ?? 0
      } else if (cblock?.type === 'text') {
        currentBlockType = 'text'
        currentBlockIndex = (parsed?.index as number) ?? 1
      } else if (cblock?.type === 'tool_use') {
        currentBlockIndex++
        currentBlockType = 'tool_use'
        fnCallId = (cblock.id as string) ?? ''
        fnCallName = (cblock.name as string) ?? ''
        fnCallArgsAcc = ''
        // Don't decode namespace here — pass the raw name as-is.
        // Namespace remapping is done by post-processing (remapNamespaceFunctionCalls).
        fnCallNamespace = ''

        if (fnCallName === 'computer') {
          // Computer tool_use → computer_call output item (action complete at start)
          const input = cblock.input as Record<string, unknown> | undefined
          const action = convertActionToOpenAI(input ?? {})
          fnCallComputerAction = action  // preserve for output_item.done
          const actionStr = JSON.stringify(action)
          writeRaw(`event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":${currentBlockIndex},"item":{"type":"computer_call","id":"cc_${fnCallId}","call_id":"${fnCallId}","action":${actionStr},"pending_safety_checks":[],"status":"in_progress"}}\n\n`)
        } else {
          // Regular tool_use → function_call
          const nsPart = fnCallNamespace ? `,"namespace":"${fnCallNamespace}"` : ''
          writeRaw(`event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":${currentBlockIndex},"item":{"type":"function_call","id":"fc_${fnCallId}","call_id":"${fnCallId}","name":"${fnCallName}","arguments":""${nsPart}}}\n\n`)
        }
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
        fnCallArgsAcc += partialJson
        writeRaw(`event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":${currentBlockIndex},"delta":${JSON.stringify(partialJson)}}\n\n`)
      } else if (deltaType === 'thinking_delta') {
        const chunk = (delta.thinking as string) ?? ''
        thinkingChunks.push(chunk)
        thinkingText += chunk
        // Emit reasoning_text.delta for Responses client
        writeRaw(`event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","output_index":0,"delta":${JSON.stringify(chunk)}}\n\n`)
      }
      return false
    }

    if (innerType === 'content_block_stop') {
      if (currentBlockType === 'thinking') {
        // Thinking block ended, emit reasoning_text.done
        writeRaw(`event: response.reasoning_text.done\ndata: {"type":"response.reasoning_text.done","output_index":0,"reasoning_text":${JSON.stringify(thinkingText)}}\n\n`)
        thinkingStarted = false
      } else if (currentBlockType === 'text') {
        writeRaw(`event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":${JSON.stringify(acc.content)}}\n\n`)
      } else if (currentBlockType === 'tool_use') {
        if (fnCallName === 'computer') {
          const action = fnCallComputerAction ?? {}
          const actionStr = JSON.stringify(action)
          writeRaw(`event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":${currentBlockIndex},"item":{"type":"computer_call","id":"cc_${fnCallId}","call_id":"${fnCallId}","action":${actionStr},"pending_safety_checks":[],"status":"completed"}}\n\n`)
          respToolCallOutputs.push({
            type: 'computer_call',
            id: `cc_${fnCallId}`,
            call_id: fnCallId,
            action: action,
            pending_safety_checks: [],
            status: 'completed',
          })
        } else {
          const nsPart = fnCallNamespace ? `,"namespace":"${fnCallNamespace}"` : ''
          writeRaw(`event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","output_index":${currentBlockIndex},"arguments":${JSON.stringify(fnCallArgsAcc)}}\n\n`)
          writeRaw(`event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":${currentBlockIndex},"item":{"type":"function_call","id":"fc_${fnCallId}","call_id":"${fnCallId}","name":"${fnCallName}","arguments":${JSON.stringify(fnCallArgsAcc)},"status":"completed"${nsPart}}}\n\n`)
          const fcOut: Record<string, unknown> = {
            type: 'function_call',
            id: `fc_${fnCallId}`,
            call_id: fnCallId,
            name: fnCallName,
            arguments: fnCallArgsAcc,
            status: 'completed',
          }
          if (fnCallNamespace) fcOut.namespace = fnCallNamespace
          respToolCallOutputs.push(fcOut)
        }
      }
      return false
    }

    if (eventType === 'message_delta' || innerType === 'message_delta') {
      const msgUsage = parsed?.usage as Record<string, unknown> | undefined
      if (msgUsage) Object.assign(anthropicUsage, msgUsage)
      return false
    }

    if (eventType === 'message_stop' || innerType === 'message_stop') {
      // Build output content (text only, reasoning goes to top-level summary)
      const msgContent: unknown[] = []
      msgContent.push({ type: 'output_text', text: acc.content, annotations: [] })
      const output: unknown[] = [{
        type: 'message',
        id: currentMsgId,
        status: 'completed',
        role: 'assistant',
        content: msgContent,
      }]
      // 把 function_call 追加到 message 后面（保持原始顺序）
      for (const fc of respToolCallOutputs) {
        output.push(fc)
      }
      const respData: Record<string, unknown> = { id: currentRespId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', output }
      // Anthropic thinking → 顶层 reasoning.summary
      if (thinkingText) {
        respData.reasoning = { summary: [{ type: 'summary_text', text: thinkingText, index: 0 }] }
      }
      if (Object.keys(anthropicUsage).length > 0) {
        const ai = (anthropicUsage.input_tokens as number) ?? 0
        const cr = (anthropicUsage.cache_read_input_tokens as number) ?? 0
        const co = (anthropicUsage.output_tokens as number) ?? 0
        const inputTokens = ai + cr
        respData.usage = { input_tokens: inputTokens, output_tokens: co, total_tokens: inputTokens + co }
      }
      writeRaw('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: respData }) + '\n\n')
      res.end()
      logger?.log('request', `流式响应完成 (Anthropic→Responses)`, {
        chunks: totalChunks,
        textLength: acc.content.length - thinkingText.length,
        thinkingLength: thinkingText.length,
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
      const msgContent: unknown[] = []
      msgContent.push({ type: 'output_text', text: acc.content, annotations: [] })
      const output: unknown[] = [{
        type: 'message',
        id: currentMsgId,
        status: 'completed',
        role: 'assistant',
        content: msgContent,
      }]
      for (const fc of respToolCallOutputs) {
        output.push(fc)
      }
      const respData: Record<string, unknown> = { id: currentRespId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', output }
      // Anthropic thinking → 顶层 reasoning.summary
      if (thinkingText) {
        respData.reasoning = { summary: [{ type: 'summary_text', text: thinkingText, index: 0 }] }
      }
      if (Object.keys(anthropicUsage).length > 0) {
        const ai = (anthropicUsage.input_tokens as number) ?? 0
        const cr = (anthropicUsage.cache_read_input_tokens as number) ?? 0
        const co = (anthropicUsage.output_tokens as number) ?? 0
        const inputTokens = ai + cr
        respData.usage = { input_tokens: inputTokens, output_tokens: co, total_tokens: inputTokens + co }
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
  pairId?: number,
  originalTools?: unknown[]
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
  let fnCallNamespace = ''
  let outputItems: Record<string, unknown>[] = [] // accumulated for response.completed
  let upstreamModel = ''         // store upstream model for response events

  // Build namespace lookup table for post-processing (CCX compat)
  const namespaceCtx = originalTools ? buildNamespaceToolContext(originalTools) : new Map()

  // Helper to decode namespace from flat function name
  const decodeNs = (flatName: string): { name: string; namespace?: string } => {
    const spec = namespaceCtx.get(flatName)
    if (spec) return { name: spec.name, namespace: spec.namespace }
    return { name: flatName }
  }

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
          if (textContent) {
            msgContent.push({ type: 'output_text', text: textContent, annotations: [] })
          }
          writeRaw(`event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"${currentMsgId}","type":"message","status":"completed","role":"assistant","content":${JSON.stringify(msgContent)}}}\n\n`)
          outputItems.unshift({ type: 'message', id: currentMsgId, status: 'completed', role: 'assistant', content: msgContent })
        }
        // ...close text block...
        if (messageStarted && currentBlockType === 'text') {
          writeRaw(`event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":${JSON.stringify(textContent)}}\n\n`)
        }
        // Emit completed with model, created_at, top-level reasoning
        const respData: Record<string, unknown> = {
          id: currentRespId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          status: 'completed',
          model: upstreamModel,
          output: outputItems.length > 0 ? outputItems : [],
        }
        // Chat reasoning_content → 顶层 reasoning.summary
        if (thinkingText) {
          respData.reasoning = { summary: [{ type: 'summary_text', text: thinkingText, index: 0 }] }
        }
        if (Object.keys(lastUsage).length > 0) {
          respData.usage = { input_tokens: lastUsage.input_tokens ?? 0, output_tokens: lastUsage.output_tokens ?? 0, total_tokens: ((lastUsage.input_tokens as number) ?? 0) + ((lastUsage.output_tokens as number) ?? 0) }
        }
        writeRaw('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: respData }) + '\n\n')
        res.end()

        logger?.log('request', `流式响应完成 (OpenAI→Responses)`, {
          chunks: totalChunks,
          textLength: textContent.length,
          thinkingLength: thinkingText.length,
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

      // kimi-k2.6 sends usage in a separate chunk with empty choices
      // Capture usage before the choices check
      if (parsed?.usage) {
        lastUsage = parsed.usage as Record<string, unknown>
      }

      const choices = parsed.choices as Array<Record<string, unknown>> | undefined
      if (!choices || choices.length === 0) continue
      const choice = choices[0]
      const delta = choice.delta as Record<string, unknown> | undefined
      const finishReason = choice.finish_reason as string | undefined
      const chunkUsage = parsed.usage as Record<string, unknown> | undefined

      // First message with role or tool_calls → init Responses stream
      // kimi-k2.6 etc may skip the role field and go straight to tool_calls
      // DON'T continue — fall through so tool_calls/text in the same chunk are processed
      if (!messageStarted && (delta?.role === 'assistant' || delta?.tool_calls)) {
        messageStarted = true
        currentRespId = respId()
        currentMsgId = msgId()
        const createdAt = Math.floor(Date.now() / 1000)
        upstreamModel = (parsed?.model as string) ?? ''
        const model = upstreamModel
        writeRaw(`event: response.created\ndata: {"type":"response.created","response":{"id":"${currentRespId}","object":"response","created_at":${createdAt},"model":"${model}","status":"in_progress","output":[]}}\n\n`)
        writeRaw(`event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"${currentRespId}","object":"response","created_at":${createdAt},"model":"${model}","status":"in_progress","output":[]}}\n\n`)
        writeRaw(`event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"${currentMsgId}","status":"in_progress","role":"assistant","content":[]}}\n\n`)
        writeRaw(`event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n`)
        currentBlockIndex = 0
        currentBlockType = 'text'
        // fall through — tool_calls or text in the SAME chunk still need processing
      }

      if (!messageStarted) continue

      // reasoning_content delta → emit reasoning_text.delta for Responses clients
      if (delta?.reasoning_content) {
        const chunk = delta.reasoning_content as string
        thinkingText += chunk
        writeRaw(`event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","output_index":0,"delta":${JSON.stringify(chunk)}}\n\n`)
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
          const nsDecoded = decodeNs(fnCallName)
          fnCallNamespace = nsDecoded.namespace ?? ''
          fnCallName = nsDecoded.name  // Override with decoded name
          const nsPart = fnCallNamespace ? `,"namespace":"${fnCallNamespace}"` : ''
          const fnArgs = ((tc.function as Record<string, unknown>)?.arguments as string) ?? ''
          fnCallArgsAcc = fnArgs  // Initialize accumulator with initial arguments
          writeRaw(`event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":${currentBlockIndex},"item":{"type":"function_call","id":"fc_${fnCallId}","call_id":"${fnCallId}","name":"${nsDecoded.name}","arguments":${JSON.stringify(fnArgs)}${nsPart}}}\n\n`)
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
          const nsPart = fnCallNamespace ? `,"namespace":"${fnCallNamespace}"` : ''
          writeRaw(`event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":${currentBlockIndex},"item":{"type":"function_call","id":"fc_${fnCallId}","call_id":"${fnCallId}","name":"${fnCallName}","arguments":${JSON.stringify(fnCallArgsAcc)},"status":"completed"${nsPart}}}\n\n`)
          // Record for response.completed output
          const fcOut: Record<string, unknown> = {
            type: 'function_call', id: `fc_${fnCallId}`, call_id: fnCallId,
            name: fnCallName, arguments: fnCallArgsAcc, status: 'completed',
          }
          if (fnCallNamespace) fcOut.namespace = fnCallNamespace
          outputItems.push(fcOut)
        }
        // Emit response.output_item.done for the message
        const msgContent: unknown[] = []
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
      if (textContent) {
        msgContent.push({ type: 'output_text', text: textContent, annotations: [] })
      }
      writeRaw(`event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"${currentMsgId}","type":"message","status":"completed","role":"assistant","content":${JSON.stringify(msgContent)}}}\n\n`)
      outputItems.unshift({ type: 'message', id: currentMsgId, status: 'completed', role: 'assistant', content: msgContent })
    }
    writeRaw(`event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":${JSON.stringify(textContent)}}\n\n`)
    const respData: Record<string, unknown> = { id: currentRespId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', output: outputItems.length > 0 ? outputItems : [] }
    // Chat reasoning_content → 顶层 reasoning.summary
    if (thinkingText) {
      respData.reasoning = { summary: [{ type: 'summary_text', text: thinkingText, index: 0 }] }
    }
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
          write({ choices: [{ delta: { role: 'assistant', reasoning_content: '' }, index: 0 }] })
        } else if (item?.type === 'function_call') {
          currentFnCallIndex = ((parsed?.output_index as number) ?? 1) - 1
          if (!hasFunctionCalls) {
            hasFunctionCalls = true
            firstFnCallOutputIndex = (parsed?.output_index as number) ?? 1
          }
          write({ choices: [{ delta: { tool_calls: [{ index: currentFnCallIndex, id: item?.call_id ?? item?.id, type: 'function', function: { name: item?.name ?? '', arguments: (item?.arguments as string) ?? '' } }] }, index: 0 }] })
        } else if (item?.type === 'computer_call') {
          // Computer call → Chat tool_calls (lossy: serialize action as arguments)
          const action = item.action as Record<string, unknown> | undefined
          currentFnCallIndex = ((parsed?.output_index as number) ?? 1) - 1
          if (!hasFunctionCalls) {
            hasFunctionCalls = true
            firstFnCallOutputIndex = (parsed?.output_index as number) ?? 1
          }
          write({ choices: [{ delta: { tool_calls: [{ index: currentFnCallIndex, id: item?.call_id ?? item?.id, type: 'function', function: { name: 'computer', arguments: JSON.stringify(action ?? {}) } }] }, index: 0 }] })
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

        // 兜底：如果 reasoning_text.delta 未触发，尝试从顶层 reasoning.summary 提取
        if (!thinkingText) {
          const topReasoning = resp?.reasoning as Record<string, unknown> | undefined
          if (topReasoning?.summary) {
            const summaryItems = topReasoning.summary as Array<Record<string, unknown>>
            const summaryText = summaryItems.map((s) => s.text ?? '').join('')
            if (summaryText) {
              thinkingText = summaryText
            }
          }
        }

        const finalDelta: Record<string, unknown> = {}
        if (thinkingText) finalDelta.reasoning_content = thinkingText

        const finalChunk: Record<string, unknown> = {
          choices: [{ delta: finalDelta, finish_reason: finishReason, index: 0 }],
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
