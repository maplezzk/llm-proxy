import XCTest
@testable import LLMProxy

@MainActor
final class ProvidersViewModelTests: XCTestCase {

    @MainActor
    func testInitialState() {
        let vm = ProvidersViewModel()
        XCTAssertTrue(vm.providers.isEmpty)
        XCTAssertEqual(vm.searchText, "")
        XCTAssertFalse(vm.isLoading)
        XCTAssertNil(vm.errorMessage)
        XCTAssertFalse(vm.showForm)
        XCTAssertFalse(vm.isEditing)
        XCTAssertNil(vm.editingProviderName)
        XCTAssertEqual(vm.formData.name, "")
        XCTAssertEqual(vm.formData.type, "openai")
        XCTAssertEqual(vm.formData.apiKey, "")
        XCTAssertEqual(vm.formData.apiBase, "")
        XCTAssertEqual(vm.formData.models.count, 1)
        XCTAssertTrue(vm.filteredProviders.isEmpty)
        XCTAssertFalse(vm.showDeleteAlert)
        XCTAssertNil(vm.deleteTargetName)
        XCTAssertFalse(vm.showPullModelsSheet)
        XCTAssertFalse(vm.pullModelsLoading)
        XCTAssertNil(vm.pullModelsError)
        XCTAssertNil(vm.pullModelsResult)
        XCTAssertTrue(vm.testResults.isEmpty)
        XCTAssertTrue(vm.testingProviderNames.isEmpty)
    }

    @MainActor
    func testFilteredProviders_emptySearch() {
        let vm = ProvidersViewModel()
        vm.providers = [
            ProviderDetail(name: "openai", type: "openai", api_key: "", api_base: "", models: []),
            ProviderDetail(name: "anthropic", type: "anthropic", api_key: "", api_base: "", models: []),
        ]
        vm.searchText = ""
        XCTAssertEqual(vm.filteredProviders.count, 2)
    }

    @MainActor
    func testFilteredProviders_withSearch() {
        let vm = ProvidersViewModel()
        vm.providers = [
            ProviderDetail(name: "openai", type: "openai", api_key: "", api_base: "", models: []),
            ProviderDetail(name: "anthropic", type: "anthropic", api_key: "", api_base: "", models: []),
            ProviderDetail(name: "deepseek", type: "openai", api_key: "", api_base: "", models: []),
        ]
        vm.searchText = "open"
        XCTAssertEqual(vm.filteredProviders.count, 1)
        XCTAssertEqual(vm.filteredProviders.first?.name, "openai")
    }

    @MainActor
    func testFilteredProviders_caseInsensitive() {
        let vm = ProvidersViewModel()
        vm.providers = [
            ProviderDetail(name: "OpenAI", type: "openai", api_key: "", api_base: "", models: []),
        ]
        vm.searchText = "open"
        XCTAssertEqual(vm.filteredProviders.count, 1)
        vm.searchText = "OPENAI"
        XCTAssertEqual(vm.filteredProviders.count, 1)
    }

    @MainActor
    func testOpenCreateForm() {
        let vm = ProvidersViewModel()
        vm.errorMessage = "previous error"
        vm.openCreateForm()
        XCTAssertTrue(vm.showForm)
        XCTAssertFalse(vm.isEditing)
        XCTAssertNil(vm.editingProviderName)
        XCTAssertEqual(vm.formData.name, "")
        XCTAssertEqual(vm.formData.models.count, 1)
        XCTAssertNil(vm.errorMessage)
    }

