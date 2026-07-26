/**
 * Responses API 协议转换测试
 *
 * 覆盖完整 Responses API schema（基于 cc-switch 实现反向推导 + OpenAI 官方文档）：
 *   - 6 个 inbound 方向（Anthropic / Chat / Responses × Anthropic / Chat / Responses 上游）
 *   - 4 个 outbound 响应方向
 *   - 4 个流式转换路径
 *   - 关键边界：input_text vs output_text、reasoning item、refusal、computer_call、
 *     namespace 工具、parallel tool_results、未知 item type、null content
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import type { ServerResponse } from 'node:http'
import {
  transformInboundRequest,
  convertOpenAIResponsesToAnthropic,
  convertAnthropicResponseToOpenAIResponses,
  convertOpenAIResponseToOpenAIResponses,
  convertOpenAIResponsesResponseToOpenAI,
  convertAnthropicResponseToOpenAI,
  convertOpenAIResponseToAnthropic,
} from '../../src/proxy/translation.js'
import {
  convertOpenAIResponsesStreamToAnthropic,
  convertAnthropicStreamToOpenAIResponses,
  convertOpenAIResponsesStreamToOpenAI,
  convertOpenAIStreamToOpenAIResponses,
} from '../../src/proxy/stream-converter.js'

const anthropicRoute = {
  providerName: 'anthropic-main',
  providerType: 'anthropic' as const,
  apiKey: 'sk-ant-1',
  apiBase: 'https://api.anthropic.com',
  modelId: 'claude-sonnet-4',
}

const openaiRoute = {
  providerName: 'openai-main',
  providerType: 'openai' as const,
  apiKey: 'sk-openai-1',
  apiBase: 'https://api.openai.com',
  modelId: 'gpt-4o',
}

const openaiResponsesRoute = {
  providerName: 'openai-responses',
  providerType: 'openai-responses' as const,
  apiKey: 'sk-openai-1',
  apiBase: 'https://api.openai.com',
  modelId: 'o3-mini',
}

// ============================================================
// 流式 helper
// ============================================================

function makeReader(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  const stream = new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i++]))
    },
  })
  return stream.getReader()
}

function makeResponse(): { chunks: string[]; res: ServerResponse } {
  const chunks: string[] = []
  const res = {
    write: (data: string) => { chunks.push(data) },
    end: (data?: string) => { if (data) chunks.push(data); chunks.push('__END__') },
    writeHead: () => {},
    setHeader: () => {},
    getHeader: () => undefined,
  } as unknown as ServerResponse
  return { chunks, res }
}

function sseEvents(chunks: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const block of chunks.join('').split('\n\n')) {
    if (!block.trim()) continue
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
    if (!dataLine) continue
    const dataStr = dataLine.slice(6)
    if (dataStr === '[DONE]') {
      out.push({ type: '__DONE__' })
      continue
    }
    try {
      out.push(JSON.parse(dataStr) as Record<string, unknown>)
    } catch { /* ignore */ }
  }
  return out
}

// ============================================================
// 1. Anthropic → Responses
// ============================================================

