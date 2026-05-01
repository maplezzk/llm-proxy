---
title: Admin UI UX 改进 — 按钮语义化 / /models 端点 / 远程拉取 / 下拉表单
type: feat
status: active
date: 2026-04-25
origin: docs/brainstorms/2026-04-25-admin-ui-ux-requirements.md
---

# Admin UI UX 改进

## Overview

基于用户提出的 Admin UI 三个改进方向（按钮颜色、/models 端点、表单下拉选项），进行 5 个方向的具体实现：
1. 语义化按钮颜色（CSS）
2. API Base 预设选择器（前端）
3. 模型名预设下拉框（前端）
4. GET /v1/models 端点（后端）
5. 远程模型拉取 API + UI（后端 + 前端）

## Requirements Trace

- R1. 操作按钮按语义区分颜色：删除=红、编辑=橙、测试=绿、添加=蓝
- R2. API Base URL 从自由输入改为预设选择器，联动 provider type
- R3. Provider 模型「上游模型名」改为基于 type 的预设下拉框 + 自定义选项
- R4. 代理暴露 OpenAI 兼容的 `GET /v1/models` 端点，供 Cursor/Cline 等工具发现模型
- R5. 支持 `POST /admin/providers/:name/pull-models` 从上游拉取可用模型列表
- R6. UI 侧支持远程模型拉取的交互（按钮 + 选择弹窗 + 导入）

## Scope Boundaries

- 不涉及配置存储格式变更（config.yaml 不变）
- 不涉及 provider type 扩展（openai-compatible 类型不在此范围）
- 不涉及批量测试、YAML 编辑器、配置快照、键盘导航等非当前诉求的功能
- 不修改现有 API 的请求/响应格式（仅新增端点）
- `GET /v1/models` 不涉及去重、过滤参数或分页

## Key Technical Decisions

- **按钮 style：light variant 常态 + hover 变实色**：`background` 淡色底 + `color` 深色字，hover 时互换。比纯实色更现代，比纯 ghost 更易识别操作类型
- **API Base 预设采用`<select>` + 隐藏`<input>`模式**：选择预设时隐藏 input 并填充值；选择"自定义..."时显示 input 供自由输入。避免`<datalist>`的跨浏览器不一致问题
- **模型名下拉采用`<select>` + "自定义..."选项**：和 API Base 同样的模式，选择预设后自动填充值，选择"自定义..."后显示隐藏的 input
- **/v1/models 响应选择方案 A（不去重）**：同名模型各一条，`owned_by` 标注 provider 名，让客户端自行处理
- **远程拉取要求 UI 发送 type/apiKey/apiBase 到后端**：后端不查询已持久化的 provider 配置，而是完全依赖请求体参数。这允许在"添加"流程中即可拉取，无需先保存

## Implementation Units

- [ ] **Unit 1: 语义化按钮颜色**

**Goal:** 新增 btn-danger/success/warning CSS 类，替换表格操作按钮和确认对话框的样式

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/api/admin-ui.html`

**Approach:**
- 在 `<style>` 中 `.btn-ghost` 之后追加 `.btn-danger`、`.btn-success`、`.btn-warning` 三个类
- 风格统一：light variant 常态（`background: var(--X-bg)` + `color: var(--X)`），hover 变实色（`background: var(--X)` + `color: #fff`）
- Provider 行操作：编辑→btn-warning, 删除→btn-danger, 测试→btn-success
- Adapter 行操作：编辑→btn-warning, 删除→btn-danger
- 确认对话框「确定」→btn-danger 实色（移除现有内联样式 `.btn-ghost-danger`）
- 动态行 ✕ 按钮：使用 `btn-danger btn-sm` 替换现有内联 style

**Patterns to follow:**
- 现有 `.btn-primary` 和 `.btn-ghost` 的过渡动画 `transition: background 0.12s`

**Test scenarios:**
- Happy path: 渲染后 provider 行测试按钮为绿色、删除按钮为红色、编辑按钮为橙色
- Happy path: 确认对话框删除按钮为红色实色
- Happy path: hover 状态颜色反转
- Edge case: btn-sm 变体在所有按钮类上保持尺寸一致

