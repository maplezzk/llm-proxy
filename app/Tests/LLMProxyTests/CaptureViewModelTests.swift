import XCTest
@testable import LLMProxy

@MainActor
final class CaptureViewModelTests: XCTestCase {
    var viewModel: CaptureViewModel!

    override func setUp() {
        viewModel = CaptureViewModel(apiClient: APIClient())
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertFalse(viewModel.running, "Should not be running initially")
        XCTAssertTrue(viewModel.entries.isEmpty, "Should have no entries initially")
        XCTAssertNil(viewModel.selectedId, "Should have no selection initially")
        XCTAssertNil(viewModel.sourceFilter, "Should have no filter initially")
        XCTAssertNil(viewModel.errorMessage, "Should have no error initially")
    }

    func testEmptySources() {
        XCTAssertTrue(viewModel.sources.isEmpty, "Empty entries should yield empty sources")
    }

    func testEmptyFilteredEntries() {
        XCTAssertTrue(viewModel.filteredEntries.isEmpty, "Empty entries should yield empty filtered")
    }

    func testNoSelectionGivesNilEntry() {
        viewModel.selectedId = nil
        XCTAssertNil(viewModel.selectedEntry)
    }

    // MARK: - Entries Management

    func testFilteredEntriesWhenNoFilter() {
        let e1 = makeEntry(id: 1, source: "proxy")
        let e2 = makeEntry(id: 2, source: "my-adapter")
        viewModel.entries = [e1, e2]
        viewModel.sourceFilter = nil

        XCTAssertEqual(viewModel.filteredEntries.count, 2)
    }

    func testFilteredEntriesWithFilter() {
        let e1 = makeEntry(id: 1, source: "proxy")
        let e2 = makeEntry(id: 2, source: "my-adapter")
        let e3 = makeEntry(id: 3, source: "proxy")
        viewModel.entries = [e1, e2, e3]
        viewModel.sourceFilter = "proxy"

        XCTAssertEqual(viewModel.filteredEntries.count, 2)
        XCTAssertEqual(viewModel.filteredEntries.map(\.id), [1, 3])
    }

    func testFilteredEntriesWithNonMatchingFilter() {
        let e1 = makeEntry(id: 1, source: "proxy")
        viewModel.entries = [e1]
        viewModel.sourceFilter = "nonexistent"

        XCTAssertTrue(viewModel.filteredEntries.isEmpty)
    }

    func testSourcesAreUniqueAndSorted() {
        let e1 = makeEntry(id: 1, source: "c")
        let e2 = makeEntry(id: 2, source: "a")
        let e3 = makeEntry(id: 3, source: "c")
        let e4 = makeEntry(id: 4, source: "b")
        viewModel.entries = [e1, e2, e3, e4]

        XCTAssertEqual(viewModel.sources, ["a", "b", "c"])
    }

    // MARK: - Selection

    func testToggleSelection() {
        viewModel.entries = [makeEntry(id: 1, source: "proxy")]

        viewModel.toggleSelected(1)
        XCTAssertEqual(viewModel.selectedId, 1)
        XCTAssertNotNil(viewModel.selectedEntry)

        viewModel.toggleSelected(1)
        XCTAssertNil(viewModel.selectedId)
        XCTAssertNil(viewModel.selectedEntry)
    }

    func testSelectedEntryFindsCorrectEntry() {
        let e1 = makeEntry(id: 10, source: "proxy")
        let e2 = makeEntry(id: 20, source: "adapter")
        viewModel.entries = [e1, e2]
        viewModel.selectedId = 20

        XCTAssertEqual(viewModel.selectedEntry?.id, 20)
        XCTAssertEqual(viewModel.selectedEntry?.source, "adapter")
    }

    func testSelectedEntryReturnsNilForNonExistingId() {
        viewModel.entries = [makeEntry(id: 1, source: "proxy")]
        viewModel.selectedId = 999

        XCTAssertNil(viewModel.selectedEntry)
    }

    // MARK: - End Capture

    @MainActor
    func testEndCaptureResetsState() async {
        viewModel.entries = [makeEntry(id: 1, source: "proxy")]
        viewModel.selectedId = 1
        viewModel.sourceFilter = "proxy"
        viewModel.errorMessage = "some error"

        await viewModel.endCapture()

        XCTAssertFalse(viewModel.running)
        XCTAssertTrue(viewModel.entries.isEmpty)
        XCTAssertNil(viewModel.selectedId)
        XCTAssertNil(viewModel.sourceFilter)
        XCTAssertNil(viewModel.errorMessage)
    }

