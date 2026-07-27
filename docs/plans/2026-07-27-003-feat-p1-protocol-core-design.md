---
title: P1 协议核心移植设计 —— canonical IR + 协议适配器
date: 2026-07-27
seq: 2026-07-27-003
type: design
status: proposed（待评审后进入实施）
execution: code
phase: P1
related:
  - docs/plans/2026-07-27-002-master-axonhub-class-gateway-plan.md
  - docs/adr/0004-pg-only-best-in-class-stack.md
  - .pi/workflows/p1_arch_analysis-2026-07-26T21-34-33.json
---

# P1 协议核心移植设计：canonical IR + 协议适配器

> 本文是 P1 的**架构设计**（主计划 §8 的 P1 + §12.3 的并发前提）。定清楚 canonical 中间表示（IR）、适配器边界、P2–P5 公共接口、PG schema 与测试移植策略后，再据此实施（机械移植可派 subagent 并行）。
> 依据：`p1_arch_analysis` workflow 对 `legacy-src/proxy/`（translation.ts 2109 行 + stream-converter.ts 1555 行）+ 配置/路由/测试的深扫，结论带 `文件:行号` 证据。

## 1. 目标与范围

- **G1**：把"两两直转"重构为 **canonical IR + 协议适配器**（hub-and-spoke），消除规则重复，为加第 4 协议铺路。
- **G2**：定好 **P2–P5 并发所需的公共接口**（§12.3），让后续功能单元能干净并行。
- **G3**：配置落 **PG schema**（providers/models/adapters/mappings），ConfigStore 双写过渡。
- **G4**：**移植全部测试**（实测约 343 it，CLAUDE.md 写 329，P1.17 前须实测对齐），保持行为等价。
- **非目标**：推理模板/override（P2）、failover（P3）、可观测性（P4）、模型管理端点（P5）——本文只**定接口**，不实现。

## 2. 现状架构与痛点

### 2.1 现状
- **请求侧**：`translation.ts` 用 `FullParams` 作隐式管道（3 extract → 4 builder 组合出 6 个跨协议方向）；每条 builder 各自重写一遍 tool_use↔tool_calls / tool_result↔tool role / thinking↔reasoning_content / image 三形态映射。
- **响应侧**：6 个独立 `convert*ResponseTo*` 函数（1:1 对应 6 方向）按块扫描 content/output 数组直接重写。
- **流式侧**：`stream-converter.ts` 是 4 个 SSE converter 的并列状态机，content_block 索引（0 thinking/1 text/2+ tool_use）、块切换、签名时机散落在 `openBlocks/thinkingBlockStarted/textBlockOpen` 等局部变量里。
- **配置侧**：Provider/Model/AdapterConfig/AdapterModelMapping 全在内存；`RouterResult` 把 apiKey/providerType/modelId/thinking/stream/max_tokens 揉成运行时对象被各处共享读取。

### 2.2 痛点（重构动因）
1. **规则重复**：四组同语义映射在 6 builder + 6 response converter + 4 stream converter 里各写一遍；加一个新协议需再加 16 处实现。
2. **两步转换**：Responses→Anthropic 走 `convertResponsesInputToMessages` → `convertMessagesToAnthropic`，重复合并 assistant+tool_calls（line 391-398/413-422/819-845）。
3. **thinking 散在 4 条管线**：`resolveReasoning`(715)、`injectThinkingConfig`(1472)、`ensureThinkingBlocks`(1402)、block 转换(851-866/1102-1126)，每条 builder 各走一遍，错误难定位。
4. **流式索引硬编码**：OpenAI→Anthropic 固定 thinking 0/text 1/tool_use 2+，被协议时序约束散落在局部变量里——IR 化后必须由**结构**而非代码保证。
5. **签名三路径**：同一条签名/思考内容在 Anthropic→OpenAI（累积到 finish 才输出）、Anthropic→Responses（塞进 reasoning.summary）、Responses→Anthropic（部分遗留空签名，line 1636-1694）走三种处理。
6. **stream 三态勉强承载**：adapter 默认 null=透传 / route 无字段=注入 true / 显式强制，全压在 `RouterResult.stream` nullable 上。

