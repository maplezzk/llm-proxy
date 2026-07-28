/**
 * 配置模型类型（P1.11 移植自 legacy-src/config/types.ts）。
 *
 * 本阶段配置来源为 YAML（~/.llm-proxy/config.yaml）；PG schema 持久化是 P1.16，
 * 届时 ConfigStore 双写过渡。运行时模型（camelCase）与 YAML 文件模型（snake_case）分离。
 *
 * P2.X 模型为中心路由：新增 ModelGroup / ModelChannelRef / OverrideRule，
 * 扩展 AdapterModelMapping 支持 model 引用 + channel 钉死 + overrides；
 * AdapterConfig 新增 on_failure。Provider/Model 增 priority/enabled/context_window。
 */

/** 供应商 / 适配器协议类型。 */
export type ProviderType = 'anthropic' | 'openai' | 'openai-responses';

/** 模型支持的输入模态。未配置时视为仅支持文本（向后兼容）。 */
export type InputModality = 'text' | 'image' | 'audio' | 'video' | 'file';

/** thinking / reasoning 配置（YAML 三可选字段）。 */
export interface ThinkingConfig {
  /** Anthropic: thinking budget tokens（启用 thinking 模式时必填）。 */
  budget_tokens?: number;
  /** OpenAI: reasoning_effort（low | medium | high | xhigh | max）。 */
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** thinking.type 透传值（如 MiniMax adaptive），优先级低于 budget_tokens/reasoning_effort。 */
  type?: string;
}

/** 供应商下的单个模型。 */
export interface Model {
  id: string;
  thinking?: ThinkingConfig;
  /** 模型支持的输入模态列表，如 ["text", "image"]。未配置时默认 ["text"]。 */
  input?: InputModality[];
  /** 模型默认上下文窗口（token）。仅是默认值，渠道绑定可覆盖。 */
  contextWindow?: number;
}

/** 外挂多模态识图配置（P1.11 管线暂不执行识图回退，配置仅加载与校验）。 */
export interface VisionConfig {
  /** 识图模型所在的 provider 名称（必须）。 */
  provider: string;
  /** 识图模型 ID（必须）。 */
  model: string;
  /** 自定义识图提示词，未配置时使用默认值。 */
  prompt?: string;
}

/** 模型供应商。 */
export interface Provider {
  name: string;
  type: ProviderType;
  apiKey: string;
  apiBase?: string;
  models: Model[];
  /** 优先级。用于多渠道调度时的排序（数值越小越优先）。未配置时默认 0。 */
  priority?: number;
  /** 是否启用。disabled 的 provider 不参与路由。 */
  enabled?: boolean;
}

/** 覆写引擎作用域。adapter-alias 作用于整个 alias；channel 仅作用于选定的渠道。 */
export type OverrideScope = 'adapter-alias' | 'channel';

/** body 单条操作。 */
export interface OverrideBodyOp {
  op: 'set' | 'set_if_absent' | 'delete';
  path: string;
  value?: unknown;
}

/** header 单条操作。 */
export interface OverrideHeaderOp {
  op: 'set' | 'delete';
  name: string;
  value?: string;
}

/** 声明式覆写规则（v1 操作集详见 KTD1）。 */
export interface OverrideRule {
  scope: OverrideScope;
  /** 轻量模板条件，渲染结果 == "true" 才应用。白名单变量见计划 §6.3。 */
  when?: string;
  body?: OverrideBodyOp[];
  headers?: OverrideHeaderOp[];
}

/** 适配器别名钉死到单一渠道时使用 `"<provider>/<model>"` 格式。 */
export type ChannelKey = `${string}/${string}`;

/** 适配器模型映射。
 *  - 模式 A（legacy）：必填 `provider` + `targetModelId`，用于 P1 一对一映射。
 *  - 模式 B（model-centric）：必填 `model`（逻辑模型组 id），可辅以 `channel` 钉死渠道。
 * 两种模式互斥，validator 检查。 */
export interface AdapterModelMapping {
  sourceModelId: string;
  /** Legacy 模式：目标 provider 名称。 */
  provider?: string;
  /** Legacy 模式：目标真实模型 ID。 */
  targetModelId?: string;
  /** Model-centric 模式：逻辑模型组 id。 */
  model?: string;
  /** Model-centric 模式：钉死单一渠道，格式 "provider/model"。 */
  channel?: ChannelKey;
  /** 该 alias 维度的覆写规则。 */
  overrides?: OverrideRule[];
  thinking?: ThinkingConfig;
}

