---
title: fix: macOS App 功能缺陷修复与未迁移功能补齐
type: fix
status: active
date: 2026-05-29
---

# fix: macOS App 功能缺陷修复与未迁移功能补齐

## Overview

修复 macOS 控制台 4 个问题：拉取模型无响应、适配器列表不显示 URL、补齐 admin UI 已有但 macOS App 缺失的 5 项功能、修复日志模块侧边栏遮盖问题。

---

## Problem Frame

用户反馈 macOS App 存在以下 4 类问题：

1. **拉取模型无反应**：Provider 编辑表单中点击"拉取模型"按钮后无响应。根因是 `APIClient.pullModels()` 未向 `/admin/providers/{name}/pull-models` 发送 `api_key`/`api_base` 请求体，后端因缺少必填字段返回 400。
2. **适配器列表不显示 URL**：Adapter 行仅展示名称、类型、映射数，用户无法看到适配器的虚拟端点地址（如 `/{name}/v1/messages`）。
3. **admin UI 已有但 macOS App 缺失的功能**：经全面对比，以下 5 项 admin UI 功能在 macOS App 中缺失或部分缺失：端口设置、代理密钥管理、配置重载、语言切换、日志级别显示与设置。
4. **日志模块左侧被侧边栏遮盖**：缩小窗口时 NavigationSplitView 的 sidebar 会覆盖 LogsView 的内容区域（过滤栏和日志列表被遮挡）。

---

## Requirements Trace

- R1. Provider 表单中点击"拉取模型"后能成功获取远程模型列表
- R2. 适配器列表每行显示其虚拟端点 URL
- R3. macOS App 具备端口设置入口，用户可查看和修改代理端口
- R4. macOS App 具备代理密钥管理入口，用户可查看、设置和移除 proxy_key
- R5. macOS App 具备配置重载入口（控制台内修改配置后无需重启）
- R6. macOS App 具备语言切换入口（中文/英文）
- R7. 日志页面上方显示当前日志级别并提供切换控件
- R8. 缩小控制台窗口时日志内容区不被侧边栏遮盖

---

## Scope Boundaries

- 不涉及后端 API 的修改——所有后端端点已就绪，仅需补齐前端调用
- 不涉及菜单栏 (MenuBarController) 的修改——菜单栏重载在 001 号计划中已覆盖
- 不涉及抓包 (Capture) 模块——该模块功能已完整
- 不涉及仪表盘 (Dashboard) 和测试面板 (TestPanel)——功能已完整

---

## Context & Research

### Relevant Code and Patterns

**SwiftUI 架构约定：**
- 每个 View 有自己的 `@State private var viewModel = XxxViewModel()`，ViewModel 用 `@Observable` + `@MainActor` 宏
- ViewModel 通过 `private let api = APIClient()` 调用 API
- 跨 View 通信通过 `@Environment(TestCoordinator.self)` 或 NotificationCenter 发 `configDidChange`
- Sheet 用 `.sheet(isPresented:)` modifier 弹出表单

**APIClient 模式：**
- 每个 API 方法返回对应 Model 类型或 Bool
- API Key 敏感字段的 GET 返回 `"***"` 掩码，SET 时若传 `"***"` 则保持原值不变
- 端口存储在 `UserDefaults.standard.integer(forKey: "llm-proxy-port")`

**文件路径模式：**
- Views: `app/Sources/Views/XxxView.swift`
- ViewModels: `app/Sources/ViewModels/XxxViewModel.swift`
- API: `app/Sources/APIClient.swift`
- Models: `app/Sources/Models.swift`
- Tests: `app/Tests/LLMProxyTests/XxxTests.swift`

### Relevant API Endpoints

| 端点 | 方法 | macOS App 支持 |
|------|------|----------------|
| `/admin/port` | GET/PUT | APIClient ✅ / UI ❌ |
| `/admin/proxy-key` | GET/PUT | APIClient ❌ / UI ❌ |
| `/admin/config/reload` | POST | APIClient ✅ / UI ❌ |
| `/admin/locale` | GET/PUT | APIClient ✅ / UI ❌ |
| `/admin/log-level` | GET/PUT | APIClient ✅ / UI ❌ |
| `/admin/providers/{name}/pull-models` | POST | APIClient ⚠️ (缺 body) / UI ✅ |

