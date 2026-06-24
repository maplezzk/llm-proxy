import SwiftUI
import Charts

struct DashboardView: View {
    @State private var viewModel = DashboardViewModel()
    @State private var showCleanupConfirm: Bool = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                if viewModel.isLoading && viewModel.config == nil {
                    loadingView
                } else {
                    serviceStatusCard
                    statsCards

                    // 图表区：仅在 tokenStats 加载成功后展示
                    if viewModel.tokenStats != nil {
                        tokenUsageSection
                        trendChartCard
                        breakdownCardsRow
                        storageCard
                    }
                }
            }
            .padding(20)
        }
        .onAppear { viewModel.startPolling() }
        .onDisappear { viewModel.stopPolling() }
        .confirmationDialog(
            loc("dashboard.usage.cleanupConfirm"),
            isPresented: $showCleanupConfirm,
            titleVisibility: .visible
        ) {
            Button(loc("dashboard.usage.cleanupBtn"), role: .destructive) {
                Task {
                    _ = await viewModel.cleanupUsage()
                }
            }
            Button(loc("common.cancel"), role: .cancel) {}
        } message: {
            Text(loc("dashboard.usage.cleanupMessage"))
        }
    }

    // MARK: - Loading

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView().scaleEffect(0.8)
            Text(loc("dashboard.loading"))
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 60)
    }

    // MARK: - Service Status Card

    private var serviceStatusCard: some View {
        HStack(spacing: 14) {
            Image(systemName: viewModel.health ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.title3)
                .foregroundColor(viewModel.health ? .green : .red)
                .symbolEffect(.pulse, isActive: viewModel.health)
            VStack(alignment: .leading, spacing: 2) {
                Text(loc("dashboard.serviceStatus"))
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                Text(viewModel.health ? loc("dashboard.online") : loc("dashboard.offline"))
                    .font(.title2)
                    .fontWeight(.bold)
                    .foregroundColor(viewModel.health ? .green : .red)
            }
            Spacer()
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(viewModel.health ? Color.green.opacity(0.06) : Color.red.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(viewModel.health ? Color.green.opacity(0.25) : Color.red.opacity(0.25), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.04), radius: 4, x: 0, y: 2)
    }

    // MARK: - Stats Cards

    private var statsCards: some View {
        HStack(spacing: 14) {
            statCard(
                title: loc("dashboard.providerCount"),
                value: "\(viewModel.providerCount)",
                icon: "server.rack",
                accentColor: .blue
            )
            statCard(
                title: loc("dashboard.modelCount"),
                value: "\(viewModel.modelCount)",
                icon: "cube",
                accentColor: .green
            )
            statCard(
                title: loc("dashboard.adapterCount"),
                value: "\(viewModel.adapterCount)",
                icon: "arrow.triangle.branch",
                accentColor: .orange
            )
        }
    }

    private func statCard(title: String, value: String, icon: String, accentColor: Color) -> some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundColor(accentColor)
            Text(value)
                .font(.largeTitle)
                .fontWeight(.bold)
                .fontDesign(.rounded)
                .monospacedDigit()
            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 22)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .overlay(alignment: .top) {
            Rectangle()
                .fill(accentColor)
                .frame(height: 3)
                .clipShape(UnevenRoundedRectangle(topLeadingRadius: 12, topTrailingRadius: 12))
        }
        .shadow(color: .black.opacity(0.04), radius: 4, x: 0, y: 2)
    }

    // MARK: - Token Usage Section（今日 4 卡片）

    private var tokenUsageSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Image(systemName: "chart.bar.fill").foregroundColor(.blue)
                Text(loc("dashboard.tokenUsage"))
                    .font(.headline)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            Divider()

            if let today = viewModel.tokenStats?.today {
                let input = today.input_tokens
                let output = today.output_tokens
                let cacheRead = today.cache_read_input_tokens
                let cacheCreate = today.cache_creation_input_tokens
                let total = input + output
                let hitRate = DashboardViewModel.pct(cacheRead, input)

                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 1) {
                    tokenCard(
                        title: loc("dashboard.requests"),
                        value: "\(today.request_count)",
                        desc: loc("dashboard.today"),
                        color: .primary
                    )
                    tokenCard(
                        title: loc("dashboard.inputTokens"),
                        value: DashboardViewModel.fmtNum(input),
                        desc: "\(loc("dashboard.outputTokens")) \(DashboardViewModel.fmtNum(output))",
                        color: .blue
                    )
                    tokenCard(
                        title: loc("dashboard.cacheHits"),
                        value: DashboardViewModel.fmtNum(cacheRead),
                        desc: "\(loc("dashboard.hitRate")) \(hitRate)",
                        color: .green
                    )
                    tokenCard(
                        title: loc("dashboard.cacheCreation"),
                        value: DashboardViewModel.fmtNum(cacheCreate),
                        desc: "\(loc("dashboard.totalTokens")) \(DashboardViewModel.fmtNum(total))",
                        color: .orange
                    )
                }
            } else {
                Text(loc("dashboard.empty"))
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 30)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .shadow(color: .black.opacity(0.04), radius: 4, x: 0, y: 2)
    }

    private func tokenCard(title: String, value: String, desc: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundColor(.secondary)
            Text(value)
                .font(.title2)
                .fontWeight(.bold)
                .fontDesign(.rounded)
                .monospacedDigit()
                .foregroundColor(color)
            if !desc.isEmpty {
                Text(desc).font(.caption2).foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
    }

    // MARK: - Trend Chart Card

    private var trendChartCard: some View {
        ChartCard(
            title: loc("dashboard.usage.trendTitle"),
            subtitle: loc("dashboard.usage.trendDesc"),
            icon: "chart.xyaxis.line",
            iconColor: .blue
        ) {
            HStack(spacing: 6) {
                ForEach([7, 30, 90], id: \.self) { days in
                    Button(action: {
                        Task { await viewModel.setTimelineDays(days) }
                    }) {
                        Text(loc(days == 7 ? "dashboard.usage.days7" : days == 30 ? "dashboard.usage.days30" : "dashboard.usage.days90"))
                            .font(.caption)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(
                                Capsule().fill(viewModel.timelineDays == days ? Color.accentColor : Color.gray.opacity(0.15))
                            )
                            .foregroundColor(viewModel.timelineDays == days ? .white : .primary)
                    }
                    .buttonStyle(.plain)
                }
            }
        } content: {
            if viewModel.timeline.isEmpty {
                Text(loc("dashboard.empty"))
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 200)
            } else {
                Chart {
                    ForEach(viewModel.timeline) { point in
                        LineMark(
                            x: .value("Date", point.shortDate),
                            y: .value("Input", point.input_tokens)
                        )
                        .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesInput")))
                        .interpolationMethod(.catmullRom)
                    }
                    ForEach(viewModel.timeline) { point in
                        LineMark(
                            x: .value("Date", point.shortDate),
                            y: .value("Output", point.output_tokens)
                        )
                        .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesOutput")))
                        .interpolationMethod(.catmullRom)
                    }
                    ForEach(viewModel.timeline) { point in
                        LineMark(
                            x: .value("Date", point.shortDate),
                            y: .value("Cache Read", point.cache_read_input_tokens)
                        )
                        .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesCacheRead")))
                        .interpolationMethod(.catmullRom)
                    }
                    ForEach(viewModel.timeline) { point in
                        LineMark(
                            x: .value("Date", point.shortDate),
                            y: .value("Cache Create", point.cache_creation_input_tokens)
                        )
                        .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesCacheCreate")))
                        .interpolationMethod(.catmullRom)
                    }
                }
                .chartForegroundStyleScale([
                    loc("dashboard.usage.seriesInput"): .blue,
                    loc("dashboard.usage.seriesOutput"): .purple,
                    loc("dashboard.usage.seriesCacheRead"): .green,
                    loc("dashboard.usage.seriesCacheCreate"): .orange,
                ])
                .chartLegend(position: .top, alignment: .leading)
                .frame(height: 220)
                .padding(.top, 4)
            }
        }
    }

    // MARK: - Breakdown Cards Row（柱状 + 饼图）

    private var breakdownCardsRow: some View {
        HStack(alignment: .top, spacing: 14) {
            // 左：分维度对比柱状图
            ChartCard(
                title: loc("dashboard.usage.breakdownTitle"),
                subtitle: nil,
                icon: "chart.bar.xaxis",
                iconColor: .purple
            ) {
                HStack(spacing: 6) {
                    dimensionMenu
                    rangeMenu
                }
            } content: {
                if viewModel.breakdown.isEmpty {
                    Text(loc("dashboard.empty"))
                        .foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 200)
                } else {
                    Chart {
                        ForEach(viewModel.breakdown.prefix(10).map { $0 }) { bucket in
                            BarMark(
                                x: .value("Input", bucket.input_tokens),
                                y: .value("Key", bucket.key)
                            )
                            .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesInput")))
                        }
                        ForEach(viewModel.breakdown.prefix(10).map { $0 }) { bucket in
                            BarMark(
                                x: .value("Output", bucket.output_tokens),
                                y: .value("Key", bucket.key)
                            )
                            .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesOutput")))
                        }
                    }
                    .chartForegroundStyleScale([
                        loc("dashboard.usage.seriesInput"): .blue,
                        loc("dashboard.usage.seriesOutput"): .purple,
                    ])
                    .chartLegend(position: .top, alignment: .leading)
                    .chartXAxis {
                        AxisMarks(position: .bottom) { value in
                            AxisGridLine()
                            AxisTick()
                            AxisValueLabel {
                                if let n = value.as(Double.self) {
                                    Text(DashboardViewModel.fmtNum(Int(n)))
                                        .font(.caption2)
                                }
                            }
                        }
                    }
                    .frame(height: 220)
                }
            }
            .frame(maxWidth: .infinity)

            // 右：今日结构占比饼图
            ChartCard(
                title: loc("dashboard.usage.pieTitle"),
                subtitle: loc("dashboard.usage.pieDesc"),
                icon: "chart.pie.fill",
                iconColor: .pink
            ) {} content: {
                if let today = viewModel.tokenStats?.today, today.input_tokens + today.output_tokens > 0 {
                    let total = today.input_tokens + today.output_tokens + today.cache_read_input_tokens + today.cache_creation_input_tokens
                    Chart {
                        SectorMark(
                            angle: .value("Input", today.input_tokens),
                            innerRadius: .ratio(0.55),
                            angularInset: 1
                        )
                        .foregroundStyle(by: .value("Type", loc("dashboard.usage.seriesInput")))
                        SectorMark(
                            angle: .value("Output", today.output_tokens),
                            innerRadius: .ratio(0.55),
                            angularInset: 1
                        )
                        .foregroundStyle(by: .value("Type", loc("dashboard.usage.seriesOutput")))
                        SectorMark(
                            angle: .value("Cache Read", today.cache_read_input_tokens),
                            innerRadius: .ratio(0.55),
                            angularInset: 1
                        )
                        .foregroundStyle(by: .value("Type", loc("dashboard.usage.seriesCacheRead")))
                        SectorMark(
                            angle: .value("Cache Create", today.cache_creation_input_tokens),
                            innerRadius: .ratio(0.55),
                            angularInset: 1
                        )
                        .foregroundStyle(by: .value("Type", loc("dashboard.usage.seriesCacheCreate")))
                    }
                    .chartForegroundStyleScale([
                        loc("dashboard.usage.seriesInput"): .blue,
                        loc("dashboard.usage.seriesOutput"): .purple,
                        loc("dashboard.usage.seriesCacheRead"): .green,
                        loc("dashboard.usage.seriesCacheCreate"): .orange,
                    ])
                    .chartLegend(position: .trailing, alignment: .center, spacing: 8)
                    .frame(height: 220)
                    .chartBackground { _ in
                        VStack(spacing: 2) {
                            Text(loc("dashboard.usage.totalLabel"))
                                .font(.caption2)
                                .foregroundColor(.secondary)
                            Text(DashboardViewModel.fmtNum(total))
                                .font(.title3)
                                .fontWeight(.bold)
                                .fontDesign(.rounded)
                                .monospacedDigit()
                        }
                    }
                } else {
                    Text(loc("dashboard.empty"))
                        .foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 200)
                }
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var dimensionMenu: some View {
        Menu {
            ForEach(["provider", "adapter", "model"], id: \.self) { dim in
                Button(loc("dashboard.usage.dim\(dim.capitalized)")) {
                    Task { await viewModel.setBreakdownDimension(dim) }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(loc("dashboard.usage.dim\(viewModel.breakdownDimension.capitalized)"))
                    .font(.caption)
                Image(systemName: "chevron.down").font(.caption2)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(Color.accentColor))
            .foregroundColor(.white)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private var rangeMenu: some View {
        Menu {
            ForEach(["today", "7d", "30d", "all"], id: \.self) { range in
                // "today" -> "Today", "7d" -> "7d"（数字开头的 word capitalize 不会改数字）
                let key = range.first?.isLetter == true ? range.capitalized : range
                Button(loc("dashboard.usage.range\(key)")) {
                    Task { await viewModel.setBreakdownRange(range) }
                }
            }
        } label: {
            // 同上：viewModel.breakdownRange 也是 raw 值，需要 capitalize
            let key = viewModel.breakdownRange.first?.isLetter == true ? viewModel.breakdownRange.capitalized : viewModel.breakdownRange
            HStack(spacing: 4) {
                Text(loc("dashboard.usage.range\(key)"))
                    .font(.caption)
                Image(systemName: "chevron.down").font(.caption2)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(Color.gray.opacity(0.15)))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    // MARK: - Storage Card

    private var storageCard: some View {
        HStack(spacing: 14) {
            Image(systemName: "externaldrive.fill")
                .font(.title3)
                .foregroundColor(.gray)
            VStack(alignment: .leading, spacing: 2) {
                Text(loc("dashboard.usage.storageTitle"))
                    .font(.subheadline)
                    .fontWeight(.semibold)
                if let info = viewModel.dbInfo {
                    Text(loc(
                        "dashboard.usage.storageDesc",
                        info.events, info.aggregates, DashboardViewModel.fmtBytes(info.sizeBytes)
                    ))
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .monospacedDigit()
                } else {
                    Text(loc("dashboard.loading"))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            Spacer()
            Button {
                showCleanupConfirm = true
            } label: {
                Text(viewModel.isCleaningUp ? loc("common.loading") : loc("dashboard.usage.cleanupBtn"))
                    .font(.caption)
            }
            .buttonStyle(.bordered)
            .disabled(viewModel.isCleaningUp)
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .shadow(color: .black.opacity(0.04), radius: 4, x: 0, y: 2)
    }
}

// MARK: - ChartCard（图表卡片通用布局）

struct ChartCard<Content: View, Toolbar: View>: View {
    let title: String
    let subtitle: String?
    let icon: String
    let iconColor: Color
    @ViewBuilder let toolbar: () -> Toolbar
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: icon).foregroundColor(iconColor)
                Text(title).font(.headline)
                Spacer()
                toolbar()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            if let subtitle = subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 6)
            }
            Divider()
            content()
                .padding(16)
        }
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .shadow(color: .black.opacity(0.04), radius: 4, x: 0, y: 2)
    }
}