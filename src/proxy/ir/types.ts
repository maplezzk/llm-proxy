/**
 * Canonical 中间表示（IR）—— 请求 / 响应 / 消息 / 块 / 工具 的统一类型。
 *
 * 设计依据：docs/plans/2026-07-27-003-feat-p1-protocol-core-design.md §3。
 *
 * 设计目标：
 * - 零依赖、纯类型，独立于任何协议适配器与运行时。
 * - 无损承载 anthropic / openai-chat / openai-responses 三协议的全部内容形态，
 *   尤其是 thinking / reasoning（签名、budget、effort、summary）。
 * - 块在 IR 里有稳定 blockId；协议相关的 index（如 Anthropic content_block 索引）
 *   不进 IR，由出站适配器在写出时按 thinking(0)→text(1)→tool_use(2+) 分配。
 */

/** 支持的入站 / 出站协议。 */
export type ClientProtocol = 'anthropic' | 'openai' | 'openai-responses';

/** canonical reasoning effort 5 级；xhigh/max 为承载 anthropic max 的哨兵。 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 透传型 thinking 类型（对应 anthropic thinking.type）。 */
export type ThinkingType = 'enabled' | 'disabled' | 'adaptive' | 'auto';

/** reasoning 决策来源，用于 trace 与可观察性（P4）。 */
export type ReasoningSource = 'client' | 'route' | 'override';

/** thinking 签名来源：上游原始 / 本地确定性生成 / 显式无。 */
export type SignatureSource = 'original' | 'generated' | 'none';

/**
 * 工具输入 / 参数的 JSON Schema。工具 schema 必为对象，故约束为 Record。
 * 具体字段语义由各协议适配器负责渲染与校验。
 */
export type JsonSchema = Record<string, unknown>;

/**
 * 工具调用输入（tool_use.input）。LLM 工具输入是 JSON 对象；
 * 适配器层负责按工具 schema 校验，IR 层仅约束为对象形态。
 */
export type ToolInput = Record<string, unknown>;

/** Anthropic 缓存控制（已知 type 值 'ephemeral'；保留索引签名兼容扩展）。 */
export interface CacheControl {
  type: string;
  [k: string]: unknown;
}

/** 图片三形态（IR 层统一，出站适配器按目标协议渲染）。 */
export type ImageSource =
  | { kind: 'url'; url: string; detail?: 'auto' | 'low' | 'high' }
  | { kind: 'base64'; mediaType: string; data: string }
  | { kind: 'file_id'; fileId: string; detail?: 'auto' | 'low' | 'high' };

/** 音频源（预留，当前协议暂未用到）。 */
export type AudioSource =
  | { kind: 'base64'; mediaType: string; data: string }
  | { kind: 'url'; url: string };

/** Computer Use 元数据（仅 computer 工具）。 */
export interface ComputerUseMeta {
  displayWidth?: number;
  displayHeight?: number;
  displayNumber?: number;
}

/**
 * 统一内容块。7+ 种 kind 足以承载三协议 wire 格式的全部内容形态。
 * - thinking：anthropic 思考块，含签名（多轮回传关键）。
 * - reasoning：openai-responses 风格 reasoning item（可独立成块）。
 * - tool_use / tool_result：工具调用与结果。
 */
export type CanonicalBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'thinking';
      text: string;
      signature?: string;
      signatureSource?: SignatureSource;
      redacted?: boolean;
    }
  | { kind: 'reasoning'; text: string; summary?: string; id?: string }
  | {
      kind: 'tool_use';
      id: string;
      name: string;
      namespace?: string;
      input: ToolInput;
      computer?: ComputerUseMeta;
    }
  | {
      kind: 'tool_result';
      toolUseId: string;
      content: CanonicalBlock[] | string;
      isError?: boolean;
    }
  | { kind: 'image'; source: ImageSource }
  | { kind: 'file'; fileId?: string; mimeType?: string }
  | { kind: 'audio'; source: AudioSource };

/** 统一消息。tool role 的 name 为工具名。 */
export interface CanonicalMessage {
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool';
  blocks: CanonicalBlock[];
  /** tool role 的工具名（可选）。 */
  name?: string;
}

/** 系统提示块（anthropic system 可为多块）。 */
export type SystemBlock =
  | { kind: 'text'; text: string; cacheControl?: CacheControl }
  | { kind: 'image'; source: ImageSource };

