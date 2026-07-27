/**
 * providers / provider_models 两张表（设计文档 §6）。
 *
 * - providers：上游供应商，credential_ref 存加密 secret/vault 引用，禁明文 api_key。
 * - provider_models：供应商下的模型能力描述（输入模态、思考能力、上下文/价格等放 metadata）。
 * - provider_models.provider_id 外键 ON DELETE CASCADE（删供应商级联删模型）。
 * - (provider_id, model_id) 组合唯一；直连路由不强制 model 全局唯一（priority 决定顺序）。
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  bigint,
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
import { protocolType, reasoningEffort, thinkingType } from './enums.ts';

export const providers = pgTable(
  'providers',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // 全库唯一的供应商名
    name: text('name').notNull().unique(),
    // 协议类型；未设 api_base 时由 type 推导默认地址
    type: protocolType('type').notNull(),
    apiBase: text('api_base'),
    // 加密 secret 或 vault ref，禁止明文
    credentialRef: text('credential_ref').notNull(),
    // 直连全局路由声明顺序，升序匹配首个命中
    priority: integer('priority').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 部分索引：仅对启用中的供应商按 priority 建索引，加速直连路由扫描
    index('idx_providers_priority').on(t.priority).where(sql`${t.enabled}`),
  ],
);

export const providerModels = pgTable(
  'provider_models',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // 删供应商时级联删除其模型
    providerId: bigint('provider_id', { mode: 'number' })
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    displayName: text('display_name'),
    // 输入模态集合，默认仅文本
    inputModalities: text('input_modalities').array().notNull().default(['text']),
    thinkingEnabled: boolean('thinking_enabled').notNull().default(false),
    thinkingBudgetTokens: integer('thinking_budget_tokens'),
    thinkingReasoningEffort: reasoningEffort('thinking_reasoning_effort'),
    thinkingType: thinkingType('thinking_type'),
    maxOutputTokens: integer('max_output_tokens'),
    // 工具能力 / 上下文窗口 / 价格等扩展信息
    metadata: jsonb('metadata').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 同供应商内 model_id 唯一
    unique('provider_models_provider_id_model_id_unique').on(t.providerId, t.modelId),
    index('idx_provider_models_model_id').on(t.modelId),
    check('provider_models_thinking_budget_tokens_check', sql`${t.thinkingBudgetTokens} > 0`),
    check('provider_models_max_output_tokens_check', sql`${t.maxOutputTokens} > 0`),
  ],
);

export type ProviderRow = typeof providers.$inferSelect;
export type NewProviderRow = typeof providers.$inferInsert;
export type ProviderModelRow = typeof providerModels.$inferSelect;
export type NewProviderModelRow = typeof providerModels.$inferInsert;
