import { describe, expect, it } from 'vitest';
import { anthropicOutbound } from '../../../../src/proxy/adapters/outbound/anthropic.ts';
import { makeRoute } from '../../../helpers/route.ts';
import type { CanonicalRequest } from '../../../../src/proxy/ir/types.ts';
const route = makeRoute({ providerType: 'anthropic', modelId: 'claude', thinking: { budget_tokens: 4096 } });
const req: CanonicalRequest = { clientProtocol: 'openai', logicalModel: 'gpt', messages: [{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }, { role: 'assistant', blocks: [{ kind: 'thinking', text: 'think', signature: 'sig' }, { kind: 'tool_use', id: 'c1', name: 'run', namespace: 'mcp__x__', input: { a: 1 } }] }], system: [{ kind: 'text', text: 'system' }], generation: { stream: false }, reasoning: { source: 'client', effort: 'high' }, tools: [{ kind: 'function', name: 'run', namespace: 'mcp__x__', schema: { type: 'object' } }, { kind: 'computer', name: 'computer', schema: {}, displayWidth: 100 }] };
describe('unit/adapters/outbound/anthropic', () => {
  it('注入 reasoning、max_tokens、system 和 namespace 工具（记录当前编码结果）', () => {
    const body = anthropicOutbound.encode(req, route);
    expect(body.max_tokens).toBe(16384);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(body.system).toEqual([{ type: 'text', text: 'system' }]);
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'mcp__x____run' });
  });
});
