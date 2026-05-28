import Foundation
import Observation

// MARK: - Form Data Models

struct ProviderFormData {
    var name = ""
    var type = "openai"
    var apiKey = ""
    var apiBase = ""
    var models: [ProviderModelFormData] = [ProviderModelFormData()]
}

struct ProviderModelFormData: Identifiable {
    let id = UUID()
    var modelId = ""
    var budgetTokens = ""
    var reasoningEffort = ""
}

// MARK: - ViewModel

@MainActor
@Observable
final class ProvidersViewModel {
    // MARK: - List State
    var providers: [ProviderDetail] = []
    var searchText = ""
    var isLoading = false
    var errorMessage: String?
    var successMessage: String?

    // MARK: - Form State
    var showForm = false
    var isEditing = false
    var editingProviderName: String?
    var formData = ProviderFormData()

    // MARK: - Delete Confirmation
    var showDeleteAlert = false
    var deleteTargetName: String?

    // MARK: - Pull Models
    var showPullModelsSheet = false
    var pullModelsLoading = false
    var pullModelsError: String?
    var pullModelsResult: PullModelsData?

    // MARK: - Test State
    var testResults: [String: TestModelResult] = [:]  // providerName -> result
    var testingProviderNames: Set<String> = []

    // MARK: - Computed

