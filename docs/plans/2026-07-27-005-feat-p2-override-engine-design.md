---
title: P2 声明式请求覆写引擎设计
date: 2026-07-27
seq: 2026-07-27-005
type: design
status: proposed（待评审后进入实施）
execution: code
phase: P2
related:
  - docs/plans/2026-07-27-002-master-axonhub-class-gateway-plan.md（主计划 §8 P2）
  - docs/research/axonhub-analysis.md（override 引擎分析）
  - docs/plans/2026-07-27-003-feat-p1-protocol-core-design.md（IR/管线/PG 基线）
  - docs/plans/2026-07-27-001-feat-reasoning-templates-and-model-capabilities-plan.md（已被主计划取代，仅作原始动机参考）
  - docs/adr/0004-pg-only-best-in-class-stack.md
---

# P2 声明式请求覆写引擎设计

> 本文档回答 P2「推理 canonical + override 引擎」的八个设计问题：覆写什么、覆写在哪配置、优先级、应用点、reasoning 模板机制、PG schema 改动、测试策略、子任务拆解。
>
> 设计基线：P1 已完成 `CanonicalRequest` / `ReasoningSpec`（`src/proxy/ir/types.ts`）+ `applyRouteDecision`（`src/proxy/pipeline.ts`，reasoning 透传、maxTokens/stream 已应用）+ `RouteDecision`（`src/proxy/adapters/index.ts`，携带 `thinking: ReasoningSpec` 与 `maxTokensOverride`）+ outbound 内字段级合并（`src/proxy/adapters/outbound/anthropic.ts:33`，`route.budget > route.effort 查表 > client.effort 查表 > client.budget`）+ PG schema（`src/db/schema/{providers,adapters}.ts`：`provider_models.thinking_*` + `adapter_model_mappings.{thinking_override, generation_overrides} JSONB`）。

## 0. 摘要

P2 的核心是「**域内类型安全 + 通用声明式**」双层覆写引擎：

1. **域内覆写（reasoning）**：可复用推理模板表（`reasoning_templates`）+ per-mapping 默认等级 + per-model 值映射 + 客户端优先 / 兜底合并。**AxonHub 没有，我们要的核心**。
2. **通用覆写（generation + 上游私有字段）**：3 操作（`set` / `set_if_absent` / `delete`）+ 条件 + 模板变量，先作用于 canonical IR 字段（generation.*），再作用于 outbound encode 后的 wire body（上游私有字段）。**AxonHub 风格简化版**。
3. **应用点**：在 `pipeline.ts` 的 `applyRouteDecision` 之后、outbound encode 之前插入新步骤 `applyOverrides`；出站适配器只做「IR → wire 渲染」，不再做字段级优先级合并（统一上提）。
4. **PG schema**：新增 `reasoning_templates` 表 + `provider_models.reasoning_template_id` FK + `adapter_model_mappings.default_reasoning_level` + `adapters.level_map`，原 `thinking_*` / `thinking_override` / `generation_overrides` 字段保留作为「内联/显式」回退路径。
5. **P2 范围**：覆写对象 = reasoning + generation（含受保护字段白名单 + Anthropic budget 钳制）。工具、数组重命名/复制/插入等复杂操作延后到 P7 协议扩展或独立计划。

---

## 1. 背景与目标

### 1.1 背景

主计划 G1 + G2 是 P2 立项依据：

- **G1 推理等级 canonical 化**：跨协议（anthropic / openai / openai-responses）无损传递推理等级。P1 已搭出 `ReasoningSpec`（5 级 effort + budget + type + summary + source + clientEffort），但**字段级合并散落在 outbound 适配器**（anthropic outbound 行 33 一处硬编码的 `route.budget > route.effort > client.effort > client.budget`），openai / openai-responses outbound 的合并路径与钳制策略尚未对齐。
- **G2 声明式参数注入**：per-provider/model 在转发请求里注入任意参数（含上游私有字段），支持条件与模板变量。**llm-proxy 完全没有此能力**。

原始动机（`2026-07-27-001` 计划，被主计划取代）：

- 把"消费层手配 reasoning 参数"上移到 **Provider 模型层的可复用推理模板**。
- 适配器持**默认统一等级 + 消费层等级映射**，暴露 `thinkingLevelMap` 给消费端做发现。
- 模板与协议脱钩、同模板多 provider 共享。

本设计在主计划 G1 + G2 框架下，**吸纳原始计划的核心机制**（模板 / 默认等级 / 消费层映射 / thinkingLevelMap），同时对齐 P1 已落地的 IR + RouteDecision + PG schema。

### 1.2 目标

- **OG1 统一合并点**：把"reasoning 字段级合并"从 outbound 适配器上提到 P2 覆写引擎；outbound 只做 IR → wire 渲染。
- **OG2 模板机制**：新增 `reasoning_templates` 顶层可复用实体；`provider_model` 按名引用；映射层持有默认等级；适配器层持有消费层映射。
- **OG3 通用覆写**：3 操作（`set` / `set_if_absent` / `delete`）+ 条件 + 模板变量；同时支持 IR 字段（`generation.*`）与 wire body 字段（上游私有）。
- **OG4 客户端优先 + 配置兜底**：reasoning 默认行为沿用原始计划 R13（"客户端优先 + 适配器默认兜底"），由模板解析为上游参数；generation 走通用覆写，默认操作语义为 `set_if_absent`。
- **OG5 钳制与保护**：Anthropic `budget_tokens < max_tokens` 钳制（沿用 legacy）；受保护字段（`model` / `messages` / `stream` / `max_tokens` 等）拒绝任意根覆盖。
- **OG6 投影可发现**：暴露 `projectThinkingLevelMap(template, levelMap, targetProtocol) → Record<ConsumerLevel, ScalarOrNull>` 纯函数，供 P5 `GET /{adapter}/v1/models` 端点调用。

### 1.3 非目标

- **多租户/权限**：与主计划一致，单用户场景，模板与映射不做 RBAC。
- **tool_use / tool_result 覆写**：P2 范围仅 reasoning + generation。工具白名单/重命名延后到 P7 或独立计划。
- **数组操作（rename / copy / array_append / array_prepend / array_insert / array_remove）**：AxonHub 9 操作中的 6 个延后；P2 仅保留 3 操作。
- **Admin UI 与 Admin API**：本设计只定义数据模型与运行时；UI/API 由 P6 收尾。
- **正则模型映射 + 上游 `/v1/models` 自动同步**：P5 范围，不在本设计。
- **CCX namespace 工具合并**：沿用 P1 既有逻辑（`src/proxy/ir/canonicalize.ts` 的 namespace 展平），P2 不重新规整。

---

## 2. 现状与断点

> 全部以 `src/` 实际代码为准；行号基于 2026-07-27 的 P1 完成态。

### 2.1 IR 已就位（`src/proxy/ir/types.ts`）

```ts
interface ReasoningSpec {
  enabled?: boolean;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';  // 5 级；xhigh/max 是 Anthropic 'max' 的哨兵
  budgetTokens?: number;
  type?: 'enabled' | 'disabled' | 'adaptive' | 'auto';
  summary?: 'auto' | 'concise' | 'detailed' | string;
  source: 'client' | 'route' | 'override';   // 决策可观察（trace 用）
  clientEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

interface GenerationSpec {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  stream: boolean;  // 必显，streamPolicy 解析后已确定
}
```

### 2.2 路由已就位（`src/proxy/adapters/index.ts` + `src/proxy/router.ts`）

```ts
interface RouteDecision {
  providerId: string;
  providerProtocol: ClientProtocol;
  apiBase: string;
  credentialHandle: string;
  resolvedModel: string;
  thinking: ReasoningSpec;        // 路由层 resolve 完毕
  streamPolicy: StreamPolicy;
  maxTokensOverride?: number;
}
```

- `routeModel`（直连）：`thinking = model.thinking`，`streamPolicy = 'default_true'`，无 `maxTokensOverride`。
- `resolveAdapterRoute`（适配器）：`thinking = mapping.thinking ?? model.thinking`，`streamPolicy = adapterStreamToPolicy(adapter.stream)`，`maxTokensOverride = adapter.max_tokens`。

**P1 既有 `thinking` 来源**：

| 来源 | 字段 | 备注 |
|------|------|------|
| `provider_models.thinking_enabled` | `enabled` | 模型是否原生支持思考 |
| `provider_models.thinking_budget_tokens` | `budgetTokens` | 静态预算 |
| `provider_models.thinking_reasoning_effort` | `effort` | 5 级 effort |
| `provider_models.thinking_type` | `type` | 透传型 thinking.type |
| `adapter_model_mappings.thinking_override` | `thinking` | JSONB，整段覆盖（null = 继承 provider_model） |
| `adapters.max_tokens` | `route.maxTokensOverride` | 路由级 max_tokens 兜底 |

### 2.3 管线（`src/proxy/pipeline.ts`）

```text
parseAndAuth
  → routeModel（RouteDecision）
    → INBOUND decode（wire → CanonicalRequest）
      → normalizeRequest（IR 归一）
        → applyRouteDecision（resolvedModel / stream / maxTokens 应用；reasoning 透传）
          → OUTBOUND encode（CanonicalRequest → wire body）
            → fetch 上游
```

**关键事实**（`src/proxy/pipeline.ts:193` `applyRouteDecision` 注释原文）：

> reasoning: 保留客户端 reasoning 原样透传；字段级优先级（route > client）由各出站适配器按目标协议解析。

**这是 P2 要打掉的散点**。

