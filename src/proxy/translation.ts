import type { RouterResult } from './types.js'
import type { Logger } from '../log/logger.js'
import { createHash } from 'node:crypto'

// --- Helpers ---

/** 从 thinking 内容生成确定性伪签名（与 stream-converter.ts 中的一致） */
function makeSignature(thinkingText: string): string {
  return createHash('sha256').update(thinkingText).digest('hex').slice(0, 16)
}

function truncateBody(obj: Record<string, unknown>, maxLen = 500): Record<string, unknown> {
  const json = JSON.stringify(obj)
  if (json.length <= maxLen) return obj
  // Truncate messages array content
  const truncated = { ...obj }
  if (Array.isArray(truncated.messages)) {
    const msgs = truncated.messages as Array<Record<string, unknown>>
    if (msgs.length > 0) {
      const last = msgs[msgs.length - 1]
      const pc = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
      truncated._messagesTruncated = `${msgs.length} messages, last: ${(pc as string).slice(0, 100)}...`
      truncated.messages = undefined
    }
  } else {
    truncated._truncated = `${json.slice(0, maxLen)}...`
  }
  return truncated
}

// --- Tool format conversion ---

function convertToolsToAnthropic(tools: unknown[]): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined
  return tools
    .filter((t: unknown) => {
      // Filter out non-function tools (web_search, code_interpreter, etc.) -
      // Anthropic API only supports standard tools
      const item = t as Record<string, unknown>
      return item.type === 'function' || (item.name && item.input_schema)
    })
    .map((t: unknown) => {
    const item = t as Record<string, unknown>
    // OpenAI Chat format: { type: "function", function: { name, description, parameters } }
    if (item.type === 'function' && item.function) {
      const fn = item.function as Record<string, unknown>
      return {
        name: fn.name ?? '',
        description: (fn.description as string) || undefined,
        input_schema: fn.parameters ?? {},
      }
    }
    // OpenAI Responses flat format: { type: "function", name, description, parameters } (no "function" wrapper)
    if (item.type === 'function' && item.name) {
      return {
        name: item.name ?? '',
        description: (item.description as string) || undefined,
        input_schema: (item.parameters as Record<string, unknown>) ?? {},
      }
    }
    // Already Anthropic format or unknown
    return item
  })
}

function convertToolsToOpenAI(tools: unknown[]): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined
  return tools
    .filter((t: unknown) => {
      // Filter out non-function tools (web_search, code_interpreter, etc.) -
      // Chat Completions API only supports type: "function"
      const item = t as Record<string, unknown>
      return item.type === 'function' || (item.name && item.input_schema)
    })
    .map((t: unknown) => {
    const item = t as Record<string, unknown>
    // Anthropic format: { name, description, input_schema }
    if (item.name && item.input_schema) {
      return {
        type: 'function',
        function: {
          name: item.name,
          description: (item.description as string) || undefined,
          parameters: item.input_schema,
        },
      }
    }
    // OpenAI Responses flat format: { type: "function", name, parameters } → wrap in "function" for Chat Completions
    if (item.type === 'function' && item.name && !item.function) {
      return {
        type: 'function',
        function: {
          name: item.name ?? '',
          description: (item.description as string) || undefined,
          parameters: (item.parameters as Record<string, unknown>) ?? {},
        },
      }
    }
    return item
  })
}

function convertToolChoiceToAnthropic(toolChoice: unknown): unknown {
  if (toolChoice === undefined || toolChoice === null) return undefined
  if (typeof toolChoice === 'string') {
    // OpenAI "required" → Anthropic "any"
    if (toolChoice === 'required') return 'any'
    return toolChoice
  }
  // OpenAI: { type: "function", function: { name } } → Anthropic: { type: "tool", name }
  const tc = toolChoice as Record<string, unknown>
  if (tc.type === 'function') {
    const fn = tc.function as Record<string, unknown> | undefined
    return { type: 'tool', name: fn?.name ?? '' }
  }
  return toolChoice
}

function convertToolChoiceToOpenAI(toolChoice: unknown): unknown {
  if (toolChoice === undefined || toolChoice === null) return undefined
  if (typeof toolChoice === 'string') {
    // Anthropic "any" → OpenAI "required"
    if (toolChoice === 'any') return 'required'
    return toolChoice
  }
  // Anthropic: { type: "tool", name } → OpenAI: { type: "function", function: { name } }
  const tc = toolChoice as Record<string, unknown>
  if (tc.type === 'tool') {
    return { type: 'function', function: { name: tc.name } }
  }
  return toolChoice
}

