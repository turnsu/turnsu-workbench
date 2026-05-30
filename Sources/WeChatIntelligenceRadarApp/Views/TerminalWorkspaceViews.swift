import SwiftUI

struct LibraryWorkspaceView: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("资料库")
                        .font(.system(size: 24, weight: .semibold))
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
            VStack(alignment: .leading, spacing: 12) {
                let messages = viewModel.filteredMessages
                PanelHeader(icon: "tray.full", title: "Research Feed · 微信线索", trailing: "\(messages.count) 条")
                if messages.isEmpty {
                    EmptyStateText(text: viewModel.hasSearch ? "无匹配消息" : "暂无消息")
                }
                ForEach(messages) { message in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(message.groupName)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(RadarTheme.green)
                            Spacer()
                            Text(AgentDateFormatting.displayString(message.sentAt))
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(RadarTheme.mutedText)
                        }
                        Text(message.text)
                            .font(.system(size: 12))
                            .foregroundStyle(RadarTheme.primaryText)
                            .lineLimit(2)
                        HStack(spacing: 6) {
                            ForEach(message.extractedSymbols, id: \.self) { symbol in
                                Button(symbol) {
                                    if let id = message.linkedTokenIDs.first {
                                        viewModel.openToken(id)
                                    }
                                }
                                .font(.system(size: 10, weight: .bold, design: .monospaced))
                                .buttonStyle(.plain)
                                .foregroundStyle(RadarTheme.blue)
                            }
                            ForEach(message.extractedContracts.prefix(1), id: \.self) { contract in
                                Text(contract)
                                    .font(.system(size: 9, design: .monospaced))
                                    .lineLimit(1)
                                    .foregroundStyle(RadarTheme.gold)
                            }
                        }
                    }
                    .padding(12)
                    .background(RadarTheme.panelElevated.opacity(0.72))
                    .researchPanel()
                    .onTapGesture {
                        viewModel.selectMessage(message.id)
                    }
                }
            }
            .padding(14)
            .radarPanel()

            TokenListPane(viewModel: viewModel)
                .frame(width: 330)
        }
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
                    RelatedMessagesPanel(messages: viewModel.selectedTokenMessages)
                } else {
                    Text("未选择 Token")
                        .foregroundStyle(RadarTheme.secondaryText)
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }
}

struct WatchlistWorkspaceView: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 12) {
                let items = viewModel.filteredWatchlistItems
                PanelHeader(icon: "star.circle", title: "观察与预警工作台", trailing: "\(items.count)")
                if items.isEmpty {
                    EmptyStateText(text: viewModel.hasSearch ? "无匹配观察项" : "暂无观察项")
                }
                ForEach(items) { item in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(item.symbol) · \(item.chain)")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                            Text(item.reason)
                                .font(.system(size: 11))
                                .foregroundStyle(RadarTheme.secondaryText)
                        }
                        Spacer()
                        Text(RuntimeStatusPresenter.label(item.freshness))
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(RuntimeStatusPresenter.color(for: item.freshness))
                    }
                    .padding(12)
                    .background(RadarTheme.panelElevated)
                    .researchPanel()
                    .onTapGesture {
                        viewModel.openToken(item.tokenID)
                    }
                }
            }
            .padding(14)
            .radarPanel()

            VStack(alignment: .leading, spacing: 12) {
                PanelHeader(icon: "bell.badge", title: "风险规则 / 下一步动作", trailing: "\(viewModel.terminalData.alerts.count) open")
                ForEach(viewModel.terminalData.alerts) { alert in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(alert.title)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                            Spacer()
                            Text("\(RuntimeStatusPresenter.label(alert.severity)) · \(RuntimeStatusPresenter.label(alert.status))")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(alert.severity == "medium" ? RadarTheme.gold : RadarTheme.green)
                        }
                        Text(alert.reason)
                            .font(.system(size: 11))
                            .foregroundStyle(RadarTheme.secondaryText)
                    }
                    .padding(12)
                    .background(RadarTheme.panelElevated)
                    .researchPanel()
                    .onTapGesture {
                        viewModel.selectedAlertID = alert.id
                    }
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

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 12) {
                PanelHeader(icon: "externaldrive.badge.gearshape", title: "Ops Runtime · 运行状态", trailing: RuntimeStatusPresenter.label(viewModel.syncState.status.rawValue))
                OpsRow(label: "执行记录", value: RuntimeStatusPresenter.shortRunLabel(viewModel.syncState.runID), status: RuntimeStatusPresenter.label(viewModel.syncState.status.rawValue))
                OpsRow(label: "最近运行", value: viewModel.syncState.lastRunAt, status: RuntimeStatusPresenter.label(viewModel.syncState.sourceFreshness))
                OpsRow(label: "最近成功", value: viewModel.syncState.lastSuccessAt ?? "--", status: "可用")
                OpsRow(label: "运行记录", value: viewModel.artifactStatus?.runDirectory ?? "--", status: viewModel.artifactStatus?.errorMessage == nil ? "可用" : "失败")
                OpsRow(label: "记录清单", value: "runtime/artifacts/manifest.json", status: RuntimeStatusPresenter.label(viewModel.terminalData.artifactManifest.completenessStatus))
                OpsRow(label: "健康", value: "runtime/health/latest-health.json", status: RuntimeStatusPresenter.label(viewModel.terminalData.runtimeHealth.overallStatus))
                OpsRow(label: "Agent Host", value: viewModel.agentOpsSnapshot.healthPath, status: viewModel.agentOpsSnapshot.dependencySummary)
                OpsRow(label: "Provider", value: viewModel.agentOpsSnapshot.providerStatusPath, status: viewModel.agentOpsSnapshot.providerSummary)
                OpsRow(label: "Policy", value: viewModel.agentOpsSnapshot.policySummaryPath, status: viewModel.agentOpsSnapshot.policySummary)
                OpsRow(label: "存储", value: "runtime/wechat · entities · evidence · tasks · watchlist · alerts", status: "本地")
                OpsRow(label: "密钥/隐私", value: viewModel.terminalData.runtimeHealth.privacyPolicy.secretsBoundary, status: "已阻断")
            }
            .padding(14)
            .radarPanel()

            VStack(alignment: .leading, spacing: 12) {
                PanelHeader(icon: "heart.text.square", title: "来源健康 / Staleness", trailing: "\(viewModel.terminalData.sourceHealth.count) 个")
                ForEach(viewModel.terminalData.sourceHealth) { health in
                    let statusText = "\(RuntimeStatusPresenter.label(health.status)) · \(RuntimeStatusPresenter.label(health.freshness))"
                    let actionText = health.degradedReason ?? RuntimeStatusPresenter.action(for: "\(health.status) \(health.freshness)")
                    OpsRow(label: health.source, value: actionText, status: statusText)
                }
                ForEach(viewModel.terminalData.runtimeHealth.checks) { check in
                    OpsRow(label: check.name, value: check.detail, status: RuntimeStatusPresenter.label(check.status))
                }
            }
            .padding(14)
            .radarPanel()

            BridgeStatusPanel(statuses: viewModel.terminalData.proactive.bridgeStatuses)
                .frame(width: 330)
        }
    }
}