### 2.4 出站端的字段级合并（`src/proxy/adapters/outbound/anthropic.ts:33`）

```ts
// 优先级：route.budget > route.effort 查表 > client.effort 查表 > client.budget
const effortBudget: Record<string, number> = { low: 1024, medium: 4096, high: 16384, xhigh: 32768, max: 65536 };
const budget = cfg.budgetTokens
  ?? (cfg.effort ? effortBudget[cfg.effort] : undefined)
  ?? (client?.effort ? effortBudget[client.effort] : undefined)
  ?? client?.budgetTokens;
const max = Math.max(req.generation.maxTokens ?? route.maxTokensOverride ?? 16384, budget ?? 0);
if (budget) body.thinking = { type: 'enabled', budget_tokens: budget };
else if (cfg.type) body.thinking = { type: cfg.type };
```

**问题**：

1. 合并规则**硬编码在 anthropic outbound**；openai / openai-responses outbound 是否各自实现合并未核实（`grep REASONING_EFFORT_TO_BUDGET` 在 `src/proxy/` 未找到第二个文件持有 `effortBudget` 表）—— 行为口径不一致。
2. `effort↔budget` 表是 anthropic **专属**，但模板与 effort 应协议无关（同一 effort 跨协议映射到不同参数集）。
3. `client?.budgetTokens` 排在最后，未与 `cfg` 字段对齐（如 `cfg.type='disabled'` 显式禁 → 应清掉 `client.budgetTokens`）。
4. 没有 `max_tokens ≥ budget_tokens` 的钳制对 Responses 路径生效（只有 anthropic 的 `max = max(req.generation.maxTokens ?? route.maxTokensOverride ?? 16384, budget ?? 0)`，但 `Math.max` 实际只放大不缩小）。

### 2.5 原始计划 001 的核心机制（动机）

| 机制 | 位置（原始计划） | 本设计处理 |
|------|------------------|------------|
| 7 级统一 effort `off\|minimal\|low\|medium\|high\|xhigh\|max` | KTD1 | **缩减为 6 级**：`off\|minimal\|low\|medium\|high\|xhigh\|max` 视情况或直接保留 5 级 effort + 单独的 `off` 开关，**需用户拍板**（见 §10 OQ-A） |
| 顶层可复用 `reasoningTemplates` 实体 | KD1 / KTD1 | **采纳**，新增 `reasoning_templates` 表 |
| `Provider 模型.reasoningTemplate`（按名引用） | R1 | **采纳**，新增 `provider_models.reasoning_template_id` FK |
| 能力事实（`contextWindow` / `maxTokens` / `input` / `reasoning`） | R5 | 部分已落 PG（`max_output_tokens` / `input_modalities` / `thinking_enabled`），`contextWindow` 暂存 `metadata` JSONB，待 P5 收口 |
| 适配器 `defaultReasoningLevel` | R7 / KTD1 | **采纳**，新增 `adapter_model_mappings.default_reasoning_level` |
| 消费层映射 `levelMap`（适配器层） | R9 / KD3 | **采纳**，新增 `adapters.level_map` JSONB（消费端等级名 → 统一等级） |
| 客户端优先 + 兜底 | R13 / KD4 | **采纳** |
| `thinkingLevelMap` 投影（消费端发现） | R10 / R12 / KTD4 | **采纳**：定义纯函数 `projectThinkingLevelMap`，端点接入延后到 P5 |
| R4 受保护字段白名单 | R4 | **采纳**：通用覆写引擎强制保护；列表见 §6.2 |
| `off` 清理 / `budget ≥ max_tokens` 钳制 | R15 / KTD3 | **采纳**：移入 P2 覆写引擎统一执行 |
| 硬报错 + CLI 迁移（旧 `thinking` / 旧直接字段） | KTD2 / R17 / R18 | **推迟到配置切换点**：P1 双写过渡期不硬报错；切换点（1.0.0 发布或 P6）一并 hard-fail + CLI 迁移 |

### 2.6 AxonHub 覆写引擎的取舍（`docs/research/axonhub-analysis.md`）

| AxonHub 特性 | P2 处理 |
|--------------|---------|
| 9 操作（`set` / `set_if_absent` / `delete` / `rename` / `copy` / `array_append` / `array_prepend` / `array_insert` / `array_remove`） | **简化为 3 操作**（`set` / `set_if_absent` / `delete`）；其余延后到 P7 或独立计划 |
| 作用于原始 wire body（sjson / gjson 路径改写） | **两层**：先 IR 字段（`generation.*` / `reasoning.*`），再 wire body（outbound encode 之后，覆盖上游私有字段） |
| Go `text/template` 渲染 value/condition，变量 `.RequestModel / .Model / .Metadata / .RequestHeader / .ReasoningEffort` | **自研**：用轻量模板引擎（建议 Nunjucks 或自写 `{{var}}` 替换），变量同 AxonHub 但精简为：`{{model}}` / `{{provider}}` / `{{clientProtocol}}` / `{{providerProtocol}}` / `{{resolvedModel}}` / `{{reasoning.effort}}` / `{{reasoning.budgetTokens}}` / `{{requestId}}` / `{{traceId}}` |
| condition 渲染后 `=='true'` 才执行 | **自研**：`condition` 字符串支持 `==` / `!=` / `in` / `&&` / `\|\|` 的子集；其余靠 Nunjucks `{% if %}` 块。详细见 §6.3 |
| 安全边界：`path='stream'` 拒绝 | **采纳并扩展**：受保护字段白名单（见 §6.2）|
| 顶层 `ReasoningEffort` 中间表示 + 4 协议互转 | 已在 P1 落地（5 级 effort + `xhigh`/`max` 哨兵）；P2 不重做 IR |
| **没有**：可复用推理模板（等级→参数组）一等对象 | **本设计核心**（§5） |
| **没有**：把"等级→下游值"映射表（`thinkingLevelMap`）暴露给消费端 | **本设计核心**（§5.6） |

---

## 3. P2 范围界定

### 3.1 范围内（P2 必须交付）

| 项 | 形态 | 备注 |
|----|------|------|
| `reasoning_templates` 表 + 引用 | PG schema | 顶层可复用实体；name 唯一 |
| 域内覆写：reasoning | 强类型 `ReasoningSpec` | 含模板解析、值映射、默认兜底、budget 钳制 |
| 通用覆写：generation | `set` / `set_if_absent` / `delete` | IR 字段层（`generation.*`） |
| 通用覆写：上游私有字段 | 同一引擎，作用于 wire body | outbound encode 之后；可选开关 |
| 模板变量 + 条件 | 轻量模板引擎 | 限定白名单 + 拒绝受保护字段 |
| 受保护字段白名单 | 强制 | `model` / `messages` / `input` / `instructions` / `system` / `stream` / `tools` / `max_tokens` / `max_output_tokens` |
| `applyOverrides` 管线步骤 | 纯函数 | 插在 `applyRouteDecision` 之后、outbound encode 之前 |
| `projectThinkingLevelMap` 纯函数 | 复用入口 | P5 调用；不在本计划交付端点 |
| 单测 + 黄金回归 | Vitest | 多层合并 / 优先级 / 模板解析 / 端到端协议输出 |

### 3.2 范围外（明确不做）

- **工具覆写**（tool_use 白名单 / tool_choice 强制 / 工具描述重写）：不做。理由：与 reasoning/generation 解耦；改动量大；与 P1 namespace 机制耦合；P7 协议扩展或独立计划。
- **数组操作**（rename / copy / array_*）：不做。理由：单用户场景下 3 操作 + 受保护白名单已覆盖 90% 需求；AxonHub 9 操作中的剩余 6 个复杂度高、收益低。
- **Admin UI / Admin API**：不做。P6 收尾；本设计提供 PG schema + ConfigStore 接入 + 投影纯函数作为接口。
- **`GET /{adapter}/v1/models` capabilities 端点**：不做。P5 模型管理范围；本设计通过 `projectThinkingLevelMap` 提供纯函数。
- **`/v1/models` 上游自动同步 + 能力发现**：不做。P5 范围。
- **正则模型映射 + 响应模型名还原**：不做。P5 范围。
- **failover 引入的覆写**：不做。P3 范围；P2 不假设覆写参与 failover 重试。
- **多租户 / 模板权限隔离**：不做。主计划已永久跳过。

### 3.3 范围与主计划 §8 P2 的关系

| 主计划 P2 子项 | 本设计归位 |
|----------------|------------|
| canonical reasoning 字段 + 三协议归一/渲染 | **P1 已完成**（`ReasoningSpec` + 三协议 outbound），P2 不重做 IR |
| xhigh 哨兵 | **P1 已完成**，P2 不动 |
| 模型名后缀解析（`gpt-5-high`） | **P2 推迟**：与"客户端优先"语义有冲突（客户端先发、后缀改写会反向覆盖），建议延后到独立计划或作为 P2.5 |
| per-provider/model reasoning 值映射 | **P2 核心**（§5.4） |
| effort↔budget 表 | **P2 重定位**：从 anthropic outbound 上提为协议无关的模板参数集（`reasoning_templates.levels[*].set`） |
| override 引擎（3 操作 + 模板 + 条件） | **P2 核心**（§6） |

---

## 4. 总体架构

### 4.1 双层覆写模型

