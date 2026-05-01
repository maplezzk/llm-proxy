# llm-proxy API 规范文档

> 版本：基于当前实现整理，供与官方规范核对使用

---

## 一、代理 API（兼容官方格式）

### 1.1 Anthropic Messages API

**端点**
```
POST /v1/messages
```

**请求头**
| 字段 | 说明 |
|------|------|
| `x-api-key` | 任意字符串（代理不校验，仅转发时替换为真实 key） |
| `anthropic-version` | 透传，固定发送 `2023-06-01` 给上游 |
| `Content-Type` | `application/json` |

**请求体（已实现字段）**
| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | string | 必填，用于路由到对应 provider |
| `messages` | array | 必填，支持 `user` / `assistant` role |
| `system` | string | 可选，系统提示 |
| `max_tokens` | number | 可选，透传 |
| `temperature` | number | 可选，透传 |
| `top_p` | number | 可选，透传 |
| `stream` | boolean | 可选，支持流式 |
| `stop_sequences` | array | 可选，透传 |
| `tools` | array | 可选，透传 |
| `tool_choice` | object/string | 可选，透传 |

**assistant 消息 content block（多轮 thinking）**
| block type | 字段 | 说明 |
|------------|------|------|
| `text` | `text` | 文本内容 |
| `thinking` | `thinking`, `signature` | thinking 内容，signature 原样透传 |
| `tool_use` | `id`, `name`, `input` | 工具调用 |
| `tool_result` | `tool_use_id`, `content` | 工具结果（透传，未做转换） |

**未实现 / 未验证字段**
- `metadata`
- `top_k`
- `stream` 的 `betas` 扩展头
- `tool_result` 的跨协议转换
- 多 `system` block（数组形式）
- `cache_control`（prompt caching）

---

### 1.2 OpenAI Chat Completions API

**端点**
```
POST /v1/chat/completions
```

**请求头**
| 字段 | 说明 |
|------|------|
| `Authorization` | `Bearer <任意>` |
| `Content-Type` | `application/json` |

**请求体（已实现字段）**
| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | string | 必填，路由用 |
| `messages` | array | 必填，支持 `system` / `user` / `assistant` |
| `max_tokens` | number | 可选，透传 |
| `temperature` | number | 可选，透传 |
| `top_p` | number | 可选，透传 |
| `stream` | boolean | 可选，支持流式 |
| `stop` | string/array | 可选，透传 |
| `tools` | array | 可选，透传 |
| `tool_choice` | object/string | 可选，透传 |

**assistant 消息扩展字段（reasoning）**
| 字段 | 说明 |
|------|------|
| `reasoning_content` | DeepSeek/兼容 API 的 thinking 内容，多轮时需传回 |
| `reasoning_signature` | 对应 Anthropic `thinking.signature`，多轮时需传回 |

**未实现字段**
- `n`（多候选）
- `presence_penalty` / `frequency_penalty`
- `logit_bias`
- `user`
- `response_format`
- `seed`
- `stream_options`
- `parallel_tool_calls`

---

### 1.3 Models API

**端点**
```
GET /v1/models
```

返回所有 provider 下配置的模型列表，格式兼容 OpenAI。

---

## 二、适配器 API（工具专用入口）

适配器允许为特定工具（如 Claude Code、Cursor）提供独立的 base URL，并将请求路由到指定 provider/model。

### 2.1 适配器请求

**端点**
```
POST /{adapterName}/v1/messages          # Anthropic 格式入站
POST /{adapterName}/v1/chat/completions  # OpenAI 格式入站
```

- `adapterName` 只支持 `[a-zA-Z0-9_-]`，不支持中文
- 入站格式由适配器 `type`（`anthropic` / `openai`）决定
- 出站格式由目标 provider `type` 决定
- 跨协议时自动转换（OpenAI ↔ Anthropic）

**跨协议转换矩阵**

