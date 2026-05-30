import Foundation
import Observation

/// 抓包 tab 的状态管理
@MainActor
@Observable
final class CaptureViewModel {
    var running = false
    var entries: [CaptureEntry] = []
    var selectedId: Int?
    var sourceFilter: String?
    var errorMessage: String?

    private let apiClient: APIClient
    private var captureClient: CaptureSSEClient?

    // MARK: - Computed

    /// 所有可用来源（去重排序）
    var sources: [String] {
        let raw = Set(entries.map(\.source))
        return raw.sorted()
    }

    /// 按来源过滤后的条目
    var filteredEntries: [CaptureEntry] {
        guard let filter = sourceFilter, !filter.isEmpty else {
            return entries
        }
        return entries.filter { $0.source == filter }
    }

    /// 当前选中的条目
    var selectedEntry: CaptureEntry? {
        guard let id = selectedId else { return nil }
        return entries.first { $0.id == id }
    }

    init(apiClient: APIClient = APIClient()) {
        self.apiClient = apiClient
    }

    // MARK: - Lifecycle

    /// 查询后端状态：已启用则自动连接 SSE
    func checkStatus() async {
        do {
            let enabled = try await apiClient.fetchCaptureStatus()
            if enabled {
                connectSSE()
            }
        } catch {
            // 后端不可达，静默处理
        }
    }

    // MARK: - Capture Control

    /// 开启抓包：先调用后端 API 启用，清空旧缓存，连接 SSE
    func startCapture() async {
        do {
            _ = try await apiClient.setCaptureControl(enabled: true, clear: true)
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        connectSSE()
    }

    /// 停止抓包：停用后端抓包，断开 SSE
    func stopCapture() async {
        do {
            _ = try await apiClient.setCaptureControl(enabled: false)
        } catch {
            // 网络错误时仍断开前端连接
        }
        disconnectSSE()
    }

    /// 结束抓包并清空：停用后端抓包 + 清空缓存 + 断开 SSE + 清空 UI
    func endCapture() async {
        do {
            _ = try await apiClient.setCaptureControl(enabled: false, clear: true)
        } catch {
            // 网络错误时仍清理前端
        }
        disconnectSSE()
        entries = []
        selectedId = nil
        sourceFilter = nil
        errorMessage = nil
    }

    // MARK: - Selection

    func toggleSelected(_ id: Int) {
        selectedId = selectedId == id ? nil : id
    }

    // MARK: - SSE

    private func connectSSE() {
        disconnectSSE()

        let client = CaptureSSEClient(baseURL: apiClient.baseURL)
        captureClient = client

        client.onEntries = { [weak self] batch in
            guard let self else { return }
            for entry in batch {
                if let idx = self.entries.firstIndex(where: { $0.pairId == entry.pairId }) {
                    self.entries[idx] = entry
                } else {
                    self.entries.append(entry)
                }
            }
            // 限制最大 200 条
            if self.entries.count > 200 {
                self.entries = Array(self.entries.suffix(200))
            }
        }

        client.onError = { [weak self] error in
            guard let self else { return }
            self.errorMessage = error.localizedDescription
        }

        client.onStatusChange = { [weak self] isRunning in
            guard let self else { return }
            self.running = isRunning
            if !isRunning {
                self.errorMessage = nil
            }
        }

        client.start()
        running = true

        // 加载历史数据
        Task { [weak self] in
            guard let self else { return }
            do {
                // 参考 Web UI：connectSSE 时另外 fetch /admin/debug/captures 获取全部历史
                // 这里 SSE 只推送增量，历史数据需要单独拉取
                try await self.loadHistory()
            } catch {
                // 静默处理
            }
        }
    }

    /// 加载历史抓包数据
    private func loadHistory() async throws {
        let url = URL(string: "\(apiClient.baseURL)/admin/debug/captures")!
        let (data, _) = try await URLSession.shared.data(from: url)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["success"] as? Bool == true,
              let arr = json["data"] as? [[String: Any]] else { return }
        let jsonData = try JSONSerialization.data(withJSONObject: arr)
        let history = try JSONDecoder().decode([CaptureEntry].self, from: jsonData)
        // 合并历史数据（避免重复）
        for entry in history {
            if !entries.contains(where: { $0.id == entry.id }) {
                entries.append(entry)
            }
        }
        // 按 id 排序
        entries.sort { $0.id < $1.id }
        // 限制最大 200 条
        if entries.count > 200 {
            entries = Array(entries.suffix(200))
        }
    }

    private func disconnectSSE() {
        captureClient?.stop()
        captureClient = nil
        running = false
    }
}
