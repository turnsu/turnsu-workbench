import SwiftUI

struct LibraryWorkspaceView: View {
    @ObservedObject var viewModel: DashboardViewModel
    @ObservedObject var loopOpsStore: LoopOpsLocalStore
    let metrics: WorkbenchLayoutMetrics
    @State private var loopOpsSurface: LoopOpsSurface = .library

    var body: some View {
        switch viewModel.selectedWorkspace {
        case .token:
            TokenTerminalWorkspaceView(viewModel: viewModel, metrics: metrics)
        case .watchlist:
            WatchlistWorkspaceView(viewModel: viewModel, metrics: metrics)
        case .skills:
            LoopOpsSkillOSView(viewModel: viewModel, store: loopOpsStore, metrics: metrics)
        default:
            VStack(alignment: .leading, spacing: 14) {
                Picker("LoopOps surface", selection: $loopOpsSurface) {
                    Text("Library").tag(LoopOpsSurface.library)
                    Text("Studio").tag(LoopOpsSurface.studio)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .frame(maxWidth: metrics.isCompact ? .infinity : 260)

                switch loopOpsSurface {
                case .studio:
                    LoopOpsStudioView(viewModel: viewModel, store: loopOpsStore, metrics: metrics)
                default:
                    LoopOpsLibraryView(viewModel: viewModel, store: loopOpsStore, metrics: metrics)
                }
            }
        }
    }
}

private enum HistoryWorkspaceMode: String, CaseIterable, Identifiable {
    case results
    case wechat
    case token
    case watchlist

    var id: String { rawValue }

    var title: String {
        switch self {
        case .results: return "结果"
        case .wechat: return "微信线索"
        case .token: return "Token"
        case .watchlist: return "观察"
        }
    }
}

private struct HistoryWorkspaceContent: View {
    @ObservedObject var viewModel: DashboardViewModel
    let metrics: WorkbenchLayoutMetrics

    var body: some View {
        if metrics.isCompact {
            VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                resultsPanel
                draftsPanel
            }
        } else {
            HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                resultsPanel
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                draftsPanel
                    .frame(width: metrics.supportColumnWidth)
            }
        }
    }

    private var resultsPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "checklist.checked", title: "结果记录", trailing: "\(viewModel.agentTasks.count)")
            if viewModel.agentTasks.isEmpty {
                EmptyStateText(text: "暂无任务记录")
            } else {
                ForEach(viewModel.agentTasks.sorted { $0.updatedAt > $1.updatedAt }.prefix(12)) { task in
                    Button {
                        viewModel.selectAgentSession(task.sessionID)
                        viewModel.select(workspace: .agents)
                    } label: {
                        HStack(alignment: .top, spacing: 11) {
                            IconChip(systemName: historyIcon(task.status), tint: historyColor(task.status), size: 32)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(task.prompt)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(RadarTheme.primaryText)
                                    .lineLimit(2)
                                Text(historyDetail(for: task))
                                    .font(.system(size: 11))
                                    .foregroundStyle(RadarTheme.secondaryText)
                                    .lineLimit(2)
                            }
                            Spacer(minLength: 0)
                            ResearchStatusChip(label: RuntimeStatusPresenter.label(task.status), color: historyColor(task.status))
                        }
                        .padding(12)
                        .quietRow(cornerRadius: 13)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .radarPanel()
    }

    private var draftsPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "doc.text", title: "草稿与交付", trailing: "\(draftCount)")
            if viewModel.filteredProposals.isEmpty && viewModel.filteredHandoffs.isEmpty {
                EmptyStateText(text: "暂无草稿或交付记录")
            } else {
                ForEach(viewModel.filteredProposals.prefix(6)) { proposal in
                    HistoryDraftRow(title: proposal.title, detail: proposal.summary, icon: "doc.badge.clock", tint: RadarTheme.blue)
                }
                ForEach(viewModel.filteredHandoffs.prefix(4)) { handoff in
                    HistoryDraftRow(title: handoff.title, detail: handoff.summaryText, icon: "arrow.triangle.branch", tint: RadarTheme.indigo)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .radarPanel()
    }

    private var draftCount: Int {
        viewModel.filteredProposals.count + viewModel.filteredHandoffs.count
    }

    private func historyDetail(for task: AgentLongTask) -> String {
        if let final = viewModel.agentFinalReadModelByRunID[task.runID],
           !final.finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return AgentOutputCopy.humanize(final.finalText)
        }
        return "Run \(task.runID) · \(task.updatedAt)"
    }

    private func historyColor(_ status: String) -> Color {
        let value = status.lowercased()
        if value.contains("blocked") || value.contains("failed") || value.contains("error") { return RadarTheme.red }
        if value.contains("review") { return RadarTheme.gold }
        if value.contains("completed") || value.contains("done") { return RadarTheme.green }
        if value.contains("running") || value.contains("queued") || value.contains("started") { return RadarTheme.blue }
        return RadarTheme.mutedText
    }

    private func historyIcon(_ status: String) -> String {
        let value = status.lowercased()
        if value.contains("blocked") || value.contains("failed") || value.contains("error") { return "exclamationmark.triangle" }
        if value.contains("review") { return "checkmark.seal" }
        if value.contains("completed") || value.contains("done") { return "checkmark.circle" }
        if value.contains("running") || value.contains("queued") || value.contains("started") { return "bolt.horizontal" }
        return "circle"
    }
}

