import AppKit

class MenuBarController: NSObject {
    let statusItem: NSStatusItem
    let client = APIClient()
    let updateChecker = UpdateChecker()

    private var adapters: [Adapter] = []
    private var providers: [Provider] = []
    private var serviceRunning: Bool = false
    private var currentLogLevel: String = "info"
    /// 菜单栏显示的端口（从 UserDefaults 读取，用户意图端口）
    private var currentPort: Int = APIClient.storedPort()
    private var pollTimer: Timer?
    private var pendingUpdate: UpdateInfo?
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
        Task { @MainActor in
            await refresh()
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
        do {
            let health = try await client.fetchHealth()
            let wasRunning = serviceRunning
            serviceRunning = health
            if wasRunning != serviceRunning { rebuildMenu() }
            updateStatusIcon()
        } catch {
            let wasRunning = serviceRunning
            serviceRunning = false
            if wasRunning { rebuildMenu() }
            updateStatusIcon()
        }
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
        serviceRunning = (try? await client.fetchHealth()) ?? false
        currentLogLevel = (try? await client.fetchLogLevel()) ?? "info"
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
        let menu = NSMenu()

        // 状态行
        let statusMenuItem = NSMenuItem()
        let statusText = serviceRunning ? loc("status.running") : loc("status.notRunning")
        let attrTitle = NSMutableAttributedString(string: statusText)
        let color: NSColor = serviceRunning
            ? NSColor(srgbRed: 0.20, green: 0.68, blue: 0.30, alpha: 1.0)
            : .secondaryLabelColor
        attrTitle.addAttribute(.foregroundColor, value: color, range: NSRange(location: 0, length: attrTitle.length))
        attrTitle.addAttribute(.font, value: NSFont.systemFont(ofSize: 13, weight: .medium), range: NSRange(location: 0, length: attrTitle.length))
        statusMenuItem.attributedTitle = attrTitle
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())

