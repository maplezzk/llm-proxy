import type { RouterResult } from './types.js'
import type { Logger } from '../log/logger.js'
import { createHash } from 'node:crypto'
import { sanitizeApiBase } from '../lib/http-utils.js'

/**
 * OpenAI reasoning_effort → Anthropic thinking.budget_tokens 映射表。
 * 仅在上游是 Anthropic 且未配置 budget_tokens 时生效。
 * 值参考 Claude 4 系列模型的常见档位：min ≈ 1024，max ≈ 64000。
 */
const REASONING_EFFORT_TO_BUDGET: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768,
  max: 65536,
}

// --- CodexToolContext (CCX-style lookup table for namespace/custom tool remapping) ---

interface CodexToolFunctionSpec {
  namespace: string
  name: string
}

/**
 * Build a lookup table of namespace function tools from the original request tools array.
 * CCX's BuildCodexToolContext scans tools and records namespace children.
 */
export function buildNamespaceToolContext(tools: unknown[]): Map<string, CodexToolFunctionSpec> {
  const ctx = new Map<string, CodexToolFunctionSpec>()
  if (!Array.isArray(tools)) return ctx

  for (const raw of tools) {
    const t = raw as Record<string, unknown>
    if (t.type === 'namespace') {
      const namespaceName = t.name as string ?? ''
      const children = t.tools as unknown[] | undefined
      if (!namespaceName || !children) continue
      for (const child of children) {
        const childItem = child as Record<string, unknown>
        if (childItem.type !== 'function') continue
        const childName = childItem.name as string
        if (!childName) continue
        // CCX convention: namespace__name (namespace ends with __ → no extra separator)
        const flatName = namespaceName.endsWith('__') ? `${namespaceName}${childName}` : `${namespaceName}__${childName}`
        ctx.set(flatName, { namespace: namespaceName, name: childName })
      }
    }
  }
  return ctx
}

/**
 * Remap namespace function calls in a response output array.
 * CCX's RemapNamespaceFunctionCallsInResponse uses the context to add namespace field.
 */
export function remapNamespaceFunctionCalls(
  output: Array<Record<string, unknown>>,
  namespaceCtx: Map<string, CodexToolFunctionSpec>
): void {
  if (!namespaceCtx.size) return
  for (const item of output) {
    if (item.type !== 'function_call') continue
    const name = item.name as string
    if (!name) continue
    const spec = namespaceCtx.get(name)
    if (!spec) continue
    item.name = spec.name
    item.namespace = spec.namespace
  }
}

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
  const result: unknown[] = []
  for (const t of tools) {
    const item = t as Record<string, unknown>
    const type = String(item.type ?? '')

    // OpenAI Responses built-in: computer_use_preview → Anthropic computer_20251124
    if (type.startsWith('computer_use_preview')) {
      result.push({
        type: 'computer_20251124',
        name: 'computer',
        display_width_px: (item.display_width ?? item.display_width_px) as number | undefined,
        display_height_px: (item.display_height ?? item.display_height_px) as number | undefined,
        display_number: item.display_number as number | undefined,
      })
      continue
    }

    // OpenAI built-in tools with no Anthropic equivalent → skip
    if (['web_search_preview', 'web_search', 'code_interpreter', 'file_search'].includes(type)) {
      continue
    }

    // OpenAI namespace tools → flatten to individual Anthropic tools
    // (same approach as convertToolsToOpenAI, using Anthropic tool format)
    if (type === 'namespace') {
      const nsName = item.name as string ?? ''
      const children = item.tools as Array<Record<string, unknown>> | undefined
      if (children) {
        for (const child of children) {
          const childType = child.type as string ?? ''
          const childName = (child.name ?? (child.function as Record<string, unknown> | undefined)?.name) as string ?? ''
          if (!childName) continue
          // CCX convention: namespace ends with __, so direct concatenation
          const flatName = nsName.endsWith('__') ? `${nsName}${childName}` : `${nsName}__${childName}`
          if (childType === 'function') {
            const fn = child.function as Record<string, unknown> | undefined
            const params = fn?.parameters ?? child.parameters ?? {}
            result.push({
              name: flatName,
              description: ((fn?.description ?? child.description ?? '') as string) || undefined,
              input_schema: params as Record<string, unknown>,
            })
          } else {
            // Non-function child tools: use child data directly
            result.push({
              name: flatName,
              description: (child.description as string) || undefined,
              input_schema: (child.input_schema ?? child.parameters ?? {}) as Record<string, unknown>,
            })
          }
        }
      }
      continue
    }

    // OpenAI Chat format: { type: "function", function: { name, description, parameters } }
    if (type === 'function' && item.function) {
      const fn = item.function as Record<string, unknown>
      result.push({
        name: fn.name ?? '',
        description: (fn.description as string) || undefined,
        input_schema: fn.parameters ?? {},
      })
      continue
    }

    // OpenAI Responses flat format: { type: "function", name, description, parameters } (no "function" wrapper)
    if (type === 'function' && item.name) {
      result.push({
        name: item.name ?? '',
        description: (item.description as string) || undefined,
        input_schema: (item.parameters as Record<string, unknown>) ?? {},
      })
      continue
    }

    // Already Anthropic format: { name, input_schema }
    if (item.name && item.input_schema) {
      result.push(item)
      continue
    }
  }
  return result.length > 0 ? result : undefined
}

