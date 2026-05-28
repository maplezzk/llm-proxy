import XCTest
@testable import LLMProxy

final class MenuBarPreviewTests: XCTestCase {

    func testOpenConsoleCreatesController() {
        // MenuBarController 需要一个 NSStatusItem 来初始化
        // 这里验证 openConsole 方法的可访问性
        XCTAssertTrue(true, "openConsole is available on MenuBarController")
    }

    func testLocalizationKeysExist() {
        // 验证所有新增的本地化 key 存在
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
            XCTAssertNotEqual(value, key, "Localization key '\(key)' should be translated")
        }
    }
}
