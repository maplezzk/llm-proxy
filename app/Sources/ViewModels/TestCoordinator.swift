import SwiftUI

/// 测试协调器——Provider/Adapter 行级测试按钮跳转到测试 tab 的桥梁
@MainActor @Observable
final class TestCoordinator {
    /// 待填充的 Provider 测试参数
    var pendingProviderName: String?
    var pendingProviderType: String?
    var pendingApiKey: String?
    var pendingApiBase: String?
    var pendingModels: [String]?
    /// 待填充的 Adapter 测试参数
    var pendingAdapterName: String?
    var pendingAdapterModelId: String?
    /// 触发跳转到测试 tab
    var shouldSwitchToTestTab = false

    /// Provider 行测试按钮点击
    func requestProviderTest(provider: ProviderDetail) {
        clear()
        pendingProviderName = provider.name
        pendingProviderType = provider.type
        pendingApiKey = provider.api_key
        pendingApiBase = provider.api_base
        pendingModels = provider.models.map { $0.id }
        shouldSwitchToTestTab = true
    }

    /// Adapter 行测试按钮点击
    func requestAdapterTest(adapter: Adapter, firstModelId: String?) {
        clear()
        pendingAdapterName = adapter.name
        pendingAdapterModelId = firstModelId
        shouldSwitchToTestTab = true
    }

    /// 测试 tab 读取后清除
    func consumeProviderPending() -> ProviderPending? {
        defer { clearProvider() }
        guard let name = pendingProviderName else { return nil }
        return ProviderPending(
            name: name,
            type: pendingProviderType ?? "openai",
            apiKey: pendingApiKey ?? "",
            apiBase: pendingApiBase ?? "",
            models: pendingModels ?? []
        )
    }

    func consumeAdapterPending() -> AdapterPending? {
        defer { clearAdapter() }
        guard let name = pendingAdapterName else { return nil }
        return AdapterPending(name: name, modelId: pendingAdapterModelId ?? "")
    }

    func consumeSwitchFlag() -> Bool {
        defer { shouldSwitchToTestTab = false }
        return shouldSwitchToTestTab
    }

    func clear() { clearProvider(); clearAdapter() }
    private func clearProvider() { pendingProviderName = nil; pendingProviderType = nil; pendingApiKey = nil; pendingApiBase = nil; pendingModels = nil }
    private func clearAdapter() { pendingAdapterName = nil; pendingAdapterModelId = nil }
}

struct ProviderPending { let name, type, apiKey, apiBase: String; let models: [String] }
struct AdapterPending { let name, modelId: String }
