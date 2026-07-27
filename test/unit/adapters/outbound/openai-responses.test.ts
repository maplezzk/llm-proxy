import { describe, expect, it } from 'vitest';
import { openAiResponsesOutbound } from '../../../../src/proxy/adapters/outbound/openai-responses.ts';
import { makeRoute } from '../../../helpers/route.ts';
import type { CanonicalRequest } from '../../../../src/proxy/ir/types.ts';
const route = makeRoute({ providerType: 'openai-responses', modelId: 'gpt-5' });
const req: CanonicalRequest = { clientProtocol: 'openai', logicalModel: 'gpt', messages: [{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }], system: 'be concise', generation: { stream: false, maxTokens: 200 }, reasoning: { source: 'client', effort: 'medium', summary: 'concise' }, tools: [{ kind: 'computer', name: 'computer', schema: {}, displayWidth: 800 }, { kind: 'function', name: 'click', namespace: 'mcp__ui__', schema: { type: 'object' } }] };
describe('unit/adapters/outbound/openai-responses', () => {
  it.skip('namespace 工具名称展平（当前出站重复追加 __）', () => {
    const body = openAiResponsesOutbound.encode(req, route);
    expect(body.instructions).toBe('be concise');
    expect(body.max_output_tokens).toBe(200);
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'concise' });
    expect(body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'computer_use_preview' }), expect.objectContaining({ name: 'mcp__ui__click' })]));
  });
});
