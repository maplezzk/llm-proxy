import Foundation

/// SSE 流读取客户端，用于 Capture 实时抓包数据
/// 内置节流机制：缓冲收到的条目，每 300ms 批量回调一次，避免主线程过载
class CaptureSSEClient: NSObject {
    var baseURL: String
    private var task: Task<Void, Never>?
    private var flushTask: Task<Void, Never>?
    private var isRunning = false

    /// 批量回调（替代逐条 onEntry）
    var onEntries: (([CaptureEntry]) -> Void)?
    var onError: ((Error) -> Void)?
    var onStatusChange: ((Bool) -> Void)?

    /// 节流间隔（秒）
    private let throttleInterval: TimeInterval = 0.3

    /// 缓冲区（后台线程访问，用锁保护）
    private let bufferLock = NSLock()
    private var buffer: [CaptureEntry] = []

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

        // 启动定时刷新
        flushTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(300))
                self.flushBuffer()
            }
        }
    }

    func stop() {
        isRunning = false
        task?.cancel()
        task = nil
        flushTask?.cancel()
        flushTask = nil
        onStatusChange?(false)
    }

    /// 将缓冲区中的条目批量回调到主线程
    @MainActor
    private func flushBuffer() {
        bufferLock.lock()
        let batch = buffer
        buffer.removeAll(keepingCapacity: true)
        bufferLock.unlock()

        guard !batch.isEmpty else { return }
        onEntries?(batch)
    }

    /// 读取 SSE 流，逐行解析 `data:` 前缀行，解析后放入缓冲区
    private func readStream() async {
        guard let url = URL(string: "\(baseURL)/admin/debug/captures/stream") else {
            await MainActor.run { self.onError?(URLError(.badURL)) }
            return
        }

        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: URLRequest(url: url))

            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                await MainActor.run { self.onError?(URLError(.badServerResponse)) }
                return
            }

            var jsonBuffer = ""
            for try await line in bytes.lines {
                guard isRunning else { break }

                if line.hasPrefix("data: ") {
                    let json = String(line.dropFirst(6))
                    jsonBuffer += json
                } else if line.isEmpty && !jsonBuffer.isEmpty {
                    // 空行表示一条完整消息
                    if let data = jsonBuffer.data(using: .utf8) {
                        do {
                            let entry = try JSONDecoder().decode(CaptureEntry.self, from: data)
                            // 放入缓冲区（不阻塞主线程）
                            bufferLock.lock()
                            buffer.append(entry)
                            bufferLock.unlock()
                        } catch {
                            // 跳过无法解析的条目
                        }
                    }
                    jsonBuffer = ""
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
