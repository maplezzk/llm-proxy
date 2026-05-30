import Foundation
import Observation

/// Dashboard 状态管理——服务状态、配置计数、Token 用量，10 秒自动刷新
@Observable
final class DashboardViewModel {
    var health: Bool = false
    var config: ConfigData?
    var tokenStats: TokenStats?
    var isLoading: Bool = false
    var errorMessage: String?

    private let client: APIClient
    private var pollTimer: Timer?

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

    /// 百分比计算
    static func pct(_ n: Int, _ total: Int) -> String {
        guard total > 0 else { return "0%" }
        return String(format: "%.1f%%", Double(n) / Double(total) * 100)
    }

    // MARK: - Data Loading

    /// 拉取所有 Dashboard 数据
    @MainActor
    func load() async {
        isLoading = true
        errorMessage = nil

        do {
            health = try await client.fetchHealth()
        } catch {
            health = false
        }

        do {
            config = try await client.fetchConfig().data
        } catch {
            // 保持上次 config，不覆盖为 nil
        }

        do {
            tokenStats = try await client.fetchTokenStats()
        } catch {
            // 保持上次 tokenStats，不覆盖为 nil
        }

        isLoading = false
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