describe('proxy/responses-protocol — Anthropic → OpenAI Responses (inbound)', () => {
  it('user 字符串消息 → input.message.input_text', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.strictEqual(result.crossProtocol, true)
    const input = result.body.input as Array<Record<string, unknown>>
    assert.strictEqual(input.length, 1)
    assert.strictEqual(input[0].type, 'message')
    assert.strictEqual(input[0].role, 'user')
    // string content：Responses 接受简单 string content
    assert.strictEqual(input[0].content, 'hello')
  })

  it('user 数组 content (text 块) → message with input_text（必须是 input_text，不是 text）', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'describe this' }] },
      ],
    })
    const input = result.body.input as Array<Record<string, unknown>>
    assert.strictEqual(input.length, 1)
    assert.strictEqual(input[0].role, 'user')
    const content = input[0].content
    // Responses 接受 string 或 array of blocks；两种合法形态都应包含 input_text
    if (typeof content === 'string') {
      assert.strictEqual(content, 'describe this')
    } else {
      const blocks = content as Array<Record<string, unknown>>
      assert.strictEqual(blocks[0].type, 'input_text', 'user 文本块必须是 input_text 而非 text')
      assert.strictEqual(blocks[0].text, 'describe this')
    }
  })

  it('user 数组 content (image 块 + text 块) → input_image + input_text', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.com/x.png' },
            },
          ],
        },
      ],
    })
    const input = result.body.input as Array<Record<string, unknown>>
    const blocks = input[0].content as Array<Record<string, unknown>>
    assert.strictEqual(blocks.length, 2)
    assert.strictEqual(blocks[0].type, 'input_text')
    assert.strictEqual(blocks[1].type, 'input_image')
    assert.strictEqual((blocks[1].image_url as string), 'https://example.com/x.png')
  })

  it('user 数组 content (image base64) → input_image with data URL', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: 'BASE64DATA' },
            },
          ],
        },
      ],
    })
    const blocks = (input0(result.body)).content as Array<Record<string, unknown>>
    assert.strictEqual(blocks[0].type, 'input_image')
    assert.strictEqual(blocks[0].image_url, 'data:image/jpeg;base64,BASE64DATA')
  })

  it('assistant 字符串消息 → message (string content，Responses 接受)', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello there' },
      ],
    })
    const input = result.body.input as Array<Record<string, unknown>>
    assert.strictEqual(input.length, 2)
    assert.strictEqual(input[1].role, 'assistant')
    assert.strictEqual(input[1].content, 'hello there')
  })

  it('assistant 数组 content (text + tool_use) → output_text + function_call（必须 output_text）', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'NYC' } },
          ],
        },
      ],
    })
    const input = result.body.input as Array<Record<string, unknown>>
    // assistant 数组 content 必须展开成多个 item：message(output_text) + function_call
    const types = input.filter((i) => i.type !== undefined).map((i) => i.type)
    assert.ok(types.includes('message'), '应有 message item 含 output_text')
    assert.ok(types.includes('function_call'), '应有 function_call item')

    // 找到 message item，检查 content 块类型是 output_text
    const msgItem = input.find((i) => i.type === 'message' && i.role === 'assistant')
    assert.ok(msgItem, '应找到 assistant message item')
    const blocks = msgItem!.content as Array<Record<string, unknown>>
    assert.strictEqual(blocks[0].type, 'output_text', 'assistant text 块必须是 output_text')
    assert.strictEqual(blocks[0].text, 'Let me check')

    // 找到 function_call item
    const fcItem = input.find((i) => i.type === 'function_call')
    assert.ok(fcItem, '应找到 function_call item')
    assert.strictEqual(fcItem!.name, 'get_weather')
    assert.strictEqual(fcItem!.call_id, 'tu_1')
    // arguments 必须是 JSON 字符串
    assert.strictEqual(typeof fcItem!.arguments, 'string')
    assert.deepStrictEqual(JSON.parse(fcItem!.arguments as string), { city: 'NYC' })
  })

  it('assistant 数组 content (thinking + text) → reasoning + message (output_text)', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'analyze...', signature: 'sig_abc' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    })
    const input = result.body.input as Array<Record<string, unknown>>
    // 应该有 reasoning item + message item
    const reasoningItem = input.find((i) => i.type === 'reasoning')
    assert.ok(reasoningItem, '应有 reasoning item')
    // signature 透传到 encrypted_content（多轮 reasoning 关键）
    assert.strictEqual(reasoningItem.encrypted_content, 'sig_abc', 'signature 须透传到 encrypted_content')
    const summary = reasoningItem.summary as Array<Record<string, unknown>>
    assert.strictEqual(summary[0].text, 'analyze...')
    const msgItem = input.find((i) => i.type === 'message' && i.role === 'assistant')
    assert.ok(msgItem, '应有 message item')
    const blocks = msgItem!.content as Array<Record<string, unknown>>
    assert.strictEqual(blocks[0].type, 'output_text')
  })

  it('Anthropic → Responses：Responses response 反向 → Anthropic thinking.signature 是上游 encrypted_content', () => {
    // 场景：Anthropic 客户端发起多轮，上一轮 Responses 上游返回的 reasoning.encrypted_content 应作为 signature
    const anthropic = convertAnthropicResponseToOpenAIResponses({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'first round', signature: 'sig_round_1' },
        { type: 'text', text: 'answer' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    // 上一轮的 signature 应在下轮请求里透传为 encrypted_content
    assert.ok(anthropic.reasoning, '应有顶层 reasoning')
    const reasoning = anthropic.reasoning as Record<string, unknown>
    assert.strictEqual(reasoning.encrypted_content, 'sig_round_1', 'signature 须透传到 encrypted_content')
  })

  it('tool_result 纯字符串 → function_call_output with string output', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'NYC' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny 25°C' },
          ],
        },
      ],
    })
    const input = result.body.input as Array<Record<string, unknown>>
    const fcOutput = input.find((i) => i.type === 'function_call_output')
    assert.ok(fcOutput, '应有 function_call_output item')
    assert.strictEqual(fcOutput!.call_id, 'tu_1')
    assert.strictEqual(fcOutput!.output, 'sunny 25°C')
  })

  it('tool_result 含 image → computer_call_output', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [
        { role: 'user', content: 'screenshot?' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'computer', input: { action: 'screenshot' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: [
                { type: 'image', source: { type: 'url', url: 'https://x.com/s.png' } },
              ],
            },
          ],
        },
      ],
    })
    const input = result.body.input as Array<Record<string, unknown>>
    const ccOutput = input.find((i) => i.type === 'computer_call_output')
    assert.ok(ccOutput, '应有 computer_call_output item')
    assert.strictEqual(ccOutput!.call_id, 'tu_1')
    const out = ccOutput!.output as Record<string, unknown>
    assert.strictEqual(out.type, 'computer_screenshot')
    assert.strictEqual(out.image_url, 'https://x.com/s.png')
  })

  it('system 字符串 → instructions', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.strictEqual(result.body.instructions, 'You are helpful')
  })

  it('max_tokens → max_output_tokens', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.strictEqual(result.body.max_output_tokens, 2048)
  })

  it('Responses 协议专有字段透传：store / include / metadata / parallel_tool_calls / previous_response_id', async () => {
    const result = await transformInboundRequest('openai-responses', openaiResponsesRoute, {
      model: 'o3-mini',
      input: 'hi',
      store: false,
      include: ['reasoning.encrypted_content'],
      metadata: { user_id: 'u_123', trace: 'abc' },
      parallel_tool_calls: false,
      previous_response_id: 'resp_prev_abc',
      truncation: 'auto',
    })
    assert.strictEqual(result.body.store, false)
    assert.deepStrictEqual(result.body.include, ['reasoning.encrypted_content'])
    assert.deepStrictEqual(result.body.metadata, { user_id: 'u_123', trace: 'abc' })
    assert.strictEqual(result.body.parallel_tool_calls, false)
    assert.strictEqual(result.body.previous_response_id, 'resp_prev_abc')
    assert.strictEqual(result.body.truncation, 'auto')
  })

  it('Chat → Responses：parallel_tool_calls 透传', async () => {
    const result = await transformInboundRequest('openai', openaiResponsesRoute, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'q' }],
      parallel_tool_calls: false,
    })
    assert.strictEqual(result.body.parallel_tool_calls, false)
  })

  it('Chat → Responses：metadata 透传', async () => {
    const result = await transformInboundRequest('openai', openaiResponsesRoute, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'q' }],
      metadata: { tag: 'test' },
    })
    assert.deepStrictEqual(result.body.metadata, { tag: 'test' })
  })

  it('tool_choice any → required', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ name: 'x', description: 'x', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
    })
    assert.strictEqual(result.body.tool_choice, 'required')
  })

  it('tool_choice auto → auto', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ name: 'x', description: 'x', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
    })
    assert.strictEqual(result.body.tool_choice, 'auto')
  })

  it('tool_choice tool 指定 → {type:"function",name}', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ name: 'get_weather', description: 'x', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
    })
    assert.deepStrictEqual(result.body.tool_choice, { type: 'function', name: 'get_weather' })
  })

  it('Anthropic function tool → Responses 扁平 function format', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'q' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather for a city',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
    })
    const tools = result.body.tools as Array<Record<string, unknown>>
    assert.strictEqual(tools.length, 1)
    assert.strictEqual(tools[0].type, 'function')
    assert.strictEqual(tools[0].name, 'get_weather')
    assert.strictEqual(tools[0].description, 'Get weather for a city')
    assert.ok(tools[0].parameters, 'parameters 字段必须保留（input_schema → parameters）')
  })

  it('reasoning effort 通过 thinking → reasoning.effort 映射', async () => {
    const result = await transformInboundRequest('anthropic', openaiResponsesRoute, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'q' }],
      thinking: { type: 'enabled', budget_tokens: 4096 },
    })
    assert.ok(result.body.reasoning, '应有 reasoning 字段')
    assert.ok((result.body.reasoning as Record<string, unknown>).effort, '应有 effort')
  })
})

// ============================================================
// 2. OpenAI Chat → Responses
// ============================================================

