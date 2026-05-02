import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var menuBarController: MenuBarController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button, let img = loadTrayIcon() {
            img.isTemplate = true
            btn.image = img
        }
        menuBarController = MenuBarController(statusItem: statusItem)
        menuBarController.buildMenu()
    }
}
