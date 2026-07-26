/**
 * Canonical 流式事件 IR。
 *
 * 设计依据：docs/plans/2026-07-27-003-feat-p1-protocol-core-design.md §3.5。
 *
 * 关键点：
 * - 块用稳定 blockId 标识；index 仅作为出站适配器分配协议索引时的提示，不承担语义。
 * - 签名独立成 block_signature 事件，与块内容解耦，便于多轮一致性处理。
 * - 区分「实时增量」（block_delta）与「终态聚合」（message_stop 携带聚合 summary）。
 */

import type { CanonicalBlock, CanonicalMessage, UsageRecord } from './types.ts';

/** 块增量。 */
export type BlockDelta =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'reasoning_summary'; text: string }
  | { kind: 'tool_input_json'; partialJson: string }
  | { kind: 'tool_input_action'; action: unknown }
  | { kind: 'image_ref'; fileId?: string };

/**
 * 流式事件统一表示。
 * - block_start/stop 用 blockId 配对；Anthropic 出站适配器据此分配 content_block 索引并补 stop。
 * - block_signature 在 thinking_delta 之后、block_stop 之前发出（不变量 §7.3.3）。
 * - error.retryable 供 P3 failover 作流中错误信号。
 */
export type CanonicalStreamEvent =
  | { type: 'message_start'; message: CanonicalMessage }
  | { type: 'block_start'; blockId: string; index: number; block: CanonicalBlock }
  | { type: 'block_delta'; blockId: string; index: number; delta: BlockDelta }
  | {
      type: 'block_signature';
      blockId: string;
      index: number;
      signature: string;
      source: 'original' | 'generated';
    }
  | { type: 'block_stop'; blockId: string; index: number }
  | { type: 'message_delta'; stopReason?: string; usage?: UsageRecord }
  | {
      type: 'message_stop';
      stopReason: string;
      finishReason: 'completed' | 'incomplete' | 'failed';
    }
  | { type: 'error'; error: { type: string; message: string; retryable?: boolean } };
