import AppKit
import SwiftUI

/// 代理服务的三态状态
enum ServiceState {
    case starting   // 启动中（app 刚拉起 / 正在调 CLI 启动）
    case running    // 运行中
    case stopped    // 未运行
}

class MenuBarController: NSObject {
    let statusItem: NSStatusItem
    let client = APIClient()
    let updateChecker = UpdateChecker()

    private var adapters: [Adapter] = []
    private var providers: [Provider] = []
    /// 服务状态（三态：启动中 / 运行中 / 未运行）
    private var serviceState: ServiceState = .starting
    /// 便捷判断：服务是否在运行
    private var isRunning: Bool { serviceState == .running }
    private var currentLogLevel: String = "info"
    /// 菜单栏显示的端口（从 UserDefaults 读取，用户意图端口）
    private var currentPort: Int = APIClient.storedPort()
    /// 用于 stop 兜底查找的实际连接端口；PID 文件冲突时可能与显示端口不同。
    private var serviceControlPort: Int {
        URL(string: client.baseURL)?.port ?? currentPort
    }
    private var pollTimer: Timer?
    private var updateCheckTimer: Timer?
    /// 任何服务生命周期操作都必须串行执行，避免 stop/start/restart 交错读写 PID 文件。
    private var serviceOperationTask: Task<Void, Never>?
    private var isServiceOperationInProgress = false
    private var isQuitting = false
    private var pendingUpdate: UpdateInfo?
    /// 操作进行中的临时状态文案（“正在停止...”），仅在 serviceOperation 期间保留
    private var transientStatus: String?
    /// 菜单栏状态卡片上的今日用量摘要
    private var todayTokensText: String?
    private var todayHitRateText: String?
    private var isCheckingUpdate = false
    private var isDownloadingUpdate = false
    private var downloadProgress: Double = 0
    private var downloadCompletedURL: URL?
    private var consoleWindowController: ConsoleWindowController?

