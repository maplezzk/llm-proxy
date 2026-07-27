/**
 * 上游非流式响应解码：wire JSON → CanonicalResponse（P1.11）。
 *
 * 已就绪基线 src/proxy/adapters/response/ 只提供 CanonicalResponse → wire 的 6 向编码器，
 * 不含反向解码；跨协议非流式转换需要先把上游响应归一到 IR，故在基线目录外补此解码器。
 * （后续如沉淀为正式 response inbound adapter，应迁入 adapters/response/ 并走 P1.13 回归。）
 *
 * usage 口径遵循设计 §7.3 不变量 6：计费输入 = 总输入 − 缓存读 − 缓存创建；
 * Anthropic / Responses 的 input_tokens 本身即计费部分，Chat 的 prompt_tokens 含缓存需扣减。
 */
import type {
  CanonicalBlock,
  CanonicalMessage,
  CanonicalResponse,
  ClientProtocol,
  FinishReason,
  StopReason,
  UsageRecord,
} from './ir/types.ts';

type Wire = Record<string, unknown>;

const isObject = (v: unknown): v is Wire =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const asObject = (v: unknown): Wire => (isObject(v) ? v : {});
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** 尽力解析工具调用 arguments JSON；失败回退空对象（不丢调用）。 */
const parseArguments = (raw: unknown): Record<string, unknown> => {
  if (isObject(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/** Anthropic stop_reason → IR StopReason。 */
const mapAnthropicStop = (raw: unknown): StopReason => {
  const known: StopReason[] = [
    'end_turn',
    'tool_use',
    'max_tokens',
    'stop_sequence',
    'content_filter',
  ];
  const s = asString(raw);
  if (s && (known as string[]).includes(s)) return s as StopReason;
  return 'end_turn';
};

/** Chat finish_reason → IR StopReason。 */
const mapChatStop = (raw: unknown): StopReason => {
  switch (asString(raw)) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
    case 'error':
      return 'error';
    default:
      return 'end_turn';
  }
};

/** StopReason → FinishReason。 */
const toFinishReason = (reason: StopReason): FinishReason => {
  if (reason === 'error') return 'failed';
  if (reason === 'max_tokens') return 'incomplete';
  return 'completed';
};

/** Anthropic 响应解码。input_tokens 即计费部分。 */
const decodeAnthropic = (wire: Wire): CanonicalResponse => {
  const blocks: CanonicalBlock[] = [];
  const content = wire.content;
  if (Array.isArray(content)) {
    for (const raw of content) {
      const item = asObject(raw);
      const type = asString(item.type);
      if (type === 'text') {
        blocks.push({ kind: 'text', text: asString(item.text) ?? '' });
      } else if (type === 'thinking') {
        const thinking = asString(item.thinking) ?? '';
        const signature = asString(item.signature);
        blocks.push({
          kind: 'thinking',
          text: thinking,
          ...(signature
            ? { signature, signatureSource: 'original' as const }
            : { signatureSource: 'none' as const }),
        });
      } else if (type === 'redacted_thinking') {
        blocks.push({ kind: 'thinking', text: '', redacted: true, signatureSource: 'none' });
      } else if (type === 'tool_use') {
        blocks.push({
          kind: 'tool_use',
          id: asString(item.id) ?? '',
          name: asString(item.name) ?? '',
          input: asObject(item.input),
        });
      }
    }
  }
  const message: CanonicalMessage = { role: 'assistant', blocks };
  const stopReason = mapAnthropicStop(wire.stop_reason);

  const usageWire = asObject(wire.usage);
  const inputTokens = asNumber(usageWire.input_tokens) ?? 0;
  const cacheRead = asNumber(usageWire.cache_read_input_tokens);
  const cacheCreate = asNumber(usageWire.cache_creation_input_tokens);
  const usage: UsageRecord | undefined = Object.keys(usageWire).length
    ? {
        inputTokens,
        outputTokens: asNumber(usageWire.output_tokens) ?? 0,
        ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheCreate !== undefined ? { cacheCreationTokens: cacheCreate } : {}),
        totalInputTokens: inputTokens + (cacheRead ?? 0) + (cacheCreate ?? 0),
        raw: wire.usage,
      }
    : undefined;

  return {
    model: asString(wire.model) ?? '',
    message,
    stopReason,
    finishReason: toFinishReason(stopReason),
    ...(usage ? { usage } : {}),
    raw: wire,
  };
};

/** Chat Completions 响应解码。prompt_tokens 含缓存，扣减后为计费部分。 */
const decodeChat = (wire: Wire): CanonicalResponse => {
  const blocks: CanonicalBlock[] = [];
  const choices = Array.isArray(wire.choices) ? wire.choices : [];
  const choice = asObject(choices[0]);
  const msg = asObject(choice.message);

  const reasoning = asString(msg.reasoning_content);
  if (reasoning) {
    // Chat 无签名，标注 generated 供多轮回传时适配器生成确定性伪签名。
    blocks.push({ kind: 'thinking', text: reasoning, signatureSource: 'generated' });
  }
  const text = asString(msg.content);
  if (text) blocks.push({ kind: 'text', text });

  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const raw of toolCalls) {
    const call = asObject(raw);
    const fn = asObject(call.function);
    blocks.push({
      kind: 'tool_use',
      id: asString(call.id) ?? '',
      name: asString(fn.name) ?? '',
      input: parseArguments(fn.arguments),
    });
  }

  const stopReason = mapChatStop(choice.finish_reason);
  const message: CanonicalMessage = { role: 'assistant', blocks };

  const usageWire = asObject(wire.usage);
  const details = asObject(usageWire.prompt_tokens_details);
  const cacheRead = asNumber(details.cached_tokens) ?? asNumber(usageWire.cache_read_input_tokens);
  const cacheCreate =
    asNumber(details.cache_creation_input_tokens) ??
    asNumber(usageWire.cache_creation_input_tokens);
  const promptTokens = asNumber(usageWire.prompt_tokens);
  const usage: UsageRecord | undefined = Object.keys(usageWire).length
    ? {
        inputTokens:
          promptTokens !== undefined
            ? Math.max(0, promptTokens - (cacheRead ?? 0) - (cacheCreate ?? 0))
            : (asNumber(usageWire.input_tokens) ?? 0),
        outputTokens:
          asNumber(usageWire.completion_tokens) ?? asNumber(usageWire.output_tokens) ?? 0,
        ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheCreate !== undefined ? { cacheCreationTokens: cacheCreate } : {}),
        ...(promptTokens !== undefined ? { totalInputTokens: promptTokens } : {}),
        raw: wire.usage,
      }
    : undefined;

  return {
    model: asString(wire.model) ?? '',
    message,
    stopReason,
    finishReason: toFinishReason(stopReason),
    ...(usage ? { usage } : {}),
    raw: wire,
  };
};

