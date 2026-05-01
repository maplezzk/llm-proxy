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

  constructor(maxSize = 200) {
    this.maxSize = maxSize
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
    res.on('close', () => this.subscribers.delete(res))
  }

  private notifySubscribers(entry: CaptureEntry): void {
    const line = JSON.stringify(entry)
    for (const sub of this.subscribers) {
      try { sub.write(`data: ${line}\n\n`) } catch { /* subscriber gone */ }
    }
  }
}