private struct HistoryDraftRow: View {
    let title: String
    let detail: String
    let icon: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            IconChip(systemName: icon, tint: tint, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(1)
                Text(detail)
                    .font(.system(size: 11.5))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(11)
        .quietRow(cornerRadius: 12)
    }
}

struct WeChatInboxWorkspaceView: View {
    @ObservedObject var viewModel: DashboardViewModel
    let metrics: WorkbenchLayoutMetrics

    var body: some View {
        if metrics.isCompact {
            VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                messagesPanel
                TokenListPane(viewModel: viewModel)
            }
        } else {
            HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                messagesPanel
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                TokenListPane(viewModel: viewModel)
                    .frame(width: metrics.tokenColumnWidth)
            }
        }
    }

    private var messagesPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            let messages = viewModel.filteredMessages
            PanelHeader(icon: "tray.full", title: "微信线索", trailing: "\(messages.count) 条")
            if messages.isEmpty {
                EmptyStateText(text: viewModel.hasSearch ? "无匹配消息" : "暂无消息")
            }
            ForEach(messages) { message in
                MessageCard(
                    message: message,
                    selected: viewModel.selectedMessageID == message.id,
                    onTapSymbol: { viewModel.openToken($0) },
                    onTap: { viewModel.selectMessage(message.id) }
                )
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .radarPanel()
    }
}

private struct MessageCard: View {
    let message: NormalizedWeChatMessage
    let selected: Bool
    let onTapSymbol: (String) -> Void
    let onTap: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            IconChip(systemName: "bubble.left.fill", tint: RadarTheme.green, size: 32)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(message.groupName)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(1)
                    Spacer()
                    Text(AgentDateFormatting.displayString(message.sentAt))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(RadarTheme.mutedText)
                }
                Text(message.text)
                    .font(.system(size: 12))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
                if !message.extractedSymbols.isEmpty || !message.extractedContracts.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(message.extractedSymbols, id: \.self) { symbol in
                            Button(symbol) {
                                if let id = message.linkedTokenIDs.first {
                                    onTapSymbol(id)
                                }
                            }
                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                            .buttonStyle(.plain)
                            .foregroundStyle(RadarTheme.blue)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(RadarTheme.blue.opacity(0.13))
                            .clipShape(Capsule())
                        }
                        ForEach(message.extractedContracts.prefix(1), id: \.self) { contract in
                            Text(contract)
                                .font(.system(size: 9, design: .monospaced))
                                .lineLimit(1)
                                .foregroundStyle(RadarTheme.gold)
                        }
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .quietRow(selected: selected, cornerRadius: 14)
        .contentShape(Rectangle())
        .onTapGesture { onTap() }
    }
}

struct TokenTerminalWorkspaceView: View {
    @ObservedObject var viewModel: DashboardViewModel
    let metrics: WorkbenchLayoutMetrics

