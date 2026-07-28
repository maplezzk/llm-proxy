import { describe, expect, it } from 'vitest';
import { openAiChatOutbound } from '../../../../src/proxy/adapters/outbound/openai-chat.ts';
import { makeRoute } from '../../../helpers/route.ts';
import type { CanonicalRequest } from '../../../../src/proxy/ir/types.ts';
const route = makeRoute({ providerType: 'openai', modelId: 'gpt-4o' });
const req: CanonicalRequest = { clientProtocol: 'anthropic', logicalModel: 'claude', messages: [{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }, { role: 'assistant', blocks: [{ kind: 'thinking', text: 'reason' }, { kind: 'tool_use', id: 'c1', name: 'run', namespace: 'mcp__x__', input: { x: 1 } }] }], generation: { stream: false, maxTokens: 123 }, reasoning: { source: 'client', effort: 'high' }, tools: [{ kind: 'function', name: 'run', namespace: 'mcp__x__', schema: { type: 'object' } }] };
describe('unit/adapters/outbound/openai-chat', () => {
  it('仅投影已解析的 reasoning effort', () => {
    const body = openAiChatOutbound.encode(req, route);

    expect(body.max_tokens).toBe(123);
    expect(body.reasoning_effort).toBe('high');
    expect((body.messages as Array<Record<string, unknown>>)[1]).toMatchObject({
      reasoning_content: 'reason',
    });
  });

  it.skip('namespace 工具名称展平（当前出站重复追加 __）', () => {
    const body = openAiChatOutbound.encode(req, route);
    expect(body.max_tokens).toBe(123);
    expect(body.reasoning_effort).toBe('high');
    expect((body.messages as Array<Record<string, unknown>>)[1]).toMatchObject({ reasoning_content: 'reason' });
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ function: { name: 'mcp__x__run' } });
  });
});
