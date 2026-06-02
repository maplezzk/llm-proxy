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
        // 从菜单栏“退出”触发的才真正退出
        if shouldReallyQuit {
            return .terminateNow
        }
        // 否则（Dock 右键退出 / Cmd+Q）：关闭控制台窗口，隐藏 Dock 图标
        for window in NSApp.windows where window.isVisible && !window.className.contains("StatusBar") {
            window.close()
        }
        NSApp.setActivationPolicy(.accessory)
        return .terminateCancel
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
