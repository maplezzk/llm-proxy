---
title: feat: Support OpenAI Responses API built-in tools (computer_use, web_search, code_interpreter, file_search, reasoning)
type: feat
status: active
date: 2026-05-24
---

# feat: Support OpenAI Responses API built-in tools (computer_use, web_search, code_interpreter, file_search, reasoning)

## Overview

支持 OpenAI Responses API 的所有内置工具（built-in tools）在跨协议转换（Responses ↔ Anthropic ↔ OpenAI Chat）中的完整处理。当前代码会将所有非 `type: "function"` 的工具过滤掉，导致 `computer_use`、`web_search_preview`、`code_interpreter`、`file_search` 等工具在转换中丢失。本计划实现双向转换、流式/非流式双路径覆盖，以及计算机操作（computer use）的完整 action ↔ tool_use 映射。

---

## Problem Frame

用户通过 llm-proxy 代理使用 OpenAI Responses API 时，可以指定内置工具（如 `computer_use_preview`、`web_search_preview`、`code_interpreter`、`file_search`）。当代理将请求路由到不同协议的上游（如 Anthropic）时：

1. **工具定义被过滤**：`convertToolsToAnthropic()` 只接受 `type: "function"`，其他类型被静默丢弃
2. **输出 item 类型未处理**：`computer_call`、`web_search_call`、`code_interpreter_call`、`file_search_call` 等响应 item 不在 `convertOpenAIResponsesToAnthropic()` 的处理列表中
3. **流式事件缺失**：SSE 转换器只处理 `message` / `function_call` 类的 event，新的 item 类型被忽略
4. **反向路径同理**：Anthropic 到 Responses 的转换缺少对 `computer_20251124` 等内置工具的支持

这使得使用 Codex computer_use 的客户端无法通过代理正常使用 Anthropic 上游模型。

---

## Requirements Trace

- R1. 跨协议时内置工具定义（`computer_use_preview` / `web_search_preview` / `code_interpreter` / `file_search`）不被静默过滤
- R2. Responses → Anthropic 转换时，`computer_call` 输出 item 转为 `tool_use`（name: "computer"），`computer_call_output` 输入转为 `tool_result`
- R3. Anthropic → Responses 转换时，`tool_use` (name: "computer") 转为 `computer_call` 输出 item，`tool_result`（含截图）转为 `computer_call_output`
- R4. 没有直接对应关系的工具（如 `web_search_preview` → Anthropic、`bash` → Responses）做最佳努力处理：可转换则转换，不可转换则记录日志后静默忽略
- R5. 流式和非流式路径都正确转换
- R6. 同协议（passthrough）时内置工具原样透传
- R7. Responses ↔ OpenAI Chat 转换时，内置工具做损失性转换（Chat API 不支持的项在输出时丢弃或转为 text 占位）
- R8. 没有对应协议的 tool_choice 做忽略处理（保留原值如果上游理解，否则用 `auto` 兜底）

---

## Scope Boundaries

- Computer use 的 action 格式转换（OpenAI ComputerAction ↔ Anthropic tool_use input）做核心映射，**不完全**覆盖所有边缘 action 属性
- Safety checks 不做跨协议映射（Anthropic 和 OpenAI 的 safety 机制不兼容），在 Anthropic 侧忽略 `pending_safety_checks`，在 Responses 侧用空数组
- `computer_use` 的 `display_width_px` / `display_height_px` / `display_number`（Anthropic 工具定义的属性）在跨协议时不传递，因为 OpenAI Responses 没有对应设施
- `code_interpreter` 的容器/文件管理、`file_search` 的 vector store 不做跨协议转换
- Anthropic `text_editor_20250728` 和 `bash_20250124` 工具在跨协议时丢弃（OpenAI 无对应），同协议时透传

---

## Context & Research

### Relevant Code and Patterns

