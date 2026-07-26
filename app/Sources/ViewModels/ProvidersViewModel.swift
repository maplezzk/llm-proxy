import Foundation
import Observation

// MARK: - Form Data Models

struct ProviderFormData {
    var name = ""
    var apiKey = ""
    var protocols: [ProviderProtocolFormData] = [ProviderProtocolFormData()]
    var models: [ProviderModelFormData] = [ProviderModelFormData()]

    init(
        name: String = "",
        type: String = "openai",
        apiKey: String = "",
        apiBase: String = "",
        protocols: [ProviderProtocolFormData]? = nil,
        models: [ProviderModelFormData] = [ProviderModelFormData()]
    ) {
        self.name = name
        self.apiKey = apiKey
        self.protocols = protocols ?? [ProviderProtocolFormData(type: type, apiBase: apiBase)]
        self.models = models
    }

    /// 旧 UI/调用方兼容：type 和 apiBase 代表首个（主）协议。
    var type: String {
        get { protocols.first?.type ?? "openai" }
        set {
            if protocols.isEmpty { protocols = [ProviderProtocolFormData(type: newValue)] }
            else { protocols[0].type = newValue }
        }
    }

    var apiBase: String {
        get { protocols.first?.apiBase ?? "" }
        set {
            if protocols.isEmpty { protocols = [ProviderProtocolFormData(apiBase: newValue)] }
            else { protocols[0].apiBase = newValue }
        }
    }

    var protocolTypes: [String] { protocols.map(\.type) }
}

struct ProviderProtocolFormData: Identifiable {
    let id = UUID()
    var type: String
    var apiBase: String

    init(type: String = "openai", apiBase: String = "") {
        self.type = type
        self.apiBase = apiBase
    }
}

struct ProviderModelFormData: Identifiable {
    let id = UUID()
    var modelId = ""
    var protocols: Set<String> = ["openai"]
    var budgetTokens = ""
    var reasoningEffort = ""
    var thinkingType = ""
    var input: Set<String> = ["text"]
}

// MARK: - ViewModel