---

## Key Technical Decisions

- **端口/密钥/语言/日志级别：统一放在侧边栏底部**：参考 admin UI 将这些"设置类"功能放在侧边栏底部而非独立 tab，避免侧边栏过长。使用 `.safeAreaInset(edge: .bottom)` 放置设置区域。
- **日志级别放在 LogsView 过滤栏**：将日志级别显示和切换放在日志页面的过滤栏右侧，与 Admin UI 的放置位置一致。
- **适配器 URL 显示在行内**：在适配器行中显示 `http://localhost:{port}/{name}/v1/{type-endpoint}` 格式的虚拟端点 URL，端口从 `APIClient.storedPort()` 读取。
- **pullModels 修复：传递 type, api_key, api_base**：参考 Admin UI 的 `openPullModels()` 方法，在 POST body 中发送 `{ type, api_key, api_base }`。同时设置 `Content-Type: application/json` 头。
- **侧边栏遮盖修复：调整 NavigationSplitView 行为**：在 ConsoleRootView 中为 NavigationSplitView 添加 detail 侧最小宽度约束，防止 sidebar 无限挤压 detail。

---

## Open Questions

### Deferred to Implementation

- 侧边栏底部设置区的具体 UI 布局（Section header + 按钮，还是独立 Sheet）——取决于实际视觉效果
- 是否需要为适配器 URL 添加点击复制功能——可视情况决定

---

## Implementation Units

- [x] U1. **修复拉取模型 API 调用缺少请求体**

**Goal:** 使 `APIClient.pullModels()` 正确发送 `type`, `api_key`, `api_base` 到后端 `/admin/providers/{name}/pull-models`

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `app/Sources/APIClient.swift`
- Test: `app/Tests/LLMProxyTests/APIClientTests.swift`

**Approach:**
- 修改 `pullModels(providerName:)` 签名，增加 `type`, `apiKey`, `apiBase` 参数
- 在 POST 请求中设置 `Content-Type: application/json` 头
- 请求体发送 `{ type, api_key, apiBase }`（仅发送非空值）
- 同步更新 `ProvidersViewModel.pullModels()` 调用处，传入 `formData.type`, `formData.apiKey`, `formData.apiBase`

**Patterns to follow:**
- `testProvider(modelId:provider:apiKey:apiBase:type:)` 的参数传递模式
- Admin UI `openPullModels()` 的请求体结构

**Test scenarios:**
- Happy path: 传入有效的 type + apiKey，应返回模型列表
- Error path: 传入空 apiKey（编辑模式），后端使用 provider 已存储的 key，需验证请求体不传 api_key 字段
- Error path: 后端返回 400 时，pullModelsError 应正确填充

**Verification:**
- 在 Provider 编辑表单中点击"拉取模型"，能成功加载远程模型列表
- 新 provider 和已有 provider 均能正常拉取

---

- [x] U2. **适配器列表显示虚拟端点 URL**

**Goal:** 适配器行中显示该适配器的虚拟端点 URL

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `app/Sources/Views/AdaptersView.swift`
- Test: `app/Tests/LLMProxyTests/AdaptersViewModelTests.swift`

**Approach:**
- 在 `adapterRow(_:)` 中新增一行显示 URL，格式为 `http://127.0.0.1:{port}/{name}/v1/{endpoint}`
- 端口从 `APIClient.storedPort()` 获取（AdaptersView 可持有 `@State private var port` 并在 `onAppear` 时读取）
- endpoint 根据 adapter.type 映射：anthropic→messages, openai→chat/completions, openai-responses→responses
- URL 使用 `.font(.caption.monospaced())` 样式，颜色 `secondary`，支持 `.textSelection(.enabled)`
- 可选：添加点击复制按钮（deferred to implementation）

**Patterns to follow:**
- `adapterRow` 已有 `typeBadge` 等子组件模式

