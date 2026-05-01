---
date: 2026-04-25
topic: tool-adapters
---

# 工具适配器 (Tool Adapters)

## Problem Frame

目前 llm-proxy 的 Provider 配置（OpenAI/Anthropic 上游 API）和模型暴露是直接的——工具通过 `/v1/chat/completions` 或 `/v1/messages` 请求时，直接使用 Provider 中定义的模型名（如 `gpt-4o`、`claude-sonnet`）。

问题在于：
- 工具（Claude Code、Cursor、Continue 等）各自配置了固定的模型名和 base_url
- 想切换工具使用的模型时，需要去改工具的配置，而不是在代理端控制
- 同一个模型名在不同工具中可能含义不同，缺乏隔离

需要一个**适配器层**作为工具和 Provider 之间的桥梁，让工具配置一次后，改模型只需改代理配置。

## Requirements

### 适配器配置 (R1-R5)
- R1. 在 config.yaml 中新增 `adapters` 段，与 `providers` 平级，支持热重载
- R2. 每个适配器定义：名称（name）、暴露的 API 格式（format: anthropic | openai）、模型映射列表
- R3. 每个模型映射定义：工具使用的模型名（name）、目标 Provider 名（provider）、目标 Provider 中的模型名（model）
- R4. 适配器名称在 yaml 中唯一，不允许与已有 Provider 名冲突（URL 路径冲突）
- R5. 模型映射中的 provider 和 model 在请求时动态解析，引用不存在或已被热重载移除的 provider/model 时返回 502

### 端点暴露 (R6-R7)
- R6. 每个适配器根据 format 自动注册专属路径，工具名称在前：
  - `format: anthropic` → `POST /{adapter-name}/v1/messages`
  - `format: openai` → `POST /{adapter-name}/v1/chat/completions`
- R7. adapter-name 作为路径段，需符合 URL 安全字符（字母、数字、连字符、下划线）
- R7a. adapter-name 禁止为保留字：`messages`、`chat`、`completions`、`admin` 以及与现有 /v1/ 路径冲突的其他值

### 请求处理 (R8-R12)
- R8. 适配器收到请求后，从请求体中提取工具发送的 model name，在适配器模型映射中查找对应的 provider + model
- R9. 找到映射后，从 Provider 配置获取 Provider 类型、API Key、API Base、上游模型名，构造 RouterResult
- R10. 复用现有的 `transformInboundRequest` + `forwardRequest` 基础设施路由请求（自动处理同/跨协议转换和流式处理）
- R11. 适配器名称不存在时返回 404；工具发送的 model name 未在适配器映射中找到时返回 404
- R12. 映射指向的 Provider 或模型在被引用时实时查找（支持热重载后 Provider 变更）

### 管理 API (R13-R14)
- R13. 新增 `GET /admin/adapters` 返回适配器列表及状态（当前映射的 provider/model）
- R14. 日志中记录适配器名称，便于追踪请求来源

### Web UI (R15-R16)
- R15. 仪表盘页面统计适配器数量
- R16. 适配器列表页面展示每个适配器的模型映射和状态

## Config 示例

```yaml
providers:
  - name: openai-main
    type: openai
    api_key: ${OPENAI_API_KEY}
    models:
      - name: gpt-4o
        model: gpt-4o
      - name: gpt-4o-mini
        model: gpt-4o-mini

  - name: anthropic-main
    type: anthropic
    api_key: ${ANTHROPIC_API_KEY}
    models:
      - name: claude-sonnet
        model: claude-sonnet-4-20250514
      - name: claude-haiku
        model: claude-3-haiku-20240307

adapters:
  # Claude Code: 用 Anthropic 格式请求，可映射多个模型
  - name: claude-code
    format: anthropic
    models:
      - name: sonnet
        provider: anthropic-main
        model: claude-sonnet
      - name: haiku
        provider: anthropic-main
        model: claude-haiku
      - name: fast
        provider: openai-main
        model: gpt-4o-mini  # 跨协议: Anthropic 格式 → OpenAI Provider

  # Cursor: 用 OpenAI 格式请求
  - name: cursor
    format: openai
    models:
      - name: gpt-4o
        provider: openai-main
        model: gpt-4o
      - name: claude
        provider: anthropic-main
        model: claude-sonnet  # 跨协议: OpenAI 格式 → Anthropic Provider
```

