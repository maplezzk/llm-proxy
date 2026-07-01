import Foundation

/// 把任意 JSON 兼容值安全地格式化为可读 JSON 字符串。
///
/// 与直接调用 `JSONSerialization.data(withJSONObject:)` 不同：
/// - 顶层是 String/Number/Bool/Null 时不会触发 `NSException`（Foundation 会对非 array/dict 顶层 raise）
/// - 包含非 JSON 兼容子类型（NSDate / NSData / URL / 非有限浮点等）时降级为可读描述
/// - 输入完全不合法时返回 `"\(value)"` 的 Swift 描述，绝不崩溃
enum JSONFormatter {
    /// 将任意 JSON 兼容值格式化为美化 JSON 字符串。
    /// - Parameter value: 任意 JSON 值（NSArray / NSDictionary 树，或基础类型）
    /// - Returns: 美化后的 JSON 字符串；失败时返回输入的字符串描述
    static func pretty(_ value: Any) -> String {
        // 顶层是 String：直接展示原文（不带 JSON 引号），避免触发 NSException
        if let s = value as? String { return s }
        // 顶层是 NSNull：显示 null
        if value is NSNull { return "null" }

        // 顶层必须是 array 或 dict，否则 NSJSONSerialization 会 raise NSException
        guard value is NSArray || value is NSDictionary else {
            return "\(value)"
        }

        // 二次校验：含 NSDate / NSData / 非有限浮点等不可序列化值时返回 false
        // 此处绝不会再触发 NSException（isValidJSONObject 是查询接口）
        guard JSONSerialization.isValidJSONObject(value) else {
            return "\(value)"
        }

        guard let data = try? JSONSerialization.data(
            withJSONObject: value,
            options: [.prettyPrinted, .sortedKeys]
        ), let str = String(data: data, encoding: .utf8) else {
            return "\(value)"
        }
        return str
    }
}