// --- Responses input ↔ Chat messages format conversion ---

/**
 * Convert OpenAI Responses input items to Chat Completions message format.
 * Responses input: {type:"message",role:"user",content:"..."} / {type:"function_call",...} / {type:"function_call_output",...}
 * Chat messages:    {role:"user",content:"..."} / {role:"assistant",tool_calls:[...]} / {role:"tool",tool_call_id,content}
 */
function convertResponsesInputToMessages(input: unknown[]): unknown[] {
  const messages: unknown[] = []
  for (const item of input) {
    const it = item as Record<string, unknown>
    if (it.type === 'message') {
      // { type: "message", role: "user"|"assistant"|"system"|"developer", content: string | array }
      const content = it.content
      let normalizedContent: unknown = content
      // Convert Responses content blocks to Chat/Anthropic-compatible format
      if (Array.isArray(content)) {
        const blocks = (content as Array<Record<string, unknown>>).map((block) => {
          // input_text → text (Anthropic-style content block)
          if (block.type === 'input_text' || block.type === 'output_text') {
            return { type: 'text', text: block.text }
          }
          // reasoning → thinking (Anthropic-style thinking block)
          if (block.type === 'reasoning') {
            // reasoning can have summary (array of summary_text) or reasoning_text (plain string)
            const summary = block.summary as Array<Record<string, unknown>> | undefined
            const reasoningText = summary
              ? summary.map((s) => s.text ?? '').join('')
              : (block.reasoning_text as string) ?? ''
            return { type: 'thinking', thinking: reasoningText, signature: '' }
          }
          // input_image → image (Anthropic-style)
          if (block.type === 'input_image') {
            // Responses input_image uses {type:"input_image", image_url:"..."} or {type:"input_image", detail, file_id}
            // Convert to Anthropic image format
            const imageUrl = block.image_url as string | undefined
            if (imageUrl) {
              return { type: 'image', source: { type: 'url', url: imageUrl } }
            }
            // If it uses file_id, skip (Anthropic doesn't support file_id directly)
            return { type: 'text', text: '[image]' }
          }
          // input_file → text placeholder (no direct Chat/Anthropic equivalent)
          if (block.type === 'input_file') {
            return { type: 'text', text: '[file]' }
          }
          return block
        })
        // If all blocks are text blocks, collapse to a single string
        if (blocks.every((b) => b.type === 'text')) {
          normalizedContent = blocks.map((b) => b.text as string).join('')
        } else {
          normalizedContent = blocks
        }
      }
      messages.push({ role: it.role, content: normalizedContent })
    } else if (it.type === 'function_call') {
      // { type: "function_call", call_id, name, arguments }
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: it.call_id ?? it.id,
          type: 'function',
          function: { name: it.name ?? '', arguments: it.arguments ?? '' },
        }],
      })
    } else if (it.type === 'function_call_output') {
      // { type: "function_call_output", call_id, output }
      messages.push({
        role: 'tool',
        tool_call_id: it.call_id,
        content: it.output ?? '',
      })
    } else if (it.type === 'item_reference') {
      // Skip item references (they reference previous response items, not applicable to stateless chat)
    } else {
      // Unknown item type, pass through as-is
      messages.push(it)
    }
  }
  return messages
}

/**
 * Convert Chat Completions messages to OpenAI Responses input format.
 */
function convertMessagesToResponsesInput(messages: unknown[]): unknown[] {
  const input: unknown[] = []
  for (const msg of messages) {
    const m = msg as Record<string, unknown>
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })
    } else if (m.role === 'assistant') {
      // Add message item for text content (if any)
      const text = typeof m.content === 'string' ? m.content : ''
      if (text) {
        input.push({ type: 'message', role: 'assistant', content: text })
      }
      // Add function_call items for tool_calls
      const toolCalls = m.tool_calls as Array<Record<string, unknown>> | undefined
      if (toolCalls) {
        for (const tc of toolCalls) {
          const fn = tc.function as Record<string, unknown> | undefined
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: fn?.name ?? '',
            arguments: fn?.arguments ?? '',
          })
        }
      }
    } else if (m.role === 'system') {
      // system is handled via instructions field, but if it appears in messages we include it
      input.push({ type: 'message', role: 'system', content: m.content })
    } else {
      // user, developer, etc.
      input.push({ type: 'message', role: m.role ?? 'user', content: m.content })
    }
  }
  return input
}

// --- System message extraction ---