describe('proxy/responses-protocol — OpenAI Chat → OpenAI Responses (inbound)', () => {
  it('字符串 user 消息 → message with string content', async () => {
    const result = await transformInboundRequest('openai', openaiResponsesRoute, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const input = result.body.input as Array<Record<string, unknown>>
    assert.strictEqual(input.length, 1)
    assert.strictEqual(input[0].role, 'user')
    assert.strictEqual(input[0].content, 'hi')
  })

  it('字符串 assistant 消息 → message with string content', async () => {
    const result = await transformInboundRequest('openai', openaiResponsesRoute, {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    })
    const input = result.body.input as Array<Record<string, unknown>>
    assert.strictEqual(input[1].role, 'assistant')
    assert.strictEqual(input[1].content, 'hello')
  })

  it('Chat image_url 块 → Responses input_image (string url)', async () => {
    const result = await transformInboundRequest('openai', openaiResponsesRoute, {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'https://x.com/p.png' } },
          ],
        },
      ],
    })
    const blocks = (input0(result.body)).content as Array<Record<string, unknown>>
    assert.strictEqual(blocks[0].type, 'input_text', 'text 块必须转 input_text')
    assert.strictEqual(blocks[1].type, 'input_image')
    assert.strictEqual(blocks[1].image_url, 'https://x.com/p.png')
  })

  it('Chat image_url with object form → input_image (string url extracted)', async () => {
    const result = await transformInboundRequest('openai', openaiResponsesRoute, {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'https://x.com/p.png', detail: 'high' },
            },
          ],
        },
      ],
    })
    const blocks = (input0(result.body)).content as Array<Record<string, unknown>>
    assert.strictEqual(blocks[0].type, 'input_image')
    assert.strictEqual(blocks[0].image_url, 'https://x.com/p.png')
    assert.strictEqual(blocks[0].detail, 'high')
  })

  it('Chat tool message → function_call_output', async () => {
    const result = await transformInboundRequest('openai', openaiResponsesRoute, {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
    })
    const input = result.body.input as Array<Record<string, unknown>>
    const fcOutput = input.find((i) => i.type === 'function_call_output')
    assert.ok(fcOutput, '应有 function_call_output item')
    assert.strictEqual(fcOutput!.call_id, 'call_1')
    assert.strictEqual(fcOutput!.output, 'sunny')
  })

  it('Chat tool_calls → function_call item (arguments 保持 JSON 字符串)', async () => {
    const result = await transformInboundRequest('openai', openaiResponsesRoute, {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
      ],
    })
    const input = result.body.input as Array<Record<string, unknown>>
    const fcItem = input.find((i) => i.type === 'function_call')
    assert.ok(fcItem)
    assert.strictEqual(fcItem!.name, 'get_weather')
    assert.strictEqual(fcItem!.call_id, 'call_1')
    assert.strictEqual(fcItem!.arguments, '{"city":"NYC"}')
  })

  it('Chat reasoning_content → 顶层 reasoning.effort 不变（应通过 reasoning 字段传递）', async () => {
    const result = await transformInboundRequest('openai', openaiResponsesRoute, {
      model: 'o3-mini',
      messages: [{ role: 'user', content: 'q' }],
      reasoning_effort: 'high',
    })
    assert.ok(result.body.reasoning, 'reasoning_effort=high 应映射到 reasoning.effort')
    assert.strictEqual((result.body.reasoning as Record<string, unknown>).effort, 'high')
  })
})

// ============================================================
// 3. Responses → Anthropic
// ============================================================

describe('proxy/responses-protocol — OpenAI Responses → Anthropic (inbound)', () => {
  it('单字符串 input → user message with string content', async () => {
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      input: 'hello',
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0].role, 'user')
    assert.strictEqual(messages[0].content, 'hello')
  })

  it('input 数组 message (string content) → user message', async () => {
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0].role, 'user')
    assert.strictEqual(messages[0].content, 'hi')
  })

  it('input 数组 message (input_text 块) → Anthropic text', async () => {
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello world' }],
        },
      ],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0].role, 'user')
    // 应被规范化（input_text → text），但形态是 string 还是 array 看实现
    const content = messages[0].content
    if (typeof content === 'string') {
      assert.strictEqual(content, 'hello world')
    } else {
      const blocks = content as Array<Record<string, unknown>>
      assert.strictEqual(blocks[0].type, 'text')
      assert.strictEqual(blocks[0].text, 'hello world')
    }
  })

  it('input 数组 input_image (string url) → Anthropic image block', async () => {
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'look' },
            { type: 'input_image', image_url: 'https://x.com/p.png' },
          ],
        },
      ],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    const blocks = messages[0].content as Array<Record<string, unknown>>
    assert.strictEqual(blocks[0].type, 'text')
    assert.strictEqual(blocks[1].type, 'image')
    assert.strictEqual((blocks[1].source as Record<string, unknown>).url, 'https://x.com/p.png')
  })

  it('input 数组 input_image (file_id) → 占位文本', async () => {
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_image', file_id: 'file_abc' },
          ],
        },
      ],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    const content = messages[0].content
    // file_id 不可达 → 降级为占位文本（与 input_text 块都被规范化为 text，全文本时塌缩为 string）
    if (typeof content === 'string') {
      assert.match(content, /file_id=file_abc/)
    } else {
      const blocks = content as Array<Record<string, unknown>>
      assert.strictEqual(blocks[0].type, 'text')
      assert.match(blocks[0].text as string, /file_id=file_abc/)
    }
  })

  it('input 数组 function_call → assistant message with tool_use', async () => {
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: '{"city":"NYC"}',
        },
      ],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    assert.strictEqual(messages.length, 2)
    assert.strictEqual(messages[1].role, 'assistant')
    const blocks = messages[1].content as Array<Record<string, unknown>>
    const toolUse = blocks.find((b) => b.type === 'tool_use')
    assert.ok(toolUse, '应有 tool_use block')
    assert.strictEqual(toolUse!.id, 'call_1')
    assert.strictEqual(toolUse!.name, 'get_weather')
    assert.deepStrictEqual(toolUse!.input, { city: 'NYC' })
  })

  it('input 数组 function_call_output (string) → tool message', async () => {
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
      ],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    // 应该有：user、assistant(tool_use)、user(tool_result) 三条
    assert.strictEqual(messages.length, 3)
    assert.strictEqual(messages[2].role, 'user')
    const toolResult = (messages[2].content as Array<Record<string, unknown>>)[0]
    assert.strictEqual(toolResult.type, 'tool_result')
    assert.strictEqual(toolResult.tool_use_id, 'call_1')
    assert.strictEqual(toolResult.content, 'sunny')
  })

  it('input 数组 parallel function_call_output → 单 user 消息含多个 tool_result', async () => {
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        { type: 'function_call', call_id: 'call_1', name: 'a', arguments: '{}' },
        { type: 'function_call', call_id: 'call_2', name: 'b', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'A' },
        { type: 'function_call_output', call_id: 'call_2', output: 'B' },
      ],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    // 找到最后一条 user 消息，应该含 2 个 tool_result
    const lastUser = messages[messages.length - 1]
    assert.strictEqual(lastUser.role, 'user')
    const toolResults = (lastUser.content as Array<Record<string, unknown>>).filter(
      (b) => b.type === 'tool_result'
    )
    assert.strictEqual(toolResults.length, 2, '并行 tool_result 必须合并到单 user 消息')
  })

  it('input 数组 reasoning item → skip（不产生消息）', async () => {
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] },
      ],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    // 只有 user 消息，没有 reasoning 转 message
    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0].role, 'user')
  })

  it('input 数组 message 混合 string + array content 都被规范化', async () => {
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      input: [
        { type: 'message', role: 'user', content: 'plain' },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'rich' }],
        },
      ],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    assert.strictEqual(messages.length, 2)
    assert.strictEqual(messages[0].content, 'plain')
  })

  it('input 数组含 system message → 不出现在 messages（应映射到 system 字段）', async () => {
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      input: [
        { type: 'message', role: 'system', content: 'be nice' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    })
    // system 应被提升到 body.system
    assert.ok(result.body.system, '应有 system 字段')
    const messages = result.body.messages as Array<Record<string, unknown>>
    // user 消息应保留
    const userMessages = messages.filter((m) => m.role === 'user')
    assert.ok(userMessages.length >= 1)
  })

  it('instructions → Anthropic system', async () => {
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      instructions: 'be helpful',
      input: 'hi',
    })
    assert.strictEqual(result.body.system, 'be helpful')
  })

  it('unknown item type → pass through（不应崩）', async () => {
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        { type: 'item_reference', id: 'resp_abc_0' } as Record<string, unknown>,
      ],
    })
    // item_reference 转为占位 user 消息，避免上下文完全丢失
    const messages = result.body.messages as Array<Record<string, unknown>>
    assert.ok(messages.length >= 1, 'item_reference 不应被静默丢弃')
  })

  it('input 数组 message content 是 object（不规范）→ 不崩', async () => {
    // 不规范形态：content 是 object 而非 string 或 array
    const result = await transformInboundRequest('openai-responses', anthropicRoute, {
      model: 'o3-mini',
      input: [
        { type: 'message', role: 'user', content: { type: 'input_text', text: 'hi' } as unknown as string },
      ],
    })
    // 应保留或转为字符串，不崩
    assert.ok(result.body.messages)
  })

  it('input 是空数组 → 跨协议路由到 Chat 上游时不发空 messages（占位 user message）', async () => {
    // 空 input 数组如果直接转 messages=[] 上游 Chat 会拒；以最小占位 user 消息填充
    const result = await transformInboundRequest('openai-responses', openaiRoute, {
      model: 'o3-mini',
      input: [],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    assert.ok(messages.length >= 1, '不能发空 messages 上游')
    assert.strictEqual(messages[0].role, 'user')
  })

  it('input 是空数组 → 路由到 Responses 上游时透传 input=[]', async () => {
    const result = await transformInboundRequest('openai-responses', openaiResponsesRoute, {
      model: 'o3-mini',
      input: [],
    })
    assert.deepStrictEqual(result.body.input, [])
  })
})