## 请求处理流程

```
Claude Code
  → POST /claude-code/v1/messages { model: "sonnet", ... }
  → 匹配适配器路径 /claude-code/v1/messages
  → 适配器 format: anthropic → 用 Anthropic 格式解析请求体
  → 模型映射: "sonnet" → provider "anthropic-main" + model "claude-sonnet"
  → 从 Provider 配置获取: type=anthropic, apiKey=xxx, apiBase=..., upstreamModel="claude-sonnet-4-20250514"
  → 构造 RouterResult → 复用 transformInboundRequest + forwardRequest
  → 同协议透传 → 上游 Anthropic API
  → 同协议透传响应 → Claude Code 收到 Anthropic 格式
```

```
Cursor
  → POST /cursor/v1/chat/completions { model: "claude", ... }
  → 匹配适配器路径 /cursor/v1/chat/completions
  → 适配器 format: openai → 用 OpenAI 格式解析请求体
  → 模型映射: "claude" → provider "anthropic-main" + model "claude-sonnet"
  → 构造 RouterResult → 复用 transformInboundRequest + forwardRequest
  → 跨协议: OpenAI 格式 → Anthropic 上游 (自动翻译 + 流式转换)
  → 响应: Anthropic 响应 → OpenAI 格式返回
```

## 路由优先级

新的适配器路径和现有路径的匹配关系（按 ROUTES 中的注册顺序）：
- `/v1/messages` → 现有的 handleAnthropicMessages（保持不变）
- `/v1/chat/completions` → 现有的 handleOpenAIChat（保持不变）
- `/{adapter-name}/v1/messages` → 由适配器路由处理
- `/{adapter-name}/v1/chat/completions` → 由适配器路由处理

通配路由 `/{name}/v1/{action}` 注册在 ROUTES 数组末尾，匹配不到时自然 fallthrough 到 404。适配器路径与现有路由不冲突（adapter-name 禁止为 `admin`、`v1` 等保留字）。

## Scope Boundaries

- Adapter 不做模型列表的自动发现——映射需要显式配置
- Adapter 不做请求缓存、限流、或 fallback——这些是后续功能
- 不改动现有的 Provider 配置结构
- 现有的 /v1/messages 和 /v1/chat/completions 端点继续保留

## Key Decisions

- **专属端点路径路由**：适配器使用独立路径前缀（如 `/claude-code/v1/`），工具名称在前——配置更清晰，工具设置 base_url 时更自然
- **通配路由调度**：在 server.ts 的 ROUTES 末尾添加通配符正则 `/^\/([a-zA-Z0-9_-]+)\/v1\/(messages|chat\/completions)$/`，匹配失败时自然 fallthrough 到 404。通配路由在现有 /v1/ 路由之后匹配，不干扰现有端点
- **复用现有 proxy 基础设施**：适配器解析映射后，构造 RouterResult 交给 `transformInboundRequest` + `forwardRequest`，天然支持跨协议和流式
- **适配器配置与 Provider 同文件**：放在同一个 config.yaml，支持热重载统一管理
- **请求时动态解析**：适配器映射中的 provider/model 引用在请求时验证，而非配置加载时。provider 或 model 不存在时返回 502

## Dependencies / Assumptions

- 假设现有 `transformInboundRequest` 和 `forwardRequest` API 足够适配器使用，无需修改
- 适配器映射中的 provider 和 model 在请求时动态解析（resolveAdapterRoute），引用不存在时返回 502——热重载后变更立即可见
- 需要在 `router.ts` 或新建 `adapter/router.ts` 中新增按名称查找 Provider 和按名称在 Provider 内查找 Model 的工具函数

## Outstanding Questions

### Deferred to Planning
- [Affects R1][Technical] 适配器的类型定义放在 `types.ts` 还是新建 `adapter/types.ts`？
- [Affects R15-R16][Needs design] Web UI 中适配器页面的具体设计
- [Affects R13][Needs research] `GET /admin/adapters` 响应格式如何与现有 `GET /admin/status/providers` 保持一致