- **核心转换文件**: `src/proxy/translation.ts`（1264 行）— 请求体转换 + 非流式响应转换
- **流式转换文件**: `src/proxy/stream-converter.ts`（1248 行）— 6 个 SSE 转换器
- **请求编排**: `src/proxy/provider.ts` — `forwardRequest()` 调度流式/非流式转换
- **路由**: `src/proxy/handlers.ts` — 三种入站类型的 handler 入口
- **类型定义**: `src/proxy/types.ts` — `RouterResult` 接口

### Protocol Conversion Matrix

| 入站 ↓ / 上游 → | anthropic | openai | openai-responses |
|----------------|-----------|--------|------------------|
| anthropic | passthrough (U6) | `translation`: 响应 `convertAnthropicResponseToOpenAI`, 流 `convertOpenAIStreamToAnthropic` | `translation`: 响应 `convertAnthropicResponseToOpenAIResponses`, 流 `convertAnthropicStreamToOpenAIResponses` |
| openai | `translation`: 响应 `convertOpenAIResponseToAnthropic`, 流 `convertAnthropicStreamToOpenAI` | passthrough (U6) | `translation`: 响应 `convertOpenAIResponseToOpenAIResponses`, 流 `convertOpenAIStreamToOpenAIResponses` |
| openai-responses | `translation`: 响应 `convertOpenAIResponsesToAnthropic`, 流 `convertOpenAIResponsesStreamToAnthropic` | `translation`: 响应 `convertOpenAIResponsesResponseToOpenAI`, 流 `convertOpenAIResponsesStreamToOpenAI` | passthrough (U6) |

### Institutional Learnings

- 流式转换器中每个 converter 维护独立的 `rawLines`/`outLines` + `ts()` 时间戳格式
- 响应转换中使用 `makeSignature()` 函数产生确定性 thinking 伪签名
- Content block 索引约定：thinking = 0, text = 1, tool_use = 2+
- `convertToolsToAnthropic()` 和 `convertToolsToOpenAI()` 有对称结构，修改时需同时更新

---

## Key Technical Decisions

1. **内置工具定义保留策略**: 跨协议时为目标协议有对应物的工具做映射，无对应物时 drop（记录 debug 日志），不做"转为 function tool"的模拟转换。原因是模拟会产生无法由上游正确执行的虚假工具定义。
2. **Computer Use action 映射格式**: OpenAI 使用扁平 action 对象 `{ type: "click", x, y }`，Anthropic 使用 `{ action: "click", coordinate: [x, y] }`。做单向映射而非通用抽象。
3. **流式 computer_call 处理**: OpenAI Responses 的 `computer_call` 以完整 item 形式一次性出现在 `response.output_item.added` 事件中（无 delta 事件），因此 Anthropic 的 `content_block_start`（tool_use with input）可一次性映射。
4. **Chat API 转换策略**: OpenAI Chat API 不支持这些内置工具，Responses→Chat 时丢弃内置工具输出 item（改为 text 说明或静默忽略），Chat→Responses 时无从产生这些 item（因为 Chat 不会返回它们）。
5. **Safety checks 不传递**: 两个平台的 safety 机制差异过大且不能互操作，直接忽略是最安全的选择。

---

## Open Questions

### Resolved During Planning

- Computer use 是否做 full action mapping 还是只做基础支持？→ 做核心 action 类型映射（click, double_click, drag, keypress, move, screenshot, scroll, type, wait）
- 没有对应物的工具怎么处理？→ 跨协议时 drop，记录 debug 日志

### Deferred to Implementation

- Anthropic `bash` 和 `text_editor` 的输出是否可以转为 Responses 有意义的 text/function_call？→ 暂不处理，直接 drop
- `computer_call` 响应中的 `pending_safety_checks` 如何在代理中传递？→ 暂不传递（safety 不可互操作）

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Conversion Flow (Responses → Anthropic Computer Use)

