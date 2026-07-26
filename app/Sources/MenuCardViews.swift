import SwiftUI
import AppKit

/// 菜单栏卡片统一宽度（CodexBar 风格富菜单）
enum MenuCardMetrics {
    static let width: CGFloat = 300
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
                    controlButton(loc("action.stop"), systemImage: "stop.fill", action: onStop)
                    controlButton(loc("action.restart"), systemImage: "arrow.clockwise", action: onRestart)
                } else {
                    controlButton(loc("action.start"), systemImage: "play.fill", action: onStart)
                }
            }
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
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
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
        /// 当前映射展示文本 "provider/targetModelId"
        let currentLabel: String
        let options: [Option]
    }

    struct Option: Identifiable {
        var id: String { "\(provider)/\(modelId)" }
        let provider: String
        let modelId: String
        let isCurrent: Bool
    }
}

struct AdapterCardView: View {
    let model: AdapterCardModel
    let onSwitch: (_ sourceModelId: String, _ provider: String, _ targetModelId: String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "bolt.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.orange)
                Text(model.name)
                    .font(.system(size: 12.5, weight: .semibold))
                Text(model.type)
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1.5)
                    .background(Capsule().fill(Color.secondary.opacity(0.12)))
                Spacer()
            }

            VStack(spacing: 4) {
                ForEach(model.mappings) { mapping in
                    HStack(spacing: 8) {
                        Text(mapping.sourceModelId)
                            .font(.system(size: 12, weight: .medium))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .layoutPriority(1)
                        Spacer(minLength: 8)
                        ModelSwitchPopUp(
                            currentLabel: mapping.currentLabel,
                            options: mapping.options,
                            onSelect: { option in
                                onSwitch(mapping.sourceModelId, option.provider, option.modelId)
                            }
                        )
                        .fixedSize()
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(width: MenuCardMetrics.width, alignment: .leading)
    }
}

// MARK: - 行内模型切换下拉（NSPopUpButton，菜单内点击直接弹出选项）

struct ModelSwitchPopUp: NSViewRepresentable {
    let currentLabel: String
    let options: [AdapterCardModel.Option]
    let onSelect: (AdapterCardModel.Option) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSelect: onSelect, options: options)
    }

    func makeNSView(context: Context) -> NSPopUpButton {
        let button = NSPopUpButton(frame: .zero, pullsDown: false)
        button.isBordered = false
        button.font = NSFont.systemFont(ofSize: 11)
        button.target = context.coordinator
        button.action = #selector(Coordinator.changed(_:))
        button.lineBreakMode = .byTruncatingMiddle
        button.widthAnchor.constraint(lessThanOrEqualToConstant: 150).isActive = true
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        rebuildItems(button, coordinator: context.coordinator)
        return button
    }

    func updateNSView(_ button: NSPopUpButton, context: Context) {
        context.coordinator.options = options
        context.coordinator.onSelect = onSelect
        rebuildItems(button, coordinator: context.coordinator)
    }

    private func rebuildItems(_ button: NSPopUpButton, coordinator: Coordinator) {
        let selectedIndex = options.firstIndex(where: { $0.isCurrent })
        button.removeAllItems()
        for option in options {
            button.addItem(withTitle: "\(option.provider)/\(option.modelId)")
            if let item = button.itemArray.last, option.isCurrent {
                item.state = .on
            }
        }
        if let selectedIndex {
            button.selectItem(at: selectedIndex)
        }
        applyTitleStyle(button)
    }

    /// 让按钮标题呈现弱化样式（11pt secondary），选择后需重贴
    static func applyTitleStyle(_ button: NSPopUpButton) {
        let title = button.titleOfSelectedItem ?? button.title
        button.attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 11),
            .foregroundColor: NSColor.secondaryLabelColor,
        ])
    }

    private func applyTitleStyle(_ button: NSPopUpButton) {
        Self.applyTitleStyle(button)
    }

    final class Coordinator: NSObject {
        var options: [AdapterCardModel.Option]
        var onSelect: (AdapterCardModel.Option) -> Void

        init(onSelect: @escaping (AdapterCardModel.Option) -> Void, options: [AdapterCardModel.Option]) {
            self.onSelect = onSelect
            self.options = options
        }

        @objc func changed(_ sender: NSPopUpButton) {
            let index = sender.indexOfSelectedItem
            guard options.indices.contains(index) else { return }
            ModelSwitchPopUp.applyTitleStyle(sender)
            onSelect(options[index])
        }
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

func makeAdapterCardModels(adapters: [Adapter], providers: [Provider]) -> [AdapterCardModel] {
    adapters.map { adapter in
        AdapterCardModel(
            name: adapter.name,
            type: adapter.type,
            mappings: adapter.models.map { mapping in
                AdapterCardModel.Mapping(
                    sourceModelId: mapping.sourceModelId,
                    currentLabel: "\(mapping.provider)/\(mapping.targetModelId)",
                    options: providers.flatMap { provider in
                        provider.models.map { model in
                            AdapterCardModel.Option(
                                provider: provider.name,
                                modelId: model.id,
                                isCurrent: provider.name == mapping.provider && model.id == mapping.targetModelId
                            )
                        }
                    }
                )
            }
        )
    }
}
