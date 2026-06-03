import AppKit
import SwiftUI

struct DashboardView: View {
    @StateObject private var viewModel: DashboardViewModel
    /// "system" / "light" / "dark" — drives the in-app appearance toggle.
    @AppStorage("radar.appearance") private var appearancePref = "system"

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
                    onSelectWorkspace: { viewModel.select(workspace: $0) },
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
                        Group {
                            if viewModel.selectedWorkspace == .agents {
                                workspaceContent
                                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            } else {
                                ScrollView {
                                    workspaceContent
                                        .frame(maxWidth: .infinity, alignment: .topLeading)
                                        .padding(.bottom, 8)
                                }
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                            }
                        }
                        .id(workspaceGroupKey)
                        .transition(.asymmetric(
                            insertion: .opacity.combined(with: .offset(y: 10)),
                            removal: .opacity
                        ))

                        if shouldShowGlobalInspector {
                            RuntimeRightInspectorView(viewModel: viewModel)
                                .transition(.move(edge: .trailing).combined(with: .opacity))
                        }
                    }
                    .animation(RadarMotion.smooth, value: workspaceGroupKey)
                    .animation(RadarMotion.gentle, value: shouldShowGlobalInspector)
                }
                .padding(.leading, 14)
                .padding(.trailing, 18)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .padding(.leading, 14)
        }
        .preferredColorScheme(resolvedColorScheme)
        .onAppear(perform: applyAppearance)
        .onChange(of: appearancePref) { _, _ in applyAppearance() }
    }

    private var resolvedColorScheme: ColorScheme? {
        switch appearancePref {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    /// Force the AppKit appearance too, so the adaptive `Color(nsColor:)` tokens + materials
    /// resolve to the chosen mode (not just SwiftUI-native views).
    private func applyAppearance() {
        let appearance: NSAppearance?
        switch appearancePref {
        case "light": appearance = NSAppearance(named: .aqua)
        case "dark": appearance = NSAppearance(named: .darkAqua)
        default: appearance = nil
        }
        NSApplication.shared.appearance = appearance
    }

    private var workspaceGroupKey: String {
        switch viewModel.selectedWorkspace {
        case .home: return "home"
        case .agents: return "agents"
        case .inbox, .token, .watchlist: return "library"
        case .ops: return "ops"
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
        VStack(alignment: .leading, spacing: 16) {
            TodayHeroHeader(viewModel: viewModel)

            HomeStatRow(viewModel: viewModel)

            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    Text("今日重点")
                        .font(RadarFont.display(19, .bold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Spacer()
                    Text("按风险 · 可信度 · 时效排序")
                        .font(.system(size: 11))
                        .foregroundStyle(RadarTheme.mutedText)
                    Text("\(topCrystals.count) / \(viewModel.filteredCrystals.count)")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(RadarTheme.tintSoft)
                        .clipShape(Capsule())
                }

                if topCrystals.isEmpty {
                    HStack(spacing: 10) {
                        IconChip(systemName: "tray", tint: RadarTheme.mutedText, size: 32)
                        Text(viewModel.hasSearch ? "没有匹配的情报" : "暂无今日重点情报")
                            .font(.system(size: 13))
                            .foregroundStyle(RadarTheme.secondaryText)
                        Spacer()
                    }
                    .padding(.vertical, 18)
                } else {
                    VStack(spacing: 9) {
                        ForEach(Array(topCrystals.enumerated()), id: \.element.id) { _, crystal in
                            TodayCrystalRow(
                                crystal: crystal,
                                selected: viewModel.selectedCrystalID == crystal.id,
                                inspect: { viewModel.selectCrystal(crystal.id) },
                                handoffToAgent: {
                                    viewModel.selectCrystal(crystal.id)
                                    viewModel.agentPrompt = "请基于这条情报继续分析并给出下一步建议：\(crystal.title)"
                                }
                            )
                            .transition(.opacity.combined(with: .offset(y: 8)))
                        }
                    }
                    .animation(RadarMotion.spring, value: topCrystals.map(\.id))
                }
            }
            .padding(18)
            .researchPanel()

            FloatingAgentComposer(viewModel: viewModel)
        }
        .frame(maxWidth: 1000, alignment: .topLeading)
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

private struct TodayHeroHeader: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 9) {
                    HStack(spacing: 6) {
                        Image(systemName: "calendar")
                            .font(.system(size: 10, weight: .semibold))
                        Text(viewModel.headerDateText)
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                    }
                    .foregroundStyle(RadarTheme.blue)

                    Text("今日情报")
                        .font(RadarFont.display(32, .bold))
                        .foregroundStyle(RadarTheme.primaryText)

                    Text(viewModel.snapshot.briefing.title)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(1)
                    Text(viewModel.snapshot.briefing.body)
                        .font(.system(size: 13))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(2)
                        .lineSpacing(3)
                        .frame(maxWidth: 620, alignment: .leading)
                }
                Spacer()
                HStack(spacing: 7) {
                    StatusDot(
                        color: RuntimeStatusPresenter.color(for: viewModel.syncState.status.rawValue),
                        pulsing: viewModel.syncState.status == .running
                    )
                    Text(RuntimeStatusPresenter.label(viewModel.syncState.status.rawValue))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(RadarTheme.secondaryText)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(RadarTheme.tintSoft)
                .overlay(Capsule().strokeBorder(RadarTheme.borderSoft, lineWidth: 1))
                .clipShape(Capsule())
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
        .padding(24)
        .background(RadarTheme.heroGradient)
        .researchPanel(glow: true)
    }
}

private struct HomeStatRow: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        let proposed = viewModel.terminalData.proactive.proposals.filter { $0.status == .proposed }.count
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4), spacing: 12) {
            HomeStatCard(icon: "sparkles.rectangle.stack", tint: RadarTheme.blue, value: viewModel.terminalData.proactive.crystals.count, label: "情报卡", spark: [3, 4, 3.6, 5, 6.2, 7], tap: { viewModel.select(workspace: .home) })
            HomeStatCard(icon: "checklist", tint: RadarTheme.indigo, value: proposed, label: "待办建议", spark: [2, 2.6, 3, 2.8, 3.4, 4], tap: { viewModel.select(workspace: .agents) })
            HomeStatCard(icon: "star.circle", tint: RadarTheme.cyan, value: viewModel.terminalData.watchlistItems.count, label: "观察中", spark: [5, 4.6, 5, 5.5, 5.2, 6], tap: { viewModel.select(workspace: .watchlist) })
            HomeStatCard(icon: "bolt.horizontal", tint: RadarTheme.green, value: viewModel.agentTasks.count, label: "进行任务", spark: [1, 2, 2.4, 3, 2.8, 3.6], tap: { viewModel.select(workspace: .agents) })
        }
    }
}