```
Client (Responses)                    llm-proxy                         Anthropic
  │                                      │                                  │
  │ POST /v1/responses                   │                                  │
  │ tools: [{ type: "computer_use_preview" }]                              │
  │─────────────────────────────────►    │                                  │
  │                                      │ convertToolsToAnthropic():       │
  │                                      │   computer_use_preview →         │
  │                                      │   computer_20251124              │
  │                                      │ convertResponsesInputToMessages():│
  │                                      │   computer_call_output input →   │
  │                                      │   tool_result with image         │
  │                                      │──────────────────────────────►  │
  │                                      │                                  │
  │                                      │  ← Anthropic tool_use (computer) │
  │                                      │                                  │
  │                                      │ convertOpenAIResponsesToAnthropic():│
  │                                      │   tool_use → computer_call       │
  │  ← computer_call output                                              │
  │─────────────────────────────────     │                                  │
```

### Action Mapping

```
OpenAI ComputerAction          →  Anthropic tool_use input
─────────────────────             ─────────────────────────
{ type: "click", x, y }          { action: "click", coordinate: [x, y] }
{ type: "double_click", x, y }   { action: "double_click", coordinate: [x, y] }
{ type: "drag", x, y }           { action: "drag", coordinate: [x, y] }
{ type: "keypress", keys }       { action: "key", text: keys.join("+") }
{ type: "move", x, y }           { action: "mouse_move", coordinate: [x, y] }
{ type: "screenshot" }           { action: "screenshot" }
{ type: "scroll", x, y, scroll_x, scroll_y }  { action: "scroll", coordinate: [x, y], scroll_x, scroll_y }
{ type: "type", text }           { action: "type", text }
{ type: "wait", ms }             { action: "wait", duration: ms }

Anthropic tool_use input        →  OpenAI ComputerAction
─────────────────────              ─────────────────────────
{ action: "click", coordinate }   { type: "click", x: coord[0], y: coord[1] }
{ action: "double_click", ... }   { type: "double_click", ... }
{ action: "drag", ... }           { type: "drag", ... }
{ action: "key", text }           { type: "keypress", keys: [text.split("")] }
{ action: "mouse_move", coord }   { type: "move", x: coord[0], y: coord[1] }
{ action: "screenshot" }          { type: "screenshot" }
{ action: "scroll", ... }         { type: "scroll", ... }
{ action: "type", text }          { type: "type", text }
{ action: "wait", duration }      { type: "wait", ms: duration }
```

### Tool Screenshot ↔ tool_result Image

```
OpenAI computer_call_output     →  Anthropic tool_result
  output: {                        content: [{
    type: "computer_screenshot",     type: "image",
    image_url: "https://..."         source: { type: "url", url: "..." }
  }                                }]

Anthropic tool_result           →  OpenAI computer_call_output
  content: [{                      output: {
    type: "image",                    type: "computer_screenshot",
    source: { type: "url", url }      image_url: url|file_id
  }]                                }
```

---

## Implementation Units

- [ ] U1. **Tool Definition & Choice Pass-Through**

**Goal:** 修改 `convertToolsToAnthropic()` 和 `convertToolsToOpenAI()`，停止过滤非 function 工具，添加内置工具的类型映射。

**Requirements:** R1, R6, R8

**Dependencies:** None

**Files:**
- Modify: `src/proxy/translation.ts`
- Test: `test/proxy/translation.test.ts`

**Approach:**
- 在 `convertToolsToAnthropic()` 中：移除 `filter()` 的 `type !== 'function'` 条件，添加 `type: "computer_use_preview"` 或 `type: "computer_use_preview-*"` → `{ type: "computer_20251124", name: "computer", display_width_px, display_height_px }` 的映射。其他非 function 工具（web_search_preview, code_interpreter, file_search）在 Anthropic 没有对应物，保留原样透传（Anthropic 会忽略不识别的 tool 类型，比静默过滤安全）。
- 在 `convertToolsToOpenAI()` 中：对称逻辑。Anthropic 的 `computer_20251124` / `computer_20250124` → `{ type: "computer_use_preview", ... }`。`text_editor_20250728` 和 `bash_20250124` 保留透传。
- 内置工具的 `tool_choice`：OpenAI 对内置工具使用 `"auto"` / `"required"` / `"none"`，Anthropic 同理。`convertToolChoiceToAnthropic()` 和 `convertToolChoiceToOpenAI()` 已能处理字符串形式，不需要改动。

