import { describe, expect, it } from 'vitest';
import { anthropicInboundAdapter } from '../../../../src/proxy/adapters/inbound/anthropic.ts';

const context = { clientProtocol: 'anthropic' as const, logicalModel: 'claude' };

describe('unit/adapters/inbound/anthropic', () => {
  it('解码多块 system、thinking、tool_use 和 tool_result', () => {
    const req = anthropicInboundAdapter.decode({ model: 'claude', system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'url', url: 'https://x/i.png' } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'think', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'x', input: { a: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ], thinking: { type: 'enabled', budget_tokens: 1000 }, max_tokens: 2000 }, context);
    expect(req.system).toHaveLength(2);
    expect(req.messages[0]?.blocks[1]).toMatchObject({ kind: 'image', source: { kind: 'url' } });
    expect(req.messages[1]?.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'thinking', signature: 'sig' }), expect.objectContaining({ kind: 'tool_use', id: 't1' })]));
    expect(req.messages[2]?.blocks[0]).toMatchObject({ kind: 'tool_result', toolUseId: 't1' });
    expect(req.reasoning).toMatchObject({ enabled: true, budgetTokens: 1000 });
  });
  it('解码 base64 图片并识别无效图片为占位文本', () => {
    const req = anthropicInboundAdapter.decode({ model: 'claude', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }, { type: 'image', source: { type: 'url' } }] }] }, context);
    expect(req.messages[0]?.blocks[0]).toMatchObject({ kind: 'image', source: { kind: 'base64', mediaType: 'image/png' } });
    expect(req.messages[0]?.blocks[1]).toEqual({ kind: 'text', text: '[image]' });
  });
});