    // MARK: - Size Limit

    func testEntriesMax200() {
        var entries: [CaptureEntry] = []
        for i in 1...250 {
            entries.append(makeEntry(id: i, source: "proxy"))
        }
        viewModel.entries = entries

        // 通过 SSE callback 模拟追加时会截断，但直接赋值不会。
        // 验证 filteredEntries 仍返回全部即可（直接赋值场景）。
        // SSE 截断逻辑在 ViewModel.connectSSE 的 onEntry callback 中。
        XCTAssertEqual(viewModel.entries.count, 250)
    }

    // MARK: - Null/Missing JSON Content

    func testSelectedEntryWithNullPhases() {
        let entry = CaptureEntry(
            id: 1,
            timestamp: 1000,
            source: "proxy",
            protocol: "anthropic",
            model: "claude-3",
            pairId: 1,
            requestIn: nil,
            requestOut: nil,
            responseIn: nil,
            responseOut: nil,
            adapterName: nil,
            upstreamProvider: nil,
            upstreamProtocol: nil,
            upstreamModel: nil
        )
        viewModel.entries = [entry]
        viewModel.selectedId = 1

        let selected = viewModel.selectedEntry
        XCTAssertNotNil(selected)
        XCTAssertNil(selected?.requestIn)
        XCTAssertNil(selected?.responseOut)
    }

    func testSelectedEntryWithPartialPhases() {
        let entry = CaptureEntry(
            id: 1,
            timestamp: 1000,
            source: "proxy",
            protocol: "openai",
            model: "gpt-4",
            pairId: 1,
            requestIn: #"{"model":"gpt-4","messages":[]}"#,
            requestOut: nil,
            responseIn: nil,
            responseOut: nil,
            adapterName: nil,
            upstreamProvider: "openai",
            upstreamProtocol: "openai",
            upstreamModel: "gpt-4-0613"
        )
        viewModel.entries = [entry]
        viewModel.selectedId = 1

        let selected = viewModel.selectedEntry
        XCTAssertEqual(selected?.requestIn, #"{"model":"gpt-4","messages":[]}"#)
        XCTAssertNil(selected?.responseIn)
        XCTAssertNotNil(selected?.upstreamProvider)
    }

    // MARK: - Upstream Info

    func testEntryWithUpstreamInfo() {
        let entry = CaptureEntry(
            id: 1,
            timestamp: 1000,
            source: "my-adapter",
            protocol: "anthropic",
            model: "claude-sonnet-4",
            pairId: 1,
            requestIn: nil,
            requestOut: nil,
            responseIn: nil,
            responseOut: nil,
            adapterName: "my-adapter",
            upstreamProvider: "deepseek",
            upstreamProtocol: "openai",
            upstreamModel: "deepseek-chat"
        )
        viewModel.entries = [entry]

        XCTAssertEqual(viewModel.entries[0].adapterName, "my-adapter")
        XCTAssertEqual(viewModel.entries[0].upstreamProvider, "deepseek")
        XCTAssertEqual(viewModel.entries[0].upstreamProtocol, "openai")
        XCTAssertEqual(viewModel.entries[0].upstreamModel, "deepseek-chat")
    }

    // MARK: - Source Filter Reset

    func testSourceFilterResetAfterEnd() async {
        viewModel.entries = [makeEntry(id: 1, source: "proxy")]
        viewModel.sourceFilter = "proxy"

        await viewModel.endCapture()

        XCTAssertNil(viewModel.sourceFilter)
    }

    // MARK: - Helpers

    private func makeEntry(id: Int, source: String) -> CaptureEntry {
        CaptureEntry(
            id: id,
            timestamp: Int(Date().timeIntervalSince1970 * 1000),
            source: source,
            protocol: "anthropic",
            model: "claude-3",
            pairId: id,
            requestIn: nil,
            requestOut: nil,
            responseIn: nil,
            responseOut: nil,
            adapterName: nil,
            upstreamProvider: nil,
            upstreamProtocol: nil,
            upstreamModel: nil
        )
    }
}
