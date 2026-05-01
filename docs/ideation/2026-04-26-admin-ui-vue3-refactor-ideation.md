---
date: 2026-04-26
topic: admin-ui-alpine-refactor
focus: sve-mono-admin-html-to-alpine-js
---

# Ideation: Admin UI 响应式重构

## Codebase Context

- 项目: Node.js >=20, TypeScript, esbuild, 原生 http server
- Admin UI: 单文件 `src/api/admin-ui.html` (911 行, ~240 行内联 CSS + ~500 行内联 JS)
- 4 页面: dashboard, logs, providers, adapters
- CRUD 通过 fetch 调 /admin/* JSON API
- 无构建步骤, 通过 readFileSync 从磁盘加载
- 全局变量 (7 个) 管理状态: _allLogs, _allProviders, _allAdapters, _cachedConfig, editingProvider, editingAdapter, _pullModelsData
- 表单使用 DOM-as-state 模式 (createElement + innerHTML, 再 querySelectorAll 回读)

## Ranked Ideas

### 1. Alpine.js 渐进式嵌入

**Description:** 通过 CDN script 标签引入 Alpine.js (14.5kB gzip), 用 x-data/x-model/x-on/x-text/x-for 逐步替换命令式 DOM 操作. 从 provider 表单开始, 一次一个页面。零构建步骤。

**Rationale:** 当前 500 行 JS 全是指令式 DOM 操作 (onclick, oninput, innerHTML=...). Alpine.js 正为此设计 — 一个 script 标签即可开始, 无需构建步骤, 不会有部署风险. 可逐模态框渐进迁移.

**Downsides:** 生态小于 Vue; 没有 .vue 单文件组件; TypeScript 类型在浏览器端不直接受益; 不适合构建大型 SPA

**Confidence:** 85%
**Complexity:** Low
**Status:** Explored (关联 brainstorm: 2026-04-26-admin-ui-alpine)

### 2. 统一错误处理链

**Description:** 包装 fetch 层统一处理网络错误+业务错误, 用发布/订阅模式解耦错误展示. 框架独立.

**Rationale:** api() 调用散布 15+ 处, 模式不统一 (.catch(() => null) / check res.success / toast)。评分 42/50 最高。

**Downsides:** 纯 JS 中需要手动实现 ErrorBoundary

**Confidence:** 95%
**Complexity:** Low
**Status:** Unexplored

### 3. 绞杀藤迁移策略

**Description:** 一次迁移一个页面/一个 modal, 新旧代码在同一 HTML 中共存直到全部完成. 从 provider 表单 (最复杂) 开始。

**Rationale:** 无论选什么框架, 这是唯一可持续的迁移策略. 当前 911 行不能一次重写.

**Downsides:** 混合状态增加短期认知负荷

**Confidence:** 90%
**Complexity:** Med
**Status:** Unexplored

### 4. Alpine.store 替换全局变量

**Description:** _allLogs, _allProviders, _allAdapters, _cachedConfig 等全局变量提取为 Alpine.store(), 组件内自动响应.

**Rationale:** Alpine.store() 天然支持跨组件共享状态, 比手动全局变量管理更安全.

**Downsides:** 需先选定 Alpine.js

**Confidence:** 80%
**Complexity:** Med
**Status:** Unexplored

### 5. 前后端共享类型

**Description:** src/shared/types.ts 定义 Admin API 类型, 后端 handler import 使用.

**Rationale:** 后端已全 TypeScript, 类型定义工作量极低 (6-8 个类型)。即使 Alpine.js 前端无法直接导入, 作为契约文档也有价值.

**Downsides:** Alpine.js 前端无法导入 TS 类型; 需维护一致性

**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored

### 6. 纯 JS 模块化提取 (兜底)

**Description:** 不引入框架, 仅将 500 行 JS 按功能拆多个文件.

**Rationale:** 兜底方案. 1-2 小时完成. 不解决核心痛点 (DOM-as-state), 但降低文件级认知负荷.

**Downsides:** 不解决状态管理问题; 无法启用未来改进

**Confidence:** 95%
**Complexity:** Low
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason |
|---|------|--------|
| 1 | Vite + Vue3 全链路构建 | 项目规模过重, 构建失败杀死 admin UI |
| 2 | Feature 目录 + SFC 结构 | 依赖构建工具决策 |
| 3 | CSS token 系统 | :root 变量已实现 |
| 4 | 分层测试 | 组件框架未定, 时机过早 |
| 5 | 前后端解耦 | 本地代理 readFileSync 方案正确 |
| 6 | 分层 CSS | 现行 ~240 行可控 |
| 7 | Vue Router | 当前 hash 路由仅 ~30 行, 工作良好 |
| 8 | HTMX | 需后端改 HTML 片段, 架构方向冲突 |
| 9 | BFF 模式 | 后端已提供 JSON API, 多余抽象 |
| 10-14 | Vite/Vue3 变体 | 被 Alpine 方案取代 |

## Session Log
- 2026-04-26: 初始构思 — 33 个候选生成, 去重合并后 22 个, 批判过滤后 7 个幸存。用户选择 Alpine.js 方向。
