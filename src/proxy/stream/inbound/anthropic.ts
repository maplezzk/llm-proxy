import type { StreamInboundAdapter } from '../../adapters/index.ts';
import type { CanonicalBlock, CanonicalMessage, ToolInput, UsageRecord } from '../../ir/types.ts';
import type { BlockDelta, CanonicalStreamEvent } from '../../ir/stream-events.ts';
import { abortableIterator } from '../abort.ts';

/** Anthropic SSE 的单个事件帧。 */
type SseFrame =
  | { kind: 'event'; event: string; data: unknown }
  | { kind: 'parse_error'; event: string; raw: string };

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asObject = (value: unknown): JsonObject => (isObject(value) ? value : {});

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asToolInput = (value: unknown): ToolInput => (isObject(value) ? value : {});

/** 把 Anthropic content block 归一为 CanonicalBlock。 */
const toCanonicalBlock = (value: unknown): CanonicalBlock | undefined => {
  const block = asObject(value);
  const type = asString(block.type);
  if (type === 'text') return { kind: 'text', text: asString(block.text) ?? '' };
  if (type === 'thinking' || type === 'redacted_thinking') {
    const signature = asString(block.signature);
    return {
      kind: 'thinking',
      text: asString(block.thinking) ?? '',
      ...(signature ? { signature, signatureSource: 'original' as const } : {}),
      ...(type === 'redacted_thinking' ? { redacted: true } : {}),
    };
  }
  if (type === 'tool_use') {
    return {
      kind: 'tool_use',
      id: asString(block.id) ?? '',
      name: asString(block.name) ?? '',
      input: asToolInput(block.input),
    };
  }
  if (type === 'image') {
    const source = asObject(block.source);
    if (source.type === 'url' && typeof source.url === 'string') {
      return { kind: 'image', source: { kind: 'url', url: source.url } };
    }
    if (source.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
      return { kind: 'image', source: { kind: 'base64', mediaType: source.media_type, data: source.data } };
    }
  }
  return undefined;
};

const toCanonicalMessage = (value: unknown): CanonicalMessage => {
  const message = asObject(value);
  const role = message.role === 'user' || message.role === 'system' || message.role === 'tool'
    ? message.role
    : 'assistant';
  const blocks = Array.isArray(message.content)
    ? message.content.map(toCanonicalBlock).filter((block): block is CanonicalBlock => block !== undefined)
    : [];
  return { role, blocks };
};

/** Anthropic usage → IR usage；input_tokens 保持计费输入语义。 */
const toUsage = (value: unknown): UsageRecord | undefined => {
  const usage = asObject(value);
  const hasUsage = Object.keys(usage).length > 0;
  if (!hasUsage) return undefined;
  const inputTokens = asNumber(usage.input_tokens) ?? 0;
  const outputTokens = asNumber(usage.output_tokens) ?? 0;
  const cacheReadTokens = asNumber(usage.cache_read_input_tokens);
  const cacheCreationTokens = asNumber(usage.cache_creation_input_tokens);
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(cacheReadTokens !== undefined || cacheCreationTokens !== undefined
      ? { totalInputTokens: inputTokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0) }
      : {}),
    raw: value,
  };
};

/**
 * 以 SSE 记录为单位读取 Web Stream。
 * 读取器只在本函数生命周期内持有，结束时无论成功失败都释放锁。
 */
