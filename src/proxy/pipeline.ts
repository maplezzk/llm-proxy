/**
 * 代理转发管线（P1.11）：把 canonical IR + 适配器接入 Hono 代理管线，端到端跑通。
 *
 * 流程（设计 §4）：
 *   parseAndAuth → routeModel（RouteDecision，见 router.ts）
 *   → inbound adapter decode（wire → CanonicalRequest）
 *   → normalizeRequest（IR 归一）
 *   → 应用路由决策（resolvedModel / streamPolicy / reasoning 优先级 / maxTokens 规整）
 *   → outbound adapter encode（CanonicalRequest → 上游 wire body）
 *   → forwardRequest（fetch 上游）
 *   → 非流式：同协议透传 / 跨协议 decodeUpstreamResponse + response converter
 *   → 流式：stream inbound（上游 SSE → CanonicalStreamEvent）→ stream outbound（→ 客户端 SSE）
 *   → capture / usage / log。
 *
 * 与 legacy（legacy-src/proxy/pipeline.ts + provider.ts）的行为等价要点见设计 §7.3；
 * 差异点在 P1.11 汇报 gotchas 中逐项说明。
 */
import type { Logger } from 'pino';
import type { ConfigStore } from '../config/store.ts';
import { maskHeaders, maskUrl, sanitizeApiBase } from '../lib/http-utils.ts';
import type { UsageStore } from '../status/usage-store.ts';
import { anthropicInboundAdapter } from './adapters/inbound/anthropic.ts';
import { openaiChatInboundAdapter } from './adapters/inbound/openai-chat.ts';
import { openaiResponsesInboundAdapter } from './adapters/inbound/openai-responses.ts';
import type {
  InboundAdapter,
  OutboundAdapter,
  RouteDecision,
  StreamInboundAdapter,
  StreamOutboundAdapter,
  WireBody,
} from './adapters/index.ts';
import {
  anthropicOutbound,
  openAiChatOutbound,
  openAiResponsesOutbound,
} from './adapters/outbound/index.ts';
import {
  convertAnthropicResponseToOpenAI,
  convertAnthropicResponseToOpenAIResponses,
  convertOpenAIResponseToAnthropic,
  convertOpenAIResponseToOpenAIResponses,
  convertOpenAIResponsesResponseToOpenAI,
  convertOpenAIResponsesToAnthropic,
} from './adapters/response/index.ts';
import type { CaptureBuffer } from './capture-store.ts';
import { normalizeRequest } from './ir/canonicalize.ts';
import type { CanonicalStreamEvent } from './ir/stream-events.ts';
import type {
  CanonicalRequest,
  CanonicalResponse,
  ClientProtocol,
  UsageRecord,
} from './ir/types.ts';
import { applyOverrides } from './override-engine.ts';
import { resolveReasoning } from './reasoning-resolver.ts';
import { decodeUpstreamResponse, extractWireUsage } from './response-decode.ts';
import { hasExplicitThinking, isRetryableUpstreamError, resolveStreamPolicy } from './router.ts';
import { anthropicStreamInboundAdapter } from './stream/inbound/anthropic.ts';
import { openAIChatStreamInboundAdapter } from './stream/inbound/openai-chat.ts';
import { openAIResponsesStreamInboundAdapter } from './stream/inbound/openai-responses.ts';
import { anthropicStreamOutboundAdapter } from './stream/outbound/anthropic.ts';
import { openAIChatStreamOutboundAdapter } from './stream/outbound/openai-chat.ts';
import { openAIResponsesStreamOutboundAdapter } from './stream/outbound/openai-responses.ts';

const ANTHROPIC_DEFAULT_MAX_TOKENS = 16384;

// --- 适配器注册表（按协议索引；基线适配器只读消费） ---

const INBOUND_ADAPTERS: Record<ClientProtocol, InboundAdapter> = {
  anthropic: anthropicInboundAdapter,
  openai: openaiChatInboundAdapter,
  'openai-responses': openaiResponsesInboundAdapter,
};

const OUTBOUND_ADAPTERS: Record<ClientProtocol, OutboundAdapter> = {
  anthropic: anthropicOutbound,
  openai: openAiChatOutbound,
  'openai-responses': openAiResponsesOutbound,
};

