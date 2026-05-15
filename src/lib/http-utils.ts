import type { IncomingMessage } from 'node:http'

export function readBody(req: IncomingMessage, maxBytes = 10_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        req.destroy()
        reject(new Error('BODY_TOO_LARGE'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

export function getDefaultApiBase(type: 'anthropic' | 'openai' | 'openai-responses'): string {
  return type === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com'
}

/**
 * 去除 api_base 末尾多余的 /v1 路径段，避免拼接 URL 时出现重复 /v1。
 * 例如：
 *   'https://api.example.com/v1'   → 'https://api.example.com'
 *   'https://api.example.com/v1/'  → 'https://api.example.com'
 *   'https://api.example.com'      → 'https://api.example.com'（不变）
 *   'https://api.example.com/'     → 'https://api.example.com'（仅去末尾斜杠）
 */
/**
 * 脱敏 URL 中的认证信息。
 */
export function maskUrl(url: string): string {
  return url.replace(/\/\/[^@]+@/, '//***@')
}

/**
 * 脱敏请求头中的敏感字段（Authorization / x-api-key）。
 */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    h[k] = k.toLowerCase() === 'authorization'
      ? v.replace(/Bearer\s+\S+/i, 'Bearer sk-***')
      : k.toLowerCase() === 'x-api-key'
        ? 'sk-***'
        : v
  }
  return h
}

export function sanitizeApiBase(base: string): string {
  // 先去掉末尾的 /v1、/V1（大小写不敏感），同时去掉 v1 后面的斜杠
  // 再统一去掉末尾斜杠
  return base.replace(/\/+v1\/?$/i, '').replace(/\/+$/, '')
}