// ============================================================
// 4. Responses → OpenAI Chat
// ============================================================

describe('proxy/responses-protocol — OpenAI Responses → OpenAI Chat (inbound)', () => {
  it('input 字符串 → messages[0].content 字符串', async () => {
    const result = await transformInboundRequest('openai-responses', openaiRoute, {
      model: 'o3-mini',
      input: 'hello',
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0].role, 'user')
    assert.strictEqual(messages[0].content, 'hello')
  })

  it('input 数组 message (input_text) → user message with text content', async () => {
    const result = await transformInboundRequest('openai-responses', openaiRoute, {
      model: 'o3-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }],
        },
      ],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    assert.strictEqual(messages.length, 1)
    // 多个 text 块应塌缩为单字符串
    assert.strictEqual(messages[0].content, 'hi')
  })

  it('input 数组 input_image (string) → Chat image_url block', async () => {
    const result = await transformInboundRequest('openai-responses', openaiRoute, {
      model: 'o3-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'look' },
            { type: 'input_image', image_url: 'https://x.com/p.png' },
          ],
        },
      ],
    })
    const blocks = (result.body.messages as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>
    assert.strictEqual(blocks[0].type, 'text')
    assert.strictEqual(blocks[1].type, 'image_url')
    assert.strictEqual((blocks[1].image_url as Record<string, unknown>).url, 'https://x.com/p.png')
  })

  it('input 数组 function_call → Chat tool_calls', async () => {
    const result = await transformInboundRequest('openai-responses', openaiRoute, {
      model: 'o3-mini',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: '{"city":"NYC"}',
        },
      ],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    assert.strictEqual(messages.length, 2)
    const assistant = messages[1]
    assert.strictEqual(assistant.role, 'assistant')
    assert.ok(assistant.tool_calls, '应有 tool_calls')
    const tc = (assistant.tool_calls as Array<Record<string, unknown>>)[0]
    assert.strictEqual(tc.id, 'call_1')
    const fn = tc.function as Record<string, unknown>
    assert.strictEqual(fn.name, 'get_weather')
    assert.strictEqual(fn.arguments, '{"city":"NYC"}')
  })

  it('input 数组 function_call_output → Chat tool message', async () => {
    const result = await transformInboundRequest('openai-responses', openaiRoute, {
      model: 'o3-mini',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        { type: 'function_call', call_id: 'call_1', name: 'a', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'result' },
      ],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    const toolMsg = messages.find((m) => m.role === 'tool')
    assert.ok(toolMsg)
    assert.strictEqual(toolMsg!.tool_call_id, 'call_1')
    assert.strictEqual(toolMsg!.content, 'result')
  })

  it('input 数组含 reasoning item → 不出现 reasoning_content（除非有显式字段）', async () => {
    const result = await transformInboundRequest('openai-responses', openaiRoute, {
      model: 'o3-mini',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
        { type: 'message', role: 'assistant', content: 'answer' },
      ],
    })
    const messages = result.body.messages as Array<Record<string, unknown>>
    // reasoning 不产生消息
    assert.ok(messages.every((m) => m.role !== 'reasoning'))
  })
})

// ============================================================
// 5. Responses → Responses（同协议）
// ============================================================

describe('proxy/responses-protocol — OpenAI Responses → OpenAI Responses (same)', () => {
  it('完整 body 保真转发 + 替换 model', async () => {
    const result = await transformInboundRequest('openai-responses', openaiResponsesRoute, {
      model: 'o3-mini',
      input: 'hi',
      instructions: 'be nice',
      max_output_tokens: 1024,
      temperature: 0.5,
      stream: true,
    })
    assert.strictEqual(result.crossProtocol, false)
    assert.strictEqual(result.body.model, 'o3-mini')
    assert.strictEqual(result.body.input, 'hi')
    assert.strictEqual(result.body.instructions, 'be nice')
    assert.strictEqual(result.body.max_output_tokens, 1024)
    assert.strictEqual(result.body.temperature, 0.5)
    assert.strictEqual(result.body.stream, true)
    assert.strictEqual(result.headers['Authorization'], 'Bearer sk-openai-1')
  })

  it('保留 input array 中的 input_text 块（同协议）', async () => {
    const result = await transformInboundRequest('openai-responses', openaiResponsesRoute, {
      model: 'o3-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }],
        },
      ],
    })
    assert.strictEqual(result.crossProtocol, false)
    const input = result.body.input as Array<Record<string, unknown>>
    assert.strictEqual(input[0].content[0].type, 'input_text', '同协议透传 input_text 不应被破坏')
  })
})

// ============================================================
// 6. Chat → Chat（同协议）
// ============================================================

describe('proxy/responses-protocol — OpenAI Chat → OpenAI Chat (same)', () => {
  it('字符串 content 保真', async () => {
    const result = await transformInboundRequest('openai', openaiRoute, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.strictEqual(result.crossProtocol, false)
    const messages = result.body.messages as Array<Record<string, unknown>>
    assert.strictEqual(messages[0].content, 'hi')
  })

  it('不应规范化 Chat 风格请求中的 input_text（用户错误契约）', async () => {
    // 用户可能用 Chat 协议但 message content 数组含 input_text 块（不规范）
    // 同协议透传时不应改 type（用户的错误由用户负责，但 llm-proxy 不应引入新的转换）
    const result = await transformInboundRequest('openai', openaiRoute, {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'unconventional but ok' }],
        },
      ],
    })
    assert.strictEqual(result.crossProtocol, false)
    // 同协议透传：保留原样
    const messages = result.body.messages as Array<Record<string, unknown>>
    const content = messages[0].content as Array<Record<string, unknown>>
    assert.strictEqual(content[0].type, 'input_text')
  })
})

