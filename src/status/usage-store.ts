/**
 * 内存 token 用量存储（P1.11）。
 *
 * legacy 的 SQLite UsageStore（legacy-src/status/usage-store.ts）依赖 node:sqlite；
 * 新栈的持久化用量表 usage_records 在 PG（设计 §6，P4/P5 消费）。
 * 本阶段仅提供内存环形记录 + 今日聚合，供管线 usage 统计与日志；重启即清空。
 */
import type { ClientProtocol } from '../proxy/ir/types.ts';

/** 单次请求用量记录（口径与 legacy UsageStore.record 对齐）。 */
export interface UsageEntry {
  /** 上游供应商名。 */
  provider: string;
  /** 适配器名（直连 /v1/* 请求为 null）。 */
  adapter: string | null;
  /** 客户端请求的模型名（代理端 model 字段）。 */
  model: string;
  /** 上游实际模型 ID。 */
  upstreamModel: string;
  /** 上游供应商协议。 */
  protocol: ClientProtocol;
  /** 来源标识：'proxy' 或 adapterName。 */
  source: string;
  /** 计费输入 token（不含缓存）。 */
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  /** 记录时间戳（ms）。 */
  ts: number;
}

/** 今日聚合。 */
export interface UsageSummary {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  request_count: number;
}

const MAX_ENTRIES = 1000;

/** 本地日期 YYYY-MM-DD。 */
const localDate = (ts: number): string => {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 内存用量存储：环形保留最近 MAX_ENTRIES 条 + 今日聚合。 */
export class UsageStore {
  private readonly entries: UsageEntry[] = [];
  private todayKey: string;
  private summary: UsageSummary;

  constructor(now: number = Date.now()) {
    this.todayKey = localDate(now);
    this.summary = this.emptySummary(this.todayKey);
  }

  private emptySummary(date: string): UsageSummary {
    return {
      date,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      request_count: 0,
    };
  }

  /** 记录一次请求用量。 */
  record(entry: Omit<UsageEntry, 'ts'>): void {
    const ts = Date.now();
    const date = localDate(ts);
    // 跨日：重置今日聚合
    if (date !== this.todayKey) {
      this.todayKey = date;
      this.summary = this.emptySummary(date);
    }
    this.entries.push({ ...entry, ts });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.summary.input_tokens += entry.inputTokens;
    this.summary.output_tokens += entry.outputTokens;
    this.summary.cache_read_input_tokens += entry.cacheRead;
    this.summary.cache_creation_input_tokens += entry.cacheCreate;
    this.summary.request_count += 1;
  }

  /** 今日聚合快照。 */
  getToday(): UsageSummary {
    return { ...this.summary };
  }

  /** 最近 limit 条明细（新→旧）。 */
  recent(limit = 50): UsageEntry[] {
    return this.entries.slice(-limit).reverse();
  }
}
