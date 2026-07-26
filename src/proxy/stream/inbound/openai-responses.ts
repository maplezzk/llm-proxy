import type { StreamInboundAdapter } from '../../adapters/index.ts';
import type { BlockDelta, CanonicalStreamEvent } from '../../ir/stream-events.ts';
import type { UsageRecord } from '../../ir/types.ts';

type JsonObject = Record<string, unknown>;
type SseFrame =
  | { kind: 'event'; event: string; data: unknown }
  | { kind: 'parse_error'; event: string; raw: string; error: string };

type ResponseBlock = {
  blockId: string;
  index: number;
  kind: 'text' | 'reasoning' | 'tool_use';
  text: string;
  arguments: string;
  isOpen: boolean;
  toolId?: string;
  toolName?: string;
  isComputer?: boolean;
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const asObject = (value: unknown): JsonObject => (isObject(value) ? value : {});
const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const toUsage = (value: unknown): UsageRecord | undefined => {
  const usage = asObject(value);
  if (Object.keys(usage).length === 0) return undefined;
  const inputTokens = asNumber(usage.input_tokens) ?? 0;
  const outputTokens = asNumber(usage.output_tokens) ?? 0;
  const inputDetails = asObject(usage.input_tokens_details);
  const cacheReadTokens = asNumber(inputDetails.cached_tokens) ?? asNumber(usage.cache_read_input_tokens);
  const cacheCreationTokens = asNumber(usage.cache_creation_input_tokens);
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(cacheReadTokens !== undefined || cacheCreationTokens !== undefined
      ? { totalInputTokens: inputTokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0) }
      : {}),
    reasoningTokens: asNumber(asObject(usage.output_tokens_details).reasoning_tokens),
    raw: value,
  };
};

const mapStopReason = (status: string, hasToolCalls: boolean): string => {
  if (hasToolCalls) return 'tool_use';
  if (status === 'incomplete') return 'max_tokens';
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'end_turn';
};

const toFinishReason = (reason: string): 'completed' | 'incomplete' | 'failed' => {
  if (reason === 'error') return 'failed';
  if (reason === 'max_tokens') return 'incomplete';
  return 'completed';
};