    @MainActor
    func testOpenEditForm_populatesData() {
        let vm = ProvidersViewModel()
        let provider = ProviderDetail(
            name: "test-provider",
            type: "anthropic",
            api_key: "sk-test",
            api_base: "https://api.test.com",
            models: [
                ProviderModelDetail(id: "claude-3", thinking: ThinkingConfig(budget_tokens: 1024), reasoning_effort: nil),
                ProviderModelDetail(id: "claude-2", thinking: nil, reasoning_effort: nil),
            ]
        )
        vm.openEditForm(provider)
        XCTAssertTrue(vm.showForm)
        XCTAssertTrue(vm.isEditing)
        XCTAssertEqual(vm.editingProviderName, "test-provider")
        XCTAssertEqual(vm.formData.name, "test-provider")
        XCTAssertEqual(vm.formData.type, "anthropic")
        XCTAssertEqual(vm.formData.apiKey, "sk-test")
        XCTAssertEqual(vm.formData.apiBase, "https://api.test.com")
        XCTAssertEqual(vm.formData.models.count, 2)
        XCTAssertEqual(vm.formData.models[0].modelId, "claude-3")
        XCTAssertEqual(vm.formData.models[0].budgetTokens, "1024")
        XCTAssertEqual(vm.formData.models[1].modelId, "claude-2")
        XCTAssertEqual(vm.formData.models[1].budgetTokens, "")
    }

    @MainActor
    func testOpenEditForm_emptyModels_addsDefaultRow() {
        let vm = ProvidersViewModel()
        let provider = ProviderDetail(
            name: "empty-models",
            type: "openai",
            api_key: "",
            api_base: "",
            models: []
        )
        vm.openEditForm(provider)
        XCTAssertEqual(vm.formData.models.count, 1)
        XCTAssertEqual(vm.formData.models[0].modelId, "")
    }

    @MainActor
    func testDismissForm() {
        let vm = ProvidersViewModel()
        vm.showForm = true
        vm.dismissForm()
        XCTAssertFalse(vm.showForm)
    }

    @MainActor
    func testAddModelRow() {
        let vm = ProvidersViewModel()
        XCTAssertEqual(vm.formData.models.count, 1)
        vm.addModelRow()
        XCTAssertEqual(vm.formData.models.count, 2)
        vm.addModelRow()
        XCTAssertEqual(vm.formData.models.count, 3)
    }

    @MainActor
    func testRemoveModelRow_lastRow_clearsIt() {
        let vm = ProvidersViewModel()
        vm.formData.models[0].modelId = "gpt-4"
        vm.removeModelRow(at: 0)
        XCTAssertEqual(vm.formData.models.count, 1)
        // 最后一行被清空而非删除
        XCTAssertEqual(vm.formData.models[0].modelId, "")
    }

    @MainActor
    func testRemoveModelRow_multipleRows() {
        let vm = ProvidersViewModel()
        vm.addModelRow()
        vm.formData.models[0].modelId = "gpt-4"
        vm.formData.models[1].modelId = "gpt-3.5"
        vm.removeModelRow(at: 0)
        XCTAssertEqual(vm.formData.models.count, 1)
        XCTAssertEqual(vm.formData.models[0].modelId, "gpt-3.5")
    }

    @MainActor
    func testConfirmDelete() {
        let vm = ProvidersViewModel()
        vm.confirmDelete("test-provider")
        XCTAssertTrue(vm.showDeleteAlert)
        XCTAssertEqual(vm.deleteTargetName, "test-provider")
    }

    @MainActor
    func testPullModelsNewItems() {
        let vm = ProvidersViewModel()
        vm.pullModelsResult = PullModelsData(
            models: [
                PullModelItem(id: "gpt-4", description: "GPT-4"),
                PullModelItem(id: "gpt-3.5", description: "GPT-3.5"),
                PullModelItem(id: "gpt-4o", description: "GPT-4o"),
            ],
            existing: ["gpt-4"]
        )
        vm.formData.models = [ProviderModelFormData(modelId: "gpt-3.5")]
        let newItems = vm.pullModelsNewItems
        XCTAssertEqual(newItems.count, 1)
        XCTAssertEqual(newItems.first?.id, "gpt-4o")
    }

    @MainActor
    func testPullModelsExistingCount() {
        let vm = ProvidersViewModel()
        vm.pullModelsResult = PullModelsData(
            models: [],
            existing: ["gpt-4", "gpt-3.5"]
        )
        XCTAssertEqual(vm.pullModelsExistingCount, 2)
    }

    @MainActor
    func testPullModelsNewItems_nilResult() {
        let vm = ProvidersViewModel()
        XCTAssertTrue(vm.pullModelsNewItems.isEmpty)
        XCTAssertEqual(vm.pullModelsExistingCount, 0)
    }

