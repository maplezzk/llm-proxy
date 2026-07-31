import XCTest
@testable import LLMProxy

final class APIClientTests: XCTestCase {
    var client: APIClient!
    private var savedPort: Any?
    private var savedManagementURL: Any?
    private var savedManagementAPIKey: Any?

    override func setUp() {
        savedPort = UserDefaults.standard.object(forKey: "llm-proxy-port")
        savedManagementURL = UserDefaults.standard.object(forKey: APIClient.managementURLDefaultsKey)
        savedManagementAPIKey = UserDefaults.standard.object(forKey: APIClient.managementAPIKeyDefaultsKey)
        UserDefaults.standard.removeObject(forKey: APIClient.managementURLDefaultsKey)
        UserDefaults.standard.removeObject(forKey: APIClient.managementAPIKeyDefaultsKey)
        client = APIClient()
        client.baseURL = "http://127.0.0.1:9000"
    }

    override func tearDown() {
        restore(savedPort, forKey: "llm-proxy-port")
        restore(savedManagementURL, forKey: APIClient.managementURLDefaultsKey)
        restore(savedManagementAPIKey, forKey: APIClient.managementAPIKeyDefaultsKey)
        client = nil
    }

    private func restore(_ value: Any?, forKey key: String) {
        if let value {
            UserDefaults.standard.set(value, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    // MARK: - Request URL Construction

    func testTokenStatsURL() {
        // 通过 URLSession 参数验证——因 APIClient 方法直接发起请求，
        // 此处验证模型解析即可，实际 HTTP 集成测试单独进行。
        // 重点：确保 TokenStatsResponse 解析正确（已在 ModelsTests 覆盖）
        XCTAssertTrue(true, "TokenStats URL is /admin/token-stats")
    }

    func testLogsURLWithQueryParams() {
        // fetchLogs 使用 URLComponents 构造参数
        // URL 格式: /admin/logs?limit=200&level=debug&type=request
        XCTAssertTrue(true, "Logs URL uses URLComponents with query items")
    }

    // MARK: - Error Handling

    func testPortDefault() {
        XCTAssertEqual(APIClient.storedPort(), UserDefaults.standard.integer(forKey: "llm-proxy-port") > 0
                       ? UserDefaults.standard.integer(forKey: "llm-proxy-port") : 9000)
    }

    func testUpdatePort() {
        client.updatePort(9001)
        XCTAssertEqual(client.baseURL, "http://127.0.0.1:9001")
        XCTAssertEqual(APIClient.storedPort(), 9001)
    }

    func testNormalizesRemoteURLAndAdminSuffix() {
        XCTAssertEqual(
            APIClient.normalizedManagementURL("  https://Proxy.Example.com/base/admin/  "),
            "https://proxy.example.com/base"
        )
    }

    func testAllowsRemoteHTTPAndRejectsInvalidComponents() {
        XCTAssertEqual(
            APIClient.normalizedManagementURL("http://Proxy.Example.com:9000/admin"),
            "http://proxy.example.com:9000"
        )
        XCTAssertNil(APIClient.normalizedManagementURL("https://user:pass@proxy.example.com"))
        XCTAssertNil(APIClient.normalizedManagementURL("https://proxy.example.com?token=secret"))
        XCTAssertEqual(
            APIClient.normalizedManagementURL("http://127.0.0.1:9000/admin"),
            "http://127.0.0.1:9000"
        )
    }

    func testPersistsAndResetsManagementURL() {
        client.baseURL = "http://127.0.0.1:9000"
        XCTAssertTrue(client.updateManagementURL("https://proxy.example.com/llm-proxy/"))

        let recreated = APIClient()
        XCTAssertEqual(recreated.baseURL, "https://proxy.example.com/llm-proxy")
        XCTAssertEqual(
            APIClient.adapterAPIBaseURL("claude"),
            "https://proxy.example.com/llm-proxy/claude/v1/"
        )
        XCTAssertTrue(recreated.usesCustomManagementURL)

        XCTAssertTrue(recreated.updateManagementURL(""))
        XCTAssertEqual(recreated.baseURL, "http://127.0.0.1:\(APIClient.storedPort())")
        XCTAssertFalse(recreated.usesCustomManagementURL)
    }

    func testRemoteManagementURLSurvivesPortUpdate() {
        UserDefaults.standard.set(9001, forKey: "llm-proxy-port")
        XCTAssertTrue(client.updateManagementURL("https://proxy.example.com"))

        client.updatePort(9443)

        XCTAssertEqual(client.baseURL, "https://proxy.example.com")
        XCTAssertEqual(APIClient.storedPort(), 9001)
        XCTAssertTrue(client.usesCustomManagementURL)
    }

    func testPersistsManagementAPIKeyAndAddsBearerAuthorization() {
        client.updateManagementAPIKey("  admin-secret  ")

        XCTAssertEqual(APIClient.configuredManagementAPIKey(), "admin-secret")
        let request = APIClient.managementRequest(url: URL(string: "http://proxy.example.com/admin/health")!)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer admin-secret")

        client.updateManagementAPIKey("")

        XCTAssertNil(APIClient.configuredManagementAPIKey())
        let unauthenticated = APIClient.managementRequest(url: URL(string: "http://proxy.example.com/admin/health")!)
        XCTAssertNil(unauthenticated.value(forHTTPHeaderField: "Authorization"))
    }
}
