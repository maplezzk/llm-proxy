# Grill: Admin UI 迁移到 React + Appica UI

- 状态: completed
- 日期: 2026-07-25
- 范围: llm-proxy admin WebUI 从 Alpine.js 全量迁移到 React + Appica UI（@appica/ui-react）
- 启动方式: 用户已确认 4 项高层决策，本轮 grill 聚焦第三方依赖处置与功能/响应式边界

## 启动阶段已确认决策（来自 ask_user_question）

| # | 决策 | 选择 |
|---|------|------|
| 1 | 重构范围 | 全量一次迁移（10 个组件） |
| 2 | 构建接入 | 引入 Vite |
| 3 | 视觉主题 | 采用 Appica 默认主题（含原生 light/dark） |
| 4 | 交付 | 仅到上线清单，不 bump/不发布 npm |

## 代码事实及证据

| 事实 | 证据 |
|------|------|
| 当前前端为 Alpine.js + 手写 CSS，无 Tailwind/React | `src/api/admin-ui.html`（1143 行，手写 CSS 变量），`src/api/admin/app.ts` esbuild 打包 |
| 10 个组件 | `src/api/admin/components/`: adapters/capture/dashboard/logs/port-setting/providers/proxy-key/test-panel/usage-charts/vision-setting |
| jsoneditor（CDN）仅 capture 页使用 | `capture.ts:150` `window.JSONEditor`，用于抓包左右 JSON 对比 + 差异分析 |
| Chart.js 仅 usage-charts 使用 | `usage-charts.ts` import 'chart.js'，token 统计图表 |
| i18n 用 i18next，zh/en 双语，localStorage + 服务端同步 | `src/api/admin/i18n.ts` |
| 16 个 admin 端点 + 1 个 SSE | `fetch('/admin/*')` 16 处 + `EventSource('/admin/debug/captures/stream')` |
| 基本无响应式 | `admin-ui.html` 仅 1 处 `@media` |
| 静态资源交付 | `server.ts` 直接返回 `admin-ui.html` + `admin-app.js`；npm `files: dist/bin/locales`；macOS app build 引用二者 |

## 分支结论

### 第三方依赖处置 — 已定

- **jsoneditor**: 保留 CDN 加载，在 React 中封装为组件。理由：抓包对比/差异分析是核心调试功能，重写成本高、风险大。
- **Chart.js → recharts**: 用户选择引入其他图表库；选 recharts（React 原生声明式图表，适配 token 统计 dashboard，无需手动操作 Canvas）。

### 功能边界 — 已定

- 10 个组件 1:1 全量等价迁移，不增不减，行为不变。

### 响应式 — 已定

- 基础响应式：利用 Appica 组件自带响应式能力（侧栏可收起、表格横向滚动），不专门做移动端优化。

### 术语 / Glossary — 已定

- 无新增项目特有术语需 canonicalize。现有术语（capture/抓包、adapter、provider、proxy-key）已在代码与 i18n 中一致使用。
- 项目无 `CONTEXT.md`，本次也不新建（无新领域概念）。

## ADR 判断结果

| 决策 | 三条件（难逆转/缺上下文费解/真实取舍） | 结果 |
|------|----------------------------------------|------|
| 迁移到 React + Appica + Vite（含主题默认） | 是/是/是 | **写** → `docs/adr/0001-migrate-admin-ui-to-react-appica.md` |
| 保留 jsoneditor CDN | 否（易逆转）/是/是 | 不写，原因记录于此 |
| recharts 替换 Chart.js | 否（易逆转）/是/是 | 不写，原因记录于此 |
| 基础响应式 | 否/否/是 | 不写 |
| 全量等价不增删 | 属范围约束非架构决策 | 不写 |

## 已定 / 未定 / deferred / 阻塞

- 已定: 范围(全量)、构建(Vite)、主题(Appica默认+dark)、交付(仅上线清单)、jsoneditor(保留CDN)、图表(recharts)、功能(等价不增删)、响应式(基础)
- 未定: 无
- deferred: 无
- 阻塞: 无

## 交给 plan 的输入

- 本 grill 记录: `docs/grills/2026-07-25-appica-admin-ui-grill.md`
- ADR: `docs/adr/0001-migrate-admin-ui-to-react-appica.md`
- CONTEXT.md: 无（不需要）