    init(statusItem: NSStatusItem) {
        self.statusItem = statusItem
        super.init()
        NotificationCenter.default.addObserver(forName: .configDidChange, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.refresh()
            }
        }
    }

    func buildMenu() {
        // 初始状态为 .starting，菜单立即显示“启动中”（避免闪现“未运行”/“无法连接”）
        serviceState = .starting
        Task { @MainActor in
            rebuildMenu()
        }
        // 每 5 秒轮询一次状态
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.refreshStatus()
            }
        }
    }

    @MainActor
    func refreshStatus() async {
        let health = (try? await client.fetchHealth()) ?? false
        let newState: ServiceState = health ? .running : .stopped
        // 启动中阶段：如果还没检测到运行，保持“启动中”不切成“未运行”（等 autoStart 流程）
        if serviceState == .starting && newState == .stopped {
            updateStatusIcon()
            return
        }
        let oldState = serviceState
        serviceState = newState
        if oldState != newState {
            if newState == .running {
                // 服务刚运行：拉一次完整数据（adapters 等），避免适配器列表为空
                await refresh()
            } else {
                rebuildMenu()
            }
        }
        updateStatusIcon()
    }

    @MainActor
    func updateStatusIcon() {
        if let btn = statusItem.button {
            let img = loadTrayIcon()
            img.isTemplate = true
            btn.image = img
        }
    }

    @MainActor
    func refresh() async {
        do {
            async let adaptersResp = client.fetchAdapters()
            async let configResp = client.fetchConfig()
            let (a, c) = try await (adaptersResp, configResp)
            adapters = a.data?.adapters ?? []
            providers = c.data?.providers ?? []
        } catch {
            print("refresh error: \(error)")
            adapters = []
            providers = []
        }
        serviceState = ((try? await client.fetchHealth()) ?? false) ? .running : .stopped
        currentLogLevel = (try? await client.fetchLogLevel()) ?? "info"
        // 今日 token 用量摘要（菜单栏状态卡片）
        if serviceState == .running,
           let stats = try? await client.fetchTokenStats() {
            let today = stats.today
            todayTokensText = DashboardViewModel.fmtNum(DashboardViewModel.totalTokens(
                input: today.input_tokens, output: today.output_tokens,
                cacheRead: today.cache_read_input_tokens, cacheCreate: today.cache_creation_input_tokens))
            todayHitRateText = DashboardViewModel.hitRate(
                input: today.input_tokens, output: today.output_tokens,
                cacheRead: today.cache_read_input_tokens, cacheCreate: today.cache_creation_input_tokens)
        } else {
            todayTokensText = nil
            todayHitRateText = nil
        }
        // 从服务端同步端口（仅当服务端可达时才更新，不覆盖用户意图）
        if let sp = try? await client.fetchPort() {
            currentPort = sp
            client.updatePort(sp)
        } else {
            // 服务端连不上 → 可能是端口冲突递增了，尝试从 PID 文件发现实际端口，但只更新连接不更新显示
            discoverActualPort()
        }
        rebuildMenu()
    }

    @MainActor
    func rebuildMenu() {
        // 临时状态文案只在 serviceOperation 期间保留，操作结束后重建时清除
        if !isServiceOperationInProgress { transientStatus = nil }
        let menu = NSMenu()

        // ── 状态卡片（CodexBar 风格：状态 + 端口 + 今日用量 + 服务控制按钮）──
        let statusCard = StatusCardView(
            model: StatusCardModel(
                state: serviceState,
                port: currentPort,
                todayTokensText: todayTokensText,
                hitRateText: todayHitRateText,
                isOperationInProgress: isServiceOperationInProgress,
                transientText: transientStatus
            ),
            onStart: { [weak self] in self?.startService() },
            onStop: { [weak self] in self?.stopService() },
            onRestart: { [weak self] in self?.restartService() }
        )
        menu.addItem(makeCardItem(statusCard, interactive: true))
        menu.addItem(.separator())

        // 控制台入口
        let consoleItem = NSMenuItem(title: loc("console.openConsole"), action: #selector(openConsole), keyEquivalent: "o")
        consoleItem.target = self
        if #available(macOS 11.0, *) {
            consoleItem.image = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: loc("console.openConsole"))
        }
        menu.addItem(consoleItem)

        // 重载配置
        let reloadItem = NSMenuItem(title: loc("action.reloadConfig"), action: #selector(reloadConfig), keyEquivalent: "r")
        reloadItem.target = self
        if #available(macOS 11.0, *) {
            reloadItem.image = NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: loc("action.reloadConfig"))
        }
        menu.addItem(reloadItem)

        menu.addItem(.separator())

        // 工具区：Admin UI → 日志目录 → 端口 → 日志级别
        let adminItem = NSMenuItem(title: loc("action.openAdmin"), action: #selector(openAdmin), keyEquivalent: "")
        adminItem.target = self
        if #available(macOS 11.0, *) {
            adminItem.image = NSImage(systemSymbolName: "globe", accessibilityDescription: loc("action.openAdmin"))
        }
        menu.addItem(adminItem)

        let logsItem = NSMenuItem(title: loc("action.openLogs"), action: #selector(openLogs), keyEquivalent: "")
        logsItem.target = self
        if #available(macOS 11.0, *) {
            logsItem.image = NSImage(systemSymbolName: "folder", accessibilityDescription: loc("action.openLogs"))
        }
        menu.addItem(logsItem)

        // 端口设置（子菜单）
        let portItem = NSMenuItem(title: loc("action.port", String(currentPort)), action: nil, keyEquivalent: "")
        if #available(macOS 11.0, *) {
            portItem.image = NSImage(systemSymbolName: "number", accessibilityDescription: loc("action.port", String(currentPort)))
        }
        let portMenu = NSMenu()
        // 常用端口快捷选项
        for p in [9000, 9001, 9002, 8080, 3000] {
            let item = NSMenuItem(title: String(p), action: #selector(changePort(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = p
            if p == currentPort { item.state = .on }
            portMenu.addItem(item)
        }
        portMenu.addItem(.separator())
        let customItem = NSMenuItem(title: loc("action.customPort"), action: #selector(showCustomPortDialog), keyEquivalent: "")
        customItem.target = self
        portMenu.addItem(customItem)
        portItem.submenu = portMenu
        menu.addItem(portItem)

        let logLevelItem = NSMenuItem(title: loc("action.logLevel", currentLogLevel), action: nil, keyEquivalent: "")
        if #available(macOS 11.0, *) {
            logLevelItem.image = NSImage(systemSymbolName: "ellipsis.circle", accessibilityDescription: loc("action.logLevel", currentLogLevel))
        }
        let logLevelMenu = NSMenu()
        for level in ["debug", "info", "warn", "error"] {
            let item = NSMenuItem(title: level, action: #selector(changeLogLevel(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = level
            if level == currentLogLevel { item.state = .on }
            logLevelMenu.addItem(item)
        }
        logLevelItem.submenu = logLevelMenu
        menu.addItem(logLevelItem)

        // 语言切换（子菜单）
        let currentLang = currentLang()
        let langLabel = currentLang == "zh" ? "中文" : "English"
        let langItem = NSMenuItem(title: loc("action.language", langLabel), action: nil, keyEquivalent: "")
        if #available(macOS 11.0, *) {
            langItem.image = NSImage(systemSymbolName: "character.book.closed", accessibilityDescription: loc("action.language", langLabel))
        }
        let langMenu = NSMenu()
        for (langCode, langName) in [("zh", "中文"), ("en", "English")] {
            let item = NSMenuItem(title: langName, action: #selector(toggleLanguage), keyEquivalent: "")
            item.target = self
            item.representedObject = langCode
            if langCode == currentLang { item.state = .on }
            langMenu.addItem(item)
        }
        langItem.submenu = langMenu
        menu.addItem(langItem)

        // ── 更新区 ──
        menu.addItem(.separator())

        let versionItem = NSMenuItem(title: loc("menu.version", currentVersion()), action: nil, keyEquivalent: "")
        versionItem.isEnabled = false
        if #available(macOS 11.0, *) {
            versionItem.image = NSImage(systemSymbolName: "info.circle", accessibilityDescription: loc("menu.version", currentVersion()))
        }
        menu.addItem(versionItem)

        if !isUpdateDismissed() {
            if isDownloadingUpdate {
                // 下载进度行
                let pct = Int(downloadProgress * 100)
                let progressText = "\(loc("update.downloading")) \(pct)%"
                let progressItem = NSMenuItem(title: progressText, action: nil, keyEquivalent: "")
                progressItem.isEnabled = false
                if #available(macOS 11.0, *) {
                    progressItem.image = NSImage(systemSymbolName: "arrow.down.circle.dotted", accessibilityDescription: nil)
                }
                let attrTitle = NSMutableAttributedString(string: progressText)
                attrTitle.addAttribute(.foregroundColor, value: NSColor.systemBlue, range: NSRange(location: 0, length: attrTitle.length))
                progressItem.attributedTitle = attrTitle
                menu.addItem(progressItem)
            } else if downloadCompletedURL != nil {
                // 已下载，可安装
                let installItem = NSMenuItem(title: loc("menu.installNow"), action: #selector(installDownloadedUpdate), keyEquivalent: "")
                installItem.target = self
                if #available(macOS 11.0, *) {
                    installItem.image = NSImage(systemSymbolName: "arrow.down.circle.fill", accessibilityDescription: nil)
                }
                let attrTitle = NSMutableAttributedString(string: loc("menu.installNow"))
                attrTitle.addAttribute(.foregroundColor, value: NSColor.systemGreen, range: NSRange(location: 0, length: attrTitle.length))
                attrTitle.addAttribute(.font, value: NSFont.systemFont(ofSize: 13, weight: .semibold), range: NSRange(location: 0, length: attrTitle.length))
                installItem.attributedTitle = attrTitle
                menu.addItem(installItem)
            } else if let update = pendingUpdate {
                // 有可用更新（未下载）
                let updateAvailableItem = NSMenuItem(title: loc("menu.updatesAvailable", update.version), action: #selector(downloadAndInstallUpdate), keyEquivalent: "")
                updateAvailableItem.target = self
                let attrTitle = NSMutableAttributedString(string: loc("menu.updatesAvailable", update.version))
                attrTitle.addAttribute(.foregroundColor, value: NSColor.systemOrange, range: NSRange(location: 0, length: attrTitle.length))
                attrTitle.addAttribute(.font, value: NSFont.systemFont(ofSize: 13, weight: .semibold), range: NSRange(location: 0, length: attrTitle.length))
                updateAvailableItem.attributedTitle = attrTitle
                if #available(macOS 11.0, *) {
                    updateAvailableItem.image = NSImage(systemSymbolName: "arrow.down.circle.fill", accessibilityDescription: nil)
                }
                menu.addItem(updateAvailableItem)
            }
        }

        let checkItem = NSMenuItem(title: loc("action.checkForUpdates"), action: #selector(checkForUpdates), keyEquivalent: "")
        checkItem.target = self
        checkItem.isEnabled = !isCheckingUpdate && !isDownloadingUpdate
        if #available(macOS 11.0, *) {
            checkItem.image = NSImage(systemSymbolName: "arrow.up.arrow.down.circle", accessibilityDescription: loc("action.checkForUpdates"))
        }
        menu.addItem(checkItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: loc("action.quit"), action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        if #available(macOS 11.0, *) {
            quitItem.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: loc("action.quit"))
        }
        menu.addItem(quitItem)

        // ── 适配器区放最底部（模型列表可能很长，悬停映射行即展开子菜单，零点击切换）──
        menu.addItem(.separator())
        if adapters.isEmpty {
            let isLoading = serviceState == .starting
            let hint = isLoading ? loc("status.loading") : loc("status.cannotConnect")
            menu.addItem(makeCardItem(MenuHintCardView(text: hint, isLoading: isLoading), interactive: false))
        } else {
            for card in makeAdapterCardModels(adapters: adapters) {
                // 适配器头：名称 + 协议类型（不可点击）
                menu.addItem(makeCardItem(AdapterHeaderCardView(name: card.name, type: card.type), interactive: false))
                // 每个映射一行：悬停自动展开模型子菜单
                for mapping in card.mappings {
                    let row = MappingRowView(sourceModelId: mapping.sourceModelId, currentLabel: mapping.currentLabel)
                    let item = makeCardItem(row, interactive: true)
                    if let adapter = adapters.first(where: { $0.name == card.name }) {
                        let submenu = buildMappingSubMenu(
                            adapter: adapter,
                            sourceModelId: mapping.sourceModelId,
                            currentProvider: mapping.provider,
                            currentTarget: mapping.targetModelId
                        )
                        if submenu.items.isEmpty {
                            item.isEnabled = false
                        } else {
                            item.submenu = submenu
                            item.target = self
                            item.action = #selector(menuCardNoOp(_:))
                        }
                    } else {
                        item.isEnabled = false
                    }
                    menu.addItem(item)
                }
                menu.addItem(.separator())
            }
            // 移除最后多余的 separator
            if menu.items.last?.isSeparatorItem == true {
                menu.removeItem(at: menu.items.count - 1)
            }
        }

        statusItem.menu = menu
    }

    /// 将 SwiftUI 卡片包装成菜单项（CodexBar 风格富菜单）
    @MainActor
    private func makeCardItem<Content: View>(_ view: Content, interactive: Bool) -> NSMenuItem {
        let hosting = NSHostingView(rootView: view)
        hosting.frame = NSRect(origin: .zero, size: NSSize(width: MenuCardMetrics.width, height: 1))
        let height = max(1, ceil(hosting.fittingSize.height))
        hosting.frame = NSRect(origin: .zero, size: NSSize(width: MenuCardMetrics.width, height: height))
        let item = NSMenuItem()
        item.view = hosting
        item.isEnabled = interactive
        return item
    }

    /// 构建映射行的模型切换子菜单（勾选当前项，按 provider 分组）
    private func buildMappingSubMenu(adapter: Adapter, sourceModelId: String, currentProvider: String, currentTarget: String) -> NSMenu {
        let submenu = NSMenu()
        for provider in providers {
            for model in provider.models {
                let item = NSMenuItem(title: "\(provider.name)/\(model.id)", action: #selector(switchMapping(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = SwitchAction(
                    adapter: adapter,
                    sourceModelId: sourceModelId,
                    provider: provider.name,
                    targetModelId: model.id
                )
                if provider.name == currentProvider && model.id == currentTarget {
                    item.state = .on
                }
                submenu.addItem(item)
            }
            submenu.addItem(.separator())
        }
        if submenu.items.last?.isSeparatorItem == true {
            submenu.removeItem(at: submenu.items.count - 1)
        }
        return submenu
    }

    /// 带子菜单的卡片项需要 action 才能悬停展开，点击本身不做任何事
    @objc private func menuCardNoOp(_ sender: NSMenuItem) {}

    @objc func switchMapping(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? SwitchAction else { return }
        Task { @MainActor in
            await performSwitch(action)
        }
    }

    @MainActor
    func performSwitch(_ action: SwitchAction) async {
        // Build updated mappings: only change the target sourceModelId
        let newMappings = action.adapter.models.map { m in
            if m.sourceModelId == action.sourceModelId {
                return UpdateModelMapping(
                    sourceModelId: m.sourceModelId,
                    provider: action.provider,
                    targetModelId: action.targetModelId
                )
            }
            return UpdateModelMapping(
                sourceModelId: m.sourceModelId,
                provider: m.provider,
                targetModelId: m.targetModelId
            )
        }
        do {
            try await client.updateAdapter(action.adapter, mappings: newMappings)
            await refresh()
        } catch {
            showError(loc("error.switchFailed", error.localizedDescription))
        }
    }

    @objc func refreshMenu() {
        Task { @MainActor in
            await refresh()
        }
    }

    @MainActor @objc func openConsole() {
        if let existing = consoleWindowController, existing.window?.isVisible == true {
            existing.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let controller = ConsoleWindowController()
        consoleWindowController = controller
        controller.show()
    }

    @MainActor @objc func changeLogLevel(_ sender: NSMenuItem) {
        guard let level = sender.representedObject as? String else { return }
        Task { @MainActor in
            do {
                try await client.setLogLevel(level)
                currentLogLevel = level
                rebuildMenu()
            } catch {
                showError(loc("error.setLogLevelFailed", error.localizedDescription))
            }
        }
    }

    @MainActor @objc func stopService() {
        guard !isServiceOperationInProgress else { return }
        isServiceOperationInProgress = true
        setTransientStatus(loc("status.stopping"))
        serviceOperationTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let result = await self.runCLIAndWait("stop", port: self.serviceControlPort)
            if result.exitCode != 0 {
                NSLog("[LLMProxy] ❌ 菜单栏停止服务失败 (exit=\(result.exitCode)): \(result.output)")
                self.isServiceOperationInProgress = false
                self.serviceOperationTask = nil
                await self.refresh()
                self.showError(result.output.isEmpty ? "停止服务失败" : result.output)
                return
            }
            await self.waitForStoppedAndRefresh()
            self.isServiceOperationInProgress = false
            self.serviceOperationTask = nil
            self.rebuildMenu()
        }
    }

    @MainActor @objc func restartService() {
        guard !isServiceOperationInProgress else { return }
        isServiceOperationInProgress = true
        setTransientStatus(loc("status.restarting"))
        serviceOperationTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let error = await self.startCLIWithPort("restart", port: self.currentPort)
            if let err = error {
                self.showError(err)
                await self.refresh()
                self.isServiceOperationInProgress = false
                self.serviceOperationTask = nil
                return
            }
            // 轮询等待服务就绪后刷新配置
            await self.waitForReadyAndRefresh()
            self.isServiceOperationInProgress = false
            self.serviceOperationTask = nil
            self.rebuildMenu()
        }
    }

    @MainActor @objc func startService() {
        guard !isServiceOperationInProgress else { return }
        isServiceOperationInProgress = true
        setTransientStatus(loc("status.starting"))
        serviceOperationTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let error = await self.startCLIWithPort("start", port: self.currentPort)
            if let err = error {
                self.showError(err)
                await self.refresh()
                self.isServiceOperationInProgress = false
                self.serviceOperationTask = nil
                return
            }
            // 轮询等待服务就绪后刷新配置
            await self.waitForReadyAndRefresh()
            self.isServiceOperationInProgress = false
            self.serviceOperationTask = nil
            self.rebuildMenu()
        }
    }

    /// 应用启动时自动检测并启动代理服务
    @MainActor
    func autoStartIfNeeded() async {
        // 查一次状态
        let running = (try? await client.fetchHealth()) ?? false
        if running {
            // 服务已在跑：拉取完整数据并重建菜单（“启动中” → “运行中” + 适配器列表）
            serviceState = .running
            await refresh()
            return
        }
        // 服务未运行：保持“启动中”，调 CLI 启动，由轮询检测到后切换为“运行中”
        NSLog("[LLMProxy] 🔄 服务未运行，自动启动...")
        guard !isServiceOperationInProgress else { return }
        isServiceOperationInProgress = true
        serviceState = .starting
        rebuildMenu()
        serviceOperationTask = Task { @MainActor [weak self] in
            guard let self else { return }
            // Preserve the CLI's config.yaml port during automatic startup;
            // currentPort is the menu's user-intent cache and can be stale on
            // first launch of an existing installation.
            let error = await self.startCLIWithPort("restart", port: nil)
            if let error {
                NSLog("[LLMProxy] ❌ 自动启动服务失败: \(error)")
                self.isServiceOperationInProgress = false
                self.serviceOperationTask = nil
                await self.refresh()
                return
            }
            await self.waitForReadyAndRefresh()
            self.isServiceOperationInProgress = false
            self.serviceOperationTask = nil
            self.rebuildMenu()
        }
    }

    @MainActor
    func setTransientStatus(_ text: String) {
        // 卡片化菜单：临时文案写入状态卡片并整体重建（按钮由 isOperationInProgress 禁用）
        transientStatus = text
        rebuildMenu()
    }

    func bundledBinaryPath() -> String? {
        guard let resourcePath = Bundle.main.resourcePath else { return nil }
        let path = (resourcePath as NSString).appendingPathComponent("llm-proxy")
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    /// 调试模式（swift run）下用 node 运行项目中的 bin/llm-proxy.js
    func debugNodeEntryPath() -> String? {
        let bundlePath = Bundle.main.bundlePath
        guard let buildRange = bundlePath.range(of: "/.build/") else { return nil }
        // bundlePath: .../llm-proxy/app/.build/arm64-apple-macosx/debug
        // appDir:     .../llm-proxy/app
        let appDir = bundlePath[..<buildRange.lowerBound]
        let projectRoot = (appDir as NSString).deletingLastPathComponent  // .../llm-proxy
        let jsEntry = (projectRoot as NSString).appendingPathComponent("bin/llm-proxy.js")
        guard FileManager.default.isExecutableFile(atPath: jsEntry) else { return nil }
        return jsEntry
    }

    /// 异步启动带端口的命令，返回错误信息（nil 表示成功）
    func startCLIWithPort(_ command: String, port: Int?) async -> String? {
        let task = Process()
        let shell = "/bin/zsh"
        task.executableURL = URL(fileURLWithPath: shell)

        if let bundled = bundledBinaryPath() {
            let portArgument = port.map { " --port \($0)" } ?? ""
            let cmdLine = "\"\(bundled)\" \(command)\(portArgument)"
            task.arguments = ["-l", "-c", cmdLine]
            task.currentDirectoryURL = URL(fileURLWithPath: Bundle.main.resourcePath!)
        } else if let jsEntry = debugNodeEntryPath() {
            let projectRoot = ((jsEntry as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
            task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            task.arguments = ["node", jsEntry, command] + (port.map { ["--port", String($0)] } ?? [])
            task.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
        } else {
            let fallback = "/opt/homebrew/bin/llm-proxy"
            guard FileManager.default.isExecutableFile(atPath: fallback) else {
                return "找不到 llm-proxy 二进制"
            }
            let portArgument = port.map { " --port \($0)" } ?? ""
            let cmdLine = "\"\(fallback)\" \(command)\(portArgument)"
            task.arguments = ["-l", "-c", cmdLine]
        }

        // 捕获 stderr
        let stderrPipe = Pipe()
        task.standardError = stderrPipe
        var stderrOutput = ""

        do {
            try task.run()
        } catch {
            return "启动 llm-proxy 失败: \(error.localizedDescription)"
        }

        // 异步收集 stderr
        let fh = stderrPipe.fileHandleForReading
        fh.readabilityHandler = { handle in
            let data = handle.availableData
            if let text = String(data: data, encoding: .utf8) {
                stderrOutput += text
            }
        }

        // 等待一小段时间判断是否有启动错误
        // 如果端口被占用，llm-proxy 会立刻退出，否则进程持续运行
        try? await Task.sleep(nanoseconds: 2_500_000_000) // 2.5秒

        // 检查进程是否还在运行
        if task.isRunning {
            // 启动成功，还在运行
            fh.readabilityHandler = nil
            return nil
        }

        // 进程已退出 → 启动失败，解析 stderr 获取原因
        fh.readabilityHandler = nil
        let remaining = fh.readDataToEndOfFile()
        if let text = String(data: remaining, encoding: .utf8) {
            stderrOutput += text
        }

        // 提取错误信息
        let lines = stderrOutput.split(separator: "\n").map(String.init)

        // 端口类错误：短消息，取第一条即可
        let portError = lines.first(where: { line in
            line.contains("端口") || line.contains("已被占用") || line.contains("EADDRINUSE") || line.contains("in use")
        })
        if let err = portError, !err.isEmpty {
            return err.trimmingCharacters(in: .whitespaces)
        }

        // 配置/校验/通用错误：返回完整 stderr，保留多行详情（如校验错误列表）
        let hasError = lines.contains(where: { line in
            line.contains("error") || line.contains("Error") ||
            line.contains("失败") || line.contains("failed") ||
            line.contains("校验")
        })
        if hasError {
            let all = stderrOutput.trimmingCharacters(in: .whitespacesAndNewlines)
            return all.isEmpty ? "启动失败，服务进程已退出" : all
        }

        // 没有找到明显错误行，返回完整 stderr
        let all = stderrOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        return all.isEmpty ? "启动失败，服务进程已退出" : all
    }

    /// 轮询等待服务就绪（health 可达），然后刷新全部配置
    @MainActor
    func waitForReadyAndRefresh() async {
        // 最多等 15 秒，每 1 秒检查一次
        for _ in 0..<15 {
            if (try? await client.fetchHealth()) == true {
                await refresh()
                return
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        // 超时，尝试刷新一次看看能拿到什么
        await refresh()
    }

    /// 停止后不要依赖固定延迟；以 health 的实际结果作为完成条件。
    @MainActor
    func waitForStoppedAndRefresh() async {
        for _ in 0..<20 {
            if (try? await client.fetchHealth()) != true {
                serviceState = .stopped
                adapters = []
                providers = []
                rebuildMenu()
                updateStatusIcon()
                return
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }

        // CLI stop 已经等待并在必要时 SIGKILL；这里再核对一次，避免 UI
        // 误报“已停止”而实际服务仍可访问。
        await refreshStatus()
    }

    func runCLI(_ command: String) {
        let task = Process()
        // 通过 login shell (-l) 启动，加载 ~/.zshrc 中的环境变量
        let shell = "/bin/zsh"
        task.executableURL = URL(fileURLWithPath: shell)
        if let bundled = bundledBinaryPath() {
            task.arguments = ["-l", "-c", "\"\(bundled)\" \(command)"]
            task.currentDirectoryURL = URL(fileURLWithPath: Bundle.main.resourcePath!)
        } else if let jsEntry = debugNodeEntryPath() {
            // 2. 调试模式（swift run）：用 node 运行 bin/llm-proxy.js
            let projectRoot = ((jsEntry as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
            task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            task.arguments = ["node", jsEntry, command]
            task.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
            NSLog("[LLMProxy] ℹ️ 调试模式: node \(jsEntry) \(command)")
        } else {
            // 3. homebrew 安装
            let fallback = "/opt/homebrew/bin/llm-proxy"
            if FileManager.default.isExecutableFile(atPath: fallback) {
                task.arguments = ["-l", "-c", "\"\(fallback)\" \(command)"]
            } else {
                NSLog("[LLMProxy] ❌ 找不到 llm-proxy 二进制")
                DispatchQueue.main.async { [weak self] in
                    self?.showError("找不到 llm-proxy 二进制。调试模式请先 npm run build 编译项目，或直接终端运行 llm-proxy start")
                }
                return
            }
        }
        if task.arguments == nil {
            task.arguments = [command]
        }

        // 捕获 stdout/stderr，写入日志文件以便排查启动失败原因
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        task.standardOutput = stdoutPipe
        task.standardError = stderrPipe

        do {
            try task.run()
            NSLog("[LLMProxy] ✅ 执行 llm-proxy \(command), pid: \(task.processIdentifier)")

            // 异步读取输出并写入日志文件
            let logDir = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".llm-proxy").path
            try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
            let logPath = (logDir as NSString).appendingPathComponent("app-launch.log")

            let dateFmt = DateFormatter()
            dateFmt.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"

            func appendToLog(_ text: String) {
                let ts = dateFmt.string(from: Date())
                let line = "[\(ts)] \(text)"
                if let handle = FileHandle(forWritingAtPath: logPath) {
                    handle.seekToEndOfFile()
                    if let data = (line + "\n").data(using: .utf8) {
                        handle.write(data)
                    }
                    handle.closeFile()
                } else {
                    try? (line + "\n").write(toFile: logPath, atomically: true, encoding: .utf8)
                }
            }

            stdoutPipe.fileHandleForReading.readabilityHandler = { fh in
                let data = fh.availableData
                if let output = String(data: data, encoding: .utf8), !output.isEmpty {
                    let lines = output.split(separator: "\n").map(String.init)
                    for line in lines {
                        NSLog("[LLMProxy:stdout] \(line)")
                        appendToLog("[STDOUT] \(line)")
                    }
                }
            }

            stderrPipe.fileHandleForReading.readabilityHandler = { fh in
                let data = fh.availableData
                if let output = String(data: data, encoding: .utf8), !output.isEmpty {
                    let lines = output.split(separator: "\n").map(String.init)
                    for line in lines {
                        NSLog("[LLMProxy:stderr] \(line)")
                        appendToLog("[STDERR] \(line)")
                    }
                }
            }

            // 进程退出时清理
            task.terminationHandler = { proc in
                stdoutPipe.fileHandleForReading.readabilityHandler = nil
                stderrPipe.fileHandleForReading.readabilityHandler = nil
                let _ = dateFmt.string(from: Date())
                let msg = "[SYSTEM] llm-proxy \(command) 已退出 (pid: \(proc.processIdentifier), code: \(proc.terminationStatus))"
                NSLog("[LLMProxy] \(msg)")
                appendToLog(msg)
            }
        } catch {
            NSLog("[LLMProxy] ❌ 启动 llm-proxy 失败: \(error.localizedDescription)")
            DispatchQueue.main.async { [weak self] in
                self?.showError("启动 llm-proxy 失败: \(error.localizedDescription)")
            }
            // 写入日志文件
            let logPath = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".llm-proxy/app-launch.log").path
            let ts = DateFormatter()
            ts.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
            let line = "[\(ts.string(from: Date()))] [SYSTEM] ❌ 启动失败: \(error.localizedDescription)\n"
            try? (line).write(toFile: logPath, atomically: true, encoding: .utf8)
        }
    }

    private struct CLIResult {
        let exitCode: Int32
        let output: String
    }

    /// 执行 CLI 并等待其真正退出。stop/restart 必须使用这个版本，不能
    /// 只启动一个异步 Process 后用固定延时猜测服务是否已经结束。
    private func runCLIAndWait(_ command: String, port: Int? = nil) async -> CLIResult {
        let task = Process()
        let shell = "/bin/zsh"

        if let bundled = bundledBinaryPath() {
            task.executableURL = URL(fileURLWithPath: shell)
            let portArgument = port.map { " --port \($0)" } ?? ""
            task.arguments = ["-l", "-c", "\"\(bundled)\" \(command)\(portArgument)"]
            task.currentDirectoryURL = URL(fileURLWithPath: Bundle.main.resourcePath!)
        } else if let jsEntry = debugNodeEntryPath() {
            let projectRoot = ((jsEntry as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
            task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            task.arguments = ["node", jsEntry, command] + (port.map { ["--port", String($0)] } ?? [])
            task.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
        } else {
            let fallback = "/opt/homebrew/bin/llm-proxy"
            guard FileManager.default.isExecutableFile(atPath: fallback) else {
                return CLIResult(exitCode: 127, output: "找不到 llm-proxy 二进制")
            }
            task.executableURL = URL(fileURLWithPath: shell)
            let portArgument = port.map { " --port \($0)" } ?? ""
            task.arguments = ["-l", "-c", "\"\(fallback)\" \(command)\(portArgument)"]
        }

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        task.standardOutput = stdoutPipe
        task.standardError = stderrPipe

        do {
            return try await withCheckedThrowingContinuation { continuation in
                task.terminationHandler = { process in
                    let stdout = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                    let stderr = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                    let output = String(data: stdout + stderr, encoding: .utf8) ?? ""
                    continuation.resume(returning: CLIResult(exitCode: process.terminationStatus, output: output.trimmingCharacters(in: .whitespacesAndNewlines)))
                }
                do {
                    try task.run()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        } catch {
            return CLIResult(exitCode: 1, output: "执行 llm-proxy \(command) 失败: \(error.localizedDescription)")
        }
    }

    @MainActor @objc func quitApp() {
        guard !isQuitting else { return }
        isQuitting = true
        setTransientStatus(loc("status.stopping"))

        // 如果已有 start/stop/restart 正在进行，先等它完成，再发起唯一的
        // stop。这样退出不会和后台生命周期操作同时争抢 PID 文件。
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let operation = self.serviceOperationTask {
                await operation.value
            }

            let result = await self.runCLIAndWait("stop", port: self.serviceControlPort)
            if result.exitCode != 0 {
                self.isQuitting = false
                let alert = NSAlert()
                alert.messageText = loc("quit.serviceStopFailed.title")
                alert.informativeText = result.output.isEmpty
                    ? loc("quit.serviceStopFailed.body")
                    : result.output
                alert.alertStyle = .warning
                alert.addButton(withTitle: loc("common.close"))
                alert.runModal()
                NSLog("[LLMProxy] ❌ 后台服务停止失败 (exit=\(result.exitCode)): \(result.output)")
                return
            }

            await self.waitForStoppedAndRefresh()
            let stillRunning = (try? await self.client.fetchHealth()) == true
            if stillRunning {
                self.isQuitting = false
                let alert = NSAlert()
                alert.messageText = loc("quit.serviceStopFailed.title")
                alert.informativeText = loc("quit.serviceStopFailed.body")
                alert.alertStyle = .warning
                alert.addButton(withTitle: loc("common.close"))
                alert.runModal()
                NSLog("[LLMProxy] ❌ 停止命令完成后服务仍可访问，拒绝退出菜单栏")
                return
            }

            (NSApp.delegate as? AppDelegate)?.shouldReallyQuit = true
            NSApplication.shared.terminate(nil)
        }
    }

    @MainActor @objc func changePort(_ sender: NSMenuItem) {
        guard let newPort = sender.representedObject as? Int else { return }
        enqueuePortChange(newPort)
    }

    @MainActor
    private func enqueuePortChange(_ newPort: Int) {
        guard !isServiceOperationInProgress else { return }
        isServiceOperationInProgress = true
        serviceOperationTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.performChangePort(newPort)
            self.isServiceOperationInProgress = false
            self.serviceOperationTask = nil
        }
    }

    @MainActor
    func performChangePort(_ newPort: Int) async {
        guard newPort >= 1 && newPort <= 65535 else {
            showError("Port must be between 1 and 65535")
            return
        }
        // 先持久化到 config.yaml
        do {
            try await client.setPort(newPort)
        } catch {
            print("setPort failed (service may be offline): \(error)")
        }
        // 更新本地缓存
        currentPort = newPort
        client.updatePort(newPort)

        // 如果服务正在运行，自动重启让新端口生效
        if isRunning {
            rebuildMenu()
            setTransientStatus(loc("status.restarting"))
            let error = await startCLIWithPort("restart", port: newPort)
            if let err = error {
                showError(err)
                await refresh()
                return
            }
            await waitForReadyAndRefresh()
        } else {
            rebuildMenu()
        }
    }

    @MainActor @objc func showCustomPortDialog() {
        let alert = NSAlert()
        alert.messageText = loc("action.portTitle")
        alert.informativeText = loc("action.portPrompt")
        alert.addButton(withTitle: loc("action.save"))
        alert.addButton(withTitle: loc("action.cancel"))

        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 120, height: 22))
        input.stringValue = String(currentPort)
        input.placeholderString = "9000"
        alert.accessoryView = input
        input.becomeFirstResponder()

        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            let portStr = input.stringValue.trimmingCharacters(in: .whitespaces)
            guard let port = Int(portStr), port >= 1, port <= 65535 else {
                showError("Port must be between 1 and 65535")
                return
            }
            enqueuePortChange(port)
        }
    }

    /// 从 PID 文件发现实际端口（端口冲突自动递增后）
    /// 仅更新 client baseURL 用于后续 API 请求，不改变 currentPort（菜单栏显示）
    func discoverActualPort() {
        let pidPath = "/tmp/llm-proxy.pid"
        guard let data = try? String(contentsOfFile: pidPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              let jsonData = data.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
              let port = json["port"] as? Int else { return }
        // 只更新 client 的连接端口，用于后续 API 请求能连上
        // 不改变 currentPort（UserDefaults 中用户意图的端口，菜单栏显示用）
        if port != currentPort {
            client.updatePort(port)
        }
    }

    @MainActor @objc func reloadConfig() {
        Task { @MainActor in
            setTransientStatus(loc("status.reloadingConfig"))
            do {
                try await client.reloadConfig()
                // 先同步 locale，再统一刷新（避免两次 rebuildMenu）
                if let serverLocale = try? await client.fetchLocale() {
                    UserDefaults.standard.set(serverLocale, forKey: "llm-proxy-lang")
                }
                await refresh()
            } catch {
                showError(loc("error.reloadFailed", error.localizedDescription))
            }
        }
    }

    @objc func openAdmin() {
        NSWorkspace.shared.open(URL(string: "\(client.baseURL)/admin")!)
    }

    @MainActor @objc func toggleLanguage(_ sender: NSMenuItem) {
        guard let lang = sender.representedObject as? String else { return }
        switchLang(lang)
        // 同步到服务端
        Task { @MainActor in
            try? await client.setLocale(lang)
        }
        rebuildMenu()
    }

    @objc func openLogs() {
        let logDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".llm-proxy")
        NSWorkspace.shared.open(logDir)
    }

    // MARK: - Update Actions

    /// 启动时立即检查更新，并启动 5 分钟间隔的定时检查（受自动更新开关控制）
    @MainActor
    func checkForUpdatesOnLaunch() {
        // 立即执行一次静默检查
        if isAutoUpdateEnabled() {
            Task { @MainActor [weak self] in
                await self?.performUpdateCheck(silent: true)
            }
        }

        // 每 5 分钟自动检查一次更新
        updateCheckTimer = Timer.scheduledTimer(withTimeInterval: 5 * 60, repeats: true) { [weak self] _ in
            guard let self, self.isAutoUpdateEnabled() else { return }
            Task { @MainActor [weak self] in
                await self?.performUpdateCheck(silent: true)
            }
        }
    }

    /// 主动检查更新（用户从菜单触发的）
    @MainActor @objc func checkForUpdates() {
        Task { @MainActor [weak self] in
            await self?.performUpdateCheck(silent: false)
        }
    }

    /// 执行更新检查
    @MainActor
    private func performUpdateCheck(silent: Bool) async {
        guard !isCheckingUpdate else { return }
        isCheckingUpdate = true
        rebuildMenu()

        defer {
            isCheckingUpdate = false
            UserDefaults.standard.set(Date(), forKey: "last-update-check")
        }

        // 启动时清理旧的下载文件
        updateChecker.cleanUpOnLaunch()

        do {
            if let update = try await updateChecker.checkForUpdates() {
                pendingUpdate = update
                rebuildMenu()

                // 有新版本时弹窗确认下载（静默检查受 24h 延迟限制）
                let shouldAlert = !silent || !isUpdateDismissed()
                if shouldAlert {
                    let alert = NSAlert()
                    alert.messageText = loc("update.available")
                    alert.informativeText = loc("update.downloadConfirm", update.version)
                    alert.addButton(withTitle: loc("action.download"))
                    alert.addButton(withTitle: "Cancel")
                    if alert.runModal() == .alertFirstButtonReturn {
                        await performDownloadAndInstall(update)
                    } else {
                        // 用户点了 Cancel，24 小时内不再提醒
                        dismissUpdateReminder(version: update.version)
                    }
                }
            } else {
                pendingUpdate = nil
                rebuildMenu()

                if !silent {
                    let alert = NSAlert()
                    alert.messageText = loc("app.title")
                    alert.informativeText = loc("update.noUpdates", currentVersion())
                    alert.addButton(withTitle: "OK")
                    alert.runModal()
                }
            }
        } catch {
            pendingUpdate = nil
            rebuildMenu()

            if !silent {
                let alert = NSAlert()
                alert.messageText = loc("app.title")
                alert.informativeText = loc("update.checkFailed", error.localizedDescription)
                alert.addButton(withTitle: "OK")
                alert.runModal()
            }
        }
    }

    /// 下载并安装更新（从更新可用菜单项触发）
    @MainActor @objc func downloadAndInstallUpdate() {
        guard let update = pendingUpdate else { return }

        Task { @MainActor [weak self] in
            await self?.performDownloadAndInstall(update)
        }
    }

    /// 24 小时内是否已延迟过此版本更新提醒
    private func isUpdateDismissed() -> Bool {
        let dismissedVersion = UserDefaults.standard.string(forKey: "update-dismissed-version")
        let dismissedDate = UserDefaults.standard.object(forKey: "update-dismissed-date") as? Date
        guard let dismissedVersion, let dismissedDate else { return false }
        // 版本不同（有新版本了），清除延迟状态
        let latestVersion = pendingUpdate?.version ?? ""
        if latestVersion != dismissedVersion { return false }
        return Date().timeIntervalSince(dismissedDate) < 24 * 60 * 60
    }

    /// 延迟提醒：24 小时内不再提醒此版本更新
    @MainActor
    private func dismissUpdateReminder(version: String) {
        UserDefaults.standard.set(version, forKey: "update-dismissed-version")
        UserDefaults.standard.set(Date(), forKey: "update-dismissed-date")
        rebuildMenu()
    }

    /// 是否启用自动检查更新（默认启用）
    private func isAutoUpdateEnabled() -> Bool {
        if UserDefaults.standard.object(forKey: "llm-proxy-auto-update-enabled") == nil {
            return true
        }
        return UserDefaults.standard.bool(forKey: "llm-proxy-auto-update-enabled")
    }

    /// 安装已下载的更新
    @MainActor @objc func installDownloadedUpdate() {
        guard let localURL = downloadCompletedURL else { return }

        Task { @MainActor [weak self] in
            await self?.performInstall(localURL, version: "")
        }
    }

    @MainActor
    private func performDownloadAndInstall(_ update: UpdateInfo) async {
        guard !isDownloadingUpdate else { return }
        isDownloadingUpdate = true
        downloadProgress = 0
        downloadCompletedURL = nil
        rebuildMenu()

        do {
            let localURL = try await updateChecker.downloadUpdate(update) { [weak self] progress in
                Task { @MainActor [weak self] in
                    self?.downloadProgress = progress
                    self?.rebuildMenu()
                }
            }

            // 下载完成
            isDownloadingUpdate = false
            downloadCompletedURL = localURL
            rebuildMenu()

            // 自动弹出安装确认
            let alert = NSAlert()
            alert.messageText = loc("update.downloadComplete")
            alert.informativeText = loc("update.installPrompt", update.version)
            alert.addButton(withTitle: loc("action.install"))
            alert.addButton(withTitle: loc("action.later24h"))
            if alert.runModal() == .alertFirstButtonReturn {
                await performInstall(localURL, version: update.version)
            } else {
                // 用户选了 Later，24 小时内不再提醒
                dismissUpdateReminder(version: update.version)
            }
        } catch {
            isDownloadingUpdate = false
            downloadProgress = 0
            rebuildMenu()

            // 下载失败，弹窗提示可重试
            let alert = NSAlert()
            alert.messageText = loc("app.title")
            alert.informativeText = loc("update.downloadFailed", error.localizedDescription)
            alert.addButton(withTitle: loc("action.retry"))
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn {
                // 重试
                await performDownloadAndInstall(update)
            }
        }
    }

    @MainActor
    private func performInstall(_ localURL: URL, version: String) async {
        if let operation = serviceOperationTask {
            await operation.value
        }
        // 安装前沿用与菜单栏退出相同的可等待停止流程，不能只发信号后
        // 立即让 helper 替换 app，否则旧服务可能继续占用端口。
        let stopResult = await runCLIAndWait("stop", port: serviceControlPort)
        guard stopResult.exitCode == 0 else {
            let alert = NSAlert()
            alert.messageText = loc("app.title")
            alert.informativeText = stopResult.output.isEmpty
                ? loc("quit.serviceStopFailed.body")
                : stopResult.output
            alert.addButton(withTitle: loc("common.close"))
            alert.runModal()
            return
        }
        await waitForStoppedAndRefresh()
        if (try? await client.fetchHealth()) == true {
            let alert = NSAlert()
            alert.messageText = loc("app.title")
            alert.informativeText = loc("quit.serviceStopFailed.body")
            alert.addButton(withTitle: loc("common.close"))
            alert.runModal()
            return
        }

        do {
            try await updateChecker.installUpdate(at: localURL)
        } catch {
            let alert = NSAlert()
            alert.messageText = loc("app.title")
            alert.informativeText = loc("update.installFailed", error.localizedDescription)
            alert.addButton(withTitle: "OK")
            alert.runModal()
            return
        }

        // helper 脚本已经启动（sleep 1; open /Applications/LLMProxy.app），
        // 且后台服务已经确认停止，这里直接强退进程。
        // NSApplication.shared.terminate 在 LSUIElement 菜单栏应用 + async 上下文不可靠。
        exit(0)
    }



    func showError(_ msg: String) {
        let alert = NSAlert()
        alert.messageText = loc("app.title")
        alert.informativeText = msg
        alert.runModal()
    }
}

struct SwitchAction {
    let adapter: Adapter
    let sourceModelId: String
    let provider: String
    let targetModelId: String
}
