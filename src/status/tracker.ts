import type { ProviderStatus, ProviderType } from '../config/types.js'

interface RequestRecord {
  timestamp: number
  latency: number
  success: boolean
}

export class StatusTracker {
  private records: Map<string, RequestRecord[]> = new Map()
  private windowMs: number

  constructor(windowMs = 5 * 60 * 1000) {
    this.windowMs = windowMs
  }

  recordRequest(providerName: string, latency: number, success: boolean): void {
    this.prune(providerName)
    const records = this.records.get(providerName) ?? []
    records.push({ timestamp: Date.now(), latency, success })
    this.records.set(providerName, records)
  }

  getStatus(providerName: string, type: ProviderType): ProviderStatus {
    this.prune(providerName)
    const records = this.records.get(providerName) ?? []

    if (records.length === 0) {
      return {
        name: providerName,
        type,
        avgLatency: 0,
        errorRate: 0,
        totalRequests: 0,
        available: true,
      }
    }

    const totalRequests = records.length
    const avgLatency = Math.round(records.reduce((sum, r) => sum + r.latency, 0) / totalRequests)
    const failedCount = records.filter((r) => !r.success).length
    const errorRate = Math.round((failedCount / totalRequests) * 100)
    const available = errorRate < 50

    return { name: providerName, type, avgLatency, errorRate, totalRequests, available }
  }

  getAllStatuses(providers: { name: string; type: ProviderType }[]): ProviderStatus[] {
    return providers.map((p) => this.getStatus(p.name, p.type))
  }

  private prune(providerName: string): void {
    const records = this.records.get(providerName)
    if (!records) return
    const cutoff = Date.now() - this.windowMs
    this.records.set(providerName, records.filter((r) => r.timestamp >= cutoff))
  }
}
