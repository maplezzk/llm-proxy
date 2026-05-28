import { describe, it } from 'node:test'
import assert from 'node:assert'
import { transformInboundRequest, convertOpenAIResponseToAnthropic, convertAnthropicResponseToOpenAI, convertOpenAIResponsesToAnthropic, convertAnthropicResponseToOpenAIResponses, convertOpenAIResponsesResponseToOpenAI, buildNamespaceToolContext, remapNamespaceFunctionCalls } from '../../src/proxy/translation.js'

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

    it('Anthropic → Anthropic 同协议：built-in tools 透传', async () => {
      const result = await transformInboundRequest('anthropic', anthropicRoute, {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'control computer' }],
        tools: [
          { type: 'computer_20251124', name: 'computer', display_width_px: 1024, display_height_px: 768 },
          { type: 'bash_20250124', name: 'bash' },
        ],
      })
      const tools = result.body.tools as Array<Record<string, unknown>>
      assert.ok(tools, 'built-in tools 应被透传')
      const computerTool = tools.find((t) => t.name === 'computer')
      assert.ok(computerTool, 'computer tool 应被保留')
      assert.strictEqual((computerTool as Record<string, unknown>).type, 'computer_20251124')
      const bashTool = tools.find((t) => t.name === 'bash')
      assert.ok(bashTool, 'bash tool 应被保留')
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
      assert.strictEqual(result.body.tool_choice.type, 'any')
    })

    it('built-in tool: computer_use_preview → Anthropic computer_20251124', async () => {
      const result = await transformInboundRequest('openai-responses', anthropicRoute, {
        model: 'claude-sonnet',
        input: 'control the computer',
        tools: [{
          type: 'computer_use_preview',
          display_width: 1024,
          display_height: 768,
        }],
      })
      const tools = result.body.tools as Array<Record<string, unknown>>
      assert.ok(tools, 'computer_use_preview 不应被过滤')
      assert.strictEqual(tools.length, 1)
      assert.strictEqual(tools[0].type, 'computer_20251124')
      assert.strictEqual(tools[0].name, 'computer')
      assert.strictEqual(tools[0].display_width_px, 1024)
      assert.strictEqual(tools[0].display_height_px, 768)
    })

    it('built-in tool: web_search_preview / code_interpreter / file_search → 被过滤（无 Anthropic 等效工具）', async () => {
      const result = await transformInboundRequest('openai-responses', anthropicRoute, {
        model: 'claude-sonnet',
        input: 'search something',
        tools: [
          { type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { loc: { type: 'string' } } } } },
          { type: 'web_search_preview' },
          { type: 'code_interpreter' },
          { type: 'file_search' },
        ],
      })
      const tools = result.body.tools as Array<Record<string, unknown>>
      assert.ok(tools, 'function tool 仍然保留')
      assert.strictEqual(tools.length, 1)
      assert.strictEqual(tools[0].name, 'get_weather')
    })

    it('built-in tool: 混合 function + computer_use_preview', async () => {
      const result = await transformInboundRequest('openai-responses', anthropicRoute, {
        model: 'claude-sonnet',
        input: 'use the computer',
        tools: [
          { type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: {} } },
          { type: 'computer_use_preview', display_width: 1920, display_height: 1080 },
        ],
      })
      const tools = result.body.tools as Array<Record<string, unknown>>
      assert.strictEqual(tools.length, 2)
      // function tool preserved
      assert.strictEqual(tools[0].name, 'get_weather')
      // computer tool mapped
      assert.strictEqual(tools[1].type, 'computer_20251124')
      assert.strictEqual(tools[1].name, 'computer')
    })

    it('computer_call_output input → Anthropic tool_result with image', async () => {
      const result = await transformInboundRequest('openai-responses', anthropicRoute, {
        model: 'claude-sonnet',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what do you see?' }] },
          {
            type: 'computer_call_output',
            call_id: 'call_123',
            output: { type: 'computer_screenshot', image_url: 'https://example.com/screen.png' },
          },
        ],
        tools: [{ type: 'computer_use_preview' }],
      })
      const msgs = result.body.messages as Array<Record<string, unknown>>
      // First message: user text
      assert.strictEqual(msgs[0].role, 'user')
      assert.strictEqual(msgs[0].content, 'what do you see?')
      // Second message: tool_result with image (tool role → combined into user message with tool_results)
      assert.strictEqual(msgs[1].role, 'user')
      const content = msgs[1].content as Array<Record<string, unknown>>
      assert.strictEqual(content[0].type, 'tool_result')
      assert.strictEqual(content[0].tool_use_id, 'call_123')
      const trContent = content[0].content as Array<Record<string, unknown>>
      assert.strictEqual(trContent[0].type, 'image')
      const source = trContent[0].source as Record<string, unknown>
      assert.strictEqual(source.type, 'url')
      assert.strictEqual(source.url, 'https://example.com/screen.png')
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

    it('Responses → Responses 同协议：built-in tools 透传', async () => {
      const result = await transformInboundRequest('openai-responses', responsesRoute, {
        model: 'gpt-4o',
        input: 'control computer',
        tools: [
          { type: 'computer_use_preview', display_width: 1024, display_height: 768 },
          { type: 'web_search_preview' },
        ],
      })
      const tools = result.body.tools as Array<Record<string, unknown>>
      assert.ok(tools, 'built-in tools 应被透传')
      const cuTool = tools.find((t) => t.type === 'computer_use_preview')
      assert.ok(cuTool, 'computer_use_preview 应被保留')
      const wsTool = tools.find((t) => t.type === 'web_search_preview')
      assert.ok(wsTool, 'web_search_preview 应被保留')
    })
  })

  describe('跨协议翻译 — Anthropic → OpenAI Responses', () => {
    const responsesRoute = {
      providerName: 'responses-main',
      providerType: 'openai-responses' as const,
      apiKey: 'sk-resp-1',
      apiBase: 'https://api.openai.com',
      modelId: 'gpt-4o',
    }

    it('user message 带 tool_result（含 image）→ computer_call_output', async () => {
      const result = await transformInboundRequest('anthropic', responsesRoute, {
        model: 'claude-sonnet',
        messages: [
          { role: 'user', content: 'what do you see?' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me look' },
              { type: 'tool_use', id: 'toolu_1', name: 'computer', input: { action: 'screenshot' } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [
                  { type: 'text', text: 'Screenshot taken' },
                  { type: 'image', source: { type: 'url', url: 'https://example.com/desktop.png' } },
                ],
              },
            ],
          },
        ],
      })
      const input = result.body.input as Array<Record<string, unknown>>
      assert.ok(input, 'input should exist')
      // Find computer_call_output items
      const cco = input.filter((item) => item.type === 'computer_call_output')
      assert.strictEqual(cco.length, 1, '应有 1 个 computer_call_output')
      assert.strictEqual(cco[0].call_id, 'toolu_1')
      const output = cco[0].output as Record<string, unknown>
      assert.strictEqual(output.type, 'computer_screenshot')
      assert.strictEqual(output.image_url, 'https://example.com/desktop.png')
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

    it('built-in tool: computer_20251124 → OpenAI computer_use_preview', async () => {
      const result = await transformInboundRequest('anthropic', openaiRoute, {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'control computer' }],
        tools: [{
          type: 'computer_20251124',
          name: 'computer',
          display_width_px: 1024,
          display_height_px: 768,
          display_number: 1,
        }],
      })
      const tools = result.body.tools as Array<Record<string, unknown>>
      assert.ok(tools, 'computer_20251124 不应被过滤')
      assert.strictEqual(tools.length, 1)
      assert.strictEqual(tools[0].type, 'computer_use_preview')
    })

    it('built-in tool: bash + text_editor → 被过滤（无 OpenAI 等效工具）', async () => {
      const result = await transformInboundRequest('anthropic', openaiRoute, {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'run command' }],
        tools: [
          { name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: {} } },
          { type: 'bash_20250124', name: 'bash' },
          { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
        ],
      })
      const tools = result.body.tools as Array<Record<string, unknown>>
      assert.ok(tools, 'function tool 仍然保留')
      assert.strictEqual(tools.length, 1)
      assert.strictEqual(tools[0].type, 'function')
      const fn = tools[0].function as Record<string, unknown>
      assert.strictEqual(fn.name, 'get_weather')
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

  it('OpenAI Responses computer_call → Anthropic tool_use (computer)', () => {
    const result = convertOpenAIResponsesToAnthropic({
      output: [{
        type: 'computer_call',
        id: 'cc_1',
        call_id: 'call_screenshot',
        action: { type: 'screenshot' },
        pending_safety_checks: [],
        status: 'completed',
      }],
    })
    const content = result.content as Array<Record<string, unknown>>
    assert.strictEqual(content[0].type, 'tool_use')
    assert.strictEqual(content[0].name, 'computer')
    const input = content[0].input as Record<string, unknown>
    assert.strictEqual(input.action, 'screenshot')
    assert.strictEqual(result.stop_reason, 'tool_use')
  })

  it('OpenAI Responses click action → Anthropic coordinate', () => {
    const result = convertOpenAIResponsesToAnthropic({
      output: [{
        type: 'computer_call',
        call_id: 'call_click',
        action: { type: 'click', x: 100, y: 200 },
        status: 'completed',
      }],
    })
    const content = result.content as Array<Record<string, unknown>>
    const input = content[0].input as Record<string, unknown>
    assert.strictEqual(input.action, 'click')
    assert.deepStrictEqual(input.coordinate, [100, 200])
  })

  it('OpenAI Responses keypress → Anthropic key + text', () => {
    const result = convertOpenAIResponsesToAnthropic({
      output: [{
        type: 'computer_call',
        call_id: 'call_key',
        action: { type: 'keypress', keys: ['ctrl', 'c'] },
        status: 'completed',
      }],
    })
    const content = result.content as Array<Record<string, unknown>>
    const input = content[0].input as Record<string, unknown>
    assert.strictEqual(input.action, 'key')
    assert.strictEqual(input.text, 'ctrlc')
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

  it('Anthropic tool_use (computer) → OpenAI Responses computer_call', () => {
    const result = convertAnthropicResponseToOpenAIResponses({
      content: [
        { type: 'text', text: 'Taking screenshot' },
        { type: 'tool_use', id: 'toolu_1', name: 'computer', input: { action: 'screenshot' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const output = result.output as Array<Record<string, unknown>>
    // First item should be message
    assert.strictEqual(output[0].type, 'message')
    // Second item should be computer_call
    const cc = output[1]
    assert.strictEqual(cc.type, 'computer_call')
    assert.strictEqual(cc.call_id, 'toolu_1')
    const action = cc.action as Record<string, unknown>
    assert.strictEqual(action.type, 'screenshot')
    assert.deepStrictEqual(cc.pending_safety_checks, [])
    assert.strictEqual(cc.status, 'completed')
  })

  it('Anthropic tool_use (computer) click → OpenAI click action with coordinates', () => {
    const result = convertAnthropicResponseToOpenAIResponses({
      content: [
        { type: 'tool_use', id: 'toolu_2', name: 'computer', input: { action: 'click', coordinate: [500, 300] } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 3 },
    })
    const output = result.output as Array<Record<string, unknown>>
    const cc = output[1]
    const action = cc.action as Record<string, unknown>
    assert.strictEqual(action.type, 'click')
    assert.strictEqual(action.x, 500)
    assert.strictEqual(action.y, 300)
  })

  it('Anthropic tool_use (bash) → 不转为特殊 item（保持 function_call 格式）', () => {
    const result = convertAnthropicResponseToOpenAIResponses({
      content: [
        { type: 'tool_use', id: 'toolu_3', name: 'bash', input: { cmd: 'ls' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 3 },
    })
    const output = result.output as Array<Record<string, unknown>>
    const fc = output[1]
    assert.strictEqual(fc.type, 'function_call')
    assert.strictEqual(fc.name, 'bash')
  })

  it('OpenAI Responses computer_call → Chat tool_calls (lossy)', () => {
    const result = convertOpenAIResponsesResponseToOpenAI({
      output: [{
        type: 'computer_call',
        id: 'cc_1',
        call_id: 'call_click',
        action: { type: 'click', x: 100, y: 200 },
        status: 'completed',
      }],
      status: 'completed',
    })
    const tcs = (result.choices[0].message as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>
    assert.ok(tcs, 'computer_call → Chat tool_calls')
    assert.strictEqual(tcs.length, 1)
    assert.strictEqual(tcs[0].function.name, 'computer')
    const args = JSON.parse(tcs[0].function.arguments as string)
    assert.strictEqual(args.type, 'click')
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
      // 即使没有 thinking 配置，也始终补空 thinking 块确保格式一致
      const hasThinking = content.some((c) => c.type === 'thinking')
      assert.strictEqual(hasThinking, true, '应有默认空的 thinking 块')
      const thinkingBlock = content.find((c) => c.type === 'thinking')!
      assert.strictEqual(thinkingBlock.thinking, '', 'thinking 内容应为空字符串')
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

  describe('stream 默认值 fallback', () => {
    it('同协议 Anthropic→Anthropic: 未传 stream → 设为 false', async () => {
      const result = await transformInboundRequest('anthropic', anthropicRoute, {
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      })
      assert.strictEqual(result.crossProtocol, false)
      assert.strictEqual(
        (result.body as Record<string, unknown>).stream,
        false,
        '未传 stream 时应默认 false',
      )
    })

    it('同协议 Anthropic→Anthropic: stream: true → 保持 true', async () => {
      const result = await transformInboundRequest('anthropic', anthropicRoute, {
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      assert.strictEqual(
        (result.body as Record<string, unknown>).stream,
        true,
        'stream:true 应保持 true',
      )
    })

    it('同协议 Anthropic→Anthropic: stream: false → 保持 false', async () => {
      const result = await transformInboundRequest('anthropic', anthropicRoute, {
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })
      assert.strictEqual(
        (result.body as Record<string, unknown>).stream,
        false,
        'stream:false 应保持 false',
      )
    })

    it('跨协议 OpenAI Chat→Anthropic: 未传 stream → 设为 false', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      })
      assert.strictEqual(result.crossProtocol, true)
      assert.strictEqual(
        (result.body as Record<string, unknown>).stream,
        false,
        '跨协议未传 stream 时应默认 false',
      )
    })

    it('跨协议 OpenAI Chat→Anthropic: stream: true → 保持 true', async () => {
      const result = await transformInboundRequest('openai', anthropicRoute, {
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      assert.strictEqual(
        (result.body as Record<string, unknown>).stream,
        true,
        '跨协议 stream:true 应保持 true',
      )
    })

    it('跨协议 Anthropic→OpenAI: 未传 stream → 设为 false', async () => {
      const result = await transformInboundRequest('anthropic', openaiRoute, {
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      })
      assert.strictEqual(result.crossProtocol, true)
      assert.strictEqual(
        (result.body as Record<string, unknown>).stream,
        false,
        '跨协议未传 stream 时应默认 false',
      )
    })

    it('跨协议 Anthropic→OpenAI: stream: true → 保持 true', async () => {
      const result = await transformInboundRequest('anthropic', openaiRoute, {
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      assert.strictEqual(
        (result.body as Record<string, unknown>).stream,
        true,
        '跨协议 stream:true 应保持 true',
      )
    })
  })

  describe('Namespace 工具后处理 (CCX 兼容)', () => {
    it('buildNamespaceToolContext: 从 namespace 工具构建查找表', () => {
      const tools = [{
        type: 'namespace',
        name: 'mcp__vscode_mcp__',
        tools: [{
          type: 'function',
          name: 'execute_command',
          parameters: { type: 'object', properties: {} },
        }],
      }]

      const ctx = buildNamespaceToolContext(tools)
      assert.strictEqual(ctx.size, 1)

      const spec = ctx.get('mcp__vscode_mcp__execute_command')
      assert.ok(spec, '应找到展平后的工具名')
      assert.strictEqual(spec.namespace, 'mcp__vscode_mcp__')
      assert.strictEqual(spec.name, 'execute_command')
    })

    it('buildNamespaceToolContext: namespace 以 __ 结尾时不加额外分隔符', () => {
      const tools = [{
        type: 'namespace',
        name: 'mcp__',
        tools: [{
          type: 'function',
          name: 'foo',
          parameters: { type: 'object', properties: {} },
        }],
      }]

      const ctx = buildNamespaceToolContext(tools)
      assert.strictEqual(ctx.size, 1)
      assert.ok(ctx.has('mcp__foo'), '展平后应为 mcp__foo 而非 mcp____foo')
    })

    it('remapNamespaceFunctionCalls: 匹配时加回 namespace', () => {
      const ctx = new Map([
        ['mcp__vscode_mcp__execute_command', { namespace: 'mcp__vscode_mcp__', name: 'execute_command' }],
      ])

      const output: Record<string, unknown>[] = [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'mcp__vscode_mcp__execute_command',
        arguments: '{"command":"test"}',
      }]

      remapNamespaceFunctionCalls(output, ctx)

      assert.strictEqual(output[0].name as string, 'execute_command')
      assert.strictEqual(output[0].namespace as string, 'mcp__vscode_mcp__')
      assert.strictEqual(output[0].arguments as string, '{"command":"test"}')
    })

    it('remapNamespaceFunctionCalls: 不匹配的工具名不受影响', () => {
      const ctx = new Map([
        ['mcp__vscode_mcp__execute_command', { namespace: 'mcp__vscode_mcp__', name: 'execute_command' }],
      ])

      const output: Record<string, unknown>[] = [{
        type: 'function_call',
        call_id: 'call_2',
        name: 'do_something',
        arguments: '{}',
      }]

      remapNamespaceFunctionCalls(output, ctx)

      assert.strictEqual(output[0].name as string, 'do_something')
      assert.strictEqual(output[0].namespace as string, undefined)
    })

    it('remapNamespaceFunctionCalls: 空上下文不修改输出', () => {
      const ctx = new Map()

      const output: Record<string, unknown>[] = [{
        type: 'function_call',
        call_id: 'call_3',
        name: 'foo',
        arguments: '{}',
      }]

      const original = JSON.stringify(output)
      remapNamespaceFunctionCalls(output, ctx)
      assert.strictEqual(JSON.stringify(output), original)
    })

    it('remapNamespaceFunctionCalls: computer_call 类型不受影响', () => {
      const ctx = new Map([
        ['mcp__vscode_mcp__execute_command', { namespace: 'mcp__vscode_mcp__', name: 'execute_command' }],
      ])

      const output: Record<string, unknown>[] = [{
        type: 'computer_call',
        call_id: 'cc_1',
        action: { type: 'screenshot' },
        status: 'completed',
      }]

      const original = JSON.stringify(output)
      remapNamespaceFunctionCalls(output, ctx)
      assert.strictEqual(JSON.stringify(output), original)
    })

    it('Anthropic → Responses: function_call 经后处理加回 namespace', () => {
      // 模拟 Anthropic 响应中包含一个经 __ 编码的 tool_use
      const anthropicBody = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'mcp__vscode_mcp__execute_command', input: { command: 'test' } },
        ],
        model: 'claude-sonnet-4',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }

      const result = convertAnthropicResponseToOpenAIResponses(anthropicBody)

      // 基础转换：tool_use → function_call，名称保留原样（含 namespace 前缀）
      const output = result.output as Array<Record<string, unknown>>
      const fcItem = output.find((i) => i.type === 'function_call') as Record<string, unknown> | undefined
      assert.ok(fcItem, '应有 function_call 输出项')

      // 基础转换不解码 __，保持原始名字
      assert.strictEqual(fcItem.name as string, 'mcp__vscode_mcp__execute_command')

      // 后处理 (remapNamespaceFunctionCalls) 查表解开
      const originalTools = [{
        type: 'namespace',
        name: 'mcp__vscode_mcp__',
        tools: [{ type: 'function', name: 'execute_command' }],
      }]
      const namespaceCtx = buildNamespaceToolContext(originalTools)
      remapNamespaceFunctionCalls(output, namespaceCtx)

      assert.strictEqual(fcItem.name as string, 'execute_command')
      assert.strictEqual(fcItem.namespace as string, 'mcp__vscode_mcp__')
    })
  })
})
