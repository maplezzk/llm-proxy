import AppKit

/// 加载 tray-icon，开发（swift run）和生产（.app）行为一致
func loadTrayIcon() -> NSImage? {
    // 优先 Bundle.main（.app 打包），回退到 Bundle.module（swift run 调试）
    // 注意：不用数组字面量，避免立即初始化 Bundle.module 导致 crash
    if let url = Bundle.main.url(forResource: "tray-icon", withExtension: "png") {
        return NSImage(contentsOf: url)
    }
    if let url = Bundle.module.url(forResource: "tray-icon", withExtension: "png") {
        return NSImage(contentsOf: url)
    }
    NSLog("[LLMProxy] 无法加载 tray-icon.png")
    return nil
}
