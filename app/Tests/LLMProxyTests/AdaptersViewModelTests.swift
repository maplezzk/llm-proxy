import XCTest
@testable import LLMProxy

@MainActor
final class AdaptersViewModelTests: XCTestCase {
    var viewModel: AdaptersViewModel!

    @MainActor
    override func setUp() {
        viewModel = AdaptersViewModel()
    }

    // MARK: - Filtered Adapters

    @MainActor
    func testFilteredAdaptersEmptySearch() {
        viewModel.adapters = [
            Adapter(name: "test-adapter", type: "openai", baseUrl: nil, models: []),
        ]
        viewModel.search = ""
        XCTAssertEqual(viewModel.filteredAdapters.count, 1)
    }

    @MainActor
    func testFilteredAdaptersWithSearch() {
        viewModel.adapters = [
            Adapter(name: "openai-adapter", type: "openai", baseUrl: nil, models: []),
            Adapter(name: "anthropic-adapter", type: "anthropic", baseUrl: nil, models: []),
        ]
        viewModel.search = "openai"
        XCTAssertEqual(viewModel.filteredAdapters.count, 1)
        XCTAssertEqual(viewModel.filteredAdapters[0].name, "openai-adapter")
    }

    @MainActor
    func testFilteredAdaptersNoMatch() {
        viewModel.adapters = [Adapter(name: "test", type: "openai", baseUrl: nil, models: [])]
        viewModel.search = "nonexistent"
        XCTAssertEqual(viewModel.filteredAdapters.count, 0)
    }

    @MainActor
    func testFilteredAdaptersCaseInsensitive() {
        viewModel.adapters = [Adapter(name: "MyAdapter", type: "openai", baseUrl: nil, models: [])]
        viewModel.search = "myadapter"
        XCTAssertEqual(viewModel.filteredAdapters.count, 1)
    }

    // MARK: - Form Management

    @MainActor
    func testOpenFormForNewAdapter() {
        viewModel.openForm()
        XCTAssertTrue(viewModel.showForm)
        XCTAssertNil(viewModel.editingAdapter)
        XCTAssertEqual(viewModel.formName, "")
        XCTAssertEqual(viewModel.formType, "openai")
        XCTAssertEqual(viewModel.formMappings.count, 1) // auto-add one row
    }

    @MainActor
    func testOpenFormForEdit() {
        let adapter = Adapter(
            name: "my-adapter",
            type: "anthropic",
            baseUrl: nil,
            models: [
                AdapterModel(sourceModelId: "gpt-4", provider: "openai", targetModelId: "gpt-4-turbo", status: nil),
            ]
        )
        viewModel.openForm(adapter: adapter)
        XCTAssertTrue(viewModel.showForm)
        XCTAssertNotNil(viewModel.editingAdapter)
        XCTAssertEqual(viewModel.formName, "my-adapter")
        XCTAssertEqual(viewModel.formType, "anthropic")
        XCTAssertEqual(viewModel.formMappings.count, 1)
        XCTAssertEqual(viewModel.formMappings[0].sourceModelId, "gpt-4")
        XCTAssertEqual(viewModel.formMappings[0].provider, "openai")
        XCTAssertEqual(viewModel.formMappings[0].targetModelId, "gpt-4-turbo")
    }

    @MainActor
    func testCloseFormResetsState() {
        viewModel.openForm()
        viewModel.closeForm()
        XCTAssertFalse(viewModel.showForm)
        XCTAssertNil(viewModel.editingAdapter)
        XCTAssertEqual(viewModel.formName, "")
        XCTAssertEqual(viewModel.formType, "openai")
        XCTAssertTrue(viewModel.formMappings.isEmpty)
    }

    @MainActor
    func testAddMappingRow() {
        viewModel.openForm()
        let initialCount = viewModel.formMappings.count
        viewModel.addMappingRow()
        XCTAssertEqual(viewModel.formMappings.count, initialCount + 1)
    }