const STREAM_INBOUND_ADAPTERS: Record<ClientProtocol, StreamInboundAdapter> = {
  anthropic: anthropicStreamInboundAdapter,
  openai: openAIChatStreamInboundAdapter,
  'openai-responses': openAIResponsesStreamInboundAdapter,
};

const STREAM_OUTBOUND_ADAPTERS: Record<ClientProtocol, StreamOutboundAdapter> = {
  anthropic: anthropicStreamOutboundAdapter,
  openai: openAIChatStreamOutboundAdapter,
  'openai-responses': openAIResponsesStreamOutboundAdapter,
};

/** 上游协议端点路径。 */
const endpointFor = (protocol: ClientProtocol): string =>
  protocol === 'anthropic'
    ? 'messages'
    : protocol === 'openai-responses'
      ? 'responses'
      : 'chat/completions';

/**
 * 凭据解析：YAML 阶段 credentialHandle 即明文 key 本身；
 * P1.16 后改为 vault/secret 引用解析（此处为唯一改造点）。
 */
const resolveCredential = (handle: string): string => handle;

// --- 管线依赖与参数 ---

/** 管线依赖（由 server 装配层注入）。 */
export interface PipelineDeps {
  store: ConfigStore;
  logger?: Logger;
  usage?: UsageStore;
  capture?: CaptureBuffer;
  /** 可注入 fetch（测试用）；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 代理认证 key 回退（config.proxyKey 未设时用，如 env PROXY_KEY）。 */
  fallbackProxyKey?: string;
}

/** 转发参数（routes 层解析后传入）。 */
export interface ForwardParams {
  clientProtocol: ClientProtocol;
  wireBody: WireBody;
  rawBody: string;
  route: RouteDecision;
  /**
   * 备选渠道（failover 候选）。U3 由 selectRoute 注入；U6 实际消费。
   * 直连请求为 undefined（routeModel 一对一，无备选）。
   */
  alternatives?: RouteDecision[];
  /** 适配器名；直连请求为 undefined。 */
  adapterName?: string;
  /** 客户端断连信号（c.req.raw.signal）。 */
  signal?: AbortSignal;
  /**
   * U6 错死别名信息（KTD3）：routes 层由 resolveAdapterRoute 透传。
   * - isPinnedChannel=true 且 onFailure='hard_fail'（默认）：钉死渠道失败不重试，直接 surface；
   * - onFailure='fallback'：钉死渠道失败可重试到 routes 中其他候选；
   * - isPinnedChannel=false（自动别名）：始终走完整 failover。
   * 直连请求无需传递（仍由 route.alternatives 驱动 failover）。
   */
  isPinnedChannel?: boolean;
  onFailure?: 'hard_fail' | 'fallback';
}

/** JSON 错误响应（与 legacy `{ error: { message } }` 形态一致）。 */
export const jsonError = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

// --- parseAndAuth：请求体解析 + 代理认证 + model 提取 ---

/** parseAndAuth 成功产物。 */
export interface ParsedRequest {
  wireBody: WireBody;
  rawBody: string;
  modelName: string;
}

/**
 * 解析请求体、校验代理 Key、提取 model。
 * 成功返回 ParsedRequest；失败直接返回应写回客户端的 Response（400/401）。
 */
export const parseAndAuth = (
  deps: PipelineDeps,
  rawBody: string,
  headers: Headers,
): ParsedRequest | Response => {
  // 1. JSON 解析
  let wireBody: WireBody;
  try {
    wireBody = JSON.parse(rawBody) as WireBody;
  } catch {
    return jsonError(400, '请求体不是有效 JSON');
  }
  if (typeof wireBody !== 'object' || wireBody === null || Array.isArray(wireBody)) {
    return jsonError(400, '请求体必须是 JSON 对象');
  }

  // 2. 代理认证（config.proxyKey 优先，回退注入的 env key；均未设则不鉴权）
  const { config } = deps.store.getConfig();
  const expectedKey = config.proxyKey ?? deps.fallbackProxyKey;
  if (expectedKey) {
    const auth = headers.get('authorization') ?? headers.get('x-api-key') ?? '';
    const provided = auth.replace(/^Bearer\s+/i, '').trim();
    if (provided !== expectedKey) {
      return jsonError(401, '代理 API Key 无效');
    }
  }

  // 3. 提取 model
  const modelName = wireBody.model;
  if (typeof modelName !== 'string' || modelName.length === 0) {
    return jsonError(400, '请求缺少 model 字段');
  }

  return { wireBody, rawBody, modelName };
};

