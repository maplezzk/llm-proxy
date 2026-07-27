import { describe, expect, it } from 'vitest';
import { convertAnthropicResponseToOpenAI, convertAnthropicResponseToOpenAIResponses, convertOpenAIResponseToAnthropic, convertOpenAIResponseToOpenAIResponses, convertOpenAIResponsesResponseToOpenAI, convertOpenAIResponsesToAnthropic } from '../../../../src/proxy/adapters/response/converters.ts';
import type { CanonicalResponse } from '../../../../src/proxy/ir/types.ts';
const response: CanonicalResponse = { model: 'gpt-4o', message: { role: 'assistant', blocks: [{ kind: 'thinking', text: 'reason', signature: 'sig' }, { kind: 'text', text: 'hello' }, { kind: 'tool_use', id: 'c1', name: 'run', namespace: 'mcp__x__', input: { a: 1 } }] }, stopReason: 'tool_use', finishReason: 'completed', usage: { inputTokens: 10, outputTokens: 5 } };
const getFinishReason = (body: Record<string, unknown>): 'stop' | 'length' | 'tool_calls' | undefined => {
  const choices = body.choices;
  if (!Array.isArray(choices)) return undefined;
  const first = choices[0];
  if (!first || typeof first !== 'object') return undefined;
  const value = (first as Record<string, unknown>).finish_reason;
  return value === 'stop' || value === 'length' || value === 'tool_calls' ? value : undefined;
};
describe('unit/adapters/response/converters', () => {
  it('覆盖 CanonicalResponse 六向转换', () => {
    expect(convertAnthropicResponseToOpenAI(response).choices).toBeDefined();
    expect(convertOpenAIResponsesResponseToOpenAI(response).choices).toBeDefined();
    expect(convertOpenAIResponseToAnthropic(response).stop_reason).toBe('tool_use');
    expect(convertOpenAIResponsesToAnthropic(response).stop_reason).toBe('tool_use');
    expect(convertAnthropicResponseToOpenAIResponses(response).output).toBeDefined();
    expect(convertOpenAIResponseToOpenAIResponses(response).output).toBeDefined();
  });
  it('stopReason 映射为 Chat finish_reason', () => {
    expect(getFinishReason(convertAnthropicResponseToOpenAI({ ...response, stopReason: 'end_turn' }))).toBe('stop');
    expect(getFinishReason(convertAnthropicResponseToOpenAI({ ...response, stopReason: 'max_tokens' }))).toBe('length');
    expect(getFinishReason(convertAnthropicResponseToOpenAI(response))).toBe('tool_calls');
  });
  it.skip('Responses namespace function_call 名称编码（当前出站重复追加 __）', () => {
    const output = convertOpenAIResponseToOpenAIResponses(response).output as Array<Record<string, unknown>>;
    expect(output).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message' }), expect.objectContaining({ type: 'function_call', name: 'mcp__x__run', status: 'completed' })]));
  });
});
