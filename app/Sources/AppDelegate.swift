import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var menuBarController: MenuBarController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let btn = statusItem.button else {
            NSLog("[LLMProxy] ❌ statusItem.button 为 nil")
            return
        }
        guard let img = loadTrayIcon() else {
            NSLog("[LLMProxy] ❌ 无法加载 tray-icon")
            // 设置颜色占位，至少能看到菜单栏有条目
            btn.image = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: "LLM Proxy")
            btn.image?.isTemplate = true
            menuBarController = MenuBarController(statusItem: statusItem)
            menuBarController.buildMenu()
            return
        }
        img.isTemplate = true
        btn.image = img
        menuBarController = MenuBarController(statusItem: statusItem)
        menuBarController.buildMenu()
    }
}
