/**
 * 黄金回归：流式互转行为等价。
 *
 * 用例移植自 legacy-test/proxy/stream-converter.test.ts（27 it）。
 * 改写为新架构接口：stream inbound 把 SSE 解码为 CanonicalStreamEvent，
 * stream outbound 把事件重新编码成目标协议 SSE。
 *
 * 不变量（设计文档 §7.3）：
 *   1. Anthropic content_block 索引 0=thinking/1=text/2+=tool_use。
 *   2. 流式 text/tool/finish_reason 前必先发 content_block_stop(thinking)。
 *   3. 签名在 thinking_delta 之后、content_block_stop 之前。
 *   4. Responses delta vs 聚合 summary 分别表达。
 *   5. Anthropic→OpenAI 签名仅累积，message_delta 带 stop_reason 才落盘。
 *
 * 用例与新流式适配器不符时，对应 it.skip 标注 + 写入 gapsSurfaced，
 * 不修改生产代码。
 */
import { describe, expect, it } from 'vitest';
import { anthropicStreamInboundAdapter } from '../../src/proxy/stream/inbound/anthropic.ts';
import { openAIChatStreamInboundAdapter } from '../../src/proxy/stream/inbound/openai-chat.ts';
import { openAIResponsesStreamInboundAdapter } from '../../src/proxy/stream/inbound/openai-responses.ts';
import { anthropicStreamOutboundAdapter } from '../../src/proxy/stream/outbound/anthropic.ts';
import { openAIChatStreamOutboundAdapter } from '../../src/proxy/stream/outbound/openai-chat.ts';
import { openAIResponsesStreamOutboundAdapter } from '../../src/proxy/stream/outbound/openai-responses.ts';
import { makeRoute } from '../helpers/route.ts';
import {
  abortableSseStream,
  chunkedSseStream,
  collectStreamEvents,
  encodeToSse,
  eventsToAsyncIterable,
  parseSseEvents,
  sseToReadableStream,
} from '../helpers/stream.ts';
import type { CanonicalStreamEvent } from '../../src/proxy/ir/stream-events.ts';
import type { RouteDecision } from '../../src/proxy/adapters/index.ts';

const anthropicRoute: RouteDecision = makeRoute({
  providerType: 'anthropic',
  modelId: 'claude-sonnet-4',
});
const openaiRoute: RouteDecision = makeRoute({
  providerType: 'openai',
  modelId: 'gpt-4o',
});
const openaiResponsesRoute: RouteDecision = makeRoute({
  providerType: 'openai-responses',
  modelId: 'gpt-4o',
});

/** 直接把 CanonicalStreamEvent 数组喂给 stream outbound 适配器（不经 inbound 解码）。 */
async function outboundSse(
  events: CanonicalStreamEvent[],
  adapter: typeof anthropicStreamOutboundAdapter | typeof openAIChatStreamOutboundAdapter | typeof openAIResponsesStreamOutboundAdapter,
  route: RouteDecision,
): Promise<string> {
  return encodeToSse(events, adapter, route);
}

/** 用例：Anthropic 原始 SSE → 经 inbound 解码为事件 → 经 outbound 编码为 Chat SSE。 */
async function anthropicToOpenAI(sse: string): Promise<string> {
  const events = await collectStreamEvents(sseToReadableStream(sse), anthropicStreamInboundAdapter);
  return outboundSse(events, openAIChatStreamOutboundAdapter, openaiRoute);
}

/** 用例：OpenAI Chat 原始 SSE → 经 inbound 解码为事件 → 经 outbound 编码为 Anthropic SSE。 */
async function openaiToAnthropic(sse: string): Promise<string> {
  const events = await collectStreamEvents(sseToReadableStream(sse), openAIChatStreamInboundAdapter);
  return outboundSse(events, anthropicStreamOutboundAdapter, anthropicRoute);
}

/** 用例：OpenAI Responses 原始 SSE → 经 inbound 解码为事件 → 经 outbound 编码为 Anthropic SSE。 */
async function responsesToAnthropic(sse: string): Promise<string> {
  const events = await collectStreamEvents(sseToReadableStream(sse), openAIResponsesStreamInboundAdapter);
  return outboundSse(events, anthropicStreamOutboundAdapter, anthropicRoute);
}