private struct TokenListPane: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            let tokens = viewModel.filteredTokens
            PanelHeader(icon: "bitcoinsign.circle", title: "Token Map", trailing: "\(tokens.count)")
            if tokens.isEmpty {
                EmptyStateText(text: viewModel.hasSearch ? "无匹配 Token" : "暂无 Token")
            }
            ForEach(tokens) { token in
                Button(action: { viewModel.openToken(token.tokenID) }) {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(token.symbol) · \(token.name)")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                            Text("\(token.chain) · 置信度 \(String(format: "%.2f", token.confidence))")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(RadarTheme.secondaryText)
                        }
                        Spacer()
                        Text("\(token.sourceMessages.count)")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundStyle(RadarTheme.green)
                    }
                    .padding(10)
                    .background(viewModel.selectedToken?.tokenID == token.tokenID ? RadarTheme.panelElevated : RadarTheme.panelElevated.opacity(0.55))
                    .researchPanel(glow: viewModel.selectedToken?.tokenID == token.tokenID)
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
        VStack(alignment: .leading, spacing: 10) {
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
                .padding(10)
                .background(RadarTheme.panelElevated.opacity(0.65))
                .researchPanel()
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
            Text(title.uppercased())
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundStyle(RadarTheme.mutedText)
            ForEach(rows, id: \.0) { row in
                HStack {
                    Text(row.0)
                        .foregroundStyle(RadarTheme.secondaryText)
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
        .background(RadarTheme.panelElevated.opacity(0.7))
        .researchPanel()
    }
}

private struct AgentModuleTimelineView: View {
    let runs: [AgentModuleRun]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "point.3.connected.trianglepath.dotted", title: "Agent 处理进度", trailing: "\(runs.count)")
            ForEach(runs) { run in
                HStack(spacing: 10) {
                    Circle()
                        .fill(color(for: run.status))
                        .frame(width: 8, height: 8)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(RuntimeStatusPresenter.intentLabel(run.moduleID.rawValue)) · \(RuntimeStatusPresenter.label(run.status.rawValue))")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                        Text(run.outputSummary)
                            .font(.system(size: 10))
                            .foregroundStyle(RadarTheme.secondaryText)
                        Text(run.producedArtifacts.isEmpty ? "暂无记录文件" : "记录文件：\(run.producedArtifacts.joined(separator: " · "))")
                            .font(.system(size: 9))
                            .lineLimit(1)
                            .foregroundStyle(RadarTheme.mutedText)
                    }
                    Spacer()
                    Text(run.degradedReason ?? run.error ?? "--")
                        .font(.system(size: 9, design: .monospaced))
                        .lineLimit(1)
                        .foregroundStyle(RadarTheme.mutedText)
                }
                .padding(10)
                .background(RadarTheme.panelElevated.opacity(0.65))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(14)
        .radarPanel()
    }

    private func color(for status: AgentModuleStatus) -> Color {
        switch status {
        case .completed:
            return RadarTheme.green
        case .degraded:
            return RadarTheme.gold
        case .failed:
            return RadarTheme.red
        default:
            return RadarTheme.secondaryText
        }
    }
}

private struct OpsRow: View {
    let label: String
    let value: String
    let status: String

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
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundStyle(RuntimeStatusPresenter.color(for: status))
        }
        .padding(10)
        .background(RadarTheme.panelElevated.opacity(0.65))
        .researchPanel()
    }
}

private struct EmptyStateText: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundStyle(RadarTheme.secondaryText)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RadarTheme.panelElevated.opacity(0.5))
            .researchPanel()
    }
}
