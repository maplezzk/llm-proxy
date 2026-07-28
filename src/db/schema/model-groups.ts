/**
 * 模型组与渠道绑定（P2 U2）。
 *
 * - model_groups：逻辑模型及其默认能力上限。
 * - model_group_channels：逻辑模型到 provider_model 的渠道绑定；路由只消费此表的 priority。
 * - 删除模型组时级联删除渠道绑定；provider_model 被引用时不级联删除。
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
import { providerModels } from './providers.ts';

export const modelGroups = pgTable(
  'model_groups',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull().unique(),
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    enabled: boolean('enabled').notNull().default(true),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('model_groups_context_window_check', sql`${table.contextWindow} > 0`),
    check('model_groups_max_output_tokens_check', sql`${table.maxOutputTokens} > 0`),
  ],
);

export const modelGroupChannels = pgTable(
  'model_group_channels',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    modelGroupId: bigint('model_group_id', { mode: 'number' })
      .notNull()
      .references(() => modelGroups.id, { onDelete: 'cascade' }),
    providerModelId: bigint('provider_model_id', { mode: 'number' })
      .notNull()
      .references(() => providerModels.id),
    priority: integer('priority').notNull().default(0),
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('model_group_channels_group_provider_model_unique').on(
      table.modelGroupId,
      table.providerModelId,
    ),
    index('idx_model_group_channels_group_priority')
      .on(table.modelGroupId, table.priority)
      .where(sql`${table.enabled}`),
    check('model_group_channels_context_window_check', sql`${table.contextWindow} > 0`),
    check('model_group_channels_max_output_tokens_check', sql`${table.maxOutputTokens} > 0`),
  ],
);

export type ModelGroupRow = typeof modelGroups.$inferSelect;
export type NewModelGroupRow = typeof modelGroups.$inferInsert;
export type ModelGroupChannelRow = typeof modelGroupChannels.$inferSelect;
export type NewModelGroupChannelRow = typeof modelGroupChannels.$inferInsert;
