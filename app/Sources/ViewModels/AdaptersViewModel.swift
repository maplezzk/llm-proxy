import Foundation
import SwiftUI

@MainActor
@Observable
final class AdaptersViewModel {
    var adapters: [Adapter] = []
    var providers: [ProviderDetail] = []
    var search: String = ""
    var error: String?
    var isLoading: Bool = false

    // Sheet 状态
    var showForm: Bool = false
    var editingAdapter: Adapter? = nil
    var formName: String = ""
    var formType: String = "openai"
    var formMappings: [FormMappingRow] = []

    // 测试状态
    var testResults: [String: TestModelResult] = [:]
    var testingAdapterName: String?
    var isTesting: Bool = false

    private let client = APIClient()

    struct FormMappingRow: Identifiable {
        let id = UUID()
        var sourceModelId: String
        var provider: String
        var targetModelId: String
    }

    var filteredAdapters: [Adapter] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return adapters }
        return adapters.filter { $0.name.lowercased().contains(q) }
    }

    func load() async {
        isLoading = true
        error = nil
        do {
            async let adaptersResp = client.fetchAdapters()
            async let providersList = client.fetchProviders()
            let (resp, provs) = try await (adaptersResp, providersList)
            adapters = resp.data?.adapters ?? []
            providers = provs
        } catch {
            self.error = loc("adapter.loadError")
        }
        isLoading = false
    }

    // MARK: - Form

    func openForm(adapter: Adapter? = nil) {
        editingAdapter = adapter
        if let adapter = adapter {
            formName = adapter.name
            formType = adapter.type
            formMappings = adapter.models.map { m in
                FormMappingRow(sourceModelId: m.sourceModelId, provider: m.provider, targetModelId: m.targetModelId)
            }
        } else {
            formName = ""
            formType = "openai"
            formMappings = []
        }
        if formMappings.isEmpty {
            addMappingRow()
        }
        showForm = true
    }

    func closeForm() {
        showForm = false
        editingAdapter = nil
        formName = ""
        formType = "openai"
        formMappings = []
        error = nil
    }

    func addMappingRow() {
        formMappings.append(FormMappingRow(sourceModelId: "", provider: "", targetModelId: ""))
    }

    func removeMappingRow(at index: Int) {
        guard index < formMappings.count else { return }
        formMappings.remove(at: index)
        if formMappings.isEmpty {
            addMappingRow()
        }
    }

    func onProviderChanged(at index: Int) {
        guard index < formMappings.count else { return }
        formMappings[index].targetModelId = ""
    }

    func providerModels(for providerName: String) -> [String] {
        guard let p = providers.first(where: { $0.name == providerName }) else { return [] }
        return p.models.map { $0.id }
    }

    func save() async -> Bool {
        let name = formName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else {
            error = loc("adapter.validationName")
            return false
        }

        let validMappings = formMappings.filter {
            !$0.sourceModelId.trimmingCharacters(in: .whitespaces).isEmpty &&
            !$0.provider.trimmingCharacters(in: .whitespaces).isEmpty &&
            !$0.targetModelId.trimmingCharacters(in: .whitespaces).isEmpty
        }

        guard !validMappings.isEmpty else {
            error = loc("adapter.validationModels")
            return false
        }

        let mappings = validMappings.map { UpdateModelMapping(sourceModelId: $0.sourceModelId, provider: $0.provider, targetModelId: $0.targetModelId) }

        do {
            if editingAdapter != nil {
                try await client.updateAdapter(Adapter(name: name, type: formType, baseUrl: nil, models: []), mappings: mappings)
            } else {
                try await client.createAdapter(name: name, type: formType, models: mappings)
            }
            closeForm()
            await load()
            NotificationCenter.default.post(name: .configDidChange, object: nil)
            return true
        } catch {
            self.error = loc("adapter.saveFailed")
            return false
        }
    }

    // MARK: - Delete

    func deleteAdapter(_ name: String) async {
        do {
            try await client.deleteAdapter(name: name)
            await load()
            NotificationCenter.default.post(name: .configDidChange, object: nil)
        } catch {
            self.error = loc("adapter.deleteFailed")
        }
    }

    // MARK: - Test

    func testAdapter(_ adapter: Adapter) async {
        guard let firstMapping = adapter.models.first else {
            testResults[adapter.name] = TestModelResult(
                reachable: false, latency: nil, model: nil,
                error: "No model mapping", adapterUrl: nil, requestUrl: nil,
                requestBody: nil, responseBody: nil, responseStatus: nil
            )
            return
        }
        let name = adapter.name
        testingAdapterName = name
        isTesting = true
        testResults.removeValue(forKey: name)
        error = nil
        do {
            testResults[name] = try await client.testAdapter(name: name, modelId: firstMapping.sourceModelId)
        } catch {
            testResults[name] = TestModelResult(
                reachable: false,
                latency: nil,
                model: nil,
                error: error.localizedDescription,
                adapterUrl: nil,
                requestUrl: nil,
                requestBody: nil,
                responseBody: nil,
                responseStatus: nil
            )
        }
        isTesting = false
    }
}
