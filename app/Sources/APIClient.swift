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

    // MARK: - Token Stats

    func fetchTokenStats() async throws -> TokenStats {
        let url = URL(string: "\(baseURL)/admin/token-stats")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let resp = try JSONDecoder().decode(TokenStatsResponse.self, from: data)
        guard resp.success, let stats = resp.data else {
            throw URLError(.cannotParseResponse)
        }
        return stats
    }

    // MARK: - Logs

    func fetchLogs(limit: Int = 200, before: Int? = nil, level: String? = nil, type: String? = nil, date: String? = nil) async throws -> LogsData {
        var components = URLComponents(string: "\(baseURL)/admin/logs")!
        var queryItems: [URLQueryItem] = [URLQueryItem(name: "limit", value: String(limit))]
        if let before = before { queryItems.append(URLQueryItem(name: "before", value: String(before))) }
        if let level = level { queryItems.append(URLQueryItem(name: "level", value: level)) }
        if let type = type { queryItems.append(URLQueryItem(name: "type", value: type)) }
        if let date = date { queryItems.append(URLQueryItem(name: "date", value: date)) }
        components.queryItems = queryItems
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        let resp = try JSONDecoder().decode(LogsResponse.self, from: data)
        guard resp.success, let logsData = resp.data else {
            throw URLError(.cannotParseResponse)
        }
        return logsData
    }

    // MARK: - Capture

    func fetchCaptureStatus() async throws -> Bool {
        let url = URL(string: "\(baseURL)/admin/debug/captures/status")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let resp = try JSONDecoder().decode(CaptureStatusResponse.self, from: data)
        guard resp.success, let status = resp.data else {
            throw URLError(.cannotParseResponse)
        }
        return status.enabled
    }

    func setCaptureControl(enabled: Bool, clear: Bool = false) async throws -> Bool {
        let url = URL(string: "\(baseURL)/admin/debug/captures/control")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["enabled": enabled, "clear": clear])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let result = try JSONDecoder().decode(CaptureControlResponse.self, from: data)
        return result.data?.enabled ?? false
    }

    // MARK: - Providers CRUD

    func fetchProviders() async throws -> [ProviderDetail] {
        let url = URL(string: "\(baseURL)/admin/config")!
        let (data, _) = try await URLSession.shared.data(from: url)
        if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
           let d = json["data"] as? [String: Any],
           let providers = d["providers"] as? [[String: Any]] {
            let jsonData = try JSONSerialization.data(withJSONObject: providers)
            return try JSONDecoder().decode([ProviderDetail].self, from: jsonData)
        }
        throw URLError(.cannotParseResponse)
    }

    func createProvider(name: String, type: String, apiKey: String, apiBase: String, models: [ProviderModelInput]) async throws {
        let url = URL(string: "\(baseURL)/admin/providers")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = CreateProviderBody(name: name, type: type, api_key: apiKey, api_base: apiBase, models: models)
        req.httpBody = try JSONEncoder().encode(body)
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }

    func updateProvider(name: String, type: String, apiKey: String, apiBase: String, models: [ProviderModelInput]) async throws {
        let url = URL(string: "\(baseURL)/admin/providers/\(name)")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = UpdateProviderBody(name: name, type: type, api_key: apiKey, api_base: apiBase, models: models)
        req.httpBody = try JSONEncoder().encode(body)
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }

    func deleteProvider(name: String) async throws {
        let url = URL(string: "\(baseURL)/admin/providers/\(name)")!
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }

    func pullModels(providerName: String) async throws -> PullModelsData {
        let url = URL(string: "\(baseURL)/admin/providers/\(providerName)/pull-models")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let result = try JSONDecoder().decode(PullModelsResponse.self, from: data)
        guard result.success, let modelsData = result.data else {
            throw URLError(.cannotParseResponse)
        }
        return modelsData
    }

    func testProvider(modelId: String, provider: String, apiKey: String, apiBase: String, type: String) async throws -> TestModelResult {
        let url = URL(string: "\(baseURL)/admin/test-model")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "model": modelId,
            "provider": provider,
            "api_key": apiKey,
            "api_base": apiBase,
            "type": type
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let result = try JSONDecoder().decode(TestModelResponse.self, from: data)
        guard result.success, let testResult = result.data else {
            throw URLError(.cannotParseResponse)
        }
        return testResult
    }

    // MARK: - Adapters CRUD

    func createAdapter(name: String, type: String, models: [UpdateModelMapping]) async throws {
        let url = URL(string: "\(baseURL)/admin/adapters")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = UpdateAdapterBody(name: name, type: type, models: models)
        req.httpBody = try JSONEncoder().encode(body)
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }

    func deleteAdapter(name: String) async throws {
        let url = URL(string: "\(baseURL)/admin/adapters/\(name)")!
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }

    func testAdapter(name: String) async throws -> TestModelResult {
        let url = URL(string: "\(baseURL)/admin/test-adapter")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["adapter": name])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let result = try JSONDecoder().decode(TestModelResponse.self, from: data)
        guard result.success, let testResult = result.data else {
            throw URLError(.cannotParseResponse)
        }
        return testResult
    }
}
