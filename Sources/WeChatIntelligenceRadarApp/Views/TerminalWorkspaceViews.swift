import SwiftUI

struct LibraryWorkspaceView: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("资料库")
                        .font(RadarFont.display(24, .bold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Text("微信线索、Token 和观察项都收在这里，不打断今日工作台。")
                        .font(.system(size: 12))
                        .foregroundStyle(RadarTheme.secondaryText)
                }
                Spacer()
                Picker("Library", selection: Binding(
                    get: { librarySelection },
                    set: { viewModel.select(workspace: $0) }
                )) {
                    Text("微信").tag(TerminalWorkspace.inbox)
                    Text("Token").tag(TerminalWorkspace.token)
                    Text("观察").tag(TerminalWorkspace.watchlist)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .frame(width: 260)
            }
            .padding(18)
            .researchPanel()

            Group {
                switch librarySelection {
                case .inbox:
                    WeChatInboxWorkspaceView(viewModel: viewModel)
                case .token:
                    TokenTerminalWorkspaceView(viewModel: viewModel)
                case .watchlist:
                    WatchlistWorkspaceView(viewModel: viewModel)
                default:
                    WeChatInboxWorkspaceView(viewModel: viewModel)
                }
            }
            .id(librarySelection)
            .transition(.opacity.combined(with: .offset(y: 8)))
        }
        .animation(RadarMotion.smooth, value: librarySelection)
    }

    private var librarySelection: TerminalWorkspace {
        switch viewModel.selectedWorkspace {
        case .token, .watchlist:
            return viewModel.selectedWorkspace
        default:
            return .inbox
        }
    }
}

struct WeChatInboxWorkspaceView: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
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
            .radarPanel()

            TokenListPane(viewModel: viewModel)
                .frame(width: 330)
        }
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

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            TokenListPane(viewModel: viewModel)
                .frame(width: 300)

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
}

struct WatchlistWorkspaceView: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
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
            .radarPanel()

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
            .radarPanel()
        }
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
    @AppStorage("radar.appearance") private var appearancePref = "system"

    private var daemon: AgentDaemonStatus { viewModel.agentDaemonStatus }
    private var daemonConnected: Bool { daemon.daemon != nil }
    private var liveWechatStatus: String { RuntimeStatusPresenter.label(daemon.policy?["liveWechat"] ?? "blocked") }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 14) {
                appearanceCard
                daemonCard
                providersCard
                liveWechatCard
            }
            safetyCard
            runtimeCard
        }
        .frame(maxWidth: 1000, alignment: .topLeading)
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
        settingsCard("后台服务", icon: "server.rack", tint: daemonConnected ? RadarTheme.green : RadarTheme.gold) {
            HStack(spacing: 8) {
                StatusDot(color: daemonConnected ? RadarTheme.green : RadarTheme.gold, pulsing: daemonConnected)
                Text(daemonConnected ? "已连接 · 127.0.0.1:\(daemon.daemon?.port ?? 8797)" : "未连接")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(RadarTheme.primaryText)
            }
            Text(daemonConnected
                 ? "Agent Runtime Host 正在运行，可发起任务与实时刷新。"
                 : "运行 scripts/start-agent-daemon.sh（或双击桌面「启动」）后自动连接。")
                .font(.system(size: 10.5))
                .foregroundStyle(RadarTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: AI 模型
    private var providersCard: some View {
        settingsCard("AI 模型", icon: "brain.head.profile", tint: RadarTheme.violet) {
            if daemon.providers.isEmpty {
                Text(daemonConnected ? "未检测到模型配置。" : "后台未连接，无法检查模型。")
                    .font(.system(size: 11)).foregroundStyle(RadarTheme.secondaryText)
            } else {
                ForEach(daemon.providers, id: \.provider) { p in
                    HStack(spacing: 8) {
                        StatusDot(color: p.ready ? RadarTheme.green : RadarTheme.gold)
                        Text(p.provider.uppercased())
                            .font(.system(size: 11, weight: .semibold)).foregroundStyle(RadarTheme.primaryText)
                            .frame(width: 78, alignment: .leading)
                        Text(p.ready ? (p.model ?? "可用") : "缺少 \(p.missingEnv.joined(separator: ", "))")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(p.ready ? RadarTheme.secondaryText : RadarTheme.gold)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                }
            }
            Text("在项目根目录 .env 填入 DEEPSEEK_API_KEY（可选 KIMI_API_KEY）后重启后台。")
                .font(.system(size: 10.5)).foregroundStyle(RadarTheme.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
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
            PanelHeader(icon: "externaldrive.badge.gearshape", title: "运行与健康", trailing: RuntimeStatusPresenter.label(viewModel.syncState.status.rawValue))
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
                .background(RadarTheme.panelElevated.opacity(0.5))
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
        .background(RadarTheme.panelElevated.opacity(0.55))
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
        .background(RadarTheme.panelElevated.opacity(hovering ? 0.7 : 0.5))
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
        .background(RadarTheme.panelElevated.opacity(0.4))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
