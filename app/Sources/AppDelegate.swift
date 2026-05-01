import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var menuBarController: MenuBarController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            if let img = Bundle.main.image(forResource: "tray-icon") {
                img.isTemplate = true
                btn.image = img
            } else {
                btn.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: "LLM Proxy")
                btn.image?.isTemplate = true
            }
        }
        menuBarController = MenuBarController(statusItem: statusItem)
        menuBarController.buildMenu()
    }
}
