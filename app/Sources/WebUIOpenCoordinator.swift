import Foundation

struct WebUIOpenResult {
    let url: URL
    let usedHandoff: Bool
    let fallbackReason: String?
}

struct WebUIOpenCoordinator {
    let baseURL: String
    let hasManagementKey: Bool
    let issueHandoff: () async throws -> String

    init(client: APIClient) {
        baseURL = client.baseURL
        hasManagementKey = APIClient.configuredManagementAPIKey() != nil
        issueHandoff = { try await client.createWebUIHandoff() }
    }

    init(
        baseURL: String,
        hasManagementKey: Bool,
        issueHandoff: @escaping () async throws -> String
    ) {
        self.baseURL = baseURL
        self.hasManagementKey = hasManagementKey
        self.issueHandoff = issueHandoff
    }

    func makeOpenResult() async -> WebUIOpenResult? {
        guard let adminURL = Self.adminURL(for: baseURL) else { return nil }
        guard hasManagementKey else {
            return WebUIOpenResult(url: adminURL, usedHandoff: false, fallbackReason: nil)
        }
        guard Self.allowsAutomaticHandoff(adminURL) else {
            return WebUIOpenResult(url: adminURL, usedHandoff: false, fallbackReason: "insecure-http")
        }

        do {
            let code = try await issueHandoff()
            guard code.range(of: "^[A-Za-z0-9_-]{40,128}$", options: .regularExpression) != nil,
                  var components = URLComponents(url: adminURL, resolvingAgainstBaseURL: false) else {
                return WebUIOpenResult(url: adminURL, usedHandoff: false, fallbackReason: "invalid-code")
            }
            components.percentEncodedFragment = "handoff=\(code)&tab=dashboard"
            guard let handoffURL = components.url else {
                return WebUIOpenResult(url: adminURL, usedHandoff: false, fallbackReason: "invalid-url")
            }
            return WebUIOpenResult(url: handoffURL, usedHandoff: true, fallbackReason: nil)
        } catch {
            return WebUIOpenResult(url: adminURL, usedHandoff: false, fallbackReason: "handoff-unavailable")
        }
    }

    static func adminURL(for baseURL: String) -> URL? {
        guard let url = URL(string: baseURL),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let basePath = components.percentEncodedPath.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        components.percentEncodedPath = "\(basePath)/admin"
        components.query = nil
        components.fragment = nil
        return components.url
    }

    static func allowsAutomaticHandoff(_ url: URL) -> Bool {
        if url.scheme?.lowercased() == "https" { return true }
        guard url.scheme?.lowercased() == "http" else { return false }
        let host = url.host?.lowercased() ?? ""
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }
}
