/**
 * 入站适配器注册导出。
 *
 * 设计依据：docs/plans/2026-07-27-003-feat-p1-protocol-core-design.md §4 / §5。
 *
 * 提供默认 inbound adapter 数组（按 clientProtocol 索引），供 pipeline（P1.11）按
 * path / clientProtocol 选取并调用 decode。本模块不引入路由决策，仅暴露注册数据。
 *
 * 适配器实例请直接从 `./anthropic.ts` / `./openai-chat.ts` / `./openai-responses.ts`
 * 导入，本 barrel 只承担注册数组单一职责。
 */

import type { InboundAdapter } from '../index.ts';
import { anthropicInboundAdapter } from './anthropic.ts';
import { openaiChatInboundAdapter } from './openai-chat.ts';
import { openaiResponsesInboundAdapter } from './openai-responses.ts';

/** 所有内置入站适配器，按数组下标顺序匹配 clientProtocol。 */
export const inboundAdapters: ReadonlyArray<InboundAdapter> = [
  anthropicInboundAdapter,
  openaiChatInboundAdapter,
  openaiResponsesInboundAdapter,
] as const;