```
                         ┌─────────────────────────────┐
                         │  域内覆写（reasoning）       │  ← 类型安全，可投影
                         │  - 模板解析                  │
                         │  - 值映射（per-model）        │
                         │  - 默认兜底                  │
                         │  - budget 钳制              │
                         └──────────────┬──────────────┘
                                        │  resolvedReasoning: ReasoningSpec
                                        ▼
   inbound ─► canonical ─► normalizeRequest ─► applyRouteDecision ─► applyOverrides ─► outbound encode ─► fetch
                                                  (P1)              ┌──────────┐
                                                                    │ 通用覆写  │  ← 3 操作 + 条件 + 模板
                                                                    │  - IR 层  │     generation.*
                                                                    │  - body 层│     （可选）上游私有
                                                                    └──────────┘
```

- **域内覆写**只改 `canonical.reasoning`（强类型），是覆写引擎的前置"语义翻译层"。
- **通用覆写**分两段：
  1. **IR 段**（必选）：操作 canonical 字段（`generation.*`），纯函数。
  2. **Body 段**（可选，默认开）：操作 outbound encode 之后的 wire body，覆盖上游私有字段。需要 P2.3 决定是否开箱即用（见 §10 OQ-B）。

### 4.2 文件结构

```
src/proxy/
  override/                              # P2 新增模块
    types.ts                             # OverrideContext / OverrideRule / OverrideOp / TemplateVar
    templates.ts                         # reasoning_templates 解析（含 projectThinkingLevelMap）
    value-map.ts                         # client effort → target-supported effort
    engine.ts                            # applyOverrides(canonical, ctx) → canonical
    body-engine.ts                       # applyBodyOverrides(body, ctx) → body
    conditions.ts                        # 条件表达式解析/求值
    template-vars.ts                     # 模板变量渲染（白名单）
    path.ts                              # 路径解析/写入（IR 与 body 两套实现）
  ir/
    types.ts                             # 不动
    canonicalize.ts                      # 不动
  adapters/
    index.ts                             # RouteDecision 加 overrides? 字段
    inbound/{anthropic,openai-chat,openai-responses}.ts   # 不动
    outbound/
      anthropic.ts                       # **删除**字段级合并；只做 IR → wire 渲染（reasoning 写入由通用 body-engine 兜底或保留最小写入）
      openai-chat.ts                     # 同上
      openai-responses.ts                # 同上
  pipeline.ts                            # applyRouteDecision 之后插入 applyOverrides；outbound encode 之后插入 applyBodyOverrides（可选）
  router.ts                              # routeModel / resolveAdapterRoute 增加 override 上下文解析
  config/
    store.ts                             # 加载 reasoning_templates / 适配器 level_map 等
  db/
    schema/
      reasoning-templates.ts             # 新增
      adapters.ts                        # adapters.level_map / adapter_model_mappings.default_reasoning_level
      providers.ts                       # provider_models.reasoning_template_id
      enums.ts                           # 新增 reasoning_effort_7 枚举（或保留 5 级 + off 开关，见 OQ-A）
```

### 4.3 关键边界

- **override 引擎是纯函数**：所有配置在 router 阶段打包进 `OverrideContext`（沿用 P1 的"router 把一切准备好"的契约），pipeline 不再做 DB 查询。
- **出站适配器只做"渲染"**：不再做字段级合并；`canonical.reasoning` 已经是最终值；outbound 只需按目标协议写字段（anthropic 写 `thinking`、openai 写 `reasoning_effort`、responses 写 `reasoning`）。这样三协议口径一致。
- **受保护字段在路径解析前硬拒**：通用引擎的 `path` 必须不在白名单内，否则 `OVERRIDE_REJECTED_PROTECTED_FIELD`。
- **body 段是可选层**：默认开但允许配置 `override.body_layer_enabled: false` 关掉（用于"我不想动上游私有字段"）。

---

## 5. 域内覆写：reasoning

### 5.1 数据模型

#### 5.1.1 推理模板（顶层可复用）

```ts
interface ReasoningTemplate {
  /** 全库唯一名。 */
  name: string;
  /** 模板说明（admin UI 用，运行时忽略）。 */
  description?: string;
  /**
   * 等级 → 上游参数集。null = 显式 off（不注入推理字段）；
   * 缺省键 = 兜底由 value-map 决定降级。
   * set 形状约束：
   *  - Anthropic 协议：允许 budget_tokens、type；不允许 model/messages/stream/max_tokens 等受保护字段
   *  - OpenAI Chat：允许 reasoning_effort
   *  - OpenAI Responses：允许 reasoning.effort、reasoning.summary
   *  - 跨协议：可写多个协议的字段，outbound 只取目标协议需要的
   */
  levels: Partial<Record<UnifiedEffort, ReasoningTemplateLevel | null>>;
  /** 是否启用。 */
  enabled: boolean;
}

interface ReasoningTemplateLevel {
  /**
   * 协议无关的"参数集"。运行时按目标 providerProtocol 投影到具体协议字段。
   * 例如：
   *   anthropic:    { thinking: { type: 'enabled', budget_tokens: 16384 } }
   *   openai:       { reasoning_effort: 'high' }
   *   openai-responses: { reasoning: { effort: 'high', summary: 'auto' } }
   * 允许的顶层键白名单：见 §5.1.4。
   */
  set: ReasoningTemplateSet;
}

interface ReasoningTemplateSet {
  anthropic?: { type?: ThinkingType; budget_tokens?: number };
  openai?: { reasoning_effort?: ReasoningEffort };
  'openai-responses'?: { effort?: ReasoningEffort; summary?: string };
}
```

#### 5.1.2 per-mapping 默认等级

```ts
interface AdapterModelMapping {
  // ... P1 字段 ...
  defaultReasoningLevel: UnifiedEffort;  // 默认 'medium'（与原始计划 R7 对齐）
  // ... P1 thinking_override JSONB 保留（见 §5.2 优先级）...
}
```

#### 5.1.3 per-model 值映射

```ts
// 存于 provider_models.metadata.reasoning_effort_mapping（JSONB 数组）
type EffortMapping = Array<{ from: UnifiedEffort; to: UnifiedEffort }>;
// 例：xhigh → high（该模型不支持 xhigh），low → minimal（该模型 low 档位为 minimal）
// 命中规则：首匹配；未命中透传
```

> **设计选择**：值映射放在 `provider_models.metadata` JSONB 内，**不新增字段**。理由：值映射是 provider_model 维度的派生映射，与 `thinking_*` 静态字段不同，且原始计划 R5 把"能力事实"统一定位在 metadata。但用户可要求独立字段（见 OQ-C）。

#### 5.1.4 模板 set 允许的顶层键白名单

```ts
const REASONING_TEMPLATE_SET_ALLOWED_KEYS: Record<ClientProtocol, ReadonlySet<string>> = {
  anthropic: new Set(['thinking', 'type']),     // type = thinking.type 透传
  openai: new Set(['reasoning_effort']),
  'openai-responses': new Set(['reasoning', 'summary']),
};
```

`thinking` 内允许 `type` / `budget_tokens`；`reasoning` 内允许 `effort` / `summary`。**受保护字段**（`model` / `messages` / `input` / `instructions` / `system` / `stream` / `tools` / `max_tokens` / `max_output_tokens`）在 `reasoning.set` 内同样拒绝（原始计划 R4）。

### 5.2 优先级与合并规则

`resolveReasoningPolicy(canonical, route, ctx)` 的决策树（伪代码）：

```text
function resolveReasoningPolicy(req, route, ctx) {
  const hasClient = !!req.reasoning && (req.reasoning.enabled !== false);
  const explicitOff = hasClient && (
    req.reasoning.type === 'disabled'
    || req.reasoning.effort === 'none'   // 不在 5 级枚举里，由 7 级扩展；见 OQ-A
    || req.reasoning.enabled === false
  );

  // [步骤 0] 显式关闭语义（按 R13：客户端显式 off → 尊重，不注入）
  if (explicitOff) {
    return { enabled: false, source: 'client' };
  }

  // [步骤 1] 解析有效默认等级（适配器映射级 > 模型级 > 适配器级）
  const defaultLevel = ctx.defaultReasoningLevel ?? 'medium';

  // [步骤 2] 决定 effective effort
  let effective: UnifiedEffort;
  if (hasClient && req.reasoning.effort) {
    // 客户端携带 effort → 走值映射（per-model 降级）
    effective = ctx.valueMap
      .find(m => m.from === req.reasoning.effort)?.to
      ?? req.reasoning.effort;
  } else if (hasClient && (req.reasoning.budgetTokens || req.reasoning.type)) {
    // 客户端携带 budget/type 但无 effort → 尊重原样（直传）
    return { ...req.reasoning, source: 'override' };
  } else {
    // 未携带 → 套用默认等级
    effective = defaultLevel;
  }

  // [步骤 3] 模板解析
  if (effective === 'off' || !ctx.template?.levels[effective]) {
    return { enabled: false, source: 'override' };  // off / 模板未定义该档
  }
  const level = ctx.template.levels[effective]!;
  const set = level.set[route.providerProtocol];
  if (!set) {
    return { enabled: false, source: 'override' };  // 模板该档未给该协议
  }

  // [步骤 4] 组装最终 ReasoningSpec
  const result: ReasoningSpec = inferReasoningSpecFromSet(set, route.providerProtocol);
  result.source = hasClient ? 'override' : 'route';
  if (hasClient) result.clientEffort = req.reasoning.effort;
  return result;
}
```

**优先级**（高 → 低，**后者覆盖前者**）：

