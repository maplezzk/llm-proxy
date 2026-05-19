import Foundation

/// 获取当前应用版本号
/// - 打包模式（.app）: 从 Info.plist 的 CFBundleShortVersionString 读取
/// - 调试模式（swift run）: 回退到读取 package.json
func currentVersion() -> String {
    // 1. 优先从 Bundle 读取（.app 打包模式）
    if let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
       !version.isEmpty {
        return version
    }

    // 2. 调试模式：从项目根目录的 package.json 读取
    if let packageJSON = loadPackageJSON() {
        return packageJSON.version
    }

    return "0.0.0"
}

private struct PackageJSON: Decodable {
    let version: String
}

private func loadPackageJSON() -> PackageJSON? {
    // 尝试从 Bundle 资源目录向上查找项目根目录
    let bundlePath = Bundle.main.bundlePath

    // 调试模式 bundlePath 类似: .../llm-proxy/app/.build/arm64-apple-macosx/debug
    // 项目根在: .../llm-proxy
    let candidates = [
        // 从 bundle 路径向上查找
        (bundlePath as NSString).deletingLastPathComponent, // .../arm64-apple-macosx
        ((bundlePath as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent, // .../.build
        (((bundlePath as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent, // .../app
        ((((bundlePath as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent, // .../llm-proxy
    ]

    for candidate in candidates {
        let url = URL(fileURLWithPath: candidate).appendingPathComponent("package.json")
        if let data = try? Data(contentsOf: url),
           let pkg = try? JSONDecoder().decode(PackageJSON.self, from: data) {
            return pkg
        }
    }

    return nil
}
