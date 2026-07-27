import { describe, expect, it } from 'vitest';
import { openaiResponsesInboundAdapter } from '../../../../src/proxy/adapters/inbound/openai-responses.ts';
const ctx = { clientProtocol: 'openai-responses' as const, logicalModel: 'gpt-5' };
describe('unit/adapters/inbound/openai-responses', () => {
  it('解码 instructions、reasoning、tool call/output 和三态图片', () => {
    const req = openaiResponsesInboundAdapter.decode({ model: 'gpt-5', instructions: 'system', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'https://x/a.png' }, { type: 'input_image', image_url: { url: 'https://x/b.png' } }, { type: 'input_image', file_id: 'file_1' }] },
      { type: 'function_call', call_id: 'c1', name: 'run', arguments: '{"x":1}' }, { type: 'function_call_output', call_id: 'c1', output: 'done' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
    ], reasoning: { effort: 'medium', summary: 'concise' } }, ctx);
    expect(req.system).toBe('system');
    expect(req.messages[0]?.blocks.filter((block) => block.kind === 'image')).toHaveLength(3);
    expect(req.messages.some((message) => message.blocks.some((block) => block.kind === 'tool_use'))).toBe(true);
    expect(req.reasoning).toMatchObject({ enabled: true, effort: 'medium', summary: 'concise' });
  });
  it('只在 Responses 入口剥离 MCP probe，并保留普通函数', () => {
    const req = openaiResponsesInboundAdapter.decode({ model: 'gpt-5', input: 'hi', tools: [{ type: 'function', name: 'list_mcp_resources', parameters: {} }, { type: 'function', name: 'exec_command', parameters: {} }] }, ctx);
    expect(req.tools?.map((tool) => tool.name)).toEqual(['exec_command']);
  });
});
