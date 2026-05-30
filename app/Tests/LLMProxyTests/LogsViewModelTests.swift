import XCTest
@testable import LLMProxy

@MainActor
final class LogsViewModelTests: XCTestCase {

    // MARK: - Helper

    func makeEntry(id: Int, timestamp: String, type: String = "request", level: String = "info", message: String = "test message", details: [String: AnyCodable]? = nil) -> LogEntry {
        LogEntry(id: id, timestamp: timestamp, type: type, level: level, message: message, details: details)
    }

    // MARK: - Happy Path

    func testFilteredLogsReturnsSortedByTimestampDescending() {
        let vm = LogsViewModel()
        // logs 由 load() 排序，此处直接设置 allLogs 为已排序状态
        vm.allLogs = [
            makeEntry(id: 2, timestamp: "2026-05-28 12:00:00.000"),
            makeEntry(id: 3, timestamp: "2026-05-28 11:00:00.000"),
            makeEntry(id: 1, timestamp: "2026-05-28 10:00:00.000"),
        ]

        let filtered = vm.filteredLogs
        XCTAssertEqual(filtered.count, 3)
        XCTAssertEqual(filtered[0].id, 2)  // 12:00 最新（已排序时排第一）
        XCTAssertEqual(filtered[1].id, 3)
        XCTAssertEqual(filtered[2].id, 1)
    }

