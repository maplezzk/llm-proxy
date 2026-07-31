import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ServerContext } from '../server.js'
import { readBody } from '../../lib/http-utils.js'
import { json } from './index.js'

interface HandoffEntry {
  credential: string
  expiresAt: number
}

/** 短期、一次性的浏览器凭据交接码；仅保存在当前服务进程内存中。 */
export class AdminHandoffStore {
  private entries = new Map<string, HandoffEntry>()

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(credential: string): { code: string; expiresIn: number } {
    this.removeExpired()
    const code = randomBytes(32).toString('base64url')
    this.entries.set(this.digest(code), {
      credential,
      expiresAt: this.now() + this.ttlMs,
    })
    return { code, expiresIn: Math.ceil(this.ttlMs / 1000) }
  }

  exchange(code: string, currentCredential: string): string | null {
    this.removeExpired()
    const digest = this.digest(code)
    const entry = this.entries.get(digest)
    if (!entry) return null
    this.entries.delete(digest)

    const issued = Buffer.from(entry.credential)
    const current = Buffer.from(currentCredential)
    if (issued.length !== current.length || !timingSafeEqual(issued, current)) return null
    return currentCredential
  }

  private digest(code: string): string {
    return createHash('sha256').update(code).digest('base64url')
  }

  private removeExpired(): void {
    const now = this.now()
    for (const [digest, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(digest)
    }
  }
}

export function handleCreateAdminHandoff(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
  const { config } = ctx.store.getConfig()
  if (!config.adminKey) {
    res.setHeader('Cache-Control', 'no-store')
    json(res, 409, { success: false, error: 'Management key handoff is not available' })
    return
  }
  const handoff = ctx.adminHandoffs.issue(config.adminKey)
  res.setHeader('Cache-Control', 'no-store')
  json(res, 200, { success: true, data: handoff })
}

export async function handleExchangeAdminHandoff(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 该接口只供同源 Web UI 使用。跨域脚本即使猜到 code 也不能读取响应。
  res.removeHeader('Access-Control-Allow-Origin')
  res.setHeader('Cache-Control', 'no-store')

  let body: { code?: unknown } = {}
  try {
    body = JSON.parse(await readBody(req)) as { code?: unknown }
  } catch {
    // 统一按无效交接码处理，不把 JSON 解析细节暴露给未认证调用方。
  }
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  const { config } = ctx.store.getConfig()
  if (!code || !config.adminKey) {
    json(res, 401, { success: false, error: 'Invalid or expired handoff code' })
    return
  }

  const credential = ctx.adminHandoffs.exchange(code, config.adminKey)
  if (!credential) {
    json(res, 401, { success: false, error: 'Invalid or expired handoff code' })
    return
  }
  json(res, 200, { success: true, data: { key: credential } })
}
