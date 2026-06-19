import Foundation

// MARK: - Token Stats

struct TokenRecord: Codable {
    let date: String
    let input_tokens: Int
    let output_tokens: Int
    let cache_read_input_tokens: Int
    let cache_creation_input_tokens: Int
    let request_count: Int
}

struct TokenStats: Codable {
    let today: TokenRecord
    let history: [TokenRecord]
    let byProvider: [String: TokenRecord]
}

struct TokenStatsResponse: Codable {
    let success: Bool
    let data: TokenStats?
}

// MARK: - Logs

struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let str = try? container.decode(String.self) { value = str }
        else if let num = try? container.decode(Int.self) { value = num }
        else if let num = try? container.decode(Double.self) { value = num }
        else if let bool = try? container.decode(Bool.self) { value = bool }
        else if let arr = try? container.decode([AnyCodable].self) { value = arr.map { $0.value } }
        else if let dict = try? container.decode([String: AnyCodable].self) { value = dict.mapValues { $0.value } }
        else { value = "" }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let str = value as? String { try container.encode(str) }
        else if let num = value as? Int { try container.encode(num) }
        else if let num = value as? Double { try container.encode(num) }
        else if let bool = value as? Bool { try container.encode(bool) }
        else if let arr = value as? [Any] { try container.encode(arr.map { AnyCodable($0) }) }
        else if let dict = value as? [String: Any] { try container.encode(dict.mapValues { AnyCodable($0) }) }
    }
}

struct LogEntry: Codable {
    let id: Int
    let timestamp: String
    let type: String
    let level: String
    let message: String
    let details: [String: AnyCodable]?
}

struct LogsData: Codable {
    let logs: [LogEntry]
    let stats: LogStats?
}

struct LogStats: Codable {
    let total: Int
    let requestCount: Int
    let systemCount: Int

    enum CodingKeys: String, CodingKey {
        case total
        case requestCount = "requestCount"
        case systemCount = "systemCount"
    }
}

struct LogsResponse: Codable {
    let success: Bool
    let data: LogsData?
}

// MARK: - Capture

struct CaptureEntry: Codable {
    let id: Int
    let timestamp: Int
    let source: String
    let `protocol`: String
    let model: String
    let pairId: Int
    let requestIn: String?
    let requestOut: String?
    let responseIn: String?
    let responseOut: String?
    let adapterName: String?
    let upstreamProvider: String?
    let upstreamProtocol: String?
    let upstreamModel: String?

    enum CodingKeys: String, CodingKey {
        case id, timestamp, source, model, pairId
        case `protocol` = "protocol"
        case requestIn, requestOut, responseIn, responseOut
        case adapterName, upstreamProvider, upstreamProtocol, upstreamModel
    }
}

struct CaptureStatus: Codable {
    let enabled: Bool
}

struct CaptureStatusResponse: Codable {
    let success: Bool
    let data: CaptureStatus?
}

struct CaptureControlResponse: Codable {
    let success: Bool
    let data: CaptureStatus?
}

// MARK: - Provider (完整详情)

struct ProviderModelDetail: Codable {
    let id: String
    let thinking: ThinkingConfig?
    let reasoning_effort: String?
    let input: [String]?

    enum CodingKeys: String, CodingKey {
        case id, thinking, reasoning_effort, input
    }
}

struct ThinkingConfig: Codable {
    let budget_tokens: Int
}

struct ProviderDetail: Codable {
    let name: String
    let type: String
    let api_key: String
    let api_base: String
    let models: [ProviderModelDetail]
}

struct ProvidersListResponse: Codable {
    let success: Bool
    let data: [ProviderDetail]?
}

// MARK: - Provider CRUD Bodies

struct CreateProviderBody: Codable {
    let name: String
    let type: String
    let api_key: String
    let api_base: String
    let models: [ProviderModelInput]
}

struct ProviderModelInput: Codable {
    let id: String
    let thinking: ThinkingInput?
    let input: [String]?
}

struct ThinkingInput: Codable {
    let budget_tokens: Int?
    let reasoning_effort: String?
}

struct UpdateProviderBody: Codable {
    let name: String
    let type: String
    let api_key: String
    let api_base: String
    let models: [ProviderModelInput]
}

// MARK: - Test Result

struct TestModelResponse: Codable {
    let success: Bool
    let data: TestModelResult?
}

struct TestModelResult: Codable {
    let reachable: Bool
    let latency: Int?
    let model: String?
    let error: String?
    let adapterUrl: String?
    let requestUrl: String?
    let requestBody: AnyCodable?
    let responseBody: AnyCodable?
    let responseStatus: Int?
}

// MARK: - Vision Fallback

struct VisionConfig: Codable, Equatable {
    let provider: String
    let model: String
    let prompt: String?
}

struct VisionResponse: Codable {
    let success: Bool
    let data: VisionConfig?
    let error: String?
}

// MARK: - Pull Models

struct PullModelsResponse: Codable {
    let success: Bool
    let data: PullModelsData?
}

struct PullModelsData: Codable {
    let models: [PullModelItem]
    let existing: [String]?
}

struct PullModelItem: Codable {
    let id: String
    let description: String?
}

// MARK: - Legacy Models (保持兼容)

struct AdapterModel: Codable {
    let sourceModelId: String
    let provider: String
    let targetModelId: String
    let status: String?
}

struct Adapter: Codable {
    let name: String
    let type: String
    let baseUrl: String?
    var models: [AdapterModel]
}

struct AdaptersResponse: Codable {
    let success: Bool
    let data: AdaptersData?
}

struct AdaptersData: Codable {
    let adapters: [Adapter]
}

struct UpdateAdapterBody: Codable {
    let name: String
    let type: String
    let models: [UpdateModelMapping]
}

struct UpdateModelMapping: Codable {
    let sourceModelId: String
    let provider: String
    let targetModelId: String
}

struct ProviderModel: Codable {
    let id: String
}

struct Provider: Codable {
    let name: String
    let type: String
    let api_key: String?
    let api_base: String?
    let models: [ProviderModel]
}

struct ConfigData: Codable {
    let providers: [Provider]
    let adapters: [Adapter]?
}

struct ConfigResponse: Codable {
    let success: Bool
    let data: ConfigData?
}