1. **客户端显式 off**（`type='disabled'` / `enabled=false` / 7 级 `off`）：`source='client'`，不注入。
2. **客户端携带 reasoning 但未给 effort**（只给 `budgetTokens` 或 `type`）：直传，`source='override'`。
3. **客户端携带 effort + 值映射命中**：用映射后的 effort 查模板。
4. **客户端携带 effort + 值映射未命中**：原 effort 查模板。
5. **客户端未携带**：用 `mapping.defaultReasoningLevel`（默认 `medium`）查模板。
6. **模板无该档位 / 该协议未配 set**：等价于 off。

**与 P1 现状（outbound anthropic 行 33）的差异**：

| 维度 | P1 现状 | P2 |
|------|---------|-----|
| 合并位置 | outbound anthropic 硬编码 | 域内覆写器；outbound 只渲染 |
| effort↔budget 表 | anthropic-only `effortBudget`（5 级） | 模板协议无关 set；anthropic 的 budget 由模板 `{thinking:{budget_tokens:16384}}` 显式给 |
| 值映射 | 无 | `provider_models.metadata.reasoning_effort_mapping`（首匹配） |
| 客户端 budget 透传 | 落到最后兜底 | 步骤 2 显式尊重，标注 `source='override'` |
| budget 钳制 | anthropic: `Math.max(max, budget)`（**只放大不缩小**，反语义） | 显式 `budget = min(set.budget_tokens, maxTokens - 1)`（与原始计划 KTD3 一致） |

### 5.3 模板引用链

```text
adapter_model_mapping
  ├── defaultReasoningLevel  (P2 新增；默认 'medium')
  ├── thinking_override       (P1 保留：内联显式 ReasoningSpec 子集，最高优先级)
  ├── generation_overrides    (P1 保留：通用覆写规则列表)
  └── provider_model_id
        └── reasoning_template_id  (P2 新增：FK → reasoning_templates.name)
        └── reasoning_effort_mapping  (P2 新增：metadata JSONB)
        └── thinking_*  (P1 内联：模型静态默认)
```

**优先级冲突解决**（"explicit override > template"）：

- `mapping.thinking_override` JSONB 若非空，**整段覆盖**模板解析结果（作为"内联显式"回退路径，向后兼容 P1 YAML/PG 数据）。
- 否则走模板解析（§5.2）。

### 5.4 值映射（per-provider/model）

```ts
// 入参：客户端 effort + provider_model 的 reasoning_effort_mapping
// 出参：effective effort
function applyValueMapping(effort, mapping): UnifiedEffort {
  if (!mapping || mapping.length === 0) return effort;
  const hit = mapping.find(m => m.from === effort);
  return hit ? hit.to : effort;
}
```

- **存哪**：`provider_models.metadata.reasoning_effort_mapping`（JSONB 数组）。或在 schema 加独立列（见 OQ-C）。
- **命中规则**：首匹配 + 未命中透传（与 AxonHub `ReasoningEffortMapping` 一致）。
- **安全**：仅在客户端携带 effort 时生效；纯 budget/type 透传不走值映射。
- **应用点**：§5.2 步骤 3。

### 5.5 budget 钳制

```ts
function clampBudget(budget: number, maxTokens: number | undefined): number {
  // Anthropic 要求 budget_tokens < max_tokens；max_tokens 未给时上限 = 16384（legacy 兜底）
  const cap = (maxTokens ?? 16384) - 1;
  return Math.max(0, Math.min(budget, cap));
}
```

- **仅 anthropic 协议生效**（openai / openai-responses 不需要钳制）。
- **应用点**：域内覆写器返回最终 `ReasoningSpec` 后，pipeline 写入 `reasoning.budgetTokens` 前。
- **错误处理**：`budget > maxTokens` 不报错，**静默钳制并打 warn 日志**（不破坏客户端体验；如需硬报错，配置 `override.budget_clamp_strict: true`，见 OQ-D）。

### 5.6 `thinkingLevelMap` 投影

```ts
/**
 * 投影模板 + 消费层映射为消费端可发现的"等级表"。
 * 纯函数，供 P5 `GET /{adapter}/v1/models` 调用。
 *
 * @param template      目标 provider_model 引用的推理模板
 * @param levelMap      适配器的消费层映射（消费端等级名 → 统一等级）
 * @param targetProtocol 目标 provider 协议（决定 set 的取哪一边）
 * @returns Record<ConsumerLevel, ScalarOrNull>
 *   - Scalar = 模板 set 在目标协议下的代表标量（anthropic: budget_tokens 数字 / openai: effort 名 / responses: effort 名）
 *   - null = 该档位不可用（off 或模板未定义）
 */
function projectThinkingLevelMap(
  template: ReasoningTemplate,
  levelMap: Record<string, UnifiedEffort>,
  targetProtocol: ClientProtocol,
): Record<string, number | string | null>;
```

**投影规则**：

```text
对 levelMap 的每个 (consumerLevel → unifiedLevel)：
  level = template.levels[unifiedLevel]
  if !level 或 unifiedLevel == 'off' → null
  set = level.set[targetProtocol]
  if !set → null
  scalar =
    anthropic:        set.thinking.budget_tokens ?? null
    openai:           set.reasoning_effort ?? null
    openai-responses: set.reasoning.effort ?? null
  return scalar
```

**默认 `levelMap`**：恒等映射（消费端等级名 = 统一等级名），与原始计划 KTD4 一致。
**默认 `defaultLevel = 'medium'`** 在模板未映射时回退 `off`（KTD4）—— 但本设计**仅在 capabilities 投影**用，**不影响请求时**（请求时缺映射按"未定义"处理，不硬失败，见 §5.2 步骤 6）。

> **P5 接入契约**：P5 端点只调本函数，**不重写**。本设计不交付端点。

---

## 6. 通用覆写引擎（3 操作 + 条件 + 模板变量）

### 6.1 形态

```ts
type OverrideOp = 'set' | 'set_if_absent' | 'delete';

interface OverrideRule {
  /** 唯一标识（admin 引用、错误信息）。 */
  id?: string;
  /** 目标路径。IR 模式："generation.maxTokens" 等；body 模式：JSON path（sjson/gjson 风格）。 */
  path: string;
  /** 操作：set=强制覆盖；set_if_absent=仅当目标缺省时设；delete=删除该路径。 */
  op: OverrideOp;
  /** 字面值或模板字符串（见 §6.4）。 */
  value?: string | number | boolean | null | object;
  /** 条件字符串（Nunjucks `{% if %}` 块或简化表达式）。不设=总是执行。 */
  condition?: string;
  /** 注释（admin UI 用）。 */
  note?: string;
}
```

**配置位置**：

| 层 | 字段 | 形态 | 作用域 |
|----|------|------|--------|
| `adapter_model_mappings` | `generation_overrides` JSONB | `OverrideRule[]` | IR 模式 + body 模式（per-rule `target: 'ir'\|'body'\|'both'`，默认 `'ir'`） |
| `adapter_model_mappings` | `thinking_override` JSONB | `Partial<ReasoningSpec>` | 域内覆写（不走通用引擎） |
| `provider_models` | `metadata.body_overrides` JSONB | `OverrideRule[]` | body 模式（上游私有字段） |

> **设计选择**：`generation_overrides` 走通用引擎，`thinking_override` 走域内覆写器（不通用化，避免引入条件/模板到 reasoning 路径造成思考签名不稳定）。

### 6.2 受保护字段白名单

```ts
const PROTECTED_PATHS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'input',              // Responses 入参
  'instructions',       // Responses system
  'system',             // Anthropic system
  'tools',
  'tool_choice',
  'stream',             // 通用覆写可改 stream 但必须经 streamPolicy（见 §6.6.1）
  'max_tokens',
  'max_output_tokens',
  'temperature',        // 见 OQ-E
  'top_p',              // 见 OQ-E
]);
```

> **temperature / top_p 是否保护**待定（OQ-E）。本设计**先保护**（与 max_tokens 同等），后续若用户希望覆写可下调。

**校验时机**：路径解析前；若 `path` 落在白名单内（按段匹配，如 `generation.maxTokens` 不可，但 `generation.stream` 可），立即 `OVERRIDE_REJECTED_PROTECTED_FIELD` 错误（HTTP 422 / log error）。

### 6.3 条件（condition）

**两套语法并存**（按复杂度选）：

1. **简化表达式**（无外部依赖）：
   ```text
   {{resolvedModel}} == "claude-sonnet-4-5"
   {{reasoning.effort}} in ["high", "xhigh"]
   {{clientProtocol}} != "openai-responses"
   ```
   支持：`==` / `!=` / `in` / `not in` / `&&` / `||` / `!` / 字符串字面量（双引号）/ 数字字面量 / 数组字面量（`[...]`）。

2. **Nunjucks `{% if %}` 块**（复杂逻辑，可选依赖）：
   ```text
   {% if model.provider == "anthropic" and reasoning.effort in ["high", "xhigh"] %}
     ...
   {% endif %}
   ```
   `{% if %}` 块不返回 value（无返回值），仅作条件；rule 本身仍带 `op` / `value`。

> **自研**（AxonHub 用 Go `text/template`，本设计用 Nunjucks 的子集；`Nunjucks` 已是 admin UI 现有依赖。**需自研**简化表达式解析器，约 50 行 TS）。

**condition 渲染结果**：
- 简化表达式：返回 boolean，直接决定是否执行。
- Nunjucks：渲染字符串，与 `value` 渲染同管线（`renderTemplate` 一次）。

### 6.4 模板变量

**白名单变量**（不允许 `{{custom}}` / 函数调用 / 任意属性访问）：

