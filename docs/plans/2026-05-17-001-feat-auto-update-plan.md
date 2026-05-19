---
title: feat: Add in-app auto-update for macOS app
type: feat
status: active
date: 2026-05-17
---

# feat: 应用内自动更新功能

## Overview

为 LLMProxy macOS 桌面应用增加应用内自动更新能力。用户可通过菜单栏检查更新、查看当前版本、下载并安装最新版本，无需手动去 GitHub Release 页面下载 DMG 或等待 Homebrew 更新。

---

## Problem Frame

当前 LLMProxy 的 macOS 应用发布流程：
1. release-please 创建 GitHub Release
2. CI 自动构建 DMG 并上传到 Release
3. CI 自动更新 Homebrew cask

但用户侧缺少应用内更新感知：
- 用户不知道有新版本可用
- 用户必须手动访问 GitHub 或运行 `brew upgrade llm-proxy`
- 没有版本号显示在 UI 中（Info.plist 中 CFBundleShortVersionString 硬编码为 `1.0`）

本功能让用户直接在菜单栏中一键检查、下载、安装更新。

---

## Requirements Trace

- R1. 菜单栏显示当前版本号
- R2. 用户可主动检查更新（菜单项 "Check for Updates..."）
- R3. 后台自动检查更新，有新版本时 UI 给出提示（badge/菜单标记）
- R4. 用户可一键下载并安装更新
- R5. 安装过程引导用户：下载 → 挂载 DMG → 替换 .app → 重启
- R6. 支持中文/英文双语

---

## Scope Boundaries

- 仅支持 macOS 原生应用（Swift），不涉及 CLI 版本的自更新
- 更新源仅限 GitHub Releases API（暂不支持其他分发渠道）
- 暂不支持静默后台自动安装（需要用户确认）
- 暂不支持增量更新 / delta 更新，始终下载完整 DMG

---

## Context & Research

### Relevant Code and Patterns

- **菜单构建**: `app/Sources/MenuBarController.swift` — `rebuildMenu()` 方法是所有菜单项的入口
- **网络请求**: `app/Sources/APIClient.swift` — 已有 HTTP 客户端模式，可参照 `fetchHealth()`/`fetchConfig()` 风格新增 API 方法
- **版本来源**: 当前 Info.plist 硬编码，需要改为从 `package.json` 或构建时注入
- **本地化**: `app/Sources/en.lproj/Localizable.strings` 和 `zh.lproj/Localizable.strings`
- **构建脚本**: `app/scripts/build.sh` — 需要在构建时将真实版本号写入 Info.plist
- **DMG 发布**: `.github/workflows/release.yml` — DMG 命名格式 `LLMProxy-v{VERSION}.dmg`

### External References

- GitHub Releases API: `GET /repos/maplezzk/llm-proxy/releases/latest`
  - Response 中 `tag_name` 为版本标签（如 `v0.12.3`）
  - `assets` 数组中包含 DMG 文件的 `browser_download_url`
- 版本比较：语义化版本（SemVer）

---

## Key Technical Decisions

- **版本号注入**: 构建时从 `package.json` 读取版本，写入 `Info.plist` 的 `CFBundleShortVersionString`，不再硬编码 `1.0`
- **更新检查周期**: 应用启动时自动检查一次，之后每 24 小时自动检查一次（非强制），菜单中始终提供手动检查入口
- **下载方式**: 使用 `URLSession` 下载 DMG 到 `~/Library/Application Support/LLMProxy/Updates/` 目录
- **安装方式**: 下载完成后提示用户，用户确认后打开 DMG（`NSWorkspace.shared.open`），引导用户拖拽安装
- **#1 对换方案**: 静默替换运行中 .app（`/Applications/LLMProxy.app`），但需要处理正在运行的进程替换问题，复杂度高，暂不采用

---

## Implementation Units

- [ ] U1. **版本号注入构建流程**

**Goal:** 构建时将真实版本号从 `package.json` 写入 `Info.plist` 和 Swift 代码中，使应用能获取当前版本

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `app/scripts/build.sh`
- Modify: `app/Sources/main.swift` 或新增 `app/Sources/Version.swift`
- Test: N/A（构建流程改动，手动验证）

**Approach:**
- 在 `build.sh` 的 Info.plist 生成部分，从 `package.json` 读取 version 并写入 `CFBundleShortVersionString`（`<string>0.12.3</string>`）
- 新增 `app/Sources/Version.swift`，编译时读取 Bundle 中的 `CFBundleShortVersionString`
- 确保调试模式（`swift run`）也能获取版本号（回退到读取 `package.json`）

**Test scenarios:**
- 构建后 `.app` 的 Info.plist 中 `CFBundleShortVersionString` 等于 `package.json` 中的版本
- Swift 代码中 `currentVersion()` 返回正确字符串
- 调试模式（swift run）下版本号也能正确获取

**Verification:**
- 运行 `bash app/scripts/build.sh`，检查生成的 `.app/Contents/Info.plist` 包含正确版本号
- Swift 编译运行后 `currentVersion()` 返回格式如 `"0.12.3"`

