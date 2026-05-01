import type { ServerResponse } from 'node:http'

export type CaptureDirection = 'request-in' | 'request-out' | 'response-in' | 'response-out'

export interface CaptureEntry {
  id: number
  timestamp: number
  direction: CaptureDirection
  source: string
  protocol: string
  model: string
  rawData: string
  pairId: number
}

export class CaptureBuffer {
  private buffer: CaptureEntry[] = []
  private nextId = 1
  private nextPairId = 1
  private maxSize: number
  private subscribers: Set<ServerResponse> = new Set()
  /** 当前正在构建的配对 ID（用于关联入站出站） */
  private currentPairId = 0

  constructor(maxSize = 200) {
    this.maxSize = maxSize
  }

  /** 开始一个新请求的配对 */
  startPair(): number {
    this.currentPairId = this.nextPairId++
    return this.currentPairId
  }

  record(
    direction: CaptureDirection,
    source: string,
    protocol: string,
    model: string,
    rawData: string,
    pairId?: number
  ): void {
    const entry: CaptureEntry = {
      id: this.nextId++,
      timestamp: Date.now(),
      direction,
      source,
      protocol,
      model,
      rawData,
      pairId: pairId ?? this.currentPairId,
    }

    this.buffer.push(entry)
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize)
    }

    // Push to SSE subscribers
    const line = JSON.stringify(entry)
    for (const sub of this.subscribers) {
      try { sub.write(`data: ${line}\n\n`) } catch { /* subscriber gone */ }
    }
  }

  getAll(): CaptureEntry[] {
    return [...this.buffer]
  }

  subscribe(res: ServerResponse): void {
    this.subscribers.add(res)
    res.on('close', () => this.subscribers.delete(res))
  }
}