| 变量 | 类型 | 说明 |
|------|------|------|
| `{{model}}` | string | `canonical.logicalModel` |
| `{{resolvedModel}}` | string | `route.resolvedModel` |
| `{{provider}}` | string | `route.providerId` |
| `{{clientProtocol}}` | `'anthropic' \| 'openai' \| 'openai-responses'` | 入站协议 |
| `{{providerProtocol}}` | 同上 | 目标协议 |
| `{{reasoning.effort}}` | string | 已解析的 effective effort（域内覆写后） |
| `{{reasoning.budgetTokens}}` | number | 已解析的 budget（域内覆写后） |
| `{{reasoning.enabled}}` | boolean | 域内覆写后 reasoning 是否启用 |
| `{{requestId}}` | string | `metadata.requestId` |
| `{{traceId}}` | string | `metadata.traceId` |

**自研**轻量实现：

```ts
// 简化版：仅支持 {{var}} / {{var.sub}} / 字面插值
function renderTemplate(input: string, vars: Record<string, unknown>): string;
// Nunjucks 子集：若 useNunjucks && 包含 {% if %} 块 → 走 Nunjucks
```

**value 渲染后**自动按 `JSON.parse` / `Number` / `Boolean` 三种尝试：
- 纯数字字符串 → number
- `"true"` / `"false"` → boolean
- `"null"` → null
- 形如 `{"k":...}` / `[...]` → object / array
- 其他 → string

### 6.5 IR 模式路径语法

- 点分路径：`generation.maxTokens` / `reasoning.effort`。
- 不支持数组下标（数组覆写走 body 模式，OQ-F）。
- 路径解析失败的 key → `OVERRIDE_PATH_NOT_FOUND`（默认 `set_if_absent` 时静默忽略；`set` 时 warn + 跳过该 rule）。

### 6.6 body 模式路径语法

- sjson / gjson 风格：`thinking.budget_tokens` / `messages.0.content.0.text`。
- 应用点：outbound encode **之后**、fetch **之前**。
- **典型用例**：注入 anthropic 私有 `metadata.user_id`、openai 私有 `stream_options.include_usage`（AxonHub EnsureUsage 用例）。
- **默认启用**（`override.body_layer_enabled: true`），可配置关。

#### 6.6.1 `stream` 字段的特殊处理

`stream` 在受保护白名单内，**但**通用覆写需要支持"强制开启/关闭流式"（与 P1 `streamPolicy` 配合）。P2 处理：

- **不**通过通用覆写改 `stream`。
- **统一由 `streamPolicy`**（`default_true` / `passthrough` / `force_true` / `force_false`）控制。
- 通用覆写尝试写 `stream` → `OVERRIDE_REJECTED_PROTECTED_FIELD`（明确边界）。

### 6.7 优先级（通用引擎）

按 rule 数组顺序**顺序执行**（后写覆盖先写）：

```text
for rule in rules:
  if !rule.condition or eval(rule.condition, vars):
    apply(rule.op, rule.path, renderValue(rule.value, vars))
```

**跨层优先级**（"后加载的覆盖先加载的"，与 AxonHub 一致）：

1. provider_models.metadata.body_overrides（先执行）
2. adapter_model_mappings.thinking_override（域内，独立管线）
3. adapter_model_mappings.generation_overrides（后执行，覆盖前者）

> **与 P1 既有 `thinking_override` 关系**：保留为最高优先级的"内联显式"回退路径，**不**纳入通用引擎。文档明确该字段是 P1 过渡遗留，P3 之后可考虑迁移为模板机制。

---

## 7. 应用点与接口设计

### 7.1 管线插入位置

```text
parseAndAuth
  → routeModel（RouteDecision + OverrideContext）
    → INBOUND decode
      → normalizeRequest
        → applyRouteDecision              (P1; 解析 resolvedModel / stream / maxTokens)
          → applyOverrides                (P2; 域内 reasoning + 通用 IR)
            → OUTBOUND encode             (P1; 纯 IR → wire 渲染)
              → applyBodyOverrides        (P2; 通用 body；outbound 之后)
                → fetch 上游
                  → decodeUpstreamResponse / stream inbound
```

`applyOverrides` 与 `applyBodyOverrides` 都是**纯函数**（无 IO，无 DB）。

### 7.2 函数签名

```ts
// src/proxy/override/engine.ts
export interface OverrideContext {
  /** 域内覆写：模板（含 levels）。 */
  template?: ReasoningTemplate;
  /** 域内覆写：per-mapping 默认等级。 */
  defaultReasoningLevel: UnifiedEffort;
  /** 域内覆写：per-model 值映射。 */
  valueMap: EffortMapping;
  /** 域内覆写：mapping.thinking_override 内联显式（最高优先级）。 */
  inlineReasoningOverride?: Partial<ReasoningSpec>;
  /** 通用覆写：IR 模式 rules。 */
  irRules: OverrideRule[];
  /** 通用覆写：body 模式 rules（由 provider_models.metadata.body_overrides + adapter_model_mappings.generation_overrides body 段合并）。 */
  bodyRules: OverrideRule[];
  /** 配置：是否启用 body 段。 */
  bodyLayerEnabled: boolean;
  /** 受保护字段白名单（运行时注入便于测试）。 */
  protectedPaths?: ReadonlySet<string>;
  /** 模板变量上下文（构建时序见 §7.4）。 */
  vars: TemplateVars;
}

export function applyOverrides(
  canonical: CanonicalRequest,
  route: RouteDecision,
  ctx: OverrideContext,
): CanonicalRequest;

// src/proxy/override/body-engine.ts
export function applyBodyOverrides(
  body: WireBody,
  ctx: OverrideContext,
  route: RouteDecision,
): WireBody;
```

### 7.3 RouteDecision 扩展（P2）

```ts
// src/proxy/adapters/index.ts
export interface RouteDecision {
  // ... P1 字段 ...
  /** P2 新增：覆写上下文（router 阶段预解析）。 */
  overrides: OverrideContext;
}
```

**为什么加 `overrides` 而不是在 pipeline 现取**：

- 沿用 P1 "router 把一切准备好" 的契约，pipeline 不查 DB。
- 路由级 fail-fast：`template_id` 不存在 / `valueMap` 格式错 / `rules` 校验失败 → 路由层直接 404/422，不进入 pipeline。

### 7.4 router.ts 的扩展

```ts
// 伪代码
export function routeModel(store, modelName): RouteDecision {
  const provider = ...;
  const model = ...;
  return buildRouteDecision({
    provider,
    modelId: model.id,
    thinking: model.thinking,   // P1：内联静态
    streamPolicy: 'default_true',
    maxTokensOverride: undefined,
    overrides: buildOverrideContext(store, { provider, model, adapter: null }),
  });
}

export function resolveAdapterRoute(store, adapterName, sourceModelId): RouteDecision {
  const adapter = ...;
  const mapping = ...;
  const model = ...;
  return buildRouteDecision({
    provider,
    modelId: model.id,
    thinking: mapping.thinking ?? model.thinking,  // P1：内联
    streamPolicy: adapterStreamToPolicy(adapter.stream),
    maxTokensOverride: adapter.max_tokens,
    overrides: buildOverrideContext(store, { provider, model, adapter, mapping }),
  });
}
```

`buildOverrideContext` 在 `src/proxy/override/templates.ts`：

```ts
function buildOverrideContext(store, ctx: {
  provider: Provider;
  model: ProviderModel;
  adapter: Adapter | null;
  mapping: AdapterModelMapping | null;
}): OverrideContext {
  // 1. 加载模板（若 model.reasoning_template_id）
  const template = ctx.model.reasoningTemplateId
    ? store.getReasoningTemplate(ctx.model.reasoningTemplateId)
    : undefined;

  // 2. 默认等级（mapping > model > 'medium'）
  const defaultReasoningLevel = ctx.mapping?.defaultReasoningLevel ?? 'medium';

  // 3. 值映射（从 model.metadata 取）
  const valueMap: EffortMapping = (ctx.model.metadata as any)?.reasoning_effort_mapping ?? [];

  // 4. IR rules（仅 mapping.generation_overrides）
  const irRules: OverrideRule[] = (ctx.mapping?.generationOverrides as OverrideRule[] | null) ?? [];

  // 5. body rules（model.metadata.body_overrides + mapping 中标记 body 的 rules）
  const bodyRules: OverrideRule[] = [
    ...((ctx.model.metadata as any)?.body_overrides ?? []),
    ...((ctx.mapping?.generationOverrides as OverrideRule[] | null) ?? [])
      .filter(r => (r as any).target === 'body'),
  ];

  // 6. 内联 thinking override
  const inlineReasoningOverride = ctx.mapping?.thinkingOverride as Partial<ReasoningSpec> | null ?? undefined;

  return {
    template,
    defaultReasoningLevel,
    valueMap,
    inlineReasoningOverride,
    irRules,
    bodyRules,
    bodyLayerEnabled: true,  // 可由全局配置覆盖
    vars: buildTemplateVars(ctx),  // 包含 model/resolvedModel/provider/...
  };
}
```

### 7.5 管线（`src/proxy/pipeline.ts`）插入片段

```ts
// 在 applyRouteDecision 之后、OUTBOUND encode 之前
const routed = applyRouteDecision(normalizeRequest(canonical), route, clientStream);
const withOverrides = applyOverrides(routed, route, route.overrides);   // P2

// outbound encode
const outBody = OUTBOUND_ADAPTERS[route.providerProtocol].encode(withOverrides, route);
// P2 body 段
const finalBody = route.overrides.bodyLayerEnabled
  ? applyBodyOverrides(outBody, route.overrides, route)
  : outBody;
const upstream = buildUpstreamRequest(route, finalBody);
```