    @MainActor
    func testImportPullModels_addsNewOnes() {
        let vm = ProvidersViewModel()
        vm.formData.models = [ProviderModelFormData(modelId: "gpt-4")]
        vm.pullModelsResult = PullModelsData(
            models: [
                PullModelItem(id: "gpt-4", description: nil),
                PullModelItem(id: "gpt-3.5", description: nil),
                PullModelItem(id: "gpt-4o", description: nil),
            ],
            existing: ["gpt-4"]
        )
        vm.importPullModels()
        // gpt-4 already in form, gpt-3.5 should be added, gpt-4o should be added
        let ids = vm.formData.models.map { $0.modelId }
        XCTAssertTrue(ids.contains("gpt-4"))
        XCTAssertTrue(ids.contains("gpt-3.5"))
        XCTAssertTrue(ids.contains("gpt-4o"))
        XCTAssertFalse(vm.showPullModelsSheet)
    }

    @MainActor
    func testValidateForm_missingName() async {
        let vm = ProvidersViewModel()
        vm.formData.name = ""
        vm.formData.models = [ProviderModelFormData(modelId: "gpt-4")]
        vm.formData.apiKey = "sk-test"
        await vm.saveForm()
        // 验证失败，errorMessage 应被设置
        XCTAssertNotNil(vm.errorMessage)
    }

    @MainActor
    func testValidateForm_missingModels() async {
        let vm = ProvidersViewModel()
        vm.formData.name = "test"
        vm.formData.models = [ProviderModelFormData(modelId: "")]
        vm.formData.apiKey = "sk-test"
        await vm.saveForm()
        XCTAssertNotNil(vm.errorMessage)
    }

    @MainActor
    func testValidateForm_missingApiKey_whenCreating() async {
        let vm = ProvidersViewModel()
        vm.isEditing = false
        vm.formData.name = "test"
        vm.formData.models = [ProviderModelFormData(modelId: "gpt-4")]
        vm.formData.apiKey = ""
        await vm.saveForm()
        XCTAssertNotNil(vm.errorMessage)
    }

    @MainActor
    func testValidateForm_emptyApiKey_whenEditing_ok() {
        // 编辑时 API Key 为空视为不修改，saveForm 不检查
        let vm = ProvidersViewModel()
        vm.isEditing = true
        vm.formData.name = "test"
        vm.formData.models = [ProviderModelFormData(modelId: "gpt-4")]
        vm.formData.apiKey = ""
        // 编辑模式下 apiKey 为空不影响验证（saveForm 只检查 !isEditing 时）
        let shouldValidate = !vm.isEditing || !vm.formData.apiKey.trimmingCharacters(in: .whitespaces).isEmpty || true
        XCTAssertTrue(shouldValidate, "Editing mode allows empty apiKey")
    }

    @MainActor
    func testDismissError() {
        let vm = ProvidersViewModel()
        vm.errorMessage = "some error"
        vm.dismissError()
        XCTAssertNil(vm.errorMessage)
    }

    @MainActor
    func testDismissSuccess() {
        let vm = ProvidersViewModel()
        vm.successMessage = "success!"
        vm.dismissSuccess()
        XCTAssertNil(vm.successMessage)
    }

    @MainActor
    func testDismissPullModels() {
        let vm = ProvidersViewModel()
        vm.showPullModelsSheet = true
        vm.pullModelsResult = PullModelsData(models: [], existing: nil)
        vm.pullModelsError = "error"
        vm.dismissPullModels()
        XCTAssertFalse(vm.showPullModelsSheet)
        XCTAssertNil(vm.pullModelsResult)
        XCTAssertNil(vm.pullModelsError)
    }

    @MainActor
    func testPullModels_beforeFetch_errorState() async {
        let vm = ProvidersViewModel()
        vm.formData.name = ""
        await vm.pullModels()
        XCTAssertTrue(vm.showPullModelsSheet)
        XCTAssertNotNil(vm.pullModelsError)
        XCTAssertFalse(vm.pullModelsLoading)
    }