### 2.3 thinking/reasoning 现状与断点
- `ThinkingConfig{budget_tokens?, reasoning_effort?, type?}` 三可选字段（config/types.ts:6-13）；5 级 effort→Anthropic budget 表 `REASONING_EFFORT_TO_BUDGET`(1024/4096/16384/32768/65536, line 12-19)。
- 注入唯一点 `injectThinkingConfig`(1472)：Anthropic 预算优先级 `route.budget_tokens > route.reasoning_effort 查表 > 客户端 reasoning_effort 查表`，强制 `max_tokens ≥ budget_tokens`。
- `makeSignature`(77)：`SHA-256(thinking).hex[:16]` 确定性伪签名，多轮回传一致。
- **断点**：① 三字段语义重叠、type 与 effort/budget 跨协议谁覆盖谁不清；② Responses→Anthropic 部分路径遗留空签名破坏多轮一致；③ 流式 signature_delta 在 Anthropic→OpenAI 等 finish_reason 才落盘，客户端提前断开会丢签名；④ `max_tokens ≥ budget` 约束只在 Anthropic 路径，Responses 无保护。

## 3. Canonical IR 设计

IR 拆 4 块独立类型：请求 / 响应 / 流式事件 / 工具。定义于 `src/proxy/ir/types.ts`（零依赖、纯类型）。

### 3.1 请求侧
```ts
interface CanonicalRequest {
  clientProtocol: 'anthropic' | 'openai' | 'openai-responses';
  logicalModel: string;             // 客户端原始 model（路由解析源键）
  resolvedModel?: ResolvedTarget;   // 路由解析后填充，不覆盖 logicalModel
  messages: CanonicalMessage[];
  system?: string | SystemBlock[];
  tools?: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  generation: GenerationSpec;
  reasoning?: ReasoningSpec;
  metadata?: { traceId?: string; requestId?: string; [k: string]: unknown };
}

interface CanonicalMessage {
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool';
  blocks: CanonicalBlock[];
  name?: string;                    // tool role 的工具名
}

type CanonicalBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; signature?: string; signatureSource?: 'original' | 'generated' | 'none'; redacted?: boolean }
  | { kind: 'reasoning'; text: string; summary?: string; id?: string }   // Responses 风格 reasoning item
  | { kind: 'tool_use'; id: string; name: string; namespace?: string; input: unknown; computer?: ComputerUseMeta }
  | { kind: 'tool_result'; toolUseId: string; content: CanonicalBlock[] | string; isError?: boolean }
  | { kind: 'image'; source: ImageSource }
  | { kind: 'file'; fileId?: string; mimeType?: string }
  | { kind: 'audio'; source: AudioSource };

type ImageSource =
  | { kind: 'url'; url: string; detail?: 'auto' | 'low' | 'high' }
  | { kind: 'base64'; mediaType: string; data: string }
  | { kind: 'file_id'; fileId: string; detail?: 'auto' | 'low' | 'high' };
```

### 3.2 reasoning 归一（核心）
```ts
interface ReasoningSpec {
  enabled?: boolean;                                  // 总开关
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';  // 5 级 canonical effort
  budgetTokens?: number;                              // Anthropic 语义预算
  type?: 'enabled' | 'disabled' | 'adaptive' | 'auto';   // 透传型
  summary?: 'auto' | 'concise' | 'detailed' | string;    // Responses 语义，Anthropic 忽略
  source: 'client' | 'route' | 'override';            // 决策可观察（trace 用）
  clientEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';  // 反向：保留客户端 effort 供跨协议查表
}
// 三协议无损承载：
// - Anthropic: enabled + budgetTokens（或 type=disabled 显式禁）；signature 留在 thinking.signature
// - OpenAI Chat: enabled + effort（reasoning_effort 字符串），无 signature
// - OpenAI Responses: enabled + effort + summary（顶层 reasoning 对象）；reasoning item 独立成块
```

