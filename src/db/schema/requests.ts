/**
 * requests 表 schema：P0 仅建一张表，结构为最小日志维度
 * （id / model / provider / status / created_at）。后续 providers / adapters / models /
 * usage / cost 各自拆文件，由 `src/db/schema/index.ts` 汇总导出。
 */
import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const requests = pgTable('requests', {
  id: serial('id').primaryKey(),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  status: integer('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
});

export type RequestRow = typeof requests.$inferSelect;
export type NewRequestRow = typeof requests.$inferInsert;
