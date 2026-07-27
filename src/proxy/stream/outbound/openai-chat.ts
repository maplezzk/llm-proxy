import type { RouteDecision, StreamOutboundAdapter } from '../../adapters/index.ts';
import type { CanonicalStreamEvent } from '../../ir/stream-events.ts';
import type { CanonicalBlock, UsageRecord } from '../../ir/types.ts';

const encoder = new TextEncoder();
type JsonObject = Record<string, unknown>;

type ToolState = {
  index: number;
  id: string;
  name: string;
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toUsage = (usage: UsageRecord): JsonObject => ({
  prompt_tokens: usage.totalInputTokens ?? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
  completion_tokens: usage.outputTokens,
  total_tokens: (usage.totalInputTokens ?? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0)) + usage.outputTokens,
  ...((usage.cacheReadTokens !== undefined || usage.cacheCreationTokens !== undefined)
    ? {
        prompt_tokens_details: {
          ...(usage.cacheReadTokens !== undefined ? { cached_tokens: usage.cacheReadTokens } : {}),
          ...(usage.cacheCreationTokens !== undefined ? { cache_creation_input_tokens: usage.cacheCreationTokens } : {}),
        },
      }
    : {}),
});

const mapStopReason = (reason: string): string => {
  const map: Record<string, string> = {
    end_turn: 'stop',
    stop: 'stop',
    max_tokens: 'length',
    length: 'length',
    tool_use: 'tool_calls',
    tool_calls: 'tool_calls',
    content_filter: 'content_filter',
    error: 'error',
  };
  return map[reason] ?? reason;
};

const toolName = (block: CanonicalBlock): string =>
  block.kind === 'tool_use' ? block.name : '';

const toolId = (block: CanonicalBlock): string =>
  block.kind === 'tool_use' ? block.id : '';

/** canonical 流式事件 → OpenAI Chat Completions SSE。 */
export function encodeOpenAIChatStream(
  events: AsyncIterable<CanonicalStreamEvent>,
  route: RouteDecision,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let messageStarted = false;
      let messageStopped = false;
      let finishWritten = false;
      let currentStopReason: string | undefined;
      let latestUsage: UsageRecord | undefined;
      let nextToolIndex = 0;
      let reasoningSignature = '';
      const tools = new Map<string, ToolState>();
      let lastEvent = 'before first canonical event';

      const writeChunk = (payload: JsonObject): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const ensureMessageStart = (): void => {
        if (messageStarted) return;
        messageStarted = true;
        writeChunk({
          id: `chatcmpl_${Date.now().toString(36)}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: route.resolvedModel,
          choices: [{ delta: { role: 'assistant' }, index: 0, finish_reason: null }],
        });
      };

      const rememberUsage = (usage: UsageRecord | undefined): void => {
        if (!usage) return;
        latestUsage = { ...(latestUsage ?? {}), ...usage };
      };

      const writeToolDelta = (state: ToolState, partialJson: string): void => {
        writeChunk({
          choices: [{
            delta: {
              tool_calls: [{ index: state.index, function: { arguments: partialJson } }],
            },
            index: 0,
          }],
        });
      };

      const writeFinish = (): void => {
        if (finishWritten) return;
        finishWritten = true;
        ensureMessageStart();
        const reason = currentStopReason ?? 'end_turn';
        const delta: JsonObject = {};
        if (reasoningSignature) delta.reasoning_signature = reasoningSignature;
        const chunk: JsonObject = {
          choices: [{ delta, finish_reason: mapStopReason(reason), index: 0 }],
        };
        if (latestUsage) chunk.usage = toUsage(latestUsage);
        writeChunk(chunk);
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        messageStopped = true;
      };

      try {
        for await (const event of events) {
          lastEvent = event.type;
          if (messageStopped) continue;
          if (event.type === 'message_start') {
            ensureMessageStart();
            continue;
          }
          if (event.type === 'block_start') {
            ensureMessageStart();
            if (event.block.kind === 'tool_use') {
              const state: ToolState = {
                index: nextToolIndex,
                id: toolId(event.block),
                name: toolName(event.block),
              };
              nextToolIndex += 1;
              tools.set(event.blockId, state);
              writeChunk({
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: state.index,
                      id: state.id,
                      type: 'function',
                      function: { name: state.name, arguments: '' },
                    }],
                  },
                  index: 0,
                }],
              });
            }
            continue;
          }
          if (event.type === 'block_delta') {
            ensureMessageStart();
            const delta = event.delta;
            if (delta.kind === 'text') {
              writeChunk({ choices: [{ delta: { content: delta.text }, index: 0 }] });
            } else if (delta.kind === 'thinking' || delta.kind === 'reasoning_summary') {
              writeChunk({ choices: [{ delta: { reasoning_content: delta.text }, index: 0 }] });
            } else if (delta.kind === 'tool_input_json') {
              const state = tools.get(event.blockId) ?? {
                index: nextToolIndex++,
                id: event.blockId,
                name: '',
              };
              tools.set(event.blockId, state);
              writeToolDelta(state, delta.partialJson);
            } else if (delta.kind === 'tool_input_action') {
              const state = tools.get(event.blockId) ?? {
                index: nextToolIndex++,
                id: event.blockId,
                name: '',
              };
              tools.set(event.blockId, state);
              writeToolDelta(state, JSON.stringify(delta.action));
            }
            continue;
          }
          if (event.type === 'block_signature') {
            reasoningSignature += event.signature;
            continue;
          }
          if (event.type === 'message_delta') {
            rememberUsage(event.usage);
            if (event.stopReason) currentStopReason = event.stopReason;
            continue;
          }
          if (event.type === 'message_stop') {
            if (event.stopReason) currentStopReason = event.stopReason;
            writeFinish();
            continue;
          }
          if (event.type === 'error') {
            writeChunk({ error: { type: event.error.type, message: event.error.message } });
            currentStopReason = 'error';
            continue;
          }
        }
        // 收尾契约：正常 EOF 时流式入站适配器保证发出 message_stop（openai-chat inbound 的 finish()，
        // 其他 inbound 转发上游终态），writeFinish 已在 message_stop 分支写出 [DONE]。
        // 到 EOF 仍无 message_stop 即表示解码层被截断（如客户端 abort），不兜底写 [DONE]。
        controller.close();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        controller.error(new Error(`OpenAI Chat SSE outbound encoding failed at ${lastEvent}: ${detail}`, { cause: error }));
      }
    },
  });
}

export const openAIChatStreamOutboundAdapter: StreamOutboundAdapter = {
  name: 'openai' as const,
  encode: encodeOpenAIChatStream,
};

export default openAIChatStreamOutboundAdapter;
