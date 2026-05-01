---
title: Unified Request Pipeline — 消除 proxy/adapter handler 重复
type: refactor
status: active
date: 2026-04-30
origin: docs/brainstorms/2026-04-30-unified-pipeline-requirements.md
---

# Unified Request Pipeline

## Overview

将 `src/proxy/handlers.ts` 和 `src/adapter/handlers.ts` 中 85% 重复的请求处理逻辑抽取为两个可复用函数 `parseAndAuth` 和 `forwardPipeline`，放置于新文件 `src/proxy/pipeline.ts`。调用方各自保留路由解析（`routeModel` / `resolveAdapterRoute`）和日志标签。

顺手在 `readBody` 中加入 Body 1MB 上限。

---

## Problem Frame

当前两个 handler 文件互为复制品：readBody → JSON.parse → 认证 → model 校验 → transformInboundRequest → forwardRequest → capture → token 统计 → 计时 → 错误处理。唯一差异是路由解析函数和日志格式。任何横切改动必须在两处分别实现。

---

## Requirements Trace

- R1. `parseAndAuth` 处理：读取 Body（含大小限制）、JSON 解析、代理认证、model 提取
- R2. Body 大小限制默认 1MB，可覆盖。超限返回 HTTP 413
- R3. JSON 解析失败 → 400，认证失败 → 401，model 缺失 → 400
- R4. `parseAndAuth` 成功返回 `{ body, rawBody, modelName }`，错误返回 null（响应已写）
- R5. `forwardPipeline` 处理：transformInboundRequest → forwardRequest → capture → token → 计时
- R6. `forwardRequest` 抛错时，headersSent 为 false → 502，已发送 → 记录日志并结束
- R7. Token 统计用 `TokenTracker.record()`，延迟用 `Date.now() - startTime`
- R8. Proxy handler 调用：parseAndAuth → routeModel → forwardPipeline
- R9. Adapter handler 调用：URL 解析 → parseAndAuth → resolveAdapterRoute → forwardPipeline
- R10. 日志标签保持现有格式
- R11. 不改变任何对外 API 行为
- R12. 115 个测试全部通过

**Origin acceptance examples:** AE1 (R1,R2: 2MB → 413), AE2 (R3: 非 JSON → 400), AE3 (R3: 无 Auth → 401), AE4 (R5,R8: 正常流式)

---

## Scope Boundaries

- 不引入中间件抽象或 filter chain
- 不改变正则路由表
- 不合并 `routeModel` 和 `resolveAdapterRoute`
- 不做 config store 并发安全改进
- Body 大小限制保持 1MB 默认（已确认加入）

---

## Context & Research

### Relevant Code and Patterns

- `src/proxy/handlers.ts:60-143` — 完整 proxy 请求处理链
- `src/adapter/handlers.ts:44-163` — 完整 adapter 请求处理链（复制模式）
- `src/proxy/provider.ts:72-176` — `forwardRequest` 签名和流式/非流式分发
- `src/proxy/types.ts` — `RouterResult` 接口
- `src/adapter/router.ts` — `AdapterRouteResult { route: RouterResult, inboundType }`
- `src/lib/http-utils.ts:3-8` — `readBody` 当前实现（无大小限制）
- `src/api/server.ts` — `ServerContext` 接口（与 `ProxyContext` 字段相同）
- `src/config/types.ts` — `InboundType` 类型

### Institutional Learnings

- `checkProxyAuth` 在 `src/proxy/handlers.ts:20-34` 作为独立 helper，adapter 端内联了相同逻辑
- adapter 的 `resolveAdapterRoute` 返回 `inboundType` 从 config 中的 `adapter.type` 推导，而 handler 中 `inboundType` 从 URL path 推导——两段式设计中统一由调用方负责 `inboundType`
- `forwardRequest` 在 `provider.ts:130-137` 中 catch 块已写 502 后 re-throw，`forwardPipeline` 的 502 检查会被 `headersSent` guard 短路——保持现状（`forwardRequest` 负责写 502）

---

## Key Technical Decisions

- **参数传递**：`parseAndAuth` 接收 `{ req, res, store, logger, maxBodyBytes }`，`forwardPipeline` 接收完整上下文 + 路由结果
- **日志标签**：`parseAndAuth` 接受 `logLabel` 参数区分 proxy/adapter 日志前缀
- **readBody 增强**：添加 `maxBytes` 可选参数，超限抛出特定错误而非静默截断
- **502 责任归属**：`forwardRequest` 保持现有行为（写 502 并 re-throw），`forwardPipeline` 的 catch 只做 token 统计和日志
- **inboundType**：`forwardPipeline` 接收 `inboundType` 作为显式参数，由调用方传入

---

## Open Questions

### Resolved During Planning