// --- 路由决策应用 ---

/**
 * 把 RouteDecision 应用到 canonical 请求（不可变，返回新对象）：
 * - resolvedModel：路由解析结果（不覆盖 logicalModel）；
 * - generation.stream：按 streamPolicy + 客户端原值解析（设计 §7.3 不变量 10）；
 * - generation.maxTokens：0/负数 → 不传（legacy sanitizeMaxTokens）；渠道 maxOutputTokens
 *   声明上限时向下钳制（U6 / R10 / KTD4）；
 * - reasoning：由 resolver 统一完成 client / route 字段仲裁、effort→budget 映射与预算钳制。
 */
export const applyRouteDecision = (
  req: CanonicalRequest,
  route: RouteDecision,
  clientStream: boolean | undefined,
): CanonicalRequest => {
  const requestedMaxTokens = req.generation.maxTokens;
  // 0/负数 → 不传（legacy sanitizeMaxTokens 语义）。
  const normalizedMaxTokens =
    requestedMaxTokens !== undefined && requestedMaxTokens <= 0 ? undefined : requestedMaxTokens;
  // U6 / R10 / KTD4：渠道 maxOutputTokens 是类型化能力上限，
  // 请求超上限时向下钳制到上限，不超则原样使用。
  const clampedMaxTokens =
    normalizedMaxTokens !== undefined && route.maxOutputTokens !== undefined
      ? Math.min(normalizedMaxTokens, route.maxOutputTokens)
      : normalizedMaxTokens;
  // 路由级 max_tokens 覆盖：仅 client 未传（或传 0 被规整掉）时生效（legacy sanitizeMaxTokens）。
  // 在此层兜底是因为 chat/responses 出站适配器不读 route.maxTokensOverride（anthropic 出站自带同语义兜底，结果一致）。
  const resolvedMaxTokens = clampedMaxTokens ?? route.maxTokensOverride;
  const reasoningMaxTokens =
    resolvedMaxTokens ??
    (route.providerProtocol === 'anthropic' ? ANTHROPIC_DEFAULT_MAX_TOKENS : undefined);
  return {
    ...req,
    resolvedModel: {
      providerId: route.providerId,
      providerProtocol: route.providerProtocol,
      modelId: route.resolvedModel,
      apiBase: route.apiBase,
    },
    generation: {
      ...req.generation,
      ...(resolvedMaxTokens !== undefined
        ? { maxTokens: resolvedMaxTokens }
        : { maxTokens: undefined }),
      stream: resolveStreamPolicy(route.streamPolicy, clientStream),
    },
    reasoning: resolveReasoning(req.reasoning, route.thinking, undefined, reasoningMaxTokens),
  };
};

// --- 上游请求构造与转发 ---

/** 上游请求三要素。 */
interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: WireBody;
}

/** 由 RouteDecision + 出站 body 构造上游 URL / 请求头（legacy transformInboundRequest 的 URL 部分）。 */
const buildUpstreamRequest = (route: RouteDecision, body: WireBody): UpstreamRequest => {
  const url = `${sanitizeApiBase(route.apiBase)}/v1/${endpointFor(route.providerProtocol)}`;
  const credential = resolveCredential(route.credentialHandle);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (route.providerProtocol === 'anthropic') {
    headers['x-api-key'] = credential;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.Authorization = `Bearer ${credential}`;
  }
  return { url, headers, body };
};

/** 跨协议非流式响应转换分派（6 向）。 */
const convertResponse = (
  from: ClientProtocol,
  to: ClientProtocol,
  canonical: CanonicalResponse,
): WireBody => {
  if (to === 'anthropic') {
    return from === 'openai'
      ? convertOpenAIResponseToAnthropic(canonical)
      : convertOpenAIResponsesToAnthropic(canonical);
  }
  if (to === 'openai') {
    return from === 'anthropic'
      ? convertAnthropicResponseToOpenAI(canonical)
      : convertOpenAIResponsesResponseToOpenAI(canonical);
  }
  return from === 'anthropic'
    ? convertAnthropicResponseToOpenAIResponses(canonical)
    : convertOpenAIResponseToOpenAIResponses(canonical);
};

