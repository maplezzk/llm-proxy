import XCTest
import Foundation
@testable import LLMProxy

/// 回归测试：覆盖历史上让 LLMProxy 闪退的 `JSONSerialization.data(withJSONObject:)`
/// 在非法输入（顶层 String / 嵌套 NSDate 等）下抛 NSException 的场景。
/// Swift 的 `try?` 抓不到 NSException，因此必须在调用前用 `isValidJSONObject` 守卫。
final class JSONFormatterTests: XCTestCase {

    // MARK: - 正常 JSON 路径

    func testDictionaryRoot_returnsPrettyJSON() {
        let value: [String: Any] = ["b": 2, "a": 1]
        let result = JSONFormatter.pretty(value)
        XCTAssertEqual(result, "{\n  \"a\" : 1,\n  \"b\" : 2\n}")
    }

    func testArrayRoot_returnsPrettyJSON() {
        let value: [Any] = [3, 1, 2]
        let result = JSONFormatter.pretty(value)
        XCTAssertEqual(result, "[\n  3,\n  1,\n  2\n]")
    }

    func testNestedDictionaryAndArray() {
        let value: [String: Any] = [
            "name": "test",
            "items": [["id": 1], ["id": 2]],
        ]
        let result = JSONFormatter.pretty(value)
        XCTAssertTrue(result.contains("\"name\" : \"test\""))
        XCTAssertTrue(result.contains("\"items\" : ["))
    }

    // MARK: - 崩溃回归路径

    func testStringRoot_doesNotCrash() {
        // 直接复现 v0.20.0 崩溃路径：responseBody 为 HTML 错误页字符串
        let value = "<html><body>502 Bad Gateway</body></html>"
        let result = JSONFormatter.pretty(value)
        // 顶层是 String：直接展示原文，不带 JSON 引号
        XCTAssertEqual(result, value)
    }

    func testEmptyStringRoot() {
        let result = JSONFormatter.pretty("")
        XCTAssertEqual(result, "")
    }

    func testNumberRoot_doesNotCrash() {
        let result = JSONFormatter.pretty(42)
        // 顶层是数字：fallback 到 Swift 描述
        XCTAssertEqual(result, "42")
    }

    func testDoubleRoot_doesNotCrash() {
        let result = JSONFormatter.pretty(3.14)
        XCTAssertEqual(result, "3.14")
    }

    func testBoolRoot_doesNotCrash() {
        XCTAssertEqual(JSONFormatter.pretty(true), "true")
        XCTAssertEqual(JSONFormatter.pretty(false), "false")
    }

    func testNullRoot_doesNotCrash() {
        let result = JSONFormatter.pretty(NSNull())
        XCTAssertEqual(result, "null")
    }

    func testNestedNonSerializableValue_doesNotCrash() {
        // dict 里嵌套 NSDate：isValidJSONObject 返回 false，应走 fallback
        let value: [String: Any] = [
            "ok": true,
            "timestamp": Date(timeIntervalSince1970: 1700000000),
        ]
        let result = JSONFormatter.pretty(value)
        // 不应崩溃，且包含可读内容（dict 的 fallback 形式）
        XCTAssertFalse(result.isEmpty)
        XCTAssertTrue(result.contains("ok"))
    }

    func testNestedURL_doesNotCrash() {
        let value: [String: Any] = [
            "url": URL(string: "https://example.com")!,
        ]
        let result = JSONFormatter.pretty(value)
        XCTAssertFalse(result.isEmpty)
    }

    func testNestedNSData_doesNotCrash() {
        let value: [String: Any] = [
            "blob": Data([0x00, 0x01, 0x02]),
        ]
        let result = JSONFormatter.pretty(value)
        XCTAssertFalse(result.isEmpty)
    }

    // MARK: - 模拟 TestPanelView 真实输入

    func testAnyCodableStringValue_doesNotCrash() {
        // 模拟崩溃报告里 TestModelResult.responseBody 为非 JSON 字符串的场景
        let anyCodable = AnyCodable("<html><body>Bad Gateway</body></html>")
        let result = JSONFormatter.pretty(anyCodable.value)
        XCTAssertEqual(result, "<html><body>Bad Gateway</body></html>")
    }

    func testAnyCodableDictValue_prettyJSON() {
        // 模拟正常 JSON 响应
        let anyCodable = AnyCodable(["status": "ok", "code": 200])
        let result = JSONFormatter.pretty(anyCodable.value)
        XCTAssertTrue(result.contains("\"status\" : \"ok\""))
        XCTAssertTrue(result.contains("\"code\" : 200"))
    }

    // MARK: - LogsViewModel 场景

    func testLogsDetailsWithMixedValues() {
        // LogsViewModel.formatDetails 的输入：dict 里 value 是 AnyCodable
        let details: [String: AnyCodable] = [
            "status": AnyCodable(200),
            "latency": AnyCodable(150),
            "error": AnyCodable("connection refused"),
            "raw": AnyCodable("<html>504 Gateway Timeout</html>"), // 非 JSON 值
        ]
        var dict: [String: Any] = [:]
        for (k, v) in details { dict[k] = v.value }
        let result = JSONFormatter.pretty(dict)
        XCTAssertTrue(result.contains("\"status\" : 200"))
        XCTAssertTrue(result.contains("\"error\" : \"connection refused\""))
        // raw 字段是 String，嵌套在 dict 里：JSONSerialization 仍能序列化（合法 JSON 字符串）
        XCTAssertTrue(result.contains("504 Gateway Timeout"))
    }
}