import XCTest
@testable import LLMProxy

@MainActor
final class DashboardViewModelTests: XCTestCase {

    // MARK: - fmtNum

    func testFmtNumLessThanThousand() {
        XCTAssertEqual(DashboardViewModel.fmtNum(0), "0")
        XCTAssertEqual(DashboardViewModel.fmtNum(42), "42")
        XCTAssertEqual(DashboardViewModel.fmtNum(999), "999")
    }

    func testFmtNumThousands() {
        XCTAssertEqual(DashboardViewModel.fmtNum(1_000), "1.0K")
        XCTAssertEqual(DashboardViewModel.fmtNum(1_500), "1.5K")
        XCTAssertEqual(DashboardViewModel.fmtNum(999_999), "1000.0K")
    }

    func testFmtNumMillions() {
        XCTAssertEqual(DashboardViewModel.fmtNum(1_000_000), "1.0M")
        XCTAssertEqual(DashboardViewModel.fmtNum(2_500_000), "2.5M")
    }

    // MARK: - pct

    func testPctNormal() {
        XCTAssertEqual(DashboardViewModel.pct(50, 100), "50.0%")
        XCTAssertEqual(DashboardViewModel.pct(1, 3), "33.3%")
    }

    func testPctWithZeroDenominator() {
        XCTAssertEqual(DashboardViewModel.pct(10, 0), "0%")
    }

    func testPctAllHits() {
        XCTAssertEqual(DashboardViewModel.pct(100, 100), "100.0%")
    }

    // MARK: - Initial State

    func testInitialState() {
        let vm = DashboardViewModel()
        XCTAssertFalse(vm.health)
        XCTAssertNil(vm.config)
        XCTAssertNil(vm.tokenStats)
        XCTAssertFalse(vm.isLoading)
        XCTAssertNil(vm.errorMessage)
        XCTAssertEqual(vm.providerCount, 0)
        XCTAssertEqual(vm.modelCount, 0)
        XCTAssertEqual(vm.adapterCount, 0)
    }

    // MARK: - Computed Properties

    func testComputedCountsFromConfig() {
        let vm = DashboardViewModel()
        let provider1 = Provider(name: "p1", type: "openai", api_key: nil, api_base: nil, models: [
            ProviderModel(id: "m1"),
            ProviderModel(id: "m2")
        ])
        let provider2 = Provider(name: "p2", type: "anthropic", api_key: nil, api_base: nil, models: [
            ProviderModel(id: "m3")
        ])
        let adapter1 = Adapter(name: "a1", type: "anthropic", baseUrl: nil, models: [])
        let adapter2 = Adapter(name: "a2", type: "openai", baseUrl: nil, models: [])
        vm.config = ConfigData(
            providers: [provider1, provider2],
            adapters: [adapter1, adapter2]
        )
        XCTAssertEqual(vm.providerCount, 2)
        XCTAssertEqual(vm.modelCount, 3)
        XCTAssertEqual(vm.adapterCount, 2)
    }

    func testComputedCountsWithEmptyConfig() {
        let vm = DashboardViewModel()
        vm.config = ConfigData(providers: [], adapters: nil)
        XCTAssertEqual(vm.providerCount, 0)
        XCTAssertEqual(vm.modelCount, 0)
        XCTAssertEqual(vm.adapterCount, 0)
    }

    // MARK: - stopPolling

    func testStopPollingDoesNotCrash() {
        let vm = DashboardViewModel()
        vm.startPolling()
        // Timer 启动后应不崩溃
        vm.stopPolling()
        // 重复 stop 也不应崩溃
        vm.stopPolling()
    }

    func testMultipleStartPolling() {
        let vm = DashboardViewModel()
        vm.startPolling()
        vm.startPolling() // 旧 timer 先 stop
        vm.stopPolling()
    }
}
