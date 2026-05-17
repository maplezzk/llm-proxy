import AppKit

/// 创建菜单栏图标的 NSImage，包含 1x、2x、3x 多重分辨率表示
/// macOS 会根据当前屏幕缩放比例自动选择最佳表示，确保菜单栏图标清晰锐利
private func _createTrayIcon() -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18))

    // 从 Bundle.main 加载（生产构建），失败再尝试安全方式访问 SPM bundle
    // ⚠️ 不使用 Bundle.module，因为其 fatalError 在 bundle 缺失时直接崩溃
    func safeLoad(name: String, size: NSSize) -> NSImageRep? {
        // 先试 Bundle.main（生产构建，PNG 在 Resources 目录下）
        if let url = Bundle.main.url(forResource: name, withExtension: "png"),
           let rep = NSImageRep(contentsOf: url) {
            rep.size = size
            return rep
        }
        // 安全方式访问 SPM resource bundle，不会崩溃
        let bundlePath = Bundle.main.bundleURL.appendingPathComponent("LLMProxy_LLMProxy.bundle").path
        if FileManager.default.fileExists(atPath: bundlePath),
           let bundle = Bundle(path: bundlePath),
           let url = bundle.url(forResource: name, withExtension: "png"),
           let rep = NSImageRep(contentsOf: url) {
            rep.size = size
            return rep
        }
        return nil
    }

    // 注册 1x 表示（18×18 像素）
    let pointSize = NSSize(width: 18, height: 18)
    if let rep = safeLoad(name: "tray-icon", size: pointSize) {
        image.addRepresentation(rep)
    } else {
        NSLog("[LLMProxy] ⚠️ 无法加载 tray-icon.png")
    }

    // 注册 @2x 表示（36×36 像素，逻辑尺寸 18pt）
    if let rep = safeLoad(name: "tray-icon@2x", size: pointSize) {
        image.addRepresentation(rep)
    }

    // 注册 @3x 表示（54×54 像素，逻辑尺寸 18pt）
    if let rep = safeLoad(name: "tray-icon@3x", size: pointSize) {
        image.addRepresentation(rep)
    }

    return image
}

private let _trayIcon: NSImage = {
    let icon = _createTrayIcon()
    icon.isTemplate = true
    return icon
}()

/// 返回缓存的菜单栏图标（只创建一次，避免重复新建导致图标消失）
func loadTrayIcon() -> NSImage {
    return _trayIcon
}
