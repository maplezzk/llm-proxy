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
import type { Config, ModelChannelRef, OverrideRule } from '../src/config/types.ts';
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

// --- U5 覆写引擎端到端（pipeline 级，用 mocked fetch 证明覆写到达出站 body/headers） ---

describe('pipeline e2e（U5 覆写引擎）', () => {
  const configWithOverrides = (overrides: OverrideRule[] | undefined): Config => ({
    providers: [
      {
        name: 'mock-openai',
        type: 'openai',
        apiKey: 'sk-mock',
        apiBase: upstreamUrl,
        models: [{ id: 'gpt-target' }],
      },
    ],
    adapters: [
      {
        name: 'mytool',
        type: 'openai',
        models: [
          {
            sourceModelId: 'GPT',
            provider: 'mock-openai',
            targetModelId: 'gpt-target',
            ...(overrides ? { overrides } : {}),
          },
        ],
      },
    ],
  });

  it('覆写 body set：reasoning_effort high 到达出站 body', async () => {
    const { app } = buildTestApp(
      configWithOverrides([
        {
          scope: 'adapter-alias',
          when: '{{model}} == "GPT"',
          body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }],
        },
      ]),
    );
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(lastUpstream().body.reasoning_effort).toBe('high');
  });

  it('覆写 header set/delete：修改出站请求头', async () => {
    const { app } = buildTestApp(
      configWithOverrides([
        {
          scope: 'adapter-alias',
          headers: [
            { op: 'set', name: 'X-Channel', value: 'kiro' },
            { op: 'set', name: 'X-Internal', value: 'secret' },
          ],
        },
      ]),
    );
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const up = lastUpstream();
    expect(up.headers['x-channel']).toBe('kiro');
    expect(up.headers['x-internal']).toBe('secret');
  });

  it('保护字段 model 被拒：出站 model 仍为 gpt-target', async () => {
    const { app } = buildTestApp(
      configWithOverrides([
        {
          scope: 'adapter-alias',
          body: [{ op: 'set', path: 'model', value: 'hacked' }],
        },
      ]),
    );
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(lastUpstream().body.model).toBe('gpt-target');
  });

  it('false 条件 no-op：覆写不被应用', async () => {
    const { app } = buildTestApp(
      configWithOverrides([
        {
          scope: 'adapter-alias',
          when: '{{model}} == "other"',
          body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }],
        },
      ]),
    );
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(lastUpstream().body.reasoning_effort).toBeUndefined();
  });

  it('直连路由未携带 overrides：不应用任何覆写（正常上游请求）', async () => {
    const { app } = buildTestApp(buildConfig());
    const res = await post(app, '/v1/chat/completions', {
      model: 'gpt-target',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    // 直连不应注入 reasoning_effort（除非 model.thinking 配置）
    expect(lastUpstream().body.reasoning_effort).toBeUndefined();
  });

  it('capture 反映覆写后的 body（覆写在 capture.updateRequest 之前）', async () => {
    const { app, capture } = buildTestApp(
      configWithOverrides([
        {
          scope: 'adapter-alias',
          body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }],
        },
      ]),
    );
    capture.setEnabled(true);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    await res.text();
    const pairs = capture.list();
    expect(pairs).toHaveLength(1);
    const pair = pairs.at(0);
    if (!pair) throw new Error('capture pair missing');
    expect(pair.requestOut).toContain('"reasoning_effort":"high"');
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
    const { routes, inboundType } = resolveAdapterRoute(s, 'mytool', 'GPT');
    expect(routes).toHaveLength(1);
    const route = routes[0];
    if (!route) throw new Error('test setup: expected at least one route');
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

// ===================== U6: 渠道钳制 + failover 循环 =====================
//
// 设计依据：docs/plans/2026-07-28-001-feat-axonhub-parity-orchestration-plan.md §U6。
// 覆盖场景：
// - AE2：priority-1 渠道返回 retryable 错误 → 网关重试 priority-2 渠道，client 收到成功
// - F3：max_tokens 超渠道 maxOutputTokens → 钳到上限
// - 钉死 hard-fail：钉死渠道 503 → surface 错误，无 fallback
// - 钉死 fallback：钉死渠道 503 + on_failure=fallback → 降级到模型其他渠道
// - 非 retryable 400 → 不重试，立即 surface
// - 所有渠道失败 → ROUTE_ALL_FAILED
// - mid-stream 失败 → surface 错误（不重试、不重发）
// - usage 基数：failover 后仍只记一次

import type { AdapterConfig, ModelGroup } from '../src/config/types.ts';

/** mock fetch 单次响应配置。 */
type MockResponse = {
  status: number;
  /** 非流式 JSON 响应（status=2xx 时使用）。 */
  jsonBody?: unknown;
  /** 非流式原始 body（优先级高于 jsonBody）。 */
  rawBody?: string;
  /** 流式响应：分块字符串。emit 后行为由 streamError 决定。 */
  streamChunks?: string[];
  /** 流式：在 emit 所有 streamChunks 后调用 controller.error() 而非 close。 */
  isStreamError?: boolean;
  /** 网络错误：fetch 直接抛。 */
  throw?: Error;
  /** 响应延迟（ms）。 */
  delayMs?: number;
  /**
   * B5：headers 已返回（status 照给），但读 body 时抛网络错误
   * （模拟上游返回 headers 后连接重置/超时/流错误）。response.text() 会 reject。
   */
  bodyReadError?: Error;
};

const buildMockedFetch = (
  responses: MockResponse[],
): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: unknown }> } => {
  const calls: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = typeof url === 'string' ? url : (url as URL).toString();
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    let bodyParsed: unknown;
    try {
      bodyParsed = JSON.parse(bodyStr);
    } catch {
      bodyParsed = bodyStr;
    }
    calls.push({ url: u, body: bodyParsed });
    const r = responses[i] ?? responses[responses.length - 1];
    if (!r) throw new Error('no mock response configured');
    if (responses[i] === undefined) {
      // 溢出回退：与已有测试语义一致（最后一次响应被复用）。i 仍要 +1。
    }
    i++;
    if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
    if (r.throw) throw r.throw;
    if (r.bodyReadError) {
      // B5：返回合法 headers（200），但 body 是一个读取时 error 的流 → response.text() 拒绝。
      const readError = r.bodyReadError;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(readError);
        },
      });
      return new Response(stream, {
        status: r.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (r.streamChunks) {
      const encoder = new TextEncoder();
      const chunks = r.streamChunks;
      let idx = 0;
      // pull-based：每次拉取交付一个 chunk，全部交付后的下一次拉取才 error/close。
      // 这保证 chunks 被读取者真实消费后才出错——正确模拟「mid-stream 失败」；
      // （start 里同步 enqueue+error 会被 ReadableStream 的 error 状态抢占，
      //   导致排队 chunks 永远不被读取、首读即抛错，退化成「首字节前失败」。B6 门闩依赖该区别。）
      // 零字节流（chunks=[]）：首次拉取即 error → 首字节前失败。
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (idx < chunks.length) {
            controller.enqueue(encoder.encode(chunks[idx] ?? ''));
            idx += 1;
          } else if (r.isStreamError) {
            controller.error(new Error('mid-stream failure'));
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        status: r.status,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    const body = r.rawBody ?? (r.jsonBody !== undefined ? JSON.stringify(r.jsonBody) : '');
    return new Response(body, {
      status: r.status,
      headers: { 'Content-Type': r.status >= 400 ? 'application/json' : 'application/json' },
    });
  };
  return { fetchImpl, calls };
};

const buildTestAppWithFetch = (
  config: Config,
  fetchImpl: typeof fetch,
): { app: Hono; usage: UsageStore; capture: CaptureBuffer; store: ConfigStore } => {
  const store = ConfigStore.fromMemory(config);
  const usage = new UsageStore();
  const capture = new CaptureBuffer(10);
  const app = new Hono();
  app.route('/', createProxyRoutes({ store, usage, capture, fetchImpl }));
  return { app, usage, capture, store };
};

/** 构造一个含 kiro + cc 双 provider + model group + adapter 的 U6 测试配置。 */
const buildFailoverConfig = (opts: {
  onFailure?: 'hard_fail' | 'fallback';
  pinnedChannel?: `${string}/${string}` | undefined;
  channels?: ModelChannelRef[];
  modelGroupId?: string;
  adapterName?: string;
  adapterType?: 'openai' | 'anthropic' | 'openai-responses';
  adapterMaxTokens?: number;
}): Config => {
  const groupId = opts.modelGroupId ?? 'opus';
  const adapterName = opts.adapterName ?? 'mytool';
  const adapterType = opts.adapterType ?? 'openai';
  const channels: ModelChannelRef[] = opts.channels ?? [
    { provider: 'kiro', model: 'kiro-fast', priority: 1 },
    { provider: 'cc', model: 'cc-fast', priority: 2 },
  ];
  const adapterConfig: AdapterConfig = {
    name: adapterName,
    type: adapterType,
    ...(opts.adapterMaxTokens !== undefined ? { max_tokens: opts.adapterMaxTokens } : {}),
    ...(opts.onFailure ? { onFailure: opts.onFailure } : {}),
    models: [
      {
        sourceModelId: 'GPT',
        model: groupId,
        ...(opts.pinnedChannel ? { channel: opts.pinnedChannel } : {}),
      },
    ],
  };
  const modelGroups: ModelGroup[] = [
    {
      id: groupId,
      channels,
    },
  ];
  return {
    providers: [
      {
        name: 'kiro',
        type: 'openai',
        apiKey: 'sk-kiro',
        apiBase: 'http://kiro.local',
        models: [{ id: 'kiro-fast' }],
      },
      {
        name: 'cc',
        type: 'anthropic',
        apiKey: 'sk-cc',
        apiBase: 'http://cc.local',
        models: [{ id: 'cc-fast' }],
      },
    ],
    modelGroups,
    adapters: [adapterConfig],
  };
};

describe('pipeline e2e（U6 渠道钳制 + failover 循环）', () => {
  it('AE2：priority-1 渠道 503 → failover 到 priority-2，client 收到成功', async () => {
    const config = buildFailoverConfig({});
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 503, jsonBody: { error: { message: 'kiro unavailable' } } },
      {
        // cc 是 anthropic 渠道，返回 anthropic wire 格式；pipeline 会跨协议转为 openai。
        status: 200,
        jsonBody: {
          id: 'msg_cc',
          type: 'message',
          role: 'assistant',
          model: 'cc-fast',
          content: [{ type: 'text', text: 'fallback success' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    // client 只看到 cc 的成功响应，看不到切换
    const json = (await res.json()) as Record<string, unknown>;
    const choices = json.choices as Array<Record<string, unknown>>;
    const message = choices[0]?.message as Record<string, unknown>;
    expect(message.content).toBe('fallback success');
    // 两次上游调用：先 kiro(503) 再 cc(200)
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('kiro.local');
    expect(calls[1]?.url).toContain('cc.local');
  });

  it('F3：max_tokens 超渠道 maxOutputTokens → 钳到上限', async () => {
    const config = buildFailoverConfig({
      channels: [{ provider: 'kiro', model: 'kiro-fast', priority: 1, maxOutputTokens: 100 }],
    });
    const { fetchImpl, calls } = buildMockedFetch([
      {
        status: 200,
        jsonBody: {
          id: 'chatcmpl-kiro',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: 'kiro-fast',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        },
      },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      max_tokens: 5000, // 超渠道上限
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    // 上游收到的 max_tokens 被钳到 100
    expect(calls[0]?.body).toMatchObject({ max_tokens: 100 });
  });

  it('钉死 hard-fail：钉死渠道 503 → surface 502，无 fallback（默认）', async () => {
    const config = buildFailoverConfig({
      onFailure: 'hard_fail',
      pinnedChannel: 'kiro/kiro-fast',
    });
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 503, jsonBody: { error: { message: 'kiro down' } } },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    // 钉死 hard-fail：503 surface 错误，1 次上游调用
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('kiro.local');
  });

  it('钉死 fallback：钉死渠道 503 + on_failure=fallback → 降级到模型其他渠道', async () => {
    const config = buildFailoverConfig({
      onFailure: 'fallback',
      pinnedChannel: 'kiro/kiro-fast',
    });
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 503, jsonBody: { error: { message: 'kiro down' } } },
      {
        // cc 是 anthropic 渠道，返回 anthropic wire 格式
        status: 200,
        jsonBody: {
          id: 'msg_cc',
          type: 'message',
          role: 'assistant',
          model: 'cc-fast',
          content: [{ type: 'text', text: 'fallback ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const choices = json.choices as Array<Record<string, unknown>>;
    const message = choices[0]?.message as Record<string, unknown>;
    expect(message.content).toBe('fallback ok');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('kiro.local');
    expect(calls[1]?.url).toContain('cc.local');
  });

  it('非 retryable 400 → 不重试，立即 surface 错误', async () => {
    const config = buildFailoverConfig({});
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 400, jsonBody: { error: { message: 'bad request' } } },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(502);
    // 400 是 fatal，1 次上游调用，不重试
    expect(calls).toHaveLength(1);
  });

  it('所有渠道 retryable 失败 → ROUTE_ALL_FAILED（502）', async () => {
    const config = buildFailoverConfig({});
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 503, jsonBody: { error: { message: 'kiro down' } } },
      { status: 502, jsonBody: { error: { message: 'cc bad gateway' } } },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(502);
    // 两个渠道都试了
    expect(calls).toHaveLength(2);
  });

  it('429 限流是 retryable：触发 failover', async () => {
    const config = buildFailoverConfig({});
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 429, jsonBody: { error: { message: 'rate limited' } } },
      {
        status: 200,
        jsonBody: {
          id: 'chatcmpl-cc',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: 'cc-fast',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('网络错误（fetch 抛）是 retryable：触发 failover', async () => {
    const config = buildFailoverConfig({});
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 0, throw: new Error('ECONNREFUSED') },
      {
        status: 200,
        jsonBody: {
          id: 'chatcmpl-cc',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: 'cc-fast',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('mid-stream 失败（首字节后）→ surface 错误，不重试', async () => {
    // 流式场景：kiro 返回首个 SSE 事件后 stream error；failover 决策已完成
    // （response.status=200 已知，尚未向 client pipe 出错字节），按 KTD/U6 规则
    // 不重试。client 看到流被截断。
    const config = buildFailoverConfig({});
    const chatChunk = (delta: unknown, finishReason: string | null): string =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-kiro',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'kiro-fast',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
    const { fetchImpl, calls } = buildMockedFetch([
      {
        status: 200,
        streamChunks: [
          chatChunk({ role: 'assistant', content: '' }, null),
          chatChunk({ content: 'partial' }, null),
        ],
        isStreamError: true, // emit 完后 controller.error()
      },
      // 即便配置了第二个响应，也不应被调用（已发首字节，failover 决策结束）
      {
        status: 200,
        jsonBody: { id: 'unused', object: 'chat.completion', choices: [], usage: {} },
      },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    // 读取 body 触发流消费 + mid-stream error
    const text = await res.text();
    expect(text).toContain('data:'); // 至少发出了首字节
    // 关键断言：mid-stream 失败不重试
    expect(calls).toHaveLength(1);
  });

  it('usage 基数：failover 后仍只记一次（compat）', async () => {
    const config = buildFailoverConfig({});
    const { fetchImpl } = buildMockedFetch([
      { status: 503, jsonBody: { error: { message: 'kiro down' } } },
      {
        // cc 是 anthropic 渠道，返回 anthropic wire 格式
        status: 200,
        jsonBody: {
          id: 'msg_cc',
          type: 'message',
          role: 'assistant',
          model: 'cc-fast',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      },
    ]);
    const { app, usage } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    // failover 后 usage 仍只记一次（来自最终成功的 cc）
    const today = usage.getToday();
    expect(today.request_count).toBe(1);
    expect(today.input_tokens).toBe(7);
    expect(today.output_tokens).toBe(3);
  });

  it('resolveAdapterRoute 钉死 + fallback：候选含模型组其他渠道', () => {
    const config = buildFailoverConfig({
      onFailure: 'fallback',
      pinnedChannel: 'kiro/kiro-fast',
    });
    const store = ConfigStore.fromMemory(config);
    const { routes, isPinnedChannel, onFailure } = resolveAdapterRoute(store, 'mytool', 'GPT');
    // 钉死 + fallback：routes 含钉死渠道 + 模型组其他渠道
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(isPinnedChannel).toBe(true);
    expect(onFailure).toBe('fallback');
    // pinned 在 routes[0]（priority=1 < 2）
    expect(routes[0]?.providerId).toBe('kiro');
    expect(routes[1]?.providerId).toBe('cc');
  });

  it('resolveAdapterRoute 钉死 + hard_fail：候选仅钉死渠道', () => {
    const config = buildFailoverConfig({
      onFailure: 'hard_fail',
      pinnedChannel: 'kiro/kiro-fast',
    });
    const store = ConfigStore.fromMemory(config);
    const { routes, isPinnedChannel } = resolveAdapterRoute(store, 'mytool', 'GPT');
    expect(routes).toHaveLength(1);
    expect(isPinnedChannel).toBe(true);
  });

  it('直连（无 adapter）无 failover：503 surface 502，1 次上游调用', async () => {
    // 直连场景：route.alternatives 为空，候选队列仅 [route]，
    // 503 retryable 但没有备选 → 502
    const config: Config = {
      providers: [
        {
          name: 'kiro',
          type: 'openai',
          apiKey: 'sk-kiro',
          apiBase: 'http://kiro.local',
          models: [{ id: 'kiro-fast' }],
        },
      ],
    };
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 503, jsonBody: { error: { message: 'kiro down' } } },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/v1/chat/completions', {
      model: 'kiro-fast',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
  });

  it('钉死 hard-fail + fatal 错误：surface 502（不重试）', async () => {
    const config = buildFailoverConfig({
      onFailure: 'hard_fail',
      pinnedChannel: 'kiro/kiro-fast',
    });
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 400, jsonBody: { error: { message: 'bad request' } } },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
  });
});

// ===================== Batch B 管线侧回归（B4-B9） =====================
// 设计依据：fix-B-router-pipeline 任务。
// B4：pinned 不被 selectRoute priority 重排改掉（routes.ts adapterHandler）。
// B5：响应体读取失败（首字节前）进 failover。
// B6：零字节流式失败（首字节前）进 failover。
// B7：client abort 不误判 retryable，终止 failover（499）。
// B8：流式异常/abort 不写部分 usage（仅正常完成记）。
// B9：client thinking disabled 时后置 reasoning override 不写入 wire（reasoningDisabled）。

describe('pipeline e2e（B4: pinned 不被 priority 重排）', () => {
  it('pinned priority 高于 fallback（数值大）时，selected 仍是 pinned（首调 pinned 渠道）', async () => {
    // R-P1-3：pinned=cc(priority=10)，fallback=kiro(priority=1)。
    // 修复前 selectRoute 会按 priority 选 kiro；修复后 pinned 直接作 selected。
    const config = buildFailoverConfig({
      onFailure: 'fallback',
      pinnedChannel: 'cc/cc-fast',
      channels: [
        { provider: 'cc', model: 'cc-fast', priority: 10 }, // pinned（priority 高数值）
        { provider: 'kiro', model: 'kiro-fast', priority: 1 }, // fallback（priority 低数值）
      ],
    });
    // cc 是 anthropic 渠道，返回 anthropic wire；pipeline 跨协议转 openai。
    const { fetchImpl, calls } = buildMockedFetch([
      {
        status: 200,
        jsonBody: {
          id: 'msg_cc',
          type: 'message',
          role: 'assistant',
          model: 'cc-fast',
          content: [{ type: 'text', text: 'pinned served' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    // 首调必须是 pinned 渠道（cc），而不是 priority 更优的 kiro。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('cc.local');
    const json = (await res.json()) as Record<string, unknown>;
    const choices = json.choices as Array<Record<string, unknown>>;
    const message = choices[0]?.message as Record<string, unknown>;
    expect(message.content).toBe('pinned served');
  });

  it('pinned 失败 + fallback：pinned 首调失败后才轮到 fallback（顺序不变）', async () => {
    const config = buildFailoverConfig({
      onFailure: 'fallback',
      pinnedChannel: 'cc/cc-fast',
      channels: [
        { provider: 'cc', model: 'cc-fast', priority: 10 },
        { provider: 'kiro', model: 'kiro-fast', priority: 1 },
      ],
    });
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 503, jsonBody: { error: { message: 'cc down' } } }, // pinned 失败
      {
        status: 200,
        jsonBody: {
          id: 'chatcmpl-kiro',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: 'kiro-fast',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'fallback ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    // 顺序：pinned(cc) 先，fallback(kiro) 后。
    expect(calls[0]?.url).toContain('cc.local');
    expect(calls[1]?.url).toContain('kiro.local');
  });
});

describe('pipeline e2e（B5: 响应体读取失败 failover）', () => {
  it('非流式：上游 200 但读 body 抛网络错误 → failover 到下一候选', async () => {
    // R-P1-1：headers 已返回，读 body 时连接重置（首字节前）→ 应可 failover。
    const config = buildFailoverConfig({});
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 200, bodyReadError: new Error('connection reset while reading body') },
      {
        status: 200,
        jsonBody: {
          id: 'msg_cc',
          type: 'message',
          role: 'assistant',
          model: 'cc-fast',
          content: [{ type: 'text', text: 'recovered' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 2 },
        },
      },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const choices = json.choices as Array<Record<string, unknown>>;
    const message = choices[0]?.message as Record<string, unknown>;
    expect(message.content).toBe('recovered');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('kiro.local');
    expect(calls[1]?.url).toContain('cc.local');
  });

  it('非流式：错误响应（503）读 body 抛网络错误 → 仍按 retryable failover', async () => {
    const config = buildFailoverConfig({});
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 503, bodyReadError: new Error('reset during error body') },
      {
        status: 200,
        jsonBody: {
          id: 'msg_cc',
          type: 'message',
          role: 'assistant',
          model: 'cc-fast',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});

describe('pipeline e2e（B6: 零字节流式失败 failover）', () => {
  const chatChunk = (model: string, delta: unknown, finishReason: string | null): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;

  // B6 专用：两个 openai 协议 provider，保证两候选都走 openai-chat 流式解码。
  const buildStreamFailoverConfig = (): Config => ({
    providers: [
      { name: 'p1', type: 'openai', apiKey: 'sk-1', apiBase: 'http://p1.local', models: [{ id: 'm1' }] },
      { name: 'p2', type: 'openai', apiKey: 'sk-2', apiBase: 'http://p2.local', models: [{ id: 'm2' }] },
    ],
    modelGroups: [
      {
        id: 'g',
        channels: [
          { provider: 'p1', model: 'm1', priority: 1 },
          { provider: 'p2', model: 'm2', priority: 2 },
        ],
      },
    ],
    adapters: [
      { name: 'mytool', type: 'openai', models: [{ sourceModelId: 'GPT', model: 'g' }] },
    ],
  });

  it('流式：上游 200 但首字节前流就报错 → failover 到下一候选成功', async () => {
    // R-P1-2：p1 返回 200 后首字节前失败（零字节流）→ client 未收到字节，应可 failover。
    const config = buildStreamFailoverConfig();
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 200, streamChunks: [], isStreamError: true }, // 零字节流失败
      {
        status: 200,
        streamChunks: [
          chatChunk('m2', { role: 'assistant', content: '' }, null),
          chatChunk('m2', { content: 'recovered' }, null),
          chatChunk('m2', {}, 'stop'),
          'data: [DONE]\n\n',
        ],
      },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('recovered');
    // 首字节前失败 → failover：两个候选都调了。
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('p1.local');
    expect(calls[1]?.url).toContain('p2.local');
  });
});

describe('pipeline e2e（B7: client abort 不误判 retryable）', () => {
  it('预 abort 的 signal → 循环首检即返回 499，不发任何上游请求', async () => {
    const config = buildFailoverConfig({});
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 200, jsonBody: { id: 'x', object: 'chat.completion', choices: [], usage: {} } },
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const ac = new AbortController();
    ac.abort(); // 客户端在请求前已断连
    const res = await app.fetch(
      new Request('http://proxy.local/mytool/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'GPT', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
        signal: ac.signal,
      }),
    );
    expect(res.status).toBe(499);
    // 循环首检 signal.aborted → 不发上游请求。
    expect(calls).toHaveLength(0);
  });

  it('候选切换间隙 abort：首候选 retryable 后，第二候选 fetch 抛 AbortError → 499，不再继续', async () => {
    const config = buildFailoverConfig({});
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    const { fetchImpl, calls } = buildMockedFetch([
      { status: 503, jsonBody: { error: { message: 'kiro down' } } }, // 首候选 retryable
      { status: 0, throw: abortErr }, // 第二候选：client 已断连 → AbortError
      // 若误判 retryable，会继续试第三个候选；这里只配两个，验证不会越过 abort。
    ]);
    const { app } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(499);
    // 恰好两次：kiro(503) + cc(AbortError)；abort 后不会继续。
    expect(calls).toHaveLength(2);
  });
});

describe('pipeline e2e（B8: 流式异常/abort 不写部分 usage）', () => {
  // openai chat usage-only chunk → inbound 映射为 message_delta(usage)。
  const usageChunk = `data: ${JSON.stringify({
    id: 'chatcmpl',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'kiro-fast',
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })}\n\n`;
  const contentChunk = `data: ${JSON.stringify({
    id: 'chatcmpl',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'kiro-fast',
    choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
  })}\n\n`;

  it('mid-stream 错误（已收到部分 usage，未 message_stop）→ 不写 usage', async () => {
    const config = buildFailoverConfig({
      channels: [{ provider: 'kiro', model: 'kiro-fast', priority: 1 }],
    });
    const { fetchImpl } = buildMockedFetch([
      {
        status: 200,
        // 首字节成功（contentChunk）→ 提交；随后 usage chunk；然后 mid-stream error（无 message_stop）。
        streamChunks: [contentChunk, usageChunk],
        isStreamError: true,
      },
    ]);
    const { app, usage } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    await res.text(); // 消费流触发异常路径
    // 流未正常完成（无 message_stop）→ 不记部分 usage。
    expect(usage.getToday().request_count).toBe(0);
  });

  it('正常完成（收到 message_stop）→ 照记 usage（回归守护）', async () => {
    const config = buildFailoverConfig({
      channels: [{ provider: 'kiro', model: 'kiro-fast', priority: 1 }],
    });
    const { fetchImpl } = buildMockedFetch([
      {
        status: 200,
        streamChunks: [contentChunk, usageChunk, 'data: [DONE]\n\n'],
      },
    ]);
    const { app, usage } = buildTestAppWithFetch(config, fetchImpl);
    const res = await post(app, '/mytool/v1/chat/completions', {
      model: 'GPT',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    await res.text();
    // 正常完成 → 记一次 usage（input 10 / output 5）。
    const today = usage.getToday();
    expect(today.request_count).toBe(1);
    expect(today.input_tokens).toBe(10);
    expect(today.output_tokens).toBe(5);
  });
});

describe('pipeline e2e（B9: client thinking disabled 拦截 reasoning override）', () => {
  const buildReasoningOverrideConfig = (overrides: OverrideRule[]): Config => ({
    providers: [
      {
        name: 'mock-openai',
        type: 'openai',
        apiKey: 'sk-mock',
        apiBase: upstreamUrl,
        models: [{ id: 'gpt-target' }],
      },
    ],
    adapters: [
      {
        name: 'mytool',
        type: 'anthropic',
        models: [
          {
            sourceModelId: 'GPT',
            provider: 'mock-openai',
            targetModelId: 'gpt-target',
            overrides,
          },
        ],
      },
    ],
  });

  const reasoningOverride: OverrideRule[] = [
    { scope: 'adapter-alias', body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }] },
  ];

  it('client thinking disabled + reasoning override → 出站 body 不含 reasoning_effort', async () => {
    const { app } = buildTestApp(buildReasoningOverrideConfig(reasoningOverride));
    // anthropic 客户端（/v1/messages 路径）显式关闭 thinking → routed.reasoning.enabled=false。
    const res = await post(app, '/mytool/v1/messages', {
      model: 'GPT',
      max_tokens: 100,
      stream: false,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    // R14：reasoningDisabled=true → reasoning_effort override 被拦截。
    expect(lastUpstream().body.reasoning_effort).toBeUndefined();
  });

  it('对照组：client 未关闭 thinking → 同一 override 正常写入 reasoning_effort', async () => {
    const { app } = buildTestApp(buildReasoningOverrideConfig(reasoningOverride));
    const res = await post(app, '/mytool/v1/messages', {
      model: 'GPT',
      max_tokens: 100,
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(lastUpstream().body.reasoning_effort).toBe('high');
  });
});
