/**
 * 全链路端到端测试：模拟 Codex 发请求 → 转换 → 上游 → 转换回 Responses 的完整过程。
 * 对比 CCX 和我们的每一步输出。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  transformInboundRequest,
  convertOpenAIResponseToOpenAIResponses,
  convertAnthropicResponseToOpenAIResponses,
} from '../../src/proxy/translation.js'

/** 模拟上游路由配置 */
const openaiRoute = {
  providerName: 'cider-anthropic',
  providerType: 'openai' as const,
  apiKey: 'sk-test',
  apiBase: 'https://api.deepseek.com',
  modelId: 'deepseek-v4-flash',
}

/**
 * 模拟 Codex 发送的 Responses API 请求（简化版，包含关键字段）。
 * 这是 Codex 用 Computer Use skill 时会发出的请求。
 */
const CODEX_REQUEST = {
  model: 'gpt-5',
  instructions: 'You are Codex, a coding assistant with computer use capabilities...',
  input: [
    {
      type: 'message',
      role: 'user',
      content: 'Using the Computer Use skill to open Chrome, navigate to Google, and take a screenshot.',
    },
  ],
  tools: [
    // 用户定义的函数工具
    { type: 'function', name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
  ],
  tool_choice: 'auto',
  stream: true,
  previous_response_id: 'resp_prev_123',
  temperature: 0.7,
  top_p: 1.0,
}

/**
 * 模拟上游 Chat API 返回的响应（对应 Codex 请求）。
 * 注意：model 可能不调用任何工具，只返回文本。
 */
const UPSTREAM_CHAT_RESPONSE = {
  id: 'chatcmpl-123',
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: 'deepseek-v4-flash',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: '我来用 Computer Use 打开 Chrome。',
    },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
}

describe('全链路端到端', () => {
  describe('请求端：Codex → llm-proxy → 上游 Chat', () => {
    it('tools 正确过滤：保留用户工具，剥离 Codex 内部工具', async () => {
      const requestWithMCPTools = {
        ...CODEX_REQUEST,
        tools: [
          ...CODEX_REQUEST.tools,
          // 这些是 Codex 内部工具，应该被剥离
          { type: 'function', name: 'list_mcp_resources', parameters: { type: 'object', properties: { server: { type: 'string' } } } },
          { type: 'function', name: 'list_mcp_resource_templates', parameters: { type: 'object', properties: { server: { type: 'string' } } } },
          { type: 'function', name: 'read_mcp_resource', parameters: { type: 'object', properties: { server: { type: 'string' }, uri: { type: 'string' } } } },
          { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
        ],
      }

      const result = await transformInboundRequest('openai-responses', openaiRoute, requestWithMCPTools)
      const tools = result.body.tools as Array<Record<string, unknown>> | undefined
      
      console.log('  请求端上游 tools:', tools?.map((t: any) => t.function?.name ?? t.name))
      
      assert.ok(tools, '应该有 tools')
      const toolNames = tools.map((t: any) => t.function?.name ?? t.name)
      
      // 用户工具应保留
      assert.ok(toolNames.includes('get_weather'), '用户工具 get_weather 应保留')
      
      // Codex 内部工具应剥离
      assert.ok(!toolNames.includes('list_mcp_resources'), 'list_mcp_resources 应剥离')
      assert.ok(!toolNames.includes('list_mcp_resource_templates'), 'list_mcp_resource_templates 应剥离')
      assert.ok(!toolNames.includes('read_mcp_resource'), 'read_mcp_resource 应剥离')
      // exec_command 是 Codex bash 执行工具，不应剥离
      assert.ok(toolNames.includes('exec_command'), 'exec_command 应保留（Codex bash 工具）')
    })

    it('instructions → system message（CCX 行为）', async () => {
      const result = await transformInboundRequest('openai-responses', openaiRoute, CODEX_REQUEST)
      const messages = result.body.messages as Array<Record<string, unknown>>
      
      console.log('  消息数量和角色:', messages.map((m: any) => m.role))
      
      // 应该有一条 system 消息（来自 instructions）
      const systemMsg = messages.find((m: any) => m.role === 'system')
      assert.ok(systemMsg, 'instructions 应转为 system message')
      assert.ok(String(systemMsg.content).includes('Codex'), '有 Codex 相关内容')
    })

    it('namespace 工具展平为 function 工具（CCX namespaceToolsToOpenAI）', async () => {
      const requestWithNamespace = {
        ...CODEX_REQUEST,
        tools: [
          ...CODEX_REQUEST.tools,
          {
            type: 'namespace',
            name: 'mcp__computer_use__',
            tools: [
              { type: 'function', name: 'get_app_state', parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] } },
              { type: 'function', name: 'click', parameters: { type: 'object', properties: { app: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['app'] } },
            ],
          },
        ],
      }

      const result = await transformInboundRequest('openai-responses', openaiRoute, requestWithNamespace)
      const tools = result.body.tools as Array<Record<string, unknown>> | undefined
      
      assert.ok(tools, '应该有 tools')
      const toolNames = tools.map((t: any) => t.function?.name ?? t.name)
      
      console.log('  namespace 展平后的 tools:', toolNames)

      // namespace 工具应展平，MCP probe 工具应剥离
      assert.ok(toolNames.includes('mcp__computer_use__get_app_state'), 'get_app_state 应展平保留')
      assert.ok(toolNames.includes('mcp__computer_use__click'), 'click 应展平保留')
      assert.ok(toolNames.includes('get_weather'), '用户工具应保留')
      assert.ok(!toolNames.includes('list_mcp_resources'), 'list_mcp_resources 应剥离')
      assert.ok(toolNames.includes('exec_command'), 'exec_command 应保留（Codex bash 工具）')
    })
  })

  describe('响应端：Chat → Responses（非流式）', () => {
    it('响应包含 model 字段（Responses API 必需）', () => {
      const result = convertOpenAIResponseToOpenAIResponses(UPSTREAM_CHAT_RESPONSE)
      
      console.log('  响应字段:', Object.keys(result as Record<string, unknown>))
      
      // Responses API 响应必须包含 model
      assert.ok((result as Record<string, unknown>).model, '响应应包含 model 字段')
      // CCX 在回显中也包含其他字段
      assert.ok((result as Record<string, unknown>).status, '响应应包含 status')
    })

    it('响应包含 created_at（非流式）', () => {
      const result = convertOpenAIResponseToOpenAIResponses(UPSTREAM_CHAT_RESPONSE)
      assert.ok((result as Record<string, unknown>).created_at, '非流式响应应包含 created_at')
    })

    it('Anthropic→Responses 响应也包含 model', () => {
      const anthropicBody = {
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
        model: 'claude-sonnet-4',
        usage: { input_tokens: 10, output_tokens: 5 },
      }
      const result = convertAnthropicResponseToOpenAIResponses(anthropicBody)
      assert.ok((result as Record<string, unknown>).model, 'Anthropic→Responses 响应应包含 model')
    })
  })
})
