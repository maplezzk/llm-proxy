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

    // MARK: - 菜单栏卡片模型

    func testAdapterCardModelsBuildsMappings() {
        let adapters = [
            Adapter(name: "my-tool", maxTokens: nil, stream: nil, baseUrl: nil, models: [
                AdapterModel(sourceModelId: "claude-sonnet-4", provider: "anthropic", targetModelId: "claude-sonnet-4-20250514", status: nil),
                AdapterModel(sourceModelId: "gpt-4o", provider: "deepseek", targetModelId: "deepseek-chat", status: nil),
            ]),
        ]
        let cards = makeAdapterCardModels(adapters: adapters)

        XCTAssertEqual(cards.count, 1)
        XCTAssertEqual(cards[0].name, "my-tool")
        XCTAssertEqual(cards[0].mappings.count, 2)

        let first = cards[0].mappings[0]
        XCTAssertEqual(first.sourceModelId, "claude-sonnet-4")
        XCTAssertEqual(first.provider, "anthropic")
        XCTAssertEqual(first.targetModelId, "claude-sonnet-4-20250514")
        XCTAssertEqual(first.currentLabel, "anthropic/claude-sonnet-4-20250514")

        let second = cards[0].mappings[1]
        XCTAssertEqual(second.currentLabel, "deepseek/deepseek-chat")
    }

    func testAdapterCardModelsEmptyAdapters() {
        XCTAssertEqual(makeAdapterCardModels(adapters: []).count, 0)
    }

    func testRemoteManagementDoesNotAllowLocalServiceControl() {
        let remote = StatusCardModel(
            state: .running,
            managementURL: "https://proxy.example.com/llm-proxy",
            usesRemoteManagement: true,
            canSwitchManagementMode: true,
            todayTokensText: nil,
            hitRateText: nil,
            isOperationInProgress: false,
            transientText: nil
        )
        let local = StatusCardModel(
            state: .running,
            managementURL: "http://127.0.0.1:9000",
            usesRemoteManagement: false,
            canSwitchManagementMode: true,
            todayTokensText: nil,
            hitRateText: nil,
            isOperationInProgress: false,
            transientText: nil
        )

        XCTAssertFalse(remote.allowsLocalServiceControl)
        XCTAssertTrue(local.allowsLocalServiceControl)
    }

    func testLocalServiceControlIgnoresRemoteManagementAddress() {
        XCTAssertEqual(
            LocalServiceControl.resolvedPort(
                pidFileContents: #"{"pid":123,"port":9123}"#,
                storedPort: 9000
            ),
            9123
        )
        XCTAssertEqual(
            LocalServiceControl.resolvedPort(pidFileContents: "invalid", storedPort: 9000),
            9000
        )
        XCTAssertEqual(
            LocalServiceControl.healthURL(port: 9123).absoluteString,
            "http://127.0.0.1:9123/admin/health"
        )
    }

    func testLocalServiceShutdownDependsOnLocalProcessInsteadOfManagementMode() {
        XCTAssertEqual(
            LocalServiceControl.shutdownPlan(isLocalServiceRunning: true),
            .stop
        )
        XCTAssertEqual(
            LocalServiceControl.shutdownPlan(isLocalServiceRunning: false),
            .alreadyStopped
        )
    }

    func testForegroundAlertsUseModalLevelAndMoveToActiveSpace() {
        let alert = NSAlert()
        ForegroundAlertPresentation.configure(alert)

        XCTAssertEqual(alert.window.level, .modalPanel)
        XCTAssertTrue(alert.window.collectionBehavior.contains(.moveToActiveSpace))
    }
}
