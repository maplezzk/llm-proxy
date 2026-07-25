---
title: Admin UI 迁移到 React + Appica UI（Vite 构建）
type: refactor
status: active
date: 2026-07-25
origin: docs/grills/2026-07-25-appica-admin-ui-grill.md
---

# Admin UI 迁移到 React + Appica UI（Vite 构建）

## Overview

将 llm-proxy 管理后台前端从 **Alpine.js + 手写 CSS + esbuild 单文件** 整体迁移到 **React 19 + Appica UI（@appica/ui-react）+ Tailwind CSS v4 + Vite**。采用 Appica 默认主题（含原生 light/dark），图表从 Chart.js 换为 recharts，capture 页保留 CDN jsoneditor。**不改变任何后端 API、协议转换逻辑**；仅重写前端并最小化调整静态资源交付（维持"单 HTML 文件"交付契约）。

## Problem Frame

现有前端是手写 CSS + Alpine.js 的单体页面（`src/api/admin-ui.html` 1143 行 + `src/api/admin/` ~1900 行 TS），缺乏成熟组件库（无障碍、键盘交互、动效、暗色模式均需手写），视觉与交互一致性靠人工维护，构建仅 esbuild 裸打包。用户希望采用 [Appica UI](https://appica.dev/llms-full.txt) 组件库重构，获得现代化、可访问、带 light/dark 的界面与更好的开发体验（Vite HMR）。详见 grill 记录与 [ADR-0001](../adr/0001-migrate-admin-ui-to-react-appica.md)。

## Requirements Trace

来源：grill 记录（`docs/grills/2026-07-25-appica-admin-ui-grill.md`）+ 用户 4 项决策 + AGENTS.md 规则 8（用户文案国际化）。

- R1. 新前端用 Vite 构建，`/admin` 仍返回可工作的单页应用；**交付契约维持单 HTML 文件**（npm `files: dist`、macOS app bundle、server 直接 readFileSync 均依赖）。
- R2. 10 个组件功能 1:1 全量等价迁移（dashboard / providers / adapters / logs / capture / settings / test-panel / port-setting / proxy-key / vision-setting），行为不变、不增不减。
- R3. 使用 Appica UI 组件，采用其默认主题，原生支持 light/dark 切换（跟随系统 + 手动切换 + 持久化）。
- R4. 保留 i18next zh/en 双语；localStorage 记忆 + 服务端 locale 同步（`/admin/locale`）行为不变。
- R5. capture 页保留 CDN jsoneditor（左右对比 + tree/code/text 视图 + 只读），封装为 React 组件。
- R6. usage 图表从 Chart.js 换为 recharts（时间线折线 + 维度堆叠柱状）。
- R7. 基础响应式（侧栏可收起、表格横向滚动），不专门做移动端优化。
- R8. `npm run build`、`tsc --noEmit`、全量测试（115 tests）通过；`npm pack` 与 macOS `app/scripts/build.sh` 产物不受破坏。
- R9. 仅到上线清单，不 bump 版本、不发布 npm（未授权外部交付）。

## Scope Boundaries

- **不改后端**：所有 `/admin/*` 与 `/v1/*` API、协议转换、SSE 推流、token 统计逻辑保持原样。
- **不改 locales/**：`locales/{zh,en}/translation.json` 前后端共享，key 全部复用，不新增/重命名 key（后端 CLI 也消费）。
- **不新增后端能力**：不引入新的 API、不动 config schema。
- 移除旧前端代码与 `admin-app.js` serve 路由（交付契约改为单 HTML 后的必然清理）。

### Deferred to Follow-Up Work
- 专门的移动端深度适配、PWA、SSR：本次不做。
- jsoneditor 替换为自研查看器：本次保留 CDN（见 grill 决策）。

## Context & Research

### Relevant Code and Patterns
- 旧前端功能规格（迁移对照基准）：`src/api/admin-ui.html`、`src/api/admin/{app,store,i18n,types}.ts`、`src/api/admin/components/*.ts`（10 个）。
- 全局状态模型：`src/api/admin/store.ts` — Alpine `store('app')`：`config/health/tokenStats/currentTab`、`fetch()` 封装、`toast()`、`confirm()`（Promise 化）、`switchTab`（hash 路由）、`switchLang`、`loadDashboard` + 10s 轮询、`reloadConfig`。
- 静态交付：`src/api/server.ts` `getAdminUIHtml()`/`getAdminAppJs()`（CWD 或 `dist/api` 读取）；路由 `GET /admin` 与 `GET /admin-app.js`。
- 构建：`package.json` `build` = `tsc && cp src/api/admin-ui.html dist/api/ && esbuild src/api/admin/app.ts --bundle`。
- macOS：`app/scripts/build.sh` 复制 `dist/api/admin-ui.html` 与 `dist/api/admin-app.js` 进 `.app` Resources。
- tsconfig：`rootDir: src`、`include: src/**/*` → 顶层 `admin-ui/` 天然不被后端 tsc 编译（隔离安全）。
- i18next 后端也使用（`src/lib/i18n.ts`）→ `i18next` 保持 dependency；`alpinejs`/`chart.js`/`@types/alpinejs` 迁移后移除。
- 测试：`test/**` 无一处引用 `admin-app.js`/`admin-ui.html`/`text/html` → 移除 admin-app 路由不破坏测试。

### Institutional Learnings
- 本仓库 `docs/brainstorms/2026-05-28-macos-native-admin-console-requirements.md`（macOS 控制台需求）— 本次保持 Web 方案，不冲突。

### External References
- Appica UI 完整文档（已离线缓存 `/tmp/appica-llms-full.txt`）：<https://appica.dev/llms-full.txt>
  - Installation：React ≥19 + Tailwind v4（`@tailwindcss/vite`）；`src/index.css` 写 `@import 'tailwindcss'; @import '@appica/ui-react/styles.css'; @source '../node_modules/@appica/ui-react/dist';`；根组件包 `ThemeProvider`；组件按子路径导入 `@appica/ui-react/<name>`。
  - Dark Mode：class-based（`<html>` 加 `.dark`），`ThemeProvider` 首屏前注入脚本防闪烁，默认跟随系统 + `localStorage[theme]` 持久化；`useTheme()` 读 `resolvedTheme/setTheme/mounted`。
  - 图标：`@appica/icons-react`。
  - 可用组件（覆盖本需求）：Navigation（侧栏，`orientation="vertical"` + `activeLink`）、Data Table / Table、Dialog / Alert Dialog、Field/Input/Select/Switch/Checkbox/Textarea、Tabs、Badge、Toast、Scroll Area、Pagination、Skeleton、Separator、Spinner。

## Key Technical Decisions

- **新前端放顶层 `admin-ui/`（独立 Vite 工程）**：`rootDir: src` 的后端 tsc 不会误编译 .tsx；与后端构建物物理隔离。
- **vite-plugin-singlefile 产出单 HTML**（见 ADR-1）：维持"单文件交付契约"，server/npm/macOS 改动最小。
- **状态管理用 React Context + hooks（不引 zustand）**：全局状态量小（config/health/tokenStats/currentTab），Context 足够，避免新增依赖与学习成本。
- **i18n 用 react-i18next**：i18next 已存在，react-i18next 提供语言切换自动重渲染与 `useTranslation`，替换 Alpine 的 `$t` magic。
- **hash 路由保留（不引 react-router）**：仅 6 个 tab，`location.hash` + `hashchange` 足够，且保持 `/admin/#capture` 等既有 URL 兼容。
- **图表 recharts**：React 原生声明式，`LineChart`（时间线 4 指标）+ 堆叠 `BarChart`（维度分布），替换 Chart.js。
- **jsoneditor 维持 CDN**：`index.html` 引 jsdelivr 脚本，`JsonEditorPane` 组件内 `useRef+useEffect` 实例化（只读、无菜单栏、tree/code/text）。
- **Vite dev server 反代 `/admin/*` → :9000**：dev 时前端 :5173，API 走代理到本地 llm-proxy，保留 HMR 体验。

**ADR-1. 单 HTML 交付（vite-plugin-singlefile）vs Vite 默认多 chunk**
- **决策:** 用 `vite-plugin-singlefile` 把 JS/CSS 全部内联进一个 `admin-ui.html`。
- **备选方案:** Vite 默认输出 `index.html + assets/*.js/css` — 需给 server.ts 增加静态目录 serve + MIME + hash 资产处理，npm/macOS 打包也要带整个 assets 目录，改动面与回归面大。
- **权衡:** 换取交付契约零破坏（server 仍 `readFileSync` 单文件、`files: dist` 不变、macOS build.sh 仅删一行）；放弃代码分割（admin 单页应用，首屏体积可接受，~与现状同量级）。
- **可逆性:** 中撤销（改回多文件需同步改 server 静态 serve + 打包脚本）。

## Open Questions

### Resolved During Planning
- 新前端目录位置 → 顶层 `admin-ui/`（tsc 隔离 + 构建独立）。
- 如何不破坏单文件交付 → vite-plugin-singlefile（ADR-1）。
- `/admin-app.js` 路由去留 → 移除（单 HTML 后无引用，测试不依赖）。
- 图表库 → recharts（grill 已定"引入其他图表库"，选 React 原生方案）。

### Deferred to Implementation
- 各 Appica 组件具体 props/variant 细节：实现时对照 Appica 文档逐组件定（不影响架构）。
- recharts 配色与暗色适配的具体 token 映射：实现时按 Appica token 微调。
- 根目录 `admin-app.js`/`admin-ui.html`（git 已跟踪但 .gitignore 列出的 dev 副本）的最终处置：cutover 时确认 tsx watch dev 流程是否仍需要，一并清理。

## Output Structure

    admin-ui/
      index.html                 # Vite 入口（dev），build 时被 singlefile 内联
      vite.config.ts             # react + @tailwindcss/vite + singlefile；dev proxy /admin->:9000
      tsconfig.json              # JSX/DOM（独立于后端 tsconfig）
      src/
        main.tsx                 # createRoot；ThemeProvider + I18nProvider + AppProvider + Toaster + ConfirmDialog
        index.css                # @import tailwindcss; @import '@appica/ui-react/styles.css'; @source ../node_modules/@appica/ui-react/dist
        App.tsx                  # Sidebar + Topbar + 页面切换（hash 路由）
        i18n.ts                  # i18next init + detectAdminLang + switchLang + syncLocaleFromServer（移植自 src/api/admin/i18n.ts）
        lib/
          api.ts                 # fetchJson 封装（Content-Type: application/json）
          app-state.tsx          # AppProvider/useApp：config/health/tokenStats/currentTab/轮询/reloadConfig
          toast.tsx              # ToastProvider/useToast（Appica Toast）
          confirm.tsx            # ConfirmProvider/useConfirm（Appica AlertDialog，Promise 化）
        components/
          Sidebar.tsx            # Navigation(vertical)+状态点+reload+语言切换+主题切换+PortSetting
          Topbar.tsx
          PortSetting.tsx        # 端口内联编辑（1-65535 校验）
          TestPanelDialog.tsx    # provider/adapter 连通性测试弹窗（共享）
          charts/TimelineChart.tsx    # recharts LineChart（input/output/cacheRead/cacheCreate）
          charts/BreakdownChart.tsx   # recharts 堆叠 BarChart（input/output × 维度）
          JsonEditorPane.tsx     # jsoneditor CDN 封装（只读/tree/code/text）
        pages/
          DashboardPage.tsx  ProvidersPage.tsx  AdaptersPage.tsx
          LogsPage.tsx       CapturePage.tsx     SettingsPage.tsx

## High-Level Technical Design

    main.tsx
      └─ ThemeProvider(Appica, 跟随系统+持久化)
         └─ I18nProvider(i18next: zh/en, localStorage, /admin/locale 同步)
            └─ AppProvider(config/health/tokenStats/currentTab/轮询)
               └─ ToastProvider + ConfirmProvider
                  └─ App: <Sidebar/> <Topbar/> {page[currentTab]}
                            currentTab ← location.hash (#dashboard|providers|adapters|logs|capture|settings)

    数据流：页面组件 --useApp()/fetchJson--> /admin/* （后端不变）
    capture：CapturePage --EventSource--> /admin/debug/captures/stream （SSE 不变）

## Implementation Units

- [ ] U1. **构建管线 + Walking Skeleton**

**Goal:** 建立 `admin-ui/` Vite+React19+Tailwind v4+Appica 工程，singlefile 构建出 `admin-ui.html` 并接入 server 交付链路；跑通"构建→serve→浏览器渲染"端到端最小路径。

**Requirements:** R1, R3, R8

**Dependencies:** None

**Files:**
- Create: `admin-ui/index.html`、`admin-ui/vite.config.ts`、`admin-ui/tsconfig.json`、`admin-ui/src/main.tsx`、`admin-ui/src/index.css`、`admin-ui/src/App.tsx`（骨架）
- Modify: `package.json`（scripts + deps）、`src/api/server.ts`（html 读取指向新产物，admin-app 路由暂留到 U9）、`app/scripts/build.sh`（删 admin-app.js 复制行）
- Test: 手动（构建产物 + serve 验证），不新增单测

**Approach:**
- 依赖：`react@^19`、`react-dom@^19`、`@appica/ui-react`、`@appica/icons-react`、`recharts`、`react-i18next`、`i18next`（已有）放 `dependencies`；`vite`、`@vitejs/plugin-react`、`tailwindcss`、`@tailwindcss/vite`、`vite-plugin-singlefile`、`@types/react{,-dom}` 放 `devDependencies`（构建时存在即可，产物自包含）。
- `vite.config.ts`：`plugins: [react(), tailwindcss(), viteSingleFile()]`；`build.outDir: 'dist'`、产物名固定 `admin-ui.html`；`server.proxy: { '/admin': 'http://localhost:9000' }`。
- `package.json`：新增 `build:admin = vite build --root admin-ui`；`build` 改为 `tsc && npm run build:admin && cp admin-ui/dist/admin-ui.html dist/api/admin-ui.html`（删除旧 esbuild 与 `cp src/api/admin-ui.html` 两步）。
- `server.ts` `getAdminUIHtml()`：保持 CWD/`__dirname` 读取逻辑（新 `admin-ui.html` 落到 `dist/api/`，路径不变）。
- 骨架 `App.tsx`：仅渲染 ThemeProvider + 一个占位 Dashboard tab + Appica 主题切换按钮，验证组件库样式与暗色生效。

**Behavior boundary:**
- `npm run build` 成功后 `dist/api/admin-ui.html` 为自包含单文件（无外链 JS/CSS，除 jsoneditor CDN——本单元暂不引入）。
- 启动服务访问 `/admin` 返回 200 HTML，页面渲染出 Appica 组件（非无样式裸元素），主题切换按钮可切 light/dark。
- `/admin-app.js` 路由本单元保留（U9 移除），不影响。

**Patterns to follow:**
- Appica Installation/Dark Mode 章节（`/tmp/appica-llms-full.txt` 980-1300 行、461-580 行）。
- 现有 server.ts 静态读取的 CWD 优先约定（bun 编译二进制场景）。

**Acceptance scenarios:**
- Happy path: `npm run build` → `dist/api/admin-ui.html` 存在且 `grep -c '<script' == 内联` → `npm start` → `curl /admin` 返回含 `<div id="root">` 的 HTML。
- Edge case: `vite build` 在未安装 devDeps 时报错明确（不在本单元处理 production-install 场景）。
- Integration: macOS `app/scripts/build.sh` 执行后 `.app/Contents/Resources/admin-ui.html` 为新产物（删 admin-app.js 行后无报错）。

**Verification:**
- `npm run build` 0 错误；`node -e` 起 server 后 `curl -s localhost:9000/admin | grep -q root`；浏览器打开 `/admin` 见 Appica 样式与主题切换生效；`npm test` 仍全绿。

- [ ] U2. **应用外壳：导航 + 全局状态 + 共享部件**

**Goal:** 完成可导航的完整外壳：6 tab 侧栏（hash 路由）、全局状态（config/health/tokenStats + 10s 轮询）、顶栏、Toast、Confirm、侧栏页脚（运行状态/reload/语言切换/主题切换/端口设置）。

**Requirements:** R2, R3, R4, R7

**Dependencies:** U1

**Files:**
- Create: `admin-ui/src/lib/{api,app-state,toast,confirm}.tsx`、`admin-ui/src/i18n.ts`、`admin-ui/src/components/{Sidebar,Topbar,PortSetting}.tsx`
- Modify: `admin-ui/src/App.tsx`（装配外壳 + 6 个占位页面槽位）、`admin-ui/src/main.tsx`（providers 套娃）

**Approach:**
- `app-state.tsx`：Context 持有 `config/health/tokenStats/currentTab/status`，`loadDashboard()`（并发 `/admin/health`+`/admin/config`+`/admin/token-stats`）、`startPolling()`（10s setInterval）、`reloadConfig()`（POST `/admin/config/reload`）。
- 路由：`useHashTab()` hook 监听 `hashchange`，`switchTab` 写 `location.hash`；tab 白名单与旧版一致（dashboard/providers/adapters/logs/capture/settings）。
- `i18n.ts`：移植 `detectAdminLang`（localStorage>浏览器>en）、`initAdminI18n`、`switchLang`（PUT `/admin/locale` + `changeLanguage`，react-i18next 自动重渲染，去掉 `location.reload`）、`syncLocaleFromServer`。用 `react-i18next` 的 `I18nextProvider` + `useTranslation`。
- Toast：Appica `Toast` 组件 + Context，命令式 `toast(msg, type)`。
- Confirm：Appica `AlertDialog` + Context，`confirm(msg): Promise<boolean>`（对齐旧 store.confirm 语义）。
- 侧栏：Appica `Navigation`（`orientation="vertical"`、`activeLink=currentTab`）+ `@appica/icons-react` 图标；页脚含状态点、reload 按钮、`🌐` 语言切换、主题切换（`useTheme`）、`PortSetting`（`/admin/port` GET/PUT，1-65535 校验，对齐 `port-setting.ts`）。

**Behavior boundary:**
- 点击侧栏任一项切换页面（hash 同步），刷新页面保持 tab；语言切换全站文案即时切换且持久化 + 同步服务端；端口编辑保存成功后 toast + 页脚显示新端口；无效端口提示错误不提交。
- 6 个页面本单元为占位（显示 tab 名），U3-U8 逐个替换为真实页面。

**Patterns to follow:**
- 旧 `store.ts`（轮询/toast/confirm/switchLang/reloadConfig 行为）、`port-setting.ts`（端口校验与保存流程）、`i18n.ts`（语言检测/同步）。
- Appica Navigation / Toast / AlertDialog / useTheme 文档。

**Acceptance scenarios:**
- Happy path: 依次点 6 个 tab 均切换；`#providers` 直接访问定位正确；切换语言后侧栏/顶栏文案变化并写入 localStorage。
- Edge case: 非法 tab hash（如 `#foo`）回退 dashboard 不报错；端口输入 0/70000/非数字 → 错误提示，不发请求。
- Error path: reloadConfig 返回 errors → toast 显示拼接的 error messages（对齐旧行为）。
- Integration: 语言切换 PUT `/admin/locale` 成功后，服务端 locale 更新（后端不变）。

**Verification:**
- 手动过一遍 6 tab 导航、语言/主题切换、端口设置、reload；`npm test` 全绿。

- [ ] U3. **Dashboard 页（统计卡片 + recharts 用量图表 + 存储清理）**

**Goal:** 实现 dashboard 全部功能：今日 token 统计卡片、状态卡片（正常/错误/providers/models/adapters）、时间线折线图、维度分布堆叠柱状图、日期范围/维度切换、数据库信息与清理。

**Requirements:** R2, R6

**Dependencies:** U2

**Files:**
- Create: `admin-ui/src/pages/DashboardPage.tsx`、`admin-ui/src/components/charts/{TimelineChart,BreakdownChart}.tsx`
- Modify: `admin-ui/src/App.tsx`（挂 DashboardPage）

**Approach:**
- 数据：`/admin/token-stats`（今日卡片）、`/admin/token-stats/timeline`（折线）、`/admin/token-stats/breakdown?dimension=`（分布）、`/admin/token-stats/db-info`（存储）、`POST /admin/token-stats/cleanup`（清理）。日期范围预设/自定义 + 维度（provider/adapter/model）切换，对齐 `dashboard.ts`。
- 图表：`TimelineChart` recharts `LineChart`（4 条线：input/output/cacheRead/cacheCreate）；`BreakdownChart` recharts 堆叠 `BarChart`（input/output × key）。暗色下用 Appica token 着色。
- 加载/空态：对齐旧版 loading 遮罩与"暂无数据"提示；清理按钮带 Confirm。

**Behavior boundary:**
- 切换日期范围/维度后两图刷新；清理成功后 toast + db-info 刷新；卡片数值与旧版一致（同一后端）。

**Patterns to follow:** 旧 `dashboard.ts` + `usage-charts.ts`（数据形状、维度、卡片字段）；Appica Card/Badge/Skeleton；recharts 文档。

**Acceptance scenarios:**
- Happy path: 默认视图展示今日统计 + 最近时间线 + provider 分布；切 adapter/model 维度分布图变化。
- Edge case: 无数据时显示空态（非报错）；timeline 为空显示"暂无数据"。
- Error path: 图表请求失败不阻塞卡片渲染。
- Integration: 与 U2 的 10s 轮询共享 tokenStats 不冲突。

**Verification:** 手动核对各卡片/图表与旧版数值一致；切换维度/日期正常；清理流程通。

- [ ] U4. **Providers 页 + 共享 TestPanelDialog**

**Goal:** provider 列表（搜索/状态/测试/编辑/删除）、新增/编辑弹窗表单（name/type/api_key/api_base/models + thinking 配置）、模型行增删、pull-models 弹窗；并实现 providers 与 adapters 共用的连通性测试弹窗。

**Requirements:** R2

**Dependencies:** U2

**Files:**
- Create: `admin-ui/src/pages/ProvidersPage.tsx`、`admin-ui/src/components/TestPanelDialog.tsx`
- Modify: `admin-ui/src/App.tsx`（挂 ProvidersPage）

**Approach:**
- 端点：`GET /admin/status/providers`、`GET /admin/config`、`POST /admin/providers`、`PUT/DELETE /admin/providers/:name`、`POST /admin/providers/:name/pull-models`、`POST /admin/test-model`。
- 表单字段与校验对齐 `providers.ts`（type: openai/anthropic/openai-responses；model 含 `thinking{budget_tokens,reasoning_effort,type}` 与 `input[]`）。
- `TestPanelDialog`：选模型 → `POST /admin/test-model` → 展示 reachable/latency/error + 可展开请求/响应详情（requestUrl/headers/body、responseStatus/body），结果列表可清空。由 Providers/Adapters 通过共享 Context 或 props 触发（替代旧 `open-test-panel` CustomEvent）。
- 删除用 U2 Confirm；操作用 Toast。

**Behavior boundary:**
- 搜索过滤列表；新增/编辑保存后列表刷新 + toast；删除需确认；pull-models 勾选导入；测试弹窗展示延迟/错误与请求响应详情。

**Patterns to follow:** 旧 `providers.ts` + `test-panel.ts`；Appica Dialog/Field/Input/Select/Table/Checkbox。

**Acceptance scenarios:**
- Happy path: 增/改/删 provider 成功并刷新；pull-models 导入选中模型；测试弹窗显示 reachable + latency。
- Edge case: 模型列表为空可保存；重名 provider 后端报错 → toast 显示后端 error。
- Error path: test-model 网络失败 → 显示"请求失败"（对齐旧版 catch 分支）。
- Integration: 删除 provider 后 adapters 引用该 provider 的下拉选项随之更新（共享 config）。

**Verification:** 手动 CRUD + pull-models + 测试弹窗全通；数值/字段与旧版一致。

- [ ] U5. **Adapters 页**

**Goal:** adapter 列表（搜索/baseUrl/模型映射/状态）、新增/编辑弹窗（name/type/max_tokens/stream 默认 + 模型映射表 sourceModelId→provider→targetModelId + thinking）、批量从 provider 导入、删除、测试（复用 TestPanelDialog）。

**Requirements:** R2

**Dependencies:** U2, U4（复用 TestPanelDialog）

**Files:**
- Create: `admin-ui/src/pages/AdaptersPage.tsx`
- Modify: `admin-ui/src/App.tsx`（挂 AdaptersPage）

**Approach:**
- 端点：`GET/POST /admin/adapters`、`PUT/DELETE /admin/adapters/:name`、`POST /admin/test-adapter`。
- 模型映射表行编辑（sourceModelId 输入 / provider 下拉 / targetModelId 下拉，联动 config 中对应 provider 的 models）；stream 三态（follow/true/false）、max_tokens，对齐 `adapters.ts`。
- 批量导入：从选定 provider 导入全部 models 生成映射行。
- 测试复用 `TestPanelDialog`（`POST /admin/test-adapter`）。

**Behavior boundary:** 搜索/CRUD/批量导入/测试行为与旧版一致；映射表行可增删。

**Patterns to follow:** 旧 `adapters.ts`；U4 的表单/表格/弹窗模式。

**Acceptance scenarios:**
- Happy path: 增/改/删 adapter；批量导入后映射表填充；测试弹窗显示 adapterUrl/requestUrl 等详情。
- Edge case: provider 无 models 时导入为空提示；stream 选 follow 不传值。
- Error path: 保存失败 toast 后端 error。

**Verification:** 手动 CRUD + 批量导入 + 测试全通。

- [ ] U6. **Logs 页**

**Goal:** 日志表格（时间/级别/消息/详情可展开 JSON + 复制）、类型筛选（all/request/system）、级别筛选、日期筛选、关键词搜索、分页、日志级别切换（GET/PUT /admin/log-level）、刷新。

**Requirements:** R2

**Dependencies:** U2

**Files:**
- Create: `admin-ui/src/pages/LogsPage.tsx`
- Modify: `admin-ui/src/App.tsx`（挂 LogsPage）

**Approach:**
- 端点：`GET /admin/logs?limit=&date=`、`GET/PUT /admin/log-level`。
- 详情展开：行内可折叠 JSON（含复制按钮，对齐 `copyJson`）。分页上一页/下一页 + 匹配计数文案（`matchCount` i18n 带 count/page/totalPages）。
- 日志级别 Select（debug/info/warn/error）切换后 PUT 并刷新。

**Behavior boundary:** 筛选组合生效；分页正确；详情展开/收起/复制；级别切换持久化。

**Patterns to follow:** 旧 `logs.ts`；Appica Table/Select/Badge/Pagination/Collapsible。

**Acceptance scenarios:**
- Happy path: 默认加载最近日志；类型+级别+关键词组合过滤；翻页。
- Edge case: 无结果显示"empty"，有数据无匹配显示"noMatch"（两种文案区分，对齐旧版）。
- Error path: 加载失败不白屏。

**Verification:** 手动过筛选/分页/详情/级别切换。

- [ ] U7. **Capture 页（SSE 实时抓包 + jsoneditor 对比）**

**Goal:** 抓包调试页：启动/停止/结束抓包（控制后端 + SSE 连接生命周期）、源过滤下拉、条目列表（id/source/时间/大小/状态）、选中条目四阶段详情（requestIn/requestOut 用 jsoneditor 树形，responseIn/responseOut 流式显示原始文本）、复制原始数据。

**Requirements:** R2, R5

**Dependencies:** U2

**Files:**
- Create: `admin-ui/src/pages/CapturePage.tsx`、`admin-ui/src/components/JsonEditorPane.tsx`
- Modify: `admin-ui/index.html`（引入 jsoneditor CDN css/js）、`admin-ui/src/App.tsx`（挂 CapturePage）

**Approach:**
- 端点：`GET /admin/debug/captures/status`、`POST /admin/debug/captures/control`（enabled/clear）、`GET /admin/debug/captures`（历史）、`EventSource /admin/debug/captures/stream`（SSE）。
- SSE 生命周期：启动=启用后端+清空缓存+连 SSE；停止=仅停用后端；结束=停用+清空后端缓存。实时更新：`entry.pairId` 匹配更新、`entry.id` 新增追加（对齐 `capture.ts`）。
- `JsonEditorPane`：`useRef` div + `useEffect` 实例化 `window.JSONEditor`（mode tree，可切 code/text；`mainMenuBar:false`、只读、无导航/状态栏）；props 变化时 `set`/`destroy` 重建。
- 详情布局：四阶段并排（响应式：窄屏纵向堆叠）。

**Behavior boundary:** 三按钮状态机与旧版一致；源过滤生效；选中条目展示四面板；JSON 面板 tree/code/text 切换；复制按钮复制原始内容。

**Patterns to follow:** 旧 `capture.ts`（SSE 匹配/状态机、jsoneditor 配置）；Appica Select/Badge/Scroll Area/Tooltip。

**Acceptance scenarios:**
- Happy path: 启动抓包 → 发一个 /v1 请求 → 列表实时出现条目（request 先、response 经 pairId 合并）；点击查看四面板。
- Edge case: 流式响应 responseIn/responseOut 显示原始 SSE 文本（非 jsoneditor）；重复 pairId 更新而非新增行。
- Error path: SSE 断开重连或提示（对齐旧版行为）；jsoneditor CDN 加载失败时降级显示原始文本不白屏。
- Integration: 与后端 capture 环形缓冲 + SSE 推送（后端不变）联调通过。

**Verification:** 启动服务 + 抓包 + 真实请求，核对四面板与旧版一致；停止/结束行为正确。

- [ ] U8. **Settings 页（Proxy Key + Vision）**

**Goal:** 设置页两张卡片：Proxy Key（设置/移除，`/admin/proxy-key` GET/PUT，显示已设置状态）；Vision（启用开关、provider/model 下拉联动、提示词编辑、保存，`/admin/vision` GET/PUT；缓存统计 + 清除，`/admin/vision-cache/stats` GET + `/admin/vision-cache/clear` POST；非图像模型警告）。

**Requirements:** R2

**Dependencies:** U2

**Files:**
- Create: `admin-ui/src/pages/SettingsPage.tsx`
- Modify: `admin-ui/src/App.tsx`（挂 SettingsPage）

**Approach:**
- Proxy Key 对齐 `proxy-key.ts`（保存空 key=移除；hasKey 状态文案）。
- Vision 对齐 `vision-setting.ts`（providers 来自 config；`selectedModelHasImage()` 警告；缓存命中率/命中/未命中/大小/最大条目展示 + 清除）。

**Behavior boundary:** proxy-key 设置/移除成功 toast + 状态刷新；vision 保存/缓存清除成功 toast；模型非图像时显示警告条。

**Patterns to follow:** 旧 `proxy-key.ts` + `vision-setting.ts`；Appica Card/Switch/Select/Textarea/Field。

**Acceptance scenarios:**
- Happy path: 设置 key→显示已设置；移除→显示未设置；vision 启用+选模型+保存成功；缓存统计展示+清除后刷新。
- Edge case: 无 vision 可用模型时显示"noVisionModel"提示；选非图像模型显示警告。
- Error path: 保存失败 toast 后端 error。

**Verification:** 手动过 proxy-key 与 vision 全流程。

- [ ] U9. **Cutover：移除旧前端 + 交付验证 + 全量回归**

**Goal:** 删除旧 Alpine 前端源码与 `admin-app.js` 交付物，收窄 `package.json` 依赖，更新文档，完成 npm pack + macOS build + 全量测试回归。

**Requirements:** R1, R2, R8, R9

**Dependencies:** U3, U4, U5, U6, U7, U8

**Files:**
- Delete: `src/api/admin/`（整目录：app/store/i18n/types/components）、`src/api/admin-ui.html`、根目录 dev 副本 `admin-app.js`（`admin-ui.html` 副本按 dev 流程确认处置）
- Modify: `src/api/server.ts`（删 `getAdminAppJs`/`handleAdminAppJs`/`admin-app.js` 路由）、`package.json`（移除 `alpinejs`/`chart.js`/`@types/alpinejs`；**保留 `esbuild`**——`build:prod` 仍用它打后端 bundle，只有 admin 打包用途消失）、`.gitignore`（如需调整 admin 副本条目）、`CLAUDE.md`（前端技术栈与构建说明）
- Test: 全量 `npm test` + `tsc --noEmit` + `npm pack` 检查 + `app/scripts/build.sh`

**Approach:**
- 确认新 UI 完整后删旧源码（tsc 不再编译 admin 目录，`include: src/**/*` 自然排除）。
- server.ts 仅保留 `GET /admin`（html）。`GET /admin-app.js` 路由删除。
- 依赖收窄后 `npm install` 重建 lockfile。注意：`esbuild` 必须保留（`build:prod` 依赖），仅移除 `alpinejs`/`chart.js`/`@types/alpinejs`。
- 回归：`npm run build`、`npm test`（115 tests）、`tsc --noEmit`、`npm pack --dry-run` 确认 `dist/api/admin-ui.html` 在包内、`app/scripts/build.sh` 产出 `.app`。

**Behavior boundary:** 移除后 `/admin` 仍返回新 UI；`/admin-app.js` 返回 404（预期，无调用方）；无任何后端行为变化；测试全绿。

**Patterns to follow:** 现有 server.ts 路由数组结构；CLAUDE.md 目录结构/构建章节写法。

**Acceptance scenarios:**
- Happy path: 删旧码后 `npm run build` + `npm test` + `tsc --noEmit` 全过；`/admin` 正常。
- Edge case: `npm pack` 产物含 `dist/api/admin-ui.html` 且不含旧 admin TS 编译物。
- Integration: macOS `app/scripts/build.sh` 成功产出可运行 `.app`（admin 页面可打开）。

**Verification:** 全量命令回归 + pack/build 产物检查 + 手动打开新 UI 点完 6 个 tab。

## 执行交接信息

**依赖与串并行：**
- 串行主干：U1 → U2（外壳是页面前提）。
- U2 完成后，U3/U4/U6/U7/U8 **可并行**（各自独立页面文件 + App.tsx 挂载点不同）；U5 依赖 U4 的 `TestPanelDialog`。
- U9 依赖 U3-U8 全部完成（cutover 前置）。

**冲突面：**
- `App.tsx`（页面挂载）与 `package.json`（依赖）被多个 U-ID 触及 → 若并行执行，挂载改动按 U-ID 顺序合并，避免同时编辑冲突；建议页面 U-ID 串行或分批合并。
- `server.ts` 仅 U1（html 指向）与 U9（删 admin-app 路由）触及，不并行。

**集成验证点：**
- U1 后：构建→serve 端到端通（最高风险点，优先验证）。
- U2 后：导航/语言/主题/端口全通。
- U7 后：SSE + jsoneditor 真实抓包联调（与后端最重交互）。
- U9 后：全量测试 + npm pack + macOS build 总回归。

**执行期遗留：** 见 Open Questions — Deferred to Implementation（Appica 组件 props 细节、recharts 暗色配色、根 dev 副本处置）。

## System-Wide Impact
- **Interaction graph:** 前端 ↔ `/admin/*` 16 端点 + 1 SSE，全部不变；仅消费方从 Alpine 换为 React。
- **Error propagation:** 前端错误处理维持"toast 后端 error 字段"模式，不改后端错误契约。
- **State lifecycle risks:** SSE 连接与 10s 轮询的组件卸载清理（useEffect cleanup）是新代码的正确性重点；jsoneditor 实例需在 props 变化/卸载时 destroy 防泄漏。
- **API surface parity:** 零后端改动；`GET /admin-app.js` 移除（确认无调用方：测试/HTML 均不引用）。
- **Integration coverage:** capture SSE 实时合并（pairId 匹配）、语言服务端同步、端口热设置——这三条是跨前后端场景，需手动联调（单测覆盖不到）。
- **Unchanged invariants:** 全部 `/admin/*` 与 `/v1/*` API 请求/响应形状、SSE 事件格式、locales key、config.yaml schema、token 统计口径——新前端只读消费，不触及。

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Appica 默认主题与旧 UI 视觉差异大，用户不适应 | grill 已明确接受（选择默认主题 + dark）；实现时保留关键信息密度对齐旧版 |
| vite-plugin-singlefile 产物体积/首屏 | admin 为本地工具单页，体积与现状同量级可接受；U1 即验证产物大小 |
| React 19 + Appica 版本兼容 / 依赖解析 | U1 最先验证安装与渲染；锁定兼容版本，lockfile 入库 |
| jsoneditor CDN 运行时加载失败（离线） | JsonEditorPane 降级显示原始文本（U7 error path）；与现状一致（本就 CDN） |
| 并行页面 U-ID 同改 App.tsx 冲突 | 页面 U-ID 串行或分批合并；挂载点改动最小化 |
| 删旧码后 tsc/测试意外引用残留 | U9 全量 `tsc --noEmit` + `npm test` 回归；删除前 grep 确认无引用 |
| macOS app build 漏改 | U1 与 U9 各验证一次 `app/scripts/build.sh` |

## Documentation / Operational Notes
- 更新 `CLAUDE.md`：前端技术栈（React+Appica+Vite）、目录结构（`admin-ui/`）、构建命令（`build:admin`）、dev 方式（Vite :5173 + proxy :9000）。
- 新增 `docs/adr/0001-migrate-admin-ui-to-react-appica.md`（已随 grill 产出）。
- 不写运行时迁移说明（纯前端，无数据迁移、无配置变更）。

## Sources & References
- **Origin document:** [grill 记录](../grills/2026-07-25-appica-admin-ui-grill.md)、[ADR-0001](../adr/0001-migrate-admin-ui-to-react-appica.md)
- Related code: `src/api/admin-ui.html`、`src/api/admin/`、`src/api/server.ts`、`app/scripts/build.sh`、`package.json`、`tsconfig.json`
- External docs: <https://appica.dev/llms-full.txt>（离线缓存 `/tmp/appica-llms-full.txt`）、<https://recharts.org>、<https://vitejs.dev>、vite-plugin-singlefile
