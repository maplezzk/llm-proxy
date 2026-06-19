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
import { sanitizeApiBase } from '../lib/http-utils.js'

/** 默认识图提示词 */
const DEFAULT_VISION_PROMPT = '请详细描述这张图片的内容，包括其中的文字、物体、场景、颜色等关键信息。'

/** 提取到的图片统一表示（data URI 或 URL） */
interface ExtractedImage {
  /** data URI (data:image/png;base64,...) 或 https URL */
  url: string
}

/** 需要被识图的消息定位信息：消息索引 + 该消息中图片块索引数组 */
interface MessageWithImages {
  messageIndex: number
  /** 图片块在 content 数组中的索引（仅当 content 是数组时） */
  blockIndices: number[]
  /** 从各图片块提取出的图片数据 */
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
    const role = (msg as Record<string, unknown>).role
    // Responses API 没有 role，用 type 区分；只有 user 消息和 function_call_output 承载图片
    const content = (msg as Record<string, unknown>).content
    if (typeof content !== 'string' && Array.isArray(content)) {
      const images: ExtractedImage[] = []
      const blockIndices: number[] = []
      content.forEach((block, blockIndex) => {
        const img = extractImageFromBlock(block as Record<string, unknown>, inboundType)
        if (img) {
          images.push(img)
          blockIndices.push(blockIndex)
        }
      })
      if (images.length > 0) {
        result.push({ messageIndex, blockIndices, images })
      }
    }
    // 忽略 role 判断（Responses 的 input[] 可能混入非 message 类型）
    void role
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
 * 调用识图模型，将一组图片转换为文字描述。
 * 走代理自身路由（routeModel），构造 OpenAI Chat 格式请求，复用 transformInboundRequest 做协议转换。
 */
async function describeImages(
  store: ConfigStore,
  visionProvider: string,
  visionModel: string,
  prompt: string,
  images: ExtractedImage[],
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
          ...images.map((img) => ({ type: 'image_url', image_url: { url: img.url } })),
        ],
      },
    ],
  }

  const upstream = await transformInboundRequest('openai', visionRoute, visionBody, logger)

  logger?.log('request', `调用识图模型: ${visionRoute.providerName}/${visionRoute.modelId}`, {
    imageCount: images.length,
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
 * 将一条消息中的图片块原地替换为 <image_description> 文本块。
 * 同一条消息的多张图片合并成一次识图请求，结果合并为一个描述块。
 */
function replaceImagesWithDescription(
  content: unknown[],
  message: MessageWithImages,
  description: string
): void {
  // 将描述文本块替换第一个图片块的位置，其余图片块置为 null（稍后过滤）
  const firstBlockIndex = message.blockIndices[0]
  content[firstBlockIndex] = {
    type: 'text',
    text: `<image_description>\n${description}\n</image_description>`,
  }
  // 其余图片块标记为 null，后续过滤掉
  for (let i = 1; i < message.blockIndices.length; i++) {
    content[message.blockIndices[i]] = null
  }
  // 移除 null 条目
  // 注意：不能直接修改数组长度，用 splice 逆序删除
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i] === null) {
      content.splice(i, 1)
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

  logger?.log('request', `外挂识图触发: 模型 ${route.modelId} 不支持图片，请求含 ${messagesWithImages.reduce((a, m) => a + m.images.length, 0)} 张图片`, {
    targetModel: route.modelId,
    visionModel: config.vision.model,
    messagesWithImages: messagesWithImages.length,
  }, 'info')

  // 逐条消息处理（同一条消息的多张图片合并为一次识图请求）
  for (const msg of messagesWithImages) {
    const description = await describeImages(store, config.vision.provider, config.vision.model, prompt, msg.images, logger)

    const content = (messages[msg.messageIndex] as Record<string, unknown>).content
    if (Array.isArray(content)) {
      replaceImagesWithDescription(content as unknown[], msg, description)
    }
  }

  logger?.log('request', `外挂识图完成，已将图片描述注入 ${messagesWithImages.length} 条消息`, {
    visionModel: config.vision.model,
  }, 'info')

  return true
}