**Verification:**
- 页面渲染后，provider 表格的编辑/删除/测试按钮视觉可区分且颜色符合语义

---

- [ ] **Unit 2: API Base 预设选择器**

**Goal:** 将 Provider 表单的 API Base URL 从单一 `<input>` 改为联动 type 的预设选择器

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `src/api/admin-ui.html`

**Approach:**
- 新增 `API_BASE_PRESETS` JS 常量：`{ openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com' }`
- 将 API Base 的 `<input>` 替换为：一个 `<select id="pApiBase">`（含预设选项 + "自定义..."） + 一个隐藏的 `<input id="pApiBaseCustom">`
- 选择预设时隐藏 custom input，填充 select 的 value 到数据收集逻辑
- 选择"自定义..."时显示 custom input，清空 select 的 value
- `pType` onchange 时联动切换 API Base 预设值（仅在用户未手动选择过自定义值时触发）
- 编辑 provider 时：如果 api_base 匹配某个预设，选中对应选项；否则选中"自定义..."并填充 input
- `saveProvider()` 的 `const api_base = ...` 逻辑改为读取 select 值或 custom input 值

**Patterns to follow:**
- 现有 `.modal select` 样式（admin-ui.html L204）
- `addMappingRow()` 中 provider 和 model 的下拉联动模式

**Test scenarios:**
- Happy path: 选择 openai type → API Base 自动填充 `https://api.openai.com`
- Happy path: 切换 type → API Base 随 type 联动切换
- Happy path: 选择"自定义..." → 显示 text input，可自由输入 URL
- Happy path: 保存时正确提交选中的 base URL
- Edge case: 编辑已有 provider，api_base 为自定义值 → 显示"自定义..."并填入 input
- Edge case: 用户手动选择了"自定义..."后切换 type → 不覆盖已输入的自定义值

**Verification:**
- 添加/编辑 provider 时 API Base 字段可按 type 自动填充，自定义输入正常工作

---

- [ ] **Unit 3: 模型名预设下拉框**

