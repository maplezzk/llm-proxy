import Foundation

class APIClient {
    var baseURL: String

    init(baseURL: String = "http://127.0.0.1:9000") {
        self.baseURL = baseURL
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
}
