/**
 * 外挂多模态识图模块
 *
 * 当路由目标模型不支持图片输入（input 不含 "image"）时，拦截请求中的图片内容块，
 * 调用配置的识图模型（走代理自身路由）将图片转换为文字描述，再用 <image_description>
 * XML 标签替换原图片块，使不支持多模态的模型也能"看懂"图片。
 *
 * 支持三种入站协议的图片块格式：
 *   - Anthropic:  { type: 'image', source: { type: 'base64', media_type, data } | { type: 'url', url } }
 *   - OpenAI Chat: { type: 'image_url', image_url: { url } | url }
 *   - OpenAI Responses: { type: 'input_image', image_url: string | { url } }
 */

import type { ConfigStore } from '../config/store.js'
import type { Logger } from '../log/logger.js'
import type { RouterResult } from './types.js'
import type { InboundType } from './translation.js'
import { routeModelInProvider } from './router.js'
import { transformInboundRequest } from './translation.js'
import { computeImageKey, type VisionCache } from './vision-cache.js'

/** 默认识图提示词 */
const DEFAULT_VISION_PROMPT = '请详细描述这张图片的内容，包括其中的文字、物体、场景、颜色等关键信息。'

/** 提取到的图片统一表示（data URI 或 URL） */
interface ExtractedImage {
  /** data URI (data:image/png;base64,...) 或 https URL */
  url: string
}

/**
 * 图片在消息中的精确定位。
 * 支持两种层级：
 *   顶层块：content[topIndex] 是 { type: 'image_url' } 等图片块
 *   嵌套块（tool_result）：content[topIndex].content[nestedIndex] 是图片块
 */
interface ImageLocation {
  /** content 数组索引（顶层图片块），或 tool_result 块的索引（嵌套图片） */
  topIndex: number
  /** 嵌套图片在 tool_result.content 中的索引；顶层图片为 -1 */
  nestedIndex: number
}

/** 需要被识图的消息定位信息 */
interface MessageWithImages {
  messageIndex: number
  locations: ImageLocation[]
  /** 从各图片块提取出的图片数据，与 locations 一一对应 */
  images: ExtractedImage[]
}

/**
 * 判断路由目标模型是否支持图片输入。
 * 未配置 input 时，保守视为仅支持文本（需要外挂识图）。
 */
export function modelSupportsImage(route: RouterResult): boolean {
  return Array.isArray(route.input) && route.input.includes('image')
}

/**
 * 从入站请求 body 中扫描所有包含图片的 user 消息。
 * 返回的消息定位信息用于后续原地替换图片块。
 */
function scanImages(body: Record<string, unknown>, inboundType: InboundType): MessageWithImages[] {
  const result: MessageWithImages[] = []

  // 不同协议的消息数组字段名
  // Anthropic / OpenAI Chat: body.messages[]
  // OpenAI Responses: body.input[]
  const messagesField = inboundType === 'openai-responses' ? 'input' : 'messages'
  const messages = body[messagesField]
  if (!Array.isArray(messages)) return result

  messages.forEach((msg, messageIndex) => {
    const content = (msg as Record<string, unknown>).content
    if (typeof content !== 'string' && Array.isArray(content)) {
      const images: ExtractedImage[] = []
      const locations: ImageLocation[] = []
      content.forEach((block, blockIndex) => {
        // 1. 直接检测图片块
        const img = extractImageFromBlock(block as Record<string, unknown>, inboundType)
        if (img) {
          images.push(img)
          locations.push({ topIndex: blockIndex, nestedIndex: -1 })
          return
        }
        // 2. 递归检测 tool_result 块中的嵌套图片（Anthropic 协议）
        const b = block as Record<string, unknown>
        if (b.type === 'tool_result' && Array.isArray(b.content)) {
          const nestedContent = b.content as Array<Record<string, unknown>>
          nestedContent.forEach((nestedBlock, nestedIdx) => {
            const nestedImg = extractImageFromBlock(nestedBlock, inboundType)
            if (nestedImg) {
              images.push(nestedImg)
              locations.push({ topIndex: blockIndex, nestedIndex: nestedIdx })
            }
          })
        }
      })
      if (images.length > 0) {
        result.push({ messageIndex, locations, images })
      }
    }
  })

  return result
}

/**
 * 从单个 content block 中提取图片。
 * 返回 data URI 或 URL；若不是图片块则返回 undefined。
 */
