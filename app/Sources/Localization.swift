import Foundation

/// 优先用 Bundle.main（.app 打包），回退到 Bundle.module（swift run 调试）
private let localizationBundle: Bundle = {
    if Bundle.main.path(forResource: "en", ofType: "lproj") != nil {
        return Bundle.main
    }
    return .module
}()

/// 获取当前语言：UserDefaults > 系统语言
func currentLang() -> String {
    let stored = UserDefaults.standard.string(forKey: "llm-proxy-lang")
    if stored == "zh" || stored == "en" { return stored! }
    // 系统语言检测
    let sysLang = Bundle.main.preferredLocalizations.first ?? "en"
    return sysLang.hasPrefix("zh") ? "zh" : "en"
}

/// 切换语言并持久化
func switchLang(_ lang: String) {
    UserDefaults.standard.set(lang, forKey: "llm-proxy-lang")
}

/// 获取指定语言的 Bundle
private func bundleForLang(_ lang: String) -> Bundle {
    if let path = localizationBundle.path(forResource: lang, ofType: "lproj"),
       let b = Bundle(path: path) {
        return b
    }
    return localizationBundle
}

func loc(_ key: String) -> String {
    let lang = currentLang()
    let bundle = bundleForLang(lang)
    return bundle.localizedString(forKey: key, value: nil, table: nil)
}

func loc(_ key: String, _ args: CVarArg...) -> String {
    let format = loc(key)
    return String(format: format, arguments: args)
}