### 7.6 错误处理

- **路由阶段**（router.ts）：`template_id` 不存在 / `template.enabled=false` / `valueMap` 格式错 / `OverrideRule.path` 受保护 / `OverrideRule.condition` 语法错 → 路由层 404（template 不存在）/ 422（配置错）。
- **运行阶段**（pipeline.ts）：`applyOverrides` 内部错（极少见，纯函数）→ 500 + log error（不暴露内部错误给客户端）。
- **body 段**：`applyBodyOverrides` 路径不存在（`set` 模式）→ warn + 跳过该 rule；`delete` 路径不存在 → 静默（与 gjson 一致）。

---

## 8. PG Schema 改动（P2.1 草案 DDL）

### 8.1 新增表

```sql
-- 8.1.1 推理模板（顶层可复用实体）
CREATE TABLE reasoning_templates (
  id BIGSERIAL PRIMARY KEY,
  -- 全库唯一名；模板引用源
  name TEXT NOT NULL UNIQUE,
  -- 描述（admin UI 用）
  description TEXT,
  -- 等级 → {set: 协议参数集} 或 null（off）；'off' 单独存放以示语义
  -- 形状：
  --   { "low": null, "medium": { "set": { "anthropic": {...}, "openai": {...} } }, "high": {...}, "xhigh": null, "max": {...} }
  --   "minimal": 可选（见 OQ-A）
  levels JSONB NOT NULL,
  -- 引用计数（admin UI 显示，避免在删除时再全表扫描；可由 trigger 维护）
  reference_count INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 形状约束：levels 必须为 object，键为 5/7 级枚举
  CONSTRAINT reasoning_templates_levels_is_object CHECK (jsonb_typeof(levels) = 'object')
);
CREATE INDEX idx_reasoning_templates_enabled ON reasoning_templates(enabled);
```

### 8.2 现有表新增字段

```sql
-- 8.2.1 provider_models：加 reasoning_template_id FK
ALTER TABLE provider_models
  ADD COLUMN reasoning_template_id BIGINT REFERENCES reasoning_templates(id) ON DELETE SET NULL;
-- null = 沿用 P1 既有 thinking_* 字段（内联）
-- ON DELETE SET NULL：模板被删时回退到内联，触发 admin 警告（不级联解绑）
CREATE INDEX idx_provider_models_template_id ON provider_models(reasoning_template_id) WHERE reasoning_template_id IS NOT NULL;

-- 8.2.2 adapter_model_mappings：加 default_reasoning_level
-- 5 级枚举；如要 7 级则新建枚举（见 OQ-A）
ALTER TABLE adapter_model_mappings
  ADD COLUMN default_reasoning_level reasoning_effort NOT NULL DEFAULT 'medium';
-- 旧 thinking_override 保留（最高优先级内联回退）
-- 旧 generation_overrides 保留（IR + body 通用覆写）

-- 8.2.3 adapters：加 level_map（消费层映射）
-- 形状：{ "minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh" } 等
-- 缺省 = 恒等映射（应用层补）
ALTER TABLE adapters
  ADD COLUMN level_map JSONB NOT NULL DEFAULT '{}'::jsonb;
```

### 8.3 与 P1 既有字段的兼容

| P1 字段 | P2 处理 | 备注 |
|---------|---------|------|
| `provider_models.thinking_enabled` | 保留 | 当 `reasoning_template_id IS NULL` 时为唯一来源 |
| `provider_models.thinking_budget_tokens` | 保留 | 同上 |
| `provider_models.thinking_reasoning_effort` | 保留 | 同上 |
| `provider_models.thinking_type` | 保留 | 同上 |
| `adapter_model_mappings.thinking_override` JSONB | 保留 | 最高优先级内联（覆盖模板结果） |
| `adapter_model_mappings.generation_overrides` JSONB | 保留 | 通用覆写 IR/body 模式 |
| `adapters.max_tokens_override`（实为 `max_tokens` 列） | 保留 | P1 行为不变 |
| `adapters.stream_policy` | 保留 | P1 行为不变；`stream` 不进通用覆写 |

### 8.4 双写过渡（与 P1.16 ConfigStore 一致）

- **YAML 仍是唯一读源**；PG 是过渡期 best-effort 镜像（沿用 P1.16）。
- 新 YAML 字段（顶层 `reasoning_templates:`）通过 `ConfigStore.importConfigToPg` 同步落库。
- 旧 YAML 字段（`adapter.thinking` / 模型直接 `budget_tokens` 等）**不报错**（与 P1 过渡姿态一致；硬报错推迟到 P6 / 1.0.0 切换点）。

### 8.5 不新增/不建议新增的项

- **不**新增独立 `unified_effort_7` 枚举：先看 OQ-A 拍板；P2 默认保留 5 级 + 单独的 `off` 开关（在 `ReasoningTemplateLevel | null` 里 `null` 即 off）。
- **不**新增独立 `value_map` 列：值映射用 `provider_models.metadata.reasoning_effort_mapping`（OQ-C）。
- **不**新增独立 `body_overrides` 列：model 级 body 覆写用 `provider_models.metadata.body_overrides`。
- **不**新增独立 `rules` / `override_rules` 表：规则嵌入 `adapter_model_mappings.generation_overrides` JSONB 数组（轻量、足够；独立表的优势在 admin 引用追踪，P6 再说）。

---

## 9. 测试策略

### 9.1 单元测试（Vitest，`test/unit/proxy/override/`）

| 用例组 | 覆盖点 | 关键 it 数（约） |
|--------|--------|------------------|
| `templates.test.ts` | 模板解析（effort → set）、`projectThinkingLevelMap` 投影、shape 校验 | 25 |
| `value-map.test.ts` | 首匹配 / 未命中透传 / 空数组 | 6 |
| `engine.test.ts`（IR 模式） | `applyOverrides` 域内 reasoning 各分支、通用 3 操作、条件求值、模板变量、max_tokens 钳制 | 60 |
| `body-engine.test.ts` | `applyBodyOverrides` 路径、set_if_absent、delete、条件、模板变量、缺路径 | 35 |
| `conditions.test.ts` | 简化表达式（`==` / `!=` / `in` / `&&` / `\|\|`）+ Nunjucks `{% if %}` | 20 |
| `template-vars.test.ts` | 白名单变量、拒绝任意属性访问 | 15 |
| `path.test.ts` | IR 路径解析、body 路径解析、保护路径拒绝 | 20 |

**关键 it**（来自原始计划 AE1–AE5，扩展为模板机制）：

- AE1. 客户端 `reasoning_effort: high` + 模板 `high` 已定义 + 默认 medium → 上游按 high 翻译。
- AE2. 客户端未携带 + 默认 medium + 模板 `medium` → 上游按 medium。
- AE3. 默认 off + 客户端未携带 → 上游无推理字段。
- AE4. `thinkingLevelMap` 投影 Pi 词汇 + 模板（minimal/low/medium 空、high→high、xhigh→max） → `{minimal:null, low:null, medium:null, high:'high', xhigh:'max'}`。
- AE5. anthropic 入站 → openai-responses 上游 + 客户端带 effort → 等价翻译、受保护字段不改写。
- AE6. capabilities 投影后响应不含原始模板 / 上游参数（OQ-G 留到 P5 验证）。
- AE7. 客户端 effort 不在模板 → value-map 命中降级 → 模板查降级后档位。
- AE8. 客户端携带 budget 但无 effort → 尊重 budget（不查模板）。
- AE9. 客户端 `type='disabled'` → 显式 off、不注入。
- AE10. `budget > max_tokens` → 钳制 `max_tokens-1`、warn 日志。
- AE11. IR 通用覆写 `path='generation.maxTokens'` 写 `4096` → 客户端未传 → 应用；客户端传 8192 → 保留（`set_if_absent`）；`op='set'` → 强制覆盖。
- AE12. body 通用覆写 `path='stream_options.include_usage'` + `condition='{{clientProtocol}} == "openai"'` → 只在 openai 协议注入。
- AE13. 受保护字段 `path='model'` → 422（路由阶段）。
- AE14. 模板变量 `{{reasoning.effort}}` 渲染为 `'high'` 后被解析为 enum。
- AE15. 简化表达式 `{{resolvedModel}} in ["claude-sonnet-4-5", "claude-opus-4"]` → 命中时执行。

### 9.2 黄金回归（Vitest `test/golden/`）

复用 P1.14 的 ccx golden-regression 设施，新增：

- `test/golden/override/`：覆写后端到端协议输出对比。
  - anthropic outbound：客户端携带 / 不携带 reasoning + 模板 + 通用 generation rule → 落库 JSON 与 baseline 对比。
  - openai-chat outbound：同上。
  - openai-responses outbound：同上。
  - 流式：截取前 3 个 SSE 事件 + message_stop 事件对比（`thinkingLevelMap` 不影响流式，但 reasoning 注入影响 message_start 的 content 数组）。

### 9.3 集成测试（`test/override-integration.test.ts`）

- `parseAndAuth → routeModel（带 OverrideContext）→ applyOverrides → OUTBOUND encode → applyBodyOverrides → fetch（mock 上游）` 全链路：
  - mock 上游校验 body 包含 `stream_options.include_usage`（AxonHub EnsureUsage 用例）。
  - mock 上游校验 body 不含被受保护字段（即使 rule 尝试写 `model`）。
  - 模板解析结果与 expected `ReasoningSpec` 断言。
  - `budget_clamp_strict=false` 钳制静默 vs `=true` 报错（OQ-D）。

### 9.4 适配器对照回归（P1.13 行为等价不变量）

