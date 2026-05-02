import AppKit

/// 加载 tray-icon，开发（swift run）和生产（.app）行为一致
func loadTrayIcon() -> NSImage? {
    // 依次尝试所有可能的 bundle
    for bundle in [Bundle.main, Bundle.module] {
        if let url = bundle.url(forResource: "tray-icon", withExtension: "png") {
            return NSImage(contentsOf: url)
        }
    }
    NSLog("[LLMProxy] 无法加载 tray-icon.png")
    return nil
}