**Test scenarios:**
- Happy path: openai 类型适配器显示 `http://127.0.0.1:9000/{name}/v1/chat/completions`
- Edge case: anthropic 类型显示 `http://127.0.0.1:9000/{name}/v1/messages`
- Edge case: 自定义端口（非 9000）时 URL 显示正确端口号

**Verification:**
- 适配器列表中每行可见虚拟端点 URL
- URL 正确反映适配器类型和端口号

---

- [x] U3. **补齐侧边栏设置区：端口、密钥、语言、配置重载**

**Goal:** 在 macOS App 侧边栏底部新增设置区域，包含端口设置、代理密钥管理、语言切换和配置重载入口

**Requirements:** R3, R4, R5, R6

**Dependencies:** None

**Files:**
- Create: `app/Sources/Views/SettingsView.swift` — 侧边栏底部设置区视图
- Modify: `app/Sources/ConsoleRootView.swift` — 在 sidebar 的 safeAreaInset(edge: .bottom) 中嵌入 SettingsView
- Modify: `app/Sources/APIClient.swift` — 新增 `fetchProxyKey()` 和 `setProxyKey(_:)` 方法
- Test: `app/Tests/LLMProxyTests/APIClientTests.swift`

**Approach:**

创建 `SettingsView` 组件，包含 4 个设置项：

1. **端口设置**：显示当前端口，点击弹出 Sheet 可修改（复用 APIClient 已有 `fetchPort()`/`setPort()`）
   - Sheet 内容：TextField 输入端口号 + 保存按钮
   - 保存成功后更新 APIClient baseURL 并发送 `.configDidChange` 通知

2. **代理密钥**：显示"已设置/未设置"状态，点击弹出 Sheet 可设置或移除
   - 新增 `APIClient.fetchProxyKey()` → GET `/admin/proxy-key` 返回 `{ set: Bool }` 
   - 新增 `APIClient.setProxyKey(_:)` → PUT `/admin/proxy-key` 
   - Sheet 内容：SecureField 输入密钥 + 设置按钮 + 移除按钮

3. **语言切换**：Segmented picker 切换 zh/en
   - 初始化时调用 `fetchLocale()` 获取当前语言
   - 切换时调用 `setLocale()` 并更新系统语言

4. **配置重载**：一个按钮，点击调用 `APIClient.reloadConfig()` 并刷新
   - 成功后发送 `.configDidChange` 通知

**Patterns to follow:**
- Admin UI `port-setting.ts` / `proxy-key.ts` 的交互逻辑
- SwiftUI Sheet 模式参考 `ProviderFormView`

**Test scenarios:**
- Happy path: 端口修改输入 8080 并保存，验证 fetchPort 返回新值
- Happy path: 设置代理密钥，验证 fetchProxyKey 返回 `set: true`
- Happy path: 移除代理密钥，验证 fetchProxyKey 返回 `set: false`
- Happy path: 切换语言为 en，验证 fetchLocale 返回 "en"
- Happy path: 点击配置重载，服务端配置刷新成功
- Edge case: 输入无效端口号（0 或 99999），显示错误提示

**Verification:**
- 侧边栏底部可见端口、密钥、语言和重载 4 项设置
- 各设置项可正常交互并生效

---

- [x] U4. **日志页面添加日志级别显示与切换**

**Goal:** 在 LogsView 过滤栏中显示当前日志级别并提供切换控件

**Requirements:** R7

**Dependencies:** None

**Files:**
- Modify: `app/Sources/Views/LogsView.swift` — 在 filterBar 中添加日志级别显示和切换
- Modify: `app/Sources/ViewModels/LogsViewModel.swift` — 新增日志级别相关状态和方法

**Approach:**
- 在 LogsView 的 `filterBar` 右侧（搜索框旁边）添加日志级别显示
- 初始加载时调用 `APIClient.fetchLogLevel()` 获取当前级别
- 使用 Picker（segmented 或 menu 风格）切换：debug / info / warn / error
- 选择时调用 `APIClient.setLogLevel(_:)` 并更新本地状态，显示 toast