P1 §7.3 不变量 1–10 在 P2 后应**全部保持**（§10 验收红线）。回归点：

- 移除 outbound anthropic 的字段级合并 → 改由域内覆写器统一产生 `reasoning` → outbound 仅做 IR → wire 写入。
- `golden-regression` 集需要重跑所有 anthropic reasoning 用例。

### 9.5 e2e（Playwright，P6 / P2.5 推迟）

- P2 不引入 e2e（admin UI 在 P6）。
- P2.5（如纳入）可加 API e2e：起服务 + mock upstream，断言推理注入与受保护字段保护。

---

## 10. 子任务拆解（P2.x）

> 每条束可独立验收、并发可派发（主计划 §12 已定 P2 单 worktree）；建议派发顺序 P2.1 → P2.2 → P2.3 → P2.4（schema 先行、引擎可与 schema 并行，集成与测试收尾）。

### 10.1 概览

| 子任务 | 内容 | 工作量 | 验收 |
|--------|------|--------|------|
| **P2.1** | PG schema 改动 + ConfigStore 加载 + 类型 | S | 迁移绿；Drizzle schema 编译；旧数据兼容 |
| **P2.2** | 域内覆写器（template / value-map / default / clamp） | M | 单测 90 it 全绿；投影纯函数与 P5 契约对齐 |
| **P2.3** | 通用覆写引擎（3 操作 + 条件 + 模板变量 + path + body 段） | M | 单测 100 it 全绿；受保护白名单 422 |
| **P2.4** | 管线集成（applyOverrides / applyBodyOverrides 插入 + RouteDecision 扩展 + router 装配） | M | 集成测试绿；outbound anthropic 字段级合并删除；P1 §7.3 行为等价不变量全保 |
| **P2.5**（可选） | 模型名后缀解析（`gpt-5-high`）+ 后缀值映射 | S | 推迟到独立计划或本子任务 |
| **P2.6** | 黄金回归 + 适配器对照测试（rebaseline） | S | golden 全绿；P1.13 不变量全保 |

### 10.2 P2.1 — Schema 与持久化

- **新增文件**：`src/db/schema/reasoning-templates.ts`（drizzle 镜像 §8.1）。
- **改动文件**：
  - `src/db/schema/adapters.ts`：加 `levelMap` JSONB。
  - `src/db/schema/providers.ts`：加 `reasoningTemplateId` FK。
  - `src/db/schema/adapters.ts`（`adapterModelMappings`）：加 `defaultReasoningLevel` 字段。
  - `src/db/config-repo.ts`（`importConfigToPg`）：新增 `reasoning_templates` 表导入 / `provider_models.reasoning_template_id` / `adapter_model_mappings.default_reasoning_level` / `adapters.level_map` 同步。
  - `src/config/types.ts` / `parser.ts` / `validator.ts`：YAML 新增 `reasoning_templates:` 顶层段 + 解析 + 校验。
- **迁移**：`drizzle-kit generate` 生成 SQL（`drizzle/0007_*.sql`），P2.1 提交时一并合入。
- **验收**：
  - `npm run db:generate` / `db:migrate` 绿。
  - 旧 YAML 仍能加载（双写过渡姿态，不报错）。
  - 新 YAML 含 `reasoning_templates:` 段 → PG 同步 + 回读一致。
  - 旧数据迁移：`provider_models.thinking_*` 字段不丢；P1.16 过渡期 `ConfigStore` 行为不变。

### 10.3 P2.2 — 域内覆写器

- **新增文件**：
  - `src/proxy/override/types.ts`：`OverrideContext` / `OverrideRule` / `OverrideOp` / `TemplateVars` / `ReasoningTemplate` / `ReasoningTemplateLevel` / `ReasoningTemplateSet`。
  - `src/proxy/override/templates.ts`：`resolveReasoningPolicy` / `applyValueMapping` / `clampBudget` / `projectThinkingLevelMap`。
- **改动文件**：
  - `src/proxy/ir/types.ts`：扩展 `ReasoningEffort` 类型（如选 7 级）或加 `UnifiedEffort` 别名（见 OQ-A）。
  - `src/proxy/router.ts`：`buildOverrideContext`（模板 + valueMap + defaultLevel 解析）。
- **验收**：
  - 单元测试 `test/unit/proxy/override/templates.test.ts` + `value-map.test.ts` 全绿（覆盖 AE1/AE2/AE3/AE4/AE7–AE10）。
  - `projectThinkingLevelMap` 纯函数与 P5 契约对齐（P5 接入前 stub 验证）。
  - `clampBudget` 在 anthropic 路径正确钳制（与原始计划 KTD3 一致）。

### 10.4 P2.3 — 通用覆写引擎

- **新增文件**：
  - `src/proxy/override/engine.ts`：`applyOverrides`（IR 模式，3 操作）。
  - `src/proxy/override/body-engine.ts`：`applyBodyOverrides`（body 模式）。
  - `src/proxy/override/conditions.ts`：简化表达式 + Nunjucks 适配。
  - `src/proxy/override/template-vars.ts`：白名单变量 + 渲染。
  - `src/proxy/override/path.ts`：IR / body 两套路径解析 + 保护路径拦截。
- **验收**：
  - 单元测试 `engine.test.ts` / `body-engine.test.ts` / `conditions.test.ts` / `template-vars.test.ts` / `path.test.ts` 全绿（覆盖 AE11–AE15）。
  - 受保护字段白名单拦截（13 个受保护路径）。
  - body 段 `path='stream'` 拦截（与 AxonHub 安全边界一致）。

### 10.5 P2.4 — 管线集成

- **改动文件**：
  - `src/proxy/adapters/index.ts`：`RouteDecision.overrides` 字段。
  - `src/proxy/router.ts`：`routeModel` / `resolveAdapterRoute` 装配 `buildOverrideContext`。
  - `src/proxy/pipeline.ts`：插入 `applyOverrides`（applyRouteDecision 之后）和 `applyBodyOverrides`（outbound encode 之后）；错误处理。
  - `src/proxy/adapters/outbound/anthropic.ts`：**删除**字段级合并（`effortBudget` 表 + 钳制逻辑）；改为读 `canonical.reasoning` 直接渲染（`budget_tokens` 已在域内钳制好；`type` 直接取；`enabled` 由 `source='client'` 显式 off 时清掉）。
  - `src/proxy/adapters/outbound/openai-chat.ts` / `openai-responses.ts`：对齐 — 不再做 reasoning 字段级合并；直接读 `canonical.reasoning` 渲染（如 `reasoning_effort` 来自 `effort`）。
- **验收**：
  - 集成测试 `test/override-integration.test.ts` 全绿。
  - P1 §7.3 行为等价不变量（迁移红线 1–10）全保：
    - 1. Anthropic content_block 索引 0=thinking/1=text/2+=tool_use（无影响）。
    - 2. text/tool/finish 前先发 `content_block_stop(thinking)`（无影响）。
    - 3. 签名在 `thinking_delta` 之后、`content_block_stop` 之前（无影响）。
    - 4. Responses `reasoning_text.delta/done` + `message_stop` 聚合（无影响）。
    - 5. Anthropic→OpenAI 流式 signature 仅累积、`message_delta` 才落盘（无影响）。
    - 6. usage 计费输入口径（无影响）。
    - 7. `makeSignature` 多轮一致（无影响；reasoning 注入路径不碰签名）。
    - 8. Responses 入口 MCP 探测工具剥离（无影响）。
    - 9. CCX namespace__name 双向一致（无影响）。
    - 10. stream_policy 三态语义（无影响；`stream` 不进通用覆写）。
  - 旧 outbound anthropic 字段级合并逻辑删除（`git grep effortBudget src/proxy/` 应无命中）。

### 10.6 P2.5 — 模型名后缀解析（**可选 / 推迟**）

- **动机**：`gpt-5-high` 风格后缀在 AxonHub 是客户端零配置入口。
- **冲突**：与 R13 "客户端优先" 有微妙冲突 — 客户端发了 `gpt-5`，后缀改写为 `gpt-5-high` 反向覆盖 effort。
- **处理**：
  - 默认**关闭**（不在 inbound decode 阶段改 `model`）。
  - 仅在"客户端未携带 reasoning"时启用后缀 → effort 注入。
  - 详见 OQ-H。
- **建议**：延后到独立计划或本子任务作为 P2.5 备选；P2.4 不依赖。

### 10.7 P2.6 — 黄金回归

- **改动文件**：
  - `test/golden/override/`：新增。
  - `test/golden/anthropic-reasoning.test.ts` / `test/golden/openai-reasoning.test.ts` / `test/golden/responses-reasoning.test.ts`：rebaseline 既有 baseline（因 outbound 删除字段级合并）。
- **验收**：
  - golden 全绿。
  - 旧 100 + 27 + 19 + 20 = 166 it translation/stream/vision/ccx 用例保持全绿（rebaseline 后不允许行为差异）。
  - `npx vitest run --exclude '**/db.test.ts' --exclude '**/config-pg.test.ts'` 198 passed + 5 skipped（P1.17 目标）保持或只增不减。

### 10.8 风险与依赖

- **依赖 P1 完整落地**：P1 §5 公共接口（`CanonicalRequest` / `ReasoningSpec` / `RouteDecision` / `GenerationSpec`）是 P2 起点；P1.16 PG schema 是 P2.1 起点。
- **并发单元**：P2.1 与 P2.2/P2.3 **可并行**（schema 独立文件）；P2.2/P2.3 与 P2.4 串行（P2.4 装配前两者）。
- **P3 协调**：P3 引入 failover 决策可能复用 `OverrideContext`（per-attempt 重新解析），需在 P3 设计时确认；P2 不预先假设。

