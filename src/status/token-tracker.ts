export interface TokenRecord {
  date: string // 'YYYY-MM-DD'
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  request_count: number
}

export interface TokenStats {
  today: TokenRecord
  history: TokenRecord[]
  byProvider: Record<string, TokenRecord>
}

export class TokenTracker {
  private dayStats: Map<string, TokenRecord> = new Map()
  private providerStats: Map<string, Map<string, TokenRecord>> = new Map()
  private today: string

  constructor() {
    this.today = this.getToday()
  }

  private getToday(): string {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
  }

  private ensureDay(): TokenRecord {
    const today = this.getToday()
    let record = this.dayStats.get(today)
    if (!record) {
      record = { date: today, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, request_count: 0 }
      this.dayStats.set(today, record)
      this.today = today
    }
    return record
  }

  record(providerName: string, inputTokens: number, outputTokens: number, cacheRead?: number, cacheCreate?: number): void {
    const day = this.ensureDay()
    day.input_tokens += inputTokens
    day.output_tokens += outputTokens
    day.cache_read_input_tokens += cacheRead ?? 0
    day.cache_creation_input_tokens += cacheCreate ?? 0
    day.request_count += 1

    let pMap = this.providerStats.get(providerName)
    if (!pMap) {
      pMap = new Map()
      this.providerStats.set(providerName, pMap)
    }
    let pRecord = pMap.get(this.today)
    if (!pRecord) {
      pRecord = { date: this.today, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, request_count: 0 }
      pMap.set(this.today, pRecord)
    }
    pRecord.input_tokens += inputTokens
    pRecord.output_tokens += outputTokens
    pRecord.cache_read_input_tokens += cacheRead ?? 0
    pRecord.cache_creation_input_tokens += cacheCreate ?? 0
    pRecord.request_count += 1
  }

  getStats(): TokenStats {
    const today = this.today
    const todayRecord = this.dayStats.get(today) ?? { date: today, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, request_count: 0 }

    const history: TokenRecord[] = []
    for (const [date, record] of this.dayStats) {
      if (date !== today) history.push(record)
    }
    history.sort((a, b) => b.date.localeCompare(a.date))

    const byProvider: Record<string, TokenRecord> = {}
    for (const [provider, pMap] of this.providerStats) {
      const pRecord = pMap.get(today)
      if (pRecord && pRecord.request_count > 0) {
        byProvider[provider] = pRecord
      }
    }

    return { today: todayRecord, history, byProvider }
  }
}