**Patterns to follow:**
- LogsView 中已有的 levelFilter Picker 模式（segmented .pickerStyle）
- Admin UI `logsPage.setLogLevel()` 模式

**Test scenarios:**
- Happy path: 初始加载显示当前日志级别（如 "info"）
- Happy path: 切换为 "debug"，验证 APIClient.setLogLevel 被调用且 UI 更新
- Error path: 切换失败时显示错误提示

**Verification:**
- 日志页面过滤栏可见当前日志级别
- 可成功切换日志级别并生效

---

- [x] U5. **修复侧边栏遮盖内容区问题**

**Goal:** 缩小控制台窗口时，日志等详情内容区不被侧边栏遮盖

**Requirements:** R8

**Dependencies:** None

**Files:**
- Modify: `app/Sources/ConsoleRootView.swift`

**Approach:**
- 为 NavigationSplitView 的 detail 侧添加 `.frame(minWidth: 400)` 确保内容区不会无限收窄
- 在 detail 的 content 上添加 `.layoutPriority(1)` 确保优先保留内容区空间
- 当前已设置 `.navigationSplitViewStyle(.balanced)`，检查是否需要改为其他策略
- 可选：当窗口过窄时自动折叠 sidebar（macOS 14+ 支持 `.navigationSplitViewColumnWidth` 配合 `NavigationSplitViewVisibility`）

**Patterns to follow:**
- 当前 ConsoleRootView 已有的 `.navigationSplitViewColumnWidth(min: 160, ideal: 180, max: 220)` 模式
- 标准 macOS NavigationSplitView 自适应行为

**Test scenarios:**
- Happy path: 窗口宽度 800px 时 sidebar 和 detail 正常并排显示
- Edge case: 窗口缩小到 500px 时，detail 最小保持 400px，sidebar 宽度保持在 min 160px
- Edge case: 窗口缩小到 300px 时，sidebar 应自动折叠而非遮盖 detail

**Verification:**
- 在任意 tab（尤其日志和抓包等复杂布局）缩小窗口，内容区不被 sidebar 遮盖
- 窗口恢复到正常大小时布局正确还原

---

## System-Wide Impact

- **Interaction graph:** SettingsView 修改端口/密钥/语言后会发送 `.configDidChange` 通知，已有监听方（DashboardView, ProvidersView 等）会收到并刷新
- **Error propagation:** API 调用失败时统一通过 ViewModel 的 errorMessage 或 toast 反馈
- **State lifecycle risks:** 端口修改后 APIClient 更新 baseURL，但当前正在进行的请求不会受影响（每个请求独立构建 URL）
- **API surface parity:** 新增的 `fetchProxyKey`/`setProxyKey` 需与 `/admin/proxy-key` 端点字段对齐（`key` 字段）
- **Unchanged invariants:** 不修改已有 ViewModel 的核心数据结构，仅新增字段和方法；不影响后端 API 路由

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 侧边栏底部 SettingsView 导致侧边栏过长 | SettingsView 采用折叠式设计（DisclosureGroup），默认收起到一行 |
| pullModels 修改后需同步 ProvidersViewModel 调用处 | 已有清晰的调用链，修改参数签名后编译器会直接报错遗漏点 |
| APIClient 新增方法需与后端字段对齐 | 参考已有方法（如 fetchPort）和后端 handler 代码确认字段名 |

---

## Documentation / Operational Notes

- 无需更新外部文档——这些是 UI 层面的修复和补齐
- 端口修改后需重启服务才能生效（已在 UI 中提示），与 admin UI 行为一致

---

## Sources & References

- Related plan: `docs/plans/2026-05-29-001-fix-console-issues-plan.md` — 侧边栏修复部分与此计划 U5 互补
- Related plan: `docs/plans/2026-05-28-001-feat-macos-native-admin-console-plan.md` — macOS 控制台初始实现
- Admin UI components: `src/api/admin/components/` — 功能参考源
- Backend handlers: `src/api/handlers/base.ts`, `src/api/handlers/model-handlers.ts` — API 契约定义
- macOS app source: `app/Sources/` — 目标实现位置
