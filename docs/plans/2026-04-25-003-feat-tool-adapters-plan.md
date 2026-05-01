---
title: feat: 工具适配器 (Tool Adapters)
type: feat
status: active
date: 2026-04-25
origin: docs/brainstorms/2026-04-25-tool-adapters-requirements.md
---

# 工具适配器 (Tool Adapters)

## Overview

在 llm-proxy 中新增适配器层，让工具（Claude Code、Cursor 等）通过专属端点路径配置一次，后续改模型只需改代理配置，无需修改工具配置。

## Problem Frame

Provider 和模型是直接暴露的——工具请求 `/v1/chat/completions` 时直接使用 Provider 定义的模型名。切换工具的模型需要改工具配置，多工具共用 Provider 时缺乏隔离。适配器层作为桥梁，工具配置一次 base_url 和模型名，后续模型切换完全由代理端控制。（见 origin: R1-R3）

## Requirements Trace

### 适配器配置 (R1-R5)
- R1-R5: 适配器配置（config.yaml 新增 adapters 段，支持热重载，请求时动态解析引用）

### 端点暴露 (R6-R7, R7a)
- R6-R7: 端点暴露（`/{adapter-name}/v1/messages` 和 `/{adapter-name}/v1/chat/completions`）
- R7a: adapter-name 保留字禁止（admin、v1、messages、chat 等）

### 请求处理 (R8-R12)
- R8-R12: 请求处理（模型映射解析 → 复用 proxy 基础设施 → 错误处理）

### 管理 API (R13-R14)
- R13-R14: 管理 API（`GET /admin/adapters`，日志记录适配器名称）

### Web UI (R15-R16)
- R15-R16: Web UI（仪表盘统计 + 适配器列表页）

## Scope Boundaries

- 模型映射需要显式配置，不做自动发现
- 不做请求缓存、限流或 fallback
- 不改动现有的 Provider 配置结构、Proxy 基础设施
- 现有的 `/v1/messages` 和 `/v1/chat/completions` 端点保持不变

## Context & Research

### Relevant Code and Patterns

- **Config types**: `src/config/types.ts` — `Config`, `Provider`, `Model` 类型定义模式
- **Config parser**: `src/config/parser.ts` — YAML → camelCase 转换，env var 插值
- **Config validator**: `src/config/validator.ts` — 字段存在性检查、唯一性检查、合法字符检查
- **Proxy routing**: `src/proxy/router.ts` — `routeModel(store, modelName)` → `RouterResult`，遍历 providers 匹配 model name
- **Proxy handler**: `src/proxy/handlers.ts` — `handleAnthropicMessages` / `handleOpenAIChat`，聚合了读 body、model routing、参数转换、请求转发、错误处理
- **HTTP server routing**: `src/api/server.ts` — `ROUTES: Route[]` 编译时常量，顺序正则匹配
- **Admin handlers**: `src/api/handlers.ts` — 统一响应格式 `{ success, data }`
- **Admin UI**: `src/api/admin-ui.html` — Provider 列表展示模式（名称、类型、状态、模型数）

## Key Technical Decisions

- **Adapter 类型定义放在 `config/types.ts`**：AdapterConfig 是 Config 的一部分（从同一 config.yaml 加载），与 Provider 类型平级，放在 config/types.ts 无需额外 import 依赖
- **通配正则路由单匹配**：ROUTES 末尾添加 `/^\/([a-zA-Z0-9_-]+)\/v1\/(messages|chat\/completions)(\?.*)?$/`，handler 从 req.url 二次提取 adapter name。正则以 `(\?.*)?$` 结尾以支持 query 参数
- **handler 按 adapter config 的 format 决定请求格式**：不论 URL 路径是 messages 还是 chat/completions，都以 adapter config 中的 format 为准解析请求体——避免配置和路径不一致导致歧义
- **resolveAdapterRoute 返回扩展结果**：返回 `{ route: RouterResult, inboundFormat: 'anthropic' | 'openai' }`，使 handler 能直接获取 inboundFormat 传给 `transformInboundRequest`
- **请求时动态验证 provider/model 引用**：resolveAdapterRoute 每次请求时从 ConfigStore 最新版本读取 providers 数组，按名称进行 O(n) 查找。热重载后变更即时生效

## Implementation Units

### Unit 1: Config types, parser, and validator for adapters

**Goal:** 定义 AdapterConfig/AdapterModelMapping 类型，扩展 Config 结构，解析和校验 adapters 配置段

