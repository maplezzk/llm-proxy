import type { StreamInboundAdapter } from '../../adapters/index.ts';
import type { BlockDelta, CanonicalStreamEvent } from '../../ir/stream-events.ts';
import type { UsageRecord } from '../../ir/types.ts';
import { abortableIterator } from '../abort.ts';

type JsonObject = Record<string, unknown>;
type SseFrame =
  | { kind: 'event'; event: string; data: unknown }
  | { kind: 'parse_error'; event: string; raw: string; error: string };

type ChatToolState = {
  blockId: string;
  index: number;
  id: string;
  name: string;
  arguments: string;
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asObject = (value: unknown): JsonObject => (isObject(value) ? value : {});
const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const toText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    const object = asObject(part);
    return object.type === 'text' && typeof object.text === 'string' ? object.text : '';
  }).join('');
};

const toUsage = (value: unknown): UsageRecord | undefined => {
  const usage = asObject(value);
  if (Object.keys(usage).length === 0) return undefined;
  const promptTokens = asNumber(usage.prompt_tokens) ?? asNumber(usage.input_tokens) ?? 0;
  const completionTokens = asNumber(usage.completion_tokens) ?? asNumber(usage.output_tokens) ?? 0;
  const promptDetails = asObject(usage.prompt_tokens_details ?? usage.prompt_cache_details);
  const cacheReadTokens = asNumber(promptDetails.cached_tokens) ?? asNumber(usage.cache_read_input_tokens);
  const cacheCreationTokens = asNumber(usage.prompt_cache_miss_tokens)
    ?? asNumber(usage.cache_creation_input_tokens);
  const inputTokens = Math.max(0, promptTokens - (cacheReadTokens ?? 0) - (cacheCreationTokens ?? 0));
  return {
    inputTokens,
    outputTokens: completionTokens,
    ...(cacheReadTokens !== undefined && cacheReadTokens !== 0 ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    totalInputTokens: promptTokens,
    raw: value,
  };
};

const mergeUsage = (previousUsage: UsageRecord | undefined, nextUsage: UsageRecord): UsageRecord => ({
  ...(previousUsage ?? {}),
  ...nextUsage,
  // usage-only chunk 通常携带完整快照，保留最新 raw 和所有显式字段。
  inputTokens: nextUsage.inputTokens,
  outputTokens: nextUsage.outputTokens,
});

const mapStopReason = (value: unknown): string | undefined => {
  const reason = asString(value);
  if (!reason) return undefined;
  const map: Record<string, string> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    function_call: 'tool_use',
    content_filter: 'content_filter',
    error: 'error',
  };
  return map[reason] ?? reason;
};

const toFinishReason = (reason: string): 'completed' | 'incomplete' | 'failed' => {
  if (reason === 'error') return 'failed';
  if (reason === 'max_tokens' || reason === 'context_length') return 'incomplete';
  return 'completed';
};

/** 读取 Chat Completions 的 SSE 帧，并在坏帧处保留可辨识错误。 */
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
      // 解析层保留原文和失败原因交给上层计数并生成协议错误事件，避免静默丢帧。
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
    throw new Error(`OpenAI Chat SSE read failed while decoding upstream stream: ${detail}`, { cause: error });
  } finally {
    reader.releaseLock();
  }
}

const errorEvent = (type: string, message: string): CanonicalStreamEvent => ({
  type: 'error',
  error: { type, message },
});