private struct HomeStatCard: View {
    let icon: String
    let tint: Color
    let value: Int
    let label: String
    let spark: [Double]
    let tap: () -> Void

    var body: some View {
        Button(action: tap) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    IconChip(systemName: icon, tint: tint, size: 30)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(RadarTheme.mutedText)
                }
                Text("\(value)")
                    .font(RadarFont.display(30, .bold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .contentTransition(.numericText())
                HStack {
                    Text(label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(RadarTheme.secondaryText)
                    Spacer()
                    ResearchSparkline(values: spark, color: tint)
                        .frame(width: 56)
                }
            }
            .padding(15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .interactiveCard(cornerRadius: 16, hoverScale: 1.01)
        }
        .buttonStyle(.plain)
    }
}

private struct TodayCrystalRow: View {
    let crystal: IntelligenceCrystal
    let selected: Bool
    let inspect: () -> Void
    let handoffToAgent: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .center, spacing: 13) {
            Button(action: inspect) {
                HStack(alignment: .center, spacing: 13) {
                    ProgressRing(
                        value: crystal.confidence,
                        size: 48,
                        lineWidth: 5,
                        colors: [riskColor, riskColor.opacity(0.55)],
                        label: "\(Int((crystal.confidence * 100).rounded()))"
                    )
                    VStack(alignment: .leading, spacing: 6) {
                        Text(crystal.title)
                            .font(.system(size: 14.5, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                            .lineLimit(1)
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
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button(action: handoffToAgent) {
                Label("交给 Agent", systemImage: "arrow.turn.up.right")
            }
            .buttonStyle(ResearchSecondaryButtonStyle())
            .controlSize(.small)
            .opacity(hovering || selected ? 1 : 0.0)
            .frame(width: hovering || selected ? nil : 0)
            .animation(RadarMotion.snappy, value: hovering || selected)
        }
        .padding(13)
        .quietRow(selected: selected, cornerRadius: 15)
        .onHover { hovering = $0 }
    }

    private var riskColor: Color {
        switch crystal.risk {
        case .critical, .high: return RadarTheme.red
        case .medium: return RadarTheme.gold
        case .low, .none, .unknown: return RadarTheme.green
        }
    }
}

private struct MinimalTag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(color == RadarTheme.mutedText ? RadarTheme.secondaryText : color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color == RadarTheme.mutedText ? RadarTheme.tintSoft : color.opacity(0.14))
            .clipShape(Capsule())
    }
}

struct FloatingAgentComposer: View {
    @ObservedObject var viewModel: DashboardViewModel
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 8) {
                IconChip(systemName: "sparkles", size: 26, gradient: RadarTheme.brandGradient)
                Text("Agent")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                StatusDot(color: statusColor(viewModel.agentSubmitStatus))
                Text(userStatus(viewModel.agentSubmitStatus))
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.mutedText)
                    .lineLimit(1)
                Spacer()
            }

            HStack(alignment: .bottom, spacing: 10) {
                TextEditor(text: $viewModel.agentPrompt)
                    .font(.system(size: 14))
                    .scrollContentBackground(.hidden)
                    .foregroundStyle(RadarTheme.primaryText)
                    .focused($focused)
                    .frame(minHeight: 54, maxHeight: 92)
                    .padding(11)
                    .background(RadarTheme.tintSoft)
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(focused ? RadarTheme.blue.opacity(0.5) : RadarTheme.borderSoft, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(alignment: .topLeading) {
                        if viewModel.agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text("问 Agent，或让它继续处理一条情报…")
                                .font(.system(size: 14))
                                .foregroundStyle(RadarTheme.mutedText)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 19)
                                .allowsHitTesting(false)
                        }
                    }
                    .animation(RadarMotion.snappy, value: focused)

                Button {
                    viewModel.submitAgentPrompt()
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .frame(width: 38, height: 38)
                }
                .buttonStyle(ResearchPrimaryButtonStyle())
                .disabled(viewModel.agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(15)
        .researchPanel()
    }

    private func userStatus(_ raw: String) -> String {
        if raw.contains("daemon_unavailable") { return "后台服务未连接" }
        if raw.contains("submitting") { return "正在交给 Agent" }
        if raw.contains("run_completed") { return "任务记录已生成" }
        if raw.contains("draft_ready") { return "草稿已填入" }
        if raw.contains("prompt_empty") { return "请输入任务" }
        return "就绪"
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
