---
date: 2026-04-25
status: active
type: feat
---

# Feat: Admin UI 命名一致性优化

## 问题

Admin UI 中"模型名"和"模型 ID"概念混淆，Provider 相关叫法不统一：

| 问题 | 位置 | 当前显示 | 问题描述 |
|------|------|----------|----------|
| 侧边栏名称模糊 | sidebar `data-tab=providers` | "模型" | 实际管理的是 Provider 配置，不是"模型"本身 |
| Provider 页面标题 | section-header h3 | "模型 Provider" | 中英混用且冗余 |
| Adapter 表格列 | table th | "格式" | 与 Provider 表的"类型"含义相同（openai/anthropic）但叫法不同 |
| Adapter 表单 | label | "格式" | 同上 |
| Provider 模型行 | dynamic-row label | "模型名" | 实际是发给上游 API 的`上游模型 ID`，不是模型"名" |
| Adapter 映射行 | dynamic-row label | "模型" | 实际引用的是 Provider 配置中的 Model.name（别名），容易误解为上游模型 ID |

## 术语对应关系

| 出站字段 | Types 字段 | 语义 | 应该显示的 UI 标签 |
|----------|----------|------|-------------------|
| `Model.name` | `models[].name` | 客户端请求使用的别名 | "别名"（已正确） |
| `Model.model` | `models[].model` | 发给上游 API 的模型标识 | "上游模型"（改） |
| `Provider.type` | `providers[].type` | API 协议类型 | "类型"（已正确） |
| `AdapterConfig.format` | `adapters[].format` | 同上 | "类型"（改） |
| `AdapterModelMapping.model` | `models[].name` | 引用的是模型别名 | "模型别名"（改） |

## 实现单元

### 单元 1：侧边栏和页面标题优化

- **Goal**: 将"模型"统一为"Provider"，消除页面标题中英混用
- **Files**: `src/api/admin-ui.html`
- **Changes**:
  - 行 254: 侧边栏 `<span>模型</span>` → `<span>Provider</span>`
  - 行 417: `providers: '模型'` → `providers: 'Provider'`
  - 行 295: `<h3>模型 Provider</h3>` → `<h3>Provider</h3>`

### 单元 2：Adapter "格式" → "类型" 统一

- **Goal**: 与 Provider 保持一致的术语
- **Files**: `src/api/admin-ui.html`
- **Changes**:
  - 行 321: Adapter 表头 `<th>格式</th>` → `<th>类型</th>`
  - 行 379: Adapter 表单 `<label>格式</label>` → `<label>类型</label>`

### 单元 3：模型行标签明确化

- **Goal**: 区分"别名"与"上游模型 ID"，说明适配器引用的是模型别名
- **Files**: `src/api/admin-ui.html`
- **Changes**:
  - Provider 模型行（自定义模式，行 610）: `模型名` → `上游模型`
  - Provider 模型行（下拉模式，行 614）: `模型名` → `上游模型`
  - Adapter 映射行（行 659）: `模型` → `模型别名`
  - Adapter 映射行选择器 `pm-label` 类（已有）

## 验证

1. 页面侧边栏显示"Provider"而非"模型"
2. Provider 页面标题显示"Provider"而非"模型 Provider"
3. Adapter 表格和表单显示"类型"而非"格式"
4. Provider 模型行标签显示"上游模型"而非"模型名"
5. Adapter 映射行标签显示"模型别名"而非"模型"

## 范围边界

- 不改动 TypeScript 后端字段名（`Model.model`、`AdapterModelMapping.model` 等保持原名）
- 不改动 YAML 配置文件字段名
- 不改动 API 响应 JSON 字段名
- 仅修改 `admin-ui.html` 的 UI 文本标签
