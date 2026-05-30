import XCTest
@testable import LLMProxy

final class ConsoleWindowControllerTests: XCTestCase {

    func testWindowCreation() {
        let controller = ConsoleWindowController()
        XCTAssertNotNil(controller.window, "Window should be created")
        XCTAssertEqual(controller.window?.title, loc("console.title"))
    }

    func testShowActivatesWindow() {
        let controller = ConsoleWindowController()
        controller.show()
        // 验证窗口可见
        XCTAssertTrue(controller.window?.isVisible == true)
    }

    func testMultipleCallsCreateNewWindows() {
        let controller1 = ConsoleWindowController()
        controller1.show()
        let controller2 = ConsoleWindowController()
        controller2.show()

        // 每次创建新窗口（不共享）
        XCTAssertNotEqual(
            ObjectIdentifier(controller1),
            ObjectIdentifier(controller2),
            "Each openConsole creates a new ConsoleWindowController"
        )
        XCTAssertNotEqual(controller1.window, controller2.window)
    }
}
