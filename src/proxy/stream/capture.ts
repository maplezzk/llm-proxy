/** 流式抓包行的方向。 */
export type CaptureDirection = 'raw' | 'out'

export interface CaptureLine {
  pairId: number
  ts: string
  direction: CaptureDirection
  line: string
}

/** 流适配器注入的抓包回调；实现方负责按 pairId 聚合并更新 CaptureBuffer。 */
export interface captureSink {
  (entry: CaptureLine): void
}

/** 将流行写入旧 CaptureBuffer 的对应响应字段。 */
export function createCaptureSink(
  update: (pairId: number, field: 'responseIn' | 'responseOut', data: string) => void,
): captureSink {
  const lines = new Map<number, { raw: string[]; out: string[] }>()
  return ({ pairId, ts, direction, line }) => {
    const pair = lines.get(pairId) ?? { raw: [], out: [] }
    pair[direction].push(`[${ts}] ${line}`)
    lines.set(pairId, pair)
    update(pairId, direction === 'raw' ? 'responseIn' : 'responseOut', pair[direction].join(''))
  }
}