---

- [ ] U2. **GitHub 版本检查 API 层**

**Goal:** 新增网络 API 客户端方法，查询 GitHub Releases 获取最新版本号和下载 URL

**Requirements:** R2, R3

**Dependencies:** None

**Files:**
- Create: `app/Sources/UpdateChecker.swift`
- Test: N/A（依赖网络，手动测试）

**Approach:**
- 新增 `UpdateChecker` 类，负责与 GitHub API 交互
- 方法 `checkForUpdates() async throws -> UpdateInfo?`
  - 请求 `https://api.github.com/repos/maplezzk/llm-proxy/releases/latest`
  - 解析 JSON，提取 `tag_name`（去除 `v` 前缀后得到版本号）
  - 在 `assets` 中查找文件名匹配 `LLMProxy-v{version}.dmg` 的 `browser_download_url`
- 方法 `compareVersions(_ current: String, _ latest: String) -> Bool` 语义化版本比较
- 定义 `UpdateInfo` 结构体：`version: String`, `downloadURL: URL`, `releaseNotes: String?`

**模型定义:**

```swift
struct UpdateInfo {
    let version: String
    let downloadURL: URL
    let releaseNotes: String?
    let releaseDate: Date?
}

struct GitHubRelease: Codable {
    let tagName: String
    let body: String?
    let publishedAt: String?
    let assets: [GitHubAsset]
    
    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case body
        case publishedAt = "published_at"
        case assets
    }
}

struct GitHubAsset: Codable {
    let name: String
    let browserDownloadURL: String
    let contentType: String
    
    enum CodingKeys: String, CodingKey {
        case name
        case browserDownloadURL = "browser_download_url"
        case contentType = "content_type"
    }
}
```

**Test scenarios:**
- 有更新的情况：GitHub 返回 `tag_name: v0.13.0`，当前版本 `0.12.3`，返回 `true`
- 没有更新的情况：GitHub 返回 `tag_name: v0.12.3`，当前版本 `0.12.3`，返回 `false`
- 网络不可用时优雅处理（抛或返回 nil）
- DMG asset 不存在时的降级处理

**Verification:**
- 在 Playground 或实际运行中调用 `UpdateChecker().checkForUpdates()` 能正确解析 Release 信息

---

- [ ] U3. **下载与安装逻辑**

**Goal:** 实现 DMG 下载到本地临时目录，并提供安装引导

**Requirements:** R4, R5

**Dependencies:** U2

**Files:**
- Modify: `app/Sources/UpdateChecker.swift`（追加下载功能）
- Test: N/A（手动测试）

**Approach:**
- 新增 `downloadUpdate(_ info: UpdateInfo) async throws -> URL` 方法
  - 使用 `URLSession` 下载 DMG 到 `~/Library/Application Support/LLMProxy/Updates/` 目录
  - 支持下载进度回调（可选，后续可增强 UI）
  - 下载完成后返回本地文件 URL
- 新增 `installUpdate(at localURL: URL)` 方法
  - 弹出确认对话框："LLMProxy v{newVersion} 已下载，是否立即安装？"\n LLMProxy 将退出，请将新版本拖入 Applications 文件夹替换旧版本。"
  - 用户确认后：
    1. 退出后台 llm-proxy 服务（调用当前 `runCLI("stop")`）
    2. 在 Finder 中打开 DMG（`NSWorkspace.shared.open(localURL)`）
    3. 退出应用（`NSApp.terminate(nil)`）
- 添加安装后自动清理：应用下次启动时检查并清理 `Updates/` 目录中旧的 DMG 文件

**Test scenarios:**
- 下载成功 → 文件保存到指定目录，文件名正确
- 下载中断/网络失败 → 抛出错误，UI 显示提示
- 用户取消安装 → DMG 保留在本地，不清除
- 磁盘空间不足 → 优雅错误提示
- 应用启动时清理旧 DMG 文件

**Verification:**
- 手动触发下载，检查 `~/Library/Application Support/LLMProxy/Updates/` 目录下载了正确的 DMG
- 双击打开的 DMG 正确定位到 Finder

---

- [ ] U4. **菜单栏 UI 集成**

**Goal:** 在菜单栏中添加更新相关菜单项，包括版本显示、检查更新、更新可用提示

**Requirements:** R1, R2, R3, R4

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `app/Sources/MenuBarController.swift`（菜单构建 + 更新逻辑）
- Modify: `app/Sources/en.lproj/Localizable.strings`（新增英文 i18n 键）
- Modify: `app/Sources/zh.lproj/Localizable.strings`（新增中文 i18n 键）
- Test: N/A（UI 改动，手动验证）

**Approach:**
- 在 `MenuBarController` 中集成更新检查逻辑
- `buildMenu()` 在"工具区"（Admin UI / 日志目录）和语言切换之间增加更新区：

  ```
  ---
  Version 0.12.3
  Check for Updates...
  (有更新时显示:) ⬆ Update Available: v0.13.0
  ---
  ```

