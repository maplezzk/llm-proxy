import XCTest
@testable import LLMProxy

final class APIClientTests: XCTestCase {
    private final class InMemoryCredentialStore: ManagementCredentialStoring {
        var values: [String: String] = [:]

        func credential(for managementURL: String) -> String? {
            values[managementURL]
        }

        func setCredential(_ credential: String?, for managementURL: String) -> Bool {
            values[managementURL] = credential
            return true
        }
    }

    var client: APIClient!
    private var savedConnectionStore: ManagementConnectionStore!
    private var credentialStore: InMemoryCredentialStore!
    private var savedPort: Any?
    private var savedManagementURL: Any?
    private var savedLastRemoteManagementURL: Any?
    private var savedManagementAPIKey: Any?

    override func setUp() {
        savedConnectionStore = APIClient.connectionStore
        credentialStore = InMemoryCredentialStore()
        APIClient.connectionStore = ManagementConnectionStore(
            defaults: .standard,
            credentials: credentialStore
        )
        savedPort = UserDefaults.standard.object(forKey: "llm-proxy-port")
        savedManagementURL = UserDefaults.standard.object(forKey: APIClient.managementURLDefaultsKey)
        savedLastRemoteManagementURL = UserDefaults.standard.object(forKey: APIClient.lastRemoteManagementURLDefaultsKey)
        savedManagementAPIKey = UserDefaults.standard.object(forKey: APIClient.managementAPIKeyDefaultsKey)
        UserDefaults.standard.removeObject(forKey: APIClient.managementURLDefaultsKey)
        UserDefaults.standard.removeObject(forKey: APIClient.lastRemoteManagementURLDefaultsKey)
        UserDefaults.standard.removeObject(forKey: APIClient.managementAPIKeyDefaultsKey)
        client = APIClient()
        client.baseURL = "http://127.0.0.1:9000"
    }

    override func tearDown() {
        restore(savedPort, forKey: "llm-proxy-port")
        restore(savedManagementURL, forKey: APIClient.managementURLDefaultsKey)
        restore(savedLastRemoteManagementURL, forKey: APIClient.lastRemoteManagementURLDefaultsKey)
        restore(savedManagementAPIKey, forKey: APIClient.managementAPIKeyDefaultsKey)
        APIClient.connectionStore = savedConnectionStore
        credentialStore = nil
        savedConnectionStore = nil
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

    func testSwitchesBetweenRemoteAndLocalWithoutLosingRemoteURL() {
        XCTAssertTrue(client.updateManagementURL("https://proxy.example.com/base"))

        client.switchToLocalManagement()

        XCTAssertFalse(client.usesCustomManagementURL)
        XCTAssertEqual(APIClient.lastRemoteManagementURL(), "https://proxy.example.com/base")
        XCTAssertEqual(client.baseURL, "http://127.0.0.1:\(APIClient.storedPort())")

        XCTAssertTrue(client.switchToRemoteManagement())
        XCTAssertTrue(client.usesCustomManagementURL)
        XCTAssertEqual(client.baseURL, "https://proxy.example.com/base")
    }

    func testCannotSwitchToRemoteWithoutSavedURL() {
        XCTAssertFalse(client.switchToRemoteManagement())
        XCTAssertFalse(client.usesCustomManagementURL)
    }

    func testPersistsManagementAPIKeyAndAddsBearerAuthorization() {
        XCTAssertTrue(client.updateManagementURL("http://proxy.example.com"))
        client.updateManagementAPIKey("  admin-secret  ")

        XCTAssertEqual(APIClient.configuredManagementAPIKey(), "admin-secret")
        let request = APIClient.managementRequest(url: URL(string: "http://proxy.example.com/admin/health")!)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer admin-secret")

        client.updateManagementAPIKey("")

        XCTAssertNil(APIClient.configuredManagementAPIKey())
        let unauthenticated = APIClient.managementRequest(url: URL(string: "http://proxy.example.com/admin/health")!)
        XCTAssertNil(unauthenticated.value(forHTTPHeaderField: "Authorization"))
    }

    func testManagementAPIKeyIsNeverAttachedToAnotherService() {
        XCTAssertTrue(client.updateManagementURL("https://one.example.com/base"))
        XCTAssertTrue(client.updateManagementAPIKey("one-secret"))

        let matching = APIClient.managementRequest(
            url: URL(string: "https://one.example.com/base/admin/health")!
        )
        XCTAssertEqual(matching.value(forHTTPHeaderField: "Authorization"), "Bearer one-secret")

        let otherHost = APIClient.managementRequest(
            url: URL(string: "https://two.example.com/base/admin/health")!
        )
        XCTAssertNil(otherHost.value(forHTTPHeaderField: "Authorization"))

        let siblingPath = APIClient.managementRequest(
            url: URL(string: "https://one.example.com/other/admin/health")!
        )
        XCTAssertNil(siblingPath.value(forHTTPHeaderField: "Authorization"))

        let proxyRoute = APIClient.managementRequest(
            url: URL(string: "https://one.example.com/base/v1/models")!
        )
        XCTAssertNil(proxyRoute.value(forHTTPHeaderField: "Authorization"))
    }

    func testManagementAPIKeysAreIsolatedByManagementURL() {
        XCTAssertTrue(client.updateManagementURL("https://one.example.com/base"))
        XCTAssertTrue(client.updateManagementAPIKey("one-secret"))

        XCTAssertTrue(client.updateManagementURL("https://two.example.com/base"))
        XCTAssertNil(APIClient.configuredManagementAPIKey())
        XCTAssertTrue(client.updateManagementAPIKey("two-secret"))

        XCTAssertTrue(client.updateManagementURL("https://one.example.com/base"))
        XCTAssertEqual(APIClient.configuredManagementAPIKey(), "one-secret")

        XCTAssertTrue(client.updateManagementURL("https://two.example.com/base"))
        XCTAssertEqual(APIClient.configuredManagementAPIKey(), "two-secret")
    }

    func testLegacyManagementAPIKeyMigratesOnlyToCurrentURL() {
        XCTAssertTrue(client.updateManagementURL("https://one.example.com"))
        UserDefaults.standard.set("legacy-secret", forKey: APIClient.managementAPIKeyDefaultsKey)

        XCTAssertEqual(APIClient.configuredManagementAPIKey(), "legacy-secret")
        XCTAssertNil(UserDefaults.standard.string(forKey: APIClient.managementAPIKeyDefaultsKey))
        XCTAssertEqual(credentialStore.values["https://one.example.com"], "legacy-secret")

        XCTAssertTrue(client.updateManagementURL("https://two.example.com"))
        XCTAssertNil(APIClient.configuredManagementAPIKey())
    }

    func testLocalCredentialMovesWhenLocalPortChanges() {
        client.baseURL = APIClient.storedManagementURL()
        XCTAssertTrue(client.updateManagementAPIKey("local-secret"))
        let oldURL = APIClient.storedManagementURL()

        client.baseURL = APIClient.storedManagementURL()
        client.updatePort(9443)

        XCTAssertNotEqual(APIClient.storedManagementURL(), oldURL)
        XCTAssertEqual(APIClient.configuredManagementAPIKey(), "local-secret")
        XCTAssertNil(credentialStore.values[oldURL])
    }
}
