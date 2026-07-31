import Foundation
import Security

protocol ManagementCredentialStoring: AnyObject {
    func credential(for managementURL: String) -> String?
    @discardableResult
    func setCredential(_ credential: String?, for managementURL: String) -> Bool
}

final class KeychainManagementCredentialStore: ManagementCredentialStoring {
    private let service: String

    init(service: String = "com.maplezzk.llm-proxy.management-api") {
        self.service = service
    }

    func credential(for managementURL: String) -> String? {
        var query = baseQuery(for: managementURL)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true

        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    @discardableResult
    func setCredential(_ credential: String?, for managementURL: String) -> Bool {
        let query = baseQuery(for: managementURL)
        guard let credential else {
            let status = SecItemDelete(query as CFDictionary)
            return status == errSecSuccess || status == errSecItemNotFound
        }

        let trimmed = credential.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else {
            return setCredential(nil, for: managementURL)
        }

        let updateStatus = SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updateStatus == errSecSuccess { return true }
        guard updateStatus == errSecItemNotFound else { return false }

        var attributes = query
        attributes[kSecValueData as String] = data
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }

    private func baseQuery(for managementURL: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: managementURL,
        ]
    }
}

final class ManagementConnectionStore {
    static let managementURLDefaultsKey = "llm-proxy-management-url"
    static let lastRemoteManagementURLDefaultsKey = "llm-proxy-last-remote-management-url"
    static let legacyManagementAPIKeyDefaultsKey = "llm-proxy-management-api-key"
    static let localPortDefaultsKey = "llm-proxy-port"

    private let defaults: UserDefaults
    private let credentials: ManagementCredentialStoring

    init(
        defaults: UserDefaults = .standard,
        credentials: ManagementCredentialStoring = KeychainManagementCredentialStore()
    ) {
        self.defaults = defaults
        self.credentials = credentials
    }

    func storedPort() -> Int {
        let stored = defaults.integer(forKey: Self.localPortDefaultsKey)
        return stored > 0 ? stored : 9000
    }

    func localManagementURL() -> String {
        "http://127.0.0.1:\(storedPort())"
    }

    func configuredManagementURL() -> String? {
        guard let stored = defaults.string(forKey: Self.managementURLDefaultsKey) else {
            return nil
        }
        return Self.normalizedManagementURL(stored)
    }

    func lastRemoteManagementURL() -> String? {
        if let stored = defaults.string(forKey: Self.lastRemoteManagementURLDefaultsKey),
           let normalized = Self.normalizedManagementURL(stored) {
            return normalized
        }
        return configuredManagementURL()
    }

    func storedManagementURL() -> String {
        configuredManagementURL() ?? localManagementURL()
    }

    @discardableResult
    func updateManagementURL(_ input: String) -> Bool {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            if let current = configuredManagementURL() {
                defaults.set(current, forKey: Self.lastRemoteManagementURLDefaultsKey)
            }
            defaults.removeObject(forKey: Self.managementURLDefaultsKey)
            return true
        }
        guard let normalized = Self.normalizedManagementURL(trimmed) else { return false }
        defaults.set(normalized, forKey: Self.managementURLDefaultsKey)
        defaults.set(normalized, forKey: Self.lastRemoteManagementURLDefaultsKey)
        return true
    }

    func switchToLocalManagement() {
        _ = updateManagementURL("")
    }

    @discardableResult
    func switchToRemoteManagement() -> Bool {
        guard let remoteURL = lastRemoteManagementURL() else { return false }
        defaults.set(remoteURL, forKey: Self.managementURLDefaultsKey)
        return true
    }

    func configuredManagementAPIKey() -> String? {
        let managementURL = storedManagementURL()
        return configuredManagementAPIKey(for: managementURL)
    }

    /// Read the credential for an explicitly captured connection. Callers that
    /// are about to send a request must not re-resolve the active URL after the
    /// request target has already been constructed, otherwise a concurrent mode
    /// switch could attach the next service's credential to the previous URL.
    func configuredManagementAPIKey(for managementURL: String) -> String? {
        if let stored = credentials.credential(for: managementURL) {
            return stored
        }

        // 升级兼容：旧版本只有一个全局明文值。首次读取时仅绑定到当前连接，
        // 避免之后切换服务时把同一凭据发送到其他地址。
        guard let legacy = defaults.string(forKey: Self.legacyManagementAPIKeyDefaultsKey) else {
            return nil
        }
        let trimmed = legacy.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            defaults.removeObject(forKey: Self.legacyManagementAPIKeyDefaultsKey)
            return nil
        }
        if credentials.setCredential(trimmed, for: managementURL) {
            defaults.removeObject(forKey: Self.legacyManagementAPIKeyDefaultsKey)
        }
        return trimmed
    }

    @discardableResult
    func updateManagementAPIKey(_ input: String) -> Bool {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let saved = credentials.setCredential(trimmed.isEmpty ? nil : trimmed, for: storedManagementURL())
        if saved {
            defaults.removeObject(forKey: Self.legacyManagementAPIKeyDefaultsKey)
        }
        return saved
    }

    func updateLocalPort(_ port: Int) {
        let oldURL = localManagementURL()
        defaults.set(port, forKey: Self.localPortDefaultsKey)
        let newURL = localManagementURL()
        guard oldURL != newURL,
              credentials.credential(for: newURL) == nil,
              let oldCredential = credentials.credential(for: oldURL),
              credentials.setCredential(oldCredential, for: newURL) else {
            return
        }
        _ = credentials.setCredential(nil, for: oldURL)
    }

    static func normalizedManagementURL(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              scheme == "https" || scheme == "http" else {
            return nil
        }

        components.scheme = scheme
        components.host = host

        var path = components.percentEncodedPath
        while path.count > 1 && path.hasSuffix("/") {
            path.removeLast()
        }
        if path == "/admin" {
            path = ""
        } else if path.hasSuffix("/admin") {
            path.removeLast("/admin".count)
        }
        components.percentEncodedPath = path

        guard let normalized = components.url?.absoluteString else { return nil }
        return normalized.hasSuffix("/") ? String(normalized.dropLast()) : normalized
    }
}
