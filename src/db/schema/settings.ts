/**
 * vision_settings / proxy_settings 两张单例表（设计文档 §6）。
 *
 * 单例模式：id INTEGER PRIMARY KEY DEFAULT 1 + CHECK (id = 1)，
 * 保证全表至多一行配置；upsert 时固定写 id = 1。
 */
import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { providerModels } from './providers.ts';

export const visionSettings = pgTable(
  'vision_settings',
  {
    id: integer('id').primaryKey().default(1),
    // 视觉理解使用的模型（指向 provider_model，不级联）
    providerModelId: bigint('provider_model_id', { mode: 'number' })
      .notNull()
      .references(() => providerModels.id),
    prompt: text('prompt'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 单例约束：id 恒为 1
    check('vision_settings_id_check', sql`${t.id} = 1`),
  ],
);

export const proxySettings = pgTable(
  'proxy_settings',
  {
    id: integer('id').primaryKey().default(1),
    // bcrypt/argon2 哈希，不存明文 proxy_key
    proxyKeyHash: text('proxy_key_hash'),
    logLevel: text('log_level').notNull().default('info'),
    locale: text('locale').notNull().default('en'),
    port: integer('port').notNull().default(9000),
    captureMaxSize: integer('capture_max_size').notNull().default(1000),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 单例约束：id 恒为 1
    check('proxy_settings_id_check', sql`${t.id} = 1`),
    // log_level / locale 取值白名单
    check('proxy_settings_log_level_check', sql`${t.logLevel} IN ('debug', 'info', 'warn', 'error')`),
    check('proxy_settings_locale_check', sql`${t.locale} IN ('zh', 'en')`),
  ],
);

export type VisionSettingRow = typeof visionSettings.$inferSelect;
export type NewVisionSettingRow = typeof visionSettings.$inferInsert;
export type ProxySettingRow = typeof proxySettings.$inferSelect;
export type NewProxySettingRow = typeof proxySettings.$inferInsert;