- `parseAndAuth` 返回类型 → 放在 `src/proxy/pipeline.ts` 中作为 `ParseResult` interface
- `readBody` 超限处理 → 在 `readBody` 中检查累计字节数，超限即中止读取并抛错
- `ServerContext` vs `ProxyContext` → 两者字段相同，`forwardPipeline` 接受 `ServerContext`（`src/api/server.ts` 已导出此类型）

### Deferred to Implementation

- 日志格式的具体字符串（从现有代码复制，不做变更）
- `readBody` 的 `maxBytes` 是否应改为 Config 可配置（当前写死 1MB 默认，未来可加）
- 工厂模式 `createHandler` 的可行性评估

---

## Implementation Units

- [ ] U1. **增强 readBody 加 Body 大小限制**

**Goal:** `readBody` 支持可选的 `maxBytes` 参数，超限时中止读取并返回错误

**Requirements:** R2, R11（Body 上限只影响超大请求，不影响正常范围请求）

**Dependencies:** None

**Files:**
- Modify: `src/lib/http-utils.ts`

**Approach:**
- 添加 `maxBytes?: number` 参数，默认 `1_000_000`
- 在每次 `chunks.push(chunk)` 前累加 `totalBytes += chunk.length`
- 超限时设置 `res.statusCode = 413`，写入 `{ error: { message: "请求体超过大小限制" } }`，返回 `null`（或抛错）
- 不修改 `readBody` 现有返回类型签名（返回 `string`，超限时抛错由调用方处理）

**Patterns to follow:** 现有 `readBody` 实现（`Buffer.concat` + `TextDecoder`）

**Test scenarios:**
- Happy path: 正常请求 Body → 完整返回字符串
- Edge case: Body 刚好等于 maxBytes → 成功返回
- Error path: Body 超过 maxBytes → 返回 `null` 且响应 413 已写
- Error path: maxBytes=0 → 立即拒绝

**Verification:**
- 2MB 请求返回 HTTP 413
- 1KB 请求（< 1MB）正常通过
- 现有测试中所有请求均 < 1MB，全部通过

---

- [ ] U2. **创建 src/proxy/pipeline.ts — parseAndAuth**

**Goal:** 抽取 Body 读取 + JSON 解析 + 认证 + model 提取为 `parseAndAuth`

**Requirements:** R1, R3, R4

**Dependencies:** U1

**Files:**
- Create: `src/proxy/pipeline.ts`

**Approach:**
- 函数签名：
  ```typescript
  async function parseAndAuth(
    req: IncomingMessage,
    res: ServerResponse,
    store: ConfigStore,
    logger: Logger,
    logLabel: string,
    maxBodyBytes?: number
  ): Promise<{ body: Record<string, unknown>; rawBody: string; modelName: string } | null>
  ```
- `logLabel` 用于错误日志前缀（proxy 传 `"/v1/messages"`，adapter 传 `"/${adapterName}"`）
- 错误路径直接写响应并返回 `null`
- 复用现有 `checkProxyAuth` helper（从 `handlers.ts` 导入或移入 `pipeline.ts`）

**Patterns to follow:** `src/proxy/handlers.ts:66-108`（Body→Parse→Auth→Model 块）

**Test scenarios:**
- Happy path: 有效 Body + 有效认证 → 返回 `{ body, rawBody, modelName }`
- Error path: 非 JSON Body → 400，返回 null
- Error path: proxyKey 已设但无 Auth header → 401，返回 null
- Error path: Body 缺少 model 字段 → 400，返回 null

**Verification:**
- 替换 `handleProxyRequest` 中前 40 行为 `parseAndAuth` 调用后，行为不变

---

- [ ] U3. **创建 src/proxy/pipeline.ts — forwardPipeline**

**Goal:** 抽取 transformInboundRequest → forwardRequest → capture → token 统计 → 计时为 `forwardPipeline`

**Requirements:** R5, R6, R7

**Dependencies:** U2

**Files:**
- Modify: `src/proxy/pipeline.ts`（追加）

**Approach:**
- 函数签名：
  ```typescript
  async function forwardPipeline(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    body: Record<string, unknown>,
    route: RouterResult,
    inboundType: InboundType,
    logLabel: string
  ): Promise<void>
  ```
- 内部流程：`transformInboundRequest` → 构建 `providerReq` → capture.startPair → `forwardRequest` → tokenTracker.record → 日志
- catch 块：`forwardRequest` 已写 502（如 headers 未发送），此处只记录 token 和日志
- 不改变现有 capture、token 统计、日志格式

**Patterns to follow:** `src/proxy/handlers.ts:109-143`（transform→forward→stats 块）

**Test scenarios:**
- Happy path: 正常非流式请求 → 200 响应 + token 统计更新
- Happy path: 正常流式请求 → SSE 流完成 + token 统计更新
- Error path: forwardRequest 抛错 + headers 未发送 → 502（由 forwardRequest 写入）
- Error path: forwardRequest 抛错 + headers 已发送 → 连接关闭（由 forwardRequest 处理）

**Verification:**
- 现有 115 个测试全部通过
- Admin 面板中 token 统计和日志与重构前一致