function extractSystemFromOpenAI(messages: unknown[]): { system?: unknown; remainingMessages: unknown[] } {
  const first = messages[0] as Record<string, unknown> | undefined
  if (first?.role === 'system') {
    return {
      system: first.content,
      remainingMessages: messages.slice(1),
    }
  }
  return { remainingMessages: messages }
}

// --- Full parameter mapping ---

interface FullParams {
  model: string
  messages: unknown[]
  system?: unknown
  temperature?: number
  max_tokens?: number
  stream?: boolean
  top_p?: number
  stop?: unknown
  tools?: unknown[]
  tool_choice?: unknown
}

function extractFullOpenAI(body: Record<string, unknown>): FullParams {
  const messages = (body.messages as unknown[]) ?? []
  const { system, remainingMessages } = extractSystemFromOpenAI(messages)
  return {
    model: body.model as string,
    messages: remainingMessages,
    system,
    temperature: body.temperature as number | undefined,
    max_tokens: body.max_tokens as number | undefined,
    stream: body.stream as boolean | undefined,
    top_p: body.top_p as number | undefined,
    stop: body.stop,
    tools: body.tools as unknown[] | undefined,
    tool_choice: body.tool_choice,
  }
}

function extractFullAnthropic(body: Record<string, unknown>): FullParams {
  return {
    model: body.model as string,
    messages: (body.messages as unknown[]) ?? [],
    system: body.system,
    temperature: body.temperature as number | undefined,
    max_tokens: body.max_tokens as number | undefined,
    stream: body.stream as boolean | undefined,
    top_p: body.top_p as number | undefined,
    stop: body.stop_sequences,
    tools: body.tools as unknown[] | undefined,
    tool_choice: body.tool_choice,
  }
}

function convertMessagesToAnthropic(messages: unknown[]): unknown[] {
  const result: unknown[] = []
  let i = 0

  while (i < messages.length) {
    const m = messages[i] as Record<string, unknown>

    // tool role → 合并连续 tool 消息到单个 user 消息
    // Anthropic 要求并行 tool_result 必须在同一 user 消息的 content 数组中
    if (m.role === 'tool') {
      const toolResults: unknown[] = []
      while (i < messages.length) {
        const cur = messages[i] as Record<string, unknown>
        if (cur.role !== 'tool') break
        toolResults.push({
          type: 'tool_result',
          tool_use_id: cur.tool_call_id,
          content: typeof cur.content === 'string' ? cur.content : JSON.stringify(cur.content),
        })
        i++
      }
      result.push({ role: 'user', content: toolResults })
      continue
    }

    // developer role → user (Anthropic doesn't support "developer" role)
    if (m.role === 'developer') {
      result.push({ role: 'user', content: m.content })
      i++
      continue
    }

    if (m.role !== 'assistant') {
      result.push(m)
      i++
      continue
    }

    const reasoning = m.reasoning_content as string | undefined
    const text = m.content as string | undefined
    const toolCalls = m.tool_calls as Array<Record<string, unknown>> | undefined

    // 如果有 tool_calls，需要转为 content 数组中的 tool_use 块
    if (toolCalls && toolCalls.length > 0) {
      const content: unknown[] = []
      if (reasoning) {
        const sig = (m.reasoning_signature as string) || makeSignature(reasoning)
        content.push({ type: 'thinking', thinking: reasoning, signature: sig })
      }
      if (text) {
        content.push({ type: 'text', text })
      }
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown> | undefined
        let input: unknown = {}
        try { input = fn?.arguments ? JSON.parse(fn.arguments as string) : {} } catch { input = {} }
        content.push({
          type: 'tool_use',
          id: tc.id as string,
          name: fn?.name as string ?? '',
          input,
        })
      }
      result.push({ role: 'assistant', content })
      i++
      continue
    }

    // If no reasoning and no tool_calls, keep as-is (Anthropic accepts string content for assistant)
    if (!reasoning) {
      result.push(m)
      i++
      continue
    }

    // Convert to content block array with thinking + text
    const content: unknown[] = []
    if (reasoning) {
      const sig = (m.reasoning_signature as string) || makeSignature(reasoning)
      content.push({ type: 'thinking', thinking: reasoning, signature: sig })
    }
    if (text) content.push({ type: 'text', text })

    result.push({ role: 'assistant', content })
    i++
  }

  return result
}