    @MainActor
    func testRemoveMappingRow() {
        viewModel.openForm()
        viewModel.addMappingRow()
        let countAfterAdd = viewModel.formMappings.count
        viewModel.removeMappingRow(at: 0)
        XCTAssertEqual(viewModel.formMappings.count, countAfterAdd - 1)
    }

    @MainActor
    func testRemoveLastMappingRowAutoAddsOne() {
        viewModel.openForm() // auto-adds 1 row
        viewModel.removeMappingRow(at: 0)
        XCTAssertEqual(viewModel.formMappings.count, 1) // auto-added
    }

    @MainActor
    func testOnProviderChangedClearsTargetModel() {
        viewModel.formMappings = [
            AdaptersViewModel.FormMappingRow(sourceModelId: "gpt-4", provider: "deepseek", targetModelId: "deepseek-chat"),
        ]
        viewModel.onProviderChanged(at: 0)
        XCTAssertEqual(viewModel.formMappings[0].targetModelId, "")
    }

    // MARK: - Provider Models

    @MainActor
    func testProviderModels() {
        viewModel.providers = [
            ProviderDetail(
                name: "deepseek",
                type: "openai",
                api_key: "sk-xxx",
                api_base: "https://api.deepseek.com",
                models: [
                    ProviderModelDetail(id: "deepseek-chat", thinking: nil, reasoning_effort: nil, input: nil),
                    ProviderModelDetail(id: "deepseek-reasoner", thinking: nil, reasoning_effort: "high", input: nil),
                ]
            ),
        ]
        let models = viewModel.providerModels(for: "deepseek")
        XCTAssertEqual(models, ["deepseek-chat", "deepseek-reasoner"])
    }

    @MainActor
    func testProviderModelsNonexistent() {
        let models = viewModel.providerModels(for: "nonexistent")
        XCTAssertEqual(models, [])
    }

    // MARK: - Validation

    @MainActor
    func testSaveWithEmptyNameShowsError() async {
        viewModel.openForm()
        viewModel.formName = ""
        viewModel.formMappings = [
            AdaptersViewModel.FormMappingRow(sourceModelId: "gpt-4", provider: "openai", targetModelId: "gpt-4-turbo"),
        ]
        let result = await viewModel.save()
        XCTAssertFalse(result)
        XCTAssertNotNil(viewModel.error)
    }

    @MainActor
    func testSaveWithEmptyMappingsShowsError() async {
        viewModel.openForm()
        viewModel.formName = "test"
        viewModel.formMappings = [
            AdaptersViewModel.FormMappingRow(sourceModelId: "", provider: "", targetModelId: ""),
        ]
        let result = await viewModel.save()
        XCTAssertFalse(result)
        XCTAssertNotNil(viewModel.error)
    }

    // MARK: - State Properties

    @MainActor
    func testInitialState() {
        XCTAssertTrue(viewModel.adapters.isEmpty)
        XCTAssertTrue(viewModel.providers.isEmpty)
        XCTAssertEqual(viewModel.search, "")
        XCTAssertFalse(viewModel.showForm)
        XCTAssertNil(viewModel.editingAdapter)
        XCTAssertNil(viewModel.error)
        XCTAssertFalse(viewModel.isLoading)
    }

    @MainActor
    func testIsTestingState() {
        XCTAssertFalse(viewModel.isTesting)
        XCTAssertNil(viewModel.testingAdapterName)
        XCTAssertNil(viewModel.testResults["test-adapter"])

        viewModel.testingAdapterName = "test-adapter"
        viewModel.isTesting = true
        XCTAssertTrue(viewModel.isTesting)
        XCTAssertEqual(viewModel.testingAdapterName, "test-adapter")
    }

    // MARK: - FormMappingRow

    func testFormMappingRowInitialization() {
        let row = AdaptersViewModel.FormMappingRow(sourceModelId: "gpt-4", provider: "openai", targetModelId: "gpt-4-turbo")
        XCTAssertEqual(row.sourceModelId, "gpt-4")
        XCTAssertEqual(row.provider, "openai")
        XCTAssertEqual(row.targetModelId, "gpt-4-turbo")
    }
}