---

- [ ] U4. **重构 proxy/handlers.ts 调用 pipeline**

**Goal:** 将三个 proxy handler（`handleAnthropicMessages`、`handleOpenAIChat`、`handleOpenAIResponses`）改为调用 `parseAndAuth` + `routeModel` + `forwardPipeline`

**Requirements:** R8, R10

**Dependencies:** U2, U3

**Files:**
- Modify: `src/proxy/handlers.ts`

**Approach:**
- 每个 handler 结构：
  ```typescript
  const pre = await parseAndAuth(req, res, ctx.store, ctx.logger, '/v1/messages')
  if (!pre) return
  const route = routeModel(ctx.store, pre.modelName)
  await forwardPipeline(ctx, req, res, pre.body, route, 'anthropic', '/v1/messages')
  ```
- `checkProxyAuth` helper 可保留在 `handlers.ts` 或移入 `pipeline.ts`
- 删除旧的 `handleProxyRequest` 函数

**Patterns to follow:** 现有 handler 中的 `routeModel` 调用和 inboundType 硬编码

**Test scenarios:**
- Happy path: 分别对 `/v1/messages`、`/v1/chat/completions`、`/v1/responses` 发请求 → 正常响应
- Error path: 不存在的 model → 404（由 routeModel 抛出）

**Verification:**
- proxy/handlers.ts 缩减到 ~40 行
- 所有现有集成测试通过

---

- [ ] U5. **重构 adapter/handlers.ts 调用 pipeline**

**Goal:** 将 `handleAdapterRequest` 改为调用 `parseAndAuth` + `resolveAdapterRoute` + `forwardPipeline`

**Requirements:** R9, R10

**Dependencies:** U2, U3

**Files:**
- Modify: `src/adapter/handlers.ts`

**Approach:**
- 从 URL 提取 `adapterName`（保持现有 `ADAPTER_PATH_RE`）
- 从 URL path 推导 `inboundType`
- 结构：
  ```typescript
  const pre = await parseAndAuth(req, res, ctx.store, ctx.logger, `/${adapterName}`)
  if (!pre) return
  const result = resolveAdapterRoute(ctx.store, adapterName, pre.modelName)
  await forwardPipeline(ctx, req, res, pre.body, result.route, inboundType, `/${adapterName}`)
  ```
- 保留 `resolveAdapterRoute` 的 AdapterError 类型错误处理（状态码区分 404/502）

**Patterns to follow:** 现有 `src/adapter/handlers.ts:44-163` 中的 URL 解析和路由逻辑

**Test scenarios:**
- Happy path: 适配器端点正常请求 → 正常响应
- Error path: adapterName 不存在 → 404
- Error path: model 映射不存在 → 404

**Verification:**
- adapter/handlers.ts 缩减到 ~50 行（含 `handleAdapterModels`）
- 所有现有适配器测试通过

---

- [ ] U6. **验证：全量测试通过**

**Goal:** 确认 115 个测试全绿，无行为回退

**Requirements:** R11, R12

**Dependencies:** U4, U5

**Files:**
- Test: `test/**/*.test.ts`（只运行，不修改）

**Approach:**
- 运行 `node --import tsx --test test/**/*.test.ts`
- 确认 115/115 pass
- 如有失败，修复后重新运行

**Test scenarios:**
- 不新增测试场景——仅验证现有测试通过

**Verification:**
- `node --import tsx --test test/**/*.test.ts` 输出 `ℹ pass 115, ℹ fail 0`

---

## System-Wide Impact

- **Interaction graph:** 所有 proxy 和 adapter 请求经过 `parseAndAuth` + `forwardPipeline`，行为等同于原两处 handler
- **Error propagation:** 错误路径不变——`parseAndAuth` 写 400/401/413，`forwardRequest` 写 502
- **State lifecycle risks:** 无——pipeline 函数本身无状态，所有状态在 ServerContext 中
- **API surface parity:** 三个 proxy 端点 + `/{adapter}/v1/*` 端点行为不变
- **Unchanged invariants:** `routeModel` 和 `resolveAdapterRoute` 行为完全不变；正则路由表完全不变

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `ServerContext` vs `ProxyContext` 类型不兼容 | 两者字段相同（store, tracker, tokenTracker, logger, capture），`forwardPipeline` 接受 `ServerContext` |
| 日志格式差异导致测试失败 | 从现有代码逐字复制日志字符串，不做变更 |
| Body 限制意外影响正常请求 | 默认 1MB，所有现有测试 payload < 1KB |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-30-unified-pipeline-requirements.md](docs/brainstorms/2026-04-30-unified-pipeline-requirements.md)
- Related code: `src/proxy/handlers.ts`, `src/adapter/handlers.ts`, `src/proxy/provider.ts`
- Prior ideation: [docs/ideation/2026-04-30-llm-proxy-phase2-ideation.md](docs/ideation/2026-04-30-llm-proxy-phase2-ideation.md)