/** OpenAI Chat SSE → canonical 流式事件。 */
export async function* decodeOpenAIChatStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<CanonicalStreamEvent> {
  let messageStarted = false;
  let currentStopReason: string | undefined;
  let latestUsage: UsageRecord | undefined;
  let finalized = false;
  let malformedFrames = 0;
  const openBlocks = new Set<string>();
  const tools = new Map<number, ChatToolState>();

  const ensureMessageStart = function* (): Generator<CanonicalStreamEvent> {
    if (!messageStarted) {
      messageStarted = true;
      yield { type: 'message_start', message: { role: 'assistant', blocks: [] } };
    }
  };

  const closeBlock = function* (blockId: string, index: number): Generator<CanonicalStreamEvent> {
    if (!openBlocks.delete(blockId)) return;
    yield { type: 'block_stop', blockId, index };
  };

  const ensureThinkingBlock = function* (): Generator<CanonicalStreamEvent> {
    if (openBlocks.has('chat:thinking')) return;
    openBlocks.add('chat:thinking');
    yield {
      type: 'block_start',
      blockId: 'chat:thinking',
      index: 0,
      block: { kind: 'thinking', text: '' },
    };
  };

  const ensureTextBlock = function* (): Generator<CanonicalStreamEvent> {
    if (openBlocks.has('chat:text')) return;
    openBlocks.add('chat:text');
    yield { type: 'block_start', blockId: 'chat:text', index: 0, block: { kind: 'text', text: '' } };
  };

  const finish = function* (): Generator<CanonicalStreamEvent> {
    if (finalized) return;
    finalized = true;
    yield* ensureMessageStart();
    for (const [index, tool] of tools) yield* closeBlock(tool.blockId, index);
    if (openBlocks.has('chat:thinking')) yield* closeBlock('chat:thinking', 0);
    if (openBlocks.has('chat:text')) yield* closeBlock('chat:text', 0);
    const reason = currentStopReason ?? 'end_turn';
    if (currentStopReason !== undefined || latestUsage) {
      yield {
        type: 'message_delta',
        ...(currentStopReason !== undefined ? { stopReason: reason } : {}),
        ...(latestUsage ? { usage: latestUsage } : {}),
      };
    }
    yield { type: 'message_stop', stopReason: reason, finishReason: toFinishReason(reason) };
  };

  // stream 既是帧来源，也是 abort 清理目标；abortableIterator 会先 source.return 释放锁再 stream.cancel。
  const frames = abortableIterator(readSse(stream), stream, signal);
  let wasAborted = false;
  try {
    while (true) {
      const next = await frames.next();
      if (next.done) {
        wasAborted = next.value === true;
        break;
      }
      const frame = next.value;
      if (frame.kind === 'parse_error') {
        malformedFrames += 1;
        yield {
          type: 'error',
          error: { type: 'invalid_sse', message: `Malformed OpenAI Chat SSE data: ${frame.raw} (${frame.error})` },
        };
        if (malformedFrames >= 3) throw new Error(`OpenAI Chat SSE protocol error: three consecutive malformed frames (last data: ${frame.raw.slice(0, 160)})`);
        continue;
      }
      malformedFrames = 0;
      if (typeof frame.data === 'string') {
        if (frame.data === '[DONE]') yield* finish();
        continue;
      }

      const payload = asObject(frame.data);
      const payloadError = asObject(payload.error);
      if (Object.keys(payloadError).length > 0 || frame.event === 'error') {
        yield {
          type: 'error',
          error: {
            type: asString(payloadError.type) ?? 'upstream_error',
            message: asString(payloadError.message) ?? 'OpenAI Chat upstream stream error',
          },
        };
        currentStopReason = 'error';
        continue;
      }

      const topLevelUsage = toUsage(payload.usage);
      if (topLevelUsage) latestUsage = mergeUsage(latestUsage, topLevelUsage);

      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      if (choices.length === 0) continue;
      const choice = asObject(choices[0]);
      // Kimi k3 等供应商把 usage 嵌在 choices[0] 内，需作为顶层 usage 的回退来源。
      const choiceUsage = toUsage(choice.usage);
      if (choiceUsage) latestUsage = mergeUsage(latestUsage, choiceUsage);
      const delta = asObject(choice.delta);
      const deltaHasContent = delta.content !== undefined || delta.reasoning_content !== undefined
        || delta.reasoning !== undefined || delta.tool_calls !== undefined;
      // OpenAI Chat wire 没有 message_start 帧；只标记状态，message_start 由出站适配器在首个内容块时补齐。
      if (!messageStarted && (delta.role === 'assistant' || deltaHasContent)) messageStarted = true;

      const reasoning = toText(delta.reasoning_content ?? delta.reasoning);
      if (reasoning !== '') {
        messageStarted = true;
        yield* ensureThinkingBlock();
        const reasoningDelta: BlockDelta = { kind: 'thinking', text: reasoning };
        yield { type: 'block_delta', blockId: 'chat:thinking', index: 0, delta: reasoningDelta };
      }

      const content = toText(delta.content);
      if (content !== '') {
        messageStarted = true;
        if (openBlocks.has('chat:thinking')) yield* closeBlock('chat:thinking', 0);
        yield* ensureTextBlock();
        yield {
          type: 'block_delta',
          blockId: 'chat:text',
          index: 0,
          delta: { kind: 'text', text: content },
        };
      }

      if (Array.isArray(delta.tool_calls)) {
        messageStarted = true;
        for (const rawToolCall of delta.tool_calls) {
          const toolCall = asObject(rawToolCall);
          const index = asNumber(toolCall.index) ?? tools.size;
          const functionValue = asObject(toolCall.function);
          let tool = tools.get(index);
          if (!tool) {
            const id = asString(toolCall.id) ?? `call_${index}`;
            const name = asString(functionValue.name) ?? '';
            tool = {
              blockId: `chat:tool:${index}`,
              index,
              id,
              name,
              arguments: '',
            };
            tools.set(index, tool);
            openBlocks.add(tool.blockId);
            yield {
              type: 'block_start',
              blockId: tool.blockId,
              index,
              block: { kind: 'tool_use', id, name, input: {} },
            };
          } else if (!tool.name && typeof functionValue.name === 'string') {
            tool.name = functionValue.name;
          }
          const partialJson = asString(functionValue.arguments) ?? '';
          if (partialJson !== '') {
            tool.arguments += partialJson;
            yield {
              type: 'block_delta',
              blockId: tool.blockId,
              index,
              delta: { kind: 'tool_input_json', partialJson },
            };
          }
        }
      }

      const signature = asString(delta.reasoning_signature);
      if (signature) {
        messageStarted = true;
        yield* ensureThinkingBlock();
        yield { type: 'block_signature', blockId: 'chat:thinking', index: 0, signature, source: 'original' };
      }

      const finishValue = mapStopReason(choice.finish_reason);
      if (finishValue) {
        currentStopReason = finishValue;
        // 完成事件被延迟到 [DONE]，以便合并后续 choices=[] usage-only chunk。
      }
    }
  } catch (error) {
    // 读取异常不静默消失：非 abort 错误转成 canonical error 事件后终止流。
    // wasAborted = true 阻止后续 finish() 补发收尾事件。
    wasAborted = true;
    if (error instanceof Error && error.name === 'AbortError') return;
    const detail = error instanceof Error ? error.message : String(error);
    yield {
      type: 'error',
      error: { type: 'upstream_error', message: `OpenAI Chat SSE decode failed: ${detail}` },
    };
    return;
  }

  // 客户端 abort 后不发收尾事件：截断事件流交给上层处理，避免误写 message_stop。
  if (!wasAborted) yield* finish();
}

export const openAIChatStreamInboundAdapter: StreamInboundAdapter = {
  name: 'openai' as const,
  decode: decodeOpenAIChatStream,
};

export default openAIChatStreamInboundAdapter;