**Patterns to follow:**
- 现有的 `convertToolsToAnthropic()` 中 `type === 'function' && item.function` 的三路分支判断模式

**Test scenarios:**
- Happy path: Responses `tools: [{ type: "computer_use_preview" }, { type: "web_search_preview" }]` → Anthropic 格式保留这两个工具（而非过滤）
- Happy path: Anthropic `tools: [{ type: "computer_20251124", name: "computer" }, { type: "bash_20250124", name: "bash" }]` → OpenAI 格式保留
- Edge case: 混合 function tool + 内置工具，function tool 正常转换，内置工具保留
- Edge case: `tool_choice: "auto"` 跨协议时不受影响
- Edge case: 空的 tools 数组 → 跳过

**Verification:**
- 同协议请求的 tools 数组原样透传
- 跨协议时内置工具不被过滤
- 所有现有 test case 仍然通过

---

- [ ] U2. **Input/Request Item Conversion — New Types**

**Goal:** 在请求入站转换中处理 `computer_call_output` 和 `computer_call` 等新 input item 类型。

**Requirements:** R2, R3

**Dependencies:** U1

**Files:**
- Modify: `src/proxy/translation.ts`
- Test: `test/proxy/translation.test.ts`

**Approach:**
- `convertResponsesInputToMessages()` 新增：
  - `type: "computer_call_output"` → 转换为 Anthropic `user` message 中的 `tool_result` block
    - `output.image_url` → `{ type: "image", source: { type: "url", url } }`
    - `output.file_id` → 暂时转为 text 占位（需要先上传文件）
    - `acknowledged_safety_checks` → 忽略
  - 非 `function_call_output` 的 tool 结果（如 web_search_call 输出）→ 跳过（没有 Anthropic 对应物）

- `convertMessagesToResponsesInput()` 新增：
  - 检查 Anthropic `tool_result` 中是否包含 image block
  - 如果 image block 的内容是截图 → 转为 `computer_call_output`（但无法自动判断是不是 computer use 结果）
  - 更安全的做法：只在消息上下文中有 computer 工具调用时，将后续的 tool_result+image 转为 `computer_call_output`
  - 简单实现：始终将 tool_result 中的 image 转为 `computer_call_output`（功能完整但宽松）
  - 后续再收紧：检测之前的内容中是否有 name="computer" 的 tool_use

**Patterns to follow:**
- 已有的 `function_call` → `tool_calls`、`function_call_output` → `tool` role 消息的转换模式

**Test scenarios:**
- Happy path: Responses input 包含 `{ type: "computer_call_output", call_id, output: { type: "computer_screenshot", image_url: "https://..." } }` → Anthropic `{ role: "user", content: [{ type: "tool_result", tool_use_id, content: [{ type: "image", source: { type: "url", url } }] }] }`
- Edge case: `computer_call_output` 中 output 只有 `file_id` 没有 `image_url` → 文本占位
- Edge case: 多个 `computer_call_output` 连续出现 → 合并到同一个 user message（与 tool_result 模式一致）
- Edge case: Anthropic `tool_result` 中的 image → `computer_call_output`（需结合上下文判断是否 computer use）

**Verification:**
- Responses input 中的 `computer_call_output` 正确转为 Anthropic tool_result
- 反向路径（Anthropic → Responses）也正确处理
- 不破坏现有的 function_call 和 message 转换

---

- [ ] U3. **Non-Streaming Response Conversion — New Output Item Types**

**Goal:** 在非流式响应转换函数中处理 `computer_call`、`web_search_call`、`code_interpreter_call`、`file_search_call`、`reasoning`（独立 item）等新输出 item 类型。

**Requirements:** R2, R3, R4, R5, R7

**Dependencies:** U1

**Files:**
- Modify: `src/proxy/translation.ts`
- Test: `test/proxy/translation.test.ts`