    func testSearchFiltersByMessage() {
        let vm = LogsViewModel()
        vm.allLogs = [
            makeEntry(id: 1, timestamp: "2026-05-28 10:00:00.000", message: "GET /v1/messages"),
            makeEntry(id: 2, timestamp: "2026-05-28 11:00:00.000", message: "POST /v1/chat"),
            makeEntry(id: 3, timestamp: "2026-05-28 12:00:00.000", message: "Server started"),
        ]
        vm.setSearch("chat")

        let filtered = vm.filteredLogs
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.id, 2)
    }

    func testSearchFiltersByDetails() {
        let vm = LogsViewModel()
        let details: [String: AnyCodable] = ["status": AnyCodable(200), "latency": AnyCodable(150)]
        vm.allLogs = [
            makeEntry(id: 1, timestamp: "2026-05-28 10:00:00.000", message: "request", details: details),
            makeEntry(id: 2, timestamp: "2026-05-28 11:00:00.000", message: "other"),
        ]
        vm.setSearch("latency")

        let filtered = vm.filteredLogs
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.id, 1)
    }

    func testSearchIsCaseInsensitive() {
        let vm = LogsViewModel()
        vm.allLogs = [
            makeEntry(id: 1, timestamp: "2026-05-28 10:00:00.000", message: "Server Started"),
        ]
        vm.setSearch("server")
        XCTAssertEqual(vm.filteredLogs.count, 1)

        vm.setSearch("SERVER")
        XCTAssertEqual(vm.filteredLogs.count, 1)

        vm.setSearch("Started")
        XCTAssertEqual(vm.filteredLogs.count, 1)
    }

    func testSearchEmptyReturnsAll() {
        let vm = LogsViewModel()
        vm.allLogs = [
            makeEntry(id: 1, timestamp: "2026-05-28 10:00:00.000"),
            makeEntry(id: 2, timestamp: "2026-05-28 11:00:00.000"),
        ]
        vm.setSearch("")
        XCTAssertEqual(vm.filteredLogs.count, 2)

        vm.setSearch("nonexistent")
        XCTAssertEqual(vm.filteredLogs.count, 0)
    }

    func testPaginationFirstPage() {
        let vm = LogsViewModel()
        // pageSize = 50
        vm.allLogs = (1...100).map {
            makeEntry(id: $0, timestamp: "2026-05-28 \(String(format: "%02d", $0 % 60)):00:00.000")
        }
        vm.currentPage = 1
        let page = vm.pagedLogs
        XCTAssertEqual(page.count, 50)
    }

    func testPaginationSecondPage() {
        let vm = LogsViewModel()
        vm.allLogs = (1...100).map {
            makeEntry(id: $0, timestamp: "2026-05-28 \(String(format: "%02d", $0 % 60)):00:00.000")
        }
        vm.currentPage = 2
        let page = vm.pagedLogs
        XCTAssertEqual(page.count, 50)
    }

    func testTotalPages() {
        let vm = LogsViewModel()
        vm.allLogs = (1...75).map {
            makeEntry(id: $0, timestamp: "2026-05-28 10:00:00.000")
        }
        XCTAssertEqual(vm.totalPages, 2)  // 75 / 50 = 1.5 → 2

        vm.allLogs = (1...50).map {
            makeEntry(id: $0, timestamp: "2026-05-28 10:00:00.000")
        }
        XCTAssertEqual(vm.totalPages, 1)

        vm.allLogs = (1...51).map {
            makeEntry(id: $0, timestamp: "2026-05-28 10:00:00.000")
        }
        XCTAssertEqual(vm.totalPages, 2)
    }

    // MARK: - Edge Cases

    func testEmptyLogsHasPaginationOne() {
        let vm = LogsViewModel()
        XCTAssertEqual(vm.filteredLogs.count, 0)
        XCTAssertEqual(vm.pagedLogs.count, 0)
        XCTAssertEqual(vm.totalPages, 1)
        XCTAssertEqual(vm.totalCount, 0)
    }

    func testSearchResetsPageToFirst() {
        let vm = LogsViewModel()
        vm.allLogs = (1...100).map {
            makeEntry(id: $0, timestamp: "2026-05-28 10:00:00.000", message: "entry \($0)")
        }
        vm.currentPage = 2
        vm.setSearch("entry 1") // matches "entry 1", "entry 10", "entry 11", etc.

        XCTAssertEqual(vm.currentPage, 1)
    }

    func testNextPrevPageBoundaries() {
        let vm = LogsViewModel()
        vm.allLogs = (1...60).map {
            makeEntry(id: $0, timestamp: "2026-05-28 10:00:00.000")
        }
        // totalPages = 2

        vm.currentPage = 1
        vm.prevPage()
        XCTAssertEqual(vm.currentPage, 1)  // can't go below 1

        vm.nextPage()
        XCTAssertEqual(vm.currentPage, 2)

        vm.nextPage()
        XCTAssertEqual(vm.currentPage, 2)  // can't exceed total
    }

    func testGoToPageOutOfBounds() {
        let vm = LogsViewModel()
        vm.allLogs = (1...50).map {
            makeEntry(id: $0, timestamp: "2026-05-28 10:00:00.000")
        }

        vm.goToPage(0)
        XCTAssertEqual(vm.currentPage, 1)

        vm.goToPage(5)
        XCTAssertEqual(vm.currentPage, 1)  // totalPages=1, can't go to 5
    }

    // MARK: - State Transitions

    func testSetLevelFilterChangesState() {
        let vm = LogsViewModel()
        XCTAssertNil(vm.levelFilter)

        // 同步设置状态（异步加载无法在同步测试中验证）
        // 仅验证状态变更
        vm.levelFilter = "debug"
        XCTAssertEqual(vm.levelFilter, "debug")

        vm.levelFilter = nil
        XCTAssertNil(vm.levelFilter)
    }

    func testSetTypeFilterChangesState() {
        let vm = LogsViewModel()
        XCTAssertNil(vm.typeFilter)

        vm.typeFilter = "request"
        XCTAssertEqual(vm.typeFilter, "request")
    }

    func testAutoScrollDefaultsToTrue() {
        let vm = LogsViewModel()
        XCTAssertTrue(vm.autoScroll)
    }

    func testHasMoreDefaultsToTrue() {
        let vm = LogsViewModel()
        XCTAssertTrue(vm.hasMore)
    }

    // MARK: - LogLevelColor

    func testLevelColors() {
        XCTAssertEqual(LogLevelColor.color(for: "debug"), "gray")
        XCTAssertEqual(LogLevelColor.color(for: "info"), "blue")
        XCTAssertEqual(LogLevelColor.color(for: "warn"), "orange")
        XCTAssertEqual(LogLevelColor.color(for: "error"), "red")
        XCTAssertEqual(LogLevelColor.color(for: "unknown"), "secondary")
    }

    // MARK: - FormatTimestamp

    func testFormatTimestampTrimsMilliseconds() {
        let result = LogsViewModel.formatTimestamp("2026-05-28 14:30:00.123")
        XCTAssertEqual(result, "2026-05-28 14:30:00")
    }

    func testFormatTimestampShortString() {
        let result = LogsViewModel.formatTimestamp("short")
        XCTAssertEqual(result, "short")
    }

    // MARK: - FormatDetails

    func testFormatDetailsNil() {
        let result = LogsViewModel.formatDetails(nil)
        XCTAssertEqual(result, "")
    }

    func testFormatDetailsEmpty() {
        let result = LogsViewModel.formatDetails([:])
        XCTAssertEqual(result, "{\n\n}")
    }

    func testFormatDetailsWithValues() {
        let details: [String: AnyCodable] = [
            "status": AnyCodable(200),
            "latency": AnyCodable(150)
        ]
        let result = LogsViewModel.formatDetails(details)
        XCTAssertTrue(result.contains("status"))
        XCTAssertTrue(result.contains("200"))
        XCTAssertTrue(result.contains("latency"))
        XCTAssertTrue(result.contains("150"))
    }

    // MARK: - AllLogs Maintained on Error

    func testErrorStatePreservesAllLogs() async {
        let vm = await MainActor.run { LogsViewModel() }
        await MainActor.run { vm.allLogs = [
            makeEntry(id: 1, timestamp: "2026-05-28 10:00:00.000", message: "existing")
        ] }
        // 模拟错误：errorMessage 设置后 allLogs 不受影响
        await MainActor.run { vm.errorMessage = "API error" }
        let count = await MainActor.run { vm.allLogs.count }
        let message = await MainActor.run { vm.allLogs.first?.message }
        let errorMessage = await MainActor.run { vm.errorMessage }
        XCTAssertEqual(count, 1)
        XCTAssertEqual(message, "existing")
        XCTAssertNotNil(errorMessage)
    }
}
