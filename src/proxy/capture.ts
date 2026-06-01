import type { ServerResponse } from 'node:http'

export interface CaptureMeta {
  /** 适配器名称（仅适配器请求） */
  adapterName?: string
  /** 上游供应商名称，如 "deepseek" */
  upstreamProvider?: string
  /** 上游供应商协议，如 "openai" */
  upstreamProtocol?: string
  /** 上游供应商模型 ID，如 "deepseek-chat" */
  upstreamModel?: string
}

export interface CaptureEntry extends CaptureMeta {
  id: number
  timestamp: number
  /** 来源：proxy（代理入口）或适配器名称 */
  source: string
  /** 代理端协议 */
  protocol: string
  /** 代理端模型 */
  model: string
  pairId: number
  /** 客户端→代理（原始请求） */
  requestIn: string | null
  /** 代理→上游（转换后请求） */
  requestOut: string | null
  /** 上游→代理（原始响应） */
  responseIn: string | null
  /** 代理→客户端（转换后响应） */
  responseOut: string | null
}

export class CaptureBuffer {
  private buffer: CaptureEntry[] = []
  private nextId = 1
  private nextPairId = 1
  private maxSize: number
  private subscribers: Set<ServerResponse> = new Set()
  /** pairId → CaptureEntry 的快速索引 */
  private entryMap: Map<number, CaptureEntry> = new Map()
  private _enabled = false

  constructor(maxSize = 100) {
    this.maxSize = maxSize
  }

  isEnabled(): boolean {
    return this._enabled
  }

  enable(): void {
    this._enabled = true
  }

  disable(): void {
    this._enabled = false
    this.clear()
  }

  clear(): void {
    this.buffer = []
    this.entryMap.clear()
  }

  /** 创建一条新请求的抓包记录，返回 pairId */
  startRequest(source: string, protocol: string, model: string, meta?: CaptureMeta): number {
    const pairId = this.nextPairId++
    const entry: CaptureEntry = {
      id: this.nextId++,
      timestamp: Date.now(),
      source,
      protocol,
      model,
      pairId,
      requestIn: null,
      requestOut: null,
      responseIn: null,
      responseOut: null,
      ...meta,
    }
    this.buffer.push(entry)
    this.entryMap.set(pairId, entry)
    if (this.buffer.length > this.maxSize) {
      const removed = this.buffer.splice(0, this.buffer.length - this.maxSize)
      for (const r of removed) {
        this.entryMap.delete(r.pairId)
      }
    }
    this.notifySubscribers(entry)
    return pairId
  }

  /** 更新已有记录某个阶段的数据 */
  updateRequest(
    pairId: number,
    field: 'requestIn' | 'requestOut' | 'responseIn' | 'responseOut',
    data: string
  ): void {
    const entry = this.entryMap.get(pairId)
    if (!entry) return
    entry[field] = data
    this.notifySubscribers(entry)
  }

  getAll(): CaptureEntry[] {
    return [...this.buffer]
  }

  subscribe(res: ServerResponse): void {
    this.subscribers.add(res)
    // 'close' 事件不可靠（客户端 kill -9 / NAT 超时 / 反代断开等都不会触发），
    // 所以同时在写入时主动检测并清理死连接。
    res.on('close', () => this.subscribers.delete(res))
  }

  /** 主动清理已死亡/被销毁的 subscriber，防止句柄 + 内部 buffer 泄漏 */
  private pruneDeadSubscribers(): void {
    for (const sub of this.subscribers) {
      // 仅当属性显式表示死亡/不可写时才清理；undefined 视为可用（兼容测试 mock）
      const s = sub as { destroyed?: boolean; writableEnded?: boolean; writable?: boolean }
      if (s.destroyed === true || s.writableEnded === true || s.writable === false) {
        this.subscribers.delete(sub)
      }
    }
  }

  private isSubDead(sub: ServerResponse): boolean {
    const s = sub as { destroyed?: boolean; writableEnded?: boolean; writable?: boolean }
    return s.destroyed === true || s.writableEnded === true || s.writable === false
  }

  private notifySubscribers(entry: CaptureEntry): void {
    if (this.subscribers.size === 0) return
    this.pruneDeadSubscribers()
    if (this.subscribers.size === 0) return

    const line = JSON.stringify(entry)
    const payload = `data: ${line}\n\n`
    for (const sub of this.subscribers) {
      try {
        // 写入前再检查一次（并发场景下 close 可能刚发生）
        if (this.isSubDead(sub)) {
          this.subscribers.delete(sub)
          continue
        }
        // 反压时跳过本次写入，避免 Node 内部 _writableState.buffer 无限膨胀；
        // 后续 notify 时若客户端已消费完会自然恢复。
        if (!sub.write(payload)) {
          // do nothing
        }
      } catch {
        this.subscribers.delete(sub)
      }
    }
  }
}