function buildAnthropicFromOpenAI(params: FullParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.max_tokens ?? 4096,
    messages: convertMessagesToAnthropic(params.messages as unknown[]),
  }
  if (params.system) body.system = params.system
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.stream) body.stream = true
  if (params.top_p !== undefined) body.top_p = params.top_p
  if (params.stop) body.stop_sequences = params.stop
  if (params.tools) body.tools = convertToolsToAnthropic(params.tools)
  if (params.tool_choice !== undefined) body.tool_choice = convertToolChoiceToAnthropic(params.tool_choice)
  return body
}

function convertMessagesToOpenAI(messages: unknown[]): unknown[] {
  const result: unknown[] = []
  for (const msg of messages) {
    const m = msg as Record<string, unknown>
    if (m.role === 'user') {
      const content = m.content
      // Check if this is a tool_result message (array with tool_result blocks)
      if (Array.isArray(content)) {
        const toolResults = content.filter((b: any) => b.type === 'tool_result')
        const otherBlocks = content.filter((b: any) => b.type !== 'tool_result')
        // Emit tool messages for each tool_result
        for (const tr of toolResults as Array<Record<string, unknown>>) {
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          })
        }
        // Emit remaining user content if any
        if (otherBlocks.length > 0) {
          const text = otherBlocks.map((b: any) => b.text ?? '').join('')
          result.push({ role: 'user', content: text })
        }
        continue
      }
    }
    // developer role → system (older Chat Completions APIs don't support "developer")
    if (m.role === 'developer') {
      result.push({ role: 'system', content: m.content })
      continue
    }
    // Handle assistant messages with content blocks (thinking + text + tool_use from Anthropic)
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const blocks = m.content as Array<Record<string, unknown>>
      let textContent = ''
      let reasoningContent = ''
      let thinkingSignature = ''
      for (const block of blocks) {
        if (block.type === 'text') {
          textContent += (block.text as string) ?? ''
        } else if (block.type === 'thinking') {
          reasoningContent += (block.thinking as string) ?? ''
          if (block.signature) thinkingSignature += (block.signature as string)
        }
      }
      const converted: Record<string, unknown> = { role: 'assistant', content: textContent }
      if (reasoningContent) {
        converted.reasoning_content = reasoningContent
        // Always include signature if reasoning_content is present (some APIs require it paired)
        converted.reasoning_signature = thinkingSignature || ''
      }
      // Convert Anthropic tool_use blocks → OpenAI tool_calls
      const toolUses = blocks.filter((b) => b.type === 'tool_use')
      if (toolUses.length > 0) {
        converted.tool_calls = toolUses.map((tu) => ({
          id: tu.id as string,
          type: 'function',
          function: {
            name: tu.name as string ?? '',
            arguments: JSON.stringify(tu.input ?? {}),
          },
        }))
      }
      if (m.tool_calls) converted.tool_calls = m.tool_calls
      result.push(converted)
      continue
    }
    result.push(m)
  }
  return result
}

function buildOpenAIFromAnthropic(params: FullParams): Record<string, unknown> {
  const convertedMessages = convertMessagesToOpenAI(params.messages as unknown[])
  const body: Record<string, unknown> = {
    model: params.model,
    messages: convertedMessages,
  }
  if (params.system) {
    body.messages = [{ role: 'system', content: params.system }, ...convertedMessages]
  }
  if (params.max_tokens !== undefined) body.max_tokens = params.max_tokens
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.stream) body.stream = true
  if (params.top_p !== undefined) body.top_p = params.top_p
  if (params.stop) body.stop = params.stop
  if (params.tools) body.tools = convertToolsToOpenAI(params.tools)
  if (params.tool_choice !== undefined) body.tool_choice = convertToolChoiceToOpenAI(params.tool_choice)
  return body
}

// --- OpenAI Responses API extraction ---

function extractFullOpenAIResponses(body: Record<string, unknown>): FullParams {
  const rawInput = body.input
  let messages: unknown[]
  if (typeof rawInput === 'string') {
    messages = [{ role: 'user', content: rawInput }]
  } else if (Array.isArray(rawInput)) {
    messages = convertResponsesInputToMessages(rawInput)
  } else {
    messages = []
  }
  return {
    model: body.model as string,
    messages,
    system: body.instructions,
    temperature: body.temperature as number | undefined,
    max_tokens: (body.max_output_tokens ?? body.max_tokens) as number | undefined,
    stream: body.stream as boolean | undefined,
    top_p: body.top_p as number | undefined,
    stop: body.stop,
    tools: body.tools as unknown[] | undefined,
    tool_choice: body.tool_choice,
  }
}

// --- Builders for OpenAI Responses format ---

