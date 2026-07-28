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

import type { OverrideRule } from '../../config/types.ts';
import type { CanonicalStreamEvent } from '../ir/stream-events.ts';
import type { CanonicalRequest, ClientProtocol, ReasoningSpec } from '../ir/types.ts';

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
 *
 * U3 扩展：渠道候选 + 能力档位 + failover 备用。
 * - priority：渠道在所属 model_group 内的优先级（数值越小越优先）；
 * - contextWindow / maxOutputTokens：渠道能力档位（U3 档位过滤与 U6 clamp 共同消费）；
 * - alternatives：钉死/自动别名的 failover 候选（U6 主用；U3 通过 selectRoute 挂载）。
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
  /** 渠道优先级（数值越小越优先）。U3 routeLogicalModel 显式化以支持 priority 序候选。 */
  priority: number;
  /** 渠道上下文窗口上限（token）。U3 档位过滤与 U6 clamp 共同消费。 */
  contextWindow?: number;
  /** 渠道最大输出 token 上限。U3 档位过滤与 U6 clamp 共同消费。 */
  maxOutputTokens?: number;
  /** 备选渠道（failover 用，U6 消费）。selectRoute 在选中态挂上 alternatives。 */
  alternatives?: RouteDecision[];
  /**
   * 适用覆写规则（U5）：route 时由 resolveAdapterRoute 从 mapping.overrides 解析，
   * pipeline 在 outbound.encode 之后、doFetch 之前调用 applyOverrides 应用。
   * 直连（routeModel）保持 undefined。
   */
  overrides?: OverrideRule[];
}

/** 渠道选择策略（KTD2 策略缝：v1=priority，weight/round-robin/latency 后续插件化）。 */
export type SelectionStrategy = 'priority';

/** selectRoute 上下文（U3 仅做透传，U4+ 扩展）。 */
export interface RouteSelectContext {
  clientStream?: boolean;
  /** 透传额外维度（租户/用户偏好等）；U3 不消费。 */
  [key: string]: unknown;
}

/** selectRoute 返回值。selected.alternatives 与 alternatives 字段同步。 */
export interface SelectionResult {
  selected: RouteDecision;
  alternatives: RouteDecision[];
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
  /**
   * 解码上游 SSE。signal 可选：传入后客户端 abort 会提前终止迭代，
   * 且不补发收尾事件（message_stop），供上层区分「正常 EOF」与「被截断」。
   */
  decode(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncIterable<CanonicalStreamEvent>;
}

/** 流式出站适配器：CanonicalStreamEvent → 目标协议 SSE 字节流。 */
export interface StreamOutboundAdapter {
  readonly name: ClientProtocol;
  encode(
    events: AsyncIterable<CanonicalStreamEvent>,
    route: RouteDecision,
  ): ReadableStream<Uint8Array>;
}
