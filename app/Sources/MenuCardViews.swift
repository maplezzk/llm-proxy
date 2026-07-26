import SwiftUI
import AppKit

/// 菜单栏卡片统一宽度（CodexBar 风格富菜单）
enum MenuCardMetrics {
    /// 需 ≥ 原生菜单项（图标 + 文案 + 快捷键）的自然宽度，
    /// 否则卡片右侧会出现空隙（菜单宽度由最宽的项决定）
    static let width: CGFloat = 340
}

// MARK: - 状态卡片

struct StatusCardModel {
    let state: ServiceState
    let port: Int
    /// 今日用量摘要（格式化后的 "52M"），nil 表示不可用/未运行
    let todayTokensText: String?
    /// 缓存命中率（"78%"），nil 表示不可用
    let hitRateText: String?
    let isOperationInProgress: Bool
    /// 操作进行中的临时文案（"正在停止..."），优先级高于 state 文案
    let transientText: String?

    var statusText: String {
        if let transientText { return transientText }
        switch state {
        case .starting: return loc("menu.status.starting")
        case .running: return loc("menu.status.running")
        case .stopped: return loc("menu.status.stopped")
        }
    }

    var statusColor: Color {
        if transientText != nil { return .orange }
        switch state {
        case .starting: return .orange
        case .running: return Color(red: 0.20, green: 0.68, blue: 0.30)
        case .stopped: return .secondary
        }
    }
}

struct StatusCardView: View {
    let model: StatusCardModel
    let onStart: () -> Void
    let onStop: () -> Void
    let onRestart: () -> Void
    let onReload: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(model.statusColor)
                    .frame(width: 8, height: 8)
                Text(model.statusText)
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                Text(verbatim: ":\(model.port)")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.secondary.opacity(0.12)))
            }

            if let tokens = model.todayTokensText {
                Text(loc("menu.todayUsage", tokens, model.hitRateText ?? "–"))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                if model.state == .running {
                    controlButton(loc("menu.btn.stop"), systemImage: "stop.fill", action: onStop)
                    controlButton(loc("menu.btn.restart"), systemImage: "arrow.clockwise", action: onRestart)
                    controlButton(loc("menu.btn.reload"), systemImage: "arrow.triangle.2.circlepath", action: onReload)
                } else {
                    controlButton(loc("menu.btn.start"), systemImage: "play.fill", action: onStart)
                }
            }
            .frame(maxWidth: .infinity)
            .disabled(model.isOperationInProgress)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(width: MenuCardMetrics.width, alignment: .leading)
    }

    private func controlButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 11, weight: .medium))
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.regular)
    }
}

// MARK: - 适配器卡片（模型行内切换）

struct AdapterCardModel {
    let name: String
    let type: String
    let mappings: [Mapping]

    struct Mapping: Identifiable {
        var id: String { sourceModelId }
        let sourceModelId: String
        let provider: String
        let targetModelId: String
        /// 当前映射展示文本 "provider/targetModelId"
        var currentLabel: String { "\(provider)/\(targetModelId)" }
    }
}

// MARK: - 适配器头（名称 + 协议类型，不可点击）

struct AdapterHeaderCardView: View {
    let name: String
    let type: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "bolt.fill")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.orange)
            Text(name)
                .font(.system(size: 12.5, weight: .semibold))
            Text(type)
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 5)
                .padding(.vertical, 1.5)
                .background(Capsule().fill(Color.secondary.opacity(0.12)))
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 2)
        .frame(width: MenuCardMetrics.width, alignment: .leading)
    }
}

// MARK: - 映射行（悬停高亮 + 展开模型子菜单，无需点击）

struct MappingRowView: View {
    let sourceModelId: String
    let currentLabel: String
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 8) {
            Text(sourceModelId)
                .font(.system(size: 12.5, weight: .medium))
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(1)
            Spacer(minLength: 8)
            Text(currentLabel)
                .font(.system(size: 11.5))
                .lineLimit(1)
                .truncationMode(.middle)
                .foregroundStyle(isHovered ? Color.white.opacity(0.85) : Color.secondary)
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(isHovered ? Color.white.opacity(0.85) : Color.secondary)
        }
        .foregroundStyle(isHovered ? Color.white : Color.primary)
        .padding(.horizontal, 14)
        .padding(.vertical, 5)
        .background {
            if isHovered {
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color(nsColor: .selectedContentBackgroundColor))
                    .padding(.horizontal, 5)
            }
        }
        .frame(width: MenuCardMetrics.width, alignment: .leading)
        .onHover { isHovered = $0 }
    }
}

// MARK: - 菜单提示行（加载中 / 无法连接）

struct MenuHintCardView: View {
    let text: String
    var isLoading: Bool = true

    var body: some View {
        HStack(spacing: 8) {
            if isLoading {
                ProgressView()
                    .scaleEffect(0.6)
                    .frame(width: 12, height: 12)
            } else {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(width: MenuCardMetrics.width, alignment: .leading)
    }
}

// MARK: - 纯函数：由 adapters/providers 构建卡片模型（便于测试）

func makeAdapterCardModels(adapters: [Adapter]) -> [AdapterCardModel] {
    adapters.map { adapter in
        AdapterCardModel(
            name: adapter.name,
            type: adapter.type,
            mappings: adapter.models.map { mapping in
                AdapterCardModel.Mapping(
                    sourceModelId: mapping.sourceModelId,
                    provider: mapping.provider,
                    targetModelId: mapping.targetModelId
                )
            }
        )
    }
}