**Approach:**
- `convertOpenAIResponsesToAnthropic()` 新增：
  - `output` 数组中新增 item 类型处理：
    - `computer_call` → `{ type: "tool_use", id, name: "computer", input: convertActionToAnthropic(action) }` 添加到 Anthropic content 数组
    - `web_search_call` → 跳过（Anthropic 无对应物）
    - `code_interpreter_call` → 跳过
    - `file_search_call` → 跳过
    - `reasoning` 独立 item → 作为 `thinking` block 添加到 content（如已通过顶层 reasoning 添加了则不重复）
  - 辅助函数 `convertActionToAnthropic()` 实现 action mapping table

- `convertAnthropicResponseToOpenAIResponses()` 新增：
  - content 中 `type: "tool_use"` 且 `name === "computer"` → `{ type: "computer_call", id, call_id, action: convertActionToOpenAI(input), pending_safety_checks: [], status: "completed" }` 作为独立 output item
  - tool_use: `name === "bash"` 或 `name === "str_replace_based_edit_tool"` → 跳过
  - 辅助函数 `convertActionToOpenAI()` 实现反向 action mapping table

- `convertOpenAIResponsesResponseToOpenAI()`（Responses → Chat）：
  - `computer_call` → 跳过（Chat 无此类型）
  - `web_search_call` → 跳过
  - 其他工具同理
  - 更新 `textContent` 和 `reasoningContent` 外的 token 计算

- `convertOpenAIResponseToOpenAIResponses()`（Chat → Responses）：
  - Chat 不会产生新的内置工具 item，无需改动
  - 但需要确保 Chat 的 `reasoning_content` 在 Responses 中可能变为独立 `reasoning` item（目前整合到顶层 summary，可以保持）

**Patterns to follow:**
- 现有的 `convertAnthropicResponseToOpenAIResponses()` 中处理 `tool_use` blocks 的模式（按 type 分类处理）

**Test scenarios:**
- Happy path: OpenAI Responses `{ output: [{ type: "computer_call", id, call_id, action: { type: "click", x: 100, y: 200 }, status: "completed" }] }` → Anthropic `{ content: [{ type: "tool_use", id, name: "computer", input: { action: "click", coordinate: [100, 200] } }] }`
- Happy path: Anthropic `{ content: [{ type: "tool_use", id, name: "computer", input: { action: "screenshot" } }] }` → Responses `{ output: [{ type: "computer_call", action: { type: "screenshot" } }] }`
- Edge case: 混合 message + computer_call + function_call → 所有类型都存在且顺序正确
- Edge case: `web_search_call` 出现在 output 中 → 跳过（不报错）
- Edge case: Anthropic `tool_use` with name "bash" → 跳过
- Error: 未知 action type → 跳过该 item，记录 warn 日志

**Verification:**
- 所有 action type 的双向映射正确
- 没有对应物的工具 item 被静默跳过（debug 级别日志）
- 现有测试不受影响

---

- [ ] U4. **Stream Conversion: Responses ↔ Anthropic (new SSE events)**

**Goal:** 在流式响应转换中，为 Responses ←→ Anthropic 方向处理 `computer_call`、`web_search_call` 等新类型的 SSE 事件。

**Requirements:** R2, R3, R4, R5

**Dependencies:** U3 (action mapping 函数可复用)

**Files:**
- Modify: `src/proxy/stream-converter.ts`
- Test: `test/proxy/stream-converter.test.ts`

**Approach:**

**`convertOpenAIResponsesStreamToAnthropic()` 新增：**
- `response.output_item.added` 事件中处理 `item.type === "computer_call"`：
  - 立即发出 `content_block_start`（tool_use, name="computer"），使用 action 映射后的 `input` 作为初始值
  - 然后立即发出 `content_block_stop`（因为 action 不是增量传输的）
  - 注意：computer_call 的 action 在 `output_item.added` 中已完整存在，无需等待 delta 事件
