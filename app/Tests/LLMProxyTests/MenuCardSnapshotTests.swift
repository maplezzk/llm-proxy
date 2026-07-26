import XCTest
import SwiftUI
import AppKit
@testable import LLMProxy

/// 临时快照工具：把菜单栏卡片渲染成 PNG 到 /tmp，供视觉走查
final class MenuCardSnapshotTests: XCTestCase {

    private func render<V: View>(_ view: V, width: CGFloat, name: String) {
        let hosting = NSHostingView(rootView: view)
        hosting.frame = NSRect(origin: .zero, size: NSSize(width: width, height: 1))
        let size = hosting.fittingSize
        hosting.frame = NSRect(origin: .zero, size: NSSize(width: width, height: size.height))
        hosting.layoutSubtreeIfNeeded()

        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
            XCTFail("bitmap rep failed")
            return
        }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            XCTFail("png failed")
            return
        }
        let url = URL(fileURLWithPath: "/tmp/\(name).png")
        try? png.write(to: url)
        NSLog("snapshot written: \(url.path) size=\(size)")
    }

    func testRenderCards() {
        // 亮色 + 暗色两种外观
        for (appearanceName, suffix) in [("aqua", "light"), ("darkAqua", "dark")] {
            _ = appearanceName
            let statusModel = StatusCardModel(
                state: .running,
                port: 9000,
                todayTokensText: "52M",
                hitRateText: "78%",
                isOperationInProgress: false,
                transientText: nil
            )
            let status = StatusCardView(model: statusModel, onStart: {}, onStop: {}, onRestart: {})

            let card = AdapterCardModel(
                name: "my-tool",
                type: "anthropic",
                mappings: [
                    .init(sourceModelId: "claude-sonnet-4",
                          currentLabel: "anthropic/claude-sonnet-4-20250514",
                          options: [
                            .init(provider: "anthropic", modelId: "claude-sonnet-4-20250514", isCurrent: true),
                            .init(provider: "anthropic", modelId: "claude-opus-4", isCurrent: false),
                            .init(provider: "deepseek", modelId: "deepseek-chat", isCurrent: false),
                          ]),
                    .init(sourceModelId: "gpt-4o",
                          currentLabel: "deepseek/deepseek-chat",
                          options: [
                            .init(provider: "anthropic", modelId: "claude-sonnet-4-20250514", isCurrent: false),
                            .init(provider: "deepseek", modelId: "deepseek-chat", isCurrent: true),
                          ]),
                ]
            )
            let adapter = AdapterCardView(model: card) { _, _, _ in }

            let stopped = StatusCardView(
                model: StatusCardModel(state: .stopped, port: 9000, todayTokensText: nil, hitRateText: nil, isOperationInProgress: false, transientText: nil),
                onStart: {}, onStop: {}, onRestart: {})

            let hint = MenuHintCardView(text: "无法连接到 llm-proxy", isLoading: false)

            // 组合整菜单：状态卡 + 分隔线 + 适配器卡 + 提示卡，模拟 NSMenu 背景
            let composite = VStack(spacing: 0) {
                status
                Divider().padding(.vertical, 4)
                adapter
                Divider().padding(.vertical, 4)
                hint
            }
            .background(Color(nsColor: .windowBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .padding(10)
            .background(Color.gray)

            render(status.environment(\.colorScheme, suffix == "dark" ? .dark : .light), width: MenuCardMetrics.width, name: "card-status-\(suffix)")
            render(adapter.environment(\.colorScheme, suffix == "dark" ? .dark : .light), width: MenuCardMetrics.width, name: "card-adapter-\(suffix)")
            render(stopped.environment(\.colorScheme, suffix == "dark" ? .dark : .light), width: MenuCardMetrics.width, name: "card-stopped-\(suffix)")
            render(hint.environment(\.colorScheme, suffix == "dark" ? .dark : .light), width: MenuCardMetrics.width, name: "card-hint-\(suffix)")
            render(composite.environment(\.colorScheme, suffix == "dark" ? .dark : .light), width: MenuCardMetrics.width + 20, name: "menu-composite-\(suffix)")

            // Dashboard 新组件
            let hero = DashboardHeroView(online: true, providerCount: 3, modelCount: 12, adapterCount: 2)
            let strip = TodayUsageStripView(total: "52M", input: "38M", output: "14M", hitRate: "78%")
            let dash = VStack(spacing: 16) { hero; strip }
                .padding(20)
                .background(Color(nsColor: .windowBackgroundColor))
            render(dash.environment(\.colorScheme, suffix == "dark" ? .dark : .light), width: 640, name: "dashboard-hero-\(suffix)")
        }
    }
}
