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

    init(
        state: ServiceState,
        port: Int,
        todayTokensText: String?,
        hitRateText: String?,
        isOperationInProgress: Bool,
        transientText: String?
    ) {
        self.state = state
        self.port = port
        self.todayTokensText = todayTokensText
        self.hitRateText = hitRateText
        self.isOperationInProgress = isOperationInProgress
        self.transientText = transientText
    }

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

/// 菜单栏迷你用量图的数据点。
struct MenuUsagePoint: Identifiable {
    let date: String
    let tokens: Int

    var id: String { date }
}

/// 菜单打开后仍由同一份状态驱动卡片，避免重建 NSMenu 后当前已展开的旧菜单不更新。
final class MenuCardState: ObservableObject {
    @Published var model: StatusCardModel
    @Published var usagePoints: [MenuUsagePoint]

    init(model: StatusCardModel, usagePoints: [MenuUsagePoint] = []) {
        self.model = model
        self.usagePoints = usagePoints
    }
}

enum MenuUsageDimension: String, CaseIterable, Identifiable {
    case provider
    case adapter
    case providerModel = "model"
    case adapterModel

    var id: String { rawValue }

    var titleKey: String {
        switch self {
        case .provider: return "dashboard.usage.dimProvider"
        case .adapter: return "dashboard.usage.dimAdapter"
        case .providerModel: return "dashboard.usage.dimModel"
        case .adapterModel: return "dashboard.usage.dimAdapterModel"
        }
    }
}

/// 菜单栏用量图的交互状态独立于 NSMenu 重建，避免 hover 详情出现时菜单闪退或丢失焦点。
final class MenuUsageInteraction: ObservableObject {
    @Published var hoveredDate: String?
    @Published var dimension: MenuUsageDimension = .provider
    @Published var buckets: [UsageBucket] = []
    @Published var isLoading = false
}

struct ServiceStatusCardView: View {
    let model: StatusCardModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // 品牌头行：App 图标 + 名称 + 状态（ClashMac 风格）
            HStack(spacing: 10) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: 6.5, style: .continuous))
                Text(loc("app.title"))
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                Circle()
                    .fill(model.statusColor)
                    .frame(width: 8, height: 8)
                Text(model.statusText)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            HStack {
                if let tokens = model.todayTokensText {
                    Text(loc("menu.todayUsage", tokens, model.hitRateText ?? "–"))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(verbatim: ":\(model.port)")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.secondary.opacity(0.12)))
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .frame(width: MenuCardMetrics.width, alignment: .leading)
    }
}

/// 图表必须是独立的 NSMenuItem 内容，这样子菜单和高亮只响应图表区域，
/// 不会覆盖上方服务状态或下方控制按钮。
struct MenuUsageChartCardView: View {
    let points: [MenuUsagePoint]
    @State private var isHighlighted = false

    var body: some View {
        MenuUsageChartView(
            points: points,
            isHighlighted: isHighlighted
        )
        .padding(.horizontal, 14)
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            if isHighlighted {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(nsColor: .selectedContentBackgroundColor))
                    .padding(.horizontal, 6)
            }
        }
        .contentShape(Rectangle())
        .onHover { isHighlighted = $0 }
        .frame(width: MenuCardMetrics.width, alignment: .leading)
    }
}

struct ServiceControlCardView: View {
    let model: StatusCardModel
    let onStart: () -> Void
    let onStop: () -> Void
    let onRestart: () -> Void
    let onReload: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            if model.state == .running {
                CardButton(title: loc("menu.btn.stop"), systemImage: "stop", tint: .red, action: onStop)
                CardButton(title: loc("menu.btn.restart"), systemImage: "arrow.clockwise", tint: .orange, action: onRestart)
                CardButton(title: loc("menu.btn.reload"), systemImage: "arrow.triangle.2.circlepath", tint: .blue, action: onReload)
            } else {
                CardButton(title: loc("menu.btn.start"), systemImage: "play", tint: Color(red: 0.20, green: 0.68, blue: 0.30), action: onStart)
            }
        }
        .frame(maxWidth: .infinity)
        .disabled(model.isOperationInProgress)
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .frame(width: MenuCardMetrics.width, alignment: .leading)
    }
}

/// NSMenu 已打开时，AppKit 可能仍在展示旧的 NSMenu 实例；这些包装器观察共享状态，
/// 让旧实例中的 SwiftUI 内容也能随服务操作和轮询结果立即更新。
struct LiveServiceStatusCardView: View {
    @ObservedObject var state: MenuCardState

    var body: some View {
        ServiceStatusCardView(model: state.model)
    }
}

struct LiveMenuUsageChartCardView: View {
    @ObservedObject var state: MenuCardState

    var body: some View {
        MenuUsageChartCardView(points: state.usagePoints)
    }
}

struct LiveServiceControlCardView: View {
    @ObservedObject var state: MenuCardState
    let onStart: () -> Void
    let onStop: () -> Void
    let onRestart: () -> Void
    let onReload: () -> Void

