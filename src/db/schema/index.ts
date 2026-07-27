/**
 * drizzle schema 聚合：按模块拆文件，最终在此 `export` 合并，
 * 作为 drizzle 客户端的 `schema` 参数与 drizzle-kit 的 `schema` 入口。
 *
 * 添加新表：在 `src/db/schema/<name>.ts` 定义，import 到下方 `tables` 对象。
 *
 * 模块清单（P1.16）：
 * - requests：P0 请求日志探针表
 * - enums：4 个全局 ENUM（protocol_type / reasoning_effort / thinking_type / stream_policy）
 * - providers：providers + provider_models
 * - adapters：adapters + adapter_model_mappings
 * - settings：vision_settings + proxy_settings（单例）
 * - usage：usage_records
 */
import * as adapters from './adapters.ts';
import * as enums from './enums.ts';
import * as providers from './providers.ts';
import * as requests from './requests.ts';
import * as settings from './settings.ts';
import * as usage from './usage.ts';

// 汇总所有表与枚举：drizzle 客户端 relational 查询只消费其中的表，
// 枚举函数一并放入以保证 drizzle-kit 扫描入口时能发现并生成 CREATE TYPE。
export const tables = {
  ...requests,
  ...enums,
  ...providers,
  ...adapters,
  ...settings,
  ...usage,
};

export { requests } from './requests.ts';
export type { RequestRow, NewRequestRow } from './requests.ts';

export { protocolType, reasoningEffort, thinkingType, streamPolicy } from './enums.ts';
export type { ProtocolType, ReasoningEffort, ThinkingType, StreamPolicy } from './enums.ts';

export { providers, providerModels } from './providers.ts';
export type {
  ProviderRow,
  NewProviderRow,
  ProviderModelRow,
  NewProviderModelRow,
} from './providers.ts';

export { adapters, adapterModelMappings } from './adapters.ts';
export type {
  AdapterRow,
  NewAdapterRow,
  AdapterModelMappingRow,
  NewAdapterModelMappingRow,
} from './adapters.ts';

export { visionSettings, proxySettings } from './settings.ts';
export type {
  VisionSettingRow,
  NewVisionSettingRow,
  ProxySettingRow,
  NewProxySettingRow,
} from './settings.ts';

export { usageRecords } from './usage.ts';
export type { UsageRecordRow, NewUsageRecordRow } from './usage.ts';

export type Schema = typeof tables;