// ============================================================
// 7. 响应方向转换
// ============================================================

describe('proxy/responses-protocol — Responses response conversion', () => {
  describe('Responses body → Anthropic body', () => {
    it('message output_text → text block', () => {
      const anthropic = convertOpenAIResponsesToAnthropic({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'o3-mini',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello!', annotations: [] }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      const content = anthropic.content as Array<Record<string, unknown>>
      assert.strictEqual(content[0].type, 'text')
      assert.strictEqual(content[0].text, 'Hello!')
      assert.strictEqual(anthropic.stop_reason, 'end_turn')
    })

    it('function_call → tool_use (arguments 解析为 object)', () => {
      const anthropic = convertOpenAIResponsesToAnthropic({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'o3-mini',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '', annotations: [] }],
          },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_weather',
            arguments: '{"city":"NYC"}',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      const content = anthropic.content as Array<Record<string, unknown>>
      const toolUse = content.find((b) => b.type === 'tool_use')
      assert.ok(toolUse)
      assert.strictEqual(toolUse!.id, 'call_1')
      assert.strictEqual(toolUse!.name, 'get_weather')
      assert.deepStrictEqual(toolUse!.input, { city: 'NYC' })
      assert.strictEqual(anthropic.stop_reason, 'tool_use')
    })

    it('空 arguments 字符串 → 空 object', () => {
      const anthropic = convertOpenAIResponsesToAnthropic({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'o3-mini',
        output: [
          { type: 'message', role: 'assistant', content: [] },
          { type: 'function_call', call_id: 'call_1', name: 'a', arguments: '' },
        ],
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      const toolUse = (anthropic.content as Array<Record<string, unknown>>).find(
        (b) => b.type === 'tool_use'
      )
      assert.deepStrictEqual(toolUse!.input, {})
    })

    it('顶层 reasoning.summary → thinking block（作为首个 content block）', () => {
      const anthropic = convertOpenAIResponsesToAnthropic({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'o3-mini',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'final', annotations: [] }],
          },
        ],
        reasoning: { summary: [{ type: 'summary_text', text: 'thought process', index: 0 }] },
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      const content = anthropic.content as Array<Record<string, unknown>>
      assert.strictEqual(content[0].type, 'thinking')
      assert.strictEqual(content[0].thinking, 'thought process')
    })

    it('refusal content → text block', () => {
      const anthropic = convertOpenAIResponsesToAnthropic({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'o3-mini',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'refusal', refusal: 'cannot comply' }],
          },
        ],
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      const content = anthropic.content as Array<Record<string, unknown>>
      assert.strictEqual(content[0].type, 'text', 'refusal 应降级为 text')
      assert.strictEqual(content[0].text, 'cannot comply')
    })

    it('status=incomplete + reason=max_output_tokens → stop_reason=max_tokens', () => {
      const anthropic = convertOpenAIResponsesToAnthropic({
        id: 'resp_1',
        object: 'response',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        model: 'o3-mini',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x', annotations: [] }] },
        ],
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      assert.strictEqual(anthropic.stop_reason, 'max_tokens')
    })

    it('status=failed → 应传播为错误（当前实现：宽容映射为 end_turn）', () => {
      // 当前实现没有 validate_responses_terminal_status，宽容映射。
      // 测试记录当前行为，避免静默改变。
      const anthropic = convertOpenAIResponsesToAnthropic({
        id: 'resp_1',
        object: 'response',
        status: 'failed',
        error: { type: 'invalid_request', message: 'bad' },
        model: 'o3-mini',
        output: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      // 当前行为：宽容映射，可能输出空 content + end_turn；不报错
      // 预期后续可改为：抛错或标记
      assert.ok(anthropic.stop_reason)
    })
  })

  describe('Responses body → Chat body', () => {
    it('output_text → content string', () => {
      const chat = convertOpenAIResponsesResponseToOpenAI({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'o3-mini',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi', annotations: [] }] },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      })
      const choice = (chat.choices as Array<Record<string, unknown>>)[0]
      const msg = choice.message as Record<string, unknown>
      assert.strictEqual(msg.content, 'hi')
      assert.strictEqual(choice.finish_reason, 'stop')
    })

    it('function_call → tool_calls', () => {
      const chat = convertOpenAIResponsesResponseToOpenAI({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'o3-mini',
        output: [
          { type: 'message', role: 'assistant', content: [] },
          { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"NYC"}' },
        ],
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      const choice = (chat.choices as Array<Record<string, unknown>>)[0]
      const msg = choice.message as Record<string, unknown>
      assert.ok(msg.tool_calls)
      const tc = (msg.tool_calls as Array<Record<string, unknown>>)[0]
      assert.strictEqual(tc.id, 'call_1')
      assert.strictEqual((tc.function as Record<string, unknown>).name, 'get_weather')
      assert.strictEqual((tc.function as Record<string, unknown>).arguments, '{"city":"NYC"}')
      assert.strictEqual(choice.finish_reason, 'tool_calls')
    })

    it('顶层 reasoning.summary → reasoning_content', () => {
      const chat = convertOpenAIResponsesResponseToOpenAI({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'o3-mini',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a', annotations: [] }] },
        ],
        reasoning: { summary: [{ type: 'summary_text', text: 'thinking' }] },
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      const choice = (chat.choices as Array<Record<string, unknown>>)[0]
      const msg = choice.message as Record<string, unknown>
      assert.strictEqual(msg.reasoning_content, 'thinking')
    })

    it('usage: cached_tokens → prompt_tokens 包含缓存 + details', () => {
      const chat = convertOpenAIResponsesResponseToOpenAI({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'o3-mini',
        output: [],
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 80 },
        },
      })
      const usage = chat.usage as Record<string, unknown>
      assert.strictEqual(usage.prompt_tokens, 100, 'prompt_tokens 应包含 cached_tokens')
      assert.strictEqual(usage.completion_tokens, 5)
      assert.deepStrictEqual(usage.prompt_tokens_details, { cached_tokens: 80 })
    })
  })

  describe('Anthropic body → Responses body', () => {
    it('text → output_text；thinking → 顶层 reasoning.summary', () => {
      const responses = convertAnthropicResponseToOpenAIResponses({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet',
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: 'analyze', signature: '' },
          { type: 'text', text: 'answer' },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      const output = responses.output as Array<Record<string, unknown>>
      const msgItem = output.find((i) => i.type === 'message')
      assert.ok(msgItem)
      const blocks = msgItem!.content as Array<Record<string, unknown>>
      assert.strictEqual(blocks[0].type, 'output_text')
      assert.strictEqual(blocks[0].text, 'answer')
      // thinking 不进入 message content，应到顶层 reasoning.summary
      assert.ok(responses.reasoning, '应有顶层 reasoning')
      const summary = (responses.reasoning as Record<string, unknown>).summary as Array<Record<string, unknown>>
      assert.strictEqual(summary[0].text, 'analyze')
    })

    it('tool_use → function_call item（canonical JSON 字符串 arguments）', () => {
      const responses = convertAnthropicResponseToOpenAIResponses({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'check' },
          { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'NYC' } },
        ],
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      const output = responses.output as Array<Record<string, unknown>>
      const fcItem = output.find((i) => i.type === 'function_call')
      assert.ok(fcItem)
      assert.strictEqual(fcItem!.call_id, 'tu_1')
      assert.strictEqual(fcItem!.name, 'get_weather')
      // arguments 必须是合法 JSON 字符串
      assert.strictEqual(typeof fcItem!.arguments, 'string')
      assert.deepStrictEqual(JSON.parse(fcItem!.arguments as string), { city: 'NYC' })
    })

    it('tool_use input 已是 string 时不重复 stringify（避免双重转义）', () => {
      // 场景：上游传递 input 为已序列化的 JSON 字符串，必须原样使用而不是多重 stringify
      const rawArgs = '{"city":"NYC","unit":"celsius"}'
      const responses = convertAnthropicResponseToOpenAIResponses({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet',
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: rawArgs as unknown as Record<string, unknown> },
        ],
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      const fcItem = (responses.output as Array<Record<string, unknown>>).find(
        (i) => i.type === 'function_call'
      )
      assert.ok(fcItem)
      assert.strictEqual(fcItem!.arguments, rawArgs, 'input 是 string 时须原样传递，不可双重 stringify')
      assert.deepStrictEqual(JSON.parse(fcItem!.arguments as string), { city: 'NYC', unit: 'celsius' })
    })

    it('computer tool_use → computer_call output item', () => {
      const responses = convertAnthropicResponseToOpenAIResponses({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet',
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'computer', input: { action: 'screenshot' } },
        ],
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      const output = responses.output as Array<Record<string, unknown>>
      const ccItem = output.find((i) => i.type === 'computer_call')
      assert.ok(ccItem)
      assert.strictEqual((ccItem!.action as Record<string, unknown>).type, 'screenshot')
    })

    it('stop_reason=max_tokens → status=incomplete', () => {
      const responses = convertAnthropicResponseToOpenAIResponses({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet',
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'partial' }],
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      assert.strictEqual(responses.status, 'incomplete')
    })

    it('usage 透传 + cache_read/cache_create 归一化', () => {
      const responses = convertAnthropicResponseToOpenAIResponses({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
        },
      })
      const usage = responses.usage as Record<string, unknown>
      assert.strictEqual(usage.input_tokens, 10)
      assert.strictEqual(usage.output_tokens, 5)
      assert.deepStrictEqual(usage.input_tokens_details, { cached_tokens: 80 })
      assert.strictEqual(usage.cache_creation_input_tokens, 20)
    })
  })

  describe('Chat body → Responses body', () => {
    it('content string + tool_calls → message(output_text) + function_call items', () => {
      const responses = convertOpenAIResponseToOpenAIResponses({
        id: 'chatcmpl_1',
        object: 'chat.completion',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'final answer',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
      const output = responses.output as Array<Record<string, unknown>>
      const msgItem = output.find((i) => i.type === 'message')
      assert.ok(msgItem)
      const blocks = msgItem!.content as Array<Record<string, unknown>>
      assert.strictEqual(blocks[0].type, 'output_text')
      const fcItem = output.find((i) => i.type === 'function_call')
      assert.ok(fcItem)
    })

    it('reasoning_content → 顶层 reasoning.summary', () => {
      const responses = convertOpenAIResponseToOpenAIResponses({
        id: 'chatcmpl_1',
        object: 'chat.completion',
        model: 'o3-mini',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'final', reasoning_content: 'thought' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
      assert.ok(responses.reasoning)
      const summary = (responses.reasoning as Record<string, unknown>).summary as Array<Record<string, unknown>>
      assert.strictEqual(summary[0].text, 'thought')
    })
  })

  describe('Anthropic body → Chat body（已有覆盖，补充 Responses 关联）', () => {
    it('thinking + text + tool_use → reasoning_content + content + tool_calls', () => {
      const chat = convertAnthropicResponseToOpenAI({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet',
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 't', signature: 'sig' },
          { type: 'text', text: 'a' },
          { type: 'tool_use', id: 'tu_1', name: 'f', input: { x: 1 } },
        ],
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      const choice = (chat.choices as Array<Record<string, unknown>>)[0]
      const msg = choice.message as Record<string, unknown>
      assert.strictEqual(msg.reasoning_content, 't')
      assert.strictEqual(msg.content, 'a')
      assert.strictEqual(msg.reasoning_signature, 'sig')
      assert.ok(msg.tool_calls)
    })
  })
})

// ============================================================
// 8. 流式 Responses → Anthropic
// ============================================================

describe('proxy/responses-protocol — Responses SSE → Anthropic SSE', () => {
  it('完整生命周期：created → output_item.added → output_text.delta → output_text.done → completed', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"o3-mini","status":"in_progress","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","status":"in_progress","role":"assistant","content":[]}}\n\n',
      'event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":" world"}\n\n',
      'event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Hello world"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
    ])
    await convertOpenAIResponsesStreamToAnthropic(reader, res)
    const events = sseEvents(chunks)
    assert.ok(events.some((e) => e.type === 'message_start'), '应有 message_start')
    assert.ok(events.some((e) => e.type === 'content_block_start'), '应有 content_block_start')
    assert.ok(events.some((e) => e.type === 'content_block_stop'), '应有 content_block_stop')
    assert.ok(events.some((e) => e.type === 'message_delta'), '应有 message_delta')
    assert.ok(events.some((e) => e.type === 'message_stop'), '应有 message_stop')
    const start = events.find((e) => e.type === 'message_start') as Record<string, unknown>
    const message = (start.message as Record<string, unknown>)
    assert.strictEqual(message.role, 'assistant')
    assert.strictEqual(message.model, 'o3-mini')
  })

  it('reasoning_text.delta → thinking_delta（固定 index=0）', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"Step 1"}\n\n',
      'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"Step 2"}\n\n',
      'event: response.reasoning_text.done\ndata: {"type":"response.reasoning_text.done"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"Final"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    await convertOpenAIResponsesStreamToAnthropic(reader, res)
    const events = sseEvents(chunks)
    const thinkingStarts = events.filter((e) => e.type === 'content_block_start')
    const thinkingBlocks = thinkingStarts.map((e) => e.content_block as Record<string, unknown>)
    assert.ok(thinkingBlocks.some((b) => b.type === 'thinking'), '应有 thinking block start')
    const thinkingDeltas = events.filter((e) => {
      const d = e.delta as Record<string, unknown> | undefined
      return e.type === 'content_block_delta' && d?.type === 'thinking_delta'
    })
    assert.ok(thinkingDeltas.length >= 2, '应有 ≥2 个 thinking_delta')
  })

  it('response.function_call_arguments.delta → input_json_delta', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"city\\":\\"NYC\\"}"}\n\n',
      'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","output_index":1,"arguments":"{\\"city\\":\\"NYC\\"}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    await convertOpenAIResponsesStreamToAnthropic(reader, res)
    const events = sseEvents(chunks)
    const inputDeltas = events.filter((e) => {
      const d = e.delta as Record<string, unknown> | undefined
      return e.type === 'content_block_delta' && d?.type === 'input_json_delta'
    })
    assert.ok(inputDeltas.length > 0, '应有 input_json_delta')
    const toolUseStart = events.find(
      (e) => e.type === 'content_block_start' && (e.content_block as Record<string, unknown>).type === 'tool_use'
    )
    assert.ok(toolUseStart)
    const cb = toolUseStart.content_block as Record<string, unknown>
    assert.strictEqual(cb.name, 'get_weather')
  })

  it('computer_call.output_item.added → tool_use(name=computer) with action mapping', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"snap"}\n\n',
      'event: response.output_text.done\ndata: {"type":"response.output_text.done"}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"computer_call","id":"cc_1","call_id":"call_1","action":{"type":"screenshot"},"status":"in_progress"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    await convertOpenAIResponsesStreamToAnthropic(reader, res)
    const events = sseEvents(chunks)
    const computerToolStart = events.find((e) => {
      const cb = e.content_block as Record<string, unknown> | undefined
      return e.type === 'content_block_start' && cb?.type === 'tool_use' && cb.name === 'computer'
    })
    assert.ok(computerToolStart, '应有 computer tool_use start')
  })

  it('refusal content → text block', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"refusal","refusal":""}}\n\n',
      'event: response.refusal.delta\ndata: {"type":"response.refusal.delta","delta":"I cannot comply"}\n\n',
      'event: response.refusal.done\ndata: {"type":"response.refusal.done","text":"I cannot comply"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    await convertOpenAIResponsesStreamToAnthropic(reader, res)
    const events = sseEvents(chunks)
    // refusal delta 应映射为 text_delta
    const textDeltas = events.filter((e) => {
      const d = e.delta as Record<string, unknown> | undefined
      return e.type === 'content_block_delta' && d?.type === 'text_delta'
    })
    assert.ok(textDeltas.some((d) => {
      const td = d.delta as Record<string, unknown>
      return (td.text as string) === 'I cannot comply'
    }), 'refusal delta 应作为 text_delta 发送')
  })

  it('response.failed → error event', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"type":"server_error","message":"upstream down"}}}\n\n',
    ])
    await convertOpenAIResponsesStreamToAnthropic(reader, res)
    const events = sseEvents(chunks)
    assert.ok(events.some((e) => e.type === 'error'), '应有 error 事件')
  })

  it('response.incomplete + reason=max_output_tokens → stop_reason=max_tokens', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
    ])
    await convertOpenAIResponsesStreamToAnthropic(reader, res)
    const events = sseEvents(chunks)
    const msgDelta = events.find((e) => e.type === 'message_delta')
    assert.ok(msgDelta)
    const d = msgDelta.delta as Record<string, unknown>
    assert.strictEqual(d.stop_reason, 'max_tokens')
  })

  it('usage 缓存 token 透传到 Anthropic usage', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":20,"input_tokens_details":{"cached_tokens":80},"output_tokens":5}}}\n\n',
    ])
    const usage = await convertOpenAIResponsesStreamToAnthropic(reader, res)
    assert.deepStrictEqual(usage, {
      input_tokens: 20,
      output_tokens: 5,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: undefined,
    })
  })

  it('上游 response.reasoning.encrypted_content 作为 thinking signature（多轮 reasoning）', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"thinking..."}\n\n',
      'event: response.reasoning_text.done\ndata: {"type":"response.reasoning_text.done"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"final"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","reasoning":{"summary":[{"type":"summary_text","text":"thinking..."}],"encrypted_content":"real_sig_abc"}}}\n\n',
    ])
    await convertOpenAIResponsesStreamToAnthropic(reader, res)
    const events = sseEvents(chunks)
    // real_sig_abc 必须以 signature_delta 发出，不是 SHA-256 伪签名
    const sigDeltas = events.filter((e) => {
      const d = e.delta as Record<string, unknown> | undefined
      return e.type === 'content_block_delta' && d?.type === 'signature_delta'
    })
    assert.ok(sigDeltas.length > 0, '应有 signature_delta')
    const realSig = sigDeltas.some((e) => {
      const d = e.delta as Record<string, unknown>
      return (d.signature as string) === 'real_sig_abc'
    })
    assert.ok(realSig, 'signature 必须是上游 encrypted_content，不是伪签名')
  })

  it('output_item.added reasoning → 开启 thinking block（不丢 reasoning）', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"sig_x","summary":[{"type":"summary_text","text":"thinking"}]}}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","delta":"more"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    await convertOpenAIResponsesStreamToAnthropic(reader, res)
    const events = sseEvents(chunks)
    // 至少应开过 thinking block
    const thinkingStarts = events.filter((e) => {
      const cb = e.content_block as Record<string, unknown> | undefined
      return e.type === 'content_block_start' && cb?.type === 'thinking'
    })
    assert.ok(thinkingStarts.length > 0, 'reasoning item 应开启 thinking block')
  })
})

