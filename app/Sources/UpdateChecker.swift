import AppKit
import Foundation

// MARK: - Models

struct UpdateInfo {
    let version: String
    let downloadURL: URL
    let releaseNotes: String?
    let releaseDate: Date?
}

struct GitHubRelease: Codable {
    let tagName: String
    let body: String?
    let publishedAt: String?
    let assets: [GitHubAsset]

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case body
        case publishedAt = "published_at"
        case assets
    }
}

struct GitHubAsset: Codable {
    let name: String
    let browserDownloadURL: String
    let contentType: String?

    enum CodingKeys: String, CodingKey {
        case name
        case browserDownloadURL = "browser_download_url"
        case contentType = "content_type"
    }
}

// MARK: - UpdateChecker

class UpdateChecker {
    private let repository = "maplezzk/llm-proxy"
    private let session: URLSession

    /// Mock 服务器地址（通过环境变量 LLM_PROXY_UPDATE_MOCK 设置）
    private let mockBaseURL: String? = {
        if let env = ProcessInfo.processInfo.environment["LLM_PROXY_UPDATE_MOCK"], !env.isEmpty {
            return env
        }
        return nil
    }()

    /// 真实 API 基础 URL（mock 模式下替换为 mock 地址）
    private var apiBaseURL: String {
        mockBaseURL ?? "https://api.github.com"
    }

    init(session: URLSession = .shared) {
        self.session = session
    }

    /// 检查 GitHub 上是否有新版本
    /// - Returns: 如果有更新返回 UpdateInfo，否则返回 nil
    func checkForUpdates() async throws -> UpdateInfo? {
        let current = currentVersion()
        let latest = try await fetchLatestRelease()

        guard compareVersions(current, latest.version) else {
            return nil
        }

        return latest
    }

    /// 从 GitHub Releases API 获取最新版本信息
    func fetchLatestRelease() async throws -> UpdateInfo {
        let url = URL(string: "\(apiBaseURL)/repos/\(repository)/releases/latest")!
        var request = URLRequest(url: url)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        // 设置 User-Agent 是 GitHub API 的要求
        request.setValue("LLMProxy/\(currentVersion())", forHTTPHeaderField: "User-Agent")
        request.timeoutInterval = 15

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw UpdateError.invalidResponse
        }

        // GitHub API 未认证限流 60次/小时，达到会返回 403
        guard httpResponse.statusCode == 200 else {
            throw UpdateError.httpError(statusCode: httpResponse.statusCode)
        }

        let decoder = JSONDecoder()
        let release = try decoder.decode(GitHubRelease.self, from: data)

        // 解析版本号（去掉 v 前缀）
        let version = release.tagName.hasPrefix("v")
            ? String(release.tagName.dropFirst())
            : release.tagName

        // 在 assets 中查找 DMG
        let dmgName = "LLMProxy-v\(version).dmg"
        guard let asset = release.assets.first(where: { $0.name == dmgName }),
              let downloadURL = URL(string: asset.browserDownloadURL) else {
            throw UpdateError.dmgAssetNotFound(version: version)
        }

        // 解析发布日期
        var releaseDate: Date? = nil
        if let dateStr = release.publishedAt {
            let formatter = ISO8601DateFormatter()
            releaseDate = formatter.date(from: dateStr)
        }