/** Responses 响应解码。input_tokens 即计费部分；reasoning summary 归一为 thinking 块。 */
const decodeResponses = (wire: Wire): CanonicalResponse => {
  const blocks: CanonicalBlock[] = [];
  const output = Array.isArray(wire.output) ? wire.output : [];
  for (const raw of output) {
    const item = asObject(raw);
    const type = asString(item.type);
    if (type === 'message') {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const partRaw of content) {
        const part = asObject(partRaw);
        if (asString(part.type) === 'output_text') {
          blocks.push({ kind: 'text', text: asString(part.text) ?? '' });
        }
      }
    } else if (type === 'reasoning') {
      // summary 数组聚合为单个 thinking 块（IR 层不区分 summary 分片）。
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const text = summary.map((s) => asString(asObject(s).text) ?? '').join('');
      if (text) blocks.push({ kind: 'thinking', text, signatureSource: 'none' });
    } else if (type === 'function_call') {
      blocks.push({
        kind: 'tool_use',
        id: asString(item.call_id) ?? asString(item.id) ?? '',
        name: asString(item.name) ?? '',
        input: parseArguments(item.arguments),
      });
    } else if (type === 'computer_call') {
      blocks.push({
        kind: 'tool_use',
        id: asString(item.call_id) ?? asString(item.id) ?? '',
        name: 'computer',
        input: asObject(item.action),
      });
    }
  }

  const status = asString(wire.status);
  const stopReason: StopReason =
    status === 'incomplete' ? 'max_tokens' : status === 'failed' ? 'error' : 'end_turn';
  const finishReason: FinishReason =
    status === 'incomplete' ? 'incomplete' : status === 'failed' ? 'failed' : 'completed';
  const message: CanonicalMessage = { role: 'assistant', blocks };

  const usageWire = asObject(wire.usage);
  const inputDetails = asObject(usageWire.input_tokens_details);
  const outputDetails = asObject(usageWire.output_tokens_details);
  const inputTokens = asNumber(usageWire.input_tokens) ?? 0;
  const cacheRead =
    asNumber(inputDetails.cached_tokens) ?? asNumber(usageWire.cache_read_input_tokens);
  const cacheCreate = asNumber(usageWire.cache_creation_input_tokens);
  const reasoningTokens = asNumber(outputDetails.reasoning_tokens);
  const usage: UsageRecord | undefined = Object.keys(usageWire).length
    ? {
        inputTokens,
        outputTokens: asNumber(usageWire.output_tokens) ?? 0,
        ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheCreate !== undefined ? { cacheCreationTokens: cacheCreate } : {}),
        totalInputTokens: inputTokens + (cacheRead ?? 0) + (cacheCreate ?? 0),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        raw: wire.usage,
      }
    : undefined;

  return {
    model: asString(wire.model) ?? '',
    message,
    stopReason,
    finishReason,
    ...(usage ? { usage } : {}),
    raw: wire,
  };
};

/** 上游非流式响应 → CanonicalResponse（按上游协议分派）。 */
export const decodeUpstreamResponse = (
  providerProtocol: ClientProtocol,
  wire: Wire,
): CanonicalResponse => {
  if (providerProtocol === 'anthropic') return decodeAnthropic(wire);
  if (providerProtocol === 'openai-responses') return decodeResponses(wire);
  return decodeChat(wire);
};

/**
 * 从上游 wire usage 提取用量记录（同协议透传路径用，不经 CanonicalResponse）。
 * 口径与 decodeUpstreamResponse 一致。
 */
export const extractWireUsage = (
  providerProtocol: ClientProtocol,
  wire: Wire,
): UsageRecord | undefined => decodeUpstreamResponse(providerProtocol, wire).usage;
