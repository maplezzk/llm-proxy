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
        window.minSize = NSSize(width: 600, height: 400)
        window.center()

        // 用 NSHostingView 嵌入 SwiftUI 根视图
        let rootView = ConsoleRootView()
        window.contentView = NSHostingView(rootView: rootView)

        self.init(window: window)
    }

    func show() {
        guard let window = window else { return }
        setupMainMenu()
        // 显示 Dock 图标
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // 窗口关闭时隐藏 Dock 图标
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            // willClose 时窗口尚未隐藏，延迟到下一个 runloop 再检查
            DispatchQueue.main.async {
                self?.windowDidClose()
            }
        }
    }

    private func windowDidClose() {
        // 所有窗口关闭后恢复为 accessory（仅菜单栏）
        let visibleWindows = NSApp.windows.filter { $0.isVisible && !$0.className.contains("StatusBar") }
        if visibleWindows.isEmpty {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    // MARK: - Main Menu

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        // App menu
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: loc("menu.about"), action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: loc("menu.settings"), action: #selector(openSettings), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: loc("menu.hide"), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: loc("menu.hideOthers"), action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: loc("menu.showAll"), action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: loc("menu.quit"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appMenuItem = NSMenuItem()
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // Edit menu
        let editMenu = NSMenu(title: loc("menu.edit"))
        editMenu.addItem(withTitle: loc("menu.undo"), action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: loc("menu.redo"), action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: loc("menu.cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: loc("menu.copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: loc("menu.paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: loc("menu.selectAll"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editMenuItem = NSMenuItem()
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // View menu
        let viewMenu = NSMenu(title: loc("menu.view"))
        let fullScreen = viewMenu.addItem(withTitle: loc("menu.fullScreen"), action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        let viewMenuItem = NSMenuItem()
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // Window menu
        let windowMenu = NSMenu(title: loc("menu.window"))
        windowMenu.addItem(withTitle: loc("menu.minimize"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: loc("menu.close"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let windowMenuItem = NSMenuItem()
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)
        NSApp.windowsMenu = windowMenu

        // Help menu
        let helpMenu = NSMenu(title: loc("menu.help"))
        let helpMenuItem = NSMenuItem()
        helpMenuItem.submenu = helpMenu
        mainMenu.addItem(helpMenuItem)
        NSApp.helpMenu = helpMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func openSettings() {
        NotificationCenter.default.post(name: .openSettings, object: nil)
    }
}

extension Notification.Name {
    static let openSettings = Notification.Name("com.llmproxy.openSettings")
}
