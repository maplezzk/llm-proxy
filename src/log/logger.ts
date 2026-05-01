import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface LogEntry {
  id: number
  timestamp: string
  type: 'request' | 'system'
  level: LogLevel
  message: string
  details?: Record<string, unknown>
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function fmtLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`
}

function formatLogLine(entry: LogEntry): string {
  const date = entry.timestamp.slice(0, 23)
  const tag = entry.type === 'request' ? 'REQ' : 'SYS'
  const level = entry.level.toUpperCase()
  let line = `[${date}] [${tag}] [${level}] ${entry.message}`
  if (entry.details && Object.keys(entry.details).length > 0) {
    const detailStr = JSON.stringify(entry.details)
    line += `  ${detailStr}`
  }
  return line + '\n'
}

const LINE_RE_NEW = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[(REQ|SYS)\] \[(DEBUG|INFO|WARN|ERROR)\] (.+?)(?:  (\{.*\}))?$/
const LINE_RE_OLD = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?)\] \[(REQ|SYS)\] (.+?)(?:  (\{.*\}))?$/

function parseLogLine(line: string): LogEntry | null {
  let match = line.match(LINE_RE_NEW)
  if (match) {
    const type: LogEntry['type'] = match[2] === 'REQ' ? 'request' : 'system'
    const level = match[3].toLowerCase() as LogLevel
    const message = match[4]
    let details: Record<string, unknown> | undefined
    if (match[5]) {
      try { details = JSON.parse(match[5]) } catch { /* ignore */ }
    }
    return { id: 0, timestamp: match[1], type, level, message, details }
  }
  match = line.match(LINE_RE_OLD)
  if (match) {
    const type: LogEntry['type'] = match[2] === 'REQ' ? 'request' : 'system'
    const message = match[3]
    let details: Record<string, unknown> | undefined
    if (match[4]) {
      try { details = JSON.parse(match[4]) } catch { /* ignore */ }
    }
    return { id: 0, timestamp: match[1], type, level: 'info', message, details }
  }
  return null
}

export class Logger {
  private entries: LogEntry[] = []
  private nextId = 1
  private maxEntries: number
  private logDir?: string
  private logLevel: LogLevel
  private currentDate = ''
  private currentLogPath = ''

  constructor(maxEntries = 10000, logDir?: string, logLevel: LogLevel = 'info') {
    this.maxEntries = maxEntries
    this.logLevel = logLevel
    if (logDir) {
      this.logDir = join(logDir, 'logs')
      mkdirSync(this.logDir, { recursive: true })
      this.loadFromFiles()
    }
  }

  /** 启动时从文件加载历史日志到内存 */
  private loadFromFiles(): void {
    if (!this.logDir || !existsSync(this.logDir)) return

    const files = this.getLogFiles()
    // 从最新的文件开始读，填满内存缓冲区
    for (const file of files) {
      if (this.entries.length >= this.maxEntries) break
      let content: string
      try {
        content = readFileSync(join(this.logDir, file), 'utf-8')
      } catch {
        continue
      }
      // 从每行解析，从文件末尾（最新）开始加载
      const lines = content.trim().split('\n').filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        if (this.entries.length >= this.maxEntries) break
        const entry = parseLogLine(lines[i])
        if (entry) {
          entry.id = this.nextId++
          this.entries.unshift(entry)
        }
      }
    }
  }

  /** 获取日志文件列表（按日期从新到旧） */
  private getLogFiles(): string[] {
    if (!this.logDir || !existsSync(this.logDir)) return []
    try {
      return readdirSync(this.logDir)
        .filter((f) => f.startsWith('llm-proxy-') && f.endsWith('.log'))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  /** 读取指定日期的日志文件内容 */
  private readFile(date: string): LogEntry[] {
    if (!this.logDir) return []
    const filePath = join(this.logDir, `llm-proxy-${date}.log`)
    if (!existsSync(filePath)) return []
    try {
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      const entries: LogEntry[] = []
      let fileId = this.nextId + 1_000_000
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = parseLogLine(lines[i])
        if (entry) {
          entry.id = fileId++
          entries.push(entry)
        }
      }
      return entries
    } catch {
      return []
    }
  }

  /** 直接从日志文件读取条目，用于弥补内存不足的历史日志 */
  private readFromFiles(limit: number, before?: number, level?: LogLevel, type?: string, date?: string): LogEntry[] {
    if (!this.logDir || !existsSync(this.logDir)) return []

    const files = date ? [`llm-proxy-${date}.log`] : this.getLogFiles()
    const result: LogEntry[] = []
    let fileId = this.nextId + 1_000_000 // 用大 ID 避免与内存 ID 冲突

    // 收集内存已有条目的 key，用于去重
    const memKeys = new Set(this.entries.map(e => `${e.timestamp}|${e.message}|${e.type}`))

    for (const file of files) {
      if (result.length >= limit) break
      try {
        const content = readFileSync(join(this.logDir, file), 'utf-8')
        const lines = content.trim().split('\n').filter(Boolean)
        for (let i = lines.length - 1; i >= 0; i--) {
          if (result.length >= limit) break
          const entry = parseLogLine(lines[i])
          if (!entry) continue

          // 跳过内存已有的
          const key = `${entry.timestamp}|${entry.message}|${entry.type}`
          if (memKeys.has(key)) continue

          // 应用过滤器
          if (level && entry.level !== level) continue
          if (type && type !== 'all' && entry.type !== type) continue
          if (before && before > 0) continue // 文件条目 ID 不可比，跳过 before 过滤

          entry.id = fileId++
          result.push(entry)
        }
      } catch { continue }
    }

    return result
  }

  private getLogPath(): string {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const today = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
    if (today !== this.currentDate) {
      this.currentDate = today
      this.currentLogPath = join(this.logDir!, `llm-proxy-${today}.log`)
    }
    return this.currentLogPath
  }

  log(type: LogEntry['type'], message: string, details?: Record<string, unknown>, level: LogLevel = 'info', curl?: string): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.logLevel]) return

    // Strip curl from details if accidentally included
    const cleanDetails = details ? { ...details } : undefined
    if (cleanDetails) delete (cleanDetails as any).curl

    const entry: LogEntry = {
      id: this.nextId++,
      timestamp: fmtLocal(new Date()),
      type,
      level,
      message,
      details: cleanDetails,
    }
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }
    if (this.logDir) {
      try {
        let line = formatLogLine(entry)
        if (curl) line += `  CURL: ${curl}\n`
        appendFileSync(this.getLogPath(), line, 'utf-8')
      } catch { /* best-effort */ }
    }
  }

  getLevel(): LogLevel {
    return this.logLevel
  }

  setLevel(level: LogLevel): void {
    this.logLevel = level
  }

  getLogs(limit = 100, before?: number, level?: LogLevel, type?: string, date?: string): LogEntry[] {
    // 1. 从内存取
    let result = this.entries

    // 2. 按日期筛
    if (date) {
      result = result.filter(e => e.timestamp.startsWith(date))
    }

    // 3. 按 before 筛
    if (before) {
      result = result.filter(e => e.id < before)
    }

    // 4. 内存不够从文件补
    if (result.length < limit && this.logDir) {
      const more = this.readFromFiles(limit - result.length, before, level, type, date)
      result = [...result, ...more]
    }

    // 5. level/type 过滤器
    if (level) {
      result = result.filter(e => e.level === level)
    }
    if (type && type !== 'all') {
      result = result.filter(e => e.type === type)
    }

    // 6. 按 ID 倒序，取最新 limit 条
    result.sort((a, b) => b.id - a.id)
    return result.slice(0, limit)
  }

  getStats(): { total: number; requestCount: number; systemCount: number } {
    return {
      total: this.entries.length,
      requestCount: this.entries.filter((e) => e.type === 'request').length,
      systemCount: this.entries.filter((e) => e.type === 'system').length,
    }
  }
}