    var body: some View {
        ServiceControlCardView(
            model: state.model,
            onStart: onStart,
            onStop: onStop,
            onRestart: onRestart,
            onReload: onReload
        )
    }
}

/// 菜单栏里的低噪声 30 天用量图：只保留总量柱，避免在窄卡片里堆叠完整坐标系。
struct MenuUsageChartView: View {
    let points: [MenuUsagePoint]
    let isHighlighted: Bool
    @State private var hoveredDate: String?

    private var totalTokens30Days: Int {
        points.reduce(0) { $0 + $1.tokens }
    }

    private var maxTokens: Int {
        max(points.map(\.tokens).max() ?? 0, 1)
    }

    private var firstDate: String { shortDate(points.first?.date ?? "") }
    private var lastDate: String { shortDate(points.last?.date ?? "") }
    private var selectedTextColor: Color {
        Color(nsColor: .selectedMenuItemTextColor)
    }
    private var primaryTextColor: Color {
        isHighlighted ? selectedTextColor : .primary
    }
    private var secondaryTextColor: Color {
        isHighlighted ? selectedTextColor.opacity(0.82) : .secondary
    }
    private var tertiaryTextColor: Color {
        isHighlighted ? selectedTextColor.opacity(0.64) : Color(nsColor: .tertiaryLabelColor)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(loc("menu.usage.last30Total"))
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(secondaryTextColor)
                Spacer()
                Text(DashboardViewModel.fmtNum(totalTokens30Days))
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(primaryTextColor)
            }

            GeometryReader { geometry in
                let chartHeight = max(geometry.size.height - 1, 1)
                HStack(alignment: .bottom, spacing: 3) {
                    ForEach(points) { point in
                        let ratio = CGFloat(point.tokens) / CGFloat(maxTokens)
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(
                                isHighlighted
                                    ? selectedTextColor.opacity(
                                        point.date == hoveredDate || point.id == points.last?.id ? 1 : 0.42
                                    )
                                    : point.date == hoveredDate || point.id == points.last?.id
                                        ? Color.accentColor
                                        : Color.accentColor.opacity(0.42)
                            )
                            .frame(maxWidth: .infinity)
                            .frame(height: point.tokens == 0 ? 2 : max(3, chartHeight * ratio))
                            .contentShape(Rectangle())
                            .onHover { isActive in
                                hoveredDate = isActive ? point.date : nil
                            }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(isHighlighted ? selectedTextColor.opacity(0.24) : Color.secondary.opacity(0.2))
                        .frame(height: 1)
                }
            }
            .frame(height: 42)

            HStack {
                Text(firstDate)
                Spacer()
                Text(lastDate)
            }
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(tertiaryTextColor)
        }
    }

    private func shortDate(_ date: String) -> String {
        date.count >= 5 ? String(date.suffix(5)) : date
    }
}

struct MenuUsagePopoverView: View {
    private enum UsageMetric: CaseIterable, Identifiable {
        case input
        case output
        case cacheRead
        case cacheCreate
        case cacheHitRate

        var id: Self { self }

        var titleKey: String {
            switch self {
            case .input: return "menu.usage.input"
            case .output: return "menu.usage.output"
            case .cacheRead: return "menu.usage.cacheRead"
            case .cacheCreate: return "menu.usage.cacheCreate"
            case .cacheHitRate: return "menu.usage.cacheHitRate"
            }
        }

        var detailKey: String {
            switch self {
            case .input: return "menu.usage.inputHelp"
            case .output: return "menu.usage.outputHelp"
            case .cacheRead: return "menu.usage.cacheReadHelp"
            case .cacheCreate: return "menu.usage.cacheCreateHelp"
            case .cacheHitRate: return "menu.usage.cacheHitRateHelp"
            }
        }
    }

    let points: [MenuUsagePoint]
    @ObservedObject var interaction: MenuUsageInteraction
    let onDimensionChange: (MenuUsageDimension) -> Void
    let onDayHover: (_ date: String, _ isActive: Bool) -> Void
    let onPanelHover: (_ isActive: Bool) -> Void
    @State private var hoveredMetric: UsageMetric?
    @State private var hoveredDay: String?

    private var totalTokens30Days: Int {
        points.reduce(0) { $0 + $1.tokens }
    }

    private var sortedBuckets: [UsageBucket] {
        interaction.buckets.sorted { totalTokens($0) > totalTokens($1) }
    }

    private var selectedTokens: Int {
        sortedBuckets.reduce(0) { $0 + totalTokens($1) }
    }

    private var selectedRequests: Int {
        sortedBuckets.reduce(0) { $0 + $1.request_count }
    }

    private var selectedInputTokens: Int {
        sortedBuckets.reduce(0) { $0 + $1.input_tokens }
    }

    private var selectedOutputTokens: Int {
        sortedBuckets.reduce(0) { $0 + $1.output_tokens }
    }

    private var selectedCacheReadTokens: Int {
        sortedBuckets.reduce(0) { $0 + $1.cache_read_input_tokens }
    }