/** 读取 Responses SSE；终态快照只用于状态收尾，不重复发成增量。 */
async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseFrame = (frame: string): SseFrame | undefined => {
    let event = '';
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return undefined;
    const raw = dataLines.join('\n').trim();
    if (raw === '' || raw === '[DONE]') return { kind: 'event', event, data: raw };
    try {
      return { kind: 'event', event, data: JSON.parse(raw) as unknown };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { kind: 'parse_error', event, raw, error: detail };
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
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenAI Responses SSE read failed while decoding upstream stream: ${detail}`, { cause: error });
  } finally {
    reader.releaseLock();
  }
}

/** OpenAI Responses SSE → canonical 流式事件。 */
export async function* decodeOpenAIResponsesStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<CanonicalStreamEvent> {
  let messageStarted = false;
  let currentStopReason = 'end_turn';
  let latestUsage: UsageRecord | undefined;
  let completed = false;
  let malformedFrames = 0;
  let hasToolCalls = false;
  const blocks = new Map<string, ResponseBlock>();

  const ensureMessageStart = function* (): Generator<CanonicalStreamEvent> {
    if (!messageStarted) {
      messageStarted = true;
      yield { type: 'message_start', message: { role: 'assistant', blocks: [] } };
    }
  };

  const startBlock = function* (block: ResponseBlock): Generator<CanonicalStreamEvent> {
    const existing = blocks.get(block.blockId);
    if (existing) return;
    blocks.set(block.blockId, block);
    yield* ensureMessageStart();
    const canonical = block.kind === 'text'
      ? { kind: 'text' as const, text: '' }
      : block.kind === 'reasoning'
        ? { kind: 'reasoning' as const, text: '' }
        : {
            kind: 'tool_use' as const,
            id: block.toolId ?? block.blockId,
            name: block.toolName ?? '',
            input: {},
            ...(block.isComputer ? { computer: {} } : {}),
          };
    yield { type: 'block_start', blockId: block.blockId, index: block.index, block: canonical };
  };

  const stopBlock = function* (block: ResponseBlock): Generator<CanonicalStreamEvent> {
    if (!block.isOpen) return;
    block.isOpen = false;
    yield { type: 'block_stop', blockId: block.blockId, index: block.index };
  };

  const stopAllBlocks = function* (): Generator<CanonicalStreamEvent> {
    for (const block of blocks.values()) yield* stopBlock(block);
  };

  const blockForText = (outputIndex: number, contentIndex: number): ResponseBlock => ({
    blockId: `responses:text:${outputIndex}:${contentIndex}`,
    index: outputIndex,
    kind: 'text',
    text: '',
    arguments: '',
    isOpen: true,
  });

  const blockForReasoning = (outputIndex: number): ResponseBlock => ({
    blockId: `responses:reasoning:${outputIndex}`,
    index: outputIndex,
    kind: 'reasoning',
    text: '',
    arguments: '',
    isOpen: true,
  });

  const blockForTool = (outputIndex: number, item: JsonObject): ResponseBlock => ({
    blockId: `responses:tool:${outputIndex}`,
    index: outputIndex,
    kind: 'tool_use',
    text: '',
    arguments: '',
    isOpen: true,
    toolId: asString(item.call_id) ?? asString(item.id) ?? `call_${outputIndex}`,
    toolName: asString(item.name) ?? (item.type === 'computer_call' ? 'computer' : ''),
    isComputer: item.type === 'computer_call',
  });

  const stopReasonFromCompleted = (payload: JsonObject): string => {
    const response = asObject(payload.response);
    const status = asString(response.status) ?? 'completed';
    return mapStopReason(status, hasToolCalls);
  };

  const finalize = function* (): Generator<CanonicalStreamEvent> {
    if (completed) return;
    completed = true;
    yield* ensureMessageStart();
    yield* stopAllBlocks();
    yield {
      type: 'message_delta',
      stopReason: currentStopReason,
      ...(latestUsage ? { usage: latestUsage } : {}),
    };
    yield {
      type: 'message_stop',
      stopReason: currentStopReason,
      finishReason: toFinishReason(currentStopReason),
    };
  };

  for await (const frame of readSse(stream)) {
    if (frame.kind === 'parse_error') {
      malformedFrames += 1;
      yield {
        type: 'error',
        error: { type: 'invalid_sse', message: `Malformed OpenAI Responses SSE data: ${frame.raw} (${frame.error})` },
      };
      if (malformedFrames >= 3) throw new Error(`OpenAI Responses SSE protocol error: three consecutive malformed frames (last data: ${frame.raw.slice(0, 160)})`);
      continue;
    }
    malformedFrames = 0;
    if (typeof frame.data === 'string') continue;

    const payload = asObject(frame.data);
    const type = asString(payload.type) ?? frame.event;
    if (type === 'response.created' || type === 'response.in_progress') {
      yield* ensureMessageStart();
      continue;
    }

    const response = asObject(payload.response);
    const responseUsage = toUsage(response.usage);
    if (responseUsage) latestUsage = responseUsage;

    if (type === 'response.output_item.added') {
      const item = asObject(payload.item);
      const outputIndex = asNumber(payload.output_index) ?? blocks.size;
      const itemType = asString(item.type);
      if (itemType === 'message') {
        yield* ensureMessageStart();
      } else if (itemType === 'function_call' || itemType === 'computer_call') {
        hasToolCalls = true;
        yield* startBlock(blockForTool(outputIndex, item));
      } else if (itemType === 'reasoning') {
        yield* startBlock(blockForReasoning(outputIndex));
      }
      continue;
    }

    if (type === 'response.output_text.delta') {
      yield* ensureMessageStart();
      const outputIndex = asNumber(payload.output_index) ?? 0;
      const contentIndex = asNumber(payload.content_index) ?? 0;
      const block = blocks.get(`responses:text:${outputIndex}:${contentIndex}`) ?? blockForText(outputIndex, contentIndex);
      yield* startBlock(block);
      const delta = asString(payload.delta) ?? '';
      if (delta) {
        block.text += delta;
        const blockDelta: BlockDelta = { kind: 'text', text: delta };
        yield { type: 'block_delta', blockId: block.blockId, index: block.index, delta: blockDelta };
      }
      continue;
    }

    if (type === 'response.output_text.done') {
      const outputIndex = asNumber(payload.output_index) ?? 0;
      const contentIndex = asNumber(payload.content_index) ?? 0;
      const block = blocks.get(`responses:text:${outputIndex}:${contentIndex}`);
      if (block) yield* stopBlock(block);
      continue;
    }

    if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
      yield* ensureMessageStart();
      const outputIndex = asNumber(payload.output_index) ?? 0;
      const block = blocks.get(`responses:reasoning:${outputIndex}`) ?? blockForReasoning(outputIndex);
      yield* startBlock(block);
      const delta = asString(payload.delta) ?? '';
      if (delta) {
        block.text += delta;
        yield {
          type: 'block_delta',
          blockId: block.blockId,
          index: block.index,
          delta: { kind: 'reasoning_summary', text: delta },
        };
      }
      continue;
    }

    if (type === 'response.reasoning_text.done' || type === 'response.reasoning_summary_text.done') {
      const outputIndex = asNumber(payload.output_index) ?? 0;
      const block = blocks.get(`responses:reasoning:${outputIndex}`);
      if (block) yield* stopBlock(block);
      continue;
    }

    if (type === 'response.function_call_arguments.delta') {
      hasToolCalls = true;
      const outputIndex = asNumber(payload.output_index) ?? 0;
      const existing = blocks.get(`responses:tool:${outputIndex}`);
      const block = existing ?? blockForTool(outputIndex, { type: 'function_call' });
      yield* startBlock(block);
      const delta = asString(payload.delta) ?? '';
      if (delta) {
        block.arguments += delta;
        yield {
          type: 'block_delta',
          blockId: block.blockId,
          index: block.index,
          delta: { kind: 'tool_input_json', partialJson: delta },
        };
      }
      continue;
    }

    if (type === 'response.function_call_arguments.done') {
      const outputIndex = asNumber(payload.output_index) ?? 0;
      const block = blocks.get(`responses:tool:${outputIndex}`);
      if (block) yield* stopBlock(block);
      continue;
    }

    if (type === 'response.output_item.done') {
      const outputIndex = asNumber(payload.output_index) ?? 0;
      const item = asObject(payload.item);
      const block = blocks.get(`responses:tool:${outputIndex}`);
      if (block) yield* stopBlock(block);
      if (item.type === 'message') {
        for (const candidate of blocks.values()) {
          if (candidate.index === outputIndex && candidate.kind === 'text') yield* stopBlock(candidate);
        }
      }
      continue;
    }

    if (type === 'response.completed' || frame.event === 'response.completed') {
      currentStopReason = stopReasonFromCompleted(payload);
      const usage = toUsage(response.usage);
      if (usage) latestUsage = usage;
      yield* finalize();
      continue;
    }

    if (type === 'error') {
      const error = asObject(payload.error);
      yield {
        type: 'error',
        error: {
          type: asString(error.type) ?? 'upstream_error',
          message: asString(error.message) ?? 'OpenAI Responses upstream stream error',
        },
      };
      currentStopReason = 'error';
    }
  }

  yield* finalize();
}

export const openAIResponsesStreamInboundAdapter: StreamInboundAdapter = {
  name: 'openai-responses' as const,
  decode: decodeOpenAIResponsesStream,
};

export default openAIResponsesStreamInboundAdapter;
