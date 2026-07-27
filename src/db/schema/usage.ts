/**
 * usage_records 用量记录表（设计文档 §6，P4/P5 使用）。
 *
 * - 记录每次代理请求的 token 用量、延迟、协议、命中模型等。
 * - provider_id / provider_model_id / adapter_id 外键均可空、不级联
 *   （用量为历史事实，配置删除后仍保留记录）。
 * - status 取值白名单：success / error / timeout。
 */
import { sql } from 'drizzle-orm';
import { bigserial, bigint, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { adapters } from './adapters.ts';
import { protocolType } from './enums.ts';
import { providerModels, providers } from './providers.ts';

export const usageRecords = pgTable(
  'usage_records',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    requestId: text('request_id').notNull(),
    traceId: text('trace_id'),
    // 客户端入站协议
    clientProtocol: protocolType('client_protocol').notNull(),
    providerId: bigint('provider_id', { mode: 'number' }).references(() => providers.id),
    providerModelId: bigint('provider_model_id', { mode: 'number' }).references(() => providerModels.id),
    adapterId: bigint('adapter_id', { mode: 'number' }).references(() => adapters.id),
    // 入站逻辑模型名 / 路由解析后的实际模型名
    logicalModel: text('logical_model').notNull(),
    resolvedModel: text('resolved_model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens'),
    totalInputTokens: integer('total_input_tokens'),
    latencyMs: integer('latency_ms'),
    firstTokenMs: integer('first_token_ms'),
    // 有意使用 text + CHECK 白名单而非 pgEnum：与设计 §6 对齐（status 不在 4 个枚举之列），
    // 取值集合后续可能扩展，text+check 比 enum 更易迁移
    status: text('status').notNull(),
    errorClass: text('error_class'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 按模型 + 时间倒序聚合用量（created_at DESC）
    index('idx_usage_records_provider_model').on(t.providerModelId, t.createdAt.desc()),
    index('idx_usage_records_request_id').on(t.requestId),
    check('usage_records_status_check', sql`${t.status} IN ('success', 'error', 'timeout')`),
  ],
);

export type UsageRecordRow = typeof usageRecords.$inferSelect;
export type NewUsageRecordRow = typeof usageRecords.$inferInsert;
