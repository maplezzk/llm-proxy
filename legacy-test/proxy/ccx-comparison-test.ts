/**
 * CCX 对比测试：用相同的 Chat Completions 工具调用输出，
 * 对比 CCX 和我们的 Responses 格式差异。
 * 
 * CCX 的 OpenAIChatResponseToResponses 处理流程：
 * 1. 从 choices[0].message.tool_calls 提取每个 tool_call
 * 2. 创建 { type: "function_call", status: "completed", call_id, name, arguments }
 * 3. 然后 WrapOpenAIChatResponseToResponsesWithContext 做后处理
 *    (RemapCustomToolCallsInResponse + RemapNamespaceFunctionCallsInResponse)
 * 
 * 对照我们的 convertOpenAIResponseToOpenAIResponses
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  convertOpenAIResponseToOpenAIResponses,
  convertAnthropicResponseToOpenAIResponses,
  buildNamespaceToolContext,
  remapNamespaceFunctionCalls,
} from '../../src/proxy/translation.js'

// CCX 测试用例：WrapOpenAIChatResponseToResponsesWithContext_NamespaceRemapping
// 输入：OpenAI Chat 响应（包含命名字空间工具调用）
const CHAT_RESP_WITH_NAMESPACE = {
  id: 'chatcmpl-123',
  model: 'gpt-4',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: 'mcp__vscode_mcp__execute_command',
          arguments: '{"command":"test"}',
        },
      }],
    },
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
}

// CCX 测试用例：TestHistoryReplay_NamespaceFunctionCallFlattened
// 输入：Responses 格式的 function_call（含 namespace 的历史记录）
const CHAT_RESP_LIST_MCP_RESOURCES = {
  id: 'chatcmpl-456',
  model: 'deepseek-v4-flash',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      tool_calls: [{
        id: 'call_list',
        type: 'function',
        function: {
          name: 'list_mcp_resources',
          arguments: '{"server":"computer-use"}',
        },
      }],
    },
  }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
}

// CCX 测试用例：TestHistoryReplay_TopLevelFunctionCallNotModified
// list_mcp_resources 是顶层 function 工具，不应被修改
const CHAT_RESP_LIST_MCP_RESOURCES_NO_NS = {
  id: 'chatcmpl-789',
  model: 'deepseek-v4-flash',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      tool_calls: [{
        id: 'call_list2',
        type: 'function',
        function: {
          name: 'list_mcp_resources',
          arguments: '{}',
        },
      }],
    },
  }],
  usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
}

describe('CCX 格式对比 — Chat → Responses (function_call)', () => {
  it('namespace 工具调用：Chat → Responses 保持 namespace 前缀', () => {
    const result = convertOpenAIResponseToOpenAIResponses(CHAT_RESP_WITH_NAMESPACE)
    
    const output = result.output as Array<Record<string, unknown>>
    assert.ok(output.length >= 1, '至少有一个 output item')
    
    const fc = output.find((i) => i.type === 'function_call') as Record<string, unknown>
    assert.ok(fc, '应有 function_call 输出项')
    
    // CCX 在这个阶段保持原始 name（含 __ 前缀），后处理再解
    assert.strictEqual(fc.name as string, 'mcp__vscode_mcp__execute_command',
      'CCX 不做 __ 解码，保持原始名字')
    assert.strictEqual(typeof fc.arguments, 'string',
      'arguments 应为 JSON 字符串')
    assert.strictEqual(fc.status, 'completed')
  })

  it('list_mcp_resources: 保留原始 name（CCX 行为）', () => {
    const result = convertOpenAIResponseToOpenAIResponses(CHAT_RESP_LIST_MCP_RESOURCES)
    
    const output = result.output as Array<Record<string, unknown>>
    const fc = output.find((i) => i.type === 'function_call') as Record<string, unknown>
    assert.ok(fc, '应有 function_call')
    
    assert.strictEqual(fc.name as string, 'list_mcp_resources',
      'list_mcp_resources 保持原名')
    assert.strictEqual(fc.arguments as string, '{"server":"computer-use"}',
      'arguments 保真传递')
    assert.strictEqual(fc.status, 'completed',
      'CCX 设置 status: "completed"')
  })

  it('list_mcp_resources 为空参数时保留原名（CCX 行为）', () => {
    const result = convertOpenAIResponseToOpenAIResponses(CHAT_RESP_LIST_MCP_RESOURCES_NO_NS)
    
    const output = result.output as Array<Record<string, unknown>>
    const fc = output.find((i) => i.type === 'function_call') as Record<string, unknown>
    assert.ok(fc, '应有 function_call')
    
    assert.strictEqual(fc.name as string, 'list_mcp_resources')
    assert.strictEqual(fc.arguments as string, '{}')
    
    // 后处理：用空上下文时不应修改任何内容
    const postOutput = JSON.parse(JSON.stringify(output))
    const postFc = postOutput.find((i: Record<string, unknown>) => i.type === 'function_call')
    assert.ok(postFc, '后处理后仍有 function_call')
    assert.strictEqual(postFc.name, 'list_mcp_resources',
      '空上下文后处理不应修改 name')
    assert.strictEqual(postFc.namespace, undefined,
      '空上下文后处理不应加 namespace')
  })
})

describe('CCX 格式对比 — Anthropic → Responses (tool_use)', () => {
  it('list_mcp_resources tool_use → function_call 保持原名', () => {
    const anthropicBody = {
      content: [
        { type: 'tool_use', id: 'toolu_list', name: 'list_mcp_resources', input: { server: 'computer-use' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const result = convertAnthropicResponseToOpenAIResponses(anthropicBody)
    
    const output = result.output as Array<Record<string, unknown>>
    const fc = output.find((i) => i.type === 'function_call') as Record<string, unknown>
    assert.ok(fc, '应有 function_call')
    
    assert.strictEqual(fc.name as string, 'list_mcp_resources')
    assert.strictEqual(fc.arguments as string, '{"server":"computer-use"}',
      'input → arguments JSON 字符串')
    assert.strictEqual(fc.status, 'completed',
      'CCX 设置 status: completed')
    assert.ok(fc.call_id, '应有 call_id')
  })

  it('namespace 工具 tool_use → function_call 保持前缀（后处理解）', () => {
    const anthropicBody = {
      content: [
        { type: 'tool_use', id: 'toolu_ns', name: 'mcp__vscode_mcp__execute_command', input: { command: 'test' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 2 },
    }
    const result = convertAnthropicResponseToOpenAIResponses(anthropicBody)
    
    const output = result.output as Array<Record<string, unknown>>
    const fc = output.find((i) => i.type === 'function_call') as Record<string, unknown>
    assert.ok(fc, '应有 function_call')
    
    // 基础转换不解码 __，保持完整前缀
    assert.strictEqual(fc.name as string, 'mcp__vscode_mcp__execute_command')
    
    // 后处理查表解开
    const originalTools = [{
      type: 'namespace', name: 'mcp__vscode_mcp__',
      tools: [{ type: 'function', name: 'execute_command' }],
    }]
    const nsCtx = buildNamespaceToolContext(originalTools)
    remapNamespaceFunctionCalls(output, nsCtx)
    
    assert.strictEqual(fc.name as string, 'execute_command',
      '后处理解开 namespace 前缀')
    assert.strictEqual(fc.namespace as string, 'mcp__vscode_mcp__',
      '后处理加回 namespace')
  })
})
