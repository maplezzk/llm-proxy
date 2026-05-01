---
date: 2026-04-25
topic: admin-ui-ux
focus: 按钮颜色语义化 + /models 端点 + 远程模型拉取 + 表单下拉选项
---

# Ideation: Admin UI UX 改进

## 背景

用户对当前 Admin UI 提出了三个改进方向：
1. 操作按钮颜色太素，全是同色 btn-ghost
2. 需要支持 /models 接口（双向：代理暴露 + 配置时从上游拉取）
3. 很多编辑框应改为下拉选项（输入值其实是受限的）

## 已选 Idea 列表

### 1. GET /v1/models — OpenAI 兼容模型发现端点
**描述：** 新增 `GET /v1/models` 端点，返回代理可路由的所有模型的 OpenAI 兼容格式列表。Cursor、Cline、Continue 等工具连接自定义端点时首先请求该接口。返回格式：`{ object: "list", data: [{ id, object, created, owned_by }] }`。
**Rationale：** 工具接入代理的基础能力，缺少该端点会导致客户端报错或无法发现模型。
**Confidence：** 100%
**Complexity：** 低
**Status：** Explored（关联 brainstorm: 2026-04-25-admin-ui-ux）

### 2. 语义化按钮颜色
**描述：** 新增 btn-danger（红）、btn-success（绿）、btn-warning（橙）CSS 类，替换当前全部 btn-ghost 的操作按钮。CSS 变量 `--danger`/`--success`/`--warn` 已存在但从未用于按钮。
**Rationale：** 用户直接提出的第一项诉求。不同操作应有视觉区分，特别是删除(危险)和测试(安全)不能同色。
**Confidence：** 100%
**Complexity：** 极低
**Status：** Explored（关联 brainstorm: 2026-04-25-admin-ui-ux）

### 3. POST /admin/providers/:name/pull-models — 远程模型拉取
**描述：** 新增端点，调用上游 provider 的 GET /v1/models（传递 apiKey），返回远程可用模型列表。UI 添加「拉取远程模型」按钮，弹窗让用户勾选要导入的模型。
**Rationale：** 用户直接提出的第二项诉求。手动输入模型名称是配置时最大痛点，特别是名称很长容易输错。
**Confidence：** 95%
**Complexity：** 中
**Status：** Explored（关联 brainstorm: 2026-04-25-admin-ui-ux）

### 4. 模型名预设下拉框
**描述：** Provider 表单「上游模型名」从自由文本输入改为带预设值的下拉框 + "自定义..."选项。根据 provider type 动态切换预设列表。
**Rationale：** 用户直接提出的第三项诉求。模型名是受限值（gpt-4o, claude-sonnet-4 等固定集合），下拉选择消除拼写错误。
**Confidence：** 100%
**Complexity：** 低
**Status：** Explored（关联 brainstorm: 2026-04-25-admin-ui-ux）

### 5. API Base URL 预设选择器（辅助项）
**描述：** API Base 从自由文本改为下拉选择：OpenAI 默认 / Anthropic 默认 / 自定义。
**Rationale：** #4 的自然延伸，后端已有 DEFAULT_API_BASES 映射。
**Confidence：** 90%
**Complexity：** 极低
**Status：** Unexplored

### 6. 批量粘贴导入模型（辅助项）
**描述：** Provider 表单增加「批量导入」按钮，textarea 解析多行文本。
**Rationale：** #4 的有益补充，Provider 有 20+ 模型时逐行添加太过痛苦。
**Confidence：** 80%
**Complexity：** 低
**Status：** Unexplored

## 被驳回方案

| # | Idea | 驳回理由 |
|---|------|---------|
| 4 | Skeleton Loading States | 打磨功能，不涉及三项诉求 |
| 5 | Modal Focus Trap | 用户未提，收益有限 |
| 6 | Inline Form Validation | 用户未提，已有 toast 报错 |
| 7-8 | Batch/Rich Test Results | 用户未提 |
| 10 | GET /admin/models | 被 #1 覆盖 |
| 12 | openai-compatible 类型扩展 | 改动面太大，不涉及三项诉求 |
| 13 | GET /v1/models/:model | 被 #1 覆盖 |
| 18 | 一键预填模板 | 不如 #4 直接 |
| 21 | 环境变量管理 | 独立功能方向，不混入 |
| 22 | 可搜索级联选择器 | 已有级联，搜索增强非必需 |
| 26 | YAML 编辑器 | 不适合单 HTML SPA |
| 30 | 命令面板 | 过度工程 |
| 33 | 配置快照 | 成本过高 |

## Session Log
- 2026-04-25: 初始构思 — 31 个候选方案生成，6 个幸存，25 个拒绝。用户确认启动 brainstorm。