    var body: some View {
        if metrics.isCompact {
            VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                TokenListPane(viewModel: viewModel)
                tokenDetail
            }
        } else {
            HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                TokenListPane(viewModel: viewModel)
                    .frame(width: metrics.tokenColumnWidth)
                tokenDetail
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }

    private var tokenDetail: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let token = viewModel.selectedToken {
                TokenIdentityPanel(token: token, market: viewModel.selectedTokenMarket, onchain: viewModel.selectedTokenOnchain)
                    .id(token.tokenID)
                    .transition(.opacity.combined(with: .offset(y: 8)))
                RelatedMessagesPanel(messages: viewModel.selectedTokenMessages)
            } else {
                EmptyStateText(text: "未选择 Token")
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .animation(RadarMotion.smooth, value: viewModel.selectedToken?.tokenID)
    }
}

struct WatchlistWorkspaceView: View {
    @ObservedObject var viewModel: DashboardViewModel
    let metrics: WorkbenchLayoutMetrics

    var body: some View {
        if metrics.isCompact {
            VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                watchlistPanel
                alertPanel
            }
        } else {
            HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                watchlistPanel
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                alertPanel
                    .frame(width: metrics.supportColumnWidth)
            }
        }
    }

    private var watchlistPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            let items = viewModel.filteredWatchlistItems
            PanelHeader(icon: "star.circle", title: "观察与预警", trailing: "\(items.count)")
            if items.isEmpty {
                EmptyStateText(text: viewModel.hasSearch ? "无匹配观察项" : "暂无观察项")
            }
            ForEach(items) { item in
                HStack(spacing: 11) {
                    IconChip(systemName: "star.fill", tint: RadarTheme.cyan, size: 32)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(item.symbol) · \(item.chain)")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                        Text(item.reason)
                            .font(.system(size: 11))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .lineLimit(2)
                    }
                    Spacer()
                    ResearchStatusChip(label: RuntimeStatusPresenter.label(item.freshness), color: RuntimeStatusPresenter.color(for: item.freshness))
                }
                .padding(11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .quietRow(selected: viewModel.selectedTokenID == item.tokenID, cornerRadius: 13)
                .contentShape(Rectangle())
                .onTapGesture { viewModel.openToken(item.tokenID) }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .radarPanel()
    }

    private var alertPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "bell.badge", title: "风险规则 / 下一步动作", trailing: "\(viewModel.terminalData.alerts.count) open")
            ForEach(viewModel.terminalData.alerts) { alert in
                let alertColor = alert.severity == "medium" ? RadarTheme.gold : (alert.severity == "high" || alert.severity == "critical" ? RadarTheme.red : RadarTheme.green)
                HStack(alignment: .top, spacing: 11) {
                    IconChip(systemName: "bell.badge.fill", tint: alertColor, size: 32)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(alert.title)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                            Spacer()
                            ResearchStatusChip(label: "\(RuntimeStatusPresenter.label(alert.severity)) · \(RuntimeStatusPresenter.label(alert.status))", color: alertColor)
                        }
                        Text(alert.reason)
                            .font(.system(size: 11))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .lineLimit(2)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .quietRow(selected: viewModel.selectedAlertID == alert.id, cornerRadius: 14)
                .contentShape(Rectangle())
                .onTapGesture { viewModel.selectedAlertID = alert.id }
            }
            ForEach(viewModel.terminalData.alertRules) { rule in
                OpsRow(label: RuntimeStatusPresenter.intentLabel(rule.ruleType), value: rule.thresholdDescription, status: RuntimeStatusPresenter.label(rule.status))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .radarPanel()
    }
}

struct AgentWorkspaceView: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        AgentWorkspaceV2View(viewModel: viewModel)
    }
}

struct OpsWorkspaceView: View {
    @ObservedObject var viewModel: DashboardViewModel
    let metrics: WorkbenchLayoutMetrics
    @AppStorage("radar.appearance") private var appearancePref = "system"