/** usage 记录（统一口径：inputTokens 为计费部分）。 */
const recordUsage = (
  deps: PipelineDeps,
  route: RouteDecision,
  clientModel: string,
  adapterName: string | undefined,
  usage: UsageRecord | undefined,
): void => {
  if (!deps.usage || !usage) return;
  deps.usage.record({
    provider: route.providerId,
    adapter: adapterName ?? null,
    model: clientModel,
    upstreamModel: route.resolvedModel,
    protocol: route.providerProtocol,
    source: adapterName ?? 'proxy',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheCreate: usage.cacheCreationTokens ?? 0,
  });
};

/** 字节流旁路：原样透传的同时把文本累积到 onChunk（抓包用）。 */
const tapStream = (
  source: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): ReadableStream<Uint8Array> => {
  const decoder = new TextDecoder();
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onChunk(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        const tail = decoder.decode();
        if (tail) onChunk(tail);
      },
    }),
  );
};

/** 合并流式 usage（message_delta 可能分多次到达）。 */
const mergeUsage = (prev: UsageRecord | undefined, next: UsageRecord): UsageRecord => ({
  ...(prev ?? {}),
  ...next,
});

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'Access-Control-Allow-Origin': '*',
};

// --- forwardPipeline 主体 ---

/** 单个候选尝试的返回结果（U6 failover 内部状态）。 */
type ForwardOnceResult =
  | { kind: 'success'; response: Response }
  | { kind: 'fatal'; response: Response }
  | { kind: 'retryable'; status?: number; message: string }
  // B7：client 断连（非上游错误），终止 failover 循环。
  | { kind: 'aborted'; message: string };

/**
 * B7：判定 fetch/读体错误是否由 client abort 引起。
 * 优先用稳定的 signal.aborted（避免各运行时 AbortError 名称差异），
 * 其次回退 err.name === 'AbortError'。client 断连不计作上游 retryable。
 */
