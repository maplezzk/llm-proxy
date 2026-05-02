import Foundation

/// 优先用 Bundle.main（.app 打包），回退到 Bundle.module（swift run 调试）
private let localizationBundle: Bundle = {
    // 检查 .app bundle 的 Resources 中是否有本地化文件
    if Bundle.main.path(forResource: "en", ofType: "lproj") != nil {
        return Bundle.main
    }
    // swift run 调试模式走 SPM module bundle
    return .module
}()

func loc(_ key: String) -> String {
    return NSLocalizedString(key, bundle: localizationBundle, comment: "")
}

func loc(_ key: String, _ args: CVarArg...) -> String {
    let format = NSLocalizedString(key, bundle: localizationBundle, comment: "")
    return String(format: format, arguments: args)
}
