---
date: 2026-04-30
topic: unified-request-pipeline
---

# Unified Request Pipeline — 消除 proxy/adapter handler 重复

## Problem Frame

`src/proxy/handlers.ts`（144 行）和 `src/adapter/handlers.ts`（164 行）实现了 85% 相同的请求处理逻辑：readBody、JSON 解析、认证、model 校验、transformInboundRequest、forwardRequest、capture、token 统计、计时、错误处理。

两处唯一的结构性差异：
- **路由解析**：proxy 调 `routeModel(store, modelName)`，adapter 调 `resolveAdapterRoute(store, adapterName, modelName)`
- **日志标签**：proxy 用 `/v1/messages` 等路径标签，adapter 用 `/${adapterName}/v1/...` 格式

任何横切改动（限流、超时、Body 大小限制、指标导出）当前必须在两个文件中分别实现。本重构将共享逻辑抽取为两个可复用函数，调用方只保留各自独特的路由解析和日志标识。

---

## Requirements

**parseAndAuth — 请求预处理**

- R1. `parseAndAuth` 处理：读取请求 Body（含大小限制）、JSON 解析、代理认证、model 字段提取
- R2. Body 大小限制默认 1MB，可通过参数覆盖。超限返回 HTTP 413，Body 不被进一步处理
- R3. JSON 解析失败返回 HTTP 400，认证失败返回 HTTP 401，model 缺失返回 HTTP 400。错误响应的 Content-Type 为 `application/json`，body 包含 `{ error: { message } }`
- R4. 成功时返回 `{ body, rawBody, modelName }`；任何错误路径返回 `null`（响应已写入 res）

**forwardPipeline — 请求转发**

- R5. `forwardPipeline` 处理：调用 `transformInboundRequest` → 构建 `providerReq` → `forwardRequest` → 记录 capture → 记录 token 统计 → 记录延迟日志
- R6. `forwardRequest` 抛错时，如果响应头未发送则返回 HTTP 502（含标准 JSON error body），已发送则记录错误日志并结束连接
- R7. Token 统计使用 `TokenTracker.record()`，延迟通过 `Date.now() - startTime` 计算，日志格式保持现有结构

**调用方适配**

- R8. Proxy handler（`handleAnthropicMessages` 等三个函数）改为：调用 `parseAndAuth` → 用返回的 modelName 调用 `routeModel` → 调用 `forwardPipeline`
- R9. Adapter handler（`handleAdapterRequest`）改为：解析 URL 提取 adapterName → 调用 `parseAndAuth` → 用 adapterName + modelName 调用 `resolveAdapterRoute` → 调用 `forwardPipeline`
- R10. 所有调用方的日志标签保持现有格式

**非功能约束**

- R11. 不改变任何对外 API 行为：请求/响应格式、状态码、错误消息均不变
- R12. 现有 115 个测试全部通过，无需修改测试断言

---

## Acceptance Examples

- AE1. **Covers R1, R2.** 向 `/v1/chat/completions` 发送一个 2MB 的请求体 → 返回 HTTP 413，body 为 `{"error":{"message":"请求体超过大小限制"}}`
- AE2. **Covers R3.** 向 `/v1/messages` 发送非 JSON 请求体 → 返回 HTTP 400，body 为 `{"error":{"message":"请求体不是有效的 JSON"}}`
- AE3. **Covers R3.** 设置 proxyKey 后，无 Authorization header 发送请求 → 返回 HTTP 401
- AE4. **Covers R5, R8.** 正常 OpenAI Chat 流式请求 → SSE 流正常返回，token 统计更新，admin 日志记录延迟和 token 数

---

## Success Criteria

- proxy/handlers.ts 缩减到 ~40 行（当前 144 行），adapter/handlers.ts 缩减到 ~35 行（当前 164 行）
- 新增 src/proxy/pipeline.ts，含 `parseAndAuth` 和 `forwardPipeline` 两个函数，总计 ~80 行
- 115 个测试全绿，无断言修改
- 任意横切功能（如后续加速率限制）只需在一个地方添加

---

## Scope Boundaries

- 不引入中间件抽象或 filter chain
- 不改变 proxy/adapter 的路由注册方式（正则路由表保持不变）
- 不合并 proxy 和 adapter 的 route resolver（`routeModel` 和 `resolveAdapterRoute` 保持独立）
- 不做 config store 的并发安全改进（单独议题）

---

## Key Decisions

- **两段式而非回调式**：将 pipeline 拆为 `parseAndAuth` + `forwardPipeline` 两段，路由解析在中间由调用方完成。避免回调参数增加心智负担
- **Body 大小限制顺手加入**：`readBody` 加 `maxBytes` 参数，默认 1MB。改动成本极低，且是当前代码库中最直接的 DoS 向量
- **不引入中间件**：本次只消除重复，中间件留作后续独立需求

---

## Dependencies / Assumptions

- `RouterResult` 类型（`src/proxy/types.ts`）保持不变
- `AdapterRouteResult` 的 `route` 字段是 `RouterResult`，`forwardPipeline` 只收 `RouterResult` 不收 `AdapterRouteResult`
- `forwardRequest` 的函数签名不发生本次重构之外的变化

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1][Technical] 是否在 `readBody` 中直接返回大小超限错误，还是让 `parseAndAuth` 自己检查？
- [Affects R4][Technical] `parseAndAuth` 返回的类型放在 `src/proxy/pipeline.ts` 还是 `src/proxy/types.ts`？
- [Affects R5,R9][Review: adversarial, feasibility] `inboundType` 流向需明确：`forwardPipeline` 必须接收 `inboundType` 参数，adapter 端从 URL path 推导而非 `AdapterRouteResult.inboundType`
- [Affects R2,R11][Review: scope-guardian, adversarial] R2 Body 1MB 限制违反 R11（新增 HTTP 413），且 1MB 默认值缺依据——base64 图片请求常超此值
- [Affects Problem Frame][Review: adversarial] 实际差异超"85%"估算：认证调用方式、路由错误语义、URL解析时机均不同，pipeline 函数可能超 ~80 行预估
- [Affects R4][Review: adversarial] `parseAndAuth` 返回 null 的约定在跨模块边界后无编译期保障，调用方漏掉 null 检查会导致 `ERR_STREAM_WRITE_AFTER_END`
- [Affects R1,R10][Review: feasibility] `parseAndAuth` 需区分 proxy 与 adapter 的日志格式——添加 `logContext` 参数
- [Affects R1,R5][Review: feasibility] `parseAndAuth` 和 `forwardPipeline` 的上下文参数形状需定义——使用统一 `PipelineContext` 还是分别传参
- [Affects R6][Review: feasibility] `forwardRequest` 已写 502，`forwardPipeline` 再做一次检查会短路——需明确 502 责任归属
- [Affects R5,R10][Review: adversarial] `forwardPipeline` 只收 `RouterResult` 不含 `adapterName`，但 adapter 日志需要此字段
- [Affects Success Criteria][Review: adversarial] adapter/handlers.ts ~35 行目标不现实（实际约需 46 行），建议调至 ~50 行
- [Affects Key Decisions][Review: adversarial] 工厂模式 `createHandler` 可将调用方缩减为一行，未被评估

### FYI (from review)

- [Success Criteria] 文件路径前缀不一致：`proxy/handlers.ts` vs `src/proxy/pipeline.ts`（coherence）

---

## Next Steps

-> `/ce-plan` for structured implementation planning
