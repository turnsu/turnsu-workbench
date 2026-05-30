import SwiftUI

struct DashboardView: View {
    @StateObject private var viewModel: DashboardViewModel

    init(initialWorkspace: TerminalWorkspace = .home) {
        _viewModel = StateObject(wrappedValue: DashboardViewModel(initialWorkspace: initialWorkspace))
    }

    var body: some View {
        ZStack {
            ResearchOSBackground()

            HStack(spacing: 0) {
                TerminalWorkspaceSidebar(
                    groups: viewModel.snapshot.groups,
                    selectedWorkspace: viewModel.selectedWorkspace,
                    selectedGroupID: viewModel.selectedGroupID,
                    tokenCount: viewModel.terminalData.tokenEntities.count,
                    alertCount: viewModel.terminalData.alerts.count,
                    onSelectWorkspace: viewModel.select(workspace:),
                    onSelectGroup: { group in
                        viewModel.select(group: group)
                        viewModel.select(workspace: .inbox)
                    },
                    onSelectAll: {
                        viewModel.select(group: nil)
                        viewModel.select(workspace: .home)
                    }
                )

                VStack(alignment: .leading, spacing: 12) {
                    TerminalTopCommandBar(viewModel: viewModel)

                    HStack(alignment: .top, spacing: 12) {
                        if viewModel.selectedWorkspace == .agents {
                            workspaceContent
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        } else {
                            ScrollView {
                                workspaceContent
                                    .frame(maxWidth: .infinity, alignment: .topLeading)
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }

                        if shouldShowGlobalInspector {
                            RuntimeRightInspectorView(viewModel: viewModel)
                        }
                    }
                }
                .padding(.leading, 14)
                .padding(.trailing, 18)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .padding(.leading, 14)
        }
    }

    private var shouldShowGlobalInspector: Bool {
        viewModel.selectedWorkspace != .agents && (
            viewModel.selectedCrystalID != nil ||
                viewModel.selectedProposalID != nil ||
                viewModel.selectedMessageID != nil ||
                viewModel.selectedTokenID != nil ||
                viewModel.selectedEvidenceID != nil ||
                viewModel.selectedAlertID != nil ||
                viewModel.selectedArtifactPath != nil ||
                viewModel.selectedHandoffID != nil
        )
    }

    @ViewBuilder
    private var workspaceContent: some View {
        switch viewModel.selectedWorkspace {
        case .home:
            HomeWorkspaceView(viewModel: viewModel)
        case .inbox, .token, .watchlist:
            LibraryWorkspaceView(viewModel: viewModel)
        case .agents:
            AgentWorkspaceView(viewModel: viewModel)
        case .ops:
            OpsWorkspaceView(viewModel: viewModel)
        }
    }
}

private struct HomeWorkspaceView: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            TodayBriefHeader(viewModel: viewModel)

            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("今日重点")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Spacer()
                    Text("\(topCrystals.count) / \(viewModel.filteredCrystals.count)")
                        .font(.system(size: 12))
                        .foregroundStyle(RadarTheme.mutedText)
                }

                ForEach(topCrystals) { crystal in
                    TodayCrystalRow(
                        crystal: crystal,
                        selected: viewModel.selectedCrystalID == crystal.id,
                        inspect: { viewModel.selectCrystal(crystal.id) },
                        handoffToAgent: {
                            viewModel.selectCrystal(crystal.id)
                            viewModel.agentPrompt = "请基于这条情报继续分析并给出下一步建议：\(crystal.title)"
                        }
                    )
                }
            }
            .padding(16)
            .researchPanel()

            FloatingAgentComposer(viewModel: viewModel)
        }
        .frame(maxWidth: 980, alignment: .topLeading)
    }

    private var topCrystals: [IntelligenceCrystal] {
        Array(viewModel.filteredCrystals.sorted { lhs, rhs in
            let lhsScore = riskScore(lhs.risk) * 2 + lhs.confidence + freshnessScore(lhs.freshness)
            let rhsScore = riskScore(rhs.risk) * 2 + rhs.confidence + freshnessScore(rhs.freshness)
            return lhsScore > rhsScore
        }.prefix(5))
    }

    private func riskScore(_ risk: ProactiveRiskLevel) -> Double {
        switch risk {
        case .critical: return 4
        case .high: return 3
        case .medium: return 2
        case .low: return 1
        case .none, .unknown: return 0
        }
    }

    private func freshnessScore(_ freshness: ProactiveFreshness) -> Double {
        switch freshness {
        case .fresh, .currentRun: return 1
        case .fixture: return 0.6
        case .degraded, .stale: return 0.2
        default: return 0
        }
    }
}