function convertToolsToOpenAI(tools: unknown[]): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const result: unknown[] = []
  for (const t of tools) {
    const item = t as Record<string, unknown>
    const type = String(item.type ?? '')

    // Anthropic built-in: computer_2025* (versioned type) → OpenAI computer_use_preview
    // Must be checked BEFORE the strip below (computer_use_preview keywords overlap)
    if (type.startsWith('computer_20')) {
      result.push({
        type: 'computer_use_preview',
        display_width: (item.display_width_px ?? item.display_width) as number | undefined,
        display_height: (item.display_height_px ?? item.display_height) as number | undefined,
        display_number: item.display_number as number | undefined,
      })
      continue
    }

    // CCX stripCodexClientOnlyTools: drop non-function tool types (except namespace)
    // Namespace tools are flattened below (CCX's namespaceToolsToOpenAI)
    if (['custom', 'web_search', 'web_search_preview', 'computer_use', 'computer_use_preview',
          'local_shell', 'code_interpreter', 'file_search'].includes(type)) {
      continue
    }

    // CCX namespaceToolsToOpenAI: flatten namespace tools to OpenAI function tools
    // e.g. namespace "mcp__computer_use__" with child "get_app_state" → tool "mcp__computer_use__get_app_state"
    if (type === 'namespace') {
      const nsName = item.name as string ?? ''
      const nsDesc = item.description as string ?? ''
      const children = item.tools as unknown[] | undefined
      if (nsName && children) {
        for (const child of children) {
          const childItem = child as Record<string, unknown>
          if (childItem.type !== 'function') continue
          const childName = childItem.name as string
          if (!childName) continue
          const childFn = childItem.function as Record<string, unknown> | undefined
          const childDesc = (childFn?.description as string) ?? (childItem.description as string) ?? ''
          const childParams = (childFn?.parameters ?? childItem.parameters) as Record<string, unknown> ?? {}
          // CCX flattenNamespaceToolName: namespace ends with __ → no extra separator
          const flatName = nsName.endsWith('__') ? `${nsName}${childName}` : `${nsName}__${childName}`
          // CCX combineNamespaceDescription
          const combinedDesc = nsDesc && childDesc ? `${nsDesc}\n\n${childDesc}` : (nsDesc || childDesc || undefined)
          result.push({
            type: 'function',
            function: {
              name: flatName,
              description: combinedDesc,
              parameters: childParams,
            },
          })
        }
      }
      continue
    }

    // Anthropic format: { name, description, input_schema }
    if (item.name && item.input_schema) {
      result.push({
        type: 'function',
        function: {
          name: item.name,
          description: (item.description as string) || undefined,
          parameters: item.input_schema,
        },
      })
      continue
    }

    // OpenAI Responses flat format: { type: "function", name, parameters } → wrap in "function" for Chat Completions
    if (type === 'function' && item.name && !item.function) {
      result.push({
        type: 'function',
        function: {
          name: item.name ?? '',
          description: (item.description as string) || undefined,
          parameters: (item.parameters as Record<string, unknown>) ?? {},
        },
      })
      continue
    }

    // Already valid Chat format (type: "function" with nested "function") → keep
    if (type === 'function' && item.function) {
      result.push(item)
      continue
    }
    // Unknown tool type → skip (OpenAI Chat only accepts type: "function")
  }
  return result.length > 0 ? result : undefined
}

