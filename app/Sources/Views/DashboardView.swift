import SwiftUI
import Charts

/// Dashboard 视图 — 双栏紧凑布局
struct DashboardView: View {
    private enum CleanupAction {
        case olderThan(Int)
        case all
    }

    @StateObject private var viewModel = DashboardViewModel()
    @State private var showCleanupConfirm = false
    @State private var pendingCleanup: CleanupAction?
    @State private var cleanupDays = 90
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
                    heroCard
                    todayUsageCard
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
            cleanupConfirmationTitle,
            isPresented: $showCleanupConfirm,
            titleVisibility: .visible
        ) {
            Button(cleanupConfirmationButtonTitle, role: .destructive) {
                let action = pendingCleanup
                pendingCleanup = nil
                Task {
                    switch action {
                    case .olderThan(let days):
                        _ = await viewModel.cleanupUsage(days: days)
                    case .all:
                        _ = await viewModel.clearAllUsage()
                    case nil:
                        break
                    }
                }
            }
            Button(loc("common.cancel"), role: .cancel) {
                pendingCleanup = nil
            }
        } message: {
            Text(cleanupConfirmationMessage)
        }
    }

    private var cleanupConfirmationTitle: String {
        switch pendingCleanup {
        case .olderThan(let days):
            return loc("dashboard.usage.cleanupConfirm", days)
        case .all:
            return loc("dashboard.usage.cleanupAllConfirm")
        case nil:
            return loc("dashboard.usage.cleanupConfirm", cleanupDays)
        }
    }

    private var cleanupConfirmationMessage: String {
        switch pendingCleanup {
        case .olderThan(let days):
            return loc("dashboard.usage.cleanupMessage", days)
        case .all:
            return loc("dashboard.usage.cleanupAllMessage")
        case nil:
            return ""
        }
    }

    private var cleanupConfirmationButtonTitle: String {
        switch pendingCleanup {
        case .all:
            return loc("dashboard.usage.cleanupAllBtn")
        case .olderThan, nil:
            return loc("dashboard.usage.cleanupBtn")
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

    // MARK: - Hero 状态卡（CodexBar 风格：大号状态指示 + 概览摘要）
    private var heroCard: some View {
        DashboardHeroView(
            online: viewModel.health,
            providerCount: viewModel.providerCount,
            modelCount: viewModel.modelCount,
            adapterCount: viewModel.adapterCount
        )
    }

    // MARK: - 今日用量条（紧凑指标，CodexBar 风格）
    @ViewBuilder
    private var todayUsageCard: some View {
        if let today = viewModel.tokenStats?.today {
            let inp = today.input_tokens
            let out = today.output_tokens
            let cr = today.cache_read_input_tokens
            let cc = today.cache_creation_input_tokens
            TodayUsageStripView(
                total: DashboardViewModel.fmtNum(DashboardViewModel.totalTokens(input: inp, output: out, cacheRead: cr, cacheCreate: cc)),
                input: DashboardViewModel.fmtNum(DashboardViewModel.totalInput(input: inp, cacheRead: cr, cacheCreate: cc)),
                output: DashboardViewModel.fmtNum(out),
                hitRate: DashboardViewModel.hitRate(input: inp, output: out, cacheRead: cr, cacheCreate: cc)
            )
        }
    }

    /// 卡片头：彩色图标 tile + 标题（统一视觉语言，macOS 设置风格）
    private func cardHeader(icon: String, color: Color, title: String) -> some View {
        HStack(spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(color.opacity(0.15))
                    .frame(width: 22, height: 22)
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(color)
            }
            Text(title)
                .font(.headline)
            Spacer()
        }
    }

    // MARK: - Trend Chart Card（全宽）
    private var trendChartCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            cardHeader(icon: "chart.xyaxis.line", color: .blue, title: loc("dashboard.usage.trendTitle"))
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
            // 反向同步：点 7/30/90 预设按钮后 viewModel.dateStart/dateEnd 变，输入框跟着更新
            .onChange(of: viewModel.dateStart) { _, newStart in
                if abs(newStart.timeIntervalSince(localDateStart)) > 1 { localDateStart = newStart }
            }
            .onChange(of: viewModel.dateEnd) { _, newEnd in
                if abs(newEnd.timeIntervalSince(localDateEnd)) > 1 { localDateEnd = newEnd }
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
                BarMark(
                    x: .value("Date", point.dateAsDate, unit: .day),
                    y: .value("Tokens", point.input_tokens)
                )
                .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesInput")))
            }
            ForEach(viewModel.timeline) { point in
                BarMark(
                    x: .value("Date", point.dateAsDate, unit: .day),
                    y: .value("Tokens", point.output_tokens)
                )
                .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesOutput")))
            }
            ForEach(viewModel.timeline) { point in
                BarMark(
                    x: .value("Date", point.dateAsDate, unit: .day),
                    y: .value("Tokens", point.cache_read_input_tokens)
                )
                .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesCacheRead")))
            }
            ForEach(viewModel.timeline) { point in
                BarMark(
                    x: .value("Date", point.dateAsDate, unit: .day),
                    y: .value("Tokens", point.cache_creation_input_tokens)
                )
                .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesCacheCreate")))
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
            GeometryReader { geo in
                if let plotFrame = proxy.plotFrame {
                    // 1) hover 检测 — 找离 x 坐标最近的数据点
                    Rectangle().fill(Color.clear).contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let loc):
                                let xInPlot = loc.x - geo[plotFrame].origin.x
                                guard xInPlot >= 0, xInPlot <= geo[plotFrame].width else { return }
                                let timeline = viewModel.timeline
                                guard !timeline.isEmpty else { return }
                                let closest = timeline.min(by: { a, b in
                                    let pa = proxy.position(forX: a.dateAsDate) ?? 0
                                    let pb = proxy.position(forX: b.dateAsDate) ?? 0
                                    return abs(pa - xInPlot) < abs(pb - xInPlot)
                                })
                                selectedTimelineDate = closest?.dateAsDate
                            case .ended:
                                selectedTimelineDate = nil
                            }
                        }

                    // 2) 选中态只绘制指示线与 tooltip，避免额外 mark 参与 Y scale 重算。
                    if let sel = selectedTimelineDate,
                       let p = nearestTimelinePoint(to: sel),
                       let xPos = proxy.position(forX: p.dateAsDate) {
                        let originX = geo[plotFrame].origin.x
                        let originY = geo[plotFrame].origin.y
                        let height = geo[plotFrame].height
                        let x = originX + xPos

                        // 垂直虚线
                        Path { path in
                            path.move(to: CGPoint(x: x, y: originY))
                            path.addLine(to: CGPoint(x: x, y: originY + height))
                        }
                        .stroke(Color.secondary.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))

                        // tooltip 浮层（贴顶 8px，边缘时左右贴齐）
                        let tooltipWidth: CGFloat = 200
                        let tooltipHeight: CGFloat = 116
                        let leadingX = min(max(x - tooltipWidth / 2, 4), geo.size.width - tooltipWidth - 4)
                        TimelineTooltip(point: p, showsYear: showsYear)
                            .frame(width: tooltipWidth, height: tooltipHeight)
                            .offset(x: leadingX, y: 8)
                            .allowsHitTesting(false)
                    }
                }
            }
        }
    }

    /// 找 timeline 中离 sel 时间最近的数据点（容忍边界值落在 axis 外的情况）
    private func nearestTimelinePoint(to sel: Date) -> TimelinePoint? {
        viewModel.timeline.min(by: { abs($0.dateAsDate.timeIntervalSince(sel)) < abs($1.dateAsDate.timeIntervalSince(sel)) })
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
            cardHeader(icon: "chart.bar.xaxis", color: .purple, title: loc("dashboard.usage.breakdownTitle"))
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 8)

            dimensionButtons
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
                        y: .value("Key", bucket.key),
                        height: .fixed(5)
                    )
                    .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesInput")))
                    .position(by: .value("Series", loc("dashboard.usage.seriesInput")))
                    .cornerRadius(2)

                    BarMark(
                        x: .value("Output", bucket.output_tokens),
                        y: .value("Key", bucket.key),
                        height: .fixed(5)
                    )
                    .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesOutput")))
                    .position(by: .value("Series", loc("dashboard.usage.seriesOutput")))
                    .cornerRadius(2)

                    BarMark(
                        x: .value("Cache Read", bucket.cache_read_input_tokens),
                        y: .value("Key", bucket.key),
                        height: .fixed(5)
                    )
                    .foregroundStyle(by: .value("Series", loc("dashboard.usage.seriesCacheRead")))
                    .position(by: .value("Series", loc("dashboard.usage.seriesCacheRead")))
                    .cornerRadius(2)
                }
                .chartForegroundStyleScale([
                    loc("dashboard.usage.seriesInput"): .blue.opacity(0.95),
                    loc("dashboard.usage.seriesOutput"): .purple.opacity(0.95),
                    loc("dashboard.usage.seriesCacheRead"): .green.opacity(0.95),
                ])
                .chartLegend(position: .top, alignment: .leading)
                .chartXAxis {
                    AxisMarks(position: .bottom) { value in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.8, dash: [3, 3]))
                            .foregroundStyle(Color.secondary.opacity(0.34))
                        AxisTick()
                            .foregroundStyle(Color.secondary.opacity(0.45))
                        AxisValueLabel {
                            if let n = value.as(Double.self) {
                                Text(DashboardViewModel.fmtNum(Int(n)))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { _ in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.8))
                            .foregroundStyle(Color.secondary.opacity(0.26))
                        AxisValueLabel()
                            .foregroundStyle(Color.secondary.opacity(0.92))
                    }
                }
                .chartOverlay { proxy in
                    GeometryReader { geo in
                        if let plotFrame = proxy.plotFrame {
                            // chartXSelection 对横向柱状图（Y 是分类）不触发，改用 onContinuousHover
                            // 不依赖 axis 顺序，直接用 proxy.position(forY:) 找离鼠标 y 最近的 bar
                            Rectangle().fill(Color.clear).contentShape(Rectangle())
                                .onContinuousHover { phase in
                                    switch phase {
                                    case .active(let loc):
                                        let yInPlot = loc.y - geo[plotFrame].origin.y
                                        guard yInPlot >= 0, yInPlot <= geo[plotFrame].height else { return }
                                        let top10 = Array(viewModel.breakdown.prefix(10))
                                        guard !top10.isEmpty else { return }
                                        let closest = top10.min(by: { a, b in
                                            let ya = proxy.position(forY: a.key) ?? 0
                                            let yb = proxy.position(forY: b.key) ?? 0
                                            return abs(ya - yInPlot) < abs(yb - yInPlot)
                                        })
                                        if let closest { selectedBreakdownKey = closest.key }
                                    case .ended:
                                        selectedBreakdownKey = nil
                                    }
                                }
                        }
                    }
                    if let key = selectedBreakdownKey,
                       let bucket = viewModel.breakdown.first(where: { $0.key == key }) {
                        GeometryReader { geo in
                            if let plotFrame = proxy.plotFrame,
                               let yPos = proxy.position(forY: bucket.key) {
                                let originY = geo[plotFrame].origin.y
                                let tooltipWidth: CGFloat = 220
                                let tooltipHeight: CGFloat = 100
                                // 默认靠右贴齐
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

    private var dimensionButtons: some View {
        HStack(spacing: 6) {
            ForEach(MenuUsageDimension.allCases) { dimension in
                let isSelected = viewModel.breakdownDimension == dimension.rawValue
                Button {
                    viewModel.setBreakdownDimension(dimension.rawValue)
                } label: {
                    Text(loc(dimension.titleKey))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(isSelected ? Color.white : Color.primary)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 5)
                        .background(
                            Capsule(style: .continuous)
                                .fill(isSelected ? Color.accentColor : Color.secondary.opacity(0.10))
                        )
                        .overlay(
                            Capsule(style: .continuous)
                                .stroke(
                                    isSelected ? Color.clear : Color.secondary.opacity(0.18),
                                    lineWidth: 1
                                )
                        )
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - Storage Card
    private var storageCard: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Color.gray.opacity(0.15))
                    .frame(width: 30, height: 30)
                Image(systemName: "externaldrive.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.gray)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(loc("dashboard.usage.storageTitle")).font(.subheadline).fontWeight(.semibold)
                if let info = viewModel.dbInfo {
                    Text(loc("dashboard.usage.storageDesc",
                             info.events, info.aggregates, DashboardViewModel.fmtBytes(info.sizeBytes)))
                        .font(.caption).foregroundColor(.secondary).monospacedDigit()
                }
            }
            Spacer()
            HStack(spacing: 7) {
                Text(loc("dashboard.usage.cleanupOlderThan"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("", value: $cleanupDays, format: .number)
                    .textFieldStyle(.roundedBorder)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 54)
                    .accessibilityLabel(loc("dashboard.usage.cleanupDaysUnit"))
                Text(loc("dashboard.usage.cleanupDaysUnit"))
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    let days = max(1, min(365, cleanupDays))
                    cleanupDays = days
                    pendingCleanup = .olderThan(days)
                    showCleanupConfirm = true
                } label: {
                    Text(viewModel.isCleaningUp ? loc("common.loading") : loc("dashboard.usage.cleanupBtn"))
                        .font(.caption)
                }
                .buttonStyle(.bordered)

                Button(role: .destructive) {
                    pendingCleanup = .all
                    showCleanupConfirm = true
                } label: {
                    Text(loc("dashboard.usage.cleanupAllBtn"))
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .tint(.red)
            }
            .disabled(viewModel.isCleaningUp)
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
// MARK: - Hero 状态卡（独立组件，便于快照测试）
struct DashboardHeroView: View {
    let online: Bool
    let providerCount: Int
    let modelCount: Int
    let adapterCount: Int

    var body: some View {
        let tint: Color = online ? Color(red: 0.20, green: 0.68, blue: 0.30) : .red
        HStack(spacing: 14) {
            ZStack {
                Circle().fill(tint.opacity(0.15)).frame(width: 40, height: 40)
                Circle().fill(tint).frame(width: 12, height: 12)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(online ? loc("menu.status.running") : loc("menu.status.stopped"))
                    .font(.title3).fontWeight(.semibold)
                Text(loc("dashboard.overviewSummary", providerCount, modelCount, adapterCount))
                    .font(.caption).foregroundColor(.secondary)
            }
            Spacer()
            Image(systemName: online ? "checkmark.shield.fill" : "exclamationmark.triangle.fill")
                .font(.system(size: 22))
                .foregroundStyle(tint)
        }
        .padding(18)
        .background(RoundedRectangle(cornerRadius: 12).fill(tint.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(tint.opacity(0.18), lineWidth: 1))
    }
}

// MARK: - 今日用量条（独立组件，便于快照测试）
struct TodayUsageStripView: View {
    let total: String
    let input: String
    let output: String
    let hitRate: String

    var body: some View {
        HStack(spacing: 0) {
            metricBlock(title: loc("dashboard.totalTokens"), value: total, accent: .primary)
            metricDivider
            metricBlock(title: loc("dashboard.inputTokens"), value: input, accent: .blue)
            metricDivider
            metricBlock(title: loc("dashboard.outputTokens"), value: output, accent: .purple)
            metricDivider
            metricBlock(title: loc("dashboard.hitRate"), value: hitRate, accent: .green)
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 16)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
        .shadow(color: .black.opacity(0.04), radius: 4, y: 2)
    }

    private var metricDivider: some View {
        Divider().frame(height: 30).padding(.horizontal, 12)
    }

    private func metricBlock(title: String, value: String, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption2)
                .foregroundColor(.secondary)
            Text(value)
                .font(.title3)
                .fontWeight(.bold)
                .fontDesign(.rounded)
                .monospacedDigit()
                .foregroundColor(accent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
