import { describe, it } from 'node:test'
import assert from 'node:assert'
import { modelSupportsImage, processVisionFallback } from '../../src/proxy/vision.js'
import { ConfigStore } from '../../src/config/store.js'
import type { RouterResult } from '../../src/proxy/types.js'

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
      const route: RouterResult = { ...baseRoute, input: ['text'] }
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }],
      }
      const result = await processVisionFallback(body, 'openai', route, store)
      assert.strictEqual(result, false)
    })

    it('目标模型已支持图片时不触发（返回 false）', async () => {
      const store = makeStore({ provider: 'openai', model: 'gpt-4o' }, ['text', 'image'])
      const route: RouterResult = { ...baseRoute, input: ['text', 'image'] }
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }],
      }
      const result = await processVisionFallback(body, 'openai', route, store)
      assert.strictEqual(result, false)
    })

    it('请求中无图片时不触发（返回 false）', async () => {
      const store = makeStore({ provider: 'openai', model: 'gpt-4o' }, ['text'])
      const route: RouterResult = { ...baseRoute, input: ['text'] }
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: '纯文本消息' }],
      }
      const result = await processVisionFallback(body, 'openai', route, store)
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
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: [
          { type: 'text', text: '这是什么' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ] }],
      }
      await assert.rejects(
        () => processVisionFallback(body, 'openai', route, store),
        /Provider "nonexistent-provider" 不存在/,
      )
    })

    it('识别 Anthropic image 块（base64）', async () => {
      const store = makeStoreWithUnroutableVision()
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: [
          { type: 'text', text: '这是什么' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        ] }],
      }
      await assert.rejects(
        () => processVisionFallback(body, 'anthropic', route, store),
        /Provider "nonexistent-provider" 不存在/,
      )
    })

    it('识别 Anthropic image 块（url）', async () => {
      const store = makeStoreWithUnroutableVision()
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } },
        ] }],
      }
      await assert.rejects(
        () => processVisionFallback(body, 'anthropic', route, store),
        /Provider "nonexistent-provider" 不存在/,
      )
    })

    it('识别 OpenAI Responses input_image 块', async () => {
      const store = makeStoreWithUnroutableVision()
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
        () => processVisionFallback(body, 'openai-responses', route, store),
        /Provider "nonexistent-provider" 不存在/,
      )
    })

    it('content 为纯字符串时不触发（无图片块）', async () => {
      const store = makeStoreWithUnroutableVision()
      const body = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: '这是纯文本' }],
      }
      const result = await processVisionFallback(body, 'openai', route, store)
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
        const body = {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: [
            { type: 'text', text: '这是什么' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
          ] }],
        }
        const result = await processVisionFallback(body, 'openai', route, store)
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

    it('同一条消息多张图片合并为一次识图请求', async () => {
      let visionCallCount = 0
      const restore = mockFetch('两张图片的合并描述')
      const originalFetch = global.fetch
      global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const bodyStr = init?.body as string
        const parsed = JSON.parse(bodyStr)
        if (parsed.messages?.[0]?.content?.some((c: Record<string, unknown>) => c.type === 'image_url')) {
          visionCallCount++
          // 验证合并：一次请求含 2 张图片
          const imageBlocks = parsed.messages[0].content.filter((c: Record<string, unknown>) => c.type === 'image_url')
          assert.strictEqual(imageBlocks.length, 2, '应合并为一次含 2 张图片的请求')
          return new Response(JSON.stringify({
            choices: [{ message: { content: '两张图片的合并描述' } }],
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response('{}', { status: 200 })
      }) as typeof global.fetch
      void restore
      try {
        const store = makeStore()
        const body = {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: [
            { type: 'text', text: '这两张图分别是什么' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,aaa' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,bbb' } },
          ] }],
        }
        await processVisionFallback(body, 'openai', route, store)
        assert.strictEqual(visionCallCount, 1, '多张图片应合并为 1 次识图请求')
        // 替换后只剩文本块 + 描述块（原 2 个图片块合并为 1 个描述块）
        const content = body.messages[0].content as Array<Record<string, unknown>>
        const descCount = content.filter((c) => (c.text as string)?.includes('<image_description>')).length
        assert.strictEqual(descCount, 1)
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
        await processVisionFallback(body, 'openai', route, store)
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
        const body = {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
          ] }],
        }
        await assert.rejects(
          () => processVisionFallback(body, 'openai', route, store),
          /识图模型错误: rate limit/,
        )
      } finally {
        global.fetch = originalFetch
      }
    })
  })
})
