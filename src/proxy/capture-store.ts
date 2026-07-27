/**
 * 协议抓包环形缓冲（P1.11 精简移植自 legacy-src/proxy/capture.ts）。
 *
 * 仅保留管线所需：startRequest / updateRequest / isEnabled / list / get / clear。
 * 管理端点（SSE 推送等）是后续阶段事项；此处供管线记录左右两侧报文体。
 */

/** 一次请求的抓包对：入站原始 + 出站转换后（请求/响应各一份）。 */
export interface CapturePair {
  id: number;
  /** 来源：'proxy'（直连）或适配器名。 */
  source: string;
  /** 入站（客户端）协议。 */
  inboundType: string;
  /** 客户端请求 model。 */
  model: string;
  meta: Record<string, unknown>;
  requestIn: string;
  requestOut: string;
  responseIn: string;
  responseOut: string;
  startedAt: number;
}

/** 可更新的抓包字段。 */
export type CaptureField = 'requestIn' | 'requestOut' | 'responseIn' | 'responseOut';

const DEFAULT_MAX_SIZE = 100;

/** 固定容量环形缓冲；满时淘汰最旧一对。 */
export class CaptureBuffer {
  private readonly pairs: CapturePair[] = [];
  private nextId = 1;
  private enabled = false;
  private readonly maxSize: number;

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.maxSize = Math.max(1, maxSize);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  /** 开始一次抓包对，返回 pairId。 */
  startRequest(
    source: string,
    inboundType: string,
    model: string,
    meta: Record<string, unknown> = {},
  ): number {
    const id = this.nextId++;
    this.pairs.push({
      id,
      source,
      inboundType,
      model,
      meta,
      requestIn: '',
      requestOut: '',
      responseIn: '',
      responseOut: '',
      startedAt: Date.now(),
    });
    if (this.pairs.length > this.maxSize) {
      this.pairs.splice(0, this.pairs.length - this.maxSize);
    }
    return id;
  }

  /** 更新指定字段内容（整体替换）。 */
  updateRequest(pairId: number, field: CaptureField, data: string): void {
    const pair = this.pairs.find((p) => p.id === pairId);
    if (pair) pair[field] = data;
  }

  list(): CapturePair[] {
    return [...this.pairs];
  }

  get(pairId: number): CapturePair | undefined {
    return this.pairs.find((p) => p.id === pairId);
  }

  clear(): void {
    this.pairs.length = 0;
  }
}
