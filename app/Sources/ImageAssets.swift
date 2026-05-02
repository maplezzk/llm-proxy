import AppKit

/// 统一图片资源加载：优先 Bundle.main（.app 打包），回退 Bundle.module（swift run）
private let resourceBundle: Bundle = {
    if Bundle.main.path(forResource: "Assets", ofType: nil) != nil {
        return Bundle.main
    }
    return .module
}()

/// 加载 tray-icon，开发（swift run）和生产（.app）行为一致
func loadTrayIcon() -> NSImage? {
    if let img = resourceBundle.image(forResource: "tray-icon") {
        return img
    }
    // SPM 打包时资源可能在子目录
    if let url = resourceBundle.url(forResource: "tray-icon", withExtension: "png"),
       let img = NSImage(contentsOf: url) {
        return img
    }
    return nil
}
