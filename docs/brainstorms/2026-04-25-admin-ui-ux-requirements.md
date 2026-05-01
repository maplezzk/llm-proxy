---
date: 2026-04-25
topic: admin-ui-ux
focus: 按钮颜色语义化 + /models 端点 + 远程模型拉取 + 表单下拉选项
---

# Brainstorm: Admin UI UX 改进需求

## 目标

四个方向同步实现：
1. `GET /v1/models` — 代理暴露模型列表端点
2. `POST /admin/providers/:name/pull-models` — 从上游拉取远程模型
3. 语义化按钮颜色 — 按钮颜色区分操作类型
4. 模型名预设下拉框 + API Base 预设选择器

---

## 方向 1: GET /v1/models 端点

### 用户故事
Cursor、Cline、Continue 等工具连接 llm-proxy 的 base_url 后，会首先调用 `GET /v1/models` 获取可用模型列表以填充模型选择器。没有该端点时，工具报错或无法发现模型。

### 接口定义

```
GET /v1/models
```

**响应格式**（OpenAI 兼容）：

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4o",
      "object": "model",
      "created": 1686935000,
      "owned_by": "system"
    },
    {
      "id": "claude-sonnet-4",
      "object": "model",
      "created": 1686935000,
      "owned_by": "system"
    }
  ]
}
```

### 实现要点
- `id` 取 provider model 的 `name` 字段（即下游调用时用的模型名），而非上游模型名
- `created` 使用固定时间戳或 0，因为代理不维护模型的创建时间
- `owned_by` 固定写 `"system"` 或 provider 名
- 数据源：所有 provider 的 `models[]` 的 `name` 字段
- 去重：不同 provider 可能有相同 `name` 的模型，是否需要去重？考虑方案：
  - **方案 A**：不去重，同名模型各一条，`owned_by` 标注 provider 名
  - **方案 B**：按 `name` 去重，只保留第一条
  - **推荐 A**：去重丢失信息，让客户端自行处理同名

### 相关文件
- 新增 `src/api/handlers.ts` 中的 `handleListModels` 函数
- 新增路由 `{ method: 'GET', pattern: /^\/v1\/models(\?.*)?$/, handler: handleListModels }` 到 `server.ts` 的 ROUTES 数组

---

## 方向 2: POST /admin/providers/:name/pull-models

### 用户故事
添加 Provider 时，用户希望能一键拉取上游 API 的所有可用模型，勾选后自动填入配置，而不是手动逐个输入模型名和上游模型名。

### 接口定义

```
POST /admin/providers/:name/pull-models
```

**请求体**（可选，不传 body 则从已配置的 provider 读取 type/apiKey/apiBase）：

```json
{
  "type": "openai",
  "api_key": "sk-xxx",
  "api_base": "https://api.openai.com"
}
```

**成功响应**：

```json
{
  "success": true,
  "data": {
    "models": [
      { "name": "gpt-4o", "description": "GPT-4o" },
      { "name": "gpt-4o-mini", "description": "GPT-4o mini" }
    ],
    "existing": ["gpt-4o"]  // 已在配置中的模型名，用于 UI 提示
  }
}
```

**错误响应**：

```json
{
  "success": false,
  "error": "上游 API 不可达"
}
```

### 上游模型列表获取逻辑

**OpenAI 兼容**（type === 'openai'）：
- 请求 `GET {apiBase}/v1/models`
- 认证：`Authorization: Bearer {apiKey}`
- 解析响应：从 `data[]` 提取每个 `{id, owned_by}` 映射
- 映射规则：`id` → model.name=model.model=id（别名和上游名相同）
- 注意：OpenAI 的 /v1/models 返回所有模型包括 GPT-3.5 等旧模型，可能量很大

**Anthropic**（type === 'anthropic'）：
- 请求 `GET {apiBase}/v1/models`
- 认证：`x-api-key: {apiKey}` + `anthropic-version: 2023-06-01`
- 解析响应：从 `data[]` 提取 `{id, display_name, type}`，过滤 `type === "model"` 的条目
- 映射规则：`id` → model.name=model.model=id

**超时**：10 秒超时（AbortSignal.timeout(10000)）

### UI 交互流程

1. Provider 表单中新增「拉取远程模型」按钮（位于模型列表上方）
2. 点击后打开一个选择弹窗，显示拉取到的模型列表（带复选框）
3. 用户勾选需要的模型，点击「导入选中」
4. 关闭弹窗，选中的模型自动填入 Provider 表单的模型列表
5. 导入规则：拉取的 `id` 同时作为别名和上游模型名填入，用户可随后修改别名

### 相关文件
- 新增 `src/api/handlers.ts` 中的 `handlePullModels` 函数
- 新增路由到 `server.ts` 的 ROUTES
- 修改 `admin-ui.html`：Provider modal 添加按钮 + 选择弹窗

---

## 方向 3: 语义化按钮颜色

### 按钮颜色映射

| 操作 | CSS 类 | 颜色 | 使用场景 |
|------|--------|------|---------|
| 删除 | `btn-danger` | `var(--danger)`: #d43b3b | 删除 provider/adapter、确认对话框确定按钮 |
| 测试 | `btn-success` | `var(--success)`: #1a8c4a | 模型测试按钮 |
| 编辑 | `btn-warning` | `var(--warn)`: #cc7a00 | 编辑/操作行中的编辑按钮 |
| 添加 | `btn-primary` | `var(--accent)`: #3080f0 | 添加按钮（已有） |
| 次要 | `btn-ghost` | 灰色 | 取消、关闭（默认） |

### CSS 实现

```css
.btn { /* 基础样式已有 */ }
.btn-primary { background: var(--accent); color: #fff; }
.btn-ghost { background: transparent; color: var(--text-muted); }

.btn-danger {
  background: var(--danger-bg); color: var(--danger);
  border: 1px solid transparent;
}
.btn-danger:hover { background: var(--danger); color: #fff; }

.btn-success {
  background: var(--success-bg); color: var(--success);
  border: 1px solid transparent;
}
.btn-success:hover { background: var(--success); color: #fff; }

.btn-warning {
  background: var(--warn-bg); color: var(--warn);
  border: 1px solid transparent;
}
.btn-warning:hover { background: var(--warn); color: #fff; }
```

设计选择：
- Light variant 作为常态（底色淡，字色深），hover 变为实色（底色深，字色白）
- 保持 `btn-ghost` 不变用于取消/关闭等次要操作
- 确认对话框的「确定删除」使用 `btn-danger` 实色（而非目前的内联样式）

### 需要改动的按钮位置

#### Provider 表格（admin-ui.html ~L512）
| 操作 | 当前 | 改为 |
|------|------|------|
| 编辑 | `btn-ghost` | `btn-warning` |
| 删除 | `btn-ghost` | `btn-danger` |
| 测试 | `btn-ghost` | `btn-success` |

#### Adapter 表格（admin-ui.html ~L549）
| 操作 | 当前 | 改为 |
|------|------|------|
| 编辑 | `btn-ghost` | `btn-warning` |
| 删除 | `btn-ghost` | `btn-danger` |

#### 确认对话框（admin-ui.html ~L329-330）
| 按钮 | 当前 | 改为 |
|------|------|------|
| 确定删除 | 内联 style 的 `btn-ghost-danger` | `btn-danger`（实色） |
| 取消 | `btn-ghost` | 不变 |

#### 动态行删除按钮（admin-ui.html ~L564, L590）
| 按钮 | 当前 | 改为 |
|------|------|------|
| ✕ 删除 | 内联 style | 使用 `btn-danger btn-sm btn-icon` |

### 相关文件
- 仅修改 `admin-ui.html` 的 `<style>` 和 `<script>` 部分

---

## 方向 4: 模型名预设下拉框 + API Base 预设

### 模型名下拉框

#### 实现方案

将 `addModelRow()` 中的第二个输入框（上游模型名）从 `<input>` 改为 `<select>` + 一个"自定义..."选项。

**预设模型列表**（按 provider type）：

```javascript
const MODEL_PRESETS = {
  openai: [
    'gpt-4o', 'gpt-4o-mini', 'gpt-4o-2024-08-06', 'gpt-4o-2024-05-13',
    'o1', 'o1-mini', 'o3-mini',
    'gpt-4-turbo', 'gpt-4-turbo-2024-04-09',
    'gpt-4', 'gpt-4-32k', 'gpt-4-0125-preview',
    'gpt-3.5-turbo', 'gpt-3.5-turbo-0125',
  ],
  anthropic: [
    'claude-sonnet-4-20250514', 'claude-sonnet-4',
    'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-20241022', 'claude-3-5-haiku-latest',
    'claude-3-opus-20240229', 'claude-3-opus-latest',
    'claude-3-haiku-20240307',
  ],
}
```

**交互**：
1. 选中预设模型 → 自动填入别名（从 model id 首段推导，如 `claude-sonnet-4-20250514` → 别名 `claude-sonnet-4`）
2. 选中"自定义..." → 输入框变为可见，用户自由输入
3. 别名保留自由输入（因为别名是业务语义的，很难预设）
4. 通过 prop 或 `data-type` 在 `addModelRow()` 调用时传入当前 type

#### 改动范围

- `addModelRow(name, model, type)` 增加 `type` 参数用于切换预设
- `openProviderForm()` 中改调用方式
- Provider 表格行中新增搜索栏上方的当前 type 信息用于联动

### API Base 预设选择器

#### 实现方案

将 API Base 的 `<input>` 改为 `<select>` + 自定义输入：

```javascript
const API_BASE_PRESETS = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
}
```

**交互**：
1. 选择 Provider type（openai/anthropic）时，自动切换 API Base 预设值
2. 提供"自定义..."选项，选中后显示文本输入框
3. 如果用户已经输入自定义值，保留不覆盖

#### 改动范围
- 替换 `admin-ui.html` 中 API Base 输入框为 `<select>` 加隐藏的 `<input>`
- 联动 `pType` 的 `onchange` 事件

---

## 实现顺序建议

建议按以下顺序实现（从低风险高价值开始）：
1. ✅ **语义化按钮颜色** — 纯 CSS 改动，零风险，立竿见影的视觉效果
2. ✅ **API Base 预设选择器** — 纯前端改动，数据已有
3. ✅ **模型名预设下拉框** — 纯前端改动，预设数据写死
4. ✅ **GET /v1/models** — 新后端端点，需路由测试
5. ✅ **远程模型拉取** — 新后端端点 + UI 弹窗交互

## 依赖文件清单

| 文件 | 改动类型 | 涉及方向 |
|------|---------|---------|
| `src/api/admin-ui.html` | 修改 | 2, 3, 4 |
| `src/api/handlers.ts` | 新增函数 | 1, 2 |
| `src/api/server.ts` | 新增路由 | 1, 2 |
