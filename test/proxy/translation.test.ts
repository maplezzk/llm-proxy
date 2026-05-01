import { describe, it } from 'node:test'
import assert from 'node:assert'
import { transformInboundRequest, convertOpenAIResponseToAnthropic, convertAnthropicResponseToOpenAI, convertOpenAIResponsesToAnthropic, convertAnthropicResponseToOpenAIResponses } from '../../src/proxy/translation.js'

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

describe('proxy/translation', () => {
  describe('同协议转发', () => {
    it('Anthropic → Anthropic 保真传递 + 替换 model', async () => {
      const result = await transformInboundRequest('anthropic', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1000,
        temperature: 0.5,
        stream: true,
      })
      assert.strictEqual(result.crossProtocol, false)
      assert.strictEqual(result.body.model, 'claude-sonnet-4')
      assert.strictEqual(result.body.temperature, 0.5)
      assert.strictEqual(result.body.stream, true)
      assert.strictEqual(result.headers['x-api-key'], 'sk-ant-1')
    })

    it('OpenAI → OpenAI 保真传递 + 替换 model', async () => {
      const result = await transformInboundRequest('openai', openaiRoute, {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1000,
      })
      assert.strictEqual(result.crossProtocol, false)
      assert.strictEqual(result.body.model, 'gpt-4o')
      assert.strictEqual(result.headers['Authorization'], 'Bearer sk-openai-1')
    })
  })

  describe('跨协议翻译 — OpenAI → Anthropic', () => {
    it('基础参数映射', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 2000,
        temperature: 0.7,
        top_p: 0.9,
        stream: true,
        stop: ['\n'],
      })
      assert.strictEqual(result.crossProtocol, true)
      assert.strictEqual(result.body.model, 'claude-sonnet-4')
      assert.strictEqual(result.body.max_tokens, 2000)
      assert.strictEqual(result.body.temperature, 0.7)
      assert.strictEqual(result.body.top_p, 0.9)
      assert.strictEqual(result.body.stream, true)
      assert.deepStrictEqual(result.body.stop_sequences, ['\n'])
      assert.strictEqual(result.headers['x-api-key'], 'sk-ant-1')
    })

    it('System message → Anthropic system 参数', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hi' },
        ],
      })
      assert.strictEqual(result.body.system, 'You are a helpful assistant.')
      assert.strictEqual((result.body.messages as unknown[]).length, 1)
      assert.strictEqual((result.body.messages as Array<Record<string, unknown>>)[0].role, 'user')
    })

    it('Tool 格式转换', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { loc: { type: 'string' } }, required: ['loc'] },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      })
      const tools = result.body.tools as Array<Record<string, unknown>>
      assert.ok(tools)
      assert.strictEqual(tools[0].name, 'get_weather')
      assert.strictEqual(tools[0].description, 'Get weather')
      assert.ok(tools[0].input_schema)
      assert.deepStrictEqual(result.body.tool_choice, { type: 'tool', name: 'get_weather' })
    })
  })

  describe('跨协议翻译 — OpenAI Responses → Anthropic', () => {
    it('input 字符串 → messages + instructions → system + max_output_tokens → max_tokens', async () => {
      const result = await transformInboundRequest('openai-responses', anthropicRoute, {
        model: 'claude-sonnet',
        input: 'Hello, how are you?',
        instructions: 'You are a helpful assistant.',
        max_output_tokens: 2048,
        temperature: 0.3,
        stream: true,
      })
      assert.strictEqual(result.crossProtocol, true)
      assert.strictEqual(result.body.model, 'claude-sonnet-4')
      assert.strictEqual(result.body.max_tokens, 2048)
      assert.strictEqual(result.body.temperature, 0.3)
      assert.strictEqual(result.body.stream, true)
      assert.strictEqual(result.body.system, 'You are a helpful assistant.')
      const msgs = result.body.messages as Array<Record<string, unknown>>
      assert.strictEqual(msgs.length, 1)
      assert.strictEqual(msgs[0].role, 'user')
      assert.strictEqual(msgs[0].content, 'Hello, how are you?')
      assert.strictEqual(result.headers['x-api-key'], 'sk-ant-1')
    })

    it('input 数组（消息列表）转换为 Anthropic messages', async () => {
      const result = await transformInboundRequest('openai-responses', anthropicRoute, {
        model: 'claude-sonnet',
        input: [{ role: 'user', content: 'Hi' }, { role: 'user', content: 'What time is it?' }],
        max_output_tokens: 100,
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      assert.strictEqual(msgs.length, 2)
      assert.strictEqual(msgs[0].role, 'user')
    })

    it('tools 转换为 Anthropic tool 格式', async () => {
      const result = await transformInboundRequest('openai-responses', anthropicRoute, {
        model: 'claude-sonnet',
        input: 'weather?',
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { loc: { type: 'string' } } } } }],
        tool_choice: 'required',
      })
      const tools = result.body.tools as Array<Record<string, unknown>>
      assert.ok(tools)
      assert.strictEqual(tools[0].name, 'get_weather')
      assert.strictEqual(result.body.tool_choice, 'any')
    })
  })

  describe('同协议转发 — OpenAI Responses → OpenAI Responses', () => {
    const responsesRoute = {
      providerName: 'responses-main',
      providerType: 'openai-responses' as const,
      apiKey: 'sk-resp-1',
      apiBase: 'https://api.openai.com',
      modelId: 'gpt-4o',
    }

    it('Responses → Responses 保真传递 + 替换 model', async () => {
      const result = await transformInboundRequest('openai-responses', responsesRoute, {
        model: 'gpt-4o',
        input: 'Hello',
        instructions: 'Be concise.',
        max_output_tokens: 500,
        temperature: 0.5,
        stream: true,
      })
      assert.strictEqual(result.crossProtocol, false)
      assert.strictEqual(result.body.model, 'gpt-4o')
      assert.strictEqual(result.body.input, 'Hello')
      assert.strictEqual(result.body.instructions, 'Be concise.')
      assert.strictEqual(result.body.max_output_tokens, 500)
      assert.strictEqual(result.body.temperature, 0.5)
      assert.strictEqual(result.body.stream, true)
      assert.strictEqual(result.headers['Authorization'], 'Bearer sk-resp-1')
    })
  })

  describe('跨协议翻译 — Anthropic → OpenAI', () => {
    it('基础参数映射', async () => {
      const result = await transformInboundRequest('anthropic', openaiRoute, {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 2000,
        temperature: 0.7,
        top_p: 0.9,
        stream: true,
        stop_sequences: ['\n'],
      })
      assert.strictEqual(result.crossProtocol, true)
      assert.strictEqual(result.body.model, 'gpt-4o')
      assert.strictEqual(result.body.max_tokens, 2000)
      assert.strictEqual(result.body.temperature, 0.7)
      assert.strictEqual(result.body.top_p, 0.9)
      assert.strictEqual(result.body.stream, true)
      assert.deepStrictEqual(result.body.stop, ['\n'])
      assert.strictEqual(result.headers['Authorization'], 'Bearer sk-openai-1')
    })

    it('System 参数 → messages 首条 system message', async () => {
      const result = await transformInboundRequest('anthropic', openaiRoute, {
        model: 'gpt-4o',
        system: 'You are Claude.',
        messages: [{ role: 'user', content: 'Hi' }],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      assert.strictEqual(msgs[0].role, 'system')
      assert.strictEqual(msgs[0].content, 'You are Claude.')
      assert.strictEqual(msgs.length, 2)
    })

    it('Tool 格式转换', async () => {
      const result = await transformInboundRequest('anthropic', openaiRoute, {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{
          name: 'get_weather',
          description: 'Get weather',
          input_schema: { type: 'object', properties: { loc: { type: 'string' } }, required: ['loc'] },
        }],
        tool_choice: { type: 'tool', name: 'get_weather' } as unknown as string,
      })
      const tools = result.body.tools as Array<Record<string, unknown>>
      assert.ok(tools)
      assert.strictEqual(tools[0].type, 'function')
      const fn = tools[0].function as Record<string, unknown>
      assert.strictEqual(fn.name, 'get_weather')
      assert.strictEqual(fn.description, 'Get weather')
      assert.ok(fn.parameters)
      assert.deepStrictEqual(result.body.tool_choice, { type: 'function', function: { name: 'get_weather' } })
    })

    it('Anthropic assistant thinking + text 内容块 → OpenAI reasoning_content + content 字符串', async () => {
      const result = await transformInboundRequest('anthropic', openaiRoute, {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: [
            { type: 'thinking', thinking: 'Let me analyze...', signature: 'sig123' },
            { type: 'text', text: 'The answer is 42' },
          ] },
        ],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      assert.strictEqual(msgs.length, 2)
      const asst = msgs[1] as Record<string, unknown>
      assert.strictEqual(asst.role, 'assistant')
      assert.strictEqual(asst.content, 'The answer is 42')
      assert.strictEqual(asst.reasoning_content, 'Let me analyze...')
      assert.strictEqual(asst.reasoning_signature, 'sig123')
    })

    it('Anthropic thinking + tool_use 共存时 reasoning_content 不丢失', async () => {
      const result = await transformInboundRequest('anthropic', openaiRoute, {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'what time is it' },
          { role: 'assistant', content: [
            { type: 'thinking', thinking: 'I need to call the time tool', signature: 's1' },
            { type: 'tool_use', id: 'tu_1', name: 'get_time', input: { timezone: 'UTC' } },
          ] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '2024-01-01T00:00:00Z' }] },
          { role: 'assistant', content: [
            { type: 'thinking', thinking: 'The time is midnight UTC', signature: 's2' },
            { type: 'text', text: 'It is currently midnight UTC.' },
          ] },
        ],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      // First assistant: thinking + tool_use
      const asst1 = msgs[1] as Record<string, unknown>
      assert.strictEqual(asst1.role, 'assistant')
      assert.strictEqual(asst1.reasoning_content, 'I need to call the time tool')
      assert.ok(Array.isArray(asst1.tool_calls))
      // Second assistant: thinking + text
      const asst2 = msgs[3] as Record<string, unknown>
      assert.strictEqual(asst2.role, 'assistant')
      assert.strictEqual(asst2.reasoning_content, 'The time is midnight UTC')
      assert.strictEqual(asst2.content, 'It is currently midnight UTC.')
    })

    it('助手消息 tool_calls → content 中 tool_use 块（有 reasoning）', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [
          { role: 'user', content: '看桌面' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: '需要查看桌面',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls ~/Desktop/"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'file.txt' },
        ],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      const assistant = msgs.find((m) => m.role === 'assistant')!
      const content = assistant.content as Array<Record<string, unknown>>
      assert.strictEqual(content[0].type, 'thinking')
      assert.strictEqual(content[0].thinking, '需要查看桌面')
      assert.strictEqual(content[1].type, 'tool_use')
      assert.strictEqual(content[1].id, 'call_1')
      assert.strictEqual(content[1].name, 'bash')
      assert.deepStrictEqual(content[1].input, { cmd: 'ls ~/Desktop/' })
      // tool_calls 不应出现在顶层
      assert.ok(!('tool_calls' in assistant))
    })

    it('助手消息 tool_calls → content 中 tool_use 块（无 reasoning）', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [
          { role: 'user', content: '看桌面' },
          {
            role: 'assistant',
            content: '正在查看',
            tool_calls: [
              { id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_2', content: 'files' },
        ],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      const assistant = msgs.find((m) => m.role === 'assistant')!
      const content = assistant.content as Array<Record<string, unknown>>
      // 没有 thinking，所以从 text 开始
      const textBlock = content.find((c) => c.type === 'text')
      assert.ok(textBlock, '应有 text 块')
      assert.strictEqual((textBlock as Record<string, unknown>).text, '正在查看')
      const toolUse = content.find((c) => c.type === 'tool_use')
      assert.ok(toolUse, '应有 tool_use 块')
      assert.strictEqual((toolUse as Record<string, unknown>).id, 'call_2')
      assert.ok(!('tool_calls' in assistant))
    })

    it('并行 tool_calls 转为多个 tool_use 块，连续 tool 消息合并为单个 user 消息', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [
          { role: 'user', content: '并行测试' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: '并行执行两个工具',
            tool_calls: [
              { id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
              { id: 'call_b', type: 'function', function: { name: 'bash', arguments: '{"cmd":"pwd"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_a', content: 'files' },
          { role: 'tool', tool_call_id: 'call_b', content: '/home' },
        ],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>

      // assistant 消息有两个 tool_use 块
      const assistant = msgs.find((m) => m.role === 'assistant')!
      const content = assistant.content as Array<Record<string, unknown>>
      const toolUses = content.filter((c) => c.type === 'tool_use')
      assert.strictEqual(toolUses.length, 2, '应有 2 个 tool_use 块')
      assert.strictEqual(toolUses[0].id, 'call_a')
      assert.strictEqual(toolUses[1].id, 'call_b')

      // tool_result 应合并到一个 user 消息
      const toolUserMsgs = msgs.filter((m: Record<string, unknown>) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as Array<Record<string, unknown>>).some((c) => c.type === 'tool_result')
      )
      assert.strictEqual(toolUserMsgs.length, 1, 'tool_result 应合并到单个 user 消息')
      const toolResults = (toolUserMsgs[0].content as Array<Record<string, unknown>>)
        .filter((c) => c.type === 'tool_result')
      assert.strictEqual(toolResults.length, 2, '单个 user 消息应有 2 个 tool_result')
      assert.strictEqual(toolResults[0].tool_use_id, 'call_a')
      assert.strictEqual(toolResults[1].tool_use_id, 'call_b')
    })

    it('单 tool_result 不合并——前后有非 tool 消息', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [
          { role: 'user', content: '单工具' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_x', type: 'function', function: { name: 'bash', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_x', content: 'done' },
          { role: 'assistant', content: '完成' },
        ],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      const toolUserMsgs = msgs.filter((m: Record<string, unknown>) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as Array<Record<string, unknown>>).some((c) => c.type === 'tool_result')
      )
      assert.strictEqual(toolUserMsgs.length, 1, '应有 1 个 tool_result user 消息')
      const toolResults = (toolUserMsgs[0].content as Array<Record<string, unknown>>)
        .filter((c) => c.type === 'tool_result')
      assert.strictEqual(toolResults.length, 1)
      // 后续 assistant 不应该丢失
      assert.ok(msgs.some((m) => m.role === 'assistant' && m.content === '完成'), '后续 assistant 消息应保留')
    })
  })
})

