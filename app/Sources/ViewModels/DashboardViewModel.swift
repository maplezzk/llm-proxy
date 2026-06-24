import Foundation
import Combine

/// Dashboard 状态管理
/// 图表数据仅在日期范围变化时重新加载，polling 只刷新今日 stats
final class DashboardViewModel: ObservableObject {
    // MARK: - 基础状态
    @Published var health: Bool = false
    @Published var config: ConfigData?
    @Published var tokenStats: TokenStats?
    @Published var isLoading: Bool = false
    @Published var errorMessage: String?

    // MARK: - 图表数据
    @Published var timeline: [TimelinePoint] = []
    @Published var breakdown: [UsageBucket] = []
    @Published var dbInfo: TokenDbInfo?
    @Published var isLoadingCharts: Bool = false
    @Published var isCleaningUp: Bool = false

    // MARK: - 日期范围
    @Published var dateStart: Date
    @Published var dateEnd: Date
    @Published var breakdownDimension: String = "provider"
    @Published var breakdownRange: String = "7d"

    /// 单调递增的请求序号，丢弃过期的并发响应
    private var chartRequestSeq: UInt64 = 0

    private let client: APIClient
    private var pollTimer: Timer?
    private var chartTask: Task<(), Never>?

    private static let df: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    init(client: APIClient = APIClient()) {
        self.client = client
        let now = Date()
        self.dateEnd = now
        self.dateStart = Calendar.current.date(byAdding: .day, value: -29, to: now) ?? now
    }

    // MARK: - Compute Helpers

    var providerCount: Int { config?.providers.count ?? 0 }
    var modelCount: Int { config?.providers.reduce(0) { $0 + $1.models.count } ?? 0 }
    var adapterCount: Int { config?.adapters?.count ?? 0 }

    static func fmtNum(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
        return String(n)
    }

    static func fmtBytes(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.2f MB", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1f KB", Double(n) / 1_000) }
        return "\(n) B"
    }

    static func pct(_ n: Int, _ total: Int) -> String {
        guard total > 0 else { return "0%" }
        return String(format: "%.1f%%", Double(n) / Double(total) * 100)
    }

    /// 将 Date 格式化为 API 需要的 YYYY-MM-dd
    var dateStartStr: String { Self.df.string(from: dateStart) }
    var dateEndStr: String { Self.df.string(from: dateEnd) }

    // MARK: - Data Loading

    /// 首次加载：并发拉取所有数据
    @MainActor
    func load() async {
        isLoading = true
        errorMessage = nil

        async let healthTask = client.fetchHealth()
        async let configTask = client.fetchConfig()
        async let tokenStatsTask = client.fetchTokenStats()
        async let chartsTask: Void = loadCharts()
        async let dbInfoTask: Void = loadDbInfo()

        if let h = try? await healthTask { health = h }
        if let c = try? await configTask { config = c.data }
        if let s = try? await tokenStatsTask { tokenStats = s }
        _ = await chartsTask
        _ = await dbInfoTask

        isLoading = false
    }

    /// 加载图表数据
    @MainActor
    func loadCharts() async {
        chartRequestSeq &+= 1
        let mySeq = chartRequestSeq
        isLoadingCharts = true

        let tlDays = max(1, Calendar.current.dateComponents([.day], from: dateStart, to: dateEnd).day ?? 30)
        let timelineTask = Task { try await client.fetchTokenTimeline(days: tlDays, startDate: dateStartStr, endDate: dateEndStr) }
        let breakdownTask = Task { try await client.fetchTokenBreakdown(dimension: breakdownDimension, range: breakdownRange, startDate: dateStartStr, endDate: dateEndStr) }

        if Task.isCancelled { return }
        let newTimeline = try? await timelineTask.value
        if Task.isCancelled { return }
        let newBreakdown = try? await breakdownTask.value
        if Task.isCancelled { return }

        guard mySeq == chartRequestSeq else { return }

        if let newTimeline { timeline = newTimeline }
        if let newBreakdown { breakdown = newBreakdown }
        isLoadingCharts = false
    }

    @MainActor
    private func loadDbInfo() async {
        dbInfo = try? await client.fetchTokenDbInfo()
    }

    // MARK: - 用户操作

    @MainActor
    func setDateRange(start: Date, end: Date) {
        dateStart = start
        dateEnd = end
        triggerChartReload()
    }

    @MainActor
    func setPresetDays(_ days: Int) {
        let now = Date()
        dateEnd = now
        dateStart = Calendar.current.date(byAdding: .day, value: -(days - 1), to: now) ?? now
        triggerChartReload()
    }

    @MainActor
    func setBreakdownDimension(_ dim: String) {
        breakdownDimension = dim
        triggerChartReload()
    }

    @MainActor
    func setBreakdownRange(_ range: String) {
        breakdownRange = range
        triggerChartReload()
    }

    @MainActor
    private func triggerChartReload() {
        chartTask?.cancel()
        let task = Task { @MainActor [weak self] in
            await self?.loadCharts()
        }
        chartTask = Task { @MainActor [weak self] in
            _ = await task.value
            self?.chartTask = nil
        }
    }

    /// 清理 90 天前的历史数据
    @MainActor
    func cleanupUsage(days: Int = 90) async -> CleanupResult? {
        isCleaningUp = true
        defer { isCleaningUp = false }
        do {
            let result = try await client.cleanupTokenUsage(days: days)
            await loadCharts()
            await loadDbInfo()
            return result
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    // MARK: - Polling（只刷新基础 stats，不刷新图表）

    func startPolling() {
        stopPolling()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let h = try? await self.client.fetchHealth() { self.health = h }
                if let s = try? await self.client.fetchTokenStats() { self.tokenStats = s }
            }
        }
        Task { @MainActor [weak self] in
            await self?.load()
        }
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
        chartTask?.cancel()
        chartTask = nil
    }
}