function extractImageFromBlock(block: Record<string, unknown>, inboundType: InboundType): ExtractedImage | undefined {
  // Anthropic image 块
  if (block.type === 'image') {
    const source = block.source as Record<string, unknown> | undefined
    if (!source) return undefined
    if (source.type === 'base64') {
      const mediaType = source.media_type as string | undefined
      const data = source.data as string | undefined
      if (mediaType && data) {
        return { url: `data:${mediaType};base64,${data}` }
      }
    }
    if (source.type === 'url') {
      const url = source.url as string | undefined
      if (url) return { url }
    }
    return undefined
  }

  // OpenAI Chat image_url 块
  if (block.type === 'image_url') {
    const imageUrl = block.image_url
    if (typeof imageUrl === 'string') return { url: imageUrl }
    if (imageUrl && typeof imageUrl === 'object') {
      const url = (imageUrl as Record<string, unknown>).url as string | undefined
      if (url) return { url }
    }
    return undefined
  }

  // OpenAI Responses input_image 块
  if (inboundType === 'openai-responses' && block.type === 'input_image') {
    const imageUrl = block.image_url
    if (typeof imageUrl === 'string') return { url: imageUrl }
    if (imageUrl && typeof imageUrl === 'object') {
      const url = (imageUrl as Record<string, unknown>).url as string | undefined
      if (url) return { url }
    }
    return undefined
  }

  return undefined
}

/**
 * 调用识图模型，将单张图片转换为文字描述。
 * 走代理自身路由（routeModel），构造 OpenAI Chat 格式请求，复用 transformInboundRequest 做协议转换。
 */
async function describeImages(
  store: ConfigStore,
  visionProvider: string,
  visionModel: string,
  prompt: string,
  image: ExtractedImage,
  logger?: Logger
): Promise<string> {
  const visionRoute = routeModelInProvider(store, visionProvider, visionModel)

  // 构造识图请求（统一用 OpenAI Chat 格式，transformInboundRequest 会转成识图模型协议）
  const visionBody: Record<string, unknown> = {
    model: visionRoute.modelId,
    stream: false,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: image.url } },
        ],
      },
    ],
  }

  const upstream = await transformInboundRequest('openai', visionRoute, visionBody, logger)

  logger?.log('request', `调用识图模型: ${visionRoute.providerName}/${visionRoute.modelId}`, {
    imageCount: 1,
    model: visionRoute.modelId,
  }, 'debug')

  const response = await fetch(upstream.url, {
    method: 'POST',
    headers: {
      ...upstream.headers,
      'Accept': 'application/json',
    },
    body: JSON.stringify(upstream.body),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    logger?.log('request', `识图模型返回错误: ${response.status}`, {
      status: response.status,
      error: errorBody.slice(0, 500),
    }, 'error')
    let errorMsg = `识图模型返回 HTTP ${response.status}`
    try {
      const parsed = JSON.parse(errorBody)
      const apiMsg = (parsed as { error?: { message?: string } }).error?.message
      if (apiMsg) errorMsg = `识图模型错误: ${apiMsg}`
    } catch {
      // 忽略 JSON 解析失败
    }
    throw new Error(errorMsg)
  }

  const data = await response.json() as Record<string, unknown>
  return extractDescriptionText(data, visionRoute.providerType)
}

/**
 * 从识图模型的响应中提取文字描述。
 * 支持三种协议的响应格式：
 *   - Anthropic: { content: [{ type: 'text', text }] }
 *   - OpenAI Chat: { choices: [{ message: { content } }] }
 *   - OpenAI Responses: { output: [{ content: [{ type: 'output_text', text }] }] }
 */
function extractDescriptionText(data: Record<string, unknown>, providerType: string): string {
  // OpenAI Chat 格式
  if (providerType === 'openai') {
    const choices = data.choices as Array<Record<string, unknown>> | undefined
    const message = choices?.[0]?.message as Record<string, unknown> | undefined
    const content = message?.content
    if (typeof content === 'string') return content.trim()
    // content 也可能是数组
    if (Array.isArray(content)) {
      const text = content
        .map((c) => (c as Record<string, unknown>).text as string | undefined)
        .filter(Boolean)
        .join('')
      if (text) return text.trim()
    }
  }

  // Anthropic 格式
  if (providerType === 'anthropic') {
    const content = data.content as Array<Record<string, unknown>> | undefined
    if (Array.isArray(content)) {
      const text = content
        .filter((c) => c.type === 'text')
        .map((c) => c.text as string)
        .join('')
      if (text) return text.trim()
    }
  }

  // OpenAI Responses 格式
  if (providerType === 'openai-responses') {
    const output = data.output as Array<Record<string, unknown>> | undefined
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item.type === 'message') {
          const content = item.content as Array<Record<string, unknown>> | undefined
          if (Array.isArray(content)) {
            const text = content
              .filter((c) => c.type === 'output_text')
              .map((c) => c.text as string)
              .join('')
            if (text) return text.trim()
          }
        }
      }
    }
  }

  // 兜底：尝试通用字段
  const fallbackText =
    (data.text as string | undefined) ??
    (data.content as string | undefined) ??
    (data.description as string | undefined)
  if (typeof fallbackText === 'string' && fallbackText.trim()) {
    return fallbackText.trim()
  }

  throw new Error('识图模型未返回有效文字描述')
}

/**
 * 将一条消息中的图片块原地替换为多个 <image_description> 文本块（每张图一个）。
 * descriptions 长度必须等于 message.blockIndices.length。
 */
