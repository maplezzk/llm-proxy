# macOS 菜单栏设计文档

> 适用范围：llm-proxy macOS App（`app/`）的菜单栏与状态卡 UI。参考对象：CodexBar（技术方案）、ClashMac（视觉语言）。

---

## 一、技术选型：NSMenu + SwiftUI 卡片（非 NSPopover）

菜单栏采用 **CodexBar 同款方案**：仍是系统 `NSMenu`，但关键菜单项通过 `NSMenuItem.view = NSHostingView<...>` 内嵌 SwiftUI 卡片。

**决策理由：**

- 保留原生菜单的全部行为：键盘导航、快捷键、子菜单悬停展开、系统滚动
- 视觉可完全自定义（卡片、按钮、图标）
- NSPopover 面板方案布局更自由，但失去原生菜单手感，实现量更大，被否决

**参考实现**（CodexBar 源码）：`StatusItemController+MenuCardItems.swift` — `item.view = NSHostingView`，`item.isEnabled = true` 保证视图内控件可交互；带子菜单的卡片项需设置 `target/action`（noOp）才能悬停展开子菜单。

**关键文件：**

| 文件 | 职责 |
|------|------|
| `app/Sources/MenuCardViews.swift` | 全部卡片视图：状态卡、适配器头、映射行、提示行、`CardButton`、`makeAdapterCardModels()` 纯函数 |
| `app/Sources/MenuBarController.swift` | `rebuildMenu()` 组装菜单、`makeCardItem()` 包装 hosting view、`buildMappingSubMenu()` 模型子菜单、`coloredIcon()` 彩色图标 |
| `app/Tests/LLMProxyTests/MenuCardSnapshotTests.swift` | 离屏渲染快照工具（见「五、验证」） |

---

## 二、菜单信息架构

自上而下，**高频操作固定在顶部一屏可达，模型列表固定最底部**（长度不限，系统菜单自动滚动，不再挤压操作区）：

```
┌ 状态卡 ─────────────────────────┐
│ [icon] LLM Proxy        ● 运行中 │  ← 品牌头行（ClashMac 风格）
│ 今日 100.9M · 缓存命中 95.6%   :9000 │
│ [ 停止 ]  [ 重启 ]  [ 重载 ]      │  ← 服务控制组（重载归属此处）
└──────────────────────────────────┘
─────
⿺ 打开控制台 ⌘O ｜ 🌐 打开 Web UI     ← 界面组
─────
⚙ 设置 › ｜ ⓘ 版本 x.y.z · 检查更新…  ← 设置收纳：端口/日志级别/语言/日志目录
─────
✕ 退出 LLMProxy ⌘Q
─────
⚡ 适配器头（名称，不可点）
  映射行   当前 provider/model    ›  ← 悬停即展开模型子菜单，零点击
```

**分区原则（用户决策，勿轻易改动）：**

1. **模型切换必须悬停零点击**——映射行悬停自动展开子菜单，不允许需要点击展开、不允许多级嵌套
2. 重载配置属于服务生命周期操作，与停止/重启同组（状态卡按钮）
3. 设置类（端口/日志级别/语言/日志目录）收纳进「设置」子菜单，中间区保持精简（2/2/1 节奏）
4. 版本号与检查更新合并一行，点击即检查

---

## 三、视觉语言（对齐 ClashMac）

1. **彩色图标**：所有菜单项用彩色 SF Symbol，`NSImage.SymbolConfiguration(paletteColors:)` + `isTemplate = false`，高亮时保持彩色。配色：控制台蓝 / Web UI 青 / 端口靛 / 日志级别橙 / 语言紫 / 日志目录黄 / 设置灰 / 版本绿 / 退出红
2. **品牌头行**：状态卡顶部 = App 图标（`NSApp.applicationIconImage`）+ 名称 + 状态点
3. **语义色按钮**：`CardButton` 使用 tinted 浅底 + 同色文字（停止红 / 重启橙 / 重载蓝 / 启动绿），避免 AppKit `.bordered` 在菜单里的厚重灰盒
4. **宽度对齐**：`MenuCardMetrics.width = 340`。NSMenu 宽度由最宽项决定，卡片宽度必须 ≥ 原生项（图标+文案+快捷键）自然宽度，否则卡片右侧出现空隙
5. **映射行悬停高亮**：`onHover` + `selectedContentBackgroundColor` 圆角底 + 白字，自带 `chevron.right` 指示子菜单（系统不会为自定义 view 画子菜单箭头）

---

## 四、踩坑记录

### 4.1 NSPopUpButton 内嵌 NSMenu 不可交互 ❌

之前误解：以为 `NSPopUpButton`（`NSViewRepresentable`）放进菜单项 view 就能点击弹出选项。实际上 NSMenu 的事件追踪循环中点击不响应，**无法切换**（真机验证失败，快照渲染发现不了）。

正确做法：自定义 view 菜单项 + 真正的 `NSMenu` 子菜单（`item.submenu`），悬停由系统展开。菜单内要交互只能用简单 `Button`（启停按钮已验证可用），复杂控件（popUp、textField）不要放。

### 4.2 SwiftUI Text 插值数字会被 locale 加千分位

`Text(":\(port)")` 渲染成 `:9,000`（LocalizedStringKey 插值按 locale 格式化数字）。涉及端口号、ID 等场景必须用 `Text(verbatim:)`。

### 4.3 卡片与菜单宽度不一致出现右缝

菜单被带快捷键的原生项撑宽后，固定 300pt 的卡片右侧露出空隙。卡片宽度需覆盖最宽原生项（当前 340pt）。

### 4.4 状态卡按钮标签截断

三按钮等宽平分时英文长标签（"Restart Service"）被截断。按钮用短标签 key（`menu.btn.*`：Stop/Restart/Reload），与菜单项长标签（`action.*`）分开。

---

## 五、验证方式

**离屏快照**（无需任何权限）：XCTest 内 `NSHostingView` + `bitmapImageRepForCachingDisplay` 渲染 PNG 到 /tmp，支持亮/暗两色。工具见 `MenuCardSnapshotTests.swift`，改动卡片后跑：

```bash
cd app && swift test --filter MenuCardSnapshotTests
```

**局限**：快照只能验证「长相」，验证不了交互（4.1 的 bug 因此漏网过一次）。交互类改动必须真机验收。osascript 点击菜单栏和 screencapture 需要辅助功能/屏幕录制权限，默认不可用。

**常规验证**：`swift build` + `swift test`（全量）；打包 `app/scripts/build.sh`。

---

## 六、Console 窗口 Dashboard

与菜单栏同批重设计：hero 状态卡（`DashboardHeroView`，在线/离线着色 + 概览摘要）+ 今日用量紧凑指标条（`TodayUsageStripView`，总计/输入/输出/命中率），均抽为独立组件便于快照测试；趋势图、分维度图、存储卡逻辑不变。