const isClientAbort = (err: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (err instanceof Error && err.name === 'AbortError');

/**
 * 一次候选尝试：inbound → IR → 应用路由决策（含钳制）→ outbound → 覆写 → fetch → 响应处理。
 * 不抛异常：所有错误都归一为 ForwardOnceResult 的三个 kind 之一。
 *
 * 关键设计（U6）：
 * - retryable：上游 5xx/408/429/网络错误 → pipeline 决定是否 failover 到下一个候选；
 * - fatal：上游 4xx（不含 408/429）/encode 失败/stream 编码失败 → 立即 surface，不重试；
 * - success：2xx 响应，按 crossProtocol / isStream 走非流式或流式分支。
 */
const forwardOnce = async (
  deps: PipelineDeps,
  params: ForwardParams,
  candidate: RouteDecision,
  baseCtx: {
    clientModel: string;
    clientStream: boolean | undefined;
    startTime: number;
    logLabel: string;
    normalizedBase: CanonicalRequest;
  },
): Promise<ForwardOnceResult> => {
  const { clientProtocol, rawBody, adapterName, signal } = params;
  const log = deps.logger;

  // 1. 应用路由决策（U6：含渠道 maxOutputTokens 钳制）
  const routed = applyRouteDecision(baseCtx.normalizedBase, candidate, baseCtx.clientStream);
  const isStream = routed.generation.stream;

  // 2. outbound encode：CanonicalRequest → 上游 wire body
  let upstream: UpstreamRequest;
  try {
    const outBody = OUTBOUND_ADAPTERS[candidate.providerProtocol].encode(routed, candidate);
    upstream = buildUpstreamRequest(candidate, outBody);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.error({ model: baseCtx.clientModel, err: message }, 'outbound encode failed');
    return { kind: 'fatal', response: jsonError(500, `请求转换失败: ${message}`) };
  }

  // 3. 覆写引擎：序列化后、doFetch 前应用（按 KTD8）
  if (candidate.overrides && candidate.overrides.length > 0) {
    const overrideCtx = {
      model: baseCtx.clientModel,
      logicalModel: baseCtx.clientModel,
      provider: candidate.providerId,
      providerProtocol: candidate.providerProtocol,
      resolvedModel: candidate.resolvedModel,
      // B9（R14）：client 显式关闭 reasoning 时（applyRouteDecision 解析出 enabled===false），
      // 后置 override 不得重新写入 reasoning 相关 wire 字段。
      reasoningDisabled: routed.reasoning?.enabled === false,
    };
    const overridden = applyOverrides(
      upstream.body,
      upstream.headers,
      candidate.overrides,
      overrideCtx,
      deps.logger,
    );
    upstream = { ...upstream, body: overridden.body, headers: overridden.headers };
  }

  const crossProtocol = clientProtocol !== candidate.providerProtocol;

  // 4. capture：记录入站原始 + 出站转换后请求体
  let pairId: number | undefined;
  if (deps.capture?.isEnabled()) {
    pairId = deps.capture.startRequest(
      adapterName ?? 'proxy',
      clientProtocol,
      baseCtx.clientModel,
      {
        ...(adapterName ? { adapterName } : {}),
        upstreamProvider: candidate.providerId,
        upstreamProtocol: candidate.providerProtocol,
        upstreamModel: candidate.resolvedModel,
      },
    );
    deps.capture.updateRequest(pairId, 'requestIn', rawBody);
    deps.capture.updateRequest(pairId, 'requestOut', JSON.stringify(upstream.body));
  }

  log?.debug(
    {
      label: baseCtx.logLabel,
      clientProtocol,
      upstreamProvider: candidate.providerId,
      upstreamProtocol: candidate.providerProtocol,
      model: baseCtx.clientModel,
      resolvedModel: candidate.resolvedModel,
      crossProtocol,
      stream: isStream,
      url: maskUrl(upstream.url),
      headers: maskHeaders(upstream.headers),
    },
    'upstream request',
  );

  // 5. fetch 上游
  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(upstream.url, {
      method: 'POST',
      headers: {
        ...upstream.headers,
        Accept: isStream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(upstream.body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    // B7（R-P2-1）：client 断连不是上游错误，单独终止（非 retryable、不计入上游失败）。
    if (isClientAbort(err, signal)) {
      return { kind: 'aborted', message: 'client disconnected' };
    }
    // 网络错误（连接拒绝 / DNS / 超时 / 连接重置）一律视为 retryable
    const message = err instanceof Error ? err.message : String(err);
    log?.error({ url: maskUrl(upstream.url), err: message }, 'upstream fetch failed (network)');
    return { kind: 'retryable', message: `网络错误: ${message}` };
  }

  if (!response.ok) {
    // B5（R-P1-1）：错误响应体读取纳入 try/catch。上游返回 headers 后读 body 时
    // 连接重置/超时/流错误发生在首字节前，应归类 retryable 继续 failover；client abort 单独终止。
    let errorBody: string;
    try {
      errorBody = await response.text();
    } catch (err) {
      if (isClientAbort(err, signal)) {
        return { kind: 'aborted', message: 'client disconnected' };
      }
      const message = err instanceof Error ? err.message : String(err);
      log?.warn(
        { status: response.status, url: maskUrl(upstream.url), err: message },
        'error body read failed (network)',
      );
      return {
        kind: 'retryable',
        status: response.status,
        message: `错误响应体读取失败: ${message}`,
      };
    }
    let upstreamMessage = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(errorBody) as { error?: { message?: string } };
      if (parsed.error?.message) upstreamMessage = parsed.error.message;
    } catch {
      // 非 JSON 错误体：用状态码兜底
    }
    log?.warn(
      { status: response.status, url: maskUrl(upstream.url), body: errorBody.slice(0, 500) },
      'upstream error response',
    );
    if (isRetryableUpstreamError({ status: response.status })) {
      return { kind: 'retryable', status: response.status, message: upstreamMessage };
    }
    return {
      kind: 'fatal',
      response: jsonError(502, `上游 API 错误 (${response.status}): ${upstreamMessage}`),
    };
  }

  // 6a. 非流式
  if (!isStream || !response.body) {
    // B5（R-P1-1）：非流式成功响应体读取同样在首字节前，读体网络错误归类 retryable。
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      if (isClientAbort(err, signal)) {
        return { kind: 'aborted', message: 'client disconnected' };
      }
      const message = err instanceof Error ? err.message : String(err);
      log?.warn({ url: maskUrl(upstream.url), err: message }, 'response body read failed (network)');
      return { kind: 'retryable', message: `响应体读取失败: ${message}` };
    }
    let parsed: WireBody | undefined;
    try {
      parsed = JSON.parse(text) as WireBody;
    } catch {
      // 上游返回非 JSON：仅透传路径可接受
    }

    recordUsage(
      deps,
      candidate,
      baseCtx.clientModel,
      adapterName,
      parsed ? extractWireUsage(candidate.providerProtocol, parsed) : undefined,
    );
    if (pairId !== undefined) deps.capture?.updateRequest(pairId, 'responseIn', text);

    if (!crossProtocol) {
      // 同协议透传（legacy：原文回写）
      if (pairId !== undefined) deps.capture?.updateRequest(pairId, 'responseOut', text);
      finishLog(
        log,
        baseCtx.logLabel,
        candidate,
        baseCtx.clientModel,
        crossProtocol,
        isStream,
        baseCtx.startTime,
      );
      return {
        kind: 'success',
        response: new Response(text, {
          status: 200,
          headers: {
            'Content-Type': response.headers.get('content-type') ?? 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }),
      };
    }

    if (!parsed) {
      return { kind: 'fatal', response: jsonError(502, '上游返回非 JSON，无法跨协议转换') };
    }
    const canonicalResponse = decodeUpstreamResponse(candidate.providerProtocol, parsed);
    const converted = convertResponse(
      candidate.providerProtocol,
      clientProtocol,
      canonicalResponse,
    );
    const outText = JSON.stringify(converted);
    if (pairId !== undefined) deps.capture?.updateRequest(pairId, 'responseOut', outText);
    finishLog(
      log,
      baseCtx.logLabel,
      candidate,
      baseCtx.clientModel,
      crossProtocol,
      isStream,
      baseCtx.startTime,
    );
    return {
      kind: 'success',
      response: new Response(outText, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  // 6b. 流式：stream inbound（上游 SSE → IR 事件）→ stream outbound（→ 客户端 SSE）
  // B6（R-P1-2）：首字节提交门闩 — 响应 200 已知但上游首字节前仍可能失败（零字节流）。
  //   eagerly 读第一个事件：读/解码失败 → retryable（client 未收到任何字节，可 failover）；
  //   首事件成功产生 → 提交候选，后续 mid-stream 错误 surface 为截断流（不重发 message_start）。
  const rawInChunks: string[] = [];
  const tappedIn =
    pairId !== undefined ? tapStream(response.body, (t) => rawInChunks.push(t)) : response.body;

  // 透传客户端断连信号：abort 时提前终止上游 SSE 迭代，且不补发收尾事件（见 StreamInboundAdapter.decode 契约）
  const events = STREAM_INBOUND_ADAPTERS[candidate.providerProtocol].decode(tappedIn, signal);

  // B8（R-P2-2）：跟踪流是否正常完成（收到终态 message_stop），仅正常完成记 usage；
  // 异常/取消/截断路径不写部分 token。
  let streamUsage: UsageRecord | undefined;
  let streamCompleted = false;
  const tracked = (async function* (): AsyncGenerator<CanonicalStreamEvent> {
    try {
      for await (const event of events) {
        if (event.type === 'message_delta' && event.usage) {
          streamUsage = mergeUsage(streamUsage, event.usage);
        }
        if (event.type === 'message_stop') {
          streamCompleted = true;
        }
        yield event;
      }
    } finally {
      // B8：仅正常完成时落 usage（收到 message_stop 且未 abort/异常）。
      if (streamCompleted) {
        recordUsage(deps, candidate, baseCtx.clientModel, adapterName, streamUsage);
      }
      if (pairId !== undefined)
        deps.capture?.updateRequest(pairId, 'responseIn', rawInChunks.join(''));
      finishLog(
        log,
        baseCtx.logLabel,
        candidate,
        baseCtx.clientModel,
        crossProtocol,
        isStream,
        baseCtx.startTime,
      );
    }
  })();

  // B6： eagerly 拉取首个事件，作为「首字节提交门闩」。
  // 首字节前失败 → retryable（可 failover）；首字节成功 → 提交候选（不可回退）。
  const iterator = tracked[Symbol.asyncIterator]();
  let firstEvent: IteratorResult<CanonicalStreamEvent>;
  try {
    firstEvent = await iterator.next();
  } catch (err) {
    // 首字节前上游读取/解码失败 → client 未收到任何字节，可 failover。
    if (isClientAbort(err, signal)) {
      return { kind: 'aborted', message: 'client disconnected' };
    }
    const message = err instanceof Error ? err.message : String(err);
    log?.warn(
      { url: maskUrl(upstream.url), err: message },
      'stream failed before first byte (retryable)',
    );
    return { kind: 'retryable', message: `流式首字节前失败: ${message}` };
  }

  // B6：首事件为空（零字节流立即关闭）或为 error 事件（上游在产出真实内容前报错，
  // 如 openai-chat 入站将读取异常转成 canonical error 事件）也属于「首字节前失败」→ retryable。
  // 只有拿到正常内容事件才算成功提交；此处主动 return 触发 tracked 的 finally 清理
  // （streamCompleted=false 故不会写部分 usage）。
  if (firstEvent.done) {
    await iterator.return?.(undefined);
    if (signal?.aborted) {
      return { kind: 'aborted', message: 'client disconnected' };
    }
    log?.warn({ url: maskUrl(upstream.url) }, 'stream closed before first byte (zero-byte, retryable)');
    return { kind: 'retryable', message: '流式首字节前失败: 上游流在首字节前关闭（零字节流）' };
  }
  if (firstEvent.value.type === 'error') {
    const reason = firstEvent.value.error?.message ?? 'unknown upstream stream error';
    await iterator.return?.(undefined);
    if (signal?.aborted) {
      return { kind: 'aborted', message: 'client disconnected' };
    }
    log?.warn({ url: maskUrl(upstream.url), err: reason }, 'stream errored before first byte (retryable)');
    return { kind: 'retryable', message: `流式首字节前失败: ${reason}` };
  }

  // 重组生成器：先产出已读取的首事件，再继续同一迭代器；
  // 取消时传播到 tracked 迭代器（确保 finally 清理执行）。
  const committed = (async function* (): AsyncGenerator<CanonicalStreamEvent> {
    try {
      if (!firstEvent.done) yield firstEvent.value;
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      await iterator.return?.(undefined);
    }
  })();

  let clientStream_: ReadableStream<Uint8Array>;
  try {
    clientStream_ = STREAM_OUTBOUND_ADAPTERS[clientProtocol].encode(committed, candidate);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.error({ err: message }, 'stream outbound encode failed');
    return { kind: 'fatal', response: jsonError(502, `流式转换失败: ${message}`) };
  }

  const outChunks: string[] = [];
  const body =
    pairId !== undefined
      ? tapStream(clientStream_, (t) => {
          outChunks.push(t);
          // 流式抓包按累积全文更新（createCaptureSink 的行级聚合由管理端点阶段接管）
          deps.capture?.updateRequest(pairId, 'responseOut', outChunks.join(''));
        })
      : clientStream_;

  return { kind: 'success', response: new Response(body, { status: 200, headers: SSE_HEADERS }) };
};

/**
 * 执行代理转发管线，返回应写回客户端的 Response。
 * 不抛异常：所有失败都归一为 JSON 错误响应（流中断除外，见下）。
 *
 * U6 failover 行为（KTD2/KTD3）：
 * - 候选队列 = [route, ...alternatives]（U3 selectRoute 已按 priority 升序排好）；
 * - 钉死别名 + on_failure='hard_fail'（默认）：i=0 retryable 时 surface 502，不重试；
 * - 钉死别名 + on_failure='fallback'：i=0 retryable 时继续试 i=1..N；
 * - 自动别名（isPinnedChannel=false）：始终按 retryable 走完整 failover；
 * - retryable 判定：5xx/408/429/网络错误/读体网络错误（B5）/流式首字节前失败（B6）；
 * - 首字节提交门闩（B6）：流式 eagerly 读首事件，首字节前失败 retryable，首字节后承诺；
 * - client abort（B7）：单独归类 aborted，终止 failover（非 retryable、非上游错误）；
 * - mid-stream 失败由 forwardOnce 流式分支透传为截断流，pipeline 不重试、不重发 message_start。
 */
export const forwardPipeline = async (
  deps: PipelineDeps,
  params: ForwardParams,
): Promise<Response> => {
  const {
    clientProtocol,
    wireBody,
    adapterName,
    route,
    alternatives,
    isPinnedChannel,
    onFailure,
    signal,
  } = params;
  const startTime = Date.now();
  const clientModel = typeof wireBody.model === 'string' ? wireBody.model : '';
  const logLabel = adapterName ? `/${adapterName}` : `/v1/${endpointFor(clientProtocol)}`;
  const log = deps.logger;

  // 1. inbound decode：wire → CanonicalRequest（一次解码，各候选共用）
  let canonical: CanonicalRequest;
  try {
    canonical = INBOUND_ADAPTERS[clientProtocol].decode(wireBody, {
      clientProtocol,
      logicalModel: clientModel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.warn({ model: clientModel, clientProtocol, err: message }, 'inbound decode failed');
    return jsonError(400, `请求解析失败: ${message}`);
  }

  const clientStream = typeof wireBody.stream === 'boolean' ? wireBody.stream : undefined;
  const normalizedBase = normalizeRequest(canonical);

  // 2. 候选队列：直连 = [route] / 适配器 = [route, ...alternatives]（U3 selectRoute 已排过 priority 序）
  const candidates: RouteDecision[] = [route, ...(alternatives ?? [])];
  const isPinned = isPinnedChannel === true;
  const onFail: 'hard_fail' | 'fallback' = onFailure ?? 'hard_fail';

  const baseCtx = {
    clientModel,
    clientStream,
    startTime,
    logLabel,
    normalizedBase,
  };

  let lastRetryable: { status?: number; message: string } | undefined;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) {
      // 防御性：candidates 不应为 undefined
      break;
    }
    // 钉死 hard_fail：理论上 i=0 之后不应进入此路径（i=0 会 surface）。
    if (i > 0 && isPinned && onFail === 'hard_fail') {
      break;
    }

    // B7（R-P2-1）：循环每次尝试前查 signal.aborted，client 已取消时停止 failover，
    // 不对剩余候选重复 encode/覆写/capture 并发立即失败的请求。
    if (signal?.aborted) {
      return jsonError(499, 'client closed request');
    }

    const result = await forwardOnce(deps, params, candidate, baseCtx);
    if (result.kind === 'success') {
      return result.response;
    }
    if (result.kind === 'fatal') {
      return result.response;
    }
    // B7：client 断连（非上游错误）——终止 failover，surface 499。
    if (result.kind === 'aborted') {
      return jsonError(499, 'client closed request');
    }
    // retryable
    lastRetryable = { status: result.status, message: result.message };

    // 钉死 hard_fail：i=0 retryable 时 surface 502，不重试到 i=1
    if (i === 0 && isPinned && onFail === 'hard_fail') {
      log?.warn(
        {
          provider: candidate.providerId,
          status: result.status,
          err: result.message,
        },
        'pinned channel failed, surfacing error (hard_fail)',
      );
      return jsonError(502, `钉死渠道失败 (${result.status ?? 'network'}): ${result.message}`);
    }

    log?.warn(
      {
        provider: candidate.providerId,
        status: result.status,
        err: result.message,
        attempt: i + 1,
        total: candidates.length,
      },
      'upstream retryable error, trying next candidate',
    );
  }

  // 所有候选都失败
  log?.error(
    {
      attempts: candidates.length,
      lastStatus: lastRetryable?.status,
      err: lastRetryable?.message,
    },
    'all channels failed (ROUTE_ALL_FAILED)',
  );
  return jsonError(502, `所有渠道失败 (ROUTE_ALL_FAILED): ${lastRetryable?.message ?? 'unknown'}`);
};

/** 完成日志（与 legacy forwardPipeline 的 done 日志对齐）。 */
const finishLog = (
  log: Logger | undefined,
  logLabel: string,
  route: RouteDecision,
  clientModel: string,
  crossProtocol: boolean,
  isStream: boolean,
  startTime: number,
): void => {
  log?.info(
    {
      label: logLabel,
      model: clientModel,
      resolvedModel: route.resolvedModel,
      provider: route.providerId,
      providerProtocol: route.providerProtocol,
      crossProtocol,
      stream: isStream,
      latencyMs: Date.now() - startTime,
    },
    'request done',
  );
};