---

## 11. 验收红线（与 P1.13 行为等价不变量合并）

P2 完成后**必须满足**：

1. P1 §7.3 行为等价不变量 1–10 全保。
2. P2 §9.1 单元测试全绿（覆盖 AE1–AE15 + 受保护字段 + 钳制 + 模板投影）。
3. P2 §9.2 黄金回归全绿（覆盖三协议出站 reasoning/generation）。
4. P2 §9.3 集成测试全绿（覆盖 mock 上游断言）。
5. P1.17 测试总数保持或只增不减。
6. `git grep effortBudget src/proxy/` 零命中（anthropic outbound 字段级合并已删除）。
7. `git grep 'route\.thinking' src/proxy/` 仅剩 `RouteDecision.thinking` 类型定义与 `buildOverrideContext` 引用，**不应**散落在 outbound 适配器。
8. P1 §7.3 内容块索引 / 签名 / 流式时序 / usage 口径无回归。

---

## 12. 开放问题（需用户拍板）

> 每条都有推荐项 + 备选，影响实施细节；先标推荐项，P2.1 启动前确认。

| 编号 | 问题 | 推荐 | 备选 |
|------|------|------|------|
| **OQ-A** | `effort` 枚举是否扩展为 7 级（`off\|minimal\|low\|medium\|high\|xhigh\|max`） | **保留 5 级 + 单独的 `off`（null）开关**；`minimal` 暂不引入（少一个 value 映射分支；如需 `minimal` → user 显式写 `minimal` → 模板查找自动降级到 `low`） | 新增 7 级 PG 枚举 `unified_effort` + 5 级 `reasoning_effort` 转换层（更对齐原始计划 001，但增加 DDL 与映射复杂度） |
| **OQ-B** | body 通用覆写（上游私有字段）是否 P2 范围内交付 | **P2 范围内（默认开）**，但用 `override.body_layer_enabled: false` 配置可关 | 推迟到 P7 协议扩展 |
| **OQ-C** | 值映射（effort_mapping）放 `provider_models.metadata` JSONB 还是独立列 | **metadata JSONB**（避免新列、admin UI 暂不暴露详细编辑） | 新增 `provider_models.reasoning_effort_mapping JSONB` 独立列（admin UI 友好） |
| **OQ-D** | `budget > max_tokens` 钳制失败时：静默 warn 还是 422 硬报错 | **静默 warn**（与 legacy 一致；不破坏客户端体验） | `override.budget_clamp_strict: true` 时 422（admin 强制） |
| **OQ-E** | `temperature` / `top_p` 是否进受保护白名单 | **进白名单**（与 max_tokens 同等，理由：生成参数是模型行为契约） | 出白名单（允许通用覆写改） |
| **OQ-F** | 通用覆写路径语法是否支持数组下标（`messages.0.content.0.text`） | **body 模式支持**（与 sjson/gjson 一致）；IR 模式**不支持**（避免数组语义复杂度） | 都不支持（body 也限制为对象路径） |
| **OQ-G** | `thinkingLevelMap` 端点是否在 P2 范围内交付 | **不在**（P5 范围）；P2 仅交付 `projectThinkingLevelMap` 纯函数 | 在 P2 范围（提前到 P2.6 收尾） |
| **OQ-H** | 模型名后缀解析（`gpt-5-high`）是否 P2 范围内 | **不在 P2 范围**（推迟到 P2.5 或独立计划；与"客户端优先"有微妙冲突） | 在 P2.5 范围内（仅"未携带 reasoning"分支启用） |
| **OQ-I** | 旧 `thinking_override` JSONB 是否在 P2 范围内被替代 | **保留为最高优先级内联回退**（不替代；P3 之后再说） | 强制迁移为模板（破坏性变更、推迟到 1.0.0） |
| **OQ-J** | 通用覆写 rules 是 rule-by-rule 顺序执行还是声明式 DAG | **顺序执行**（与 AxonHub 一致；行为可预测） | DAG（更强大但复杂度高，单用户场景不必要） |
| **OQ-K** | body 覆写是否走 Nunjucks 完整引擎（含 `{% for %}` 等） | **仅 `{% if %}`**（防滥用；其余走简化表达式） | 完整 Nunjucks（更强大、攻击面更大） |
| **OQ-L** | 受保护字段白名单是否提供 admin 可配置 | **不可配置**（硬编码在 `path.ts`；白名单扩展需改代码） | 可由 `override.protected_paths` 全局配置 |
| **OQ-M** | 模板 set 内允许的字段是按协议分开还是统一 | **按协议分开**（`set.anthropic / set.openai / set.openai-responses`），与多协议互转对齐 | 统一字段 + 协议忽略不识别的（简单但易泄漏协议细节） |
| **OQ-N** | `reasoning_templates.reference_count` 字段是否要 trigger 维护 | **应用层维护**（更可控；admin 删除模板时弹引用清单） | DB trigger（更自动但难调试） |

---

## 13. 风险与诚实评估

| 风险 | 等级 | 缓解 |
|------|------|------|
| 移除 outbound anthropic 字段级合并后某条边界用例回归 | 中 | P2.6 黄金回归 + 集成测试全量 rebase；P1 §7.3 不变量回归集。 |
| `effort` 5 级 vs 7 级 拍板晚于 P2.1 schema 落地 → 需 DDL 反复 | 低 | 建议先拍 OQ-A 再启动 P2.1；若不拍，5 级先行、7 级后续 minor 迁移。 |
| 通用覆写 body 段默认开 → 误改上游私有字段 | 中 | 受保护白名单 + 路径存在性校验 + warn 日志；`body_layer_enabled: false` 一键关。 |
| 模板机制成为"配置复杂度"来源 | 中 | 顶层可复用（一处改、处处生效）是收益；UX 关键在 admin UI（P6）+ 编辑引导（缺省模板）。 |
| 文档说"thinkingLevelMap 是消费端发现"——端点延后到 P5 → 闭环未完成 | 中 | 明确 P2 仅交付投影函数；P5 端点对接（不在本计划范围）。原始计划 001 也持同样姿态（capabilities 端点由 P5 接管）。 |
| 旧 `thinking_override` 长期共存 → schema 漂移 | 低 | 文档化"P1 过渡遗留"；P3 后再考虑迁移。 |
| body 通用覆写的条件/模板被滥用做"任意字段注入" | 中 | 条件白名单语法 + 路径解析拒绝数组下标越界 + 受保护白名单 + admin UI 限制。 |
| `applyOverrides` 纯函数被误带 IO | 低 | 单元测试 + 集成测试断言"无 fetch / 无 DB 调用"；ESLint rule（可选）。 |

---

## 14. 与主计划 / 其他阶段的边界

| 阶段 | 关系 |
|------|------|
| **P0 地基** | 已完成；P2 依赖 P0 的 Hono + Drizzle + pino + Vitest + Playwright 骨架。 |
| **P1 协议核心** | 已完成；P2 依赖 P1 的 IR / RouteDecision / outbound 适配器 / PG schema。 |
| **P3 路由 + failover** | P3 引入多 provider 重试，可能复用 `OverrideContext`（per-attempt 重新解析）；P2 不预先假设，P3 设计时确认。 |
| **P4 可观测性** | P4 增加 `request_id` / `trace_id` 贯穿；P2 的 `{{requestId}}` / `{{traceId}}` 模板变量已为此铺路。 |
| **P5 模型管理** | P5 调 `projectThinkingLevelMap` 纯函数交付 `GET /{adapter}/v1/models` capabilities 端点；本设计是函数契约。 |
| **P6 Admin UI** | P6 交付推理模板 CRUD + Provider 模型选模板 + Adapter 默认等级 / levelMap 编辑 + Admin API；本设计提供 schema 与 ConfigStore 接入点。 |
| **P7 协议扩展** | P7 引入新协议时复用本设计的 `OverrideContext` / `applyOverrides` 流水线（无需改动覆写引擎本身）。 |

---

## 15. 总结

P2 在 P1 IR / RouteDecision / outbound 适配器 / PG schema 的基础上，**统一覆写合并点**（从 outbound 散点 → 域内覆写器 + 通用引擎）、**新增 reasoning 模板机制**（AxonHub 没有）、**简化 AxonHub 9 操作到 3 操作**（set / set_if_absent / delete），并把**条件 + 模板变量 + 受保护白名单**作为安全护栏。

- **域内覆写**（reasoning）：强类型 → 模板解析 → 值映射 → 默认兜底 → budget 钳制。
- **通用覆写**（generation + 上游私有）：3 操作 → 简化表达式 / Nunjucks `{% if %}` 条件 → 白名单模板变量 → 受保护路径拒绝。
- **应用点**：在 `applyRouteDecision` 之后插入 `applyOverrides`（IR 段），outbound encode 之后插入 `applyBodyOverrides`（body 段，可关）。
- **PG schema**：新增 `reasoning_templates` 表 + 三处现有表加字段；旧 P1 字段保留为内联回退。
- **P2 范围**：reasoning + generation；工具、数组操作、admin UI、capabilities 端点延后。
- **开放问题**：14 条需用户拍板（OQ-A–OQ-N），影响 schema / 引擎形态 / 配置 UX。

P2.1 启动前需拍板 **OQ-A / OQ-B / OQ-D**（最直接影响 schema 与默认行为）；其余可在 P2.2 / P2.3 实施时同步确认。