// ============================================================
// 9. 流式 Anthropic → Responses
// ============================================================

describe('proxy/responses-protocol — Anthropic SSE → Responses SSE', () => {
  it('message_start → response.created + response.in_progress + response.output_item.added', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])
    await convertAnthropicStreamToOpenAIResponses(reader, res)
    const events = sseEvents(chunks)
    assert.ok(events.some((e) => e.type === 'response.created'))
    assert.ok(events.some((e) => e.type === 'response.in_progress'))
    assert.ok(events.some((e) => e.type === 'response.output_item.added'))
    assert.ok(events.some((e) => e.type === 'response.content_part.added'))
    assert.ok(events.some((e) => e.type === 'response.output_text.delta'))
    assert.ok(events.some((e) => e.type === 'response.output_text.done'))
    assert.ok(events.some((e) => e.type === 'response.completed'))
  })

  it('thinking_delta → response.reasoning_text.delta + 顶层 reasoning.summary in completed', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"analyzing"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])
    await convertAnthropicStreamToOpenAIResponses(reader, res)
    const events = sseEvents(chunks)
    const reasoningDeltas = events.filter((e) => e.type === 'response.reasoning_text.delta')
    assert.ok(reasoningDeltas.length > 0, '应有 reasoning_text.delta')
    // completed 中应有顶层 reasoning.summary
    const completed = events.find((e) => e.type === 'response.completed') as Record<string, unknown>
    const response = completed.response as Record<string, unknown>
    assert.ok(response.reasoning, 'completed.response 应有 reasoning')
  })

  it('tool_use → function_call + arguments delta', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"NYC\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])
    await convertAnthropicStreamToOpenAIResponses(reader, res)
    const events = sseEvents(chunks)
    const fcAdded = events.find((e) => {
      if (e.type !== 'response.output_item.added') return false
      const item = e.item as Record<string, unknown>
      return item?.type === 'function_call'
    })
    assert.ok(fcAdded)
    const item = fcAdded!.item as Record<string, unknown>
    assert.strictEqual(item.name, 'get_weather')
    assert.strictEqual(item.call_id, 'tu_1')
    const argsDelta = events.find((e) => e.type === 'response.function_call_arguments.delta')
    assert.ok(argsDelta)
  })

  it('computer tool_use → computer_call output item', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"computer","input":{"action":"screenshot"}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])
    await convertAnthropicStreamToOpenAIResponses(reader, res)
    const events = sseEvents(chunks)
    const ccAdded = events.find((e) => {
      if (e.type !== 'response.output_item.added') return false
      const item = e.item as Record<string, unknown>
      return item?.type === 'computer_call'
    })
    assert.ok(ccAdded, '应有 computer_call output_item.added')
  })

  it('namespace 工具 mcp__xxx__yyy → 解码为 function_call with namespace field', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"mcp__filesystem__read_file","input":{}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])
    const originalTools = [
      {
        type: 'namespace',
        name: 'mcp__filesystem__',
        tools: [{ type: 'function', name: 'read_file' }],
      },
    ]
    await convertAnthropicStreamToOpenAIResponses(reader, res, undefined, undefined, undefined, originalTools)
    const events = sseEvents(chunks)
    const fcAdded = events.find((e) => {
      if (e.type !== 'response.output_item.added') return false
      const item = e.item as Record<string, unknown>
      return item?.type === 'function_call'
    })
    assert.ok(fcAdded)
    const item = fcAdded!.item as Record<string, unknown>
    // namespace 解码后：name='read_file', namespace='mcp__filesystem__'
    assert.strictEqual(item.name, 'read_file')
    assert.strictEqual(item.namespace, 'mcp__filesystem__')
  })
})