function buildAnthropicFromOpenAIResponses(params: FullParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.max_tokens ?? 4096,
    messages: convertMessagesToAnthropic(params.messages as unknown[]),
  }
  if (params.system) body.system = params.system
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.stream) body.stream = true
  if (params.top_p !== undefined) body.top_p = params.top_p
  if (params.stop) body.stop_sequences = params.stop
  if (params.tools) body.tools = convertToolsToAnthropic(params.tools)
  if (params.tool_choice !== undefined) body.tool_choice = convertToolChoiceToAnthropic(params.tool_choice)
  return body
}

function buildOpenAIResponsesFromFullParams(params: FullParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    input: convertMessagesToResponsesInput(params.messages as unknown[]),
  }
  if (params.system) body.instructions = params.system
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.max_tokens !== undefined) body.max_output_tokens = params.max_tokens
  if (params.stream) body.stream = true
  if (params.top_p !== undefined) body.top_p = params.top_p
  if (params.stop) body.stop = params.stop
  if (params.tools) body.tools = convertToolsToOpenAI(params.tools)
  if (params.tool_choice !== undefined) body.tool_choice = convertToolChoiceToOpenAI(params.tool_choice)
  return body
}

// --- Public interface ---

export type InboundType = 'anthropic' | 'openai' | 'openai-responses'

export interface TransformResult {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  crossProtocol: boolean
}