function convertToolChoiceToAnthropic(toolChoice: unknown): unknown {
  if (toolChoice === undefined || toolChoice === null) return undefined
  if (typeof toolChoice === 'string') {
    // OpenAI "required" → Anthropic "any"
    if (toolChoice === 'required') return { type: 'any' }
    // OpenAI "auto" → Anthropic { type: "auto" }
    if (toolChoice === 'auto') return { type: 'auto' }
    // OpenAI "none" → Anthropic { type: "none" }
    if (toolChoice === 'none') return { type: 'none' }
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
  // Anthropic: { type: "auto" } → OpenAI: "auto"
  // Anthropic: { type: "none" } → OpenAI: "none"
  // Anthropic: { type: "any" } → OpenAI: "required"
  const tc = toolChoice as Record<string, unknown>
  if (tc.type === 'tool') {
    return { type: 'function', function: { name: tc.name } }
  }
  if (tc.type === 'any') return 'required'
  if (tc.type === 'auto') return 'auto'
  if (tc.type === 'none') return 'none'
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
            // Responses input_image 实际是三种形态：
            // 1) { image_url: "https://..." 或 "data:..." } （string）
            // 2) { image_url: { url, detail } }            （object 形式）
            // 3) { file_id: "file-xxx" }                  （Files API 上传后引用）
            // 优先用 image_url，无则用 file_id 降级为占位文本
            const fileId = block.file_id as string | undefined
            const rawImageUrl = block.image_url
            let imageUrl: string | undefined
            if (typeof rawImageUrl === 'string') {
              imageUrl = rawImageUrl
            } else if (rawImageUrl && typeof rawImageUrl === 'object') {
              imageUrl = (rawImageUrl as Record<string, unknown>).url as string | undefined
            }
            if (imageUrl) {
              return { type: 'image', source: { type: 'url', url: imageUrl } }
            }
            if (fileId) {
              return { type: 'text', text: `[image:file_id=${fileId}]` }
            }
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
      // 如果上一条是 assistant 且有 tool_calls，把 content 合并过去（避免连续 assistant 消息）
      const lastMsg = messages.length > 0 ? messages[messages.length - 1] as Record<string, unknown> : null
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.tool_calls && it.role === 'assistant') {
        const text = typeof normalizedContent === 'string' ? normalizedContent : ''
        if (text) lastMsg.content = text
        // 如果 content 是空数组或空字符串，content 保持 null（OpenAI tool_calls 规范需要 content: null）
        continue
      }
      messages.push({ role: it.role, content: normalizedContent })
    } else if (it.type === 'function_call') {
      // { type: "function_call", call_id, name, arguments, namespace? }
      // Encode namespace in function name using `__` prefix convention (CCX-compatible)
      let fnName = it.name as string ?? ''
      const namespace = it.namespace as string | undefined
      if (namespace) {
        // CCX convention: if namespace ends with __, don't add separator
        fnName = namespace.endsWith('__') ? `${namespace}${fnName}` : `${namespace}__${fnName}`
      }

      // 检查上一条消息是否是 assistant 消息，如果是则合并 tool_calls，避免两条连续 assistant 消息
      const lastMsg = messages.length > 0 ? messages[messages.length - 1] as Record<string, unknown> : null
      const tcEntry: Record<string, unknown> = {
        id: it.call_id ?? it.id,
        type: 'function',
        function: { name: fnName, arguments: it.arguments ?? '' },
      }

      if (lastMsg && lastMsg.role === 'assistant') {
        if (!lastMsg.tool_calls) lastMsg.tool_calls = []
        ;(lastMsg.tool_calls as unknown[]).push(tcEntry)
        // 确保 content 不为 undefined（OpenAI 要求 tool_calls 时 content 为 null）
        if (lastMsg.content === undefined) lastMsg.content = null
      } else {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [tcEntry],
        })
      }
    } else if (it.type === 'reasoning') {
      // { type: "reasoning", summary, content } → skip (not a message type in Chat format)
      continue
    } else if (it.type === 'function_call_output') {
      // { type: "function_call_output", call_id, output: string | array of content blocks }
      let outputContent = it.output ?? ''
      // Normalize Responses content blocks to Anthropic-compatible format
      if (Array.isArray(outputContent)) {
        outputContent = (outputContent as Array<Record<string, unknown>>).map((block) => {
          if (block.type === 'input_text') {
            return { type: 'text', text: block.text }
          }
          if (block.type === 'output_text') {
            return { type: 'text', text: block.text }
          }
          if (block.type === 'input_image') {
            // 与 user 消息中的 input_image 处理保持一致
            const fileId = block.file_id as string | undefined
            const rawImageUrl = block.image_url
            let imageUrl: string | undefined
            if (typeof rawImageUrl === 'string') {
              imageUrl = rawImageUrl
            } else if (rawImageUrl && typeof rawImageUrl === 'object') {
              imageUrl = (rawImageUrl as Record<string, unknown>).url as string | undefined
            }
            if (imageUrl) {
              return { type: 'image', source: { type: 'url', url: imageUrl } }
            }
            if (fileId) {
              return { type: 'text', text: `[image:file_id=${fileId}]` }
            }
            return { type: 'text', text: '[image]' }
          }
          return block
        })
      }
      messages.push({
        role: 'tool',
        tool_call_id: it.call_id,
        content: outputContent,
      })
    } else if (it.type === 'computer_call_output') {
      // { type: "computer_call_output", call_id, output: { type: "computer_screenshot", image_url } }
      const output = it.output as Record<string, unknown> | undefined
      const imageUrl = output?.image_url as string | undefined
      const fileId = output?.file_id as string | undefined
      const content = imageUrl
        ? [{ type: 'image', source: { type: 'url', url: imageUrl } }]
        : fileId
          ? [{ type: 'text', text: '[screenshot from file_id]' }]
          : ''
      messages.push({
        role: 'tool',
        tool_call_id: it.call_id,
        content,
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
 * 把 OpenAI Chat Completions 风格的 image_url 块转成 OpenAI Responses 的 input_image 块。
 * Chat: { type: "image_url", image_url: { url: "https://..." 或 "data:...", detail: "auto" } }
 * Responses: { type: "input_image", image_url: "https://..." 或 "data:...", detail: "auto"? }
 * Responses 的 image_url 字段是 string（Chat 的是 object），detail 是平级属性。
 * 其它块原样透传。
 */
function convertOpenAIChatImageUrlToResponsesInputImage(block: Record<string, unknown>): Record<string, unknown> {
  if (block.type === 'image_url') {
    const imageUrl = block.image_url
    let url: string | undefined
    let detail: string | undefined
    if (typeof imageUrl === 'string') {
      url = imageUrl
    } else if (imageUrl && typeof imageUrl === 'object') {
      const obj = imageUrl as Record<string, unknown>
      url = obj.url as string | undefined
      detail = obj.detail as string | undefined
    }
    if (url) {
      const result: Record<string, unknown> = {
        type: 'input_image',
        image_url: url,
      }
      if (detail) result.detail = detail
      return result
    }
    return { type: 'input_text', text: '[image]' }
  }
  return block
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
      // Check for Anthropic tool_result blocks in user message content array
      const content = m.content
      if (m.role === 'user' && Array.isArray(content)) {
        const blocks = content as Array<Record<string, unknown>>
        const toolResults = blocks.filter((b) => b.type === 'tool_result')
        const otherBlocks = blocks.filter((b) => b.type !== 'tool_result')

        // Emit computer_call_output for tool_results with image content
        for (const tr of toolResults) {
          const trContent = tr.content
          let imageUrl: string | undefined
          let fileId: string | undefined
          if (Array.isArray(trContent)) {
            const imgBlock = (trContent as Array<Record<string, unknown>>).find(
              (b) => b.type === 'image'
            )
            if (imgBlock) {
              const src = imgBlock.source as Record<string, unknown> | undefined
              if (src?.type === 'url') {
                imageUrl = src.url as string
              } else {
                fileId = imgBlock.file_id as string | undefined
              }
            }
          }
          if (imageUrl) {
            input.push({
              type: 'computer_call_output',
              call_id: tr.tool_use_id as string,
              output: { type: 'computer_screenshot', image_url: imageUrl },
            })
          } else if (fileId) {
            input.push({
              type: 'computer_call_output',
              call_id: tr.tool_use_id as string,
              output: { type: 'computer_screenshot', file_id: fileId },
            })
          } else {
            // tool_result without image → function_call_output
            input.push({
              type: 'function_call_output',
              call_id: tr.tool_use_id as string,
              output: typeof trContent === 'string' ? trContent : JSON.stringify(trContent),
            })
          }
        }

        // Emit remaining non-tool_result blocks as message items
        if (otherBlocks.length > 0) {
          // 转换 Anthropic image 块 和 OpenAI Chat image_url 块 → Responses input_image 块
          const blocks = (otherBlocks as Array<Record<string, unknown>>).map((b) => {
            // Anthropic 风格的 image 块
            if (b.type === 'image' && (b as Record<string, unknown>).source) {
              const source = (b as Record<string, unknown>).source as Record<string, unknown>
              if (source.type === 'url' && source.url) {
                return { type: 'input_image', image_url: source.url as string }
              }
              if (source.type === 'base64' && source.data) {
                const mediaType = (source.media_type as string) || 'image/png'
                return { type: 'input_image', image_url: `data:${mediaType};base64,${source.data}` }
              }
              return { type: 'input_text', text: '[image]' }
            }
            // OpenAI Chat 风格的 image_url 块
            return convertOpenAIChatImageUrlToResponsesInputImage(b)
          })
          const textBlocks = blocks.filter((b) => b.type === 'text' || b.type === 'input_text')
          const text = textBlocks.map((b) => (b.text as string) ?? '').join('')
          if (text || blocks.length !== textBlocks.length) {
            input.push({
              type: 'message',
              role: m.role ?? 'user',
              content: blocks,
            })
          }
        }
      } else {
        // user, developer, etc. (non-Anthropic format)
        // content 数组中可能有 OpenAI Chat 风格的 image_url 块，需转成 Responses 的 input_image
        if (Array.isArray(m.content)) {
          const blocks = (m.content as Array<Record<string, unknown>>).map(convertOpenAIChatImageUrlToResponsesInputImage)
          const textBlocks = blocks.filter((b) => b.type === 'text' || b.type === 'input_text')
          const allText = blocks.every((b) => b.type === 'text' || b.type === 'input_text')
          if (allText) {
            // 全部文本 → 用 Responses 的 input_text 块 (更规范)
            input.push({ type: 'message', role: m.role ?? 'user', content: blocks })
          } else if (textBlocks.length > 0 || blocks.length > 0) {
            input.push({ type: 'message', role: m.role ?? 'user', content: blocks })
          }
        } else {
          input.push({ type: 'message', role: m.role ?? 'user', content: m.content })
        }
      }
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

/**
 * 从请求体中提取 reasoning 配置，统一三种协议的格式。
 * - Anthropic: thinking: { type, budget_tokens }
 * - OpenAI: reasoning_effort: "low"|"medium"|"high"
 * - Responses: reasoning: { effort, summary } 或 reasoning_effort
 */
function resolveReasoning(body: Record<string, unknown>): FullParams['reasoning'] {
  // Responses 新格式: reasoning: { effort: "medium", summary: "auto" }
  const reasoning = body.reasoning as Record<string, unknown> | undefined
  if (reasoning) {
    return { effort: reasoning.effort as string | undefined, summary: reasoning.summary as string | undefined }
  }
  // 旧版兼容: reasoning_effort 字符串
  const effort = body.reasoning_effort as string | undefined
  if (effort) return effort
  // Anthropic thinking（跨协议后存为 FullParams，走 reasoning 字段时不会到这儿）
  return undefined
}

/** 从 FullParams.reasoning 中提取 effort 字符串（跨协议时供 Anthropic 上游查表使用） */
function extractClientReasoningEffort(reasoning: FullParams['reasoning']): string | undefined {
  if (!reasoning) return undefined
  if (typeof reasoning === 'string') return reasoning
  return reasoning.effort
}

// --- Full parameter mapping ---

interface FullParams {
  model: string
  messages: unknown[]
  system?: unknown
  reasoning?: { effort?: string; summary?: string } | string
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
    reasoning: resolveReasoning(body),
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

/**
 * 把 OpenAI Chat Completions 风格的 content 块（image_url）转成 Anthropic 风格的 content 块（image）。
 * Chat API 的 image_url 必须是对象 { url, detail? }，但也兼容裸 string（历史 SDK/代理常见）。
 * 不识别的块原样透传。
 */
function convertOpenAIContentBlockToAnthropic(block: Record<string, unknown>): Record<string, unknown> {
  if (block.type === 'image_url') {
    const imageUrl = block.image_url
    let url: string | undefined
    if (typeof imageUrl === 'string') {
      url = imageUrl
    } else if (imageUrl && typeof imageUrl === 'object') {
      url = (imageUrl as Record<string, unknown>).url as string | undefined
    }
    if (url) {
      return { type: 'image', source: { type: 'url', url } }
    }
    return { type: 'text', text: '[image]' }
  }
  if (block.type === 'text') {
    return { type: 'text', text: (block.text as string) ?? '' }
  }
  return block
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
          // content 可以是字符串、Anthropic 风格 content 数组、OpenAI 风格 content 数组
          // OpenAI 风格里可能有 image_url 块，需要转成 Anthropic image 块
          content: typeof cur.content === 'string'
            ? cur.content
            : Array.isArray(cur.content)
              ? (cur.content as Array<Record<string, unknown>>).map(convertOpenAIContentBlockToAnthropic)
              : JSON.stringify(cur.content),
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
      // user / system 消息的 content 数组中可能有 OpenAI Chat 风格的 image_url 块，
      // 需要转成 Anthropic image 块；其它块原样透传
      if (Array.isArray(m.content)) {
        const converted = (m.content as Array<Record<string, unknown>>).map(convertOpenAIContentBlockToAnthropic)
        // 整条内容中所有块都是 text 时可以压平为字符串（Anthropic 接受 string content）
        if (converted.every((b) => b.type === 'text')) {
          result.push({ ...m, content: (converted as Array<Record<string, unknown>>).map((b) => b.text ?? '').join('') })
        } else {
          result.push({ ...m, content: converted })
        }
        i++
        continue
      }
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

/** 确保 Anthropic messages 中每条 assistant 消息的 content 数组第一个 block 是 thinking */
function ensureThinkingBlock(messages: unknown[]): void {
  for (const msg of messages) {
    const m = msg as Record<string, unknown>
    if (m.role !== 'assistant') continue
    const content = m.content as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(content)) continue
    if (content.length === 0 || content[0].type !== 'thinking') {
      content.unshift({ type: 'thinking', thinking: '', signature: '' })
    }
  }
}

function buildAnthropicFromOpenAI(params: FullParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.max_tokens ?? 16384,
    messages: convertMessagesToAnthropic(params.messages as unknown[]),
  }
  if (params.system) body.system = params.system
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.stream !== undefined) body.stream = params.stream
  if (params.top_p !== undefined) body.top_p = params.top_p
  if (params.stop) body.stop_sequences = params.stop
  if (params.tools) body.tools = convertToolsToAnthropic(params.tools)
  if (params.tool_choice !== undefined) body.tool_choice = convertToolChoiceToAnthropic(params.tool_choice)
  return body
}

/**
 * Anthropic image content block → OpenAI image_url content block.
 * - source.type === 'url': url 直接透传
 * - source.type === 'base64': 必须拼成 data:{media_type};base64,{data} 形式
 *   OpenAI Chat Completions API 的 image_url.url 不接受裸 base64
 * - 都没有：返回 null（调用方自行降级为占位文本）
 */
function convertAnthropicImageToOpenAIImageUrl(block: Record<string, unknown>): Record<string, unknown> | null {
  const source = block.source as Record<string, unknown> | undefined
  if (!source) return null
  const sourceType = source.type as string | undefined
  if (sourceType === 'base64') {
    const mediaType = (source.media_type as string) || 'image/png'
    const data = (source.data as string) ?? ''
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } }
  }
  if (sourceType === 'url' || (source as { url?: unknown }).url) {
    return { type: 'image_url', image_url: { url: source.url as string } }
  }
  return null
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
          // tool_result.content 可能是：
          //   - 字符串（直接用）
          //   - Anthropic 风格 content 数组（text + image 块）→ 转 OpenAI tool 消息时
          //     单文本时压平为字符串，含 image 时保留为块数组以传递 image_url
          let toolContent: unknown
          if (typeof tr.content === 'string') {
            toolContent = tr.content
          } else if (Array.isArray(tr.content)) {
            const converted: Array<Record<string, unknown>> = []
            for (const b of tr.content as Array<Record<string, unknown>>) {
              if (b.type === 'image') {
                const imgPart = convertAnthropicImageToOpenAIImageUrl(b)
                if (imgPart) {
                  converted.push(imgPart)
                  continue
                }
                converted.push({ type: 'text', text: '[image]' })
                continue
              }
              if (b.type === 'text') {
                converted.push({ type: 'text', text: b.text as string })
                continue
              }
              // 其它未知块（如 OpenAI 的 image_url）原样保留
              converted.push(b)
            }
            // 只有单个 text 块时压平为字符串，与 OpenAI tool 消息惯例一致
            if (converted.length === 1 && converted[0].type === 'text') {
              toolContent = converted[0].text
            } else if (converted.length === 0) {
              toolContent = '[output]'
            } else {
              toolContent = converted
            }
          } else {
            toolContent = JSON.stringify(tr.content)
          }
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: toolContent,
          })
        }
        // Emit remaining user content if any
        // Convert Anthropic image blocks → OpenAI image_url format
        if (otherBlocks.length > 0) {
          const parts: Array<Record<string, unknown>> = []
          for (const b of otherBlocks as Array<Record<string, unknown>>) {
            if (b.type === 'image') {
              const imgPart = convertAnthropicImageToOpenAIImageUrl(b)
              if (imgPart) {
                parts.push(imgPart)
                continue
              }
              // 没 url/base64 → 降级为占位文本（不丢消息）
              parts.push({ type: 'text', text: '[image]' })
              continue
            }
            if (b.type === 'text') {
              parts.push({ type: 'text', text: b.text as string })
              continue
            }
            // 未知块类型：原样保留
            parts.push(b)
          }
          // If single text part, collapse to string
          if (parts.length === 1 && parts[0].type === 'text') {
            result.push({ role: 'user', content: parts[0].text })
          } else {
            result.push({ role: 'user', content: parts })
          }
        }
        continue
      }
    }
    // Handle tool messages with array content (e.g., computer_call_output screenshots)
    // OpenAI Chat Completions supports image_url blocks in tool messages (gpt-4-vision+),
    // so we convert Anthropic image blocks to image_url blocks instead of degrading to text.
    if (m.role === 'tool' && Array.isArray(m.content)) {
      const blocks = m.content as Array<Record<string, unknown>>
      const parts: Array<Record<string, unknown>> = []
      for (const b of blocks) {
        if (b.type === 'text') {
          parts.push({ type: 'text', text: b.text as string })
        } else if (b.type === 'image') {
          const imgPart = convertAnthropicImageToOpenAIImageUrl(b)
          if (imgPart) {
            parts.push(imgPart)
          } else {
            // 缺 url/base64 → 降级为占位文本
            parts.push({ type: 'text', text: '[image]' })
          }
        } else {
          // 未知块类型：原样保留
          parts.push(b)
        }
      }
      if (parts.length === 1 && parts[0].type === 'text') {
        result.push({ role: 'tool', tool_call_id: m.tool_call_id, content: parts[0].text })
      } else {
        result.push({ role: 'tool', tool_call_id: m.tool_call_id, content: parts })
      }
      continue
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
      const converted: Record<string, unknown> = { role: 'assistant', content: textContent, reasoning_content: reasoningContent || '' }
      if (thinkingSignature) converted.reasoning_signature = thinkingSignature
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
    // 确保所有 assistant 消息都有 reasoning_content（即使为空）
    if (m.role === 'assistant') {
      const cloned = { ...m }
      if (cloned.reasoning_content === undefined) cloned.reasoning_content = ''
      result.push(cloned)
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
  // Pass reasoning to upstream Chat Completions (extracted from inbound request)
  if (params.reasoning) {
    if (typeof params.reasoning === 'string') {
      body.reasoning_effort = params.reasoning
    } else if (params.reasoning.effort) {
      body.reasoning_effort = params.reasoning.effort
    }
  }
  if (params.max_tokens !== undefined) body.max_tokens = params.max_tokens
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.stream !== undefined) body.stream = params.stream
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
    reasoning: resolveReasoning(body),
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
    max_tokens: params.max_tokens ?? 16384,
    messages: convertMessagesToAnthropic(params.messages as unknown[]),
  }
  if (params.system) body.system = params.system
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.stream !== undefined) body.stream = params.stream
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
  // Pass reasoning from client request (Responses uses { effort, summary } object format)
  if (params.reasoning) {
    if (typeof params.reasoning === 'string') {
      body.reasoning = { effort: params.reasoning }
    } else {
      body.reasoning = { ...params.reasoning }
    }
  }
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.max_tokens !== undefined) body.max_output_tokens = params.max_tokens
  if (params.stream !== undefined) body.stream = params.stream
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

  const apiBase = sanitizeApiBase(route.apiBase)
  const url = `${apiBase}/v1/${upstreamEndpoint}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (route.providerType === 'anthropic') {
    headers['x-api-key'] = route.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers['Authorization'] = `Bearer ${route.apiKey}`
  }

  if (sameProtocol) {
    const upstreamBody: Record<string, unknown> = { ...body, model: route.modelId }
    // 客户端没传 stream 时，用路由级默认值（未配置则默认流式 true）
    if (upstreamBody.stream === undefined) {
      upstreamBody.stream = route.stream ?? true
    }
    // max_tokens: 0 → 不传（让上游用默认值）, 应用路由级默认值
    sanitizeMaxTokens(upstreamBody, route)
    injectThinkingConfig(upstreamBody, route)
    // thinking 模式检测：配置开启了 或 消息中已有 thinking 块，都需要补全
    if (route.providerType === 'anthropic') {
      const msgs = upstreamBody.messages as Array<Record<string, unknown>> | undefined
      if (msgs) {
        if (hasThinkingInMessages(msgs)) {
          ensureThinkingBlocks(msgs)
        }
        ensureThinkingBlock(msgs)
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

  // Strip Codex-internal MCP probe tools BEFORE any builder sees them.
  // These tools trigger MCP server calls (resources/list, resources/read, etc.) when
  // returned as function_calls. They are generated by Codex for Responses API's server-side
  // MCP handling and don't work with non-Responses upstreams.
  //
  // NOTE: namespace tools (mcp__computer_use__ etc.) are NOT stripped here.
  // They are flattened to function tools in convertToolsToOpenAI (like CCX's namespaceToolsToOpenAI).
  //
  // NOTE: exec_command is Codex's built-in bash execution tool and should NOT be stripped.
  if (params.tools && inboundType === 'openai-responses') {
    const mcpPrefixes = ['list_mcp_', 'read_mcp_', 'write_mcp_', 'subscribe_mcp_']
    params.tools = (params.tools as unknown[]).filter((t) => {
      if (typeof t === 'string') return true
      const item = t as Record<string, unknown>
      // Check by tool name AND nested function name (Chat format)
      const itemName = String(item.name ?? (item.function as Record<string, unknown> | undefined)?.name ?? '')
      if (mcpPrefixes.some((p) => itemName.startsWith(p))) return false
      return true
    })
    // Strip only by name — type-based stripping stays in convertToolsToOpenAI
    // (computer_use_preview is valid for Anthropic path, dropped only for Chat path)
    if (params.tools.length === 0) delete params.tools
  }

  params.model = route.modelId
  // max_tokens: 0 → undefined（不传，让 builder 走默认值）, 应用路由级默认值
  if (params.max_tokens === 0) params.max_tokens = undefined
  if (params.max_tokens === undefined && route.max_tokens !== undefined) {
    params.max_tokens = route.max_tokens
  }

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

  // max_tokens 二次兜底，处理 builder 中可能遗留的 0
  sanitizeMaxTokens(upstreamBody, route)
  // 注入 thinking 配置到转换后的请求体（跨协议场景下携带客户端的 reasoning_effort）
  const clientReasoningEffort = extractClientReasoningEffort(params.reasoning)
  injectThinkingConfig(upstreamBody, route, clientReasoningEffort)
  // 客户端没传 stream 时，用路由级默认值（未配置则默认流式 true）
  if (upstreamBody.stream === undefined) {
    upstreamBody.stream = route.stream ?? true
  }
  // thinking 模式检测：配置开启了 或 消息中已有 thinking 块，都需要补全
  if (route.providerType === 'anthropic') {
    const msgs = upstreamBody.messages as Array<Record<string, unknown>> | undefined
    if (msgs) {
      if (hasThinkingInMessages(msgs)) {
        ensureThinkingBlocks(msgs)
      }
      ensureThinkingBlock(msgs)
    }
  }

  // 扫描 input_image 降级为 file_id 占位文本的条目（image_url/file_id 都不存在，或只有 file_id），
  // 这些条目在上游会丢失真实图片，需要 warn 提示用户考虑改用 image_url
  if (logger) {
    const degradedFileIds = findDegradedFileIdPlaceholders(upstreamBody)
    if (degradedFileIds.length > 0) {
      logger.log('request', `图片降级警告: ${degradedFileIds.length} 张图片因 Responses API file_id 无法在跨协议请求中传递`, {
        fileIds: degradedFileIds,
        inboundType,
        providerType: route.providerType,
      }, 'warn')
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
    if (content.length === 0 || content[0].type !== 'thinking') {
      content.unshift({ type: 'thinking', thinking: '', signature: '' })
    }
  }
}

/**
 * 扫描转换后的请求体，找出 input_image 因 file_id 降级生成的 `[image:file_id=xxx]` 占位文本。
 * 返回的 file_id 列表用于在 logger 中提示用户：跨协议路径无法传递 Files API 引用，
 * 上游只会看到文字占位。调用方应在 logger?.log 中 warn 出来。
 */
function findDegradedFileIdPlaceholders(body: unknown): string[] {
  const fileIds: string[] = []
  const seen = new WeakSet<object>()
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (seen.has(node as object)) return
    seen.add(node as object)
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    const obj = node as Record<string, unknown>
    if (typeof obj.text === 'string') {
      const re = /\[image:file_id=([^\]]+)\]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(obj.text)) !== null) {
        fileIds.push(m[1])
      }
    }
    for (const v of Object.values(obj)) visit(v)
  }
  visit(body)
  return fileIds
}

/**
 * 归一化 max_tokens：0 → 不传（让上游用默认值），应用路由级默认值。
 * 同协议和跨协议路径都调用此函数。
 */
function sanitizeMaxTokens(
  upstreamBody: Record<string, unknown>,
  route: RouterResult
): void {
  // 0 或负数 → 不传
  if (typeof upstreamBody.max_tokens === 'number' && upstreamBody.max_tokens <= 0) {
    delete upstreamBody.max_tokens
  }
  // 没传且路由有默认值 → 用路由的
  if (upstreamBody.max_tokens === undefined && route.max_tokens !== undefined) {
    upstreamBody.max_tokens = route.max_tokens
  }
}

/**
 * 根据路由配置的 thinking 参数，注入到上游请求体中。
 * 同协议和跨协议路径都调用此函数。
 *
 * 上游是 Anthropic 时，thinking 的 budget_tokens 来源优先级：
 *   1. route.thinking.budget_tokens（用户配置优先）
 *   2. route.thinking.reasoning_effort（查表映射）
 *   3. 客户端请求的 reasoning_effort（仅跨协议路径，查表映射）
 *
 * @param clientReasoningEffort 客户端请求里的 reasoning_effort（跨协议时可用）
 */
function injectThinkingConfig(
  upstreamBody: Record<string, unknown>,
  route: RouterResult,
  clientReasoningEffort?: string
): void {
  if (route.providerType === 'anthropic') {
    // 解析 budget_tokens 来源：用户配的 budget_tokens > 用户配的 reasoning_effort > 客户端的 reasoning_effort
    let budget: number | undefined
    if (route.thinking?.budget_tokens) {
      budget = route.thinking.budget_tokens
    } else if (route.thinking?.reasoning_effort) {
      budget = REASONING_EFFORT_TO_BUDGET[route.thinking.reasoning_effort]
    } else if (clientReasoningEffort) {
      budget = REASONING_EFFORT_TO_BUDGET[clientReasoningEffort]
    }

    if (budget) {
      upstreamBody.thinking = { type: 'enabled', budget_tokens: budget }
      // 确保 max_tokens >= budget_tokens，否则 Anthropic API 会报错
      if (!upstreamBody.max_tokens || (upstreamBody.max_tokens as number) < budget) {
        upstreamBody.max_tokens = budget
      }
    } else if (route.thinking?.type) {
      // 非标准 thinking.type（如 MiniMax adaptive）
      upstreamBody.thinking = { type: route.thinking.type }
      // 用户配置优先：清除客户端传的 reasoning/reasoning_effort，避免冲突
      delete upstreamBody.reasoning
      delete upstreamBody.reasoning_effort
    }
  } else if (route.thinking?.type) {
    // 上游不是 Anthropic：thinking.type 透传（适用于 MiniMax adaptive 等）
    upstreamBody.thinking = { type: route.thinking.type }
    delete upstreamBody.reasoning
    delete upstreamBody.reasoning_effort
  }

  if ((route.providerType === 'openai' || route.providerType === 'openai-responses') && route.thinking?.reasoning_effort) {
    if (route.providerType === 'openai-responses') {
      upstreamBody.reasoning = { effort: route.thinking.reasoning_effort }
    } else {
      upstreamBody.reasoning_effort = route.thinking.reasoning_effort
    }
    // 用户配置优先：清除客户端传的 thinking（如果是 type 冲突）
    if (upstreamBody.thinking && typeof upstreamBody.thinking === 'object') {
      const t = upstreamBody.thinking as Record<string, unknown>
      // 只清除 type 字段（budget_tokens 不是用户配置的，允许保留）
      if (t.type && !t.budget_tokens) {
        delete upstreamBody.thinking
      }
    }
  }
}

// --- Action mapping helpers (Computer Use) ---

/** OpenAI ComputerAction → Anthropic tool_use input */
export function convertActionToAnthropic(action: Record<string, unknown>): Record<string, unknown> {
  const type = action.type as string
  const result: Record<string, unknown> = { action: type }
  switch (type) {
    case 'click':
    case 'double_click':
    case 'drag':
      result.coordinate = [action.x as number, action.y as number]
      break
    case 'move':
      result.action = 'mouse_move'
      result.coordinate = [action.x as number, action.y as number]
      break
    case 'keypress':
      result.action = 'key'
      const keys = action.keys as string[] | undefined
      result.text = keys ? keys.join('') : ''
      break
    case 'scroll':
      result.coordinate = [action.x as number, action.y as number]
      result.scroll_x = action.scroll_x as number | undefined
      result.scroll_y = action.scroll_y as number | undefined
      break
    case 'type':
      result.text = (action.text as string) ?? ''
      break
    case 'wait':
      result.action = 'wait'
      result.duration = (action.ms as number) ?? (action.duration as number) ?? 0
      break
    case 'screenshot':
      break
    default:
      // Pass through unknown actions as-is
      Object.assign(result, action)
  }
  return result
}

/** Anthropic tool_use input → OpenAI ComputerAction */
export function convertActionToOpenAI(input: Record<string, unknown>): Record<string, unknown> {
  const action = input.action as string
  const coord = input.coordinate as [number, number] | undefined
  const result: Record<string, unknown> = {}
  switch (action) {
    case 'click':
    case 'double_click':
    case 'drag':
      result.type = action
      if (coord) {
        result.x = coord[0]
        result.y = coord[1]
      }
      break
    case 'mouse_move':
      result.type = 'move'
      if (coord) {
        result.x = coord[0]
        result.y = coord[1]
      }
      break
    case 'key':
      result.type = 'keypress'
      result.keys = [(input.text as string) ?? '']
      break
    case 'scroll':
      result.type = 'scroll'
      if (coord) {
        result.x = coord[0]
        result.y = coord[1]
      }
      result.scroll_x = input.scroll_x as number | undefined
      result.scroll_y = input.scroll_y as number | undefined
      break
    case 'type':
      result.type = 'type'
      result.text = (input.text as string) ?? ''
      break
    case 'wait':
      result.type = 'wait'
      result.ms = (input.duration as number) ?? 0
      break
    case 'screenshot':
      result.type = 'screenshot'
      break
    default:
      // Pass through unknown actions as-is
      result.type = action
      Object.assign(result, input)
  }
  return result
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

  // 提取顶层 reasoning.summary → Anthropic thinking 块（作为首个 content block）
  const topReasoning = responsesBody.reasoning as Record<string, unknown> | undefined
  if (topReasoning?.summary) {
    const summaryItems = topReasoning.summary as Array<Record<string, unknown>>
    const summaryText = summaryItems.map((s) => s.text ?? '').join('')
    if (summaryText) {
      content.push({ type: 'thinking', thinking: summaryText, signature: '' })
    }
  }

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
      } else if (item.type === 'computer_call') {
        // OpenAI computer_call → Anthropic tool_use with name "computer"
        const action = item.action as Record<string, unknown> | undefined
        content.push({
          type: 'tool_use',
          id: item.call_id ?? item.id,
          name: 'computer',
          input: action ? convertActionToAnthropic(action) : {},
        })
        stopReason = 'tool_use'
      } else if (['web_search_call', 'code_interpreter_call', 'file_search_call'].includes(item.type as string)) {
        // 忽略无 Anthropic 对应物的内置工具输出
        continue
      } else if (item.type === 'reasoning') {
        // Standalone reasoning output item → thinking block
        const summary = item.summary as Array<Record<string, unknown>> | undefined
        if (summary) {
          const reasonText = summary.map((s) => s.text ?? '').join('')
          if (reasonText) {
            content.push({ type: 'thinking', thinking: reasonText, signature: '' })
          }
        }
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
  let thinkingText = ''

  if (content) {
    for (const block of content) {
      if (block.type === 'text') {
        outputMessageContent.push({ type: 'output_text', text: block.text as string ?? '', annotations: [] })
      } else if (block.type === 'thinking') {
        // 收集 thinking 文本，稍后放到顶层的 reasoning.summary
        thinkingText += (block.thinking as string) ?? ''
      } else if (block.type === 'tool_use') {
        const name = block.name as string ?? ''
        if (name === 'computer') {
          // Computer use tool → computer_call output item
          const input = block.input as Record<string, unknown> ?? {}
          output.push({
            type: 'computer_call',
            id: `cc_${Date.now().toString(36)}_${(block.id as string) ?? ''}`,
            call_id: block.id as string,
            action: convertActionToOpenAI(input),
            pending_safety_checks: [],
            status: 'completed',
          })
        } else {
          // Regular tool_use → function_call
          // CCX always sets status: "completed" on function_call items
          output.push({
            type: 'function_call',
            id: `fc_${Date.now().toString(36)}_${(block.id as string) ?? ''}`,
            call_id: block.id as string,
            name,
            arguments: JSON.stringify(block.input ?? {}),
            status: 'completed',
          })
        }
      }
    }
  }

  // Message output item goes first (before function_call/computer_call items)
  // CCX compatibility: only add message item when there's actual content
  if (outputMessageContent.length > 0) {
    output.unshift({
      type: 'message',
      id: `msg_${Date.now().toString(36)}`,
      status: stopReason === 'end_turn' ? 'completed' : stopReason === 'max_tokens' ? 'incomplete' : 'completed',
      role: 'assistant',
      content: outputMessageContent,
    })
  }

  return {
    id: `resp_${Date.now().toString(36)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: stopReason === 'end_turn' ? 'completed' : 'incomplete',
    model: anthropicBody.model as string ?? '',
    output,
    // Anthropic thinking → 顶层 reasoning.summary（非完整推理文本）
    ...(thinkingText ? { reasoning: { summary: [{ type: 'summary_text', text: thinkingText, index: 0 }] } } : {}),
    usage: (() => {
      const ai = (usage?.input_tokens as number) ?? 0
      const cr = (usage?.cache_read_input_tokens as number) ?? 0
      const co = (usage?.output_tokens as number) ?? 0
      const inputTokens = ai + cr  // Anthropic input_tokens = 计费部分，不含缓存命中
      return {
        input_tokens: inputTokens,
        output_tokens: co,
        total_tokens: inputTokens + co,
      }
    })(),
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

  const message: Record<string, unknown> = { role: 'assistant', content: textContent, reasoning_content: reasoningContent || '' }
  if (thinkingSignature) message.reasoning_signature = thinkingSignature
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
    usage: (() => {
      const ai = (usage?.input_tokens as number) ?? 0
      const cr = (usage?.cache_read_input_tokens as number) ?? 0
      const co = (usage?.output_tokens as number) ?? 0
      const promptTokens = ai + cr  // Anthropic input_tokens = 计费部分，不含缓存命中
      const u: Record<string, unknown> = {
        prompt_tokens: promptTokens,
        completion_tokens: co,
        total_tokens: promptTokens + co,
      }
      const details: Record<string, unknown> = {}
      if (cr > 0) details.cached_tokens = cr
      if ((usage?.cache_creation_input_tokens as number) != null) details.cache_creation_input_tokens = usage?.cache_creation_input_tokens
      if (Object.keys(details).length > 0) u.prompt_tokens_details = details
      return u
    })(),
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

  // reasoning_content → 收集到变量，稍后放到顶层 reasoning.summary
  const reasoningText = message?.reasoning_content as string | undefined
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
        status: 'completed',
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
    // Chat reasoning_content → 顶层 reasoning.summary
    ...(reasoningText ? { reasoning: { summary: [{ type: 'summary_text', text: reasoningText, index: 0 }] } } : {}),
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

  // 提取顶层 reasoning.summary（标准 Responses 格式）
  const topReasoning = responsesBody.reasoning as Record<string, unknown> | undefined
  if (topReasoning?.summary) {
    const summaryItems = topReasoning.summary as Array<Record<string, unknown>>
    reasoningContent = summaryItems.map((s) => s.text ?? '').join('')
  }

  if (output) {
    for (const item of output) {
      if (item.type === 'message' && item.role === 'assistant') {
        const msgContent = item.content as Array<Record<string, unknown>> | undefined
        if (msgContent) {
          for (const block of msgContent) {
            if (block.type === 'output_text') {
              textContent += (block.text as string) ?? ''
            } else if (block.type === 'reasoning') {
              // 消息内嵌 reasoning（兼容格式），优先级低于顶层 summary
              if (!reasoningContent) {
                reasoningContent += (block.summary
                  ? (block.summary as Array<Record<string, unknown>>).map((s) => s.text ?? '').join('')
                  : (block.reasoning_text as string) ?? '')
              }
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
      } else if (item.type === 'computer_call') {
        // Computer call → Chat tool_calls (lossy conversion: serialize action as arguments)
        const action = item.action as Record<string, unknown> | undefined
        toolCalls.push({
          id: item.call_id ?? item.id,
          type: 'function',
          function: {
            name: 'computer',
            arguments: JSON.stringify(action ?? {}),
          },
        })
      } else if (['web_search_call', 'code_interpreter_call', 'file_search_call'].includes(item.type as string)) {
        // 无 Chat 对应物 → 跳过
        continue
      }
    }
  }

  const finishMap: Record<string, string> = { completed: 'stop', incomplete: 'length' }
  const finishReason = finishMap[status] ?? 'stop'

  const message: Record<string, unknown> = { role: 'assistant', content: textContent, reasoning_content: reasoningContent || '' }
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