| 入站 | 出站 | 转换内容 |
|------|------|---------|
| OpenAI | Anthropic | messages system 提取、tools 格式、tool_choice、stop→stop_sequences、reasoning_content→thinking block |
| Anthropic | OpenAI | system→messages[0]、tools 格式、tool_choice、stop_sequences→stop、thinking block→reasoning_content |
| 同协议 | 同协议 | 仅替换 model 字段，其余透传 |

### 2.2 适配器 Models

**端点**
```
GET /{adapterName}/v1/models
```

返回该适配器配置的 source model ID 列表。

---

## 三、流式响应（SSE）

### 3.1 Anthropic SSE 格式（直通 / OpenAI→Anthropic 转换输出）

标准 Anthropic SSE 事件序列：
```
event: message_start
event: content_block_start   (type: text / thinking / tool_use)
event: content_block_delta   (type: text_delta / thinking_delta / signature_delta / input_json_delta)
event: content_block_stop
event: message_delta         (含 stop_reason)
event: message_stop
```

**已实现 delta 类型**
| delta type | 说明 |
|------------|------|
| `text_delta` | 文本增量 |
| `thinking_delta` | thinking 内容增量 |
| `signature_delta` | thinking signature 增量 |
| `input_json_delta` | tool_use 参数增量 |

### 3.2 OpenAI SSE 格式（直通 / Anthropic→OpenAI 转换输出）

标准 OpenAI SSE 格式，每行 `data: {...}`，结束 `data: [DONE]`。

**delta 扩展字段**
| 字段 | 说明 |
|------|------|
| `content` | 文本增量 |
| `reasoning_content` | thinking 内容增量（来自 Anthropic thinking_delta） |
| `reasoning_signature` | thinking signature（在 [DONE] 前单独发出） |
| `tool_calls` | 工具调用增量 |

### 3.3 OpenAI Responses SSE ↔ Anthropic SSE 转换

**Responses → Anthropic**:
| Responses event | Anthropic event | 说明 |
|-----------------|-----------------|------|
| `response.output_item.added` (message) | `message_start` + `content_block_start` (text, index=1) | 消息开始 |
| `response.reasoning_text.delta` | `content_block_start` (thinking, index=0) + `thinking_delta` | 首次 reasoning 时自动发送 content_block_start |
| `response.reasoning_text.done` | `content_block_stop` (index=0) | 结束 thinking 块 |
| `response.output_text.delta` | `text_delta` (index=1) | 文本增量 |
| `response.output_text.done` | `content_block_stop` (index=1) | 结束文本块（若 thinking 未结束则先发 thinking stop） |
| `response.output_item.added` (function_call) | `content_block_start` + `input_json_delta` | 工具调用块 |
| `response.function_call_arguments.delta` | `input_json_delta` | 工具参数增量 |
| `response.completed` | `content_block_stop` → `message_delta` → `message_stop` | 先停止所有块再结束消息 |

**Anthropic → Responses**:
| Anthropic event | Responses event | 说明 |
|-----------------|-----------------|------|
| `message_start` | `response.created` + `response.in_progress` + `response.output_item.added` | 响应初始化 |
| `thinking_delta` | `response.reasoning_text.delta` | thinking 增量 |
| `text_delta` | `response.output_text.delta` | 文本增量 |
| `message_delta` (usage) | 内嵌到 `response.completed` | usage 附加到完成事件 |
| `message_stop` | `response.completed` | 流结束 |

### 3.4 Anthropic 流式 content_block 索引规范

为保证协议合规，转换器严格区分不同 content_block 的索引：

| block 类型 | 索引 | 说明 |
|------------|------|------|
| `thinking` | 0 | 推理内容块（始终最先发出） |
| `text` | 1 | 文本内容块 |
| `tool_use` | 2, 3, ... | 多个工具调用块依次递增 |

每个 content_block 的生命周期：`content_block_start` → (多个 `content_block_delta`) → `content_block_stop`。
所有块必须在 `message_delta` 之前完成 stop。

---

## 四、协议转换细节

### 4.1 Tools 格式转换

**OpenAI → Anthropic**
```json
// OpenAI
{ "type": "function", "function": { "name": "...", "description": "...", "parameters": {...} } }
// → Anthropic
{ "name": "...", "description": "...", "input_schema": {...} }
```