function replaceImagesWithDescription(
  content: unknown[],
  message: MessageWithImages,
  descriptions: string[]
): void {
  if (descriptions.length !== message.locations.length) return

  // 逐张图片替换（从后往前处理避免索引偏移）
  const indices = [...message.locations.keys()].sort((a, b) => b - a)
  for (const idx of indices) {
    const loc = message.locations[idx]
    const desc = descriptions[idx]
    const text = desc || ''
    const descBlock = { type: 'text', text: `<image_description>\n${text}\n</image_description>` }

    if (loc.nestedIndex >= 0) {
      // tool_result 嵌套图片：替换 tool_result.content 中的图文块
      const toolBlock = content[loc.topIndex] as Record<string, unknown> | undefined
      if (!toolBlock || !Array.isArray(toolBlock.content)) continue
      const nestedContent = toolBlock.content as unknown[]
      nestedContent.splice(loc.nestedIndex, 1, descBlock)
    } else {
      // 顶层图片块：直接替换
      content.splice(loc.topIndex, 1, descBlock)
    }
  }

  // 最终清理：删除消息 content 层和 tool_result 嵌套中所有残留的图片块
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i] as Record<string, unknown> | undefined
    if (b && (b.type === 'image' || b.type === 'image_url' || b.type === 'input_image')) {
      content.splice(i, 1)
    }
    if (b && b.type === 'tool_result' && Array.isArray(b.content)) {
      const nc = b.content as unknown[]
      for (let j = nc.length - 1; j >= 0; j--) {
        const nb = nc[j] as Record<string, unknown> | undefined
        if (nb && (nb.type === 'image' || nb.type === 'image_url' || nb.type === 'input_image')) {
          nc.splice(j, 1)
        }
      }
    }
  }
}

/**
 * 对入站请求执行外挂识图处理（原地修改 body）。
 *
 * 触发条件：
 *   1. 配置了 vision
 *   2. 路由目标模型的 input 不含 "image"
 *   3. 请求消息中存在图片块
 *
 * 处理流程：
 *   - 扫描所有包含图片的 user 消息
 *   - 对每条消息，合并其中的图片为一次识图请求
 *   - 用 <image_description> XML 标签替换原图片块
 *
 * 返回值：是否执行了识图替换（用于日志记录）。
 */
export async function processVisionFallback(
  body: Record<string, unknown>,
  inboundType: InboundType,
  route: RouterResult,
  store: ConfigStore,
  cache: VisionCache,
  logger?: Logger
): Promise<boolean> {
  const { config } = store.getConfig()

  // 条件 1：未配置 vision
  if (!config.vision) return false

  // 条件 2：目标模型已支持图片，无需外挂
  if (modelSupportsImage(route)) return false

  const messagesField = inboundType === 'openai-responses' ? 'input' : 'messages'
  const messages = body[messagesField]
  if (!Array.isArray(messages)) return false

  // 扫描包含图片的消息
  const messagesWithImages = scanImages(body, inboundType)
  if (messagesWithImages.length === 0) return false

  const prompt = config.vision.prompt || DEFAULT_VISION_PROMPT
  const totalImages = messagesWithImages.reduce((a, m) => a + m.images.length, 0)

  logger?.log('request', `外挂识图触发: 模型 ${route.modelId} 不支持图片，请求含 ${totalImages} 张图片`, {
    targetModel: route.modelId,
    visionModel: config.vision.model,
    messagesWithImages: messagesWithImages.length,
  }, 'info')

  // 逐张图片独立处理：先查 cache，未命中单独调用识图模型
  for (const msg of messagesWithImages) {
    const descriptions: string[] = new Array(msg.images.length)

    for (let j = 0; j < msg.images.length; j++) {
      const key = computeImageKey(msg.images[j].url)
      const cached = cache.get(key)
      if (cached != null) {
        descriptions[j] = cached
        continue
      }
      // 未命中：调识图模型（单张图片）
      const desc = await describeImages(
        store,
        config.vision.provider,
        config.vision.model,
        prompt,
        msg.images[j],
        logger
      )
      if (desc) {
        descriptions[j] = desc
        cache.set(key, desc)
      }
    }

    // 替换图片块为描述块
    const msgContent = (messages[msg.messageIndex] as Record<string, unknown>).content
    if (Array.isArray(msgContent)) {
      replaceImagesWithDescription(msgContent as unknown[], msg, descriptions)
    } else {
      logger?.log('request', `外挂识图: messages[${msg.messageIndex}] 的 content 不是数组，跳过替换`, {}, 'warn')
    }
  }

  const finalStats = cache.getStats()
  logger?.log('request', `外挂识图完成，已处理 ${messagesWithImages.length} 条消息中的图片`, {
    visionModel: config.vision.model,
    cacheHits: finalStats.hits,
    cacheMisses: finalStats.misses,
    cacheSize: finalStats.size,
  }, 'info')

  return true
}