### 3.3 generation / tools
```ts
interface GenerationSpec {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  stream: boolean;                  // 必须显式，由 RouteDecision.streamPolicy 决定默认值
}

interface CanonicalTool {
  name: string;                     // 主名（namespace__child 展平形式）
  namespace?: string;               // 原 namespace，仅 mcp/CCX 工具用
  description?: string;
  schema: unknown;
  kind: 'function' | 'web_search' | 'code_interpreter' | 'file_search' | 'computer' | 'mcp' | 'custom';
  displayWidth?: number; displayHeight?: number; displayNumber?: number;
  builtIn?: boolean;
  raw?: unknown;
}

type CanonicalToolChoice =
  | { kind: 'auto' } | { kind: 'required' } | { kind: 'none' } | { kind: 'tool'; name: string };
```

### 3.4 响应侧
```ts
interface CanonicalResponse {
  model: string;
  message: CanonicalMessage;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'content_filter' | 'error';
  finishReason: 'completed' | 'incomplete' | 'failed';
  usage?: UsageRecord;
  raw?: unknown;
}

interface UsageRecord {
  inputTokens: number;              // 计费输入（不含缓存）
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalInputTokens?: number;        // 含缓存
  reasoningTokens?: number;         // Responses reasoning_tokens
  raw?: unknown;
}
```

### 3.5 流式事件
```ts
type CanonicalStreamEvent =
  | { type: 'message_start'; message: CanonicalMessage }
  | { type: 'block_start'; blockId: string; index: number; block: CanonicalBlock }
  | { type: 'block_delta'; blockId: string; index: number; delta: BlockDelta }
  | { type: 'block_signature'; blockId: string; index: number; signature: string; source: 'original' | 'generated' }
  | { type: 'block_stop'; blockId: string; index: number }
  | { type: 'message_delta'; stopReason?: string; usage?: UsageRecord }
  | { type: 'message_stop'; stopReason: string; finishReason: 'completed' | 'incomplete' | 'failed' }
  | { type: 'error'; error: { type: string; message: string; retryable?: boolean } };

type BlockDelta =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'reasoning_summary'; text: string }
  | { kind: 'tool_input_json'; partialJson: string }
  | { kind: 'tool_input_action'; action: unknown }
  | { kind: 'image_ref'; fileId?: string };
```

### 3.6 IR 不变量
1. 块在 IR 里有稳定 `blockId`；Anthropic 适配器写出时按 thinking(0)→text(1)→tool_use(2+) 分配 index，**index 不进 IR**。
2. `thinking.signature` 与 stream `block_signature` 一一对应；多轮回传 adapter 优先用 `source='original'`，缺则生成 deterministic（`'generated'`）。
3. Responses 的 reasoning item 既可独立成块（`kind:'reasoning'`）也可在 stream 中以 `kind:'reasoning_summary'` 增量表达。
4. `tool_use.namespace` 只在 mcp/CCX 工具上使用，普通 function tool 不带。
5. `image.source` 三形态（url/base64/file_id）在 IR 层统一。
6. MCP 探测工具（`list_mcp_/read_mcp_/write_mcp_/subscribe_mcp_`）在 **Responses adapter 入口**剥离，IR 规范化阶段不承担。

## 4. 适配器拆分（文件结构）