// ============================================================
// 10. 流式 Chat → Responses
// ============================================================

describe('proxy/responses-protocol — Chat SSE → Responses SSE', () => {
  it('role delta → response.created + output_item.added', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ])
    await convertOpenAIStreamToOpenAIResponses(reader, res)
    const events = sseEvents(chunks)
    assert.ok(events.some((e) => e.type === 'response.created'))
    assert.ok(events.some((e) => e.type === 'response.in_progress'))
    assert.ok(events.some((e) => e.type === 'response.output_item.added'))
    assert.ok(events.some((e) => e.type === 'response.content_part.added'))
    assert.ok(events.some((e) => e.type === 'response.output_text.delta'))
    assert.ok(events.some((e) => e.type === 'response.output_text.done'))
    assert.ok(events.some((e) => e.type === 'response.completed'))
  })

  it('reasoning_content delta → response.reasoning_text.delta', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":""}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking step"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ])
    await convertOpenAIStreamToOpenAIResponses(reader, res)
    const events = sseEvents(chunks)
    const reasoning = events.filter((e) => e.type === 'response.reasoning_text.delta')
    assert.ok(reasoning.length > 0, '应有 reasoning_text.delta')
    assert.ok((reasoning[0].delta as string) === 'thinking step')
  })

  it('tool_calls delta → response.function_call_arguments.delta', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"NYC\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ])
    await convertOpenAIStreamToOpenAIResponses(reader, res)
    const events = sseEvents(chunks)
    const argsDeltas = events.filter((e) => e.type === 'response.function_call_arguments.delta')
    assert.ok(argsDeltas.length > 0, '应有 function_call_arguments.delta')
  })
})

