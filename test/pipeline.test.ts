/**
 * P1.11 管线端到端测试：起 mock 上游（node:http，模拟三协议，含 SSE），
 * 通过 Hono app.fetch 发真实请求走完整管线（inbound → IR → outbound → fetch → stream 适配器）。
 *
 * 覆盖：
 * - 同协议非流式透传 / default_true 流式注入 + SSE 往返；
 * - 跨协议非流式双向（anthropic↔openai）+ 跨协议流式（anthropic 客户端 ← openai SSE 上游）；
 * - 适配器路由（映射 / max_tokens 覆盖 / stream 透传 / models 列表）；
 * - 认证（proxyKey）/ 错误路径（404/400）；
 * - usage 统计与 capture 抓包落点；
 * - router 单元（RouteDecision / streamPolicy / thinking 归一）。
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config/store.ts';
import type { Config } from '../src/config/types.ts';
import { CaptureBuffer } from '../src/proxy/capture-store.ts';
import {
  adapterStreamToPolicy,
  resolveAdapterRoute,
  resolveStreamPolicy,
  routeModel,
  toReasoningSpec,
} from '../src/proxy/router.ts';
import { createProxyRoutes } from '../src/proxy/routes.ts';
import { UsageStore } from '../src/status/usage-store.ts';

// --- mock 上游 ---

interface RecordedRequest {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

const recorded: RecordedRequest[] = [];

/** mock OpenAI Chat 非流式响应（prompt_tokens 含 3 缓存，计费输入 = 7）。 */
const CHAT_JSON = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-target',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    prompt_tokens_details: { cached_tokens: 3 },
  },
};

