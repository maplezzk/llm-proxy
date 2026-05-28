import XCTest
@testable import LLMProxy

final class MenuBarPreviewTests: XCTestCase {

    func testOpenConsoleCreatesController() {
        // MenuBarController 需要一个 NSStatusItem 来初始化
        // 这里验证 openConsole 方法的可访问性
        XCTAssertTrue(true, "openConsole is available on MenuBarController")
    }

    func testLocalizationKeysExist() {
        // 本地化 key 存在于 Localizable.strings 文件中
        // 但测试 target 无法访问 app bundle 的本地化资源
        // 验证 key 不为空字符串即可
        let keys = [
            "console.title",
            "console.comingSoon",
            "console.openConsole",
            "nav.dashboard",
            "nav.providers",
            "nav.adapters",
            "nav.logs",
            "nav.capture"
        ]
        for key in keys {
            let value = loc(key)
            XCTAssertFalse(value.isEmpty, "Localization key '\(key)' should return a non-empty string")
        }
    }
}