**Requirements:** R1-R4, R7a

**Dependencies:** None

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/parser.ts`
- Modify: `src/config/validator.ts`

**Approach:**
- 在 `types.ts` 中新增 `AdapterModelMapping`（name, provider, model）和 `AdapterConfig`（name, format, models[]）接口
- 扩展 `Config` 增加 `adapters: AdapterConfig[]`，扩展 `ConfigFile` 增加 `adapters` 原始字段
- `parser.ts`: 在已有的 `loadConfigFromYaml` 返回值中添加 `adapters` 映射（snake_case → camelCase 转换由已有逻辑处理，adapters 无需额外转换）
- `validator.ts`: 新增 `validateAdapters` 函数，校验：
  - adapters 是数组（非必须字段，允许空数组或缺失）
  - 每个 adapter 有 name, format 为 anthropic/openai, models 非空数组
  - adapter name 唯一，且不与任何 provider name 冲突
  - adapter name 合法字符 + 保留字检查（禁 admin、v1、messages、chat 等）
  - 每个 mapping 有 name, provider, model 字符串字段，非空
- 验证器**不**校验 provider/model 引用的存在性（请求时动态解析，见 R5）

**Patterns to follow:**
- `types.ts` 中 `Config` 和 `ConfigFile` 的对偶模式
- `validator.ts` 中 `validateConfig` 的 error 收集模式（收集所有错误不中断）

**Test scenarios:**
- Happy path: 合法 adapters 配置通过验证
- Edge case: 空 adapters 数组（允许）
- Edge case: adapter name 为保留字（admin, v1 等 → 拒绝）
- Edge case: adapter name 与 provider name 重复（拒绝）
- Error: adapter format 不是 anthropic/openai
- Error: adapter models 为空
- Error: adapter name 为空

**Verification:**
- 类型定义编译通过
- 包含 adapters 的 YAML 正确解析为 Config 结构
- 非法配置返回正确的 ValidationError 列表

---

### Unit 2: Adapter router (resolveAdapterRoute)

**Goal:** 实现按 adapter name + tool model name 解析为目标 Provider 路由的核心函数

**Requirements:** R5, R8-R9, R12

**Dependencies:** Unit 1

**Files:**
- Create: `src/adapter/router.ts`
- Test: `test/adapter/router.test.ts`

**Approach:**
- 创建 `resolveAdapterRoute(store: ConfigStore, adapterName: string, toolModelName: string): { route: RouterResult; inboundFormat: 'anthropic' | 'openai' }`
- 从 `store.getConfig()` 获取当前 config
- 按 `adapterName` 在 `config.adapters` 中查找对应的 AdapterConfig，同时获取其 format
- 按 `toolModelName` 在 AdapterConfig.models 中查找匹配的 AdapterModelMapping
- 按 mapping.provider 在 `config.providers` 中查找目标 Provider
- 按 mapping.model（即 provider 内的 model name）在该 Provider 的 models 中查找具体 Model，获取上游模型名
- 不存在时抛出带错误码的异常（适配器未找到 / 模型映射未找到 / Provider 不存在 / Model 不存在）

**Patterns to follow:**
- `src/proxy/router.ts` 中 `routeModel` 的异常抛出模式

**Test scenarios:**
- Happy path: 合法 adapter name + 合法 tool model name → 返回正确的 RouterResult（providerName, providerType, apiKey, apiBase, upstreamModel）
- Happy path: 映射到 OpenAI provider + 跨协议场景 → 正确的 providerType 和 apiBase
- Error: adapterName 不存在 → 抛出 "适配器未找到" 错误
- Error: toolModelName 在 adapter 映射中不存在 → 抛出 "模型映射未找到" 错误
- Error: mapping 的 provider 在 config 中不存在 → 抛出 "Provider 不存在" 错误
- Error: mapping 的 model 在 provider 中不存在 → 抛出 "Model 不存在" 错误

**Verification:**
- 所有测试场景通过
- 异常消息清晰区分 404 和 502 场景

---

### Unit 3: Server routing and adapter handler

**Goal:** 注册适配器请求的通配路由，实现 handleAdapterRequest 处理入口函数

**Requirements:** R6-R7, R10-R11, R14

**Dependencies:** Unit 2

**Files:**
- Create: `src/adapter/handlers.ts`
- Modify: `src/api/server.ts`
- Test: `test/adapter/handlers.test.ts`

**Approach:**
- `server.ts`:
  - 在 ROUTES 末尾添加通配路由（在 /v1/ 路由之后）：
    ```typescript
    { method: 'POST', pattern: /^\/([a-zA-Z0-9_-]+)\/v1\/(messages|chat\/completions)(\?.*)?$/, handler: handleAdapterRequest }
    ```
  - handler 内从 `req.url` 二次 match 正则提取 adapter name
  - 修复现有 `/admin/logs` 路由正则，改为 `/^\/admin\/logs(\?.*)?$/` 以支持 query 参数
- `adapter/handlers.ts`:
  - `handleAdapterRequest(ctx, req, res)` 函数
  - 从 req.url 提取 adapter name
  - 读请求体 → JSON 解析 → 提取 model name
  - 调 `resolveAdapterRoute(ctx.store, adapterName, modelName)` 获取 `{ route: RouterResult, inboundFormat }`
  - 调 `transformInboundRequest(inboundFormat, route, body)` 构造上游请求
  - 调 `forwardRequest({ ...route, inboundFormat }, res)` 转发
  - 日志记录 adapterName（见 R14）
  - 错误处理：
    - resolveAdapterRoute 抛 "适配器未找到" → 404
    - resolveAdapterRoute 抛 "模型映射未找到" → 404
    - resolveAdapterRoute 抛 "Provider 不存在" → 502
    - resolveAdapterRoute 抛 "Model 不存在" → 502
    - 其他错误 → 502（与现有 handlers.ts 一致）

**Patterns to follow:**
- `src/proxy/handlers.ts` — `handleAnthropicMessages` 的 body 读取、错误处理、日志记录模式
- `server.ts` — ROUTES 注册模式

**Test scenarios:**
- Happy path: 存在适配器 + 存在模型映射 → 成功转发请求
- Edge case: 请求体 model name 在适配器映射中但 provider/model 引用失效 → 502
- Error: 适配器名称在 config 中不存在 → 404
- Error: model name 在适配器映射中不存在 → 404
- Error: 请求体不是合法 JSON → 400
- Integration: 跨协议映射通过 handler 正确路由

**Verification:**
- 单元测试覆盖主要错误路径和一条 happy path
- handleAdapterRequest 与现有 handlers 的请求处理路径无缝衔接

---

### Unit 4: Admin API — GET /admin/adapters

**Goal:** 新增管理 API 端点，返回适配器列表及当前映射状态

**Requirements:** R13

**Dependencies:** Unit 1

**Files:**
- Modify: `src/api/handlers.ts`
- Modify: `src/api/server.ts`

**Approach:**
- 在 `api/handlers.ts` 新增 `handleGetAdapters`：
  - 从 `ctx.store.getConfig()` 获取 adapters
  - 为每个 adapter 的每个 model mapping 解析当前状态：
    - 实时检查 mapping 的 provider 和 model 是否存在于当前 config
    - 返回 ok/error 状态
  - 响应格式：`{ success: true, data: { adapters: [{ name, format, models: [{ name, provider, model, status: 'ok' | 'provider_not_found' | 'model_not_found' }] }] } }`
- 在 `server.ts` ROUTES 中添加：`{ method: 'GET', pattern: /^\/admin\/adapters$/, handler: handleGetAdapters }`

**Patterns to follow:**
- `api/handlers.ts` 中现有 admin handler 的统一响应格式

**Test scenarios:**
- Happy path: 返回所有 adapter 列表，每个 mapping 状态为 ok
- Edge case: 某个 mapping 的 provider 已被热重载删除 → 状态为 provider_not_found
- Edge case: adapters 段为空 → 返回空数组

**Verification:**
- 手动测试 GET /admin/adapters 返回格式和内容正确
- 配合测试覆盖正常和异常状态

---

### Unit 5: Web UI — 适配器展示

**Goal:** 在管理后台展示适配器信息和模型映射状态

**Requirements:** R15-R16

**Dependencies:** Unit 4

**Files:**
- Modify: `src/api/admin-ui.html`

**Approach:**
- 仪表盘页面：适配器数量卡片（在 statCards 中添加）
- 适配器列表页面：在现有的 Providers 页面 / 新增页面中展示每个 adapter 的映射列表
  - 表格列：适配器名称、暴露格式、模型映射（工具模型名 → Provider → 目标模型名）、状态
- 复用 `/admin/adapters` API 获取数据
- 或在现有 Providers Tab 中新增 Adapters 区域
- 适配器数量显示在侧边栏 Providers Tab 或独立 Tab

**Patterns to follow:**
- Providers 页面的 `loadProviders()` API 调用和表格渲染模式
- 侧边栏 Tab 的注册模式

**Test scenarios:**
- 无适配器配置时显示"暂无适配器"
- 有适配器时显示名称、格式、模型映射
- 映射状态异常时显示状态标记

**Verification:**
- 浏览器中打开 admin UI，确认适配器信息正确展示
- 适配器数在仪表盘卡片中显示

---

### Unit 6: Integration tests

**Goal:** 端到端验证适配器路由 + 请求转发的正确性

**Requirements:** R6, R8-R11

**Dependencies:** Units 1-3

**Files:**
- Modify: `test/api/integration.test.ts`

**Approach:**
- 在 mock upstream server 内添加适配器相关测试场景
- 创建包含适配器配置的 test Config
- 测试通过适配器端点发送请求，验证请求被正确路由到目标 provider 的 mock upstream

**Patterns to follow:**
- 现有的 integration.test.ts 中的 mock server 启动、Config 创建、fetch 请求模式

**Test scenarios:**
- Integration: 通过 `/claude-code/v1/messages` 发送 Anthropic 格式请求，同协议路由到 anthropic provider
- Integration: 通过 `/cursor/v1/chat/completions` 发送 OpenAI 格式请求，跨协议路由到 anthropic provider
- Integration: 使用不存在的 adapter name → 404
- Integration: 使用适配器映射中不存在的 model name → 404
- Integration: 验证日志中包含 adapter name

**Verification:**
- 新增的集成测试与现有 67 个测试一起全部通过
- 验证适配器端点和直接 /v1/ 端点不冲突

## System-Wide Impact

- **Interaction graph:** 适配器 handler 的请求处理路径与现有 proxy handler 共享 `transformInboundRequest → forwardRequest` 链路。适配器只替换了路由查找阶段（routeModel → resolveAdapterRoute），不影响上游请求的发送和响应处理
- **Error propagation:** resolveAdapterRoute 的错误有 404 / 502 两种，handleAdapterRequest 根据错误类型映射 HTTP 状态码，与现有 handler 的错误处理风格一致
- **API surface parity:** 现有 /v1/messages 和 /v1/chat/completitions 端点不受影响。适配器新端点与现有端点是独立的 URL namespace
- **Unchanged invariants:** Provider 配置结构、ConfigStore API、proxy/translation.ts、proxy/provider.ts、proxy/stream-converter.ts 均无变更
- **Hot-reload behavior:** 适配器配置（包括增删适配器、修改映射）通过现有 config.yaml 热重载即时生效。请求时动态解析确保不出现 stale reference

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 适配器路径与现有路由冲突 | adapter-name 保留字验证 + 通配路由注册在 ROUTES 末尾（先匹配现有精确路由） |
| 热重载后 provider 被删除导致适配器映射失效 | 请求时动态验证，引用不存在时返回 502，不崩溃不阻塞 |
| 通配路由意外匹配非适配器路径 | 正则限制为 `/{name}/v1/{messages\|chat/completions}` 模式，非此格式不匹配 |

## Open Questions

### Resolved During Planning

- **适配器类型定义位置** → 放在 `config/types.ts`，与 Provider 类型平级。AdapterConfig 属于 Config 的一部分
- **通配路由匹配方式** → 一个正则匹配所有 `/{name}/v1/{action}` 请求，handler 内从 `req.url` 二次正则提取 adapter name
- **handler 中的 format 来源** → 从 adapter config 中读取 format，而不是从 URL 路径推断。防止配置不一致引发的混淆
- **resolveAdapterRoute 返回类型** → 返回 `{ route: RouterResult; inboundFormat: 'anthropic' | 'openai' }` 扩展结果，使 handler 可直接获取 inboundFormat
- **通配正则 query 参数支持** → 所有 ROUTES 正则添加 `(\?.*)?$` 结尾以支持 query 参数。同时修复现有 `/admin/logs` 路由的正则模式（潜在 bug）

### Deferred to Implementation

- Web UI 的具体页面布局（现有的 Provider Tab 下方展示还是独立 Tab）
- GET /admin/adapters 响应中每个 adapter 是否包含 resolved 后的 upstream 信息

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-25-tool-adapters-requirements.md](../brainstorms/2026-04-25-tool-adapters-requirements.md)
- Related code: `src/proxy/router.ts` (routeModel pattern), `src/api/server.ts` (ROUTES pattern), `src/proxy/handlers.ts` (handler pattern)
