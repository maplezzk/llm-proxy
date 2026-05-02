import Foundation

/// Localization helper for the macOS app.
/// Uses NSLocalizedString with Bundle.module for SPM resource support.
func loc(_ key: String) -> String {
    return NSLocalizedString(key, bundle: .module, comment: "")
}

func loc(_ key: String, _ args: CVarArg...) -> String {
    let format = NSLocalizedString(key, bundle: .module, comment: "")
    return String(format: format, arguments: args)
}
