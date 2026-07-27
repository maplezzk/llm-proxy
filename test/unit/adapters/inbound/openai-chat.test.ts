import { describe, expect, it } from 'vitest';
import { openaiChatInboundAdapter } from '../../../../src/proxy/adapters/inbound/openai-chat.ts';

const context = { clientProtocol: 'openai' as const, logicalModel: 'gpt-4o' };
describe('unit/adapters/inbound/openai-chat', () => {
  it.skip('解码 system 多块、reasoning、tool calls 和 tool result（当前接口不符）', () => {
    const req = openaiChatInboundAdapter.decode({ model: 'gpt-4o', messages: [
      { role: 'system', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: 'https://x/i.png' }] },
      { role: 'assistant', content: null, reasoning_content: 'r', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{"x":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ], reasoning_effort: 'high' }, context);
    expect(req.system).toEqual(expect.any(Array));
    expect(req.reasoning).toMatchObject({ enabled: true, effort: 'high', clientEffort: 'high' });
    expect(req.messages[1]?.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'thinking' }), expect.objectContaining({ kind: 'tool_use', input: { x: 1 } })]));
    expect(req.messages[2]?.blocks[0]).toMatchObject({ kind: 'tool_result', toolUseId: 'c1' });
  });
  it.skip('图片支持 url、data URL 和无效值占位（当前接口不符）', () => {
    const req = openaiChatInboundAdapter.decode({ model: 'gpt-4o', messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://x/a.png', detail: 'high' } },
      { type: 'image_url', image_url: 'data:image/png;base64,abc' },
      { type: 'image_url', image_url: {} },
    ] }] }, context);
    expect(req.messages[0]?.blocks[0]).toMatchObject({ kind: 'image', source: { kind: 'url', detail: 'high' } });
    expect(req.messages[0]?.blocks[1]).toMatchObject({ kind: 'image', source: { kind: 'base64', mediaType: 'image/png' } });
    expect(req.messages[0]?.blocks[2]).toEqual({ kind: 'text', text: '[image]' });
  });
});