export async function transformInboundRequest(
  inboundType: InboundType,
  route: RouterResult,
  body: Record<string, unknown>,
  logger?: Logger
): Promise<TransformResult> {
  const sameProtocol = inboundType === route.providerType

  const upstreamEndpoint = route.providerType === 'anthropic'
    ? 'messages'
    : route.providerType === 'openai-responses'
      ? 'responses'
      : 'chat/completions'

  const url = `${route.apiBase}/v1/${upstreamEndpoint}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (route.providerType === 'anthropic') {
    headers['x-api-key'] = route.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers['Authorization'] = `Bearer ${route.apiKey}`
  }

  if (sameProtocol) {
    const upstreamBody: Record<string, unknown> = { ...body, model: route.modelId }
    injectThinkingConfig(upstreamBody, route)
    // thinking 模式检测：配置开启了 或 消息中已有 thinking 块，都需要补全
    if (route.providerType === 'anthropic') {
      const msgs = upstreamBody.messages as Array<Record<string, unknown>> | undefined
      if (msgs) {
        if (hasThinkingInMessages(msgs)) {
          ensureThinkingBlocks(msgs)
        }
      }
    }
    return { url, headers, body: upstreamBody, crossProtocol: false }
  }

  // Cross-protocol: full translation
  const params = inboundType === 'openai-responses'
    ? extractFullOpenAIResponses(body)
    : inboundType === 'openai'
      ? extractFullOpenAI(body)
      : extractFullAnthropic(body)
  params.model = route.modelId

  let upstreamBody: Record<string, unknown>
  if (route.providerType === 'anthropic') {
    upstreamBody = inboundType === 'openai-responses'
      ? buildAnthropicFromOpenAIResponses(params)
      : buildAnthropicFromOpenAI(params)
  } else if (route.providerType === 'openai-responses') {
    upstreamBody = buildOpenAIResponsesFromFullParams(params)
  } else {
    upstreamBody = buildOpenAIFromAnthropic(params)
  }

  // 注入 thinking 配置到转换后的请求体
  injectThinkingConfig(upstreamBody, route)
  // thinking 模式检测：配置开启了 或 消息中已有 thinking 块，都需要补全
  if (route.providerType === 'anthropic') {
    const msgs = upstreamBody.messages as Array<Record<string, unknown>> | undefined
    if (msgs) {
      if (hasThinkingInMessages(msgs)) {
        ensureThinkingBlocks(msgs)
      }
    }
  }

  logger?.log('request', `跨协议转换: ${inboundType} → ${route.providerType}`, {
    originalModel: body.model,
    targetModel: route.modelId,
    originalBody: truncateBody(body),
    convertedBody: truncateBody(upstreamBody),
  }, 'debug')

  return { url, headers, body: upstreamBody, crossProtocol: true }
}

/**
 * 根据 content 块生成描述性的占位 thinking 文本。
 */
function generatePlaceholderThinking(content: Array<Record<string, unknown>>): string {
  const toolUses = content.filter((c) => c.type === 'tool_use')
  if (toolUses.length > 0) {
    const names = toolUses.map((c) => c.name as string).filter(Boolean)
    const uniqueNames = [...new Set(names)]
    if (uniqueNames.length === 1) {
      return `让我调用 ${uniqueNames[0]} 工具`
    }
    return `让我调用 ${uniqueNames.join('、')} 等多个工具`
  }
  return '让我思考一下'
}

/**
 * 检查消息列表中是否有任意 assistant 消息已包含 thinking 块（或 OpenAI 的 reasoning_content）。
 * 如果有，说明对话已经在 thinking 模式下，需要保证所有 assistant 消息都有 thinking 块。
 */
function hasThinkingInMessages(messages: Array<Record<string, unknown>>): boolean {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    // OpenAI 格式：有 reasoning_content 说明开启了 thinking
    if (msg.reasoning_content) return true
    // Anthropic 格式：content 数组中有 thinking 块
    const content = msg.content
    if (Array.isArray(content)) {
      if (content.some((c: Record<string, unknown>) => c.type === 'thinking')) return true
    }
  }
  return false
}

/**
 * 确保所有 assistant 消息在 thinking 模式下都有 thinking 块作为首个 content block。
 * 工具调用消息如果没有 reasoning_content，需要补一个占位 thinking。
 */
function ensureThinkingBlocks(messages: Array<Record<string, unknown>>): void {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (!Array.isArray(content)) continue
    // 如果第一个 block 不是 thinking，在前面插入占位 thinking
    if (content.length === 0 || content[0].type !== 'thinking') {
      const placeholder = generatePlaceholderThinking(content)
      content.unshift({ type: 'thinking', thinking: placeholder, signature: makeSignature(placeholder) })
    }
  }
}

/**
 * 根据路由配置的 thinking 参数，注入到上游请求体中。
 * 同协议和跨协议路径都调用此函数。
 */
function injectThinkingConfig(
  upstreamBody: Record<string, unknown>,
  route: RouterResult
): void {
  if (!route.thinking) return

  if (route.providerType === 'anthropic' && route.thinking.budget_tokens) {
    const budget = route.thinking.budget_tokens
    upstreamBody.thinking = { type: 'enabled', budget_tokens: budget }
    // 确保 max_tokens >= budget_tokens，否则 Anthropic API 会报错
    if (!upstreamBody.max_tokens || (upstreamBody.max_tokens as number) < budget) {
      upstreamBody.max_tokens = budget
    }
  }

  if ((route.providerType === 'openai' || route.providerType === 'openai-responses') && route.thinking.reasoning_effort) {
    upstreamBody.reasoning_effort = route.thinking.reasoning_effort
  }
}

// --- OpenAI Responses ↔ Anthropic response conversion ---

function mapResponsesStopReason(stop: string, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_use'
  const stopMap: Record<string, string> = { completed: 'end_turn', incomplete: 'max_tokens', max_output_tokens: 'max_tokens' }
  return stopMap[stop] ?? 'end_turn'
}

export function convertOpenAIResponsesToAnthropic(responsesBody: Record<string, unknown>): Record<string, unknown> {
  const output = responsesBody.output as Array<Record<string, unknown>> | undefined
  const usage = responsesBody.usage as Record<string, unknown> | undefined

  const content: unknown[] = []
  let stopReason = 'end_turn'

  if (output) {
    for (const item of output) {
      if (item.type === 'message' && item.role === 'assistant') {
        const msgContent = item.content as Array<Record<string, unknown>> | undefined
        if (msgContent) {
          for (const block of msgContent) {
            if (block.type === 'output_text') {
              content.push({ type: 'text', text: block.text ?? '' })
            } else if (block.type === 'reasoning') {
              content.push({ type: 'thinking', thinking: block.summary ? (block.summary as Array<Record<string, unknown>>).map((s) => s.text ?? '').join('') : (block.reasoning_text ?? ''), signature: '' })
            } else if (block.type === 'web_search_call') {
              // web_search is Responses-specific, map to text note or skip
              // For now, skip as Anthropic doesn't have direct equivalent
            }
          }
        }
        if (item.status) stopReason = item.status as string
      } else if (item.type === 'function_call') {
        let input: unknown = {}
        try { input = typeof item.arguments === 'string' ? JSON.parse(item.arguments as string) : (item.arguments ?? {}) } catch { input = item.arguments }
        content.push({
          type: 'tool_use',
          id: item.call_id ?? item.id,
          name: item.name ?? '',
          input,
        })
        stopReason = 'tool_use'
      }
    }
  }

  const hasToolCalls = content.some((b) => (b as Record<string, unknown>).type === 'tool_use')
  const anthropicStop = mapResponsesStopReason(stopReason, hasToolCalls)

  return {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: responsesBody.model as string ?? '',
    stop_reason: anthropicStop,
    stop_sequence: null,
    usage: {
      input_tokens: (usage?.input_tokens as number) ?? 0,
      output_tokens: (usage?.output_tokens as number) ?? 0,
    },
  }
}

export function convertAnthropicResponseToOpenAIResponses(anthropicBody: Record<string, unknown>): Record<string, unknown> {
  const content = anthropicBody.content as Array<Record<string, unknown>> | undefined
  const usage = anthropicBody.usage as Record<string, unknown> | undefined
  const stopReason = anthropicBody.stop_reason as string ?? 'end_turn'

  const outputMessageContent: unknown[] = []
  const output: unknown[] = []

  if (content) {
    for (const block of content) {
      if (block.type === 'text') {
        outputMessageContent.push({ type: 'output_text', text: block.text as string ?? '', annotations: [] })
      } else if (block.type === 'thinking') {
        // Skip reasoning - Responses client doesn't track it
      } else if (block.type === 'tool_use') {
        output.push({
          type: 'function_call',
          id: `fc_${Date.now().toString(36)}_${(block.id as string) ?? ''}`,
          call_id: block.id as string,
          name: block.name as string ?? '',
          arguments: JSON.stringify(block.input ?? {}),
        })
      }
    }
  }

  // Message output item goes first (before function_call items for correct ordering)
  output.unshift({
    type: 'message',
    id: `msg_${Date.now().toString(36)}`,
    status: stopReason === 'end_turn' ? 'completed' : stopReason === 'max_tokens' ? 'incomplete' : 'completed',
    role: 'assistant',
    content: outputMessageContent,
  })

  return {
    id: `resp_${Date.now().toString(36)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: stopReason === 'end_turn' ? 'completed' : 'incomplete',
    model: anthropicBody.model as string ?? '',
    output,
    usage: {
      input_tokens: (usage?.input_tokens as number) ?? 0,
      output_tokens: (usage?.output_tokens as number) ?? 0,
      total_tokens: ((usage?.input_tokens as number) ?? 0) + ((usage?.output_tokens as number) ?? 0),
    },
  }
}

