import Foundation
import Observation

/// 日志级别颜色映射
enum LogLevelColor {
    static func color(for level: String) -> String {
        switch level {
        case "debug": return "gray"
        case "info": return "blue"
        case "warn": return "orange"
        case "error": return "red"
        default: return "secondary"
        }
    }
}

@MainActor
@Observable
final class LogsViewModel {
    // MARK: - State

    var allLogs: [LogEntry] = []
    var levelFilter: String? = nil
    var typeFilter: String? = nil
    var search: String = ""
    var currentPage: Int = 1
    let pageSize: Int = 50
    var isLoading: Bool = false
    var isLoadingOlder: Bool = false
    var errorMessage: String? = nil
    var autoScroll: Bool = true
    var stats: LogStats? = nil
    var hasMore: Bool = true
    var logLevel: String = "info"

    private let client: APIClient
    private var pollTimer: Timer?
    private let pollInterval: TimeInterval = 5.0
    private var isPolling: Bool = false

    // MARK: - Init

    init(client: APIClient = APIClient()) {
        self.client = client
    }

    // MARK: - Computed

    /// 经搜索词过滤后的日志（已按时间倒序排列）
    var filteredLogs: [LogEntry] {
        if search.isEmpty { return allLogs }
        let q = search.lowercased()
        return allLogs.filter { entry in
            entry.message.lowercased().contains(q) ||
            Self.formatDetails(entry.details).lowercased().contains(q)
        }
    }

    /// 当前页的日志
    var pagedLogs: [LogEntry] {
        let start = (currentPage - 1) * pageSize
        guard start < filteredLogs.count else { return [] }
        let end = min(start + pageSize, filteredLogs.count)
        return Array(filteredLogs[start..<end])
    }

    /// 总页数
    var totalPages: Int {
        max(1, Int(ceil(Double(filteredLogs.count) / Double(pageSize))))
    }

    /// 过滤后总条数
    var totalCount: Int {
        filteredLogs.count
    }

    // MARK: - API Calls

    /// 按当前过滤条件全量加载（切换 level/type 过滤时调用）
    func load() async {
        isLoading = true
        errorMessage = nil
        do {
            let response = try await client.fetchLogs(
                limit: pageSize * 2,
                level: levelFilter,
                type: typeFilter
            )
            allLogs = response.logs.sorted { $0.timestamp > $1.timestamp }
            stats = response.stats
            currentPage = 1
            hasMore = response.logs.count >= pageSize * 2
        } catch {
            // 保持已有日志不丢失
            if allLogs.isEmpty {
                errorMessage = error.localizedDescription
            }
        }
        isLoading = false
    }

    /// 轮询拉取最新日志，新 ID 追加到顶部
    func poll() async {
        guard !isPolling else { return }
        isPolling = true
        do {
            let response = try await client.fetchLogs(
                limit: 50,
                level: levelFilter,
                type: typeFilter
            )
            let existingIds = Set(allLogs.map(\.id))
            let newLogs = response.logs.filter { !existingIds.contains($0.id) }
            if !newLogs.isEmpty {
                allLogs = (newLogs + allLogs).sorted { $0.timestamp > $1.timestamp }
            }
            errorMessage = nil
        } catch {
            // 轮询静默失败，不影响已有数据
        }
        isPolling = false
    }

    /// 游标分页加载更早的日志
    func loadOlder() async {
        guard !isLoadingOlder, let oldestId = allLogs.min(by: { $0.id < $1.id })?.id else { return }
        isLoadingOlder = true
        do {
            let response = try await client.fetchLogs(
                limit: pageSize,
                before: oldestId,
                level: levelFilter,
                type: typeFilter
            )
            if response.logs.isEmpty {
                hasMore = false
            } else {
                allLogs.append(contentsOf: response.logs)
                allLogs.sort { $0.timestamp > $1.timestamp }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoadingOlder = false
    }

    // MARK: - Filter Changes

    /// 级别过滤变更 → 全量重载
    func setLevelFilter(_ level: String?) async {
        guard levelFilter != level else { return }
        levelFilter = level
        await load()
    }

    /// 类型过滤变更 → 全量重载
    func setTypeFilter(_ type: String?) async {
        guard typeFilter != type else { return }
        typeFilter = type
        await load()
    }

    /// 搜索词变更 → 客户端过滤，重置页码
    func setSearch(_ query: String) {
        search = query
        currentPage = 1
    }

    // MARK: - Pagination

    func goToPage(_ page: Int) {
        guard page >= 1 && page <= totalPages else { return }
        currentPage = page
    }

    func nextPage() {
        if currentPage < totalPages { currentPage += 1 }
    }

    func prevPage() {
        if currentPage > 1 { currentPage -= 1 }
    }

    // MARK: - Polling

    func fetchLogLevel() async {
        do {
            logLevel = try await client.fetchLogLevel()
        } catch {
            // keep default
        }
    }

    func setLogLevel(_ level: String) async {
        do {
            try await client.setLogLevel(level)
            logLevel = level
        } catch {
            // revert?
        }
    }

    func startPolling() {
        stopPolling()
        pollTimer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                await self.poll()
            }
        }
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    // MARK: - Helpers

    /// 将 details 字典格式化为 JSON 字符串，用于搜索和详情展示
    static func formatDetails(_ details: [String: AnyCodable]?) -> String {
        guard let details else { return "" }
        // 通过 AnyCodable 重新编码为 JSON
        var dict: [String: Any] = [:]
        for (key, anyCodable) in details {
            dict[key] = anyCodable.value
        }
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys]),
              let str = String(data: data, encoding: .utf8) else {
            return String(describing: dict)
        }
        return str
    }

    /// 格式化时间戳供显示（去掉毫秒部分便于阅读）
    static func formatTimestamp(_ ts: String) -> String {
        // 时间戳格式: "2026-05-28 14:30:00.123"
        // 保留到秒
        if ts.count >= 19 {
            return String(ts.prefix(19))
        }
        return ts
    }

    /// 仅提取时间部分（如 "14:30:01"）
    static func formatTimeOnly(_ ts: String) -> String {
        // 时间戳格式: "2026-05-28 14:30:00.123"
        if ts.count >= 19 {
            let start = ts.index(ts.startIndex, offsetBy: 11)
            let end = ts.index(ts.startIndex, offsetBy: 19)
            return String(ts[start..<end])
        }
        return ts
    }
}