private struct TodayBriefHeader: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("今日情报")
                        .font(.system(size: 28, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Text(viewModel.snapshot.briefing.title)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(1)
                    Text(viewModel.snapshot.briefing.body)
                        .font(.system(size: 13))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(3)
                        .lineSpacing(3)
                }
                Spacer()
                HStack(spacing: 8) {
                    StatusDot(color: RuntimeStatusPresenter.color(for: viewModel.syncState.status.rawValue))
                    Text(RuntimeStatusPresenter.label(viewModel.syncState.status.rawValue))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(RadarTheme.secondaryText)
                }
            }

            HStack(spacing: 10) {
                Button {
                    viewModel.agentPrompt = "请梳理今日微信与链上情报重点，按优先级给出行动建议。"
                } label: {
                    Label("让 Agent 梳理今日重点", systemImage: "sparkles")
                }
                .buttonStyle(ResearchPrimaryButtonStyle())

                Button {
                    viewModel.select(workspace: .inbox)
                } label: {
                    Label("打开资料库", systemImage: "folder")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
            }
        }
        .padding(20)
        .researchPanel()
    }
}

private struct TodayCrystalRow: View {
    let crystal: IntelligenceCrystal
    let selected: Bool
    let inspect: () -> Void
    let handoffToAgent: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button(action: inspect) {
                HStack(alignment: .top, spacing: 12) {
                    StatusDot(color: riskColor, size: 8)
                        .padding(.top, 5)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(crystal.title)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                            .lineLimit(2)
                        Text(crystal.rationale)
                            .font(.system(size: 12))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .lineLimit(2)
                        HStack(spacing: 6) {
                            MinimalTag(text: RuntimeStatusPresenter.label(crystal.risk.rawValue), color: riskColor)
                            MinimalTag(text: "\(crystal.evidenceRefs.count) 证据", color: RadarTheme.mutedText)
                            MinimalTag(text: RuntimeStatusPresenter.label(crystal.freshness.rawValue), color: RadarTheme.mutedText)
                        }
                    }
                    Spacer()
                }
            }
            .buttonStyle(.plain)

            Button(action: handoffToAgent) {
                Text("交给 Agent")
            }
            .buttonStyle(ResearchSecondaryButtonStyle())
        }
        .padding(13)
        .background(selected ? Color.white.opacity(0.075) : Color.white.opacity(0.035))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var riskColor: Color {
        switch crystal.risk {
        case .critical, .high:
            return RadarTheme.red
        case .medium:
            return RadarTheme.gold
        case .low, .none, .unknown:
            return RadarTheme.green
        }
    }
}

private struct MinimalTag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.white.opacity(0.045))
            .clipShape(Capsule())
    }
}

struct FloatingAgentComposer: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                StatusDot(color: statusColor(viewModel.agentSubmitStatus))
                Text(userStatus(viewModel.agentSubmitStatus))
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.mutedText)
                    .lineLimit(1)
            }

            HStack(alignment: .bottom, spacing: 10) {
                TextEditor(text: $viewModel.agentPrompt)
                    .font(.system(size: 14))
                    .scrollContentBackground(.hidden)
                    .foregroundStyle(RadarTheme.primaryText)
                    .frame(minHeight: 54, maxHeight: 88)
                    .padding(10)
                    .background(Color.white.opacity(0.055))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(alignment: .topLeading) {
                        if viewModel.agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text("问 Agent，或让它继续处理一条情报…")
                                .font(.system(size: 14))
                                .foregroundStyle(RadarTheme.mutedText)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 18)
                                .allowsHitTesting(false)
                        }
                    }

                Button {
                    viewModel.submitAgentPrompt()
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .bold))
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(ResearchPrimaryButtonStyle())
                .disabled(viewModel.agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(14)
        .researchPanel()
    }

    private func userStatus(_ raw: String) -> String {
        if raw.contains("daemon_unavailable") { return "后台服务未连接" }
        if raw.contains("submitting") { return "正在交给 Agent" }
        if raw.contains("run_completed") { return "任务记录已生成" }
        if raw.contains("draft_ready") { return "草稿已填入" }
        if raw.contains("prompt_empty") { return "请输入任务" }
        return "Agent 就绪"
    }

    private func statusColor(_ raw: String) -> Color {
        let value = raw.lowercased()
        if value.contains("unavailable") || value.contains("fail") || value.contains("error") {
            return RadarTheme.red
        }
        if value.contains("submitting") || value.contains("draft") {
            return RadarTheme.gold
        }
        return RadarTheme.green
    }
}