        // 服务控制
        if serviceRunning {
            let stopItem = NSMenuItem(title: loc("action.stop"), action: #selector(stopService), keyEquivalent: "")
            stopItem.target = self
            if #available(macOS 11.0, *) {
                stopItem.image = NSImage(systemSymbolName: "stop.fill", accessibilityDescription: loc("action.stop"))
            }
            menu.addItem(stopItem)
            let restartItem = NSMenuItem(title: loc("action.restart"), action: #selector(restartService), keyEquivalent: "")
            restartItem.target = self
            if #available(macOS 11.0, *) {
                restartItem.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: loc("action.restart"))
            }
            menu.addItem(restartItem)
        } else {
            let startItem = NSMenuItem(title: loc("action.start"), action: #selector(startService), keyEquivalent: "")
            startItem.target = self
            if #available(macOS 11.0, *) {
                startItem.image = NSImage(systemSymbolName: "play.fill", accessibilityDescription: loc("action.start"))
            }
            menu.addItem(startItem)
        }
        // 重载配置放在服务控制区
        let reloadItem = NSMenuItem(title: loc("action.reloadConfig"), action: #selector(reloadConfig), keyEquivalent: "r")
        reloadItem.target = self
        if #available(macOS 11.0, *) {
            reloadItem.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: loc("action.reloadConfig"))
        }
        menu.addItem(reloadItem)

        // 控制台入口
        let consoleItem = NSMenuItem()
        let consoleText = loc("console.openConsole")
        let attrConsole = NSMutableAttributedString(string: consoleText)
        attrConsole.addAttribute(.font, value: NSFont.systemFont(ofSize: 13, weight: .medium), range: NSRange(location: 0, length: attrConsole.length))
        consoleItem.attributedTitle = attrConsole
        consoleItem.target = self
        consoleItem.action = #selector(openConsole)
        if #available(macOS 11.0, *) {
            consoleItem.image = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: loc("console.openConsole"))
        }
        menu.addItem(consoleItem)

        menu.addItem(.separator())

        if adapters.isEmpty {
            let item = NSMenuItem(title: loc("status.cannotConnect"), action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        } else {
            for adapter in adapters {
                // 适配器名 + 协议类型作为 header
                let headerItem = NSMenuItem(title: "\(adapter.name)（\(adapter.type)）", action: nil, keyEquivalent: "")
                headerItem.isEnabled = false
                let titleAttr = NSMutableAttributedString(string: "\(adapter.name)（\(adapter.type)）")
                titleAttr.addAttribute(.font, value: NSFont.systemFont(ofSize: 12, weight: .semibold), range: NSRange(location: 0, length: titleAttr.length))
                titleAttr.addAttribute(.foregroundColor, value: NSColor.labelColor, range: NSRange(location: 0, length: titleAttr.length))
                headerItem.attributedTitle = titleAttr
                menu.addItem(headerItem)

                // 每个模型映射直接平铺，缩进显示
                for mapping in adapter.models {
                    let separator = " · "
                    let displayText = "  \(mapping.sourceModelId)\(separator)\(mapping.provider)/\(mapping.targetModelId)"
                    let attrTitle = NSMutableAttributedString(string: displayText)
                    let srcEnd = "  \(mapping.sourceModelId)\(separator)".count
                    attrTitle.addAttribute(.font, value: NSFont.systemFont(ofSize: 13), range: NSRange(location: 0, length: srcEnd))
                    let tgtRange = NSRange(location: srcEnd, length: displayText.count - srcEnd)
                    attrTitle.addAttribute(.font, value: NSFont.systemFont(ofSize: 12), range: tgtRange)
                    attrTitle.addAttribute(.foregroundColor, value: NSColor.secondaryLabelColor, range: tgtRange)
                    
                    let mappingItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
                    mappingItem.attributedTitle = attrTitle
                    let mappingSubMenu = NSMenu()

                    for provider in providers {
                        for model in provider.models {
                            let label = "\(provider.name)/\(model.id)"
                            let item = NSMenuItem(title: label, action: #selector(switchMapping(_:)), keyEquivalent: "")
                            item.target = self
                            item.representedObject = SwitchAction(
                                adapter: adapter,
                                sourceModelId: mapping.sourceModelId,
                                provider: provider.name,
                                targetModelId: model.id
                            )
                            if provider.name == mapping.provider && model.id == mapping.targetModelId {
                                item.state = .on
                            }
                            mappingSubMenu.addItem(item)
                        }
                        mappingSubMenu.addItem(.separator())
                    }
                    if mappingSubMenu.items.last?.isSeparatorItem == true {
                        mappingSubMenu.removeItem(at: mappingSubMenu.items.count - 1)
                    }
                    mappingItem.submenu = mappingSubMenu
                    menu.addItem(mappingItem)
                }
                menu.addItem(.separator())
            }
            // 移除最后多余的 separator
            if menu.items.last?.isSeparatorItem == true {
                menu.removeItem(at: menu.items.count - 1)
            }
        }

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

        statusItem.menu = menu
    }

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
        runCLI("stop")
        setTransientStatus(loc("status.stopping"))
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await refresh()
        }
    }

    @MainActor @objc func restartService() {
        setTransientStatus(loc("status.restarting"))
        Task { @MainActor in
            let error = await startCLIWithPort("restart", port: currentPort)
            if let err = error {
                showError(err)
                await refresh()
                return
            }
            // 轮询等待服务就绪后刷新配置
            await waitForReadyAndRefresh()
        }
    }

    @MainActor @objc func startService() {
        setTransientStatus(loc("status.starting"))
        Task { @MainActor in
            let error = await startCLIWithPort("start", port: currentPort)
            if let err = error {
                showError(err)
                await refresh()
                return
            }
            // 轮询等待服务就绪后刷新配置
            await waitForReadyAndRefresh()
        }
    }

    /// 应用启动时自动检测并启动代理服务
    @MainActor
    func autoStartIfNeeded() async {
        // 先刷新状态（buildMenu 已调用 refresh，但确保拿到最新状态）
        await refresh()
        if !serviceRunning {
            NSLog("[LLMProxy] 🔄 服务未运行，自动启动...")
            runCLI("restart")
            setTransientStatus(loc("status.starting"))
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            await refresh()
        }
    }

    @MainActor
    func setTransientStatus(_ text: String) {
        guard let menu = statusItem.menu,
              let first = menu.items.first else { return }
        let attrTitle = NSMutableAttributedString(string: text)
        attrTitle.addAttribute(.foregroundColor, value: NSColor.systemOrange,
                               range: NSRange(location: 0, length: attrTitle.length))
        attrTitle.addAttribute(.font, value: NSFont.systemFont(ofSize: 13, weight: .medium),
                               range: NSRange(location: 0, length: attrTitle.length))
        first.attributedTitle = attrTitle
        // 禁用所有服务控制按钮
        for item in menu.items where !item.isSeparatorItem && item !== first {
            if item.action == #selector(startService) ||
               item.action == #selector(stopService) ||
               item.action == #selector(restartService) {
                item.isEnabled = false
            }
        }
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
    func startCLIWithPort(_ command: String, port: Int) async -> String? {
        let task = Process()
        let shell = "/bin/zsh"
        task.executableURL = URL(fileURLWithPath: shell)

        let cmdLine: String
        if let bundled = bundledBinaryPath() {
            cmdLine = "\"\(bundled)\" \(command) --port \(port)"
            task.arguments = ["-l", "-c", cmdLine]
            task.currentDirectoryURL = URL(fileURLWithPath: Bundle.main.resourcePath!)
        } else if let jsEntry = debugNodeEntryPath() {
            let projectRoot = ((jsEntry as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
            cmdLine = "node \"\(jsEntry)\" \(command) --port \(port)"
            task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            task.arguments = ["node", jsEntry, command, "--port", String(port)]
            task.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
        } else {
            let fallback = "/opt/homebrew/bin/llm-proxy"
            guard FileManager.default.isExecutableFile(atPath: fallback) else {
                return "找不到 llm-proxy 二进制"
            }
            cmdLine = "\"\(fallback)\" \(command) --port \(port)"
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

        // 提取关键错误行
        let lines = stderrOutput.split(separator: "\n").map(String.init)
        let errorLine = lines.first(where: { line in
            line.contains("端口") || line.contains("port") || line.contains("Port") ||
            line.contains("已被占用") || line.contains("EADDRINUSE") || line.contains("in use") ||
            line.contains("error") || line.contains("Error") || line.contains("失败") || line.contains("failed")
        })

        if let err = errorLine, !err.isEmpty {
            return err.trimmingCharacters(in: .whitespaces)
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

    @objc func quitApp() {
        stopSync()
        (NSApp.delegate as? AppDelegate)?.shouldReallyQuit = true
        NSApplication.shared.terminate(nil)
    }

    /// 同步停止后台服务，等待进程退出后再退出应用
    /// 避免异步 stop 未完成时 terminate 导致旧进程残留
    private func stopSync() {
        let task = Process()
        let shell = "/bin/zsh"
        task.executableURL = URL(fileURLWithPath: shell)

        if let bundled = bundledBinaryPath() {
            task.arguments = ["-l", "-c", "\"\(bundled)\" stop"]
            task.currentDirectoryURL = URL(fileURLWithPath: Bundle.main.resourcePath!)
        } else if let jsEntry = debugNodeEntryPath() {
            let projectRoot = ((jsEntry as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
            task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            task.arguments = ["node", jsEntry, "stop"]
            task.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
        } else {
            let fallback = "/opt/homebrew/bin/llm-proxy"
            guard FileManager.default.isExecutableFile(atPath: fallback) else {
                NSLog("[LLMProxy] ❌ 找不到 llm-proxy 二进制")
                return
            }
            task.arguments = ["-l", "-c", "\"\(fallback)\" stop"]
        }

        do {
            try task.run()
            // 阻塞直到 stop 完成（llm-proxy stop 内部会 SIGTERM + 清理 PID 文件）
            task.waitUntilExit()
        } catch {
            NSLog("[LLMProxy] ❌ 同步停止服务失败: \(error.localizedDescription)")
        }
    }

    @MainActor @objc func changePort(_ sender: NSMenuItem) {
        guard let newPort = sender.representedObject as? Int else { return }
        Task { @MainActor in
            await performChangePort(newPort)
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
        if serviceRunning {
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
            Task { @MainActor in
                await performChangePort(port)
            }
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

    /// 应用启动时执行后台更新检查
    @MainActor
    func checkForUpdatesOnLaunch() {
        // 检查上次更新检查时间（24 小时间隔）
        let lastCheck = UserDefaults.standard.object(forKey: "last-update-check") as? Date ?? .distantPast
        if Date().timeIntervalSince(lastCheck) < 24 * 60 * 60 {
            return
        }

        Task { @MainActor [weak self] in
            await self?.performUpdateCheck(silent: true)
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

                // 静默检查时不弹通知，只更新菜单标记
                if !silent {
                    let alert = NSAlert()
                    alert.messageText = loc("update.available")
                    alert.informativeText = loc("update.downloadConfirm", update.version)
                    alert.addButton(withTitle: loc("action.download"))
                    alert.addButton(withTitle: "Cancel")
                    if alert.runModal() == .alertFirstButtonReturn {
                        await performDownloadAndInstall(update)
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
            alert.addButton(withTitle: "Later")
            if alert.runModal() == .alertFirstButtonReturn {
                await performInstall(localURL, version: update.version)
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
        // 停止后台服务
        runCLI("stop")

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

        // 退出应用（helper 脚本会重启新版本）
        NSApplication.shared.terminate(nil)
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
