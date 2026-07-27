import type { RouteDecision, StreamOutboundAdapter } from '../../adapters/index.ts';
import type { CanonicalStreamEvent } from '../../ir/stream-events.ts';
import type { CanonicalBlock, UsageRecord } from '../../ir/types.ts';

const encoder = new TextEncoder();
type JsonObject = Record<string, unknown>;

type ToolState = {
  outputIndex: number;
  id: string;
  name: string;
  arguments: string;
  isComputer: boolean;
  computerAction: JsonObject;
  isClosed: boolean;
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'completed',
  stop: 'completed',
  max_tokens: 'incomplete',
  length: 'incomplete',
  tool_use: 'completed',
  tool_calls: 'completed',
  error: 'failed',
};

const toResponsesUsage = (usage: UsageRecord): JsonObject => {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheCreation = usage.cacheCreationTokens ?? 0;
  const inputTokens = usage.inputTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: inputTokens + cacheRead + cacheCreation + usage.outputTokens,
    ...(cacheRead > 0 ? { input_tokens_details: { cached_tokens: cacheRead } } : {}),
    ...(cacheCreation > 0 ? { cache_creation_input_tokens: cacheCreation } : {}),
    ...(usage.reasoningTokens !== undefined ? { output_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}),
  };
};

const toOpenAIAction = (input: JsonObject): JsonObject => {
  if (typeof input.type === 'string') return input;
  const action = typeof input.action === 'string' ? input.action : '';
  const coordinate = Array.isArray(input.coordinate) ? input.coordinate : [];
  const result: JsonObject = {};
  if (action === 'click' || action === 'double_click' || action === 'drag') {
    result.type = action;
    if (typeof coordinate[0] === 'number') result.x = coordinate[0];
    if (typeof coordinate[1] === 'number') result.y = coordinate[1];
  } else if (action === 'mouse_move') {
    result.type = 'move';
    if (typeof coordinate[0] === 'number') result.x = coordinate[0];
    if (typeof coordinate[1] === 'number') result.y = coordinate[1];
  } else if (action === 'key') {
    result.type = 'keypress';
    result.keys = [typeof input.text === 'string' ? input.text : ''];
  } else if (action === 'scroll') {
    result.type = 'scroll';
    if (typeof coordinate[0] === 'number') result.x = coordinate[0];
    if (typeof coordinate[1] === 'number') result.y = coordinate[1];
    if (typeof input.scroll_x === 'number') result.scroll_x = input.scroll_x;
    if (typeof input.scroll_y === 'number') result.scroll_y = input.scroll_y;
  } else if (action === 'type') {
    result.type = 'type';
    result.text = typeof input.text === 'string' ? input.text : '';
  } else if (action === 'wait') {
    result.type = 'wait';
    result.ms = typeof input.duration === 'number' ? input.duration : 0;
  } else if (action === 'screenshot') {
    result.type = 'screenshot';
  } else {
    result.type = action;
    Object.assign(result, input);
  }
  return result;
};

