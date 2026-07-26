import { describe, it } from 'node:test'
import assert from 'node:assert'
import { modelSupportsImage, processVisionFallback } from '../../src/proxy/vision.js'
import { VisionCache } from '../../src/proxy/vision-cache.js'
import { ConfigStore } from '../../src/config/store.js'
import type { RouterResult } from '../../src/proxy/types.js'

/** 测试用 cache：内存模式 + 小容量 + 临时文件路径 */
function makeTestCache(maxEntries = 100): VisionCache {
  const cache = new VisionCache({ filePath: `/tmp/test-vision-cache-${Math.random().toString(36).slice(2)}.json`, maxEntries })
  return cache
}

const baseRoute: RouterResult = {
  providerName: 'deepseek',
  providerType: 'openai',
  apiKey: 'sk-test',
  apiBase: 'https://api.deepseek.com',
  modelId: 'deepseek-chat',
}

describe('proxy/vision', () => {
  describe('modelSupportsImage', () => {
    it('input 含 image 时返回 true', () => {
      assert.strictEqual(modelSupportsImage({ ...baseRoute, input: ['text', 'image'] }), true)
    })

    it('input 不含 image 时返回 false', () => {
      assert.strictEqual(modelSupportsImage({ ...baseRoute, input: ['text'] }), false)
    })

    it('input 未配置时返回 false（向后兼容，视为仅文本）', () => {
      assert.strictEqual(modelSupportsImage(baseRoute), false)
    })
  })

  describe('processVisionFallback 触发条件', () => {
    // 这些测试验证触发逻辑，不真正发起识图请求（无 fetch mock）

    function makeStore(vision?: { provider: string; model: string; prompt?: string }, providerInput?: string[]): InstanceType<typeof ConfigStore> {
      const config = {
        providers: [
          {
            name: 'deepseek',
            type: 'openai' as const,
            apiKey: 'sk-test',
            apiBase: 'https://api.deepseek.com',
            models: [{ id: 'deepseek-chat', input: providerInput }],
          },
          {
            name: 'openai',
            type: 'openai' as const,
            apiKey: 'sk-test',
            apiBase: 'https://api.openai.com',
            models: [{ id: 'gpt-4o', input: ['text', 'image'] }],
          },
        ],
        vision,
      }
      // 直接构造 ConfigStore，绕过文件加载
      return new ConfigStore('/tmp/test-config.yaml', config as never)
    }

    it('未配置 vision 时不触发（返回 false）', async () => {
      const store = makeStore(undefined, ['text'])
      const cache = makeTestCache()
      const route: RouterResult = { ...baseRoute, input: ['text'] }
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }],
      }
      const result = await processVisionFallback(body, 'openai', route, store, cache)
      assert.strictEqual(result, false)
    })

    it('目标模型已支持图片时不触发（返回 false）', async () => {
      const store = makeStore({ provider: 'openai', model: 'gpt-4o' }, ['text', 'image'])
      const cache = makeTestCache()
      const route: RouterResult = { ...baseRoute, input: ['text', 'image'] }
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }],
      }
      const result = await processVisionFallback(body, 'openai', route, store, cache)
      assert.strictEqual(result, false)
    })

    it('请求中无图片时不触发（返回 false）', async () => {
      const store = makeStore({ provider: 'openai', model: 'gpt-4o' }, ['text'])
      const cache = makeTestCache()
      const route: RouterResult = { ...baseRoute, input: ['text'] }
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: '纯文本消息' }],
      }
      const result = await processVisionFallback(body, 'openai', route, store, cache)
      assert.strictEqual(result, false)
    })
  })

  describe('图片块扫描覆盖三种协议', () => {
    // 验证 scanImages 能识别三种协议的图片块——通过 processVisionFallback
    // 在未配置识图模型路由时会抛错，借此确认扫描到了图片

    function makeStoreWithUnroutableVision(): InstanceType<typeof ConfigStore> {
      // vision 指向不存在的 provider，routeModelInProvider 会抛错
      // 如果扫描到了图片，processVisionFallback 会尝试识图并抛出错误
      const config = {
        providers: [
          {
            name: 'deepseek',
            type: 'openai' as const,
            apiKey: 'sk-test',
            apiBase: 'https://api.deepseek.com',
            models: [{ id: 'deepseek-chat', input: ['text'] }],
          },
        ],
        vision: { provider: 'nonexistent-provider', model: 'gpt-4o' },
      }
      return new ConfigStore('/tmp/test-config.yaml', config as never)
    }

    const route: RouterResult = { ...baseRoute, input: ['text'] }

    it('识别 OpenAI Chat image_url 块', async () => {
      const store = makeStoreWithUnroutableVision()
      const cache = makeTestCache()
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: [
          { type: 'text', text: '这是什么' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ] }],
      }
      await assert.rejects(
        () => processVisionFallback(body, 'openai', route, store, cache),
        /Provider "nonexistent-provider" 不存在/,
      )
    })

    it('识别 Anthropic image 块（base64）', async () => {
      const store = makeStoreWithUnroutableVision()
      const cache = makeTestCache()
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: [
          { type: 'text', text: '这是什么' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        ] }],
      }
      await assert.rejects(
        () => processVisionFallback(body, 'anthropic', route, store, cache),
        /Provider "nonexistent-provider" 不存在/,
      )
    })

    it('识别 Anthropic image 块（url）', async () => {
      const store = makeStoreWithUnroutableVision()
      const cache = makeTestCache()
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } },
        ] }],
      }
      await assert.rejects(
        () => processVisionFallback(body, 'anthropic', route, store, cache),
        /Provider "nonexistent-provider" 不存在/,
      )
    })

    it('识别 OpenAI Responses input_image 块', async () => {
      const store = makeStoreWithUnroutableVision()
      const cache = makeTestCache()
      const body = {
        model: 'deepseek-chat',
        input: [
          { type: 'message', role: 'user', content: [
            { type: 'input_text', text: '这是什么' },
            { type: 'input_image', image_url: 'data:image/png;base64,abc' },
          ] },
        ],
      }
      await assert.rejects(
        () => processVisionFallback(body, 'openai-responses', route, store, cache),
        /Provider "nonexistent-provider" 不存在/,
      )
    })

    it('content 为纯字符串时不触发（无图片块）', async () => {
      const store = makeStoreWithUnroutableVision()
      const cache = makeTestCache()
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: '这是纯文本' }],
      }
      const result = await processVisionFallback(body, 'openai', route, store, cache)
      assert.strictEqual(result, false)
    })
  })

  describe('图片块替换为 <image_description>（fetch mock）', () => {

    function makeStore(): InstanceType<typeof ConfigStore> {
      const config = {
        providers: [
          {
            name: 'deepseek',
            type: 'openai' as const,
            apiKey: 'sk-test',
            apiBase: 'https://api.deepseek.com',
            models: [{ id: 'deepseek-chat', input: ['text'] }],
          },
          {
            name: 'openai',
            type: 'openai' as const,
            apiKey: 'sk-test',
            apiBase: 'https://api.openai.com',
            models: [{ id: 'gpt-4o', input: ['text', 'image'] }],
          },
        ],
        vision: { provider: 'openai', model: 'gpt-4o', prompt: '描述图片' },
      }
      return new ConfigStore('/tmp/test-config.yaml', config as never)
    }

    // fetch mock：拦截识图请求，返回固定描述
    function mockFetch(description: string) {
      const original = global.fetch
      global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const bodyStr = init?.body as string
        const parsed = JSON.parse(bodyStr)
        // 模拟 OpenAI Chat 响应格式
        if (parsed.messages?.[0]?.content?.some((c: Record<string, unknown>) => c.type === 'image_url')) {
          return new Response(JSON.stringify({
            choices: [{ message: { content: description } }],
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response('{}', { status: 200 })
      }) as typeof global.fetch
      return () => { global.fetch = original }
    }

    const route: RouterResult = { ...baseRoute, input: ['text'] }

    it('单张图片被替换为 <image_description> 文本块', async () => {
      const restore = mockFetch('图中是一个红色按钮')
      try {
        const store = makeStore()
        const cache = makeTestCache()
        const body = {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: [
            { type: 'text', text: '这是什么' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
          ] }],
        }
        const result = await processVisionFallback(body, 'openai', route, store, cache)
        assert.strictEqual(result, true)

        const content = body.messages[0].content as Array<Record<string, unknown>>
        // 图片块被替换为文本块
        assert.strictEqual(content.length, 2)
        const descBlock = content.find((c) => (c.text as string)?.includes('<image_description>'))
        assert.ok(descBlock, '应包含 image_description 文本块')
        assert.match(descBlock!.text as string, /<image_description>\n图中是一个红色按钮\n<\/image_description>/)
        // 文本块保留
        assert.ok(content.some((c) => c.text === '这是什么'))
      } finally {
        restore()
      }
    })

    it('同一条消息多张图片各自独立识图', async () => {
      let visionCallCount = 0
      const originalFetch = global.fetch
      global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const bodyStr = init?.body as string
        const parsed = JSON.parse(bodyStr)
        if (parsed.messages?.[0]?.content?.some((c: Record<string, unknown>) => c.type === 'image_url')) {
          visionCallCount++
          // 每次 call 只有 1 张图（不再合并）
          const imageBlocks = parsed.messages[0].content.filter((c: Record<string, unknown>) => c.type === 'image_url')
          assert.strictEqual(imageBlocks.length, 1, '每张图独立请求，每次只含 1 张图片')
          return new Response(JSON.stringify({
            choices: [{ message: { content: `描述${visionCallCount}` } }],
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response('{}', { status: 200 })
      }) as typeof global.fetch
      try {
        const store = makeStore()
        const cache = makeTestCache()
        const body = {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: [
            { type: 'text', text: '这两张图分别是什么' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,aaa' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,bbb' } },
          ] }],
        }
        await processVisionFallback(body, 'openai', route, store, cache)
        assert.strictEqual(visionCallCount, 2, '2 张图应分别调 2 次识图')
        // 替换后：文本块 + 2 个独立描述块
        const content = body.messages[0].content as Array<Record<string, unknown>>
        const descCount = content.filter((c) => (c.text as string)?.includes('<image_description>')).length
        assert.strictEqual(descCount, 2, '每张图应有独立的 <image_description> 块')
        // 两个 cache 条目都已写入
        const stats = cache.getStats()
        assert.strictEqual(stats.size, 2, 'cache 应有 2 条记录')
      } finally {
        global.fetch = originalFetch
      }
    })

    it('缓存命中时不再调用识图模型', async () => {
      let visionCallCount = 0
      const originalFetch = global.fetch
      global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const bodyStr = init?.body as string
        const parsed = JSON.parse(bodyStr)
        if (parsed.messages?.[0]?.content?.some((c: Record<string, unknown>) => c.type === 'image_url')) {
          visionCallCount++
          return new Response(JSON.stringify({
            choices: [{ message: { content: '已识图结果' } }],
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response('{}', { status: 200 })
      }) as typeof global.fetch
      try {
        const store = makeStore()
        const cache = makeTestCache()
        const body = {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
          ] }],
        }
        // 第一次：未命中，走模型
        await processVisionFallback(body, 'openai', route, store, cache)
        assert.strictEqual(visionCallCount, 1)
        // 第二次：同图应命中
        const body2 = {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
          ] }],
        }
        await processVisionFallback(body2, 'openai', route, store, cache)
        assert.strictEqual(visionCallCount, 1, '第二次相同图应命中缓存，不调用模型')
        const stats = cache.getStats()
        assert.strictEqual(stats.hits, 1)
        assert.strictEqual(stats.misses, 1)
      } finally {
        global.fetch = originalFetch
      }
    })

    it('部分命中：已缓存的图跳过识图', async () => {
      let visionCallCount = 0
      const originalFetch = global.fetch
      global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const bodyStr = init?.body as string
        const parsed = JSON.parse(bodyStr)
        if (parsed.messages?.[0]?.content?.some((c: Record<string, unknown>) => c.type === 'image_url')) {
          visionCallCount++
          return new Response(JSON.stringify({
            choices: [{ message: { content: 'bbb描述' } }],
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response('{}', { status: 200 })
      }) as typeof global.fetch
      try {
        const store = makeStore()
        const cache = makeTestCache()
        // 预热：识别 aaa
        await processVisionFallback({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,aaa' } },
          ] }],
        }, 'openai', route, store, cache)
        assert.strictEqual(visionCallCount, 1)
        // 第二次：aaa 命中，bbb 未命中
        await processVisionFallback({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,aaa' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,bbb' } },
          ] }],
        }, 'openai', route, store, cache)
        assert.strictEqual(visionCallCount, 2, '应只对 bbb 调用一次识图')
        const stats = cache.getStats()
        assert.strictEqual(stats.hits, 1, 'aaa 命中一次')
        assert.strictEqual(stats.misses, 2, 'aaa(预热) + bbb 各 miss 一次')
        assert.strictEqual(stats.size, 2)
      } finally {
        global.fetch = originalFetch
      }
    })

    it('tool_result 嵌套图片（Anthropic 协议）被正确识别并替换', async () => {
      let visionCallCount = 0
      const originalFetch = global.fetch
      global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const bodyStr = init?.body as string
        const parsed = JSON.parse(bodyStr)
        if (parsed.messages?.[0]?.content?.some((c: Record<string, unknown>) => c.type === 'image_url')) {
          visionCallCount++
          return new Response(JSON.stringify({
            choices: [{ message: { content: '这是一张猫的图片' } }],
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response('{}', { status: 200 })
      }) as typeof global.fetch
      try {
        const store = makeStore()
        const cache = makeTestCache()
        // Anthropic 协议：tool_result 块嵌套在 user 消息的 content 中
        const body = {
          model: 'deepseek-chat',
          messages: [
            { role: 'user', content: '描述我的图片' },
            { role: 'assistant', content: [{ type: 'text', text: '请上传' }] },
            { role: 'user', content: [
              { type: 'tool_result', tool_use_id: 'call_xxx', content: [
                { type: 'text', text: 'Read image file [image/png]' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
              ], is_error: false },
            ] },
          ],
        }
        const result = await processVisionFallback(body, 'anthropic', route, store, cache)
        assert.strictEqual(result, true, '应执行外挂识图')

        // 验证 tool_result 嵌套中的图片已被替换为 <image_description>
        const msg = body.messages[2] as Record<string, unknown>
        const content = msg.content as Array<Record<string, unknown>>
        assert.strictEqual(content.length, 1, 'tool_result 块本身应该保留')
        const toolBlock = content[0]
        assert.strictEqual(toolBlock.type, 'tool_result')
        assert.strictEqual(toolBlock.tool_use_id, 'call_xxx')
        // tool_result.content 中应该只剩 text 和 image_description
        const nestedContent = toolBlock.content as Array<Record<string, unknown>>
        assert.strictEqual(nestedContent.length, 2, 'tool_result 嵌套应有 2 个块')
        assert.ok(nestedContent.some((c) => (c.text as string) === 'Read image file [image/png]'), '文本块保留')
        assert.ok(nestedContent.some((c) => (c.text as string)?.includes('<image_description>')), '图片被替换为 image_description')
        // 无残留 image 块
        assert.strictEqual(nestedContent.filter((c) => c.type === 'image').length, 0, 'tool_result 嵌套中无残留图片')

        assert.strictEqual(visionCallCount, 1)
        assert.strictEqual(cache.getStats().size, 1)
      } finally {
        global.fetch = originalFetch
      }
    })

    it('多条消息的图片分别识图', async () => {
      let visionCallCount = 0
      const originalFetch = global.fetch
      global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const bodyStr = init?.body as string
        const parsed = JSON.parse(bodyStr)
        if (parsed.messages?.[0]?.content?.some((c: Record<string, unknown>) => c.type === 'image_url')) {
          visionCallCount++
          return new Response(JSON.stringify({
            choices: [{ message: { content: `描述${visionCallCount}` } }],
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response('{}', { status: 200 })
      }) as typeof global.fetch
      try {
        const store = makeStore()
        const cache = makeTestCache()
        const body = {
          model: 'deepseek-chat',
          messages: [
            { role: 'user', content: [
              { type: 'text', text: '第一张' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,aaa' } },
            ] },
            { role: 'user', content: [
              { type: 'text', text: '第二张' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,bbb' } },
            ] },
          ],
        }
        await processVisionFallback(body, 'openai', route, store, cache)
        assert.strictEqual(visionCallCount, 2, '两条消息应分别识图')
      } finally {
        global.fetch = originalFetch
      }
    })

    it('识图模型返回错误时抛出异常', async () => {
      const originalFetch = global.fetch
      global.fetch = (async () => new Response('{"error":{"message":"rate limit"}}', { status: 429 })) as typeof global.fetch
      try {
        const store = makeStore()
        const cache = makeTestCache()
        const body = {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
          ] }],
        }
        await assert.rejects(
          () => processVisionFallback(body, 'openai', route, store, cache),
          /识图模型错误: rate limit/,
        )
      } finally {
        global.fetch = originalFetch
      }
    })

    it('多消息多图：所有图片各自独立识别并替换，无残留图片块', async () => {
      let visionCallCount = 0
      const originalFetch = global.fetch
      global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const bodyStr = init?.body as string
        const parsed = JSON.parse(bodyStr)
        if (parsed.messages?.[0]?.content?.some((c: Record<string, unknown>) => c.type === 'image_url')) {
          visionCallCount++
          return new Response(JSON.stringify({
            choices: [{ message: { content: `描述${visionCallCount}` } }],
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response('{}', { status: 200 })
      }) as typeof global.fetch
      try {
        const store = makeStore()
        const cache = makeTestCache(100)
        // 混合：system + user(text) + assistant + user(text+image) + user(double image)
        const body = {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: '你是一个助手' },
            { role: 'user', content: '你好' },
            { role: 'assistant', content: [{ type: 'text', text: '你好，有什么可以帮助？' }] },
            { role: 'user', content: [
              { type: 'text', text: '这是什么' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,cat' } },
            ] },
            { role: 'user', content: [
              { type: 'image_url', image_url: { url: 'data:image/png;base64,dog' } },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,tree' } },
            ] },
          ],
        }
        const result = await processVisionFallback(body, 'openai', route, store, cache)
        assert.strictEqual(result, true, '应执行外挂识图')

        // 验证所有消息中无残留图片块
        for (let i = 0; i < body.messages.length; i++) {
          const msg = body.messages[i] as Record<string, unknown>
          const content = msg.content
          if (!Array.isArray(content)) continue
          for (const block of content) {
            const b = block as Record<string, unknown>
            if (b.type === 'image_url' || b.type === 'image' || b.type === 'input_image') {
              assert.fail(`messages[${i}] 中仍存在残留图片块: ${JSON.stringify(b).slice(0, 100)}`)
            }
          }
        }

        assert.strictEqual(visionCallCount, 3, '3 张图各 1 次识图')
        assert.strictEqual(cache.getStats().size, 3)
      } finally {
        global.fetch = originalFetch
      }
    })
  })
})