private struct ResearchHeroDesk: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                ResearchSectionEyebrow(text: "Operating Desk · Live", icon: "dot.radiowaves.left.and.right")
                Spacer()
                ResearchStatusChip(label: RuntimeStatusPresenter.label(viewModel.syncState.status.rawValue), icon: "waveform.path.ecg", color: RadarTheme.green)
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("微信 x 链上 Agent 情报工作台")
                    .font(.system(size: 34, weight: .heavy, design: .rounded))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(2)
                Text("从群聊信号到 Token 证据链，再到 Agent 建议、Owner 审批与本地交接包。每一步都有 artifact、policy 和 freshness 可追踪。")
                    .font(.system(size: 13))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 680, alignment: .leading)
            }

            HStack(spacing: 8) {
                ResearchStatusChip(label: "\(viewModel.terminalData.proactive.crystals.count) 条情报卡", icon: "sparkles.rectangle.stack", color: RadarTheme.green)
                ResearchStatusChip(label: "\(viewModel.terminalData.proactive.proposals.count) 个建议", icon: "checklist", color: RadarTheme.violet)
                ResearchStatusChip(label: "Source Trust + Guard", icon: "shield.lefthalf.filled", color: RadarTheme.blue)
                ResearchStatusChip(label: RuntimeStatusPresenter.label(viewModel.snapshot.sourceMode), icon: "externaldrive", color: RadarTheme.gold)
            }

            HStack(spacing: 10) {
                Button {
                    viewModel.select(workspace: .agents)
                    if let template = AgentWorkspaceTaskTemplates.all.first {
                        viewModel.applyAgentTemplate(template)
                    }
                } label: {
                    Label("发起 Agent 研究", systemImage: "sparkle.magnifyingglass")
                }
                .buttonStyle(ResearchPrimaryButtonStyle())

                Button {
                    viewModel.select(workspace: .watchlist)
                } label: {
                    Label("加入观察", systemImage: "plus")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
            }

            Spacer(minLength: 0)
        }
        .padding(28)
        .background(RadarTheme.heroGradient)
        .researchPanel(glow: true)
    }
}

private struct ResearchWatchlistPanel: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                ResearchSectionEyebrow(text: "Watchlist · Intraday", icon: "chart.xyaxis.line")
                Spacer()
                Text("fixture / CMC")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundStyle(RadarTheme.mutedText)
            }

            LazyVGrid(columns: [GridItem(.flexible(), spacing: 18), GridItem(.flexible(), spacing: 18)], spacing: 24) {
                ForEach(Array(marketAssets.prefix(4).enumerated()), id: \.offset) { index, asset in
                    WatchTile(asset: asset, seed: index)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(22)
        .researchPanel()
    }

    private var marketAssets: [MarketAsset] {
        let assets = viewModel.terminalData.marketSnapshots.flatMap(\.assets)
        if !assets.isEmpty { return assets }
        if !viewModel.snapshot.web3.market.assets.isEmpty { return viewModel.snapshot.web3.market.assets }
        return [
            MarketAsset(symbol: "BTC", name: "Bitcoin", priceUSD: 0, percentChange24h: 0, volume24hUSD: 0, marketCapUSD: 0, source: "not_run", isLive: false),
            MarketAsset(symbol: "ETH", name: "Ethereum", priceUSD: 0, percentChange24h: 0, volume24hUSD: 0, marketCapUSD: 0, source: "not_run", isLive: false),
            MarketAsset(symbol: "SOL", name: "Solana", priceUSD: 0, percentChange24h: 0, volume24hUSD: 0, marketCapUSD: 0, source: "not_run", isLive: false)
        ]
    }
}

private struct WatchTile: View {
    let asset: MarketAsset
    let seed: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(asset.symbol)
                        .font(.system(size: 12, weight: .bold, design: .monospaced))
                        .foregroundStyle(RadarTheme.primaryText)
                    Text(asset.name)
                        .font(.system(size: 10))
                        .foregroundStyle(RadarTheme.mutedText)
                        .lineLimit(1)
                }
                Spacer()
            }
            ResearchSparkline(values: sparkValues, color: changeColor)
            Text(priceText)
                .font(.system(size: 20, weight: .bold, design: .monospaced))
                .foregroundStyle(RadarTheme.primaryText)
            Text(changeText)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(changeColor)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var priceText: String {
        asset.priceUSD <= 0 ? "--" : String(format: "%.2f", asset.priceUSD)
    }

    private var changeText: String {
        let prefix = asset.percentChange24h >= 0 ? "▲" : "▼"
        return "\(prefix) \(String(format: "%.2f", abs(asset.percentChange24h)))%"
    }

    private var changeColor: Color {
        asset.percentChange24h >= 0 ? RadarTheme.positive : RadarTheme.negative
    }

    private var sparkValues: [Double] {
        let base = 40.0 + Double(seed * 6)
        let direction = asset.percentChange24h >= 0 ? 1.0 : -1.0
        return (0..<12).map { rawIndex -> Double in
            let index = Double(rawIndex)
            let drift = index * direction * 0.85
            let wave = Foundation.sin(Double(rawIndex + seed)) * 2.8
            return base + drift + wave
        }
    }
}

