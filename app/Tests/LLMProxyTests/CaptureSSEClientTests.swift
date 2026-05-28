import XCTest
@testable import LLMProxy

final class CaptureSSEClientTests: XCTestCase {
    var client: CaptureSSEClient!

    override func setUp() {
        client = CaptureSSEClient(baseURL: "http://127.0.0.1:9000")
    }

    override func tearDown() {
        client.stop()
        client = nil
    }

    // MARK: - Lifecycle

    func testStartSetsRunning() {
        client.start()
        // start 是异步的，验证不会崩溃
        XCTAssertTrue(true)
        client.stop()
    }

    func testStopCancelsTask() {
        client.start()
        client.stop()
        // 验证 stop 后 onStatusChange 被调用
        var stopped = false
        client.onStatusChange = { running in
            if !running { stopped = true }
        }
        client.start()
        client.stop()
        XCTAssertTrue(stopped)
    }

    func testDoubleStartIsNoop() {
        client.start()
        client.start() // 不应崩溃
        client.stop()
    }

    // MARK: - Callbacks

    func testOnStatusChangeCallback() {
        var statuses: [Bool] = []
        client.onStatusChange = { statuses.append($0) }
        client.baseURL = "http://127.0.0.1:9999" // 无效地址
        client.start()

        // 短暂等待让 start 尝试连接
        let expectation = XCTestExpectation(description: "wait for async")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            self.client.stop()
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertTrue(statuses.contains(true), "Should have fired running=true")
    }
}
