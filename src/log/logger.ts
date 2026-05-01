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

const LINE_RE_NEW = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[(REQ|SYS)\] \[(DEBUG|INFO|WARN|ERROR)\] (.+?)(?:  (\{.*\}))?$/
const LINE_RE_OLD = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[(REQ|SYS)\] (.+?)(?:  (\{.*\}))?$/

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

  constructor(maxEntries = 1000, logDir?: string, logLevel: LogLevel = 'info') {
    this.maxEntries = maxEntries
    this.logLevel = logLevel
    if (logDir) {
      this.logDir = join(logDir, 'logs')
      mkdirSync(this.logDir, { recursive: true })
      this.loadFromFiles()
    }
  }

  private loadFromFiles(): void {
    if (!this.logDir || !existsSync(this.logDir)) return

    let files: string[]
    try {
      files = readdirSync(this.logDir)
        .filter((f) => f.startsWith('llm-proxy-') && f.endsWith('.log'))
        .sort()
        .reverse()
    } catch {
      return
    }

    for (const file of files.slice(0, 2)) {
      if (this.entries.length >= this.maxEntries) break
      let content: string
      try {
        content = readFileSync(join(this.logDir, file), 'utf-8')
      } catch {
        continue
      }
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

  getLogs(limit = 100, before?: number, level?: LogLevel, type?: string): LogEntry[] {
    let entries = this.entries
    if (before) {
      entries = entries.filter((e) => e.id < before)
    }
    if (level) {
      entries = entries.filter((e) => e.level === level)
    }
    if (type && type !== 'all') {
      entries = entries.filter((e) => e.type === type)
    }
    return entries.slice(-limit).reverse()
  }

  getStats(): { total: number; requestCount: number; systemCount: number } {
    return {
      total: this.entries.length,
      requestCount: this.entries.filter((e) => e.type === 'request').length,
      systemCount: this.entries.filter((e) => e.type === 'system').length,
    }
  }
}