**Goal:** Provider 表单的「上游模型名」从自由 `<input>` 改为按 type 切换的预设 `<select>` + 自定义输入

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/api/admin-ui.html`

**Approach:**
- 新增 `MODEL_PRESETS` JS 常量：`{ openai: [...], anthropic: [...] }`，包含最常用的模型 ID
- `addModelRow(name, model, providerType)` 新增第三个参数 `providerType`
  - 第二个字段从 `<input>` 改为 `<select>` + 隐藏 `<input>`
  - 根据 `providerType` 渲染对应的预设 `<option>` 列表 + "自定义..."选项
  - 选择预设时自动填入 model 值，隐藏 custom input
  - 选择"自定义..."时显示 custom input
- `openProviderForm()` 中 `addModelRow` 调用处传入当前 `pType.value`
- 别名（第一个字段）保持自由输入不变
- pType onchange 时：已有模型行的下拉不会自动切换（保持当前选中值），但新添加的行使用新 type

**Patterns to follow:**
- 现有 `addMappingRow()` 中 `<select>` 的渲染模式（admin-ui.html L578-591）

**Test scenarios:**
- Happy path: provider type 为 openai 时，模型名下拉显示 GPT 模型列表
- Happy path: provider type 为 anthropic 时，模型名下拉显示 Claude 模型列表
- Happy path: 选中预设模型 → 自动填充值
- Happy path: 选择"自定义..." → 显示 input，可自由输入模型名
- Happy path: 保存时 collectModelRows 正确读取下拉值
- Edge case: 编辑已有 provider，模型的下拉正确选中已有值（或显示自定义）
- Edge case: 切换 type 不影响已有行的已选值

**Verification:**
- 添加 provider 时模型名可选预设值，自定义输入可正常工作，保存后的值正确

---

- [ ] **Unit 4: GET /v1/models 端点**

**Goal:** 新增 OpenAI 兼容的 GET /v1/models 端点，返回代理所有可路由模型

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `src/api/handlers.ts`（新增 `handleListModels` 函数）
- Modify: `src/api/server.ts`（新增路由条目）
- Test: `test/api/integration.test.ts`

**Approach:**
- `handleListModels`：遍历 `ctx.store.getConfig().config.providers`，对每个 provider 的每个 model，生成一条 `{ id: model.name, object: "model", created: Math.floor(Date.now() / 1000), owned_by: provider.name }`
- 不去重，同名但不同 provider 的 model 各显示一条
- `created` 使用当前时间戳的固定值（所有模型同一时间，避免客户端因时间差产生奇怪行为）
- `object` 始终为 `"model"`
- 路由：`{ method: 'GET', pattern: /^\/v1\/models(\?.*)?$/, handler: handleListModels }`，放在 ROUTES 数组靠前位置（避免被 adapter 路由 `^/([a-zA-Z0-9_-]+)/v1/...` 拦截）
  - 注意：现有 adapter 路由 `^/([a-zA-Z0-9_-]+)/v1/(messages|chat/completions)` 不会匹配 `models`，所以顺序不是问题，但为可读性仍应放在 proxy 路由前

**Patterns to follow:**
- `handleGetConfig`（handlers.ts L29-48）遍历 provider + models 的模式
- 现有 `json()` 工具函数的用法

**Test scenarios:**
- Happy path: 配置有 2 个 provider 各 2 个 model → 返回 4 条记录
- Happy path: 返回格式为 `{ object: "list", data: [...] }`
- Edge case: 无任何 provider 配置 → 返回空数组 `data: []`
- Error path: 方法不是 GET 时不被路由命中（由路由框架处理）
- Integration: `curl /v1/models` 返回 200 + 正确 JSON 格式

**Verification:**
- `GET /v1/models` 返回格式正确的模型列表，客户端可解析

---

- [ ] **Unit 5: 远程模型拉取 API**

**Goal:** 新增 `POST /admin/providers/:name/pull-models` 端点，从上游拉取可用模型

**Requirements:** R5

**Dependencies:** Unit 4（复用类似的 HTTP 请求模式，但无代码依赖）

**Files:**
- Modify: `src/api/handlers.ts`（新增 `handlePullModels` 函数）
- Modify: `src/api/server.ts`（新增路由条目）
- Test: `test/api/integration.test.ts`

**Approach:**
- URL 匹配：复用现有 `PROVIDER_PATH_RE = /^\/admin\/providers\/([a-zA-Z0-9_-]+)$/`，方法改为 POST + 路径以 `pull-models` 结尾
  - 实际上需要新增正则：`/^\/admin\/providers\/([a-zA-Z0-9_-]+)\/pull-models$/`
- 从请求体读取 `{ api_key, api_base }`，如果缺失则从已存储的 provider 配置读取
- 根据 provider type 构建对应头信息：
  - `openai`: `Authorization: Bearer {apiKey}`
  - `anthropic`: `x-api-key: {apiKey}` + `anthropic-version: 2023-06-01`
- 向上游 `GET {apiBase}/v1/models` 发请求，超时 10 秒
- 解析响应：
  - OpenAI: 从 `data[]` 提取 `{id, owned_by}`，直接映射 `{ name: id, description: owned_by || null }`
  - Anthropic: 从 `data[]` 过滤 `type === "model"`，提取 `{id, display_name}`，映射 `{ name: id, description: display_name || null }`
- 标记哪些模型已存在当前 provider 配置中（比较 `existingModels`）
- 返回格式：`{ success: true, data: { models: [...], existing: ["gpt-4o", ...] } }`

**Patterns to follow:**
- `handleTestModel`（handlers.ts L293-363）的 fetch + 超时 + 错误处理模式
- 现有 CRUD handler 的 `try/catch` + `json()` 错误响应模式

**Test scenarios:**
- Happy path: OpenAI provider pull → 返回上游模型列表
- Happy path: Anthropic provider pull → 返回上游模型列表（过滤 type=model）
- Happy path: 响应中包含 `existing` 数组标注已配置的模型
- Error path: 上游不可达 → 返回 `{ success: false, error: "..." }`
- Error path: provider name 不存在 → 404
- Error path: 超时 → 返回超时错误
- Error path: 上游返回 non-JSON → 返回解析错误
- Edge case: 空模型列表 → 返回空数组
- Integration: mock 上游 /v1/models → 验证响应解析正确

**Verification:**
- 能正确定向拉取 OpenAI 和 Anthropic 的模型列表并返回结构化数据

---

- [ ] **Unit 6: 远程模型拉取 UI**

**Goal:** Provider 表单中添加「拉取远程模型」按钮和选择弹窗

**Requirements:** R6

**Dependencies:** Unit 3, Unit 5

**Files:**
- Modify: `src/api/admin-ui.html`

**Approach:**
- Provider 表单「模型列表」标签旁新增「拉取远程模型」按钮（`.btn-sm btn-success`）
- 点击后：
  1. 调用 `POST /admin/providers/:name/pull-models`，用表单当前的 `pType.value`, `pApiKey.value`, `pApiBase` 值
  2. 如果 name 为空（新建模式），传递当前 input 的值；如果 name 有值，使用 editingProvider
  3. 弹窗显示加载状态（骨架屏或 loading text）
- 成功返回后打开选择弹窗：
  - 弹窗可复用现有 modal 结构
  - 内容为有序列表格：复选框 + 模型 ID + 描述/来源
  - 已存在的模型默认勾选并置灰
  - 底部按钮：「导入选中」(btn-primary) + 「取消」(btn-ghost)
- 点击「导入选中」：
  1. 清除当前所有模型行（`#pModels.innerHTML = ''`）
  2. 对每个勾选的模型调用 `addModelRow(name, model, type)`（name = model = 模型 ID）
  3. 关闭弹窗
  4. toast 提示成功导入了 N 个模型
