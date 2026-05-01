import Foundation

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