private struct ResearchMetricDeck: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        LazyVGrid(columns: [
            GridItem(.flexible(), spacing: 14),
            GridItem(.flexible(), spacing: 14),
            GridItem(.flexible(), spacing: 14),
            GridItem(.flexible(), spacing: 14)
        ], spacing: 14) {
            ResearchMetricCard(title: "活跃主题", value: "\(viewModel.terminalData.proactive.crystals.count)", detail: "已归档 Crystal", color: RadarTheme.green, spark: [2, 3, 3.4, 4, 5, 6])
            ResearchMetricCard(title: "Active Thesis", value: "\(viewModel.terminalData.watchlistItems.count)", detail: "进入持续跟踪", color: RadarTheme.blue, spark: [6, 5, 4, 4.5, 5, 5.6])
            ResearchMetricCard(title: "待审批 Memo", value: "\(viewModel.terminalData.proactive.proposals.filter { $0.status == .proposed }.count)", detail: "进入 Proposal", color: RadarTheme.gold, spark: [2, 2.5, 3, 3.2, 3.3, 3.5])
            ResearchMetricCard(title: "进行中研究", value: "\(viewModel.agentTasks.count)", detail: "Agent session", color: RadarTheme.violet, spark: [3, 2.8, 2.6, 2.9, 3.2, 4])
        }
    }
}

private struct ResearchMetricCard: View {
    let title: String
    let value: String
    let detail: String
    let color: Color
    let spark: [Double]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ResearchSectionEyebrow(text: title, icon: "bolt")
            HStack(alignment: .lastTextBaseline) {
                Text(value)
                    .font(.system(size: 30, weight: .heavy, design: .rounded))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
                ResearchStatusChip(label: detail, color: color)
            }
            ResearchSparkline(values: spark, color: color)
        }
        .padding(18)
        .researchPanel()
    }
}

private struct ResearchTopRadarPanel: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    ResearchSectionEyebrow(text: "卡点雷达 · Top 3", icon: "scope")
                    Text("按可信度、风险和证据密度排序，优先处理高分情报。")
                        .font(.system(size: 11))
                        .foregroundStyle(RadarTheme.secondaryText)
                }
                Spacer()
                Button("进入情报流") {
                    viewModel.select(workspace: .home)
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
            }

            LazyVGrid(columns: [
                GridItem(.flexible(), spacing: 14),
                GridItem(.flexible(), spacing: 14),
                GridItem(.flexible(), spacing: 14)
            ], spacing: 14) {
                ForEach(Array(topCrystals.enumerated()), id: \.element.id) { index, crystal in
                    TopCrystalCard(index: index + 1, crystal: crystal) {
                        viewModel.selectCrystal(crystal.id)
                    }
                }
            }
        }
        .padding(22)
        .background(
            LinearGradient(
                colors: [RadarTheme.panelWash, RadarTheme.panel.opacity(0.82), RadarTheme.cyanBase.opacity(0.42)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .researchPanel(glow: true)
    }

    private var topCrystals: [IntelligenceCrystal] {
        let crystals = viewModel.filteredCrystals.sorted { $0.confidence > $1.confidence }
        return Array(crystals.prefix(3))
    }
}

private struct TopCrystalCard: View {
    let index: Int
    let crystal: IntelligenceCrystal
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 13) {
                HStack(alignment: .top) {
                    Text("#\(String(format: "%02d", index))")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(RadarTheme.mutedText)
                    Spacer()
                    Text("\(Int((crystal.confidence * 100).rounded()))")
                        .font(.system(size: 31, weight: .heavy, design: .rounded))
                        .foregroundStyle(RadarTheme.primaryText)
                }
                ResearchScoreBar(value: crystal.confidence, color: scoreColor)
                Text(crystal.title)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(2)
                Text(crystal.rationale)
                    .font(.system(size: 10))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    ResearchStatusChip(label: RuntimeStatusPresenter.label(crystal.risk.rawValue), color: scoreColor)
                    ResearchStatusChip(label: "\(crystal.evidenceRefs.count) evidence", color: RadarTheme.violet)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, minHeight: 170, alignment: .topLeading)
            .background(RadarTheme.panelElevated.opacity(0.62))
            .researchPanel()
        }
        .buttonStyle(.plain)
    }

    private var scoreColor: Color {
        switch crystal.risk {
        case .high, .critical:
            return RadarTheme.red
        case .medium:
            return RadarTheme.gold
        default:
            return RadarTheme.green
        }
    }
}
