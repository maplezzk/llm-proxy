import XCTest
@testable import LLMProxy

final class WebUIOpenCoordinatorTests: XCTestCase {
    func testHTTPSManagementURLUsesHandoffFragment() async {
        let code = String(repeating: "a", count: 43)
        let coordinator = WebUIOpenCoordinator(
            baseURL: "https://proxy.example.com/base",
            hasManagementKey: true,
            issueHandoff: { code }
        )

        let result = await coordinator.makeOpenResult()

        XCTAssertEqual(result?.url.absoluteString, "https://proxy.example.com/base/admin#handoff=\(code)&tab=dashboard")
        XCTAssertEqual(result?.usedHandoff, true)
    }

    func testRemoteHTTPFallsBackWithoutSendingCredential() async {
        var issued = false
        let coordinator = WebUIOpenCoordinator(
            baseURL: "http://proxy.example.com:9000",
            hasManagementKey: true,
            issueHandoff: {
                issued = true
                return String(repeating: "a", count: 43)
            }
        )

        let result = await coordinator.makeOpenResult()

        XCTAssertEqual(result?.url.absoluteString, "http://proxy.example.com:9000/admin")
        XCTAssertEqual(result?.fallbackReason, "insecure-http")
        XCTAssertFalse(issued)
    }

    func testLoopbackHTTPAllowsHandoff() async {
        let code = String(repeating: "b", count: 43)
        let coordinator = WebUIOpenCoordinator(
            baseURL: "http://127.0.0.1:9000",
            hasManagementKey: true,
            issueHandoff: { code }
        )

        let result = await coordinator.makeOpenResult()
        XCTAssertEqual(result?.usedHandoff, true)
    }

    func testMissingKeyAndOldServerFailureOpenPlainAdminPage() async {
        let withoutKey = WebUIOpenCoordinator(
            baseURL: "https://proxy.example.com",
            hasManagementKey: false,
            issueHandoff: { XCTFail("should not issue handoff"); return "" }
        )
        let withoutKeyResult = await withoutKey.makeOpenResult()
        XCTAssertEqual(withoutKeyResult?.url.absoluteString, "https://proxy.example.com/admin")

        let unavailable = WebUIOpenCoordinator(
            baseURL: "https://proxy.example.com",
            hasManagementKey: true,
            issueHandoff: { throw URLError(.unsupportedURL) }
        )
        let fallback = await unavailable.makeOpenResult()
        XCTAssertEqual(fallback?.url.absoluteString, "https://proxy.example.com/admin")
        XCTAssertEqual(fallback?.fallbackReason, "handoff-unavailable")
    }
}
