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

    // MARK: - 统一错误解析

    /// 从后端错误响应里提取人类可读的消息，支持三种格式：
    /// 1. `{"success": false, "error": "..."}`         — 手写错误
    /// 2. `{"success": false, "error": "校验失败", "errors": [{"field":"...","message":"..."}]}` — 校验错误（带明细）
    /// 3. `{"error": {"message": "..."}}`             — 通用 catch-all
    /// 解析失败时回退到 "HTTP <statusCode>"
    static func extractErrorMessage(data: Data, statusCode: Int) -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return "HTTP \(statusCode)"
        }
        // 格式 3: error 是对象 {message: ...}
        if let errObj = json["error"] as? [String: Any],
           let msg = errObj["message"] as? String,
           !msg.isEmpty {
            return msg
        }
        // 格式 1/2: error 是字符串
        let topError = (json["error"] as? String) ?? ""
        // 格式 2: errors 数组
        if let errs = json["errors"] as? [[String: Any]] {
            let lines = errs.compactMap { e -> String? in
                guard let msg = e["message"] as? String, !msg.isEmpty else { return nil }
                let field = (e["field"] as? String) ?? ""
                return field.isEmpty ? "• \(msg)" : "• \(field): \(msg)"
            }
            if !lines.isEmpty {
                let prefix = topError.isEmpty ? "校验失败" : topError
                return prefix + "\n" + lines.joined(separator: "\n")
            }
        }
        if !topError.isEmpty { return topError }
        return "HTTP \(statusCode)"
    }

    /// 校验 HTTP 响应：非 2xx 时抛出带后端错误信息的 NSError
    static func validate(data: Data, response: URLResponse, context: String) throws {
        guard let http = response as? HTTPURLResponse else {
            throw NSError(domain: "APIClient", code: 0, userInfo: [NSLocalizedDescriptionKey: "无效的响应"])
        }
        guard (200..<300).contains(http.statusCode) else {
            let msg = extractErrorMessage(data: data, statusCode: http.statusCode)
            throw NSError(
                domain: "APIClient", code: http.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "[\(context)] \(msg)"]
            )
        }
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
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.validate(data: data, response: resp, context: "setLogLevel")
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
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.validate(data: data, response: resp, context: "reloadConfig")
    }

    func updateAdapter(_ adapter: Adapter, mappings: [UpdateModelMapping]) async throws {
        let url = URL(string: "\(baseURL)/admin/adapters/\(adapter.name)")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = UpdateAdapterBody(name: adapter.name, type: adapter.type, maxTokens: adapter.maxTokens, stream: adapter.stream, models: mappings)
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.validate(data: data, response: resp, context: "updateAdapter")
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
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.validate(data: data, response: resp, context: "setLocale")
    }

    func fetchProxyKey() async throws -> Bool {
        let url = URL(string: "\(baseURL)/admin/proxy-key")!
        let (data, _) = try await URLSession.shared.data(from: url)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let d = json["data"] as? [String: Any] else { return false }
        return d["set"] as? Bool ?? false
    }

    func setProxyKey(_ key: String?) async throws {
        let url = URL(string: "\(baseURL)/admin/proxy-key")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["key": key ?? ""])
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.validate(data: data, response: resp, context: "setProxyKey")
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
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.validate(data: data, response: resp, context: "setPort")
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

    /// 获取趋势折线图数据（支持天数或自定义日期范围）
    func fetchTokenTimeline(days: Int = 30, startDate: String? = nil, endDate: String? = nil) async throws -> [TimelinePoint] {
        var query = "days=\(days)"
        if let s = startDate, let e = endDate {
            query = "startDate=\(s)&endDate=\(e)"
        }
        let url = URL(string: "\(baseURL)/admin/token-stats/timeline?\(query)")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let resp = try JSONDecoder().decode(ArrayResponse<TimelinePoint>.self, from: data)
        guard resp.success else { throw URLError(.cannotParseResponse) }
        return resp.data ?? []
    }

    /// 按维度分桶查询，与 token-stats/timeline 共用同一对 startDate/endDate
    /// - Parameter dimension: provider / adapter / model
    func fetchTokenBreakdown(dimension: String, startDate: String? = nil, endDate: String? = nil) async throws -> [UsageBucket] {
        var query = "dimension=\(dimension)"
        if let s = startDate, let e = endDate {
            query += "&startDate=\(s)&endDate=\(e)"
        }
        let url = URL(string: "\(baseURL)/admin/token-stats/breakdown?\(query)")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let resp = try JSONDecoder().decode(ArrayResponse<UsageBucket>.self, from: data)
        guard resp.success else { throw URLError(.cannotParseResponse) }
        return resp.data ?? []
    }

    /// 获取数据库概况（条目数 + 大小）
    func fetchTokenDbInfo() async throws -> TokenDbInfo {
        let url = URL(string: "\(baseURL)/admin/token-stats/db-info")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let resp = try JSONDecoder().decode(InfoResponse<TokenDbInfo>.self, from: data)
        guard resp.success, let info = resp.data else {
            throw URLError(.cannotParseResponse)
        }
        return info
    }

    /// 清理 N 天前的历史数据
    func cleanupTokenUsage(days: Int = 90) async throws -> CleanupResult {
        let url = URL(string: "\(baseURL)/admin/token-stats/cleanup")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["days": days])
        let (data, _) = try await URLSession.shared.data(for: req)
        let resp = try JSONDecoder().decode(CleanupResponse.self, from: data)
        guard resp.success, let result = resp.data else {
            throw URLError(.cannotParseResponse)
        }
        return result
    }

    // MARK: - Vision Fallback

    /// 获取外挂识图配置。返回 nil 表示未启用。
    func fetchVision() async throws -> VisionConfig? {
        let url = URL(string: "\(baseURL)/admin/vision")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let resp = try JSONDecoder().decode(VisionResponse.self, from: data)
        guard resp.success else {
            throw URLError(.cannotParseResponse)
        }
        return resp.data
    }

    /// 设置外挂识图配置。传 nil/空表示禁用。
    func setVision(provider: String?, model: String?, prompt: String?) async throws {
        let url = URL(string: "\(baseURL)/admin/vision")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = [:]
        if let p = provider, !p.isEmpty { body["provider"] = p }
        if let m = model, !m.isEmpty { body["model"] = m }
        if let pr = prompt, !pr.isEmpty { body["prompt"] = pr }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: req)
        let resp = try JSONDecoder().decode(VisionResponse.self, from: data)
        guard resp.success else {
            throw NSError(domain: "Vision", code: 1, userInfo: [NSLocalizedDescriptionKey: resp.error ?? "Unknown error"])
        }
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
        try Self.validate(data: data, response: resp, context: "setCaptureControl")
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
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.validate(data: data, response: resp, context: "createProvider")
    }

    func updateProvider(name: String, type: String, apiKey: String, apiBase: String, models: [ProviderModelInput]) async throws {
        let url = URL(string: "\(baseURL)/admin/providers/\(name)")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = UpdateProviderBody(name: name, type: type, api_key: apiKey, api_base: apiBase, models: models)
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.validate(data: data, response: resp, context: "updateProvider")
    }

    func deleteProvider(name: String) async throws {
        let url = URL(string: "\(baseURL)/admin/providers/\(name)")!
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.validate(data: data, response: resp, context: "deleteProvider")
    }

    func pullModels(providerName: String, type: String, apiKey: String = "", apiBase: String = "") async throws -> PullModelsData {
        let url = URL(string: "\(baseURL)/admin/providers/\(providerName)/pull-models")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = ["type": type]
        if !apiKey.isEmpty { body["api_key"] = apiKey }
        if !apiBase.isEmpty { body["api_base"] = apiBase }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.validate(data: data, response: resp, context: "pullModels")
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
        try Self.validate(data: data, response: resp, context: "testProvider")
        let result = try JSONDecoder().decode(TestModelResponse.self, from: data)
        guard result.success, let testResult = result.data else {
            throw URLError(.cannotParseResponse)
        }
        return testResult
    }

    // MARK: - Adapters CRUD

    func createAdapter(name: String, type: String, maxTokens: Int? = nil, stream: Bool? = nil, models: [UpdateModelMapping]) async throws {
        let url = URL(string: "\(baseURL)/admin/adapters")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = UpdateAdapterBody(name: name, type: type, maxTokens: maxTokens, stream: stream, models: models)
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.validate(data: data, response: resp, context: "createAdapter")
    }

    func deleteAdapter(name: String) async throws {
        let url = URL(string: "\(baseURL)/admin/adapters/\(name)")!
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.validate(data: data, response: resp, context: "deleteAdapter")
    }

    func testAdapter(name: String, modelId: String) async throws -> TestModelResult {
        let url = URL(string: "\(baseURL)/admin/test-adapter")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["adapterName": name, "modelId": modelId])
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.validate(data: data, response: resp, context: "testAdapter")
        let result = try JSONDecoder().decode(TestModelResponse.self, from: data)
        guard result.success, let testResult = result.data else {
            throw URLError(.cannotParseResponse)
        }
        return testResult
    }
}