    private var selectedCacheCreationTokens: Int {
        sortedBuckets.reduce(0) { $0 + $1.cache_creation_input_tokens }
    }

    private var selectedCacheHitRate: String {
        DashboardViewModel.hitRate(
            input: selectedInputTokens,
            output: selectedOutputTokens,
            cacheRead: selectedCacheReadTokens,
            cacheCreate: selectedCacheCreationTokens
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Image(systemName: "chart.bar.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                Text(loc("dashboard.usage.breakdownTitle"))
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                if let date = interaction.hoveredDate {
                    Text(date)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            HStack(alignment: .firstTextBaseline) {
                Text(loc("menu.usage.last30Total"))
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Text(DashboardViewModel.fmtNum(totalTokens30Days))
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
            }

            GeometryReader { geometry in
                let maxTokens = max(points.map(\.tokens).max() ?? 0, 1)
                HStack(alignment: .bottom, spacing: 3) {
                    ForEach(points) { point in
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(point.date == (hoveredDay ?? interaction.hoveredDate) ? Color.accentColor : Color.accentColor.opacity(0.42))
                            .frame(maxWidth: .infinity)
                            .frame(height: point.tokens == 0 ? 2 : max(3, geometry.size.height * CGFloat(point.tokens) / CGFloat(maxTokens)))
                            .contentShape(Rectangle())
                            .onHover { isActive in
                                self.hoveredDay = isActive ? point.date : nil
                                self.onDayHover(point.date, isActive)
                            }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            }
            .frame(height: 54)

            HStack {
                Text(shortDate(points.first?.date ?? ""))
                Spacer()
                Text(shortDate(points.last?.date ?? ""))
            }
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(.tertiary)

            Divider()

            HStack(alignment: .firstTextBaseline) {
                Text(interaction.hoveredDate?.replacingOccurrences(of: "-", with: "/") ?? "")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                Spacer()
                Text(DashboardViewModel.fmtNum(selectedTokens))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                Text(loc("menu.usage.requests", selectedRequests))
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 5) {
                metricCell(.input, selectedInputTokens)
                metricCell(.output, selectedOutputTokens)
                metricCell(.cacheRead, selectedCacheReadTokens)
                metricCell(.cacheCreate, selectedCacheCreationTokens)
            }

            HStack(spacing: 5) {
                metricCell(.cacheHitRate, selectedCacheHitRate)
                    .frame(maxWidth: .infinity)
                if let hoveredMetric {
                    Text(loc(hoveredMetric.detailKey))
                        .font(.system(size: 8.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Spacer()
                }
            }

            HStack(spacing: 5) {
                ForEach(MenuUsageDimension.allCases) { dimension in
                    Button(loc(dimension.titleKey)) {
                        onDimensionChange(dimension)
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(interaction.dimension == dimension ? Color.white : Color.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
                    .background(
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .fill(interaction.dimension == dimension ? Color.accentColor : Color.secondary.opacity(0.1))
                    )
                }
            }

            if interaction.isLoading {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(loc("common.loading"))
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else if sortedBuckets.isEmpty {
                Text(loc("dashboard.empty"))
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 7) {
                        ForEach(sortedBuckets) { bucket in
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(Color.accentColor.opacity(0.65))
                                    .frame(width: 5, height: 5)
                                Text(bucket.key)
                                    .font(.system(size: 10))
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Spacer(minLength: 4)
                                Text(DashboardViewModel.fmtNum(totalTokens(bucket)))
                                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                Text(loc("menu.usage.requests", bucket.request_count))
                                    .font(.system(size: 9))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
                .frame(maxHeight: 185)
            }
        }
        .padding(14)
        .frame(width: 330, height: 420, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.regularMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(Color.primary.opacity(0.12), lineWidth: 1)
                )
        )
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .onHover(perform: onPanelHover)
    }

    private func shortDate(_ date: String) -> String {
        date.count >= 5 ? String(date.suffix(5)) : date
    }

    private func totalTokens(_ bucket: UsageBucket) -> Int {
        bucket.input_tokens
            + bucket.output_tokens
            + bucket.cache_read_input_tokens
            + bucket.cache_creation_input_tokens
    }

    private func metricCell(_ metric: UsageMetric, _ value: Int) -> some View {
        metricCell(metric, DashboardViewModel.fmtNum(value))
    }

    private func metricCell(_ metric: UsageMetric, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(loc(metric.titleKey))
                .font(.system(size: 8.5))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 5)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Color.secondary.opacity(0.08))
        )
        .contentShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
        .onHover { isActive in
            hoveredMetric = isActive ? metric : nil
        }
    }
}

/// 菜单卡片内的轻量按钮：语义色 tinted 底 + 悬停加深 + 描线图标
struct CardButton: View {
    let title: String
    let systemImage: String
    let tint: Color
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(tint)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(tint.opacity(isHovered ? 0.22 : 0.13))
                )
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
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