/** canonical 流式事件 → OpenAI Responses SSE。 */
export function encodeOpenAIResponsesStream(
  events: AsyncIterable<CanonicalStreamEvent>,
  route: RouteDecision,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let responseStarted = false;
      let responseStopped = false;
      let messageItemAdded = false;
      let messageItemClosed = false;
      let messageText = '';
      let reasoningSummary = '';
      let latestUsage: UsageRecord | undefined;
      let currentStopReason = 'end_turn';
      let currentFinishReason: 'completed' | 'incomplete' | 'failed' = 'completed';
      let nextOutputIndex = 1;
      let currentEvent = 'before first canonical event';
      const responseId = `resp_${Date.now().toString(36)}`;
      const messageId = `msg_${Date.now().toString(36)}`;
      const tools = new Map<string, ToolState>();
      const outputItems: JsonObject[] = [];
      // 追踪处于打开状态的 reasoning/thinking 块，block_stop 或收尾时补发 reasoning_text.done。
      const reasoningBlocks = new Set<string>();
      let reasoningDoneWritten = false;

      const writeEvent = (event: string, data: JsonObject): void => {
        const payload = JSON.stringify(data);
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
      };

      const ensureResponseStart = (): void => {
        if (responseStarted) return;
        responseStarted = true;
        const createdAt = Math.floor(Date.now() / 1000);
        writeEvent('response.created', {
          type: 'response.created',
          response: {
            id: responseId,
            object: 'response',
            created_at: createdAt,
            model: route.resolvedModel,
            status: 'in_progress',
            output: [],
          },
        });
        writeEvent('response.in_progress', {
          type: 'response.in_progress',
          response: {
            id: responseId,
            object: 'response',
            created_at: createdAt,
            model: route.resolvedModel,
            status: 'in_progress',
            output: [],
          },
        });
      };

      const ensureMessageItem = (): void => {
        ensureResponseStart();
        if (messageItemAdded) return;
        messageItemAdded = true;
        writeEvent('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: messageId, status: 'in_progress', role: 'assistant', content: [] },
        });
        writeEvent('response.content_part.added', {
          type: 'response.content_part.added',
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
      };

      const writeTextDone = (): void => {
        if (!messageItemAdded) return;
        writeEvent('response.output_text.done', {
          type: 'response.output_text.done',
          output_index: 0,
          content_index: 0,
          text: messageText,
        });
      };

      const closeTool = (state: ToolState): void => {
        if (state.isClosed) return;
        state.isClosed = true;
        if (state.isComputer) {
          const action = state.computerAction;
          writeEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: state.outputIndex,
            item: {
              type: 'computer_call',
              id: `cc_${state.id}`,
              call_id: state.id,
              action,
              pending_safety_checks: [],
              status: 'completed',
            },
          });
          outputItems.push({
            type: 'computer_call',
            id: `cc_${state.id}`,
            call_id: state.id,
            action,
            pending_safety_checks: [],
            status: 'completed',
          });
          return;
        }
        writeEvent('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          output_index: state.outputIndex,
          arguments: state.arguments,
        });
        const item: JsonObject = {
          type: 'function_call',
          id: `fc_${state.id}`,
          call_id: state.id,
          name: state.name,
          arguments: state.arguments,
          status: 'completed',
        };
        writeEvent('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: state.outputIndex,
          item,
        });
        outputItems.push(item);
      };

      // 三类输出（text / tool / reasoning）的统一收尾子步骤：
      // 正常路径由各 block_stop 逐个关闭，这里负责“上游未发 *.done”时的兜底补齐。
      const closeAll = (): void => {
        writeTextDone();
        for (const state of tools.values()) closeTool(state);
        if (reasoningBlocks.size > 0) {
          reasoningBlocks.clear();
          writeReasoningDone();
        }
      };

      // legacy 行为：thinking/reasoning 增量用 response.reasoning_text.delta 表达，
      // 全部 reasoning 块关闭后补发一次 response.reasoning_text.done；
      // 聚合 summary 仍放在 completed 顶层 reasoning.summary。
      const writeReasoningDone = (): void => {
        if (reasoningDoneWritten) return;
        reasoningDoneWritten = true;
        writeEvent('response.reasoning_text.done', {
          type: 'response.reasoning_text.done',
          output_index: 0,
          text: reasoningSummary,
        });
      };

      const finishResponse = (): void => {
        if (responseStopped) return;
        responseStopped = true;
        ensureResponseStart();
        ensureMessageItem();
        closeAll();
        if (!messageItemClosed) {
          messageItemClosed = true;
          const messageOutput: JsonObject = {
            type: 'message',
            id: messageId,
            status: 'completed',
            role: 'assistant',
            content: messageText ? [{ type: 'output_text', text: messageText, annotations: [] }] : [],
          };
          writeEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: messageOutput,
          });
          outputItems.unshift(messageOutput);
        }
        const response: JsonObject = {
          id: responseId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model: route.resolvedModel,
          status: currentFinishReason === 'failed' ? 'failed' : currentFinishReason === 'incomplete' ? 'incomplete' : 'completed',
          output: outputItems,
        };
        if (reasoningSummary) {
          response.reasoning = { summary: [{ type: 'summary_text', text: reasoningSummary, index: 0 }] };
        }
        if (latestUsage) response.usage = toResponsesUsage(latestUsage);
        writeEvent('response.completed', { type: 'response.completed', response });
      };

      try {
        for await (const event of events) {
          currentEvent = event.type;
          if (responseStopped) continue;
          if (event.type === 'message_start') {
            ensureResponseStart();
            continue;
          }
          if (event.type === 'block_start') {
            ensureResponseStart();
            const block = event.block;
            if (block.kind === 'text') {
              ensureMessageItem();
            } else if (block.kind === 'thinking' || block.kind === 'reasoning') {
              reasoningBlocks.add(event.blockId);
            } else if (block.kind === 'tool_use') {
              const isComputer = block.name === 'computer' || block.computer !== undefined;
              const state: ToolState = {
                outputIndex: nextOutputIndex++,
                id: block.id,
                name: block.name,
                arguments: isComputer ? JSON.stringify(toOpenAIAction(block.input)) : '',
                isComputer,
                computerAction: isComputer ? toOpenAIAction(block.input) : {},
                isClosed: false,
              };
              tools.set(event.blockId, state);
              if (isComputer) {
                const action = toOpenAIAction(block.input);
                writeEvent('response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: state.outputIndex,
                  item: {
                    type: 'computer_call',
                    id: `cc_${state.id}`,
                    call_id: state.id,
                    action,
                    pending_safety_checks: [],
                    status: 'in_progress',
                  },
                });
              } else {
                writeEvent('response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: state.outputIndex,
                  item: {
                    type: 'function_call',
                    id: `fc_${state.id}`,
                    call_id: state.id,
                    name: state.name,
                    arguments: state.arguments,
                  },
                });
              }
            }
            continue;
          }
          if (event.type === 'block_delta') {
            ensureResponseStart();
            if (event.delta.kind === 'text') {
              ensureMessageItem();
              messageText += event.delta.text;
              writeEvent('response.output_text.delta', {
                type: 'response.output_text.delta',
                output_index: 0,
                content_index: 0,
                delta: event.delta.text,
              });
            } else if (event.delta.kind === 'thinking' || event.delta.kind === 'reasoning_summary') {
              reasoningSummary += event.delta.text;
              writeEvent('response.reasoning_text.delta', {
                type: 'response.reasoning_text.delta',
                output_index: 0,
                delta: event.delta.text,
              });
            } else if (event.delta.kind === 'tool_input_json') {
              const state = tools.get(event.blockId);
              if (state) {
                state.arguments += event.delta.partialJson;
                writeEvent('response.function_call_arguments.delta', {
                  type: 'response.function_call_arguments.delta',
                  output_index: state.outputIndex,
                  delta: event.delta.partialJson,
                });
              }
            } else if (event.delta.kind === 'tool_input_action') {
              const state = tools.get(event.blockId);
              if (state) {
                const actionJson = JSON.stringify(event.delta.action);
                state.arguments += actionJson;
                writeEvent('response.function_call_arguments.delta', {
                  type: 'response.function_call_arguments.delta',
                  output_index: state.outputIndex,
                  delta: actionJson,
                });
              }
            }
            continue;
          }
          if (event.type === 'block_stop') {
            const state = tools.get(event.blockId);
            if (state) closeTool(state);
            // reasoning 块全部关闭后补发一次 reasoning_text.done。
            if (reasoningBlocks.delete(event.blockId) && reasoningBlocks.size === 0) {
              writeReasoningDone();
            }
            continue;
          }
          if (event.type === 'block_signature') continue;
          if (event.type === 'message_delta') {
            if (event.stopReason) currentStopReason = event.stopReason;
            if (event.usage) latestUsage = { ...(latestUsage ?? {}), ...event.usage };
            currentFinishReason = STOP_REASON_MAP[currentStopReason] === 'failed'
              ? 'failed'
              : STOP_REASON_MAP[currentStopReason] === 'incomplete' ? 'incomplete' : 'completed';
            continue;
          }
          if (event.type === 'message_stop') {
            currentStopReason = event.stopReason;
            currentFinishReason = event.finishReason;
            finishResponse();
            continue;
          }
          if (event.type === 'error') {
            writeEvent('error', {
              type: 'error',
              error: { type: event.error.type, message: event.error.message },
            });
            currentStopReason = 'error';
            currentFinishReason = 'failed';
            finishResponse();
            continue;
          }
        }
        finishResponse();
        controller.close();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        controller.error(new Error(`OpenAI Responses SSE outbound encoding failed at ${currentEvent}: ${detail}`, { cause: error }));
      }
    },
  });
}

export const openAIResponsesStreamOutboundAdapter: StreamOutboundAdapter = {
  name: 'openai-responses' as const,
  encode: encodeOpenAIResponsesStream,
};

export default openAIResponsesStreamOutboundAdapter;