```
src/proxy/
  ir/
    types.ts            # P1.1 全部 IR 类型（零依赖）
    canonicalize.ts     # P1.2 IR 内部归一（messages 合并/tool_result 合并/image 三态/thinking↔reasoning/namespace 注册）
    stream-events.ts    # P1.1 CanonicalStreamEvent/BlockDelta
  adapters/
    index.ts            # P1.3 InboundAdapter/OutboundAdapter 接口（name/canHandle/encode/decode）
    inbound/{anthropic,openai-chat,openai-responses}.ts   # P1.4 wire→CanonicalRequest
    outbound/{anthropic,openai-chat,openai-responses}.ts  # P1.5 CanonicalRequest→wire
    response/           # P1.7 6 个 response converter（CanonicalResponse→wire 6 方向）
    ccx/namespace.ts    # P1.6 buildNamespaceToolContext + remapNamespaceFunctionCalls + decodeNs
  stream/
    inbound/{anthropic,openai-chat,openai-responses}.ts   # P1.8 SSE→CanonicalStreamEvent
    outbound/{anthropic,openai-chat,openai-responses}.ts  # P1.9 CanonicalStreamEvent→SSE
    capture.ts          # P1.10 captureSink 接口（rawLines/outLines 时间戳，与 capture.updateRequest 解耦）
    abort.ts            # P1.10 abortAndCancel 信号传播（保留 stream-converter.ts:37-46 契约）
  pipeline.ts           # P1.11 forwardPipeline 改造
```

**关键边界**：
- **inbound adapter**：wire body → CanonicalRequest（仅 decode）。Responses inbound 负责 MCP 探测工具剥离、5 种 item（message/function_call/function_call_output/computer_call_output/item_reference）归一。
- **outbound adapter**：CanonicalRequest → wire body（encode）。处理 reasoning 注入、tools 归一（含 `computer_20251124`↔`computer_use_preview` 映射、CCX `stripCodexClientOnlyTools`）、`max_tokens ≥ budget_tokens` 约束、namespace__name 展平/反展。
- **stream inbound/outbound**：SSE ↔ CanonicalStreamEvent。Anthropic outbound 负责 content_block 索引分配 + 补 stop + 签名时机。
- **pipeline**：`parseAndAuth → routeModel → processVisionFallback → inbound → canonicalize → outbound → forwardRequest → capture/usage/log`。

**替换策略**：新 `ir/`、`adapters/`、`stream/` 与旧 `translation.ts`、`stream-converter.ts` **共存**；新实现以旧函数名为 facade 入口，P1.15 feature flag 切流、回归通过后删旧实现。

## 5. P2–P5 公共接口（§12.3 并发前提）

P1 必须定好、供后续并发单元复用：

| 接口 | 职责 | 消费方 |
|------|------|--------|
| `CanonicalRequest` | 请求侧 IR 入口；`clientProtocol`+`logicalModel`+`resolvedModel` | P2 模板 override / P3 路由写 resolvedModel / P4 trace / P5 元数据回查 |
| `CanonicalMessage`/`CanonicalBlock` | 7 种块统一表达 | P2 模板插入点 / P4 逐块 trace |
| `ReasoningSpec` | 归一 reasoning 策略（enabled/effort/budget/type/summary/source/clientEffort） | P2 模板 override / P3 按等级筛 provider / P4 trace 决策来源 / P5 模型默认 reasoning |
| `CanonicalTool`/`CanonicalToolChoice` | 工具定义/选择（含 kind/namespace/builtIn） | P2 工具白名单 / P3 按能力过滤 / P5 模型工具能力 |
| `CanonicalResponse`/`UsageRecord` | 响应 IR；usage 区分 billable/total/cache/reasoning | P3 failover 决策 / P4 记账 / P5 成本 |
| `CanonicalStreamEvent`/`BlockDelta` | 流式 IR；blockId 稳定 + 签名独立事件 | P4 实时 trace/TTFT / P3 流中错误触发 failover |
| `RouteDecision` | `{providerId, providerType, apiBase, credentialHandle, resolvedModel, thinking:ReasoningSpec, streamPolicy, maxTokensOverride?}`；apiKey 不入 IR、stream 三态用枚举 | P1 pipeline / P3 failover / P4 trace / P5 元数据 |
| `RetryableError` | `(error, attemptCount, route) => {retryable, retryAfterMs?, reason?}`；429/503/超时可重试，400/401/422 不可，context_length_exceeded 可降级 | P3 failover 主信号 / P1 上游错误归一 / P4 retry 上报 |
| `GenerationSpec` | maxTokens/temperature/topP/stopSequences/stream | P2 generation override / P3 限流 |

## 6. PG Schema（P1.16）