async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseFrame = (frame: string): SseFrame | undefined => {
    const eventLines = frame.split(/\r?\n/);
    let event = '';
    const dataLines: string[] = [];
    for (const line of eventLines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return undefined;
    const raw = dataLines.join('\n').trim();
    if (raw === '[DONE]' || raw === '') return { kind: 'event', event, data: raw };
    try {
      return { kind: 'event', event, data: JSON.parse(raw) as unknown };
    } catch {
      return { kind: 'parse_error', event, raw };
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
    }
    if (buffer.trim()) {
      const parsed = parseFrame(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

const ANTHROPIC_BLOCK_ID_PREFIX = 'anthropic:';

const finishReason = (reason: string): 'completed' | 'incomplete' | 'failed' => {
  if (reason === 'error') return 'failed';
  if (reason === 'max_tokens' || reason === 'context_length') return 'incomplete';
  return 'completed';
};

/** Anthropic wire SSE → canonical 流式事件。 */
export async function* decodeAnthropicStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<CanonicalStreamEvent> {
  let currentStopReason = 'end_turn';
  const openBlocks = new Set<string>();

  let malformedFrames = 0;

  // abort 时 abortableIterator 提前结束迭代，本函数随之返回，不发出任何残留事件。
  for await (const frame of abortableIterator(readSse(stream), stream, signal)) {
    if (frame.kind === 'parse_error') {
      malformedFrames += 1;
      yield {
        type: 'error',
        error: {
          type: 'invalid_sse',
          message: `Malformed Anthropic SSE data: ${frame.raw}`,
        },
      };
      if (malformedFrames >= 3) {
        throw new Error('Anthropic SSE protocol produced three consecutive malformed frames');
      }
      continue;
    }
    malformedFrames = 0;
    if (typeof frame.data === 'string') continue;
    const data = asObject(frame.data);
    const type = asString(data.type) ?? frame.event;

    if (type === 'ping') continue;
    if (type === 'error' || frame.event === 'error') {
      const error = asObject(data.error);
      yield {
        type: 'error',
        error: {
          type: asString(error.type) ?? 'upstream_error',
          message: asString(error.message) ?? 'Anthropic upstream stream error',
          retryable: asNumber(data.status) === 429,
        },
      };
      continue;
    }

    if (type === 'message_start') {
      const message = asObject(data.message);
      const usage = toUsage(message.usage);
      yield { type: 'message_start', message: toCanonicalMessage(message) };
      if (usage) yield { type: 'message_delta', usage };
      continue;
    }

    if (type === 'content_block_start') {
      const index = asNumber(data.index) ?? openBlocks.size;
      const block = toCanonicalBlock(data.content_block);
      if (!block) continue;
      const id = `${ANTHROPIC_BLOCK_ID_PREFIX}${index}`;
      openBlocks.add(id);
      yield { type: 'block_start', blockId: id, index, block };
      continue;
    }

    if (type === 'content_block_delta') {
      const index = asNumber(data.index) ?? 0;
      const id = `${ANTHROPIC_BLOCK_ID_PREFIX}${index}`;
      const delta = asObject(data.delta);
      const deltaType = asString(delta.type);
      let canonicalDelta: BlockDelta | undefined;
      if (deltaType === 'text_delta') {
        canonicalDelta = { kind: 'text', text: asString(delta.text) ?? '' };
      } else if (deltaType === 'thinking_delta') {
        canonicalDelta = { kind: 'thinking', text: asString(delta.thinking) ?? '' };
      } else if (deltaType === 'input_json_delta') {
        canonicalDelta = { kind: 'tool_input_json', partialJson: asString(delta.partial_json) ?? '' };
      }
      if (canonicalDelta) yield { type: 'block_delta', blockId: id, index, delta: canonicalDelta };
      else if (deltaType === 'signature_delta') {
        const signature = asString(delta.signature);
        if (signature) yield { type: 'block_signature', blockId: id, index, signature, source: 'original' };
      }
      continue;
    }

    if (type === 'content_block_stop') {
      const index = asNumber(data.index) ?? 0;
      const id = `${ANTHROPIC_BLOCK_ID_PREFIX}${index}`;
      openBlocks.delete(id);
      yield { type: 'block_stop', blockId: id, index };
      continue;
    }

    if (type === 'message_delta') {
      const delta = asObject(data.delta);
      const reason = asString(delta.stop_reason) ?? asString(data.stop_reason);
      if (reason) currentStopReason = reason;
      const usage = toUsage(data.usage);
      yield {
        type: 'message_delta',
        ...(reason ? { stopReason: reason } : {}),
        ...(usage ? { usage } : {}),
      };
      continue;
    }

    if (type === 'message_stop') {
      yield {
        type: 'message_stop',
        stopReason: currentStopReason,
        finishReason: finishReason(currentStopReason),
      };
    }
  }
}

export const anthropicStreamInboundAdapter: StreamInboundAdapter = {
  name: 'anthropic' as const,
  decode: decodeAnthropicStream,
};

export default anthropicStreamInboundAdapter;