    var filteredProviders: [ProviderDetail] {
        let q = searchText.lowercased().trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return providers }
        return providers.filter { $0.name.lowercased().contains(q) }
    }

    /// Pull models 中尚未在表单中的新模型
    var pullModelsNewItems: [PullModelItem] {
        guard let result = pullModelsResult else { return [] }
        let existingIds = Set(result.existing ?? [])
        let formModelIds = Set(formData.models.map { $0.modelId })
        return result.models.filter { !existingIds.contains($0.id) && !formModelIds.contains($0.id) }
    }

    /// Pull models 中已存在的模型数
    var pullModelsExistingCount: Int {
        guard let result = pullModelsResult else { return 0 }
        return result.existing?.count ?? 0
    }

    // MARK: - API Client

    private let api = APIClient()

    // MARK: - Load

    func load() async {
        isLoading = true
        errorMessage = nil
        do {
            providers = try await api.fetchProviders()
        } catch {
            errorMessage = loc("providers.error.loadFailed", error.localizedDescription)
        }
        isLoading = false
    }

    // MARK: - Form Actions

    func openCreateForm() {
        isEditing = false
        editingProviderName = nil
        formData = ProviderFormData()
        errorMessage = nil
        successMessage = nil
        showForm = true
    }

    func openEditForm(_ provider: ProviderDetail) {
        isEditing = true
        editingProviderName = provider.name
        errorMessage = nil
        successMessage = nil
        formData = ProviderFormData(
            name: provider.name,
            type: provider.type,
            apiKey: provider.api_key,
            apiBase: provider.api_base,
            models: provider.models.isEmpty
                ? [ProviderModelFormData()]
                : provider.models.map { model in
                    let bt = model.thinking?.budget_tokens ?? 0
                    return ProviderModelFormData(
                        modelId: model.id,
                        budgetTokens: bt > 0 ? String(bt) : "",
                        reasoningEffort: model.reasoning_effort ?? ""
                    )
                }
        )
        showForm = true
    }

    func dismissForm() {
        showForm = false
    }

    func saveForm() async {
        // 验证名称
        let trimmedName = formData.name.trimmingCharacters(in: .whitespaces)
        guard !trimmedName.isEmpty else {
            errorMessage = loc("providers.validation.name")
            return
        }

        // 过滤有效模型
        let validModels = formData.models.filter {
            !$0.modelId.trimmingCharacters(in: .whitespaces).isEmpty
        }
        guard !validModels.isEmpty else {
            errorMessage = loc("providers.validation.models")
            return
        }

        // 新增时必须填 API Key
        if !isEditing && formData.apiKey.trimmingCharacters(in: .whitespaces).isEmpty {
            errorMessage = loc("providers.validation.apiKey")
            return
        }

        // 构建模型输入
        let modelInputs = validModels.map { model -> ProviderModelInput in
            var thinking: ThinkingInput? = nil
            if formData.type == "anthropic" {
                if let bt = Int(model.budgetTokens), bt > 0 {
                    thinking = ThinkingInput(budget_tokens: bt, reasoning_effort: nil)
                }
            } else if !model.reasoningEffort.isEmpty {
                thinking = ThinkingInput(budget_tokens: nil, reasoning_effort: model.reasoningEffort)
            }
            return ProviderModelInput(
                id: model.modelId.trimmingCharacters(in: .whitespaces),
                thinking: thinking
            )
        }

        do {
            if isEditing, editingProviderName != nil {
                try await api.updateProvider(
                    name: formData.name,
                    type: formData.type,
                    apiKey: formData.apiKey,
                    apiBase: formData.apiBase,
                    models: modelInputs
                )
                successMessage = loc("providers.updated")
            } else {
                try await api.createProvider(
                    name: formData.name,
                    type: formData.type,
                    apiKey: formData.apiKey,
                    apiBase: formData.apiBase,
                    models: modelInputs
                )
                successMessage = loc("providers.created")
            }
            showForm = false
            await load()
            NotificationCenter.default.post(name: .configDidChange, object: nil)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func addModelRow() {
        formData.models.append(ProviderModelFormData())
    }

    func removeModelRow(at index: Int) {
        guard formData.models.count > 1 else {
            formData.models[0] = ProviderModelFormData()
            return
        }
        formData.models.remove(at: index)
    }

    // MARK: - Delete

    func confirmDelete(_ name: String) {
        deleteTargetName = name
        showDeleteAlert = true
    }

    func executeDelete() async {
        guard let name = deleteTargetName else { return }
        do {
            try await api.deleteProvider(name: name)
            deleteTargetName = nil
            successMessage = loc("providers.deleted")
            await load()
            NotificationCenter.default.post(name: .configDidChange, object: nil)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Pull Models

    func pullModels() async {
        let providerName = isEditing ? (editingProviderName ?? formData.name) : formData.name
        guard !providerName.trimmingCharacters(in: .whitespaces).isEmpty else {
            pullModelsError = loc("providers.validation.providerName")
            showPullModelsSheet = true
            return
        }

        pullModelsLoading = true
        pullModelsError = nil
        pullModelsResult = nil

        do {
            pullModelsResult = try await api.pullModels(providerName: providerName)
        } catch {
            pullModelsError = error.localizedDescription
        }
        pullModelsLoading = false
        showPullModelsSheet = true
    }

    func dismissPullModels() {
        showPullModelsSheet = false
        pullModelsResult = nil
        pullModelsError = nil
    }

    func importPullModels() {
        guard let result = pullModelsResult else { return }
        let existingIds = Set(formData.models.map { $0.modelId })
        var added = 0
        var skipped = 0

        for item in result.models {
            if existingIds.contains(item.id) {
                skipped += 1
            } else {
                formData.models.append(ProviderModelFormData(modelId: item.id))
                added += 1
            }
        }

        showPullModelsSheet = false
        pullModelsResult = nil

        if added > 0 {
            successMessage = skipped > 0
                ? loc("providers.pullModels.importedWithSkip", added, skipped)
                : loc("providers.pullModels.imported", added)
        }
    }

    // MARK: - Test Connectivity

    func testProvider(_ provider: ProviderDetail) async {
        guard let firstModel = provider.models.first else {
            errorMessage = loc("providers.validation.noModels")
            return
        }
        let providerName = provider.name
        testingProviderNames.insert(providerName)
        testResults.removeValue(forKey: providerName)

        do {
            let result = try await api.testProvider(
                modelId: firstModel.id,
                provider: providerName,
                apiKey: provider.api_key,
                apiBase: provider.api_base,
                type: provider.type
            )
            testResults[providerName] = result
        } catch {
            testResults[providerName] = TestModelResult(reachable: false, latency: nil, model: nil, error: error.localizedDescription, adapterUrl: nil, requestUrl: nil, requestBody: nil, responseBody: nil, responseStatus: nil)
        }
        testingProviderNames.remove(providerName)
    }

    func dismissError() {
        errorMessage = nil
    }

    func dismissSuccess() {
        successMessage = nil
    }
}
