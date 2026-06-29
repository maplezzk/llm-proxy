import SwiftUI
import Charts

/// Dashboard 视图 — 双栏紧凑布局
struct DashboardView: View {
    @StateObject private var viewModel = DashboardViewModel()
    @State private var showCleanupConfirm = false
    @State private var localDateStart: Date = Date()
    @State private var localDateEnd: Date = Date()
    @State private var selectedTimelineDate: Date? = nil
    @State private var selectedBreakdownKey: String? = nil

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if viewModel.isLoading && viewModel.config == nil {
                    loadingView
                } else {
                    statsGridSection
                    trendChartCard
                    breakdownCard
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
        .frame(maxWidth: .infinity, minHeight: 78, alignment: .leading)
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
                    x: .value("Date", point.dateAsDate),
                    y: .value("Input", point.input_tokens)
                )
                .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesInput")))
                .interpolationMethod(.monotone)
            }
            ForEach(viewModel.timeline) { point in
                LineMark(
                    x: .value("Date", point.dateAsDate),
                    y: .value("Output", point.output_tokens)
                )
                .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesOutput")))
                .interpolationMethod(.monotone)
            }
            ForEach(viewModel.timeline) { point in
                LineMark(
                    x: .value("Date", point.dateAsDate),
                    y: .value("Cache Read", point.cache_read_input_tokens)
                )
                .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesCacheRead")))
                .interpolationMethod(.monotone)
            }
            ForEach(viewModel.timeline) { point in
                LineMark(
                    x: .value("Date", point.dateAsDate),
                    y: .value("Cache Create", point.cache_creation_input_tokens)
                )
                .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesCacheCreate")))
                .interpolationMethod(.monotone)
            }
            // 选中日期画垂直虚线 + 高亮点
            if let sel = selectedTimelineDate,
               let p = viewModel.timeline.first(where: { Calendar.current.isDate($0.dateAsDate, inSameDayAs: sel) }) {
                RuleMark(x: .value("Selected", p.dateAsDate))
                    .foregroundStyle(.secondary.opacity(0.5))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .annotation(position: .top, alignment: .center, spacing: 0) {
                        EmptyView()
                    }
                PointMark(
                    x: .value("Date", p.dateAsDate),
                    y: .value("Input", p.input_tokens)
                )
                .symbolSize(80)
                .foregroundStyle(.blue)
                PointMark(
                    x: .value("Date", p.dateAsDate),
                    y: .value("Output", p.output_tokens)
                )
                .symbolSize(80)
                .foregroundStyle(.purple)
                PointMark(
                    x: .value("Date", p.dateAsDate),
                    y: .value("Cache Read", p.cache_read_input_tokens)
                )
                .symbolSize(60)
                .foregroundStyle(.green)
                PointMark(
                    x: .value("Date", p.dateAsDate),
                    y: .value("Cache Create", p.cache_creation_input_tokens)
                )
                .symbolSize(60)
                .foregroundStyle(.orange)
            }
        }
        .chartForegroundStyleScale([
            loc("dashboard.usage.seriesInput"): .blue,
            loc("dashboard.usage.seriesOutput"): .purple,
            loc("dashboard.usage.seriesCacheRead"): .green,
            loc("dashboard.usage.seriesCacheCreate"): .orange,
        ])
        .chartLegend(position: .top, alignment: .leading)
        .chartXSelection(value: $selectedTimelineDate)
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, count: timelineAxisStride)) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let d = value.as(Date.self) {
                        Text(axisLabel(for: d))
                            .font(.caption2)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(values: .automatic(desiredCount: 5)) { value in
                AxisGridLine()
                AxisValueLabel { if let n = value.as(Double.self) { Text(DashboardViewModel.fmtNum(Int(n))).font(.caption2) } }
            }
        }
        .chartOverlay { proxy in
            if let sel = selectedTimelineDate,
               let p = viewModel.timeline.first(where: { Calendar.current.isDate($0.dateAsDate, inSameDayAs: sel) }) {
                GeometryReader { geo in
                    if let plotFrame = proxy.plotFrame {
                        let xPos = proxy.position(forX: p.dateAsDate) ?? 0
                        let originX = geo[plotFrame].origin.x
                        let tooltipWidth: CGFloat = 200
                        let tooltipHeight: CGFloat = 116
                        // 趋近边缘时左/右贴齐
                        let leadingX = min(max(originX + xPos - tooltipWidth / 2, 4), geo.size.width - tooltipWidth - 4)
                        let topY: CGFloat = 8
                        TimelineTooltip(point: p, showsYear: showsYear)
                            .frame(width: tooltipWidth, height: tooltipHeight)
                            .offset(x: leadingX, y: topY)
                            .allowsHitTesting(false)
                    }
                }
            }
        }
    }

    /// 趋势图 X 轴步长 — 数据多时按天取间隔，避免标签重叠
    private var timelineAxisStride: Int {
        let days = max(1, Calendar.current.dateComponents([.day], from: viewModel.dateStart, to: viewModel.dateEnd).day ?? 1)
        let stride = (days + 5) / 6
        return max(1, min(stride, days))
    }

    /// 日期范围是否跨年（决定 X 轴是否显示年份）
    private var showsYear: Bool {
        let y1 = Calendar.current.component(.year, from: viewModel.dateStart)
        let y2 = Calendar.current.component(.year, from: viewModel.dateEnd)
        return y1 != y2
    }

    private func axisLabel(for date: Date) -> String {
        let cal = Calendar.current
        let m = cal.component(.month, from: date)
        let day = cal.component(.day, from: date)
        let mmdd = String(format: "%02d-%02d", m, day)
        if showsYear {
            let y = cal.component(.year, from: date) % 100
            return String(format: "%02d-%@", y, mmdd)
        }
        return mmdd
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
                .chartXSelection(value: $selectedBreakdownKey)
                .chartXAxis {
                    AxisMarks(position: .bottom) { value in
                        AxisGridLine()
                        AxisValueLabel { if let n = value.as(Double.self) { Text(DashboardViewModel.fmtNum(Int(n))).font(.caption2) } }
                    }
                }
                .chartOverlay { proxy in
                    if let key = selectedBreakdownKey,
                       let bucket = viewModel.breakdown.first(where: { $0.key == key }) {
                        GeometryReader { geo in
                            if let plotFrame = proxy.plotFrame,
                               let yPos = proxy.position(forY: bucket.key) {
                                let originY = geo[plotFrame].origin.y
                                let tooltipWidth: CGFloat = 220
                                let tooltipHeight: CGFloat = 100
                                // 默认靠右贴齐，接近右边缘时反向
                                let baseX = geo[plotFrame].maxX - tooltipWidth - 8
                                let leadingX = max(baseX, 8)
                                let topY = min(max(originY + yPos - tooltipHeight / 2, 4), geo.size.height - tooltipHeight - 4)
                                BreakdownTooltip(bucket: bucket)
                                    .frame(width: tooltipWidth, height: tooltipHeight)
                                    .offset(x: leadingX, y: topY)
                                    .allowsHitTesting(false)
                            }
                        }
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

// MARK: - 趋势图 hover tooltip
struct TimelineTooltip: View {
    let point: TimelinePoint
    let showsYear: Bool

    private var totalTokens: Int {
        point.input_tokens + point.output_tokens + point.cache_read_input_tokens + point.cache_creation_input_tokens
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(point.axisLabel(showYear: showsYear))
                .font(.caption).fontWeight(.semibold)
                .foregroundColor(.secondary)
            HStack(spacing: 6) {
                Circle().fill(Color.blue).frame(width: 6, height: 6)
                Text("\(DashboardViewModel.fmtNum(point.input_tokens))")
                    .font(.caption2).monospacedDigit()
            }
            HStack(spacing: 6) {
                Circle().fill(Color.purple).frame(width: 6, height: 6)
                Text("\(DashboardViewModel.fmtNum(point.output_tokens))")
                    .font(.caption2).monospacedDigit()
            }
            if point.cache_read_input_tokens > 0 {
                HStack(spacing: 6) {
                    Circle().fill(Color.green).frame(width: 6, height: 6)
                    Text("\(DashboardViewModel.fmtNum(point.cache_read_input_tokens))")
                        .font(.caption2).monospacedDigit()
                }
            }
            Divider().padding(.vertical, 1)
            HStack {
                Text("Total").font(.caption2).foregroundColor(.secondary)
                Spacer()
                Text(DashboardViewModel.fmtNum(totalTokens)).font(.caption2).fontWeight(.semibold).monospacedDigit()
            }
            HStack {
                Text("Requests").font(.caption2).foregroundColor(.secondary)
                Spacer()
                Text("\(point.request_count)").font(.caption2).fontWeight(.semibold).monospacedDigit()
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(nsColor: .windowBackgroundColor))
                .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
        )
    }
}

// MARK: - 柱状图 hover tooltip
struct BreakdownTooltip: View {
    let bucket: UsageBucket

    private var totalTokens: Int {
        bucket.input_tokens + bucket.output_tokens + bucket.cache_read_input_tokens + bucket.cache_creation_input_tokens
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(bucket.key)
                .font(.caption).fontWeight(.semibold)
                .foregroundColor(.primary)
                .lineLimit(2)
            HStack(spacing: 6) {
                Circle().fill(Color.blue).frame(width: 6, height: 6)
                Text("\(DashboardViewModel.fmtNum(bucket.input_tokens))")
                    .font(.caption2).monospacedDigit()
            }
            HStack(spacing: 6) {
                Circle().fill(Color.purple).frame(width: 6, height: 6)
                Text("\(DashboardViewModel.fmtNum(bucket.output_tokens))")
                    .font(.caption2).monospacedDigit()
            }
            if bucket.cache_read_input_tokens > 0 {
                HStack(spacing: 6) {
                    Circle().fill(Color.green).frame(width: 6, height: 6)
                    Text("\(DashboardViewModel.fmtNum(bucket.cache_read_input_tokens))")
                        .font(.caption2).monospacedDigit()
                }
            }
            Divider().padding(.vertical, 1)
            HStack {
                Text("Total").font(.caption2).foregroundColor(.secondary)
                Spacer()
                Text(DashboardViewModel.fmtNum(totalTokens)).font(.caption2).fontWeight(.semibold).monospacedDigit()
            }
            HStack {
                Text("Requests").font(.caption2).foregroundColor(.secondary)
                Spacer()
                Text("\(bucket.request_count)").font(.caption2).fontWeight(.semibold).monospacedDigit()
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(nsColor: .windowBackgroundColor))
                .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
        )
    }
}