**Anthropic → OpenAI**
```json
// Anthropic
{ "name": "...", "description": "...", "input_schema": {...} }
// → OpenAI
{ "type": "function", "function": { "name": "...", "description": "...", "parameters": {...} } }
```

### 4.2 tool_choice 转换

| OpenAI | Anthropic |
|--------|-----------|
| `"required"` | `"any"` |
| `{ type: "function", function: { name } }` | `{ type: "tool", name }` |
| `"auto"` | `"auto"` |

### 4.3 stop_reason / finish_reason 映射

| Anthropic stop_reason | OpenAI finish_reason |
|-----------------------|----------------------|
| `end_turn` | `stop` |
| `max_tokens` | `length` |
| `tool_use` | `tool_calls` |

### 4.4 多轮 thinking 传递

多轮对话时，上一轮 assistant 消息中的 thinking 内容必须原样传回：

- **OpenAI 客户端**：在 assistant 消息中保留 `reasoning_content` + `reasoning_signature`
- **Anthropic 客户端**：在 assistant 消息 content 中保留 `thinking` block（含 `signature`）
- 跨协议时代理自动完成 `reasoning_content` ↔ `thinking block` 的互转

---

## 五、Admin API

| 端点 | 方法 | 功能 |
|------|------|------|
| `/admin/` | GET | Admin UI 页面 |
| `/admin/config` | GET | 获取当前配置 |
| `/admin/config/reload` | POST | 热重载配置 |
| `/admin/health` | GET | 健康检查 |
| `/admin/status/providers` | GET | Provider 状态统计 |
| `/admin/logs` | GET | 查询日志（支持分页/级别过滤/搜索） |
| `/admin/log-level` | GET/PUT | 获取/设置日志级别（持久化到 config.yaml） |
| `/admin/token-stats` | GET | Token 使用统计（今日/历史/按 Provider 聚合） |
| `/admin/proxy-key` | GET/PUT | 获取/设置代理 API 密钥 |
| `/admin/adapters` | GET/POST/PUT/DELETE | 适配器 CRUD |
| `/admin/providers` | POST/PUT/DELETE | Provider CRUD |
| `/admin/test-model` | POST | 模型连通性测试 |
| `/admin/providers/{name}/pull-models` | POST | 拉取远端模型列表 |

### 5.1 Token 统计响应格式

```json
{
  "success": true,
  "data": {
    "today": {
      "input_tokens": 15000,
      "output_tokens": 8000,
      "cache_read_input_tokens": 3000,
      "cache_creation_input_tokens": 500,
      "request_count": 42
    },
    "history": { ... },
    "byProvider": { "openai": { ... }, "anthropic": { ... } }
  }
}
```

### 5.2 代理 API Key 认证

- `proxy_key` 配置在 `config.yaml` 中
- 若设置，所有 `/v1/*` 请求须携带 `Authorization: Bearer <key>` 或 `x-api-key: <key>`
- `/admin/*` 路由不校验

## 六、已知限制 / 待核对项

| 项目 | 状态 | 说明 |
|------|------|------|
| `tool_result` 跨协议转换 | ⚠️ 未实现 | tool_result 消息在跨协议时未做格式转换 |
| Anthropic `thinking` signature 有效性 | ✅ 已处理 | 跨协议时基于 thinking 内容自动生成 SHA-256 确定性伪签名，上游原始签名存在时透传 |
| OpenAI `n > 1` 多候选 | ❌ 不支持 | 仅取 choices[0] |
| Anthropic `cache_control` | ❌ 不支持 | prompt caching 相关字段未透传 |
| `stream_options.include_usage` | ❌ 不支持 | 流式 usage 统计未实现 |
| system 数组格式 | ⚠️ 未验证 | Anthropic 支持 system 为 content block 数组 |
| **thinking 流式 content_block 索引** | ✅ 已修复 | thinking 固定 index=0, text 固定 index=1，互不冲突 |
| **OpenAI Responses API** | ✅ 支持 | `/v1/responses` 端点和跨协议转换 |
