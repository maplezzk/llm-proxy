import SwiftUI

struct DashboardView: View {
    @State private var viewModel = DashboardViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                if viewModel.isLoading && viewModel.config == nil {
                    loadingView
                } else {
                    serviceStatusCard
                    statsCards
                    if viewModel.tokenStats != nil {
                        tokenUsageSection
                    }
                }
            }
            .padding(24)
        }
        .onAppear {
            viewModel.startPolling()
        }
        .onDisappear {
            viewModel.stopPolling()
        }
    }

    // MARK: - Loading

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
                .scaleEffect(0.8)
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

    // MARK: - Token Usage Section

    private var tokenUsageSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Image(systemName: "chart.bar.fill")
                    .foregroundColor(.blue)
                Text(loc("dashboard.tokenUsage"))
                    .font(.headline)
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

                LazyVGrid(columns: [
                    GridItem(.flexible()),
                    GridItem(.flexible())
                ], spacing: 1) {
                    tokenCard(
                        title: loc("dashboard.requests"),
                        value: "\(today.request_count)",
                        desc: "",
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
            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
            Text(value)
                .font(.title2)
                .fontWeight(.bold)
                .fontDesign(.rounded)
                .monospacedDigit()
                .foregroundColor(color)
            if !desc.isEmpty {
                Text(desc)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
    }
}
