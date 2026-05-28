import AppKit
import SwiftUI

/// 控制台窗口控制器——每次新建，关闭即销毁
class ConsoleWindowController: NSWindowController {

    convenience init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = loc("console.title")
        window.center()

        // 用 NSHostingView 嵌入 SwiftUI 根视图
        let rootView = ConsoleRootView()
        window.contentView = NSHostingView(rootView: rootView)

        self.init(window: window)
    }

    func show() {
        guard let window = window else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
