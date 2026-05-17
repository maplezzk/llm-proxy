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
        let url = URL(string: "https://api.github.com/repos/\(repository)/releases/latest")!
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

    /// 下载 DMG 更新文件
    /// - Parameter info: 更新信息
    /// - Returns: 下载完成的本地文件 URL
    func downloadUpdate(_ info: UpdateInfo, progressHandler: ((Double) -> Void)? = nil) async throws -> URL {
        let updatesDir = try ensureUpdatesDirectory()
        let fileName = "LLMProxy-v\(info.version).dmg"
        let fileURL = updatesDir.appendingPathComponent(fileName)

        // 如果已下载相同版本，跳过重复下载
        if FileManager.default.fileExists(atPath: fileURL.path) {
            return fileURL
        }

        // 清理旧 DMG 文件
        cleanOldDownloads(updatesDir: updatesDir, keep: fileName)

        let downloadRequest = URLRequest(url: info.downloadURL)
        let (localURL, response) = try await session.download(for: downloadRequest)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw UpdateError.downloadFailed
        }

        // 移动到目标位置
        if FileManager.default.fileExists(atPath: fileURL.path) {
            try FileManager.default.removeItem(at: fileURL)
        }
        try FileManager.default.moveItem(at: localURL, to: fileURL)

        return fileURL
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

    /// 安装更新：在 Finder 中打开 DMG 并提示用户拖入 Applications
    /// - Parameter localURL: 已下载的 DMG 文件 URL
    /// - Returns: true 如果成功打开 DMG
    func installUpdate(at localURL: URL) -> Bool {
        return NSWorkspace.shared.open(localURL)
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

// MARK: - Errors

enum UpdateError: LocalizedError {
    case invalidResponse
    case httpError(statusCode: Int)
    case dmgAssetNotFound(version: String)
    case downloadFailed

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
        }
    }
}