describe('proxy/response-conversion', () => {
  it('OpenAI 响应 → Anthropic 格式', () => {
    const openai = {
      id: 'chatcmpl-abc123',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-4o',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
    const result = convertOpenAIResponseToAnthropic(openai)
    assert.strictEqual(result.type, 'message')
    assert.strictEqual(result.role, 'assistant')
    const content = result.content as Array<Record<string, unknown>>
    assert.strictEqual(content[0].type, 'text')
    assert.strictEqual(content[0].text, 'Hello!')
    assert.strictEqual(result.stop_reason, 'end_turn')
    assert.strictEqual(result.usage.input_tokens, 10)
    assert.strictEqual(result.usage.output_tokens, 5)
  })

  it('Anthropic 响应 → OpenAI 格式', () => {
    const result = convertAnthropicResponseToOpenAI({
      id: 'msg_xyz',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there!' }],
      model: 'claude-sonnet-4',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    assert.strictEqual(result.object, 'chat.completion')
    const msg = (result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>
    assert.strictEqual(msg.content, 'Hi there!')
    assert.strictEqual(result.usage.prompt_tokens, 10)
    assert.strictEqual(result.usage.completion_tokens, 5)
  })

  it('OpenAI tool_calls → Anthropic tool_use', () => {
    const result = convertOpenAIResponseToAnthropic({
      choices: [{
        message: {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'get_weather', arguments: '{"loc":"NYC"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    })
    const content = result.content as Array<Record<string, unknown>>
    assert.strictEqual(content[0].type, 'tool_use')
    assert.strictEqual(content[0].name, 'get_weather')
    assert.deepStrictEqual(content[0].input, { loc: 'NYC' })
    assert.strictEqual(result.stop_reason, 'tool_use')
  })

  it('Anthropic tool_use → OpenAI tool_calls', () => {
    const result = convertAnthropicResponseToOpenAI({
      content: [
        { type: 'text', text: 'Let me check' },
        { type: 'tool_use', id: 'tu_123', name: 'get_weather', input: { loc: 'NYC' } },
      ],
      stop_reason: 'tool_use',
    })
    const msg = (result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>
    assert.strictEqual(msg.content, 'Let me check')
    const tcs = msg.tool_calls as Array<Record<string, unknown>>
    assert.strictEqual(tcs[0].id, 'tu_123')
    assert.strictEqual(tcs[0].type, 'function')
    assert.strictEqual((tcs[0].function as Record<string, unknown>).name, 'get_weather')
    assert.strictEqual((result.choices as Array<Record<string, unknown>>)[0].finish_reason, 'tool_calls')
  })

  it('并行 tool_use → 并行 tool_calls', () => {
    const result = convertAnthropicResponseToOpenAI({
      content: [
        { type: 'text', text: '查看结果' },
        { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls ~/Desktop/' } },
        { type: 'tool_use', id: 'tu_2', name: 'bash', input: { cmd: 'pwd' } },
      ],
      stop_reason: 'tool_use',
    })
    const msg = (result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>
    assert.strictEqual(msg.content, '查看结果')
    const tcs = msg.tool_calls as Array<Record<string, unknown>>
    assert.strictEqual(tcs.length, 2, '应有 2 个 tool_calls')
    assert.strictEqual(tcs[0].id, 'tu_1')
    assert.strictEqual(tcs[0].type, 'function')
    assert.strictEqual((tcs[0].function as Record<string, unknown>).name, 'bash')
    assert.strictEqual((tcs[0].function as Record<string, unknown>).arguments, '{"cmd":"ls ~/Desktop/"}')
    assert.strictEqual(tcs[1].id, 'tu_2')
    assert.strictEqual(tcs[1].type, 'function')
    assert.strictEqual((tcs[1].function as Record<string, unknown>).name, 'bash')
    assert.strictEqual((tcs[1].function as Record<string, unknown>).arguments, '{"cmd":"pwd"}')
    assert.strictEqual((result.choices as Array<Record<string, unknown>>)[0].finish_reason, 'tool_calls')
  })

  it('OpenAI Responses 响应 → Anthropic 格式', () => {
    const result = convertOpenAIResponsesToAnthropic({
      id: 'resp_abc',
      object: 'response',
      model: 'gpt-4o',
      output: [{
        type: 'message',
        id: 'msg_1',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello!', annotations: [] }],
      }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })
    assert.strictEqual(result.type, 'message')
    assert.strictEqual(result.role, 'assistant')
    const content = result.content as Array<Record<string, unknown>>
    assert.strictEqual(content.length, 1)
    assert.strictEqual(content[0].type, 'text')
    assert.strictEqual(content[0].text, 'Hello!')
    assert.strictEqual(result.stop_reason, 'end_turn')
    assert.strictEqual(result.usage.input_tokens, 10)
    assert.strictEqual(result.usage.output_tokens, 5)
  })

  it('OpenAI Responses function_call → Anthropic tool_use', () => {
    const result = convertOpenAIResponsesToAnthropic({
      output: [
        { type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '{"loc":"NYC"}' },
      ],
    })
    const content = result.content as Array<Record<string, unknown>>
    assert.strictEqual(content[0].type, 'tool_use')
    assert.strictEqual(content[0].name, 'get_weather')
    assert.deepStrictEqual(content[0].input, { loc: 'NYC' })
    assert.strictEqual(result.stop_reason, 'tool_use')
  })

  it('Anthropic 响应 → OpenAI Responses 格式', () => {
    const result = convertAnthropicResponseToOpenAIResponses({
      id: 'msg_xyz',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there!' }],
      model: 'claude-sonnet-4',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    assert.strictEqual(result.object, 'response')
    assert.strictEqual(result.status, 'completed')
    const output = result.output as Array<Record<string, unknown>>
    assert.ok(output.length >= 1)
    const msg = output[0]
    assert.strictEqual(msg.type, 'message')
    assert.strictEqual(msg.role, 'assistant')
    const msgContent = msg.content as Array<Record<string, unknown>>
    assert.strictEqual(msgContent[0].type, 'output_text')
    assert.strictEqual(msgContent[0].text, 'Hi there!')
    assert.strictEqual(result.usage.input_tokens, 10)
    assert.strictEqual(result.usage.output_tokens, 5)
  })

  it('OpenAI reasoning_content → Anthropic thinking 块', () => {
    const result = convertOpenAIResponseToAnthropic({
      choices: [{
        message: {
          role: 'assistant',
          content: 'The answer is 42',
          reasoning_content: 'Let me think about this...',
          reasoning_signature: 'sig_abc',
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
    const content = result.content as Array<Record<string, unknown>>
    assert.strictEqual(content.length, 2)
    assert.strictEqual(content[0].type, 'thinking')
    assert.strictEqual(content[0].thinking, 'Let me think about this...')
    assert.strictEqual(content[0].signature, 'sig_abc')
    assert.strictEqual(content[1].type, 'text')
    assert.strictEqual(content[1].text, 'The answer is 42')
  })

  it('Anthropic thinking + text → OpenAI reasoning_content + content', () => {
    const result = convertAnthropicResponseToOpenAI({
      id: 'msg_xyz',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me think...', signature: 's1' },
        { type: 'text', text: 'The answer is 42' },
      ],
      model: 'claude-sonnet-4',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const msg = (result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>
    assert.strictEqual(msg.content, 'The answer is 42')
    assert.strictEqual(msg.reasoning_content, 'Let me think...')
    assert.strictEqual(msg.reasoning_signature, 's1')
  })

  describe('thinking 配置注入', () => {
    it('同协议 Anthropic 注入 thinking.budget_tokens', async () => {
      const route = { ...anthropicRoute, thinking: { budget_tokens: 8192 } }
      const result = await transformInboundRequest('anthropic', route, {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10000,
      })
      assert.deepStrictEqual(result.body.thinking, { type: 'enabled', budget_tokens: 8192 })
      // max_tokens should remain unchanged since it's >= budget
      assert.strictEqual(result.body.max_tokens, 10000)
    })

    it('同协议 Anthropic 自动调整 max_tokens < budget_tokens', async () => {
      const route = { ...anthropicRoute, thinking: { budget_tokens: 8192 } }
      const result = await transformInboundRequest('anthropic', route, {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      })
      assert.strictEqual(result.body.max_tokens, 8192)
    })

    it('同协议 Anthropic max_tokens 未设置时自动设为 budget_tokens', async () => {
      const route = { ...anthropicRoute, thinking: { budget_tokens: 4096 } }
      const result = await transformInboundRequest('anthropic', route, {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
      })
      assert.strictEqual(result.body.max_tokens, 4096)
    })

    it('同协议 OpenAI 注入 reasoning_effort', async () => {
      const route = { ...openaiRoute, thinking: { reasoning_effort: 'medium' } }
      const result = await transformInboundRequest('openai', route, {
        model: 'o3-mini',
        messages: [{ role: 'user', content: 'hi' }],
      })
      assert.strictEqual(result.body.reasoning_effort, 'medium')
    })

    it('跨协议 OpenAI → Anthropic 注入 thinking', async () => {
      const route = { ...anthropicRoute, thinking: { budget_tokens: 8192 } }
      const result = await transformInboundRequest('openai', route, {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
      })
      assert.deepStrictEqual(result.body.thinking, { type: 'enabled', budget_tokens: 8192 })
      assert.strictEqual(result.body.max_tokens, 8192)
    })

    it('跨协议 Anthropic → OpenAI 注入 reasoning_effort', async () => {
      const route = { ...openaiRoute, thinking: { reasoning_effort: 'high' } }
      const result = await transformInboundRequest('anthropic', route, {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1000,
      })
      assert.strictEqual(result.body.reasoning_effort, 'high')
    })

    it('无 thinking 配置时不注入任何参数', async () => {
      const result = await transformInboundRequest('anthropic', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
      })
      assert.strictEqual(result.body.thinking, undefined)
    })

    it('对话中已有 thinking 时，工具调用 assistant 自动补占位 thinking', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [
          { role: 'user', content: '看桌面' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: '让我检查一下桌面',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'files' },
        ],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      const asst = msgs.find((m) => m.role === 'assistant')!
      const content = asst.content as Array<Record<string, unknown>>
      // 有 reasoning_content，convertMessagesToAnthropic 已创建 thinking 块
      assert.strictEqual(content[0].type, 'thinking', '首块应为 thinking')
      assert.strictEqual(content[0].thinking, '让我检查一下桌面', '保留原始 reasoning')
      assert.strictEqual(content[1].type, 'tool_use')
    })

    it('已有 thinking 块时，后续无 reasoning 的 tool_calls 也补占位', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '你好', reasoning_content: '用中文回应' },
          { role: 'user', content: '看桌面' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: '需要查看桌面',
            tool_calls: [
              { id: 'c2', type: 'function', function: { name: 'bash', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c2', content: 'files' },
          { role: 'user', content: '继续' },
          {
            role: 'assistant',
            content: null,
            // 无 reasoning_content——之前对话已有 thinking，应补占位
            tool_calls: [
              { id: 'c3', type: 'function', function: { name: 'bash', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c3', content: 'done' },
        ],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      // 第一条 assistant（有 reasoning）— 保留原始
      const asst1 = msgs[1] as Record<string, unknown>
      assert.strictEqual((asst1.content as Array<Record<string, unknown>>)[0].thinking, '用中文回应')
      // 第二条 assistant（有 reasoning + tool_calls）— 已有 thinking，不重复
      const asst2 = msgs[3] as Record<string, unknown>
      const c2 = asst2.content as Array<Record<string, unknown>>
      assert.strictEqual(c2[0].thinking, '需要查看桌面')
      assert.strictEqual(c2[1].type, 'tool_use')
      assert.strictEqual(c2.length, 2, '不应重复插入 thinking')
      // 第三条 assistant（无 reasoning，仅有 tool_calls）— 应补占位
      const asst3 = msgs[6] as Record<string, unknown>
      const c3 = asst3.content as Array<Record<string, unknown>>
      assert.strictEqual(c3[0].type, 'thinking', '首块应为 thinking')
      assert.strictEqual(c3[0].thinking, '让我调用 bash 工具', '应有描述性占位')
      assert.strictEqual(c3[1].type, 'tool_use')
    })

    it('thinking 模式未启用时不补占位 thinking', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c3', type: 'function', function: { name: 'test', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c3', content: 'ok' },
        ],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      const asst = msgs.find((m) => m.role === 'assistant')!
      const content = asst.content as Array<Record<string, unknown>>
      // 没有 thinking 配置，也没有任何 assistant 有 reasoning_content，所以不补 thinking
      const hasThinking = content.some((c) => c.type === 'thinking')
      assert.strictEqual(hasThinking, false, '无 thinking 配置时不应有 thinking 块')
    })

    it('无 thinking 配置但对话中已有 reasoning_content 时自动补占位 thinking', async () => {
      // 用户没配 thinking.budget_tokens，但之前的 assistant 消息有 reasoning_content
      // 说明对话已经在 thinking 模式下
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '好的',
            reasoning_content: '用户打招呼，我用中文回应',
          },
          { role: 'user', content: '看桌面' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c4', type: 'function', function: { name: 'bash', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c4', content: 'files' },
        ],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      // 第一条 assistant（有 reasoning）— 已有 thinking，不改
      const asst1 = msgs.find((m: Record<string, unknown>) => m.role === 'assistant' && (m.content as Array<Record<string, unknown>>)?.some((c: Record<string, unknown>) => c.type === 'thinking' && (c as any).thinking === '用户打招呼，我用中文回应'))
      assert.ok(asst1, '第一条 assistant 的 thinking 保留')
      // 第二条 assistant（工具调用，无 reasoning）— 应自动补占位 thinking
      const asst2 = msgs.filter((m: Record<string, unknown>) => m.role === 'assistant')[1]
      const content2 = asst2.content as Array<Record<string, unknown>>
      assert.strictEqual(content2[0].type, 'thinking', '工具调用 assistant 首块应为 thinking')
      assert.strictEqual(content2[0].thinking, '让我调用 bash 工具', '应有描述性占位')
      assert.strictEqual(content2[1].type, 'tool_use', '第二块为 tool_use')
    })

    it('thinking 签名：上游有 reasoning_signature 时优先使用', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: 'Thinking text',
            reasoning_signature: 'upstream_sig_abc',
          },
        ],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      const asst = msgs.find((m) => m.role === 'assistant')!
      const thinking = (asst.content as Array<Record<string, unknown>>)[0]
      assert.strictEqual(thinking.signature, 'upstream_sig_abc', '应使用上游原始签名')
    })

    it('thinking 签名：上游无 reasoning_signature 时自动 SHA-256 生成', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: 'Hello world',
            // 故意不传 reasoning_signature
          },
        ],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      const asst = msgs.find((m) => m.role === 'assistant')!
      const thinking = (asst.content as Array<Record<string, unknown>>)[0]
      // SHA-256('Hello world') 前16字符
      const expectedSig = '64ec88ca00b268e5'
      assert.strictEqual(thinking.signature, expectedSig, '应自动生成 SHA-256 签名')
    })
  })
})
