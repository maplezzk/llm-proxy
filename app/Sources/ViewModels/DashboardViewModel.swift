import Foundation
import Observation

/// Dashboard 状态管理——服务状态、配置计数、Token 用量，10 秒自动刷新
@Observable
final class DashboardViewModel {
    // 基础状态
    var health: Bool = false
    var config: ConfigData?
    var tokenStats: TokenStats?
    var isLoading: Bool = false
    var errorMessage: String?

    // 图表数据
    var timeline: [TimelinePoint] = []
    var breakdown: [UsageBucket] = []
    var dbInfo: TokenDbInfo?
    var timelineDays: Int = 30
    var breakdownDimension: String = "provider"  // provider / adapter / model
    var breakdownRange: String = "today"          // today / 7d / 30d / all
    var isLoadingCharts: Bool = false
    var isCleaningUp: Bool = false

    /// 单调递增的请求序号，用于丢弃过期的并发响应
    /// （防止用户快速点击 7→90→7 时，90 天的慢请求覆盖 7 天的快响应）
    private var chartRequestSeq: UInt64 = 0

    private let client: APIClient
    private var pollTimer: Timer?
    /// 当前图表请求任务句柄，切换参数时取消旧任务避免响应错位
    private var chartTask: Task<(), Never>?

    init(client: APIClient = APIClient()) {
        self.client = client
    }

    // MARK: - Compute Helpers

    /// Provider 数量
    var providerCount: Int {
        config?.providers.count ?? 0
    }

    /// 模型总数（跨所有 Provider）
    var modelCount: Int {
        config?.providers.reduce(0) { $0 + ($1.models.count) } ?? 0
    }

    /// Adapter 数量
    var adapterCount: Int {
        config?.adapters?.count ?? 0
    }

    // MARK: - fmtNum（对齐 Web UI 逻辑）

    /// 数字格式化为 K/M 缩写
    static func fmtNum(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
        return String(n)
    }

    /// 字节数格式化
    static func fmtBytes(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.2f MB", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1f KB", Double(n) / 1_000) }
        return "\(n) B"
    }

    /// 百分比计算
    static func pct(_ n: Int, _ total: Int) -> String {
        guard total > 0 else { return "0%" }
        return String(format: "%.1f%%", Double(n) / Double(total) * 100)
    }

    // MARK: - Data Loading

    /// 拉取所有 Dashboard 数据，并发跑以压低首屏延迟
    @MainActor
    func load() async {
        isLoading = true
        errorMessage = nil

        // 并发启动 4 个独立请求，谁先回谁先写状态
        async let healthTask = client.fetchHealth()
        async let configTask = client.fetchConfig()
        async let tokenStatsTask = client.fetchTokenStats()
        async let chartsTask: Void = loadCharts()

        // 写入状态（哪个请求先回就先 await 哪个，但启动是并发的）
        if let h = try? await healthTask { health = h }
        if let c = try? await configTask { config = c.data }
        if let s = try? await tokenStatsTask { tokenStats = s }
        _ = await chartsTask

        isLoading = false
    }

    /// 加载图表数据（timeline/breakdown/db-info）
    /// 内部用 sequence number 丢弃过期请求的响应，避免快速点击导致的 UI 错乱
    @MainActor
    func loadCharts() async {
        chartRequestSeq &+= 1
        let mySeq = chartRequestSeq
        isLoadingCharts = true
        // 为每个 fetch 套上独立 Task，让它们能被 chartTask.cancel() 取消
        let timelineTask = Task { try await client.fetchTokenTimeline(days: timelineDays) }
        let breakdownTask = Task { try await client.fetchTokenBreakdown(dimension: breakdownDimension, range: breakdownRange) }
        let dbInfoTask = Task { try await client.fetchTokenDbInfo() }

        // 被取消时尽早退出，不浪费 CPU/网络
        if Task.isCancelled { return }

        let newTimeline: [TimelinePoint]? = try? await timelineTask.value
        if Task.isCancelled { return }
        let newBreakdown: [UsageBucket]? = try? await breakdownTask.value
        if Task.isCancelled { return }
        let newDbInfo: TokenDbInfo? = try? await dbInfoTask.value
        if Task.isCancelled { return }

        // 过期的请求静默丢弃，不覆盖最新数据
        guard mySeq == chartRequestSeq else { return }

        if let newTimeline { timeline = newTimeline }
        if let newBreakdown { breakdown = newBreakdown }
        if let newDbInfo { dbInfo = newDbInfo }
        isLoadingCharts = false
    }

    /// 统一的任务启动入口：取消旧任务，启动新任务并 await
    /// 避免多个 chartTask 并发造成的 MainActor 排队与响应错位
    @MainActor
    private func startChartTask() async {
        chartTask?.cancel()
        let task = Task { @MainActor [weak self] in
            await self?.loadCharts()
            return
        }
        chartTask = task
        await task.value
        chartTask = nil
    }

    /// 切换趋势天数
    @MainActor
    func setTimelineDays(_ days: Int) async {
        timelineDays = days
        await startChartTask()
    }

    /// 切换分桶维度
    @MainActor
    func setBreakdownDimension(_ dim: String) async {
        breakdownDimension = dim
        await startChartTask()
    }

    /// 切换时间范围
    @MainActor
    func setBreakdownRange(_ range: String) async {
        breakdownRange = range
        await startChartTask()
    }

    /// 清理 90 天前的历史数据
    @MainActor
    func cleanupUsage(days: Int = 90) async -> CleanupResult? {
        isCleaningUp = true
        defer { isCleaningUp = false }
        do {
            let result = try await client.cleanupTokenUsage(days: days)
            await loadCharts()
            return result
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    // MARK: - Polling

    /// 启动 10 秒轮询
    func startPolling() {
        stopPolling()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.load()
            }
        }
        // 立即触发首次加载
        Task { @MainActor [weak self] in
            await self?.load()
        }
    }

    /// 停止轮询
    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }
}