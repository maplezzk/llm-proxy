import SwiftUI
import Charts

/// Dashboard 视图 — 双栏紧凑布局
struct DashboardView: View {
    @StateObject private var viewModel = DashboardViewModel()
    @State private var showCleanupConfirm = false
    @State private var localDateStart: Date = Date()
    @State private var localDateEnd: Date = Date()

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if viewModel.isLoading && viewModel.config == nil {
                    loadingView
                } else {
                    statsGridSection
                    trendChartCard
                    bottomRowSection
                    storageCard
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
                Task { _ = await viewModel.cleanupUsage() }
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
        .frame(maxWidth: .infinity, minHeight: 300)
    }

    // MARK: - Stats Grid（2 行 4 列）
    private var statsGridSection: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                statCard(title: loc("dashboard.serviceStatus"),
                         value: viewModel.health ? loc("dashboard.online") : loc("dashboard.offline"),
                         icon: viewModel.health ? "checkmark.circle.fill" : "xmark.circle.fill",
                         accentColor: viewModel.health ? .green : .red)
                statCard(title: loc("dashboard.providerCount"),
                         value: "\(viewModel.providerCount)",
                         icon: "server.rack", accentColor: .blue)
                statCard(title: loc("dashboard.modelCount"),
                         value: "\(viewModel.modelCount)",
                         icon: "cube", accentColor: .purple)
                statCard(title: loc("dashboard.adapterCount"),
                         value: "\(viewModel.adapterCount)",
                         icon: "arrow.triangle.branch", accentColor: .orange)
            }
            if let today = viewModel.tokenStats?.today {
                HStack(spacing: 12) {
                    statCard(title: loc("dashboard.requests"),
                             value: "\(today.request_count)",
                             subtitle: loc("dashboard.today"),
                             icon: "arrow.up.arrow.down", accentColor: .gray)
                    statCard(title: loc("dashboard.inputTokens"),
                             value: DashboardViewModel.fmtNum(today.input_tokens),
                             subtitle: "\(loc("dashboard.outputTokens")) \(DashboardViewModel.fmtNum(today.output_tokens))",
                             icon: "arrow.down.circle", accentColor: .blue)
                    statCard(title: loc("dashboard.cacheHits"),
                             value: DashboardViewModel.fmtNum(today.cache_read_input_tokens),
                             subtitle: "\(loc("dashboard.hitRate")) \(DashboardViewModel.pct(today.cache_read_input_tokens, today.input_tokens))",
                             icon: "bolt.fill", accentColor: .green)
                    statCard(title: loc("dashboard.cacheCreation"),
                             value: DashboardViewModel.fmtNum(today.cache_creation_input_tokens),
                             subtitle: loc("dashboard.newCacheTokens"),
                             icon: "plus.circle", accentColor: .orange)
                }
            }
        }
    }

    private func statCard(title: String, value: String, subtitle: String? = nil,
                          icon: String, accentColor: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.caption)
                    .foregroundColor(accentColor)
                Text(title)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Text(value)
                .font(.title2)
                .fontWeight(.bold)
                .fontDesign(.rounded)
                .monospacedDigit()
                .foregroundColor(accentColor)
            if let subtitle {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(alignment: .top) {
            RoundedRectangle(cornerRadius: 10)
                .fill(accentColor.opacity(0.6))
                .frame(height: 2)
        }
        .shadow(color: .black.opacity(0.03), radius: 2, y: 1)
    }

    // MARK: - Trend Chart Card（全宽）
    private var trendChartCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "chart.xyaxis.line").foregroundColor(.blue)
                Text(loc("dashboard.usage.trendTitle"))
                    .font(.headline)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 2)

            Text(loc("dashboard.usage.trendDesc"))
                .font(.caption)
                .foregroundColor(.secondary)
                .padding(.horizontal, 16)
                .padding(.bottom, 10)

            Divider()

            // 日期选择器
            HStack(spacing: 10) {
                DatePicker("", selection: $localDateStart, in: ...Date(), displayedComponents: .date)
                    .labelsHidden()
                    .frame(width: 100)
                Text("→").foregroundColor(.secondary)
                DatePicker("", selection: $localDateEnd, in: localDateStart...Date(), displayedComponents: .date)
                    .labelsHidden()
                    .frame(width: 100)
                Spacer()
                HStack(spacing: 4) {
                    presetButton("dashboard.usage.days7", days: 7)
                    presetButton("dashboard.usage.days30", days: 30)
                    presetButton("dashboard.usage.days90", days: 90)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .onChange(of: localDateStart) { _, newStart in
                viewModel.setDateRange(start: newStart, end: localDateEnd)
            }
            .onChange(of: localDateEnd) { _, newEnd in
                viewModel.setDateRange(start: localDateStart, end: newEnd)
            }
            .onAppear {
                localDateStart = viewModel.dateStart
                localDateEnd = viewModel.dateEnd
            }

            Divider()

            if viewModel.timeline.isEmpty {
                Text(loc("dashboard.empty"))
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 200)
                    .padding(16)
            } else {
                timelineChart
                    .frame(height: 240)
                    .padding(16)
            }
        }
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
        .shadow(color: .black.opacity(0.04), radius: 4, y: 2)
    }

    private func presetButton(_ key: String, days: Int) -> some View {
        Button { viewModel.setPresetDays(days) } label: {
            Text(loc(key))
                .font(.caption)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private var timelineChart: some View {
        Chart {
            ForEach(viewModel.timeline) { point in
                LineMark(
                    x: .value("Date", point.shortDate),
                    y: .value("Input", point.input_tokens)
                )
                .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesInput")))
                .interpolationMethod(.monotone)
            }
            ForEach(viewModel.timeline) { point in
                LineMark(
                    x: .value("Date", point.shortDate),
                    y: .value("Output", point.output_tokens)
                )
                .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesOutput")))
                .interpolationMethod(.monotone)
            }
            ForEach(viewModel.timeline) { point in
                LineMark(
                    x: .value("Date", point.shortDate),
                    y: .value("Cache Read", point.cache_read_input_tokens)
                )
                .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesCacheRead")))
                .interpolationMethod(.monotone)
            }
            ForEach(viewModel.timeline) { point in
                LineMark(
                    x: .value("Date", point.shortDate),
                    y: .value("Cache Create", point.cache_creation_input_tokens)
                )
                .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesCacheCreate")))
                .interpolationMethod(.monotone)
            }
        }
        .chartForegroundStyleScale([
            loc("dashboard.usage.seriesInput"): .blue,
            loc("dashboard.usage.seriesOutput"): .purple,
            loc("dashboard.usage.seriesCacheRead"): .green,
            loc("dashboard.usage.seriesCacheCreate"): .orange,
        ])
        .chartLegend(position: .top, alignment: .leading)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 8)) { value in
                AxisGridLine()
                AxisValueLabel { if let d = value.as(String.self) { Text(d).font(.caption2) } }
            }
        }
        .chartYAxis {
            AxisMarks(values: .automatic(desiredCount: 5)) { value in
                AxisGridLine()
                AxisValueLabel { if let n = value.as(Double.self) { Text(DashboardViewModel.fmtNum(Int(n))).font(.caption2) } }
            }
        }
    }

    // MARK: - Bottom Row（柱状 + 环形）
    private var bottomRowSection: some View {
        HStack(alignment: .top, spacing: 14) {
            breakdownCard.frame(maxWidth: .infinity)
            doughnutCard.frame(maxWidth: .infinity)
        }
    }

    // 分维度柱状图
    private var breakdownCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "chart.bar.xaxis").foregroundColor(.purple)
                Text(loc("dashboard.usage.breakdownTitle")).font(.headline)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 8)

            HStack(spacing: 6) {
                dimensionPicker
                rangePicker
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 10)

            Divider()

            if viewModel.breakdown.isEmpty {
                Text(loc("dashboard.empty"))
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 200).padding(.top, 20)
            } else {
                Chart(viewModel.breakdown.prefix(10), id: \.key) { bucket in
                    BarMark(
                        x: .value("Input", bucket.input_tokens),
                        y: .value("Key", bucket.key)
                    )
                    .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesInput")))
                    .position(by: .value("Series", loc("dashboard.usage.seriesInput")))

                    BarMark(
                        x: .value("Output", bucket.output_tokens),
                        y: .value("Key", bucket.key)
                    )
                    .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesOutput")))
                    .position(by: .value("Series", loc("dashboard.usage.seriesOutput")))

                    BarMark(
                        x: .value("Cache Read", bucket.cache_read_input_tokens),
                        y: .value("Key", bucket.key)
                    )
                    .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesCacheRead")))
                    .position(by: .value("Series", loc("dashboard.usage.seriesCacheRead")))
                }
                .chartForegroundStyleScale([
                    loc("dashboard.usage.seriesInput"): .blue,
                    loc("dashboard.usage.seriesOutput"): .purple,
                    loc("dashboard.usage.seriesCacheRead"): .green,
                ])
                .chartLegend(position: .top, alignment: .leading)
                .chartXAxis {
                    AxisMarks(position: .bottom) { value in
                        AxisGridLine()
                        AxisValueLabel { if let n = value.as(Double.self) { Text(DashboardViewModel.fmtNum(Int(n))).font(.caption2) } }
                    }
                }
                .frame(height: 240)
                .padding(14)
            }
        }
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
        .shadow(color: .black.opacity(0.04), radius: 4, y: 2)
    }

    private var dimensionPicker: some View {
        Picker("", selection: $viewModel.breakdownDimension) {
            Text(loc("dashboard.usage.dimProvider")).tag("provider")
            Text(loc("dashboard.usage.dimAdapter")).tag("adapter")
            Text(loc("dashboard.usage.dimModel")).tag("model")
        }
        .pickerStyle(.menu).controlSize(.small).frame(width: 100)
        .onChange(of: viewModel.breakdownDimension) { _, _ in
            Task { await viewModel.setBreakdownDimension(viewModel.breakdownDimension) }
        }
    }

    private var rangePicker: some View {
        Picker("", selection: $viewModel.breakdownRange) {
            Text(loc("dashboard.usage.rangeToday")).tag("today")
            Text(loc("dashboard.usage.range7d")).tag("7d")
            Text(loc("dashboard.usage.range30d")).tag("30d")
            Text(loc("dashboard.usage.rangeAll")).tag("all")
        }
        .pickerStyle(.menu).controlSize(.small).frame(width: 80)
        .onChange(of: viewModel.breakdownRange) { _, _ in
            Task { await viewModel.setBreakdownRange(viewModel.breakdownRange) }
        }
    }

    // 今日结构环形图
    private var doughnutCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "chart.pie.fill").foregroundColor(.pink)
                Text(loc("dashboard.usage.pieTitle")).font(.headline)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 2)

            Text(loc("dashboard.usage.pieDesc"))
                .font(.caption).foregroundColor(.secondary)
                .padding(.horizontal, 14).padding(.bottom, 10)

            Divider()

            if let today = viewModel.tokenStats?.today,
               today.input_tokens + today.output_tokens + today.cache_read_input_tokens + today.cache_creation_input_tokens > 0 {
                let total = today.input_tokens + today.output_tokens + today.cache_read_input_tokens + today.cache_creation_input_tokens
                ZStack {
                    Chart {
                        SectorMark(angle: .value("Input", today.input_tokens), innerRadius: .ratio(0.58), angularInset: 1.5)
                            .foregroundStyle(by: .value("Type", loc("dashboard.usage.seriesInput")))
                        SectorMark(angle: .value("Output", today.output_tokens), innerRadius: .ratio(0.58), angularInset: 1.5)
                            .foregroundStyle(by: .value("Type", loc("dashboard.usage.seriesOutput")))
                        SectorMark(angle: .value("Cache Read", today.cache_read_input_tokens), innerRadius: .ratio(0.58), angularInset: 1.5)
                            .foregroundStyle(by: .value("Type", loc("dashboard.usage.seriesCacheRead")))
                        SectorMark(angle: .value("Cache Create", today.cache_creation_input_tokens), innerRadius: .ratio(0.58), angularInset: 1.5)
                            .foregroundStyle(by: .value("Type", loc("dashboard.usage.seriesCacheCreate")))
                    }
                    .chartForegroundStyleScale([
                        loc("dashboard.usage.seriesInput"): .blue,
                        loc("dashboard.usage.seriesOutput"): .purple,
                        loc("dashboard.usage.seriesCacheRead"): .green,
                        loc("dashboard.usage.seriesCacheCreate"): .orange,
                    ])
                    .chartLegend(position: .trailing, alignment: .center, spacing: 6)

                    VStack(spacing: 2) {
                        Text(loc("dashboard.usage.totalLabel"))
                            .font(.caption2).foregroundColor(.secondary)
                        Text(DashboardViewModel.fmtNum(total))
                            .font(.title3).fontWeight(.bold)
                            .fontDesign(.rounded).monospacedDigit()
                    }
                }
                .frame(height: 240).padding(14)
            } else {
                Text(loc("dashboard.empty"))
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 200).padding(.top, 20)
            }
        }
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
        .shadow(color: .black.opacity(0.04), radius: 4, y: 2)
    }

    // MARK: - Storage Card
    private var storageCard: some View {
        HStack(spacing: 14) {
            Image(systemName: "externaldrive.fill").font(.title3).foregroundColor(.gray)
            VStack(alignment: .leading, spacing: 2) {
                Text(loc("dashboard.usage.storageTitle")).font(.subheadline).fontWeight(.semibold)
                if let info = viewModel.dbInfo {
                    Text(loc("dashboard.usage.storageDesc",
                             info.events, info.aggregates, DashboardViewModel.fmtBytes(info.sizeBytes)))
                        .font(.caption).foregroundColor(.secondary).monospacedDigit()
                }
            }
            Spacer()
            Button {
                showCleanupConfirm = true
            } label: {
                Text(viewModel.isCleaningUp ? loc("common.loading") : loc("dashboard.usage.cleanupBtn"))
                    .font(.caption)
            }
            .buttonStyle(.bordered).disabled(viewModel.isCleaningUp)
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
        .shadow(color: .black.opacity(0.04), radius: 4, y: 2)
    }
}