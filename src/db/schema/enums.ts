/**
 * P1.16 全局 ENUM 定义（设计文档 §6）。
 *
 * 四个枚举均映射为 PG `CREATE TYPE ... AS ENUM`，由 drizzle-kit 在迁移中生成。
 * 值严格对齐设计文档，禁止增删（会影响已落库数据与协议转换分支）。
 */
import { pgEnum } from 'drizzle-orm/pg-core';

/** 协议类型：上游 provider / 入站 adapter / 用量记录共用 */
export const protocolType = pgEnum('protocol_type', ['anthropic', 'openai', 'openai-responses']);

/** 推理力度（reasoning effort）：映射 provider_model 的思考强度档位 */
export const reasoningEffort = pgEnum('reasoning_effort', ['low', 'medium', 'high', 'xhigh', 'max']);

/** 思考开关类型：enabled/disabled/adaptive/auto */
export const thinkingType = pgEnum('thinking_type', ['enabled', 'disabled', 'adaptive', 'auto']);

/** 流式策略：adapter 入站请求的 stream 处理策略 */
export const streamPolicy = pgEnum('stream_policy', ['default_true', 'passthrough', 'force_true', 'force_false']);

// 枚举取值联合类型，供应用层类型收窄使用
export type ProtocolType = (typeof protocolType.enumValues)[number];
export type ReasoningEffort = (typeof reasoningEffort.enumValues)[number];
export type ThinkingType = (typeof thinkingType.enumValues)[number];
export type StreamPolicy = (typeof streamPolicy.enumValues)[number];
