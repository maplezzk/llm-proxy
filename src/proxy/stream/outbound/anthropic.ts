import { createHash } from 'node:crypto';
import type { RouteDecision, StreamOutboundAdapter } from '../../adapters/index.ts';
import type { BlockDelta, CanonicalStreamEvent } from '../../ir/stream-events.ts';
import type { CanonicalBlock, UsageRecord } from '../../ir/types.ts';

const encoder = new TextEncoder();

type JsonObject = Record<string, unknown>;
type BlockState = {
  blockId: string;
  index: number;
  kind: CanonicalBlock['kind'];
  text: string;
  signature: string;
  signatureEmitted: boolean;
  isOpen: boolean;
};

const isThinkingKind = (kind: CanonicalBlock['kind']): boolean =>
  kind === 'thinking' || kind === 'reasoning';

const makeSignature = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

const asObject = (value: unknown): JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};

const mapStopReason = (reason: string): string => {
  const map: Record<string, string> = {
    stop: 'end_turn',
    end_turn: 'end_turn',
    length: 'max_tokens',
    max_tokens: 'max_tokens',
    tool_calls: 'tool_use',
    function_call: 'tool_use',
    content_filter: 'content_filter',
  };
  return map[reason] ?? reason;
};

const toUsage = (usage: UsageRecord): JsonObject => ({
  input_tokens: usage.inputTokens,
  output_tokens: usage.outputTokens,
  ...(usage.cacheReadTokens !== undefined ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
  ...(usage.cacheCreationTokens !== undefined ? { cache_creation_input_tokens: usage.cacheCreationTokens } : {}),
});

const blockWire = (block: CanonicalBlock): JsonObject => {
  if (block.kind === 'thinking' || block.kind === 'reasoning') {
    return { type: 'thinking', thinking: '' };
  }
  if (block.kind === 'text') return { type: 'text', text: '' };
  if (block.kind === 'tool_use') {
    const id = typeof block.id === 'string' ? block.id : '';
    const name = typeof block.name === 'string' ? block.name : '';
    const input = typeof block.input === 'object' && block.input !== null && !Array.isArray(block.input)
      ? block.input
      : {};
    return { type: 'tool_use', id, name, input };
  }
  return { type: 'text', text: '' };
};

const initialBlockText = (block: CanonicalBlock): string => {
  if (block.kind === 'text' || block.kind === 'thinking' || block.kind === 'reasoning') {
    return typeof block.text === 'string' ? block.text : '';
  }
  return '';
};

const deltaKind = (delta: BlockDelta): CanonicalBlock['kind'] => {
  if (delta.kind === 'thinking' || delta.kind === 'reasoning_summary') return 'thinking';
  if (delta.kind === 'tool_input_json' || delta.kind === 'tool_input_action') return 'tool_use';
  return 'text';
};

/** canonical 流式事件 → Anthropic SSE。 */
export function encodeAnthropicStream(
  events: AsyncIterable<CanonicalStreamEvent>,
  route: RouteDecision,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let messageStarted = false;
      let messageStopped = false;
      let stopReasonWritten = false;
      let nextToolIndex = 2;
      const blocks = new Map<string, BlockState>();

      const enqueueEvent = (event: string, data: JsonObject): void => {
        const json = JSON.stringify(data);
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${json}\n\n`));
      };

      const ensureMessageStart = (): void => {
        if (messageStarted) return;
        messageStarted = true;
        enqueueEvent('message_start', {
          type: 'message_start',
          message: {
            id: `msg_${Date.now().toString(36)}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: route.resolvedModel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
      };

      const allocateIndex = (block: CanonicalBlock): number => {
        if (isThinkingKind(block.kind)) return 0;
        if (block.kind === 'text') return 1;
        const index = nextToolIndex;
        nextToolIndex += 1;
        return index;
      };

      const ensureBlock = (blockId: string, block: CanonicalBlock): BlockState => {
        const existing = blocks.get(blockId);
        if (existing) return existing;
        const index = allocateIndex(block);
        const state: BlockState = {
          blockId,
          index,
          kind: block.kind,
          text: initialBlockText(block),
          signature: block.kind === 'thinking' ? block.signature ?? '' : '',
          signatureEmitted: false,
          isOpen: true,
        };
        blocks.set(blockId, state);
        enqueueEvent('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: blockWire(block),
        });
        return state;
      };

      const stateForDelta = (event: Extract<CanonicalStreamEvent, { type: 'block_delta' }>): BlockState => {
        const existing = blocks.get(event.blockId);
        if (existing) return existing;
        const kind = deltaKind(event.delta);
        const block: CanonicalBlock = kind === 'thinking'
          ? { kind: 'thinking', text: '' }
          : kind === 'tool_use'
            ? { kind: 'tool_use', id: event.blockId, name: '', input: {} }
            : { kind: 'text', text: '' };
        return ensureBlock(event.blockId, block);
      };

      const closeBlock = (state: BlockState): void => {
        if (!state.isOpen) return;
        if (isThinkingKind(state.kind) && !state.signatureEmitted) {
          const signature = state.signature || makeSignature(state.text);
          enqueueEvent('content_block_delta', {
            type: 'content_block_delta',
            index: state.index,
            delta: { type: 'signature_delta', signature },
          });
          state.signature = signature;
          state.signatureEmitted = true;
        }
        enqueueEvent('content_block_stop', { type: 'content_block_stop', index: state.index });
        state.isOpen = false;
      };

      const closeOpenBlocks = (): void => {
        for (const state of blocks.values()) closeBlock(state);
      };

      const writeMessageDelta = (reason: string | undefined, usage: UsageRecord | undefined): void => {
        const delta: JsonObject = {};
        if (reason) {
          delta.stop_reason = mapStopReason(reason);
          delta.stop_sequence = null;
          stopReasonWritten = true;
        }
        enqueueEvent('message_delta', {
          type: 'message_delta',
          delta,
          ...(usage ? { usage: toUsage(usage) } : {}),
        });
      };

      try {
        for await (const event of events) {
          if (messageStopped) continue;
          if (event.type === 'message_start') {
            ensureMessageStart();
            continue;
          }
          if (event.type === 'block_start') {
            ensureMessageStart();
            ensureBlock(event.blockId, event.block);
            continue;
          }
          if (event.type === 'block_delta') {
            ensureMessageStart();
            const state = stateForDelta(event);
            const delta = event.delta;
            if (delta.kind === 'text') {
              state.text += delta.text;
              enqueueEvent('content_block_delta', {
                type: 'content_block_delta',
                index: state.index,
                delta: { type: 'text_delta', text: delta.text },
              });
            } else if (delta.kind === 'thinking' || delta.kind === 'reasoning_summary') {
              state.text += delta.text;
              enqueueEvent('content_block_delta', {
                type: 'content_block_delta',
                index: state.index,
                delta: { type: 'thinking_delta', thinking: delta.text },
              });
            } else if (delta.kind === 'tool_input_json') {
              enqueueEvent('content_block_delta', {
                type: 'content_block_delta',
                index: state.index,
                delta: { type: 'input_json_delta', partial_json: delta.partialJson },
              });
            } else if (delta.kind === 'tool_input_action') {
              enqueueEvent('content_block_delta', {
                type: 'content_block_delta',
                index: state.index,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(delta.action) },
              });
            }
            continue;
          }
          if (event.type === 'block_signature') {
            ensureMessageStart();
            const existing = blocks.get(event.blockId);
            const state = existing ?? ensureBlock(event.blockId, { kind: 'thinking', text: '' });
            state.signature += event.signature;
            enqueueEvent('content_block_delta', {
              type: 'content_block_delta',
              index: state.index,
              delta: { type: 'signature_delta', signature: event.signature },
            });
            state.signatureEmitted = true;
            continue;
          }
          if (event.type === 'block_stop') {
            const state = blocks.get(event.blockId);
            if (state) closeBlock(state);
            continue;
          }
          if (event.type === 'message_delta') {
            ensureMessageStart();
            if (event.stopReason) closeOpenBlocks();
            writeMessageDelta(event.stopReason, event.usage);
            continue;
          }
          if (event.type === 'message_stop') {
            ensureMessageStart();
            closeOpenBlocks();
            if (!stopReasonWritten) writeMessageDelta(event.stopReason, undefined);
            enqueueEvent('message_stop', { type: 'message_stop' });
            messageStopped = true;
            continue;
          }
          if (event.type === 'error') {
            enqueueEvent('error', {
              type: 'error',
              error: { type: event.error.type, message: event.error.message },
            });
            continue;
          }
        }
        if (!messageStopped) {
          ensureMessageStart();
          closeOpenBlocks();
          if (!stopReasonWritten) writeMessageDelta(undefined, undefined);
          enqueueEvent('message_stop', { type: 'message_stop' });
        }
        controller.close();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        controller.error(new Error(`Anthropic SSE outbound encoding failed: ${detail}`, { cause: error }));
      }
    },
  });
}

export const anthropicStreamOutboundAdapter: StreamOutboundAdapter = {
  name: 'anthropic' as const,
  encode: encodeAnthropicStream,
};

export default anthropicStreamOutboundAdapter;
