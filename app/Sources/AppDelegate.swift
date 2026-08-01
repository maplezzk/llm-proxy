import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var menuBarController: MenuBarController!
    /// 标记是否从菜单栏触发的真正退出
    var shouldReallyQuit = false

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // 清理完成后的第二次 terminate 才真正退出。
        if shouldReallyQuit {
            return .terminateNow
        }

        // Cmd+Q、Dock“退出”和菜单栏“退出”必须走同一套本地代理清理流程。
        // quitApp 完成异步 stop 后会设置 shouldReallyQuit 并再次 terminate。
        if menuBarController != nil {
            Task { @MainActor [weak self] in
                self?.menuBarController.quitApp()
            }
            return .terminateCancel
        }

        // 启动尚未完成、控制器还未建立时没有需要清理的子进程。
        shouldReallyQuit = true
        return .terminateNow
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let btn = statusItem.button else {
            NSLog("[LLMProxy] ❌ statusItem.button 为 nil")
            return
        }
        let img = loadTrayIcon()
        img.isTemplate = true
        btn.image = img
        
        menuBarController = MenuBarController(statusItem: statusItem)
        menuBarController.buildMenu()
        
        // 启动时触发后台更新检查
        menuBarController.checkForUpdatesOnLaunch()
        
        // 启动时自动启动代理服务（如果未运行）
        Task { @MainActor in
            await menuBarController.autoStartIfNeeded()
        }
    }
}