以现有 `config/types.ts` 为基础，拆 snake_case、引入 priority/stream_policy 枚举、`credential_ref` 取代明文 api_key。

```sql
CREATE TYPE protocol_type AS ENUM ('anthropic','openai','openai-responses');
CREATE TYPE reasoning_effort AS ENUM ('low','medium','high','xhigh','max');
CREATE TYPE thinking_type AS ENUM ('enabled','disabled','adaptive','auto');
CREATE TYPE stream_policy AS ENUM ('default_true','passthrough','force_true','force_false');

CREATE TABLE providers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type protocol_type NOT NULL,
  api_base TEXT,                              -- 未设时由 type 推导默认
  credential_ref TEXT NOT NULL,               -- 加密 secret 或 vault ref，禁明文
  priority INTEGER NOT NULL DEFAULT 0,        -- 直连全局路由声明顺序，升序匹配首个
  enabled BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_providers_priority ON providers(priority) WHERE enabled;

CREATE TABLE provider_models (
  id BIGSERIAL PRIMARY KEY,
  provider_id BIGINT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  display_name TEXT,
  input_modalities TEXT[] NOT NULL DEFAULT '{text}',
  thinking_enabled BOOLEAN NOT NULL DEFAULT false,
  thinking_budget_tokens INTEGER CHECK (thinking_budget_tokens > 0),
  thinking_reasoning_effort reasoning_effort,
  thinking_type thinking_type,
  max_output_tokens INTEGER CHECK (max_output_tokens > 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,   -- 工具能力/上下文窗口/价格
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_id)
);
CREATE INDEX idx_provider_models_model_id ON provider_models(model_id);

CREATE TABLE adapters (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  inbound_type protocol_type NOT NULL,
  max_tokens_override INTEGER CHECK (max_tokens_override > 0),
  stream_policy stream_policy NOT NULL DEFAULT 'passthrough',
  enabled BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE adapter_model_mappings (
  id BIGSERIAL PRIMARY KEY,
  adapter_id BIGINT NOT NULL REFERENCES adapters(id) ON DELETE CASCADE,
  source_model_id TEXT NOT NULL,
  provider_model_id BIGINT NOT NULL REFERENCES provider_models(id),
  thinking_override JSONB,                    -- null = 继承 provider_model；存 ReasoningSpec 子集
  generation_overrides JSONB,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (adapter_id, source_model_id)
);
CREATE INDEX idx_adapter_mappings_adapter_id ON adapter_model_mappings(adapter_id);

CREATE TABLE vision_settings (                -- 单例
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider_model_id BIGINT NOT NULL REFERENCES provider_models(id),
  prompt TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE proxy_settings (                 -- 单例
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  proxy_key_hash TEXT,                        -- bcrypt/argon2，不存明文
  log_level TEXT NOT NULL DEFAULT 'info' CHECK (log_level IN ('debug','info','warn','error')),
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('zh','en')),
  port INTEGER NOT NULL DEFAULT 9000,
  capture_max_size INTEGER NOT NULL DEFAULT 1000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE usage_records (                  -- P4/P5 用
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL,
  trace_id TEXT,
  client_protocol protocol_type NOT NULL,
  provider_id BIGINT REFERENCES providers(id),
  provider_model_id BIGINT REFERENCES provider_models(id),
  adapter_id BIGINT REFERENCES adapters(id),
  logical_model TEXT NOT NULL,
  resolved_model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER,
  total_input_tokens INTEGER,
  latency_ms INTEGER,
  first_token_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('success','error','timeout')),
  error_class TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_records_provider_model ON usage_records(provider_model_id, created_at DESC);
CREATE INDEX idx_usage_records_request_id ON usage_records(request_id);
```

**迁移约束**：providers/adapters name 全库唯一；mapping source_model_id 同 adapter 内唯一；`thinking_override` JSONB 由应用层 validate；迁移期 ConfigStore 先 YAML→PG 导入再从 PG 读、双写过渡；直连 model 唯一性不强制（priority 决定顺序，兼容 legacy）；`credential_ref` 禁明文。