- 增加 `@objc checkForUpdates()` 方法
  - 手动触发：立即查询 GitHub，有更新时弹窗提示下载，无更新时弹窗"已是最新版本"
- 增加后台自动检查机制：
  - `applicationDidFinishLaunching` 时异步调用一次
  - 使用 `UserDefaults` 记录上次检查时间，24 小时间隔
  - 有新版本时在菜单中标记（菜单项变为橙色/添加 badge）
  - 不弹打扰式通知，仅在菜单中标记
- 新增 `downloadUpdateAction()` 执行下载流程
- 增加 `DownloadProgress` 状态管理，可选显示下载进度（简化版：下载期间禁用按钮，完成后显示提示）

**新增 i18n keys:**
```
EN:
"menu.version" = "Version %@";
"action.checkForUpdates" = "Check for Updates...";
"menu.updatesAvailable" = "⬆ Update Available: v%@";
"update.noUpdates" = "LLMProxy is up to date (v%@)";
"update.available" = "A new version is available!";
"update.downloadConfirm" = "LLMProxy v%@ is ready to download. Proceed?";
"update.installPrompt" = "LLMProxy v%@ has been downloaded. LLMProxy will now quit. Please drag the new app into Applications folder to complete the update.";
"update.downloading" = "Downloading update...";
"update.downloadComplete" = "Download complete!";
"update.downloadFailed" = "Download failed: %@";
"update.checkFailed" = "Failed to check for updates: %@";

ZH:
"menu.version" = "版本 %@";
"action.checkForUpdates" = "检查更新...";
"menu.updatesAvailable" = "⬆ 新版本可用: v%@";
"update.noUpdates" = "LLMProxy 已是最新版本 (v%@)";
"update.available" = "有新版本可用！";
"update.downloadConfirm" = "LLMProxy v%@ 待下载，是否继续？";
"update.installPrompt" = "LLMProxy v%@ 已下载完成。LLMProxy 即将退出，请将新应用拖入 Applications 文件夹完成更新。";
"update.downloading" = "正在下载更新...";
"update.downloadComplete" = "下载完成！";
"update.downloadFailed" = "下载失败: %@";
"update.checkFailed" = "检查更新失败: %@";
```

**Test scenarios:**
- 菜单栏显示当前版本号
- "Check for Updates" 菜单项可点击，触发网络请求
- 无更新时弹出"已是最新版本"
- 有更新时弹出确认下载对话框
- 下载完成后弹出安装引导对话框
- 应用退出时服务正常停止
- 中英文切换后更新相关文案正确

**Verification:**
- 手动点击所有更新相关菜单项，校验每个弹窗/提示的内容和交互
- 切换语言后菜单项正确显示对应语言

---

- [ ] U5. **构建脚本完善**

**Goal:** 确保 `build.sh` 正确注入版本号到 Info.plist，并增加构建相关的辅助脚本

**Requirements:** R1

**Dependencies:** U1

**Files:**
- Modify: `app/scripts/build.sh`

**Approach:**
- 在 Info.plist 生成部分，从 `package.json` 读取版本：
  ```bash
  VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
  ```
- Info.plist 中写入：
  ```xml
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$VERSION</string>
  ```
- 确保 `release.yml` 中的 `build-macos` job 也不受影响（它已经用了 `node -p` 获取版本）

**验证:**
- 运行 `bash app/scripts/build.sh`，检查 `LLMProxy.app/Contents/Info.plist` 中版本号正确

---

## System-Wide Impact

- **Info.plist 变更**: `CFBundleShortVersionString` 从硬编码 `1.0` 变为真实版本号，可能影响 spot-light 索引、系统关于本机显示
- **构建流程**: build.sh 增加一步版本读取，无副作用
- **本地化**: 新增 10 条翻译键，需确保 en/zh 同步
- **UserDefaults**: 新增 `last-update-check` 键记录上次检查时间
- **文件系统**: 新增 `~/Library/Application Support/LLMProxy/Updates/` 目录用于存放下载的 DMG

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| GitHub API 限流（未认证请求 60 次/小时） | 采用 24 小时间隔缓存 + 用户主动检查不频繁触发，够用 |
| 网络不可用时阻塞 UI | `checkForUpdates()` 使用 async/await 非阻塞，失败不弹出错误仅静默降级 |
| DMG 挂载/安装用户操作复杂 | 安装引导弹窗给出清晰的步骤说明，并在 Finder 中打开 DMG |
| 版本号误读（非 SemVer） | 当前版本格式固定 `major.minor.patch`，使用简单字符串比较即可 |
| 调试模式版本获取 | 回退到读取 `package.json`，确保 `swift run` 下版本号正确 |

---

## Documentation / Operational Notes

- 新增功能菜单截图可用于项目 README
- Homebrew 用户仍可通过 `brew upgrade llm-proxy` 更新，应用内更新作为补充渠道

---

## Sources & References

- GitHub API: `GET https://api.github.com/repos/maplezzk/llm-proxy/releases/latest`
- DMG 命名格式: `LLMProxy-v{VERSION}.dmg`
- Release workflow: `.github/workflows/release.yml`