/** 适配器别名失败行为。hard_fail：钉死的渠道一旦失败直接报错；
 *  fallback：钉死的渠道失败可回退到模型组的其他渠道。 */
export type AdapterOnFailure = 'hard_fail' | 'fallback';

/** 适配器（虚拟端点 /{name}/v1/*）。 */
export interface AdapterConfig {
  name: string;
  type: ProviderType;
  /** 默认 max_tokens，客户端没传时使用。命名与传统 yaml 保持一致。 */
  max_tokens?: number;
  /** 下游未传 stream 时的默认值。未配置（undefined）时透传（不注入）。 */
  stream?: boolean;
  /** 钉死渠道失败时的行为。默认 hard_fail。 */
  onFailure?: AdapterOnFailure;
  models: AdapterModelMapping[];
}

/** 模型组内的渠道引用。 */
export interface ModelChannelRef {
  provider: string;
  model: string;
  /** 渠道优先级。数值越小越优先。未配置时使用 provider.priority 或 0。 */
  priority?: number;
  /** 该渠道专属的上下文窗口上限（token）。覆盖模型默认值。 */
  contextWindow?: number;
  /** 该渠道专属的最大输出 token 上限。 */
  maxOutputTokens?: number;
}

/** 逻辑模型组（model-centric 路由单元）。 */
export interface ModelGroup {
  id: string;
  /** 模型组默认上下文窗口。 */
  contextWindow?: number;
  /** 模型组默认最大输出 token。 */
  maxOutputTokens?: number;
  /** 服务该模型的渠道列表。 */
  channels: ModelChannelRef[];
}

/** 运行时配置根对象。 */
export interface Config {
  providers: Provider[];
  /** 逻辑模型组（model-centric 路由，可选）。 */
  modelGroups?: ModelGroup[];
  adapters?: AdapterConfig[];
  /** 外挂多模态识图配置（P1.11 仅加载，管线不消费）。 */
  vision?: VisionConfig;
  proxyKey?: string;
  logLevel?: LogLevel;
  locale?: string;
  /** 端口号，不设则默认 9000。 */
  port?: number;
  /** 抓包缓冲区最大条数，默认 100。 */
  captureMaxSize?: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// --- YAML 文件模型（snake_case，与历史 config.yaml 兼容） ---

export interface ThinkingConfigFile {
  budget_tokens?: number;
  reasoning_effort?: string;
  type?: string;
}

export interface ProviderConfigFile {
  name: string;
  type: ProviderType;
  api_key: string;
  api_base?: string;
  priority?: number;
  enabled?: boolean;
  models: {
    id: string;
    thinking?: ThinkingConfigFile;
    reasoning_effort?: string;
    input?: string[];
    context_window?: number;
  }[];
}

export interface OverrideBodyOpFile {
  op: 'set' | 'set_if_absent' | 'delete';
  path: string;
  value?: unknown;
}

export interface OverrideHeaderOpFile {
  op: 'set' | 'delete';
  name: string;
  value?: string;
}

export interface OverrideRuleFile {
  scope: OverrideScope;
  when?: string;
  body?: OverrideBodyOpFile[];
  headers?: OverrideHeaderOpFile[];
}

export interface ModelChannelRefFile {
  provider: string;
  model: string;
  priority?: number;
  context_window?: number;
  max_output_tokens?: number;
}

export interface ModelGroupFile {
  id: string;
  context_window?: number;
  max_output_tokens?: number;
  channels: ModelChannelRefFile[];
}

export interface AdapterConfigFile {
  name: string;
  type: ProviderType;
  max_tokens?: number;
  stream?: boolean;
  on_failure?: AdapterOnFailure;
  models: {
    source_model_id: string;
    provider?: string;
    target_model_id?: string;
    model?: string;
    channel?: ChannelKey;
    overrides?: OverrideRuleFile[];
    thinking?: ThinkingConfigFile;
    reasoning_effort?: string;
  }[];
}

export interface ConfigFile {
  providers: ProviderConfigFile[];
  model_groups?: ModelGroupFile[];
  adapters?: AdapterConfigFile[];
  vision?: { provider: string; model: string; prompt?: string };
  proxy_key?: string;
  log_level?: string;
  locale?: string;
  port?: number;
  capture_max_size?: number;
}

/** 校验错误条目。 */
export interface ValidationError {
  field: string;
  message: string;
}

/** 热重载结果。 */
export type ReloadResult =
  | { success: true; version: number }
  | { success: false; errors: ValidationError[] };