## 7. 测试移植策略

### 7.1 测试栈迁移（全部 it 共用）
`node:test → vitest`；路径 `../../src/ → ../src/`；assert API 机械转换（~734 `strictEqual`→`toBe`、~252 `ok`→`toBeTruthy`、~41 `deepStrictEqual`→`toEqual`、7 `throws`、5 `rejects`）；10 处 `global.fetch` mock → `vi.stubGlobal('fetch', fn)` + `afterEach(vi.unstubAllGlobals)`。零 fixture/零 snapshot/零外部资源。

### 7.2 分阶段（按风险递增）
- **阶段 A（低，~70 it，机械迁移）**：config/validator、config/parser、log/logger、status/tracker、lib/*、cli/*、adapter/router。仅栈迁移、断言不变；与 IR 解耦，可先行 PR。
- **阶段 B（中，~95 it，HTTP 路径改造）**：api/server、api/integration、api/server-timeout、adapter/handlers、usage-recording、status/usage-store。HTTP 测试改 `app.fetch(new Request(...))`；adapter/router 增 PG-backed 配置加载用例。
- **阶段 C（高，162 it，IR 重构契约）**：
  - C1 translation.test.ts 100 it → 拆 adapter-in(4 describe)+IR 归一(2)+adapter-out(4)+跨 adapter 黄金集成(1)；旧 100 it 保留为 `.legacy.test.ts` 副作用回归。
  - C2 stream-converter.test.ts 27 it → 6 个 SSE encoder describe + AbortSignal(3) + content_block 索引不变量；rawLines/outLines 断言改 captureSink 接口断言。
  - C3 vision 19 + vision-cache 20 it → fetch mock 触发点改在 canonicalize.ts image 三态归一前；逐 it 调 expect 触发点。
  - C4 ccx-strip(3)+ccx-comparison(7)+full-pipeline(7)=17 it → 抽 `golden-regression/ccx-compat.test.ts`，任何 adapter 改动必须先过此集。
- **阶段 D（集成回归）**：vision+translation 集成(39)确认 `<image_description>` 替换后 reasoning_content 位置；capture(27)验 captureSink 6 adapter 时间戳一致；router(6)验 PG-backed 与 YAML 行为一致。

### 7.3 行为等价不变量清单（移植红线）
1. Anthropic content_block 索引 0=thinking/1=text/2+=tool_use；
2. Anthropic 流式 text/tool/finish_reason 前必先发 `content_block_stop`(thinking)；
3. 签名在 thinking_delta 之后、content_block_stop 之前；
4. Responses `reasoning_text.delta/done` 与 message_stop 聚合 summary 分别表达；
5. Anthropic→OpenAI 流式 signature 仅累积、message_delta 带 stop_reason 才落盘；
6. usage 计费输入 = input_tokens − cache_read − cache_creation（含缓存 total 单独存）；
7. `makeSignature(text)=SHA-256(text).hex[:16]` 在无 upstream signature 时生成；
8. Responses 入口 MCP 探测工具剥离语义保留；
9. CCX namespace__name 编码/解码双向一致；
10. stream_policy：`passthrough` 不注入、`default_true` client 未传时注入 true、`force_true/false` 强制覆盖。

## 8. P1 子任务拆解

| 子任务 | 内容 | 性质 |
|--------|------|------|
| P1.1 | `ir/types.ts` + `ir/stream-events.ts`（全部 IR 类型，零依赖） | 纯类型，独立 PR |
| P1.2 | `ir/canonicalize.ts`（IR 内部归一，纯函数） | 独立 PR |
| P1.3 | `adapters/` 公共接口 + RouteDecision/RetryableError/GenerationSpec/UsageRecord（P2–P5 并发基础） | 接口 |
| P1.4 | 3 个 inbound adapter（对照 translation.test inbound 用例） | 实现 |
| P1.5 | 3 个 outbound adapter（reasoning 注入/tools 归一/约束） | 实现 |
| P1.6 | `ccx/namespace.ts` 抽取 | 重构 |
| P1.7 | 6 个 response converter | 实现 |
| P1.8 | 3 个 stream inbound encoder | 实现 |
| P1.9 | 3 个 stream outbound encoder（索引分配/补 stop/签名时机） | 实现 |
| P1.10 | `stream/capture.ts` + `abort.ts` | 实现 |
| P1.11 | `pipeline.ts` forwardPipeline 改造（保留旧 facade） | 集成 |
| P1.12 | 测试迁移阶段 A+B（~165 it 机械迁移） | 独立 PR |
| P1.13 | 测试迁移阶段 C（translation/stream/vision/ccx 拆解） | 高风险 |
| P1.14 | ccx golden-regression 集 | 回归基线 |
| P1.15 | feature flag 切流 + 新旧双跑 + 删旧实现 | 切流 |
| P1.16 | PG schema migration + ConfigStore 双写（YAML→PG 导入） | 持久化 |
| P1.17 | 文档/CLAUDE.md 更新 + 实测对齐测试数（329 vs 343） | 收尾 |

**并行性**：P1.1→P1.2→P1.3 是关键路径（先定类型/接口）；P1.4–P1.10 在接口定好后**可并行**（inbound/outbound/stream 各派 subagent）；P1.12 测试栈迁移与 IR 重构解耦，可先行。

## 9. 风险

- **content_block 索引迁移**：IR 化后由 Anthropic outbound 分配 index，任何忘补 stop 的边界会被客户端拒绝——回归严格覆盖。
- **签名多轮一致**：`makeSignature` 依赖完整 thinking 文本；流式累加与终态不一致会致签名变化——IR 层强制 `source` 字段。
- **Responses→Anthropic 空签名**（legacy line 1636-1694）：IR 规范化阶段强制 `thinking.signature` 非空或 `source='none'` 显式标注。
- **直连路由顺序**：providers 改 priority 升序；导入老 YAML 须按数组下标显式写 priority，否则匹配顺序变。
- **stream 三态语义**：IR 用 boolean + `RouteDecision.streamPolicy`；漏改点会破坏"client 未传默认注入 true"的向后兼容。
- **vision fallback 触发点**：从 translation 层移到 canonicalize 层；grep `processVisionFallback` 全量同步，vision.test 19 it 逐 it 调 mock 入口。
- **Responses 5 种 item**：`item_reference` 涉跨会话资源引用，可能丢失——专门回归用例。
- **MCP 探测工具剥离归属**：必须留在 Responses inbound 入口，不能在 IR 规范化阶段（会污染 Chat/Anthropic）；grep `list_mcp_` 验证。
- **CCX namespace 边界字符**（`__`/`.`/`/`）：在测试集固定。
- **YAML→PG 双写漂移**：单一 ConfigStore 事务保证读取一致（要么全 YAML 要么全 PG）。
- **Responses reasoning item 归属**：adapter 须区分实时 `reasoning_text.delta` 与终态 `reasoning.summary`，避免重复/漏签名。
- **测试数差异**：CLAUDE.md 329 vs 实测 343（差 14 it）；P1.17 前实测对齐。
- **tool input 增量累加**：adapter 用 blockId→Chat index / Responses output_index 双向映射表，错映射致工具参数错位。
- **computer_use_preview↔computer_20251124**：IR 化后 Computer Use 是 tool_use.block.computer，Responses 输出 computer_call；漏改会在 Chat 路径变普通 function 调用。

## 10. 切流与回退

- 新旧实现共存，以旧函数名为 facade；**feature flag** 控制默认路径（旧 translation/stream-converter vs 新 ir/adapters/stream）。
- 切流期 CI **同时跑新旧两套测试**；回归全过后切默认，再删旧 `translation.ts`/`stream-converter.ts`。
- ConfigStore 双写过渡：启动优先读 PG、回退 YAML；CLI 修改入口走 PG 时同步写 YAML 备份；保留旧 CLI 配置路径 1 个 minor 版本。
