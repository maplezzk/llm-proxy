import Foundation

/// SSE 流读取客户端，用于 Capture 实时抓包数据
class CaptureSSEClient: NSObject {
    var baseURL: String
    private var task: Task<Void, Never>?
    private var isRunning = false
    var onEntry: ((CaptureEntry) -> Void)?
    var onError: ((Error) -> Void)?
    var onStatusChange: ((Bool) -> Void)?

    init(baseURL: String) {
        self.baseURL = baseURL
        super.init()
    }

    func start() {
        guard !isRunning else { return }
        isRunning = true
        onStatusChange?(true)

        task = Task {
            await readStream()
        }
    }

    func stop() {
        isRunning = false
        task?.cancel()
        task = nil
        onStatusChange?(false)
    }

    /// 读取 SSE 流，逐行解析 `data:` 前缀行
    private func readStream() async {
        guard let url = URL(string: "\(baseURL)/admin/debug/captures/stream") else {
            onError?(URLError(.badURL))
            return
        }

        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: URLRequest(url: url))

            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                onError?(URLError(.badServerResponse))
                return
            }

            var buffer = ""
            for try await line in bytes.lines {
                guard isRunning else { break }

                if line.hasPrefix("data: ") {
                    let json = String(line.dropFirst(6))
                    buffer += json
                } else if line.isEmpty && !buffer.isEmpty {
                    // 空行表示一条完整消息
                    if let data = buffer.data(using: .utf8) {
                        do {
                            let entry = try JSONDecoder().decode(CaptureEntry.self, from: data)
                            await MainActor.run {
                                self.onEntry?(entry)
                            }
                        } catch {
                            // 跳过无法解析的条目
                        }
                    }
                    buffer = ""
                }
            }
        } catch let error as URLError where error.code == .cancelled {
            // 正常取消
        } catch {
            if isRunning {
                await MainActor.run {
                    self.onError?(error)
                }
            }
        }
    }
}