- 错误处理：拉取失败时 toast 显示错误消息，不打开弹窗

**Patterns to follow:**
- 现有 Modal 的 open/close 模式（admin-ui.html L199, L616-617）
- `addModelRow()` 的调用模式

**Test scenarios:**
- Happy path: 拉取成功 → 弹窗显示模型列表，勾选后导入到表单
- Happy path: 导入后表单模型行正确填充
- Error path: 拉取失败（上游不可达/key 无效）→ toast 报错，不打开弹窗
- Edge case: 拉取 100+ 模型 → 弹窗可滚动，全部可勾选
- Edge case: 已存在的模型在列表中标记且默认勾选
- Edge case: 编辑模式下拉取 → 使用已保存的 provider name 作为路径参数

**Verification:**
- 能通过 UI 拉取上游模型并成功导入到 provider 表单中

## System-Wide Impact

- **API surface parity（新增端点）：** `/v1/models` 是新的外部 API 端点，如果其他组件（如 adapter router）有 catch-all 路由需确认不会拦截。当前 adapter 路由 `^/([a-zA-Z0-9_-]+)/v1/(messages|chat/completions)` 不匹配 `models`，安全。
- **Config write path（无影响）：** 远程拉取只读取上游数据，不直接写配置。模型需通过现有的 saveProvider 流程写入。
- **Error propagation：** pull-models 失败只影响 UI 交互，不影响代理的请求转发功能。
- **Unchanged invariants：** 所有现有 API 端点（/admin/config, /admin/health, CRUD, /v1/messages, /v1/chat/completions 等）行为不变。

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 上游 /v1/models 响应格式与预期不符（如非标准 OpenAI API 的服务） | handlePullModels 中加 try/catch，解析失败时返回友好错误 |
| 模型下拉预设列表过时（新增/废弃模型名称） | 预设列表是静态的建议值，"自定义..."选项保证无遗漏 |
| /v1/models 被已有 adapter 路由误拦截 | server.ts 中路由顺序确保 /v1/models 在 adapter 路由之前匹配 |
| 远程拉取的 API key 从表单 POST 到后端通过 HTTP 传输 | 已经是本地代理（localhost），且现有 test-model 同样处理 |

## Open Questions

### Resolved During Planning

- 没有未解决的阻塞性问题。

### Deferred to Implementation

- 远程拉取时新建 provider（name 未保存）的路径参数处理：如果 name 为空，可以用 `_new` 作为路径参数，后端只验证 provider 不存在则跳过名称查找
- 模型预设列表的具体版本号：实现时按当前已知最常用的模型 ID 列出