// --- Chat Completions ↔ Anthropic response conversion ---

export function convertOpenAIResponseToAnthropic(openaiBody: Record<string, unknown>): Record<string, unknown> {
  const choices = openaiBody.choices as Array<Record<string, unknown>> | undefined
  const choice = choices?.[0]
  const message = choice?.message as Record<string, unknown> | undefined
  const usage = openaiBody.usage as Record<string, unknown> | undefined

  const content: unknown[] = []

  // reasoning_content → thinking block
  const reasoning = message?.reasoning_content as string | undefined
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: (message?.reasoning_signature as string) ?? '' })

  // Collect text content
  const text = message?.content as string | undefined
  if (text) content.push({ type: 'text', text })

  // Collect tool calls
  const toolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined
  if (toolCalls) {
    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown> | undefined
      let input: unknown = {}
      try { input = fn?.arguments ? JSON.parse(fn.arguments as string) : {} } catch { input = {} }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: fn?.name ?? '',
        input,
      })
    }
  }

  const stopMap: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' }
  const stopReason = choice?.finish_reason as string ?? 'end_turn'

  return {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: openaiBody.model as string ?? '',
    stop_reason: stopMap[stopReason] ?? stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: (usage?.prompt_tokens as number) ?? 0,
      output_tokens: (usage?.completion_tokens as number) ?? 0,
    },
  }
}

export function convertAnthropicResponseToOpenAI(anthropicBody: Record<string, unknown>): Record<string, unknown> {
  const content = anthropicBody.content as Array<Record<string, unknown>> | undefined
  const usage = anthropicBody.usage as Record<string, unknown> | undefined

  let textContent = ''
  let reasoningContent = ''
  let thinkingSignature = ''
  const toolCalls: Record<string, unknown>[] = []

  if (content) {
    for (const block of content) {
      if (block.type === 'thinking') {
        reasoningContent += (block.thinking as string) ?? ''
        if (block.signature) thinkingSignature += (block.signature as string)
      } else if (block.type === 'text') {
        textContent += (block.text as string) ?? ''
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
      }
    }
  }

  const stopMap: Record<string, string> = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls' }
  const stopReason = anthropicBody.stop_reason as string ?? 'stop'

  const message: Record<string, unknown> = { role: 'assistant', content: textContent }
  if (reasoningContent) {
    message.reasoning_content = reasoningContent
    if (thinkingSignature) message.reasoning_signature = thinkingSignature
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicBody.model as string ?? '',
    choices: [{
      index: 0,
      message,
      finish_reason: stopMap[stopReason] ?? stopReason,
    }],
    usage: {
      prompt_tokens: (usage?.input_tokens as number) ?? 0,
      completion_tokens: (usage?.output_tokens as number) ?? 0,
      total_tokens: ((usage?.input_tokens as number) ?? 0) + ((usage?.output_tokens as number) ?? 0),
    },
  }
}

