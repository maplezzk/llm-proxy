import type { IncomingMessage } from 'node:http'

export function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        req.destroy()
        reject(new Error('请求体超过大小限制'))
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