// ============================================================
// 11. 流式 Responses → Chat
// ============================================================

describe('proxy/responses-protocol — Responses SSE → Chat SSE', () => {
  it('output_text.delta → content delta + finish_reason=stop', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"Hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
    ])
    await convertOpenAIResponsesStreamToOpenAI(reader, res)
    const events = sseEvents(chunks)
    const contentDelta = events.find((e) => {
      const choices = e.choices as Array<Record<string, unknown>> | undefined
      const choice = choices?.[0]
      const delta = choice?.delta as Record<string, unknown> | undefined
      return e.type === undefined && delta?.content === 'Hi'
    })
    assert.ok(contentDelta, '应有 content=Hi delta')
    const final = events.find((e) => {
      const choices = e.choices as Array<Record<string, unknown>> | undefined
      return choices?.[0]?.finish_reason !== undefined
    })
    assert.ok(final)
    const finishChoice = (final.choices as Array<Record<string, unknown>>)[0]
    assert.strictEqual(finishChoice.finish_reason, 'stop')
  })

  it('reasoning_text.delta → reasoning_content delta', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"think"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"ans"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    await convertOpenAIResponsesStreamToOpenAI(reader, res)
    const events = sseEvents(chunks)
    const reasoningChunk = events.find((e) => {
      const choices = e.choices as Array<Record<string, unknown>> | undefined
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
      return delta?.reasoning_content === 'think'
    })
    assert.ok(reasoningChunk)
  })

  it('function_call → tool_calls + finish_reason=tool_calls', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"city\\":\\"NYC\\"}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    await convertOpenAIResponsesStreamToOpenAI(reader, res)
    const events = sseEvents(chunks)
    const toolStart = events.find((e) => {
      const choices = e.choices as Array<Record<string, unknown>> | undefined
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
      const tc = delta?.tool_calls as Array<Record<string, unknown>> | undefined
      return tc && tc.length > 0 && tc[0].id
    })
    assert.ok(toolStart)
    const final = events.find((e) => {
      const choices = e.choices as Array<Record<string, unknown>> | undefined
      return choices?.[0]?.finish_reason !== undefined
    })
    assert.ok(final)
    const finishChoice = (final.choices as Array<Record<string, unknown>>)[0]
    assert.strictEqual(finishChoice.finish_reason, 'tool_calls')
  })

  it('cache_read_input_tokens 计入 prompt_tokens + details', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":20,"input_tokens_details":{"cached_tokens":80},"output_tokens":5}}}\n\n',
    ])
    const usage = await convertOpenAIResponsesStreamToOpenAI(reader, res)
    const events = sseEvents(chunks)
    const finalUsage = events.find((e) => e.usage)?.usage as Record<string, unknown>
    assert.strictEqual(finalUsage.prompt_tokens, 100, 'prompt_tokens 应包含 cached_tokens')
    assert.deepStrictEqual(finalUsage.prompt_tokens_details, { cached_tokens: 80 })
    assert.deepStrictEqual(usage, {
      input_tokens: 20,
      output_tokens: 5,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: undefined,
    })
  })

  it('cache_creation_input_tokens 透传到 Responses → Chat 流式 usage', async () => {
    const { chunks, res } = makeResponse()
    const reader = makeReader([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":20,"input_tokens_details":{"cached_tokens":80},"cache_creation_input_tokens":50,"output_tokens":5}}}\n\n',
    ])
    const usage = await convertOpenAIResponsesStreamToOpenAI(reader, res)
    const events = sseEvents(chunks)
    const finalUsage = events.find((e) => e.usage)?.usage as Record<string, unknown>
    assert.strictEqual(usage.cache_creation_input_tokens, 50, 'lastUsage 应记录 cache_creation')
    const details = finalUsage.prompt_tokens_details as Record<string, unknown>
    assert.strictEqual(details.cached_tokens, 80)
    assert.strictEqual(details.cache_creation_input_tokens, 50, 'prompt_tokens_details 应含 cache_creation_input_tokens')
  })
})

// ============================================================
// 辅助函数
// ============================================================

function input0(body: Record<string, unknown>): Record<string, unknown> {
  const input = body.input as Array<Record<string, unknown>>
  return input[0]
}