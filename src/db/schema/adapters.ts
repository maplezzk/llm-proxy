/**
 * adapters / adapter_model_mappings 两张表（设计文档 §6）。
 *
 * - adapters：协议适配虚拟端点，inbound_type 为入站协议，stream_policy 控制流式策略。
 * - adapter_model_mappings：adapter 入站模型映射到 legacy provider_model 或逻辑 model_group。
 *   - adapter_id 外键 ON DELETE CASCADE（删 adapter 级联删映射）。
 *   - provider_model_id 保留 legacy 映射，也用于 model-centric 钉死渠道。
 *   - model_group_id 为 model-centric 绑定；迁移期允许与 provider_model_id 同时存在。
 *   - (adapter_id, source_model_id) 组合唯一。
 *   - thinking_override / generation_overrides 为 JSONB，由应用层 validate。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { protocolType, streamPolicy } from './enums.ts';
import { modelGroups } from './model-groups.ts';
import { providerModels } from './providers.ts';

export const adapters = pgTable(
  'adapters',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // 全库唯一的 adapter 名
    name: text('name').notNull().unique(),
    // 入站协议类型
    inboundType: protocolType('inbound_type').notNull(),
    maxTokensOverride: integer('max_tokens_override'),
    // 流式策略，默认透传入站请求的 stream 参数
    streamPolicy: streamPolicy('stream_policy').notNull().default('passthrough'),
    enabled: boolean('enabled').notNull().default(true),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('adapters_max_tokens_override_check', sql`${t.maxTokensOverride} > 0`)],
);

export const adapterModelMappings = pgTable(
  'adapter_model_mappings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // 删 adapter 时级联删除其映射
    adapterId: bigint('adapter_id', { mode: 'number' })
      .notNull()
      .references(() => adapters.id, { onDelete: 'cascade' }),
    sourceModelId: text('source_model_id').notNull(),
    // Legacy 映射目标；model-centric 钉死渠道时也复用此列
    providerModelId: bigint('provider_model_id', { mode: 'number' }).references(
      () => providerModels.id,
    ),
    // 逻辑模型组；legacy 行在自动升级后也会写入该列
    modelGroupId: bigint('model_group_id', { mode: 'number' }).references(() => modelGroups.id),
    // null = 继承 provider_model；否则存 ReasoningSpec 子集（应用层 validate）
    thinkingOverride: jsonb('thinking_override'),
    generationOverrides: jsonb('generation_overrides'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 同 adapter 内 source_model_id 唯一
    unique('adapter_model_mappings_adapter_id_source_model_id_unique').on(
      t.adapterId,
      t.sourceModelId,
    ),
    index('idx_adapter_mappings_adapter_id').on(t.adapterId),
    check(
      'adapter_model_mappings_target_check',
      sql`${t.providerModelId} IS NOT NULL OR ${t.modelGroupId} IS NOT NULL`,
    ),
  ],
);

export type AdapterRow = typeof adapters.$inferSelect;
export type NewAdapterRow = typeof adapters.$inferInsert;
export type AdapterModelMappingRow = typeof adapterModelMappings.$inferSelect;
export type NewAdapterModelMappingRow = typeof adapterModelMappings.$inferInsert;
