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
        if let btn = statusItem.button {
            btn.image = NSImage(
                systemSymbolName: serviceRunning ? "arrow.triangle.branch" : "arrow.triangle.branch",
                accessibilityDescription: "LLM Proxy"
            )
            btn.image?.isTemplate = true
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
        let dot = serviceRunning ? "● " : "○ "
        let statusText = serviceRunning ? "llm-proxy 运行中" : "llm-proxy 未运行"
        let attrTitle = NSMutableAttributedString(string: dot + statusText)
        let color: NSColor = serviceRunning ? .systemGreen : .systemGray
        attrTitle.addAttribute(.foregroundColor, value: color, range: NSRange(location: 0, length: attrTitle.length))
        attrTitle.addAttribute(.font, value: NSFont.systemFont(ofSize: 13, weight: .medium), range: NSRange(location: 0, length: attrTitle.length))
        statusMenuItem.attributedTitle = attrTitle
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())

        // 服务控制
        if serviceRunning {
            let stopItem = NSMenuItem(title: "⏹  停止服务", action: #selector(stopService), keyEquivalent: "")
            stopItem.target = self
            menu.addItem(stopItem)
            let restartItem = NSMenuItem(title: "↺  重启服务", action: #selector(restartService), keyEquivalent: "")
            restartItem.target = self
            menu.addItem(restartItem)
        } else {
            let startItem = NSMenuItem(title: "▶  启动服务", action: #selector(startService), keyEquivalent: "")
            startItem.target = self
            menu.addItem(startItem)
        }
        menu.addItem(.separator())

        if adapters.isEmpty {
            let item = NSMenuItem(title: "无法连接到 llm-proxy", action: nil, keyEquivalent: "")
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

        let refreshItem = NSMenuItem(title: "刷新", action: #selector(refreshMenu), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)

        // 日志级别
        let logLevelItem = NSMenuItem(title: "日志级别: \(currentLogLevel)", action: nil, keyEquivalent: "")
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

        let adminItem = NSMenuItem(title: "打开 Admin UI", action: #selector(openAdmin), keyEquivalent: "")
        adminItem.target = self
        menu.addItem(adminItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
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
            showError("切换失败: \(error.localizedDescription)")
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
                showError("设置日志级别失败: \(error.localizedDescription)")
            }
        }
    }

    @MainActor @objc func stopService() {
        runCLI("stop")
        setTransientStatus("正在停止...")
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await refresh()
        }
    }

    @MainActor @objc func restartService() {
        runCLI("restart")
        setTransientStatus("正在重启...")
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            await refresh()
        }
    }

    @MainActor @objc func startService() {
        runCLI("start")
        setTransientStatus("正在启动...")
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            await refresh()
        }
    }

    @MainActor
    func setTransientStatus(_ text: String) {
        guard let menu = statusItem.menu,
              let first = menu.items.first else { return }
        let attrTitle = NSMutableAttributedString(string: "◌ " + text)
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

    func runCLI(_ command: String) {
        let task = Process()
        if let bundled = bundledBinaryPath() {
            task.executableURL = URL(fileURLWithPath: bundled)
        } else {
            task.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/llm-proxy")
        }
        task.arguments = [command]
        try? task.run()
    }

    @objc func openAdmin() {
        NSWorkspace.shared.open(URL(string: "\(client.baseURL)/admin")!)
    }

    func showError(_ msg: String) {
        let alert = NSAlert()
        alert.messageText = "LLM Proxy"
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