/**
 * 归一后的 reasoning 策略。三协议无损承载：
 * - anthropic：enabled + budgetTokens（或 type=disabled 显式禁）；签名留在 thinking.signature。
 * - openai-chat：enabled + effort（reasoning_effort 字符串），无签名。
 * - openai-responses：enabled + effort + summary（顶层 reasoning 对象）；reasoning item 独立成块。
 */
export interface ReasoningSpec {
  /** 总开关。 */
  enabled?: boolean;
  /** 5 级 canonical effort。 */
  effort?: ReasoningEffort;
  /** anthropic 语义预算。 */
  budgetTokens?: number;
  /** 透传型（anthropic thinking.type）。 */
  type?: ThinkingType;
  /** openai-responses 语义；anthropic 忽略。 */
  summary?: 'auto' | 'concise' | 'detailed' | string;
  /** 决策来源（trace 用）。 */
  source: ReasoningSource;
  /** 反向：保留客户端原始 effort，供跨协议查表。 */
  clientEffort?: ReasoningEffort;
}

/** 生成参数。stream 必须显式，默认值由 RouteDecision.streamPolicy 决定。 */
export interface GenerationSpec {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /**
   * 是否流式（non-nullable，策略解析后的最终布尔值）。
   * “客户端未传时是否默认开启流式”由 RouteDecision.streamPolicy 决定；
   * 此字段是该策略解析后的确定结果，不可为空。
   */
  stream: boolean;
}

/** 工具种类。 */
export type CanonicalToolKind =
  | 'function'
  | 'web_search'
  | 'code_interpreter'
  | 'file_search'
  | 'computer'
  | 'mcp'
  | 'custom';

/**
 * 统一工具定义。
 * - name 为主名（namespace__child 展平形式）。
 * - namespace 仅 mcp / CCX 工具使用，普通 function 工具不带。
 */
export interface CanonicalTool {
  name: string;
  namespace?: string;
  description?: string;
  schema: JsonSchema;
  kind: CanonicalToolKind;
  displayWidth?: number;
  displayHeight?: number;
  displayNumber?: number;
  builtIn?: boolean;
  /** 原始 wire 工具对象（供出站适配器还原协议特有字段）。 */
  raw?: unknown;
}

/** 工具选择。 */
export type CanonicalToolChoice =
  | { kind: 'auto' }
  | { kind: 'required' }
  | { kind: 'none' }
  | { kind: 'tool'; name: string };

/** 路由解析后的目标（由 route 注入，不覆盖 logicalModel）。 */
export interface ResolvedTarget {
  providerId: string;
  /** 目标 provider 的协议（与 CanonicalRequest.clientProtocol 命名对齐）。 */
  providerProtocol: ClientProtocol;
  modelId: string;
  apiBase?: string;
}

/**
 * 请求侧 IR 入口。
 * - clientProtocol：入站协议。
 * - logicalModel：客户端原始请求 model（路由解析源键）。
 * - resolvedModel：路由解析后填充。
 */
export interface CanonicalRequest {
  clientProtocol: ClientProtocol;
  logicalModel: string;
  resolvedModel?: ResolvedTarget;
  messages: CanonicalMessage[];
  system?: string | SystemBlock[];
  tools?: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  generation: GenerationSpec;
  reasoning?: ReasoningSpec;
  metadata?: { traceId?: string; requestId?: string; [k: string]: unknown };
}

/** 用量记录。区分计费输入（不含缓存）与含缓存总量。 */
export interface UsageRecord {
  /** 计费输入（不含缓存）。 */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** 含缓存的输入总量。 */
  totalInputTokens?: number;
  /** openai-responses reasoning_tokens。 */
  reasoningTokens?: number;
  /**
   * 原始 wire usage。使用时必须经类型守卫还原为具体协议类型，禁止当 any 直接用。
   */
  raw?: unknown;
}

/** 停止原因（协议无关）。 */
export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'content_filter'
  | 'error';

/** 完成态。 */
export type FinishReason = 'completed' | 'incomplete' | 'failed';

/** 响应侧 IR。 */
export interface CanonicalResponse {
  model: string;
  message: CanonicalMessage;
  stopReason: StopReason;
  finishReason: FinishReason;
  usage?: UsageRecord;
  /**
   * 原始 wire 响应。使用时必须经类型守卫还原为具体协议类型，禁止当 any 直接用。
   */
  raw?: unknown;
}