        return UpdateInfo(
            version: version,
            downloadURL: downloadURL,
            releaseNotes: release.body,
            releaseDate: releaseDate
        )
    }

    /// 语义化版本比较
    /// - Returns: true 如果 latest > current
    func compareVersions(_ current: String, _ latest: String) -> Bool {
        let currentParts = parseVersion(current)
        let latestParts = parseVersion(latest)

        // 逐段比较 major.minor.patch
        let maxDepth = max(currentParts.count, latestParts.count)
        for i in 0..<maxDepth {
            let c = i < currentParts.count ? currentParts[i] : 0
            let l = i < latestParts.count ? latestParts[i] : 0
            if l > c { return true }
            if l < c { return false }
        }
        return false
    }

    /// 将版本字符串解析为整数数组，如 "0.12.3" -> [0, 12, 3]
    private func parseVersion(_ version: String) -> [Int] {
        // 清理可能的 v 前缀和预发布后缀
        var clean = version
        if clean.hasPrefix("v") { clean = String(clean.dropFirst()) }
        // 只取主版本号部分（忽略 -beta, -alpha 等后缀）
        if let dashIndex = clean.firstIndex(of: "-") {
            clean = String(clean[..<dashIndex])
        }

        return clean
            .split(separator: ".")
            .compactMap { Int($0) }
    }

    // MARK: - Download with Progress

    private var activeDownloadDelegate: DownloadTaskDelegate?

    /// 带进度的 DMG 下载（自动重试）
    /// - Parameters:
    ///   - info: 更新信息
    ///   - progressHandler: 进度回调 0.0~1.0，在主线程调用
    /// - Returns: 下载完成的本地文件 URL
    func downloadUpdate(_ info: UpdateInfo, progressHandler: ((Double) -> Void)? = nil) async throws -> URL {
        let updatesDir = try ensureUpdatesDirectory()
        let fileName = "LLMProxy-v\(info.version).dmg"
        let fileURL = updatesDir.appendingPathComponent(fileName)

        // 如果已下载相同版本，直接返回
        if FileManager.default.fileExists(atPath: fileURL.path) {
            await MainActor.run { progressHandler?(1.0) }
            return fileURL
        }

        // 清理旧 DMG 文件
        cleanOldDownloads(updatesDir: updatesDir, keep: fileName)

        // 最多重试 2 次
        var lastError: Error? = nil
        for attempt in 1...3 {
            do {
                let tempURL = try await downloadWithProgress(
                    url: info.downloadURL,
                    progressHandler: progressHandler
                )

                // 移动到目标位置
                if FileManager.default.fileExists(atPath: fileURL.path) {
                    try FileManager.default.removeItem(at: fileURL)
                }
                try FileManager.default.moveItem(at: tempURL, to: fileURL)

                await MainActor.run { progressHandler?(1.0) }
                return fileURL
            } catch {
                lastError = error
                if attempt < 3 {
                    // 指数退避重试
                    let delay = UInt64(attempt * 2_000_000_000)
                    try await Task.sleep(nanoseconds: delay)
                }
            }
        }

        throw lastError ?? UpdateError.downloadFailed
    }

    /// 使用 URLSessionDownloadDelegate 实现带进度的下载
    private func downloadWithProgress(url: URL, progressHandler: ((Double) -> Void)?) async throws -> URL {
        return try await withCheckedThrowingContinuation { continuation in
            let delegate = DownloadTaskDelegate(
                progressHandler: { progress in
                    Task { @MainActor in
                        progressHandler?(progress)
                    }
                },
                completionHandler: { result in
                    continuation.resume(with: result)
                }
            )
            // 保持 delegate 引用，防止被释放
            self.activeDownloadDelegate = delegate

            let config = URLSessionConfiguration.default
            config.timeoutIntervalForResource = 300 // 5分钟超时
            let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)

            let task = session.downloadTask(with: url)
            delegate.cleanup = {
                session.invalidateAndCancel()
                self.activeDownloadDelegate = nil
            }
            task.resume()
        }
    }

    // MARK: - Private Helpers

    private func ensureUpdatesDirectory() throws -> URL {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        ).first!

        let updatesDir = appSupport
            .appendingPathComponent("LLMProxy")
            .appendingPathComponent("Updates")

        try FileManager.default.createDirectory(
            at: updatesDir,
            withIntermediateDirectories: true
        )

        return updatesDir
    }

    /// 全自动安装更新：挂载 DMG → 替换 App → 卸载 DMG → 重启
    /// - Parameter localURL: 已下载的 DMG 文件 URL
    /// - Throws: UpdateError.installationFailed
    func installUpdate(at localURL: URL) async throws {
        let mountPath = try mountDMG(at: localURL)
        let appInDMG = mountPath.appendingPathComponent("LLMProxy.app")

        guard FileManager.default.fileExists(atPath: appInDMG.path) else {
            unmountDMG(at: mountPath)
            throw UpdateError.installationFailed(reason: "DMG 中未找到 LLMProxy.app")
        }

        let destinationURL = URL(fileURLWithPath: "/Applications/LLMProxy.app")

        // 删除旧版本
        if FileManager.default.fileExists(atPath: destinationURL.path) {
            try FileManager.default.removeItem(at: destinationURL)
        }

        // 用 ditto 复制新版本（保留签名和扩展属性）
        try await runProcess(
            executable: "/usr/bin/ditto",
            arguments: [appInDMG.path, destinationURL.path]
        )

        // 卸载 DMG
        unmountDMG(at: mountPath)

        // 清理下载的 DMG
        try? FileManager.default.removeItem(at: localURL)

        // 创建重启 helper 脚本并执行
        try createAndLaunchRestartHelper(appPath: destinationURL.path)
    }

    // MARK: - DMG Operations

    /// 挂载 DMG 并返回挂载路径
    private func mountDMG(at dmgURL: URL) throws -> URL {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        process.arguments = ["attach", "-nobrowse", "-plist", dmgURL.path]

        let outputPipe = Pipe()
        process.standardOutput = outputPipe

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            throw UpdateError.installationFailed(reason: "hdiutil attach 失败")
        }

        let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
        guard let plist = try? PropertyListSerialization.propertyList(from: outputData, options: [], format: nil),
              let entries = plist as? [[String: Any]] else {
            throw UpdateError.installationFailed(reason: "无法解析 hdiutil 输出")
        }

        // 查找挂载点
        for entry in entries {
            if let mountPoint = entry["mount-point"] as? String {
                return URL(fileURLWithPath: mountPoint)
            }
        }

        throw UpdateError.installationFailed(reason: "未找到 DMG 挂载点")
    }

    /// 卸载 DMG
    private func unmountDMG(at mountPath: URL) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        process.arguments = ["detach", mountPath.path, "-quiet"]
        try? process.run()
        process.waitUntilExit()
    }

    // MARK: - Restart Helper

    /// 创建重启 helper 脚本并执行
    /// 由于应用需要退出后才能被新版本替换，使用一个后台 shell 脚本完成：
    /// 1. 等待当前进程退出
    /// 2. 用 open 启动新版本
    private func createAndLaunchRestartHelper(appPath: String) throws {
        let helperDir = try ensureUpdatesDirectory()
        let helperPath = helperDir.appendingPathComponent("restart-llmproxy.sh")

        let script = """
        #!/bin/bash
        sleep 1
        open \(appPath)
        """

        try script.write(to: helperPath, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helperPath.path)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [helperPath.path]
        try process.run()
    }

    // MARK: - Process Helper

    @discardableResult
    private func runProcess(executable: String, arguments: [String]) async throws -> String {
        return try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments

            let outputPipe = Pipe()
            let errorPipe = Pipe()
            process.standardOutput = outputPipe
            process.standardError = errorPipe

            process.terminationHandler = { proc in
                let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
                let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: outputData, encoding: .utf8) ?? ""
                let errorOutput = String(data: errorData, encoding: .utf8) ?? ""

                if proc.terminationStatus == 0 {
                    continuation.resume(returning: output)
                } else {
                    let msg = errorOutput.isEmpty ? output : errorOutput
                    continuation.resume(throwing: UpdateError.installationFailed(reason: msg.trimmingCharacters(in: .whitespacesAndNewlines)))
                }
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    /// 应用启动时清理旧的下载文件
    func cleanUpOnLaunch() {
        guard let updatesDir = try? ensureUpdatesDirectory() else { return }
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: updatesDir,
            includingPropertiesForKeys: [.creationDateKey]
        ) else { return }

        let dmgFiles = files.filter { $0.lastPathComponent.hasSuffix(".dmg") }
        guard dmgFiles.count > 1 else { return }

        // 按创建日期排序，保留最新的一个，删除旧的
        let sorted = dmgFiles.sorted { a, b in
            let dateA = (try? a.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            let dateB = (try? b.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            return dateA > dateB
        }

        // 保留最新的，删除其余
        for file in sorted.dropFirst() {
            try? FileManager.default.removeItem(at: file)
        }
    }

    /// 清理旧 DMG 文件（保留最新的一份）
    private func cleanOldDownloads(updatesDir: URL, keep: String) {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: updatesDir,
            includingPropertiesForKeys: nil
        ) else { return }

        for file in files where file.lastPathComponent.hasSuffix(".dmg") {
            if file.lastPathComponent != keep {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }
}

// MARK: - DownloadTaskDelegate

/// URLSessionDownloadDelegate 实现，支持进度回调和 async/await 桥接
private class DownloadTaskDelegate: NSObject, URLSessionDownloadDelegate {
    let progressHandler: (Double) -> Void
    let completionHandler: (Result<URL, Error>) -> Void
    var cleanup: (() -> Void)?

    init(progressHandler: @escaping (Double) -> Void,
         completionHandler: @escaping (Result<URL, Error>) -> Void) {
        self.progressHandler = progressHandler
        self.completionHandler = completionHandler
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let progress = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        progressHandler(min(progress, 1.0))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        // 先复制到可访问的位置，因为 location 是临时目录
        let tempDir = FileManager.default.temporaryDirectory
        let tempURL = tempDir.appendingPathComponent(location.lastPathComponent)
        try? FileManager.default.removeItem(at: tempURL)
        do {
            try FileManager.default.moveItem(at: location, to: tempURL)
            completionHandler(.success(tempURL))
        } catch {
            completionHandler(.failure(error))
        }
        cleanup?()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didCompleteWithError error: Error?) {
        if let error = error {
            completionHandler(.failure(error))
            cleanup?()
        }
    }
}

// MARK: - Errors

enum UpdateError: LocalizedError {
    case invalidResponse
    case httpError(statusCode: Int)
    case dmgAssetNotFound(version: String)
    case downloadFailed
    case installationFailed(reason: String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid response from server"
        case .httpError(let code):
            return "Server returned HTTP \(code)"
        case .dmgAssetNotFound(let version):
            return "DMG asset not found for version \(version)"
        case .downloadFailed:
            return "Failed to download update"
        case .installationFailed(let reason):
            return reason
        }
    }
}