// --- Chat Completions ↔ OpenAI Responses response conversion ---

/**
 * Convert OpenAI Chat Completions response to OpenAI Responses format.
 */
export function convertOpenAIResponseToOpenAIResponses(chatBody: Record<string, unknown>): Record<string, unknown> {
  const choices = chatBody.choices as Array<Record<string, unknown>> | undefined
  const choice = choices?.[0]
  const message = choice?.message as Record<string, unknown> | undefined
  const usage = chatBody.usage as Record<string, unknown> | undefined
  const finishReason = choice?.finish_reason as string ?? 'stop'

  const output: unknown[] = []
  const outputMessageContent: unknown[] = []

  // reasoning_content → skip (Responses client doesn't track reasoning for passthrough)
  // text content
  const text = message?.content as string | undefined
  if (text) {
    outputMessageContent.push({ type: 'output_text', text, annotations: [] })
  }

  // Add message output item
  const statusMap: Record<string, string> = { stop: 'completed', length: 'incomplete', tool_calls: 'completed' }
  output.push({
    type: 'message',
    id: `msg_${Date.now().toString(36)}`,
    status: statusMap[finishReason] ?? 'completed',
    role: 'assistant',
    content: outputMessageContent,
  })

  // tool_calls → function_call output items
  const toolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined
  if (toolCalls) {
    for (const tc of toolCalls) {
      output.push({
        type: 'function_call',
        id: `fc_${Date.now().toString(36)}_${(tc.id as string) ?? ''}`,
        call_id: tc.id,
        name: (tc.function as Record<string, unknown>)?.name ?? '',
        arguments: (tc.function as Record<string, unknown>)?.arguments ?? '',
      })
    }
  }

  return {
    id: `resp_${Date.now().toString(36)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: statusMap[finishReason] ?? 'completed',
    model: chatBody.model as string ?? '',
    output,
    usage: {
      input_tokens: (usage?.prompt_tokens as number) ?? 0,
      output_tokens: (usage?.completion_tokens as number) ?? 0,
      total_tokens: ((usage?.prompt_tokens as number) ?? 0) + ((usage?.completion_tokens as number) ?? 0),
    },
  }
}

/**
 * Convert OpenAI Responses response to Chat Completions format.
 */
export function convertOpenAIResponsesResponseToOpenAI(responsesBody: Record<string, unknown>): Record<string, unknown> {
  const output = responsesBody.output as Array<Record<string, unknown>> | undefined
  const usage = responsesBody.usage as Record<string, unknown> | undefined
  const status = (responsesBody.status as string) ?? 'completed'

  let textContent = ''
  let reasoningContent = ''
  const toolCalls: Record<string, unknown>[] = []

  if (output) {
    for (const item of output) {
      if (item.type === 'message' && item.role === 'assistant') {
        const msgContent = item.content as Array<Record<string, unknown>> | undefined
        if (msgContent) {
          for (const block of msgContent) {
            if (block.type === 'output_text') {
              textContent += (block.text as string) ?? ''
            } else if (block.type === 'reasoning') {
              reasoningContent += (block.summary
                ? (block.summary as Array<Record<string, unknown>>).map((s) => s.text ?? '').join('')
                : (block.reasoning_text as string) ?? '')
            }
          }
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id ?? item.id,
          type: 'function',
          function: {
            name: item.name ?? '',
            arguments: item.arguments ?? '',
          },
        })
      }
    }
  }

  const finishMap: Record<string, string> = { completed: 'stop', incomplete: 'length' }
  const finishReason = finishMap[status] ?? 'stop'

  const message: Record<string, unknown> = { role: 'assistant', content: textContent }
  if (reasoningContent) message.reasoning_content = reasoningContent
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: responsesBody.model as string ?? '',
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: (usage?.input_tokens as number) ?? 0,
      completion_tokens: (usage?.output_tokens as number) ?? 0,
      total_tokens: ((usage?.input_tokens as number) ?? 0) + ((usage?.output_tokens as number) ?? 0),
    },
  }
}
