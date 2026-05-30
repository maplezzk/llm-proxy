---
title: fix: 控制台 v1 修复与优化
type: fix
status: active
date: 2026-05-29
---

# fix: 控制台 v1 修复与优化

## Overview

修复 macOS 控制台的 6 个问题：侧边栏遮挡、测试面板自动填充、适配器测试报错、测试模型指定、测试面板改为独立 tab、菜单栏自动重载。

---

## Requirements Trace

- R1. 侧边栏不再遮盖右侧内容区
- R2. 测试面板打开时自动填充选中 Provider 的 apiKey/apiBase/type/models
- R3. 适配器测试修复字段名对齐（adapterName + modelId）
- R4. 测试面板支持选择/输入模型
- R5. 测试面板改为侧边栏独立 tab
- R6. 控制台内修改配置后菜单栏自动重载

---

## Implementation Units

- [ ] U1. **修复侧边栏遮挡内容区**

**Files:** `app/Sources/ConsoleRootView.swift`

**Approach:** NavigationSplitView 添加 `.navigationSplitViewStyle(.balanced)` 确保 sidebar 不覆盖 detail

---

- [ ] U2. **修复适配器测试 -1011 错误**

**Files:** `app/Sources/APIClient.swift`

**Approach:** testAdapter body 改为 `["adapterName": name, "modelId": firstModelId]`，对齐后端 handleTestAdapter 期望字段。需要传入 adapter 的第一个 modelId。

---

- [ ] U3. **测试面板改为侧边栏 tab + 自动填充 + 支持 Provider/Adapter 两种测试**

**Files:**
- Modify: `app/Sources/ConsoleRootView.swift` — 新增 test tab
- Modify: `app/Sources/Views/TestPanelView.swift` — 重写为完整 tab 视图
- Modify: `app/Sources/Views/ProvidersView.swift` — 测试按钮跳转到测试 tab
- Modify: `app/Sources/Views/AdaptersView.swift` — 测试按钮跳转到测试 tab

**Approach:**
- 控制台侧边栏新增"测试"tab
- TestPanelView 改为全页面视图（非 Sheet）
- 通过 @Environment 或直接传参，从 Provider/Adapter 行跳转时自动填充
- 支持两种模式：Provider 测试（手填所有参数）和 Adapter 测试（选 adapter + model）

---

- [ ] U4. **菜单栏配置变更后自动重载**

**Files:** `app/Sources/MenuBarController.swift`

**Approach:** 控制台窗口关闭时（或配置变更后），触发菜单栏 rebuildMenu()。通过 NotificationCenter 发通知，MenuBarController 监听并 rebuildMenu()。

---

## Open Questions

### Deferred to Implementation

- 测试 tab 如何区分 Provider 模式和 Adapter 模式（Picker 切换 或 两个子 tab）
- 菜单栏重载时机（窗口关闭时 vs 每次 save 后立即）