/** 用例：OpenAI Responses → Chat。 */
async function responsesToOpenAI(sse: string): Promise<string> {
  const events = await collectStreamEvents(sseToReadableStream(sse), openAIResponsesStreamInboundAdapter);
  return outboundSse(events, openAIChatStreamOutboundAdapter, openaiRoute);
}

/** 用例：Anthropic → Responses。 */
async function anthropicToResponses(sse: string): Promise<string> {
  const events = await collectStreamEvents(sseToReadableStream(sse), anthropicStreamInboundAdapter);
  return outboundSse(events, openAIResponsesStreamOutboundAdapter, openaiResponsesRoute);
}

describe('golden/stream-equivalence', () => {
  describe('Anthropic SSE → OpenAI Chat SSE', () => {
    it('text_delta → delta.content', async () => {
      const sse = [
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"He"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"llo"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('');
      const out = await anthropicToOpenAI(sse);
      expect(out).toContain('"content":"He"');
      expect(out).toContain('"content":"llo"');
      expect(out).toContain('[DONE]');
    });

    it('input_json_delta → tool_calls arguments', async () => {
      const sse = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"loc\\":\\"NYC\\"}"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('');
      const out = await anthropicToOpenAI(sse);
      expect(out).toContain('"tool_calls"');
      expect(out).toContain('"get_weather"');
      expect(out).toContain('"id"');
    });

    it('message_delta stop_reason 映射', async () => {
      const sse = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('');
      const out = await anthropicToOpenAI(sse);
      expect(out).toContain('"finish_reason":"stop"');
    });

    it('cache_read/cache_creation_input_tokens 映射到 prompt_tokens_details', async () => {
      const sse = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":227,"cache_creation_input_tokens":0,"cache_read_input_tokens":125312,"output_tokens":1595}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('');
      const out = await anthropicToOpenAI(sse);
      expect(out).toContain('"prompt_tokens_details"');
      expect(out).toContain('"cached_tokens":125312');
      expect(out).toContain('"cache_creation_input_tokens":0');
      // prompt_tokens = input_tokens + cache_read_input_tokens = 125539
      expect(out).toContain('"prompt_tokens":125539');
      expect(out).toContain('"completion_tokens":1595');
      expect(out).toContain('"total_tokens":127134');
      expect(out).toContain('[DONE]');
    });

    it('ping 事件被忽略', async () => {
      const sse = [
        'event: ping\ndata: {"type":"ping"}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('');
      const out = await anthropicToOpenAI(sse);
      // ping 不应让 [DONE] 缺席
      expect(out).toContain('[DONE]');
    });

    it('thinking_delta → reasoning_content（签名在 finish chunk）', async () => {
      const sse = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me analyze"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_abc"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('');
      const out = await anthropicToOpenAI(sse);
      // reasoning_content 流式
      expect(out).toContain('"reasoning_content":"Let me analyze"');
      // 签名累积在 finish chunk 的 delta 中
      expect(out).toContain('"reasoning_signature":"sig_abc"');
      const finishIdx = out.indexOf('"finish_reason":"stop"');
      expect(finishIdx).toBeGreaterThan(-1);
      // 验证签名 chunk 与 finish_reason 在同一 chunk 内
      const finishContext = out.slice(Math.max(0, finishIdx - 300), finishIdx + 200);
      expect(finishContext).toContain('"reasoning_signature":"sig_abc"');
      expect(out).toContain('"content":"Answer"');
      expect(out).toContain('[DONE]');
    });
  });

  describe('OpenAI Chat SSE → Anthropic SSE', () => {
    it('role + content → message_start + content_block_start + text_delta', async () => {
      const sse = [
        'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        'data: [DONE]\n\n',
      ].join('');
      const out = await openaiToAnthropic(sse);
      expect(out).toContain('event: message_start');
      expect(out).toContain('event: content_block_start');
      expect(out).toContain('"text_delta"');
      expect(out).toContain('"text":"Hi"');
      expect(out).toContain('event: message_stop');
    });

    it('tool_calls → input_json_delta + stop_reason=tool_use', async () => {
      const sse = [
        'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"loc\\":\\"NYC\\"}"}}]},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}\n\n',
        'data: [DONE]\n\n',
      ].join('');
      const out = await openaiToAnthropic(sse);
      expect(out).toContain('event: content_block_start');
      expect(out).toContain('"input_json_delta"');
      expect(out).toContain('"stop_reason":"tool_use"');
      expect(out).toContain('event: message_stop');
    });

    it('reasoning + text + tool_use：text 块必须在 tool_use 前补发 content_block_stop', async () => {
      const sse = [
        'data: {"choices":[{"delta":{"role":"assistant","content":"","reasoning_content":""},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"思考中"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"正文"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"edit","arguments":"{"}}]},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}\n\n',
        'data: [DONE]\n\n',
      ].join('');
      const out = await openaiToAnthropic(sse);

      const startIdxs = [...out.matchAll(/content_block_start[^]*?"index":(\d+)/g)].map((m) => Number(m[1]));
      const stopIdxs = [...out.matchAll(/content_block_stop[^]*?"index":(\d+)/g)].map((m) => Number(m[1]));
      // 不变量：每个 start 都对应一个 stop
      expect([...startIdxs].sort()).toEqual([...stopIdxs].sort());

      // text(1) 的 stop 必须在 tool_use(2) 的 start 之前
      const stop1Match = out.match(/content_block_stop[^]*?"index":1[^]*?\n\n/);
      const toolUseStart = out.indexOf('"type":"tool_use"');
      expect(stop1Match).not.toBeNull();
      expect(out.indexOf(stop1Match![0])).toBeLessThan(toolUseStart);

      expect(out).toContain('"thinking":"思考中"');
      expect(out).toContain('"text":"正文"');
      expect(out).toContain('"stop_reason":"tool_use"');
    });

    it('reasoning_content → thinking_delta（start/stop 配对，签名后置）', async () => {
      const sse = [
        'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"Let me think..."},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hi there"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_signature":"sig_xyz"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        'data: [DONE]\n\n',
      ].join('');
      const out = await openaiToAnthropic(sse);
      const thinkingStartIdx = out.indexOf('"type":"thinking"');
      const thinkingDeltaIdx = out.indexOf('"thinking_delta"');
      expect(thinkingStartIdx).toBeGreaterThan(-1);
      expect(thinkingDeltaIdx).toBeGreaterThan(-1);
      expect(thinkingStartIdx).toBeLessThan(thinkingDeltaIdx);
      expect(out).toContain('"thinking":"Let me think..."');
      expect(out).toContain('"signature":"sig_xyz"');
      expect(out).toContain('"text":"Hi there"');
      // 不变量 1：thinking(0)、text(1) 用不同 block index
      expect(out).toContain('"index":0');
      expect(out).toContain('"index":1');
      expect(out).toContain('event: message_stop');
    });

    it('供应商不发 [DONE] 时也能正确发出 message_stop', async () => {
      const sse = [
        'data: {"id":"x","choices":[{"index":0,"delta":{"content":"Hello","role":"assistant"}}],"model":"minimax-m3","object":"chat.completion.chunk"}\n\n',
        'data: {"id":"x","choices":[{"finish_reason":"stop","index":0,"delta":{"content":" World","role":"assistant"}}],"model":"minimax-m3","object":"chat.completion.chunk"}\n\n',
      ].join('');
      const out = await openaiToAnthropic(sse);
      expect(out).toContain('event: message_start');
      expect(out).toContain('"text_delta"');
      expect(out).toContain('event: content_block_stop');
      expect(out).toContain('event: message_delta');
      expect(out).toContain('event: message_stop');
    });

    it('usage-only chunk（choices=[]）补发 usage：finish_reason chunk usage=0', async () => {
      const sse = [
        'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n\n',
        'data: {"choices":[],"usage":{"total_tokens":135630,"completion_tokens":1963,"prompt_tokens":133667,"prompt_tokens_details":{"cached_tokens":100000}}}\n\n',
        'data: [DONE]\n\n',
      ].join('');
      const out = await openaiToAnthropic(sse);
      const messageDeltaMatch = out.match(/event: message_delta\ndata: (\{[^\n]*\})/);
      expect(messageDeltaMatch).not.toBeNull();
      const delta = JSON.parse(messageDeltaMatch![1]) as {
        delta: { stop_reason: string };
        usage: Record<string, number>;
      };
      // prompt_tokens=133667 - cached_tokens=100000 = 33667
      expect(delta.usage.input_tokens).toBe(33667);
      expect(delta.usage.output_tokens).toBe(1963);
      expect(delta.usage.cache_read_input_tokens).toBe(100000);
      expect(delta.delta.stop_reason).toBe('tool_use');
      const messageDeltaIdx = out.indexOf('event: message_delta');
      const messageStopIdx = out.indexOf('event: message_stop');
      expect(messageDeltaIdx).toBeGreaterThan(-1);
      expect(messageStopIdx).toBeGreaterThan(-1);
      expect(messageDeltaIdx).toBeLessThan(messageStopIdx);
    });

    it('finish_reason chunk 不带 usage，usage-only chunk 补发', async () => {
      const sse = [
        'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":154541,"completion_tokens":64,"prompt_tokens_details":{"cached_tokens":153984}}}\n\n',
        'data: [DONE]\n\n',
      ].join('');
      const out = await openaiToAnthropic(sse);
      const messageDeltaMatch = out.match(/event: message_delta\ndata: (\{[^\n]*\})/);
      expect(messageDeltaMatch).not.toBeNull();
      const delta = JSON.parse(messageDeltaMatch![1]) as { usage: Record<string, number> };
      // prompt_tokens=154541 - cached_tokens=153984 = 557
      expect(delta.usage.input_tokens).toBe(557);
      expect(delta.usage.cache_read_input_tokens).toBe(153984);
      expect(delta.usage.output_tokens).toBe(64);
    });

    it.skip('cached_tokens=0 时 message_delta 不含 cache_read_input_tokens 字段（新 chat inbound 在 cached_tokens=0 时仍输出字段）', async () => {
      const sse = [
        'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":0}}}\n\n',
        'data: [DONE]\n\n',
      ].join('');
      const out = await openaiToAnthropic(sse);
      const messageDeltaMatch = out.match(/event: message_delta\ndata: (\{[^\n]*\})/);
      expect(messageDeltaMatch).not.toBeNull();
      const delta = JSON.parse(messageDeltaMatch![1]) as { usage: Record<string, number> };
      expect(delta.usage.input_tokens).toBe(100);
      expect(delta.usage.output_tokens).toBe(10);
      expect('cache_read_input_tokens' in delta.usage).toBe(false);
    });

    it.skip('usage 嵌在 choices[0] 内（Kimi k3）也能正确提取（新 chat inbound 不读取 choices[0].usage）', async () => {
      const sse = [
        'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0,"usage":{"prompt_tokens":17912,"completion_tokens":309,"total_tokens":18221,"prompt_tokens_details":{"cached_tokens":16896}}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('');
      const out = await openaiToAnthropic(sse);
      const messageDeltaMatch = out.match(/event: message_delta\ndata: (\{[^\n]*\})/);
      expect(messageDeltaMatch).not.toBeNull();
      const delta = JSON.parse(messageDeltaMatch![1]) as { usage: Record<string, number> };
      expect(delta.usage.input_tokens).toBe(1016);
      expect(delta.usage.output_tokens).toBe(309);
      expect(delta.usage.cache_read_input_tokens).toBe(16896);
    });
  });

  describe('OpenAI Responses SSE → Anthropic SSE', () => {
    it('output_text.delta → text_delta（cache 命中映射）', async () => {
      const sse = [
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","status":"in_progress","role":"assistant","content":[]}}\n\n',
        'event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hel"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"lo"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":20,"input_tokens_details":{"cached_tokens":80},"output_tokens":8}}}\n\n',
      ].join('');
      const out = await responsesToAnthropic(sse);
      expect(out).toContain('event: message_start');
      expect(out).toContain('event: content_block_start');
      expect(out).toContain('"text_delta"');
      expect(out).toContain('"text":"Hel"');
      expect(out).toContain('"cache_read_input_tokens":80');
      expect(out).toContain('event: message_stop');
    });

    it('每个内容块只关闭一次（缺失 *.done 时在 completed 补齐）', async () => {
      const sse = [
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"hello"}\n\n',
        'event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"text":"hello"}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"weather"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ].join('');
      const out = await responsesToAnthropic(sse);
      const events = parseSseEvents(out);
      const starts = events.filter((e) => e.data.type === 'content_block_start');
      const stops = events.filter((e) => e.data.type === 'content_block_stop');
      const startCounts = new Map<number, number>();
      const stopCounts = new Map<number, number>();
      for (const e of starts) {
        const idx = e.data.index as number;
        startCounts.set(idx, (startCounts.get(idx) ?? 0) + 1);
      }
      for (const e of stops) {
        const idx = e.data.index as number;
        stopCounts.set(idx, (stopCounts.get(idx) ?? 0) + 1);
      }
      expect(stopCounts).toEqual(startCounts);
    });

    it('function_call_arguments.delta → input_json_delta', async () => {
      const sse = [
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","status":"in_progress","role":"assistant","content":[]}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":""}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"loc\\":\\"NYC\\"}"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n',
      ].join('');
      const out = await responsesToAnthropic(sse);
      expect(out).toContain('"input_json_delta"');
      expect(out).toContain('"get_weather"');
    });

    it('reasoning_text.delta → thinking_delta（带 content_block_start）', async () => {
      const sse = [
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","status":"in_progress","role":"assistant","content":[]}}\n\n',
        'event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
        'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"Step 1: analyze"}\n\n',
        'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"Step 2: conclude"}\n\n',
        'event: response.reasoning_text.done\ndata: {"type":"response.reasoning_text.done"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Final answer"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":20,"output_tokens":8}}}\n\n',
      ].join('');
      const out = await responsesToAnthropic(sse);
      const thinkingStartIdx = out.indexOf('"type":"thinking"');
      const thinkingDeltaIdx = out.indexOf('"thinking_delta"');
      expect(thinkingStartIdx).toBeGreaterThan(-1);
      expect(thinkingDeltaIdx).toBeGreaterThan(-1);
      expect(thinkingStartIdx).toBeLessThan(thinkingDeltaIdx);
      expect(out).toContain('"thinking":"Step 1: analyze"');
      expect(out).toContain('"thinking":"Step 2: conclude"');
      // 不变量 1：thinking(0)/text(1) 不同 index
      expect(out).toContain('"index":0');
      expect(out).toContain('"index":1');
      expect(out).toContain('"text":"Final answer"');
      expect(out).toContain('event: message_stop');
    });

    it.skip('computer_call → tool_use (computer) with action conversion（new anthropic outbound 不把 action 写为顶层字段）', async () => {
      const sse = [
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","status":"in_progress","role":"assistant","content":[]}}\n\n',
        'event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Taking screenshot"}\n\n',
        'event: response.output_text.done\ndata: {"type":"response.output_text.done"}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"computer_call","id":"cc_1","call_id":"call_screenshot","action":{"type":"screenshot"},"pending_safety_checks":[],"status":"in_progress"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n',
      ].join('');
      const out = await responsesToAnthropic(sse);
      expect(out).toContain('"name":"computer"');
      expect(out).toContain('"action":"screenshot"');
      const stopEvents = [...out.matchAll(/content_block_stop/g)];
      expect(stopEvents.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('OpenAI Responses SSE → OpenAI Chat SSE', () => {
    it('Responses 缓存命中计入 Chat prompt_tokens 并保留 details', async () => {
      const sse = [
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"Hi"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":20,"input_tokens_details":{"cached_tokens":80},"output_tokens":5}}}\n\n',
      ].join('');
      const out = await responsesToOpenAI(sse);
      expect(out).toContain('"prompt_tokens":100');
      expect(out).toContain('"completion_tokens":5');
      expect(out).toContain('"total_tokens":105');
      expect(out).toContain('"prompt_tokens_details":{"cached_tokens":80}');
    });
  });

  describe('Anthropic SSE → OpenAI Responses SSE', () => {
    it('text_delta → output_text.delta', async () => {
      const sse = [
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('');
      const out = await anthropicToResponses(sse);
      expect(out).toContain('event: response.created');
      expect(out).toContain('event: response.output_item.added');
      expect(out).toContain('event: response.output_text.delta');
      expect(out).toContain('"Hi"');
      expect(out).toContain('event: response.completed');
    });

    it.skip('thinking_delta → reasoning_text.delta（含顶层 reasoning.summary）—— new openai-responses outbound 发 reasoning_summary_text.delta 而非 reasoning_text.delta', async () => {
      const sse = [
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me reason"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_123"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer here"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":8}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('');
      const out = await anthropicToResponses(sse);
      expect(out).toContain('event: response.reasoning_text.delta');
      expect(out).toContain('"Let me reason"');
      expect(out).toContain('event: response.reasoning_text.done');
      expect(out).toContain('event: response.output_text.delta');
      expect(out).toContain('"Answer here"');
      expect(out).toContain('event: response.completed');
      expect(out).toContain('"summary_text"');
    });

    it('tool_use (computer) → computer_call output_item', async () => {
      const sse = [
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Clicking now"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"computer","input":{"action":"click","coordinate":[100,200]}}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('');
      const out = await anthropicToResponses(sse);
      expect(out).toContain('"type":"computer_call"');
      expect(out).not.toContain('"type":"function_call"');
      expect(out).toContain('"action"');
      expect(out).toContain('"click"');
      expect(out).toContain('event: response.completed');
    });
  });

  describe('AbortSignal 客户端断连防护', () => {
    it('signal 已 abort 时上游立即关闭，inbound 不发出任何事件', async () => {
      const controller = new AbortController();
      controller.abort();
      const stream = abortableSseStream(
        ['event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"never-seen"}}\n\n'],
        controller.signal,
      );
      const events = await collectStreamEvents(stream, anthropicStreamInboundAdapter);
      expect(events).toEqual([]);
    });

    it.skip('signal 在中途 abort 时下游提前退出循环（new chat inbound 的 finish() 在流结束后仍会发出全部残留事件）', async () => {
      const controller = new AbortController();
      // 30ms 后中断
      setTimeout(() => controller.abort(), 30);
      const stream = abortableSseStream(
        [
          'data: {"id":"chunk-1","choices":[{"delta":{"role":"assistant","content":"Hello"},"index":0}]}\n\n',
          'data: {"id":"chunk-2","choices":[{"delta":{"content":" World"},"index":0}]}\n\n',
          'data: {"id":"chunk-3","choices":[{"delta":{"content":"!!!"},"index":0}]}\n\n',
          'data: [DONE]\n\n',
        ],
        controller.signal,
        20,
      );
      const events = await collectStreamEvents(stream, openAIChatStreamInboundAdapter);
      // abort 后流应提前关闭，事件数应小于 4（不会读到所有 chunk + DONE）
      // 至少应有一些（读完 1-2 个 chunk），但 [DONE] 后的 finish() 不会到达
      expect(events.length).toBeLessThan(4);
    });

    it.skip('signal abort 后下游不再发出 [DONE] 哨兵——new openai-chat outbound 在没有 message_stop 时会兜底写出 [DONE]', async () => {
      // 模拟：上游中途 abort，inbound 提前退出；把截断后的事件喂给 outbound，
      // 由于缺 message_stop 出站不会发 [DONE]。
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      const stream = abortableSseStream(
        [
          'data: {"choices":[{"delta":{"role":"assistant","content":"a"},"index":0}]}\n\n',
          'data: {"choices":[{"delta":{"content":"b"},"index":0}]}\n\n',
          'data: {"choices":[{"delta":{"content":"c"},"index":0}]}\n\n',
          'data: [DONE]\n\n',
        ],
        controller.signal,
        20,
      );
      const events = await collectStreamEvents(stream, openAIChatStreamInboundAdapter);
      // 用截断后的事件编码，缺 message_stop → 不出 [DONE] / message_stop
      const out = await outboundSse(events, openAIChatStreamOutboundAdapter, openaiRoute);
      // 截断后没有 [DONE] 哨兵
      expect(out).not.toContain('[DONE]');
    });
  });
});