@MainActor
@Observable
final class ProvidersViewModel {
    // MARK: - List State
    var providers: [ProviderDetail] = []
    var searchText = ""
    /// 当前识图模型配置（"provider/model"），用于在编辑表单中提示用户不要去掉 image 勾选
    var visionModelKey: String? = nil
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
        // 同时拉取 vision 配置（用于在编辑表单中提示哪些 model 不能去掉 image 勾选）
        // 拉取失败不影响列表加载
        if let vision = try? await api.fetchVision() {
            visionModelKey = "\(vision.provider)/\(vision.model)"
        } else {
            visionModelKey = nil
        }
        isLoading = false
    }

    /// 判断某个 modelRow 是否是当前识图模型（用于在表单中给出智能提示）
    func isVisionModelRow(providerName: String, modelId: String) -> Bool {
        guard let key = visionModelKey else { return false }
        return key == "\(providerName)/\(modelId)"
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
            protocols: provider.supportedProtocols.map {
                ProviderProtocolFormData(type: $0.type, apiBase: $0.api_base ?? "")
            },
            models: provider.models.isEmpty
                ? [ProviderModelFormData()]
                : provider.models.map { model in
                    let bt = model.thinking?.budget_tokens ?? 0
                    let inputSet = Set(model.input ?? ["text"])
                    return ProviderModelFormData(
                        modelId: model.id,
                        protocols: Set(model.protocols ?? model.protocol.map { [$0] } ?? provider.supportedProtocols.map(\.type)),
                        budgetTokens: bt > 0 ? String(bt) : "",
                        reasoningEffort: model.reasoning_effort ?? "",
                        thinkingType: model.thinking?.type ?? "",
                        input: inputSet
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
            let budgetTokens: Int? = model.protocols.contains("anthropic") ? Int(model.budgetTokens).flatMap { $0 > 0 ? $0 : nil } : nil
            let reasoningEffort: String? = (model.protocols.contains("openai") || model.protocols.contains("openai-responses")) && !model.reasoningEffort.isEmpty
                ? model.reasoningEffort
                : nil
            let thinkingType: String? = model.thinkingType.isEmpty ? nil : model.thinkingType
            if budgetTokens != nil || reasoningEffort != nil || thinkingType != nil {
                thinking = ThinkingInput(budget_tokens: budgetTokens, reasoning_effort: reasoningEffort, type: thinkingType)
            }
            // 输入模态：按设定顺序输出；只要勾选了任何模态（含 text）就发送，让后端能看到用户的意图
            let allowedModalities: [String] = ["text", "image", "audio", "video", "file"]
            let selectedModalities = allowedModalities.filter { model.input.contains($0) }
            let inputField: [String]? = selectedModalities.isEmpty ? nil : selectedModalities
            return ProviderModelInput(
                id: model.modelId.trimmingCharacters(in: .whitespaces),
                protocols: model.protocols.isEmpty ? nil : Array(model.protocols),
                thinking: thinking,
                input: inputField
            )
        }

        do {
            if isEditing, editingProviderName != nil {
                try await api.updateProvider(
                    name: formData.name,
                    type: formData.type,
                    apiKey: formData.apiKey,
                    apiBase: formData.apiBase,
                    protocols: formData.protocols.map { ProviderProtocolDetail(type: $0.type, api_base: $0.apiBase.isEmpty ? nil : $0.apiBase) },
                    models: modelInputs
                )
                successMessage = loc("providers.updated")
            } else {
                try await api.createProvider(
                    name: formData.name,
                    type: formData.type,
                    apiKey: formData.apiKey,
                    apiBase: formData.apiBase,
                    protocols: formData.protocols.map { ProviderProtocolDetail(type: $0.type, api_base: $0.apiBase.isEmpty ? nil : $0.apiBase) },
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
        formData.models.append(ProviderModelFormData(protocols: Set(formData.protocolTypes)))
    }

    func removeModelRow(at index: Int) {
        guard index >= 0 && index < formData.models.count else { return }
        removeModelRow(id: formData.models[index].id)
    }

    /// 通过稳定 UUID 删除模型行，避免按索引删除时其它行闭包持有陈旧索引导致越界崩溃
    func removeModelRow(id: UUID) {
        guard let index = formData.models.firstIndex(where: { $0.id == id }) else { return }
        guard formData.models.count > 1 else {
            formData.models[0] = ProviderModelFormData()
            return
        }
        formData.models.remove(at: index)
    }

    func addProtocol() {
        let used = Set(formData.protocolTypes)
        let next = ["openai", "anthropic", "openai-responses"].first { !used.contains($0) } ?? "openai"
        formData.protocols.append(ProviderProtocolFormData(type: next))
    }

    func toggleProtocol(type: String, enabled: Bool) {
        let exists = formData.protocolTypes.contains(type)
        if enabled && !exists {
            formData.protocols.append(ProviderProtocolFormData(type: type))
        } else if !enabled && exists && formData.protocols.count > 1 {
            removeProtocol(id: formData.protocols.first(where: { $0.type == type })!.id)
        }
    }

    func updateProtocolBase(type: String, apiBase: String) {
        guard let index = formData.protocols.firstIndex(where: { $0.type == type }) else { return }
        formData.protocols[index].apiBase = apiBase
    }

    func removeProtocol(id: UUID) {
        guard formData.protocols.count > 1,
              let index = formData.protocols.firstIndex(where: { $0.id == id }) else { return }
        let removedType = formData.protocols[index].type
        formData.protocols.remove(at: index)
        let remainingType = formData.protocols[0].type
        for index in formData.models.indices {
            formData.models[index].protocols.remove(removedType)
            if formData.models[index].protocols.isEmpty {
                formData.models[index].protocols.insert(remainingType)
            }
        }
    }

    func updateProtocolType(id: UUID, to type: String) {
        guard let index = formData.protocols.firstIndex(where: { $0.id == id }) else { return }
        let oldType = formData.protocols[index].type
        guard oldType != type else { return }
        formData.protocols[index].type = type
        for modelIndex in formData.models.indices where formData.models[modelIndex].protocols.contains(oldType) {
            formData.models[modelIndex].protocols.remove(oldType)
            formData.models[modelIndex].protocols.insert(type)
        }
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
            let protocolConfig = formData.protocols.first ?? ProviderProtocolFormData()
            pullModelsResult = try await api.pullModels(providerName: providerName, type: protocolConfig.type, apiKey: formData.apiKey, apiBase: protocolConfig.apiBase)
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
                apiBase: provider.supportedProtocols.first?.api_base ?? provider.api_base,
                type: provider.supportedProtocols.first?.type ?? provider.type
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