/** mock Anthropic 非流式响应（input_tokens 即计费部分）。 */
const ANTHROPIC_JSON = {
  id: 'msg_mock',
  type: 'message',
  role: 'assistant',
  model: 'claude-target',
  content: [{ type: 'text', text: 'Hi from Claude' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
};

const sse = (event: string | null, data: unknown): string =>
  `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

/** 写 OpenAI Chat SSE（含 usage-only chunk + [DONE]）。 */
const writeChatSse = (res: ServerResponse): void => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (
    delta: unknown,
    finishReason: string | null,
    extra: Record<string, unknown> = {},
  ): string =>
    sse(null, {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'gpt-target',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra,
    });
  res.write(chunk({ role: 'assistant', content: '' }, null));
  res.write(chunk({ content: 'Hello' }, null));
  res.write(chunk({ content: '!' }, null));
  res.write(chunk({}, 'stop'));
  res.write(
    sse(null, {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'gpt-target',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
  );
  res.write(sse(null, '[DONE]'));
  res.end();
};

/** 写 Anthropic SSE（text 块 + message_delta usage）。 */
const writeAnthropicSse = (res: ServerResponse): void => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-target',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }),
  );
  res.write(
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
  );
  res.write(
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hi from Claude' },
    }),
  );
  res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
  res.write(
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 3 },
    }),
  );
  res.write(sse('message_stop', { type: 'message_stop' }));
  res.end();
};

let upstream: Server;
let upstreamUrl: string;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf-8');
    });
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      recorded.push({ path: req.url ?? '', headers: req.headers, body });
      const isStream = body.stream === true;
      if (req.url === '/v1/chat/completions') {
        if (isStream) writeChatSse(res);
        else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(CHAT_JSON));
        }
      } else if (req.url === '/v1/messages') {
        if (isStream) writeAnthropicSse(res);
        else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(ANTHROPIC_JSON));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const addr = upstream.address() as AddressInfo;
  upstreamUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  recorded.length = 0;
});

// --- 测试 app 装配 ---

const buildConfig = (extra: Partial<Config> = {}): Config => ({
  providers: [
    {
      name: 'mock-openai',
      type: 'openai',
      apiKey: 'sk-mock',
      apiBase: upstreamUrl,
      models: [{ id: 'gpt-target' }, { id: 'gpt-thinky', thinking: { reasoning_effort: 'high' } }],
    },
    {
      name: 'mock-anthropic',
      type: 'anthropic',
      apiKey: 'sk-ant-mock',
      apiBase: upstreamUrl,
      models: [{ id: 'claude-target' }],
    },
  ],
  adapters: [
    {
      name: 'mytool',
      type: 'openai',
      max_tokens: 1234,
      models: [{ sourceModelId: 'GPT', provider: 'mock-openai', targetModelId: 'gpt-target' }],
    },
  ],
  ...extra,
});

const buildTestApp = (config: Config): { app: Hono; usage: UsageStore; capture: CaptureBuffer } => {
  const store = ConfigStore.fromMemory(config);
  const usage = new UsageStore();
  const capture = new CaptureBuffer(10);
  const app = new Hono();
  app.route('/', createProxyRoutes({ store, usage, capture }));
  return { app, usage, capture };
};

const post = (
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  Promise.resolve(
    app.fetch(
      new Request(`http://proxy.local${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    ),
  );

const lastUpstream = (): RecordedRequest => {
  const last = recorded.at(-1);
  if (!last) throw new Error('no upstream request recorded');
  return last;
};

// --- 端到端用例 ---

describe('pipeline e2e（mock 上游）', () => {
  it('同协议非流式透传（openai → openai）', async () => {
    const { app } = buildTestApp(buildConfig());
    const res = await post(app, '/v1/chat/completions', {
      model: 'gpt-target',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CHAT_JSON);

    // 上游侧：model 解析为 target，client 显式 stream:false → default_true 不覆盖 → 不注入 stream
    const up = lastUpstream();
    expect(up.path).toBe('/v1/chat/completions');
    expect(up.body.model).toBe('gpt-target');
    expect(up.body.stream).toBeUndefined();
    expect(up.headers.authorization).toBe('Bearer sk-mock');
  });

  it('default_true：client 未传 stream → 注入 true，SSE 往返（openai → openai）', async () => {
    const { app, usage } = buildTestApp(buildConfig());
    const res = await post(app, '/v1/chat/completions', {
      model: 'gpt-target',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(lastUpstream().body.stream).toBe(true);

    const text = await res.text();
    expect(text).toContain('data:');
    expect(text).toContain('"Hello"');
    expect(text).toContain('"!"');
    expect(text).toContain('[DONE]');

    // usage 落库（流式 usage-only chunk：output 2）
    const today = usage.getToday();
    expect(today.request_count).toBe(1);
    expect(today.output_tokens).toBe(2);
    expect(today.input_tokens).toBe(10);
  });

  it('跨协议非流式（anthropic 客户端 → openai 上游）', async () => {
    const { app } = buildTestApp(buildConfig());
    const res = await post(app, '/v1/messages', {
      model: 'gpt-target',
      max_tokens: 100,
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(lastUpstream().path).toBe('/v1/chat/completions');

    const json = (await res.json()) as Record<string, unknown>;
    const content = json.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: 'text', text: 'Hello!' });
    expect(json.stop_reason).toBe('end_turn');
    // usage 口径：计费输入 = prompt 10 − 缓存 3 = 7
    expect(json.usage).toMatchObject({
      input_tokens: 7,
      output_tokens: 2,
      cache_read_input_tokens: 3,
    });
  });

  it('跨协议流式（anthropic 客户端 ← openai SSE 上游）', async () => {
    const { app } = buildTestApp(buildConfig());
    const res = await post(app, '/v1/messages', {
      model: 'gpt-target',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_start');
    // 基线不变量：text 块固定 index 1（thinking 0 / text 1 / tool_use 2+）
    expect(text).toContain('"index":1');
    expect(text).toContain('"text_delta"');
    expect(text).toContain('"Hello"');
    expect(text).toContain('event: message_delta');
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain('event: message_stop');
    // 不变量：content_block_stop 先于 message_delta
    expect(text.indexOf('content_block_stop')).toBeLessThan(text.indexOf('event: message_delta'));
  });

  it('跨协议非流式（openai 客户端 → anthropic 上游）', async () => {
    const { app } = buildTestApp(buildConfig());
    const res = await post(app, '/v1/chat/completions', {
      model: 'claude-target',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);

    // 上游侧：anthropic 端点 + x-api-key + anthropic-version
    const up = lastUpstream();
    expect(up.path).toBe('/v1/messages');
    expect(up.headers['x-api-key']).toBe('sk-ant-mock');
    expect(up.headers['anthropic-version']).toBe('2023-06-01');

    const json = (await res.json()) as Record<string, unknown>;
    const choices = json.choices as Array<Record<string, unknown>>;
    const message = choices[0]?.message as Record<string, unknown>;
    expect(message.content).toBe('Hi from Claude');
    expect(json.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 3 });
  });

  it('路由级 thinking 配置注入上游（reasoning_effort → openai 上游）', async () => {
    const { app } = buildTestApp(buildConfig());
    const res = await post(app, '/v1/chat/completions', {
      model: 'gpt-thinky',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(lastUpstream().body.reasoning_effort).toBe('high');
  });

  it('适配器路由：映射 + max_tokens 覆盖 + 透传', async () => {
    const { app } = buildTestApp(buildConfig());
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CHAT_JSON);

    const up = lastUpstream();
    expect(up.body.model).toBe('gpt-target');
    expect(up.body.max_tokens).toBe(1234);
    // adapter 未配 stream → passthrough：client false → 不注入
    expect(up.body.stream).toBeUndefined();
  });

  it('适配器 stream 透传：client stream:true 原样转发', async () => {
    const { app } = buildTestApp(buildConfig());
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(lastUpstream().body.stream).toBe(true);
    expect(await res.text()).toContain('[DONE]');
  });

  it('适配器 models 列表', async () => {
    const { app } = buildTestApp(buildConfig());
    const res = await app.fetch(new Request('http://proxy.local/mytool/v1/models'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      object: string;
      data: Array<{ id: string; owned_by: string }>;
    };
    expect(json.object).toBe('list');
    expect(json.data[0]).toMatchObject({ id: 'GPT', owned_by: 'mytool' });
  });

  it('认证：config.proxyKey 生效（401 / x-api-key / Bearer）', async () => {
    const { app } = buildTestApp(buildConfig({ proxyKey: 'sk-secret' }));
    const body = {
      model: 'gpt-target',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    };

    expect((await post(app, '/v1/chat/completions', body)).status).toBe(401);
    expect(
      (await post(app, '/v1/chat/completions', body, { 'x-api-key': 'sk-secret' })).status,
    ).toBe(200);
    expect(
      (await post(app, '/v1/chat/completions', body, { Authorization: 'Bearer sk-secret' })).status,
    ).toBe(200);
    expect(
      (await post(app, '/v1/chat/completions', body, { Authorization: 'Bearer wrong' })).status,
    ).toBe(401);
  });

  it('错误路径：404 模型 / 404 适配器 / 404 映射 / 400 JSON / 400 缺 model', async () => {
    const { app } = buildTestApp(buildConfig());

    const notFound = await post(app, '/v1/chat/completions', {
      model: 'no-such',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(notFound.status).toBe(404);

    const noAdapter = await post(app, '/ghost/v1/chat/completions', {
      model: 'GPT',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(noAdapter.status).toBe(404);

    const noMapping = await post(app, '/mytool/v1/chat/completions', {
      model: 'OTHER',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(noMapping.status).toBe(404);

    const badJson = await post(app, '/v1/chat/completions', '{oops');
    expect(badJson.status).toBe(400);

    const noModel = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(noModel.status).toBe(400);
    expect(await noModel.json()).toMatchObject({
      error: { message: expect.stringContaining('model') },
    });
  });

  it('上游错误响应归一为 502 + 上游 message', async () => {
    const { app } = buildTestApp(buildConfig());
    const res = await post(app, '/v1/chat/completions', {
      model: 'gpt-target',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    // mock 上游对 /v1/chat/completions 之外的路径返回 404；此处强制触发：请求未知端点协议
    expect(res.status).toBe(200); // chat 端点存在，正常流式
    await res.text();

    // 用一个指向 mock 不存在路径的 provider 触发 502
    const badConfig = buildConfig();
    badConfig.providers.push({
      name: 'bad',
      type: 'openai-responses',
      apiKey: 'sk-x',
      apiBase: upstreamUrl,
      models: [{ id: 'resp-model' }],
    });
    const { app: app2 } = buildTestApp(badConfig);
    const res2 = await post(app2, '/v1/responses', {
      model: 'resp-model',
      input: 'hi',
      stream: false,
    });
    expect(res2.status).toBe(502);
    expect(await res2.json()).toMatchObject({
      error: { message: expect.stringContaining('上游 API 错误') },
    });
  });

  it('capture：启用后记录请求/响应对', async () => {
    const { app, capture } = buildTestApp(buildConfig());
    capture.setEnabled(true);
    const res = await post(app, '/v1/messages', {
      model: 'gpt-target',
      max_tokens: 100,
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    await res.text();

    const pairs = capture.list();
    expect(pairs).toHaveLength(1);
    const pair = pairs.at(0);
    if (!pair) throw new Error('capture pair missing');
    expect(pair.inboundType).toBe('anthropic');
    expect(pair.meta).toMatchObject({
      upstreamProvider: 'mock-openai',
      upstreamModel: 'gpt-target',
    });
    expect(pair.requestIn).toContain('"gpt-target"');
    expect(pair.requestOut).toContain('"model":"gpt-target"');
    expect(pair.responseIn).toContain('chatcmpl-mock');
    expect(pair.responseOut).toContain('Hello!');
  });
});

// --- router 单元 ---

describe('router（RouteDecision 解析）', () => {
  const store = (): ConfigStore => ConfigStore.fromMemory(buildConfig());

  it('resolveStreamPolicy 全组合', () => {
    expect(resolveStreamPolicy('default_true', undefined)).toBe(true);
    expect(resolveStreamPolicy('default_true', true)).toBe(true);
    expect(resolveStreamPolicy('default_true', false)).toBe(false);
    expect(resolveStreamPolicy('passthrough', undefined)).toBe(false);
    expect(resolveStreamPolicy('passthrough', true)).toBe(true);
    expect(resolveStreamPolicy('passthrough', false)).toBe(false);
    expect(resolveStreamPolicy('force_true', false)).toBe(true);
    expect(resolveStreamPolicy('force_false', true)).toBe(false);
  });

  it('adapterStreamToPolicy：undefined→passthrough / true→default_true / false→force_false', () => {
    expect(adapterStreamToPolicy(undefined)).toBe('passthrough');
    expect(adapterStreamToPolicy(true)).toBe('default_true');
    expect(adapterStreamToPolicy(false)).toBe('force_false');
  });

  it('toReasoningSpec：budget / effort / type 归一（source=route）', () => {
    expect(toReasoningSpec(undefined)).toEqual({ source: 'route' });
    expect(toReasoningSpec({ budget_tokens: 4096 })).toMatchObject({
      enabled: true,
      budgetTokens: 4096,
      source: 'route',
    });
    expect(toReasoningSpec({ reasoning_effort: 'high' })).toMatchObject({
      enabled: true,
      effort: 'high',
    });
    expect(toReasoningSpec({ type: 'disabled' })).toMatchObject({
      enabled: false,
      type: 'disabled',
    });
  });

  it('routeModel：声明顺序首个命中 + RouteDecision 字段', () => {
    const config = buildConfig();
    // 同名模型在两个 provider：首个（mock-openai）命中
    config.providers[1]?.models.push({ id: 'gpt-target' });
    const s = ConfigStore.fromMemory(config);
    const decision = routeModel(s, 'gpt-target');
    expect(decision.providerId).toBe('mock-openai');
    expect(decision.providerProtocol).toBe('openai');
    expect(decision.resolvedModel).toBe('gpt-target');
    expect(decision.apiBase).toBe(upstreamUrl);
    expect(decision.credentialHandle).toBe('sk-mock');
    expect(decision.streamPolicy).toBe('default_true');
    expect(decision.thinking).toEqual({ source: 'route' });
  });

  it('routeModel：未命中抛错', () => {
    expect(() => routeModel(store(), 'no-such')).toThrow(/未找到模型/);
  });

  it('resolveAdapterRoute：映射 thinking 覆盖模型 thinking', () => {
    const config = buildConfig();
    const adapter = config.adapters?.at(0);
    if (!adapter) throw new Error('test setup: adapter missing');
    adapter.models = [
      {
        sourceModelId: 'GPT',
        provider: 'mock-openai',
        targetModelId: 'gpt-target',
        thinking: { reasoning_effort: 'low' },
      },
    ];
    const s = ConfigStore.fromMemory(config);
    const { route, inboundType } = resolveAdapterRoute(s, 'mytool', 'GPT');
    expect(route.resolvedModel).toBe('gpt-target');
    expect(route.thinking).toMatchObject({ effort: 'low', source: 'route' });
    expect(route.maxTokensOverride).toBe(1234);
    expect(route.streamPolicy).toBe('passthrough');
    expect(inboundType).toBe('openai');
  });

  it('resolveAdapterRoute：错误码（ADAPTER_NOT_FOUND / MODEL_MAPPING_NOT_FOUND）', () => {
    const s = store();
    expect(() => resolveAdapterRoute(s, 'ghost', 'GPT')).toThrow(/未找到/);
    expect(() => resolveAdapterRoute(s, 'mytool', 'OTHER')).toThrow(/未找到模型映射/);
  });
});
