/**
 * P1.4 inbound 适配器烟雾测试（不入正式回归；只验证 wire → IR 形态映射）。
 * 不变量验证在 P1.13 测试迁移阶段对照 legacy 用例执行。
 */

import { describe, expect, it } from 'vitest';

import { anthropicInboundAdapter } from '../src/proxy/adapters/inbound/anthropic.ts';
import { openaiChatInboundAdapter } from '../src/proxy/adapters/inbound/openai-chat.ts';
import { openaiResponsesInboundAdapter } from '../src/proxy/adapters/inbound/openai-responses.ts';

describe('inbound/anthropic', () => {
  it('decodes messages + tools + thinking', () => {
    const req = anthropicInboundAdapter.decode(
      {
        model: 'claude-sonnet',
        max_tokens: 1024,
        system: 'You are helpful.',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Let me analyze', signature: 'sig1' },
              { type: 'tool_use', id: 'tu1', name: 'get_weather', input: { city: 'SF' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu1', content: 'sunny' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'iVBORw' },
              },
            ],
          },
        ],
        tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object' } }],
        tool_choice: { type: 'tool', name: 'get_weather' },
        thinking: { type: 'enabled', budget_tokens: 4096 },
      },
      { clientProtocol: 'anthropic', logicalModel: 'claude-sonnet' },
    );
    expect(req.clientProtocol).toBe('anthropic');
    expect(req.logicalModel).toBe('claude-sonnet');
    expect(req.system).toBe('You are helpful.');
    expect(req.messages).toHaveLength(3);
    expect(req.messages[0]?.blocks[0]).toEqual({ kind: 'text', text: 'hi' });
    expect(req.messages[1]?.blocks[0]).toMatchObject({ kind: 'thinking', text: 'Let me analyze', signature: 'sig1' });
    expect(req.messages[1]?.blocks[1]).toMatchObject({ kind: 'tool_use', id: 'tu1', name: 'get_weather' });
    expect(req.messages[2]?.blocks[0]).toMatchObject({ kind: 'tool_result', toolUseId: 'tu1' });
    expect(req.messages[2]?.blocks[1]).toMatchObject({ kind: 'image', source: { kind: 'base64', mediaType: 'image/png' } });
    expect(req.reasoning).toMatchObject({ enabled: true, budgetTokens: 4096, source: 'client' });
    expect(req.toolChoice).toEqual({ kind: 'tool', name: 'get_weather' });
    expect(req.tools?.[0]?.name).toBe('get_weather');
  });

  it('rejects invalid wire body', () => {
    expect(() => anthropicInboundAdapter.decode({ messages: 'bad' } as never, { clientProtocol: 'anthropic', logicalModel: 'claude-sonnet' })).toThrow(
      /anthropic.inbound/,
    );
  });
});

describe('inbound/openai-chat', () => {
  it('decodes messages + reasoning_content + tool_calls + tool result', () => {
    const req = openaiChatInboundAdapter.decode(
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'look' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: 'Let me look',
            reasoning_signature: 'sig1',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'files' },
        ],
        reasoning_effort: 'high',
        tools: [
          {
            type: 'function',
            function: { name: 'bash', description: 'bash', parameters: { type: 'object' } },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'bash' } },
      },
      { clientProtocol: 'openai', logicalModel: 'gpt-4o' },
    );
    expect(req.clientProtocol).toBe('openai');
    expect(req.system).toBe('You are helpful.');
    expect(req.reasoning).toMatchObject({
      enabled: true,
      effort: 'high',
      clientEffort: 'high',
      source: 'client',
    });
    const assistant = req.messages.find((m) => m.role === 'assistant');
    expect(assistant?.blocks[0]).toMatchObject({ kind: 'thinking', text: 'Let me look', signature: 'sig1' });
    expect(assistant?.blocks[1]).toMatchObject({ kind: 'tool_use', id: 'c1', name: 'bash' });
    const tool = req.messages.find((m) => m.role === 'tool');
    expect(tool?.blocks[0]).toMatchObject({ kind: 'tool_result', toolUseId: 'c1', content: 'files' });
  });

  it('rejects invalid wire body', () => {
    expect(() => openaiChatInboundAdapter.decode({ model: 'gpt-4o' } as never, { clientProtocol: 'openai', logicalModel: 'gpt-4o' })).toThrow(
      /openai-chat.inbound/,
    );
  });
});

describe('inbound/openai-responses', () => {
  it('decodes input array (5 item types) + strips MCP probes', () => {
    const req = openaiResponsesInboundAdapter.decode(
      {
        model: 'gpt-4o',
        instructions: 'Be concise.',
        input: [
          { type: 'message', role: 'user', content: 'hi' },
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'describe' },
              { type: 'input_image', image_url: 'https://example.com/cat.png' },
            ],
          },
          { type: 'function_call', call_id: 'fc1', name: 'get_weather', arguments: '{"city":"SF"}' },
          { type: 'function_call_output', call_id: 'fc1', output: 'sunny' },
          {
            type: 'computer_call_output',
            call_id: 'cc1',
            output: { type: 'computer_screenshot', image_url: 'https://example.com/desktop.png' },
          },
          { type: 'item_reference', id: 'ref_1' },
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Let me think' }] },
        ],
        tools: [
          {
            type: 'function',
            name: 'get_weather',
            parameters: { type: 'object' },
          },
          { type: 'function', name: 'list_mcp_resources', parameters: {} },
        ],
        reasoning: { effort: 'medium', summary: 'concise' },
      },
      { clientProtocol: 'openai-responses', logicalModel: 'gpt-4o' },
    );
    expect(req.clientProtocol).toBe('openai-responses');
    expect(req.system).toBe('Be concise.');
    // input array 解析后：user(text 'hi') + user(text 'describe' + image) + assistant(tool_use) + tool + tool + assistant(reasoning， standalone)
    expect(req.messages).toHaveLength(6);
    expect(req.messages[1]?.blocks.some((b) => b.kind === 'image')).toBe(true);
    const assistant = req.messages[2];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.blocks.some((b) => b.kind === 'tool_use')).toBe(true);
    expect(req.messages[3]?.role).toBe('tool');
    expect(req.messages[3]?.blocks[0]).toMatchObject({ kind: 'tool_result' });
    expect(req.messages[4]?.blocks[0]).toMatchObject({
      kind: 'tool_result',
      content: [{ kind: 'image', source: { kind: 'url', url: 'https://example.com/desktop.png' } }],
    });
    // standalone reasoning item：上一条是 tool 不是 assistant，新建 assistant（reasoning）
    expect(req.messages[5]?.role).toBe('assistant');
    expect(req.messages[5]?.blocks[0]).toMatchObject({ kind: 'reasoning', text: 'Let me think' });
    // MCP 探测工具剥离
    expect(req.tools?.map((t) => t.name)).toEqual(['get_weather']);
    expect(req.reasoning).toMatchObject({
      enabled: true,
      effort: 'medium',
      clientEffort: 'medium',
      summary: 'concise',
      source: 'client',
    });
  });

  it('decodes input string → single user message', () => {
    const req = openaiResponsesInboundAdapter.decode(
      { model: 'gpt-4o', input: 'hi' },
      { clientProtocol: 'openai-responses', logicalModel: 'gpt-4o' },
    );
    expect(req.messages).toEqual([{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }]);
  });

  it('rejects invalid wire body', () => {
    expect(() => openaiResponsesInboundAdapter.decode({ input: [] } as never, { clientProtocol: 'openai-responses', logicalModel: 'gpt-4o' })).toThrow(
      /openai-responses.inbound/,
    );
  });
});