    private var daemon: AgentDaemonStatus { viewModel.agentDaemonStatus }
    private var daemonConnected: Bool { daemon.daemon != nil }
    private var liveWechatStatus: String { RuntimeStatusPresenter.label(daemon.policy?["liveWechat"] ?? "blocked") }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            LazyVGrid(columns: settingsColumns, spacing: metrics.workspaceSpacing) {
                appearanceCard
                daemonCard
                providersCard
                liveWechatCard
            }
            safetyCard
            runtimeCard
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private var settingsColumns: [GridItem] {
        if metrics.isCompact {
            return [GridItem(.flexible(), spacing: metrics.workspaceSpacing)]
        }
        return [
            GridItem(.flexible(), spacing: metrics.workspaceSpacing),
            GridItem(.flexible(), spacing: metrics.workspaceSpacing),
        ]
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("设置")
                .font(RadarFont.display(24, .bold))
                .foregroundStyle(RadarTheme.primaryText)
            Text("外观、后台服务、模型密钥、实时微信与安全边界——当前实际状态一目了然。")
                .font(.system(size: 12))
                .foregroundStyle(RadarTheme.secondaryText)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .researchPanel()
    }

    // MARK: 外观
    private var appearanceCard: some View {
        settingsCard("外观", icon: "circle.lefthalf.filled", tint: RadarTheme.blue) {
            Picker("appearance", selection: $appearancePref) {
                Text("跟随系统").tag("system")
                Text("浅色").tag("light")
                Text("深色").tag("dark")
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            Text("也可点顶栏的太阳 / 月亮按钮快速切换。")
                .font(.system(size: 10.5))
                .foregroundStyle(RadarTheme.mutedText)
        }
    }

    // MARK: 后台服务
    private var daemonCard: some View {
        settingsCard("历史客户端状态", icon: "server.rack", tint: RadarTheme.gold) {
            HStack(spacing: 8) {
                StatusDot(color: RadarTheme.gold)
                Text("Legacy Agent client 已停用")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(RadarTheme.primaryText)
            }
            Text("请使用 Web Product API 工作台。此 Swift 参考界面不会直连 Agent daemon。")
                .font(.system(size: 10.5))
                .foregroundStyle(RadarTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Agent 能力源
    private var providersCard: some View {
        settingsCard("Agent 能力源", icon: "brain.head.profile", tint: RadarTheme.violet) {
            if daemon.providers.isEmpty {
                Text("历史客户端不读取能力源配置；请在 Web Product API 工作台检查模型与运行就绪状态。")
                    .font(.system(size: 11)).foregroundStyle(RadarTheme.secondaryText)
            } else {
                ForEach(daemon.providers, id: \.provider) { p in
                    let ok = (p.connected ?? p.ready) && (p.degraded ?? false) == false
                    HStack(spacing: 8) {
                        StatusDot(color: ok ? RadarTheme.green : RadarTheme.gold)
                        Text(p.provider.uppercased())
                            .font(.system(size: 11, weight: .semibold)).foregroundStyle(RadarTheme.primaryText)
                            .frame(width: 78, alignment: .leading)
                        Text(providerDetail(p))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(ok ? RadarTheme.secondaryText : RadarTheme.gold)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                }
            }
            Text("模型、CMC MCP、WeChatCLI 均由本地后台读取运行时配置；缺配置时会降级而不是伪装可用。")
                .font(.system(size: 10.5)).foregroundStyle(RadarTheme.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func providerDetail(_ provider: AgentDaemonStatus.ProviderStatus) -> String {
        if provider.provider == "coinmarketcap" {
            if provider.connected == true { return "CMC MCP 已连接" }
            if provider.configured == true { return provider.providerType == "cmcRestProvider" ? "CMC REST fallback" : "CMC 已配置" }
            return "CMC MCP 未配置"
        }
        if provider.provider == "wechat-cli" {
            return provider.ready ? "WeChatCLI 只读可用" : "live refresh 未启用"
        }
        if provider.ready { return provider.model ?? "可用" }
        return provider.missingEnv.isEmpty ? "未配置" : "缺少 \(provider.missingEnv.joined(separator: ", "))"
    }

    // MARK: 实时微信
    private var liveWechatCard: some View {
        settingsCard("实时微信", icon: "bubble.left.and.text.bubble.right", tint: RadarTheme.cyan) {
            HStack {
                ResearchStatusChip(label: "本地只读 · \(liveWechatStatus)", color: RadarTheme.cyan)
                Spacer()
                Button {
                    Task { await viewModel.refreshWeChatLiveAndReload() }
                } label: { Label("刷新", systemImage: "arrow.clockwise") }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .controlSize(.small)
            }
            if !viewModel.wechatLiveStatus.isEmpty {
                Text(viewModel.wechatLiveStatus)
                    .font(.system(size: 10.5)).foregroundStyle(RadarTheme.secondaryText).lineLimit(2)
            }
            Text("首次使用：sudo wechat-cli init（微信运行中 + 完全磁盘访问）。只读，不发送。")
                .font(.system(size: 10.5)).foregroundStyle(RadarTheme.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: 安全边界
    private var safetyCard: some View {
        let policy = daemon.policy ?? [
            "liveWechat": "local", "trade": "blocked", "sendMessage": "blocked",
            "publishExternal": "blocked", "computerUse": "needs_confirmation"
        ]
        return VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "lock.shield", title: "安全边界", trailing: "本地优先")
            OpsRow(label: "真实微信", value: "wechat-cli 只读，不发送", status: RuntimeStatusPresenter.label(policy["liveWechat"] ?? "local"))
            OpsRow(label: "交易 / 转账", value: "永久阻断", status: RuntimeStatusPresenter.label(policy["trade"] ?? "blocked"))
            OpsRow(label: "发送消息", value: "阻断（wechat-cli 也无发送能力）", status: RuntimeStatusPresenter.label(policy["sendMessage"] ?? "blocked"))
            OpsRow(label: "对外发布", value: "阻断", status: RuntimeStatusPresenter.label(policy["publishExternal"] ?? "blocked"))
            OpsRow(label: "电脑操作", value: "只生成申请，需确认", status: RuntimeStatusPresenter.label(policy["computerUse"] ?? "needs_confirmation"))
            OpsRow(label: "密钥 / 隐私", value: "只读环境变量，不写入 artifact / 日志", status: "已保护")
        }
        .padding(14)
        .radarPanel()
    }

    // MARK: 运行与健康
    private var runtimeCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "externaldrive.badge.gearshape", title: "Diagnostics / 运行健康", trailing: RuntimeStatusPresenter.label(viewModel.syncState.status.rawValue))
            OpsRow(label: "最近运行", value: viewModel.syncState.lastRunAt, status: RuntimeStatusPresenter.label(viewModel.syncState.sourceFreshness))
            OpsRow(label: "健康", value: "runtime/health/latest-health.json", status: RuntimeStatusPresenter.label(viewModel.terminalData.runtimeHealth.overallStatus))
            OpsRow(label: "存储", value: "runtime/wechat · entities · evidence · tasks · watchlist · alerts", status: "本地")
            ForEach(viewModel.terminalData.sourceHealth) { health in
                OpsRow(label: health.source, value: health.degradedReason ?? RuntimeStatusPresenter.action(for: "\(health.status) \(health.freshness)"), status: "\(RuntimeStatusPresenter.label(health.status)) · \(RuntimeStatusPresenter.label(health.freshness))")
            }
        }
        .padding(14)
        .radarPanel()
    }

    private func settingsCard<Content: View>(_ title: String, icon: String, tint: Color, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: icon, title: title, trailing: "", tint: tint)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 130, alignment: .topLeading)
        .radarPanel()
    }
}

private struct TokenListPane: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            let tokens = viewModel.filteredTokens
            PanelHeader(icon: "bitcoinsign.circle", title: "Token Map", trailing: "\(tokens.count)")
            if tokens.isEmpty {
                EmptyStateText(text: viewModel.hasSearch ? "无匹配 Token" : "暂无 Token")
            }
            ForEach(tokens) { token in
                Button(action: { viewModel.openToken(token.tokenID) }) {
                    HStack(spacing: 11) {
                        IconChip(systemName: "bitcoinsign.circle.fill", tint: RadarTheme.gold, size: 34)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(token.symbol) · \(token.name)")
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                                .lineLimit(1)
                            HStack(spacing: 6) {
                                Text(token.chain)
                                    .font(.system(size: 9.5, weight: .medium))
                                    .foregroundStyle(RadarTheme.secondaryText)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 1)
                                    .background(RadarTheme.tintSoft)
                                    .clipShape(Capsule())
                                Text("\(token.sourceMessages.count) 条线索")
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(RadarTheme.mutedText)
                            }
                        }
                        Spacer(minLength: 4)
                        ProgressRing(value: token.confidence, size: 32, lineWidth: 3.5, label: nil)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .quietRow(selected: viewModel.selectedToken?.tokenID == token.tokenID, cornerRadius: 13)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .radarPanel()
    }
}

private struct TokenIdentityPanel: View {
    let token: TokenEntity
    let market: MarketAsset?
    let onchain: OnchainSnapshot?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PanelHeader(icon: "chart.xyaxis.line", title: "Token Deep Dive", trailing: RuntimeStatusPresenter.label(token.freshness))
            HStack(alignment: .top, spacing: 14) {
                InfoColumn(title: "身份信息", rows: [
                    ("符号", token.symbol),
                    ("名称", token.name),
                    ("链", token.chain),
                    ("合约", token.contractAddress ?? "缺失 / 仅识别符号"),
                    ("可信度", String(format: "%.2f", token.confidence))
                ])
                InfoColumn(title: "市场", rows: [
                    ("来源", market?.source ?? "暂无"),
                    ("价格", market.map { "$\(String(format: "%.2f", $0.priceUSD))" } ?? "--"),
                    ("24h", market.map { "\(String(format: "%.2f", $0.percentChange24h))%" } ?? "--"),
                    ("市值", market.map { "$\(String(format: "%.0f", $0.marketCapUSD))" } ?? "--")
                ])
                InfoColumn(title: "链上", rows: [
                    ("来源", onchain?.source ?? "暂无"),
                    ("数据状态", RuntimeStatusPresenter.label(onchain?.freshness ?? "--")),
                    ("流动性", onchain?.poolLiquidityUSD.map { "$\(String(format: "%.0f", $0))" } ?? "--"),
                    ("风险", onchain?.contractRisk ?? "--"),
                    ("持有人", onchain?.holders.map(String.init) ?? "--")
                ])
            }
        }
        .padding(14)
        .radarPanel()
    }
}

private struct RelatedMessagesPanel: View {
    let messages: [NormalizedWeChatMessage]

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            PanelHeader(icon: "bubble.left.and.text.bubble.right", title: "微信证据链", trailing: "\(messages.count)")
            ForEach(messages) { message in
                VStack(alignment: .leading, spacing: 4) {
                    Text(message.groupName)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(RadarTheme.green)
                    Text(message.text)
                        .font(.system(size: 12))
                        .lineLimit(2)
                        .foregroundStyle(RadarTheme.primaryText)
                }
                .padding(11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RadarTheme.tintFaint)
                .overlay(
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            }
        }
        .padding(14)
        .radarPanel()
    }
}

private struct InfoColumn: View {
    let title: String
    let rows: [(String, String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(RadarTheme.secondaryText)
            ForEach(rows, id: \.0) { row in
                HStack {
                    Text(row.0)
                        .foregroundStyle(RadarTheme.mutedText)
                    Spacer()
                    Text(row.1)
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(1)
                }
                .font(.system(size: 11))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RadarTheme.tintFaint)
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
    }
}

private struct OpsRow: View {
    let label: String
    let value: String
    let status: String
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(RadarTheme.primaryText)
                .frame(width: 130, alignment: .leading)
            Text(value)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(2)
            Spacer()
            Text(status)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(RuntimeStatusPresenter.color(for: status))
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(hovering ? RadarTheme.tintSoft : RadarTheme.tintFaint)
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(hovering ? RadarTheme.borderStrong : RadarTheme.borderSoft, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .onHover { hovering = $0 }
        .animation(RadarMotion.snappy, value: hovering)
    }
}

private struct EmptyStateText: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "tray")
                .font(.system(size: 13))
                .foregroundStyle(RadarTheme.mutedText)
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(RadarTheme.secondaryText)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RadarTheme.tintFaint)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
