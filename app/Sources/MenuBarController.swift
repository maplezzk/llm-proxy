import AppKit

class MenuBarController: NSObject {
    let statusItem: NSStatusItem
    let client = APIClient()

    private var adapters: [Adapter] = []
    private var providers: [Provider] = []
    private var serviceRunning: Bool = false
    private var currentLogLevel: String = "info"
    private var pollTimer: Timer?

    init(statusItem: NSStatusItem) {
        self.statusItem = statusItem
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
        if let btn = statusItem.button, let img = loadTrayIcon() {
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
        rebuildMenu()
    }

    @MainActor
    func rebuildMenu() {
        let menu = NSMenu()

        // 状态行
        let statusMenuItem = NSMenuItem()
        let statusText = serviceRunning ? loc("status.running") : loc("status.notRunning")
        let attrTitle = NSMutableAttributedString(string: statusText)
        let color: NSColor = serviceRunning ? .systemGreen : .systemGray
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
            menu.addItem(stopItem)
            let restartItem = NSMenuItem(title: loc("action.restart"), action: #selector(restartService), keyEquivalent: "")
            restartItem.target = self
            menu.addItem(restartItem)
        } else {
            let startItem = NSMenuItem(title: loc("action.start"), action: #selector(startService), keyEquivalent: "")
            startItem.target = self
            menu.addItem(startItem)
        }
        menu.addItem(.separator())

        if adapters.isEmpty {
            let item = NSMenuItem(title: loc("status.cannotConnect"), action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        } else {
            for adapter in adapters {
                // 适配器名作为不可点击的标题
                let headerItem = NSMenuItem(title: adapter.name, action: nil, keyEquivalent: "")
                headerItem.isEnabled = false
                let titleAttr = NSMutableAttributedString(string: adapter.name)
                titleAttr.addAttribute(.font, value: NSFont.systemFont(ofSize: 12, weight: .semibold), range: NSRange(location: 0, length: titleAttr.length))
                titleAttr.addAttribute(.foregroundColor, value: NSColor.labelColor, range: NSRange(location: 0, length: titleAttr.length))
                headerItem.attributedTitle = titleAttr
                menu.addItem(headerItem)

                // 每个模型映射直接平铺，缩进显示
                for mapping in adapter.models {
                    let mappingItem = NSMenuItem(title: "  \(mapping.sourceModelId)", action: nil, keyEquivalent: "")
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

        let refreshItem = NSMenuItem(title: loc("action.refresh"), action: #selector(refreshMenu), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)

        // 日志级别
        let logLevelItem = NSMenuItem(title: loc("action.logLevel", currentLogLevel), action: nil, keyEquivalent: "")
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

        let adminItem = NSMenuItem(title: loc("action.openAdmin"), action: #selector(openAdmin), keyEquivalent: "")
        adminItem.target = self
        menu.addItem(adminItem)

        let logsItem = NSMenuItem(title: loc("action.openLogs"), action: #selector(openLogs), keyEquivalent: "")
        logsItem.target = self
        menu.addItem(logsItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: loc("action.quit"), action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
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
        runCLI("restart")
        setTransientStatus(loc("status.restarting"))
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            await refresh()
        }
    }

    @MainActor @objc func startService() {
        runCLI("start")
        setTransientStatus(loc("status.starting"))
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
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

    /// 从 ~/.llm-proxy/.env 加载环境变量
    func loadEnvFile() -> [String: String] {
        let envPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".llm-proxy/.env")
        guard let content = try? String(contentsOf: envPath, encoding: .utf8) else { return [:] }
        var vars: [String: String] = [:]
        for line in content.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("#") else { continue }
            if let eq = trimmed.firstIndex(of: "=") {
                let key = String(trimmed[..<eq]).trimmingCharacters(in: .whitespaces)
                let val = String(trimmed[trimmed.index(after: eq)...])
                    .trimmingCharacters(in: .whitespaces)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                vars[key] = val
            }
        }
        return vars
    }

    func bundledBinaryPath() -> String? {
        guard let resourcePath = Bundle.main.resourcePath else { return nil }
        let path = (resourcePath as NSString).appendingPathComponent("llm-proxy")
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    func runCLI(_ command: String) {
        let task = Process()
        if let bundled = bundledBinaryPath() {
            task.executableURL = URL(fileURLWithPath: bundled)
            task.currentDirectoryURL = URL(fileURLWithPath: Bundle.main.resourcePath!)
        } else {
            let fallback = "/opt/homebrew/bin/llm-proxy"
            if FileManager.default.isExecutableFile(atPath: fallback) {
                task.executableURL = URL(fileURLWithPath: fallback)
            } else {
                NSLog("[LLMProxy] ❌ 找不到 llm-proxy 二进制 (bundled 和 /opt/homebrew/bin 都不存在)")
                return
            }
        }
        task.arguments = [command]

        // 合并父进程环境变量 + .env 文件中的变量
        let envFile = loadEnvFile()
        if !envFile.isEmpty {
            var env = ProcessInfo.processInfo.environment
            for (k, v) in envFile { env[k] = v }
            task.environment = env
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
                let ts = dateFmt.string(from: Date())
                let msg = "[SYSTEM] llm-proxy \(command) 已退出 (pid: \(proc.processIdentifier), code: \(proc.terminationStatus))"
                NSLog("[LLMProxy] \(msg)")
                appendToLog(msg)
            }
        } catch {
            NSLog("[LLMProxy] ❌ 启动 llm-proxy 失败: \(error.localizedDescription)")
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
        NSApplication.shared.terminate(nil)
    }

    @objc func openAdmin() {
        NSWorkspace.shared.open(URL(string: "\(client.baseURL)/admin")!)
    }

    @objc func openLogs() {
        let logDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".llm-proxy")
        NSWorkspace.shared.open(logDir)
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
