/**
 * 协议适配器公共接口与共享类型（P1.3）。
 *
 * 设计依据：docs/plans/2026-07-27-003-feat-p1-protocol-core-design.md §4 / §5。
 *
 * 本模块定义 P2–P5 并发所需的稳定契约：
 * - InboundAdapter / OutboundAdapter：请求侧 wire ↔ CanonicalRequest。
 * - StreamInboundAdapter / StreamOutboundAdapter：流式 SSE ↔ CanonicalStreamEvent。
 * - RouteDecision / StreamPolicy / ProxyError / RetryableErrorJudge：路由与重试契约。
 */

import type { CanonicalRequest, ClientProtocol, ReasoningSpec } from '../ir/types.ts';
import type { CanonicalStreamEvent } from '../ir/stream-events.ts';

/**
 * wire 协议 body（JSON 对象）。inbound 解码前视为不可信，
 * 适配器实现必须用 zod 做结构校验（类型守卫）后再转为 CanonicalRequest。
 */
export type WireBody = Record<string, unknown>;

/** 流式策略：取代 legacy RouterResult.stream 的三态 nullable。 */
export type StreamPolicy = 'default_true' | 'passthrough' | 'force_true' | 'force_false';

/**
 * 路由解析产物。apiKey 不入 IR，以受控凭据引用 credentialHandle 表示；
 * thinking 已归一为 ReasoningSpec；stream 三态用 StreamPolicy 枚举。
 */
export interface RouteDecision {
  providerId: string;
  /** 目标 provider 协议（与 CanonicalRequest.clientProtocol 命名对齐）。 */
  providerProtocol: ClientProtocol;
  apiBase: string;
  /** 受控凭据引用（vault/secret key），非明文 apiKey。 */
  credentialHandle: string;
  resolvedModel: string;
  thinking: ReasoningSpec;
  streamPolicy: StreamPolicy;
  maxTokensOverride?: number;
}

/**
 * 归一后的上游错误。出站适配器把各协议错误规整为此形态，
 * 供 RetryableErrorJudge 做协议无关的重试判定（P3 failover 主信号）。
 */
export interface ProxyError {
  /** 归一错误类型。 */
  type:
    | 'rate_limited'
    | 'server_error'
    | 'auth'
    | 'invalid_request'
    | 'context_length'
    | 'network'
    | 'unknown';
  message: string;
  /** 上游 HTTP 状态码（如有）。 */
  status?: number;
  /** 出站适配器已知时的可重试提示。 */
  retryable?: boolean;
  cause?: Error;
}

/** 重试判定结果。 */
export interface RetryVerdict {
  retryable: boolean;
  retryAfterMs?: number;
  reason?: string;
}

/**
 * 协议无关的重试判定函数契约（实现于 P3）。
 * 429/503/网络超时 → 可重试；400/401/422 → 不可；context_length → 不可但可降级。
 */
export type RetryableErrorJudge = (
  error: ProxyError,
  attemptCount: number,
  route: RouteDecision,
) => RetryVerdict;

/** inbound 解码上下文。 */
export interface InboundContext {
  clientProtocol: ClientProtocol;
  logicalModel: string;
  /** 入站请求头（只读，供提取 trace id 等）。 */
  headers?: Record<string, string>;
}

/** 请求侧入站适配器：wire body → CanonicalRequest。 */
export interface InboundAdapter {
  readonly name: ClientProtocol;
  /** 是否能处理该入站请求（按 path/body 判定）。 */
  canHandle(ctx: InboundContext): boolean;
  /** wire body → CanonicalRequest；实现须用 zod 校验入参，不信任 wire 数据。 */
  decode(body: WireBody, ctx: InboundContext): CanonicalRequest;
}

/** 请求侧出站适配器：CanonicalRequest → wire body。 */
export interface OutboundAdapter {
  readonly name: ClientProtocol;
  /** CanonicalRequest → wire body。 */
  encode(req: CanonicalRequest, route: RouteDecision): WireBody;
}

/** 流式入站适配器：上游 SSE 字节流 → CanonicalStreamEvent 异步迭代。 */
export interface StreamInboundAdapter {
  readonly name: ClientProtocol;
  decode(stream: ReadableStream<Uint8Array>): AsyncIterable<CanonicalStreamEvent>;
}

/** 流式出站适配器：CanonicalStreamEvent → 目标协议 SSE 字节流。 */
export interface StreamOutboundAdapter {
  readonly name: ClientProtocol;
  encode(
    events: AsyncIterable<CanonicalStreamEvent>,
    route: RouteDecision,
  ): ReadableStream<Uint8Array>;
}