- `item.type === "web_search_call"` → 跳过（无对应物）
- `item.type === "code_interpreter_call"` → 跳过
- `item.type === "file_search_call"` → 跳过
- `reasoning` 独立 item 的 SSE 事件（`reasoning_text.delta`/`.done`）→ 当前已作为 content block 处理，需额外处理独立 item 形式
  - `response.output_item.added` 中 `item.type === "reasoning"` → 触发 thinking block start
  - `response.reasoning_text.delta`（可能带 `item_id`）→ `thinking_delta`
  - `response.reasoning_text.done`（可能带 `item_id`）→ `content_block_stop` + `signature_delta`

**`convertAnthropicStreamToOpenAIResponses()` 新增：**
- `content_block_delta`（thinking → `response.reasoning_text.delta`）当前已实现
- `content_block_start`（tool_use, name="computer"）→ 当前已作为普通 tool_use 处理（发出 `function_call`），但需要改为发出 `computer_call`：
  - 当 `name === "computer"` → 发出 `response.output_item.added` 事件，`item.type: "computer_call"`，action 映射
  - 需要跟踪当前 block 的 type（tool_use vs computer_use）以决定发出方式
- tool_use `name === "bash"` or `name === "str_replace_based_edit_tool"` → 跳过（无对应物）

**Stream Event Flow (computer_call):**
```
Responses SSE                         Anthropic SSE (converted)
─────────────────                     ────────────────────────
response.output_item.added
  item.type: "computer_call",           → content_block_start (tool_use, computer)
  action: {type:"click", x, y}            input: {action:"click", coordinate}
                                       → content_block_stop
```

```
Anthropic SSE                         Responses SSE (converted)
─────────────                         ──────────────────────
content_block_start                   
  tool_use, name: "computer"           → response.output_item.added
  input: {action, coordinate}            item.type: "computer_call"
                                         action: {type, x, y}
content_block_delta                   (no delta events - action complete)
  input_json_delta                     
content_block_stop                    
```

**Test scenarios:**
- Happy path: Responses SSE `response.output_item.added(item.type="computer_call", action={type:"click"})` → Anthropic SSE `content_block_start(tool_use, computer)` + `content_block_stop`
- Happy path: Anthropic SSE `content_block_start(tool_use, computer)` + `input_json_delta` → Responses SSE `response.output_item.added(computer_call)` + `response.function_call_arguments.done`
- Edge case: `web_search_call` in Responses stream → 不产生 Anthropic 事件
- Edge case: Anthropic `tool_use` with name "bash" → 不产生 Responses 事件
- Edge case: 多个工具类型混合（text + computer + function_call）→ 都正确排序

**Verification:**
- 流式路径的 computer use 与非流式路径的输出一致
- 现有的 thinking/text/function_call 流式事件不受影响

---

- [ ] U5. **Stream Conversion: Responses ↔ OpenAI Chat (new SSE events)**

**Goal:** 在流式响应转换中，为 Responses ←→ OpenAI Chat 方向处理新类型的 SSE 事件。

**Requirements:** R7

**Dependencies:** None (Chat API 不会产生内置工具 item，只需处理单向)

**Files:**
- Modify: `src/proxy/stream-converter.ts`
- Test: `test/proxy/stream-converter.test.ts`

**Approach:**

**`convertOpenAIResponsesStreamToOpenAI()`（Responses SSE → Chat SSE）：**
- 已有 `response.output_item.added(computer_call)` 事件 → 当前代码会尝试将其作为 `tool_calls` 处理（`item?.type === 'function_call'` 之外的类型 fallthrough 到 `function_call` 分支触发 if 失败）
- 新增：`item.type === "computer_call"` → 转为 Chat 的 `tool_calls`，其中 `function.name: "computer"`，`function.arguments: JSON.stringify(action)`（损失性转换，但 Chat client 可以收到提示）
- `item.type === "web_search_call"` → 跳过
- `item.type === "code_interpreter_call"` → 跳过
- `item.type === "file_search_call"` → 跳过
- `item.type === "reasoning"` → 已经通过 `reasoning_text.delta` 处理

**`convertOpenAIStreamToOpenAIResponses()`（Chat SSE → Responses SSE）：**
- Chat API 不会产生 `computer_call` 等内置工具 item，无需改动
- 但 Chat 的 `tool_calls` 中如果有 `function.name === "computer"` 的奇怪情况 → 可以转为 `computer_call`（但这更多是防御性编程）

