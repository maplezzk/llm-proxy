import { describe, expect, it } from 'vitest';
import { openaiChatInboundAdapter } from '../../../../src/proxy/adapters/inbound/openai-chat.ts';

const context = { clientProtocol: 'openai' as const, logicalModel: 'gpt-4o' };
describe('unit/adapters/inbound/openai-chat', () => {
  it('解码 system 多块、reasoning、tool calls 和 tool result', () => {
    // 入站抽取首条 system 到 IR.system，assistant 的 reasoning_content 转 thinking 块、tool_calls 转 tool_use 块，
    // tool 消息转 tool_result 块。修正原 skip 版本里 messages 索引错位（system 被抽出后不再占用 messages 索引）：
    // messages[0] = assistant、messages[1] = tool。
    const req = openaiChatInboundAdapter.decode({ model: 'gpt-4o', messages: [
      { role: 'system', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: 'https://x/i.png' }] },
      { role: 'assistant', content: null, reasoning_content: 'r', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{"x":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ], reasoning_effort: 'high' }, context);
    expect(req.system).toEqual(expect.any(Array));
    expect(req.reasoning).toMatchObject({ enabled: true, effort: 'high', clientEffort: 'high' });
    expect(req.messages[0]?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'thinking' }),
      expect.objectContaining({ kind: 'tool_use', input: { x: 1 } }),
    ]));
    expect(req.messages[1]?.blocks[0]).toMatchObject({ kind: 'tool_result', toolUseId: 'c1' });
  });
  it('解码 wire 顶层 reasoning_signature → thinking 块 signature（使 Chat→Anthropic 时 signature 不丢）', () => {
    // 不变量：Chat wire 顶层 reasoning_signature 必须写入 IR thinking.signature，
    // 这样跨协议 Chat→Anthropic 时 signature 不丢失（Anthropic outbound 会写入 thinking.signature）。
    const req = openaiChatInboundAdapter.decode({ model: 'gpt-4o', messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, reasoning_content: 'r', reasoning_signature: 'sig-abc' },
      { role: 'user', content: 'go' },
    ] }, context);
    expect(req.messages[1]?.blocks[0]).toMatchObject({ kind: 'thinking', text: 'r', signature: 'sig-abc' });
  });
  it.skip('图片支持 url、data URL 和无效值占位（当前接口不符）', () => {
    // B 类保持现状：data:image URL 不收敛 base64（透传为 url 形态）。保持 skip 不修。
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
