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
  /**
   * 抓包 SSE 订阅者集合。
   * 使用 Map<ServerResponse, { lastSeen }> 跟踪每个订阅者的最近活跃时间，
   * 以便后续 pruneStaleSubscribers() 主动剔除长时间无活动的死连接。
   */
  private subscribers: Map<ServerResponse, { lastSeen: number }> = new Map()
  /** 订阅者空闲超时（毫秒）——超过此时长无活动则从集合中移除 */
  private subscriberIdleTimeoutMs = 60_000
  /** 定期清理周期（毫秒） */
  private subscriberPruneIntervalMs = 30_000
  private pruneTimer: NodeJS.Timeout | null = null
  /** pairId → CaptureEntry 的快速索引 */
  private entryMap: Map<number, CaptureEntry> = new Map()
  private _enabled = false

  constructor(maxSize = 100) {
    this.maxSize = maxSize
    // 启动定期清理定时器（unref 不阻止进程退出）
    this.pruneTimer = setInterval(() => this.pruneStaleSubscribers(), this.subscriberPruneIntervalMs)
    if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref()
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
    this.subscribers.set(res, { lastSeen: Date.now() })
    // 'close' 事件不可靠（客户端 kill -9 / NAT 超时 / 反代断开等都不会触发），
    // 所以同时在写入时主动检测并清理死连接。
    res.on('close', () => this.subscribers.delete(res))
  }

  /** 主动清理已死亡/被销毁的 subscriber，防止句柄 + 内部 buffer 泄漏 */
  private pruneDeadSubscribers(): void {
    for (const sub of this.subscribers.keys()) {
      // 仅当属性显式表示死亡/不可写时才清理；undefined 视为可用（兼容测试 mock）
      const s = sub as { destroyed?: boolean; writableEnded?: boolean; writable?: boolean }
      if (s.destroyed === true || s.writableEnded === true || s.writable === false) {
        this.subscribers.delete(sub)
      }
    }
  }

  /**
   * 清理长时间无活动的 subscriber。
   * close 事件不可靠，部分场景（如反代超时中断、NAT 重建）下永远不会触发。
   * 定期清理可保证即使完全静默断开也能被回收，避免句柄和缓冲区累积泄漏。
   */
  private pruneStaleSubscribers(): void {
    const now = Date.now()
    for (const [sub, meta] of this.subscribers) {
      const s = sub as { destroyed?: boolean; writableEnded?: boolean; writable?: boolean }
      const dead = s.destroyed === true || s.writableEnded === true || s.writable === false
      if (dead || now - meta.lastSeen > this.subscriberIdleTimeoutMs) {
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
    const now = Date.now()
    for (const [sub, meta] of this.subscribers) {
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
        meta.lastSeen = now
      } catch {
        this.subscribers.delete(sub)
      }
    }
  }

  /** 释放定时器等资源（测试用） */
  destroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    this.subscribers.clear()
  }
}
