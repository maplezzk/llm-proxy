import Foundation

class APIClient {
    var baseURL: String

    init() {
        let port = Self.storedPort()
        self.baseURL = "http://127.0.0.1:\(port)"
    }

    /// 从 UserDefaults 读取端口，默认 9000
    static func storedPort() -> Int {
        let stored = UserDefaults.standard.integer(forKey: "llm-proxy-port")
        return stored > 0 ? stored : 9000
    }

    /// 更新 baseURL（端口变更时调用）
    func updatePort(_ port: Int) {
        UserDefaults.standard.set(port, forKey: "llm-proxy-port")
        baseURL = "http://127.0.0.1:\(port)"
    }

    func fetchLogLevel() async throws -> String {
        let url = URL(string: "\(baseURL)/admin/log-level")!
        let (data, _) = try await URLSession.shared.data(from: url)
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let d = json["data"] as? [String: Any],
           let level = d["level"] as? String { return level }
        return "info"
    }

    func setLogLevel(_ level: String) async throws {
        let url = URL(string: "\(baseURL)/admin/log-level")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["level": level])
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }

    func fetchHealth() async throws -> Bool {
        let url = URL(string: "\(baseURL)/admin/health")!
        let (data, resp) = try await URLSession.shared.data(from: url)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return false }
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return json["success"] as? Bool ?? false
        }
        return false
    }

    func fetchConfig() async throws -> ConfigResponse {
        let url = URL(string: "\(baseURL)/admin/config")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(ConfigResponse.self, from: data)
    }

    func fetchAdapters() async throws -> AdaptersResponse {
        let url = URL(string: "\(baseURL)/admin/adapters")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(AdaptersResponse.self, from: data)
    }

    func reloadConfig() async throws {
        let url = URL(string: "\(baseURL)/admin/config/reload")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }

    func updateAdapter(_ adapter: Adapter, mappings: [UpdateModelMapping]) async throws {
        let url = URL(string: "\(baseURL)/admin/adapters/\(adapter.name)")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = UpdateAdapterBody(name: adapter.name, type: adapter.type, models: mappings)
        req.httpBody = try JSONEncoder().encode(body)
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }

    func fetchLocale() async throws -> String {
        let url = URL(string: "\(baseURL)/admin/locale")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        if let d = json?["data"] as? [String: Any], let locale = d["locale"] as? String {
            return locale
        }
        return "en"
    }

    func setLocale(_ locale: String) async throws {
        let url = URL(string: "\(baseURL)/admin/locale")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["locale": locale])
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }

    func fetchPort() async throws -> Int? {
        let url = URL(string: "\(baseURL)/admin/port")!
        let (data, _) = try await URLSession.shared.data(from: url)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let d = json["data"] as? [String: Any] else { return nil }
        return d["port"] as? Int
    }

    func setPort(_ port: Int?) async throws {
        let url = URL(string: "\(baseURL)/admin/port")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var bodyDict: [String: Any] = [:]
        if let p = port {
            bodyDict["port"] = p
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: bodyDict)
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }
}