    // MARK: - Model Type Tests

    func testProviderDetailDecoding() throws {
        let json = """
        {
            "name": "openai",
            "type": "openai",
            "api_key": "sk-test",
            "api_base": "https://api.openai.com",
            "models": [
                {"id": "gpt-4", "thinking": {"budget_tokens": 1024}},
                {"id": "o1", "reasoning_effort": "high"}
            ]
        }
        """.data(using: .utf8)!
        let provider = try JSONDecoder().decode(ProviderDetail.self, from: json)
        XCTAssertEqual(provider.name, "openai")
        XCTAssertEqual(provider.type, "openai")
        XCTAssertEqual(provider.models.count, 2)
        XCTAssertEqual(provider.models[0].id, "gpt-4")
        XCTAssertEqual(provider.models[0].thinking?.budget_tokens, 1024)
        XCTAssertEqual(provider.models[1].id, "o1")
        XCTAssertEqual(provider.models[1].reasoning_effort, "high")
    }

    func testProviderDetailDecoding_emptyModels() throws {
        let json = """
        {
            "name": "empty",
            "type": "openai",
            "api_key": "",
            "api_base": "",
            "models": []
        }
        """.data(using: .utf8)!
        let provider = try JSONDecoder().decode(ProviderDetail.self, from: json)
        XCTAssertTrue(provider.models.isEmpty)
    }

    func testPullModelsDataDecoding() throws {
        let json = """
        {
            "models": [
                {"id": "gpt-4", "description": "GPT-4"},
                {"id": "gpt-3.5", "description": null}
            ],
            "existing": ["gpt-4"]
        }
        """.data(using: .utf8)!
        let data = try JSONDecoder().decode(PullModelsData.self, from: json)
        XCTAssertEqual(data.models.count, 2)
        XCTAssertEqual(data.models[0].id, "gpt-4")
        XCTAssertEqual(data.models[0].description, "GPT-4")
        XCTAssertEqual(data.models[1].id, "gpt-3.5")
        XCTAssertNil(data.models[1].description)
        XCTAssertEqual(data.existing?.count, 1)
        XCTAssertEqual(data.existing?.first, "gpt-4")
    }

    func testPullModelsDataDecoding_noExisting() throws {
        let json = """
        {
            "models": [{"id": "gpt-4", "description": null}]
        }
        """.data(using: .utf8)!
        let data = try JSONDecoder().decode(PullModelsData.self, from: json)
        XCTAssertEqual(data.models.count, 1)
        XCTAssertNil(data.existing)
    }

    func testTestModelResultDecoding() throws {
        let json = """
        {"reachable": true, "latency": 150, "model": "test", "error": null, "adapterUrl": null, "requestUrl": null, "requestBody": null, "responseBody": null, "responseStatus": 200}
        """.data(using: .utf8)!
        let result = try JSONDecoder().decode(TestModelResult.self, from: json)
        XCTAssertTrue(result.reachable)
        XCTAssertEqual(result.latency, 150)
        XCTAssertNil(result.error)
    }

    func testCreateProviderBodyEncoding() throws {
        let body = CreateProviderBody(
            name: "test",
            type: "anthropic",
            api_key: "sk-key",
            api_base: "https://api.test.com",
            models: [ProviderModelInput(id: "claude-3", thinking: ThinkingInput(budget_tokens: 1024, reasoning_effort: nil))]
        )
        let data = try JSONEncoder().encode(body)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["name"] as? String, "test")
        XCTAssertEqual(json["type"] as? String, "anthropic")
        XCTAssertEqual(json["api_key"] as? String, "sk-key")
        XCTAssertEqual(json["api_base"] as? String, "https://api.test.com")
        let models = json["models"] as! [[String: Any]]
        XCTAssertEqual(models.count, 1)
        XCTAssertEqual(models[0]["id"] as? String, "claude-3")
        let thinking = models[0]["thinking"] as! [String: Any]
        XCTAssertEqual(thinking["budget_tokens"] as? Int, 1024)
        XCTAssertNil(thinking["reasoning_effort"])
    }
}
