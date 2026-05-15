import AppKit

private let _trayIcon: NSImage = {
    // 加载自定义 PNG（开发和生产一致），只创建一次避免重复设置导致图标消失
    if let url = Bundle.main.url(forResource: "tray-icon", withExtension: "png") {
        return NSImage(contentsOf: url) ?? NSImage()
    }
    if let url = Bundle.module.url(forResource: "tray-icon", withExtension: "png") {
        return NSImage(contentsOf: url) ?? NSImage()
    }
    NSLog("[LLMProxy] 无法加载 tray-icon.png，使用空图标")
    return NSImage()
}()

/// 返回缓存的菜单栏图标（只创建一次，避免重复新建导致图标消失）
func loadTrayIcon() -> NSImage {
    return _trayIcon
}