**Test scenarios:**
- Happy path: Responses SSE `response.output_item.added(computer_call)` → Chat SSE `tool_calls` with function name "computer"
- Edge case: `web_search_call` in Responses stream → Chat 无输出
- Edge case: 混合 `function_call` + `computer_call` → Chat 侧都有 `tool_calls`
- Edge case: `[DONE]` 之前的 `response.completed` 处理新增内容

**Verification:**
- Responses→Chat 方向产生合理的损失性转换
- 现有工具类型不受影响

---

- [ ] U6. **Same-Protocol Passthrough Integrity**

**Goal:** 确保同协议（passthrough）场景下，内置工具的原样透传不受影响，所有修改不破坏已有功能。

**Requirements:** R6

**Dependencies:** U1, U2, U3, U4, U5

**Files:**
- Modify: `src/proxy/translation.ts`（确认同协议分支不受新增逻辑影响）
- Test: `test/proxy/translation.test.ts`（追加同协议携带内置工具的测试）
- Test: `test/proxy/stream-converter.test.ts`（追加直通流式测试）

**Approach:**
- 确认 `transformInboundRequest()` 中 `sameProtocol` 分支直接使用 `{ ...body, model: route.modelId }` 透传，不经过 `convertTools*`，因此不受改动影响
- 确认 `forwardPassthroughStream()` 在 `provider.ts` 中不对 SSE 内容做修改，只提取 token 统计
- 补充测试：
  - Responses → Responses 同协议时，tools 数组包含 `computer_use_preview`
  - Anthropic → Anthropic 同协议时，tools 包含 `computer_20251124`

**Test scenarios:**
- Integration: Responses 请求带 `computer_use_preview` 工具，路由到 Responses 上游 → 工具定义原样透传
- Integration: Anthropic 请求带 `computer_20251124` 工具，路由到 Anthropic 上游 → 工具定义原样透传

**Verification:**
- 所有现有 test case 通过（`node --import tsx --test test/**/*.test.ts`）
- 同协议路径的内置工具不受新增逻辑影响

---

## System-Wide Impact

- **Interaction graph:** 主要影响 `translation.ts`（6 个转换函数）和 `stream-converter.ts`（6 个 converter）。`provider.ts` 中的分发逻辑不变。
- **Error propagation:** 新 item 类型处理中的运行时错误不抛出到上层，转换为 warn 日志 + 跳过该 item。
- **State lifecycle risks:** 无状态变更（代理不维护会话状态）。
- **API surface parity:** Anthropic `bash` 和 `text_editor` 工具的同协议透传不受影响。
- **Integration coverage:** 建议补充 e2e 测试（用 mock 上游）。
- **Unchanged invariants:** `provider.ts` 的所有路由/分发逻辑不变。`router.ts`、`config/`、`api/` 都不需要改动。

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Action mapping 不完整导致客户端异常 | 所有未知 action type → 跳过 + warn 日志，不崩溃 |
| Anthropic 工具定义中的 `display_width_px` 等参数丢失 | 这个是设计决策——OpenAI Responses 无对应设施 |
| Safety checks 忽略导致安全问题 | Safety 机制不可互操作，保留各自平台的 safety 是正确做法 |
| OpenAI API 更改 item 格式 | 解耦在每个转换函数中，修改范围有限 |

---

## Documentation / Operational Notes

- 更新 `docs/api-spec.md` 中关于协议转换的描述
- 更新 `examples/` 中的示例配置

---

## Sources & References

- **OpenAI Responses API spec:** `src/proxy/translation.ts`, `src/proxy/stream-converter.ts`
- **OpenAI OpenAPI:** [openai-openapi.yaml](https://github.com/openai/openai-openapi) — computer_use/web_search/code_interpreter/file_search schemas
- **Anthropic Computer Use docs:** https://docs.anthropic.com/en/docs/build-with-claude/computer-use
