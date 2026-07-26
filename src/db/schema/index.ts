/**
 * drizzle schema 聚合：按模块拆文件，最终在此 `export` 合并，
 * 作为 drizzle 客户端的 `schema` 参数与 drizzle-kit 的 `schema` 入口。
 *
 * 添加新表：在 `src/db/schema/<name>.ts` 定义，import 到下方 `tables` 对象。
 */
import * as requests from './requests.ts';

export const tables = {
  ...requests,
};

export { requests } from './requests.ts';
export type { RequestRow, NewRequestRow } from './requests.ts';

export type Schema = typeof tables;
