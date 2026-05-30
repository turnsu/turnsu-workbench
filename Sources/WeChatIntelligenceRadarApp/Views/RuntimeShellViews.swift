import SwiftUI

struct TerminalTopCommandBar: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 9) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
                TextField("搜索情报、Token、群聊…", text: $viewModel.searchQuery)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color.white.opacity(0.055))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(RadarTheme.borderSoft, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .frame(maxWidth: .infinity)

            Picker("Window", selection: Binding(
                get: { viewModel.selectedWindow },
                set: { viewModel.updateWindow($0) }
            )) {
                ForEach(TimeWindow.allCases) { window in
                    Text(window.rawValue).tag(window)
                }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: 180)

            HStack(spacing: 7) {
                StatusDot(color: RuntimeStatusPresenter.color(for: viewModel.syncState.status.rawValue))
                Text(RuntimeStatusPresenter.label(viewModel.syncState.status.rawValue))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(RadarTheme.secondaryText)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color.white.opacity(0.045))
            .clipShape(Capsule())

            Button(action: { viewModel.refresh(reason: "top_command_refresh") }) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .bold))
            }
            .buttonStyle(ResearchSecondaryButtonStyle())
        }
        .padding(8)
        .background(.ultraThinMaterial)
        .researchPanel()
    }
}

struct RuntimeRightInspectorView: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                ResearchSectionEyebrow(text: "Inspector", icon: "sidebar.right")
                Spacer()
                Text(viewModel.selectedToken?.symbol ?? "Evidence")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(RadarTheme.mutedText)
                    .lineLimit(1)
            }

            if let crystal = viewModel.selectedCrystal {
                inspectorSection("情报卡", rows: [
                    ("标题", crystal.title),
                    ("数据状态", RuntimeStatusPresenter.label(crystal.freshness.rawValue)),
                    ("风险", RuntimeStatusPresenter.label(crystal.risk.rawValue)),
                    ("可信度", String(format: "%.2f", crystal.confidence))
                ])
                Text(crystal.rationale)
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(3)
                HStack {
                    Button("有用") { viewModel.markSelectedCrystalUseful() }
                    Button("误报") { viewModel.markSelectedCrystalFalsePositive() }
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .controlSize(.small)
            }

            if let proposal = viewModel.selectedProposal {
                inspectorSection("行动建议", rows: [
                    ("建议动作", RuntimeStatusPresenter.intentLabel(proposal.action.rawValue)),
                    ("状态", RuntimeStatusPresenter.label(proposal.status.rawValue)),
                    ("权限", RuntimeStatusPresenter.label(proposal.permission.permission.rawValue))
                ])
                HStack {
                    Button("接受") { viewModel.acceptSelectedProposal() }
                    Button("拒绝") { viewModel.rejectSelectedProposal() }
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .controlSize(.small)
            }

            if let message = viewModel.selectedMessage {
                inspectorSection("微信消息", rows: [
                    ("群组", message.groupName),
                    ("发送者", message.sender),
                    ("Token", message.extractedSymbols.joined(separator: ",").ifEmpty("--")),
                    ("合约地址", message.extractedContracts.joined(separator: ",").ifEmpty("--"))
                ])
                Button("创建跟进任务") {
                    viewModel.createTaskFromSelectedMessage()
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .controlSize(.small)
            }

            if let token = viewModel.selectedToken {
                inspectorSection("Token 信息", rows: [
                    ("标识", token.tokenID),
                    ("链", token.chain),
                    ("合约", token.contractAddress ?? "仅识别符号"),
                    ("可信度", String(format: "%.2f", token.confidence)),
                    ("数据状态", RuntimeStatusPresenter.label(token.freshness))
                ])
                Button("加入观察列表") {
                    viewModel.addSelectedTokenToWatchlist()
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .controlSize(.small)
            }

            if let evidence = viewModel.selectedEvidence {
                inspectorSection("判断依据", rows: [
                    ("类型", RuntimeStatusPresenter.intentLabel(evidence.evidenceType)),
                    ("数据状态", RuntimeStatusPresenter.label(evidence.freshness)),
                    ("可信度", String(format: "%.2f", evidence.confidence)),
                    ("来源", evidence.source)
                ])
                Text(evidence.summary)
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(3)
                Button("复制依据") {
                    viewModel.copySelectedEvidenceToPasteboard()
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .controlSize(.small)
            }

            if let alert = viewModel.selectedAlert {
                inspectorSection("预警", rows: [
                    ("标题", alert.title),
                    ("级别", RuntimeStatusPresenter.label(alert.severity)),
                    ("状态", RuntimeStatusPresenter.label(alert.status))
                ])
                HStack {
                    Button("确认") { viewModel.acknowledgeAlert(alert.id) }
                    Button("静音") { viewModel.muteAlert(alert.id) }
                    Button("解决") { viewModel.resolveAlert(alert.id) }
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .controlSize(.small)
            }

            if let artifact = viewModel.selectedArtifactPath {
                inspectorSection("记录文件", rows: [
                    ("位置", artifact)
                ])
            }

            if let handoff = viewModel.selectedHandoff {
                inspectorSection("交接包", rows: [
                    ("状态", RuntimeStatusPresenter.label(handoff.status.rawValue)),
                    ("脱敏", RuntimeStatusPresenter.intentLabel(handoff.redaction.policy.rawValue)),
                    ("隐私内容", handoff.redaction.privateContentIncluded ? "需要复核" : "已脱敏")
                ])
            }

            if !hasSelection {
                VStack(alignment: .leading, spacing: 8) {
                    ResearchSectionEyebrow(text: "Evidence / Policy / Artifact", icon: "doc.text.magnifyingglass")
                    Text("选择情报卡、Token、微信消息、行动建议或记录文件后，这里会显示证据链、权限边界和可复制的交接信息。")
                        .font(.system(size: 11))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
                .researchPanel()
            }

            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(width: 320)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(
            LinearGradient(
                colors: [RadarTheme.sidebar.opacity(0.86), RadarTheme.cyanBase.opacity(0.26), RadarTheme.backgroundDeep.opacity(0.8)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .researchPanel()
    }

    private func inspectorSection(_ title: String, rows: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            ResearchSectionEyebrow(text: title, icon: "square.text.square")
            ForEach(rows, id: \.0) { row in
                HStack(alignment: .top) {
                    Text(row.0)
                        .foregroundStyle(RadarTheme.mutedText)
                        .frame(width: 76, alignment: .leading)
                    Text(row.1)
                        .lineLimit(2)
                        .foregroundStyle(RadarTheme.primaryText)
                }
                .font(.system(size: 10))
            }
        }
        .padding(12)
        .researchPanel()
    }

    private var hasSelection: Bool {
        viewModel.selectedCrystal != nil ||
            viewModel.selectedProposal != nil ||
            viewModel.selectedMessage != nil ||
            viewModel.selectedToken != nil ||
            viewModel.selectedEvidence != nil ||
            viewModel.selectedAlert != nil ||
            viewModel.selectedArtifactPath != nil ||
            viewModel.selectedHandoff != nil
    }
}

struct BottomOperationsDeck: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                ResearchSectionEyebrow(text: "Execution Strip", icon: "waveform.path")
                ForEach(OperationsDeckTab.allCases) { tab in
                    Button(action: { viewModel.selectedOperationsTab = tab }) {
                        Text(tab.displayName)
                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                            .foregroundStyle(viewModel.selectedOperationsTab == tab ? RadarTheme.green : RadarTheme.secondaryText)
                            .researchCapsule(active: viewModel.selectedOperationsTab == tab)
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
                ResearchStatusChip(
                    label: "Run \(RuntimeStatusPresenter.shortRunLabel(viewModel.syncState.runID))",
                    icon: "record.circle",
                    color: RuntimeStatusPresenter.color(for: viewModel.syncState.status.rawValue)
                )
            }

            deckContent
                .frame(maxWidth: .infinity, minHeight: 105, maxHeight: 125, alignment: .topLeading)
        }
        .padding(12)
        .background(
            LinearGradient(
                colors: [RadarTheme.panel.opacity(0.84), RadarTheme.cyanBase.opacity(0.22), RadarTheme.purpleBase.opacity(0.24)],
                startPoint: .leading,
                endPoint: .trailing
            )
        )
        .researchPanel()
    }

    @ViewBuilder
    private var deckContent: some View {
        switch viewModel.selectedOperationsTab {
        case .run:
            deckGrid(viewModel.terminalData.moduleRuns.prefix(6).map {
                ("步骤", "\(RuntimeStatusPresenter.intentLabel($0.moduleID.rawValue)) · \(RuntimeStatusPresenter.label($0.status.rawValue))", $0.degradedReason ?? $0.outputSummary)
            })
        case .proactive:
            let rows = viewModel.filteredCrystals.prefix(3).map {
                ("情报", $0.title, "\(RuntimeStatusPresenter.label($0.freshness.rawValue)) · \(String(format: "%.2f", $0.confidence))")
            } + viewModel.filteredProposals.prefix(3).map {
                ("建议", $0.title, "\(RuntimeStatusPresenter.label($0.status.rawValue)) · \(RuntimeStatusPresenter.label($0.permission.permission.rawValue))")
            }
            deckGrid(rows)
        case .evidence:
            deckGrid(viewModel.terminalData.evidenceItems.prefix(6).map {
                ("证据", $0.title, "\(RuntimeStatusPresenter.label($0.freshness)) · \(String(format: "%.2f", $0.confidence))")
            })
        case .tasks:
            deckGrid(viewModel.terminalData.tasks.prefix(6).map {
                ("任务", $0.title, "\(RuntimeStatusPresenter.label($0.status)) · P\($0.priority)")
            })
        case .logs:
            deckGrid(viewModel.logs.prefix(6).map {
                ($0.level.rawValue, $0.timestamp, $0.message)
            })
        case .artifacts:
            deckGrid(viewModel.terminalData.artifactManifest.references.prefix(6).map {
                ("记录", RuntimeStatusPresenter.intentLabel($0.label), RuntimeStatusPresenter.label($0.status))
            })
        case .policy:
            deckGrid(viewModel.policies.prefix(6).map {
                (RuntimeStatusPresenter.intentLabel($0.action), RuntimeStatusPresenter.label($0.status), $0.reason)
            })
        }
    }

    private func deckGrid(_ rows: [(String, String, String)]) -> some View {
        LazyVGrid(columns: [
            GridItem(.flexible(), spacing: 8),
            GridItem(.flexible(), spacing: 8),
            GridItem(.flexible(), spacing: 8)
        ], spacing: 8) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.0.uppercased())
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .foregroundStyle(RadarTheme.mutedText)
                    Text(row.1)
                        .font(.system(size: 10, weight: .semibold))
                        .lineLimit(1)
                        .foregroundStyle(RadarTheme.primaryText)
                    Text(row.2)
                        .font(.system(size: 9))
                        .lineLimit(1)
                        .foregroundStyle(RadarTheme.secondaryText)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RadarTheme.panelElevated.opacity(0.58))
                .researchPanel()
            }
        }
    }
}

private struct StatusPill: View {
    let label: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label.uppercased())
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .foregroundStyle(RadarTheme.mutedText)
            Text(detail)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(RuntimeStatusPresenter.color(for: detail))
                .lineLimit(1)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(RadarTheme.panelElevated.opacity(0.8))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

private extension String {
    func ifEmpty(_ fallback: String) -> String {
        isEmpty ? fallback : self
    }
}

enum RuntimeStatusPresenter {
    static func label(_ raw: String) -> String {
        let value = raw.lowercased()
        if value.contains("fresh") || value.contains("current") || value == "pass" || value == "completed" || value == "ok" || value == "enabled" || value == "active" || value == "accepted" {
            return "可用"
        }
        if value.contains("stale") {
            return "过期"
        }
        if value.contains("degraded") {
            return "降级"
        }
        if value.contains("blocked") {
            return "已阻断"
        }
        if value.contains("failed") || value.contains("rejected") {
            return "失败"
        }
        if value.contains("needs_confirmation") || value.contains("confirmation") {
            return "需确认"
        }
        if value.contains("local_write") || value.contains("local_read") || value == "metadata" || value == "fixture" {
            return "本地"
        }
        if value == "low" {
            return "低"
        }
        if value == "medium" {
            return "中"
        }
        if value == "high" {
            return "高"
        }
        if value == "critical" {
            return "严重"
        }
        if value.contains("running") {
            return "运行中"
        }
        if value.contains("proposed") || value.contains("pending") || value.contains("draft") || value.contains("planned") {
            return "待处理"
        }
        if value.contains("archived") {
            return "已归档"
        }
        if value.isEmpty || value == "--" {
            return "--"
        }
        return raw
    }

    static func action(for raw: String) -> String {
        let value = raw.lowercased()
        if value.contains("blocked") {
            return "保持阻断；需用户明确授权才可接入。"
        }
        if value.contains("stale") {
            return "等待外部 normalized JSON 刷新。"
        }
        if value.contains("degraded") {
            return "查看记录文件与降级原因后再决策。"
        }
        if value.contains("needs_confirmation") {
            return "需要用户确认后才可读取。"
        }
        return "可继续本地操作。"
    }

    static func intentLabel(_ raw: String) -> String {
        let value = raw.lowercased()
        switch value {
        case "ingestion", "read_mock_fixture", "read_fixture_file", "wechat.read_normalized_messages":
            return "读取微信情报"
        case "entityresolver", "token.resolve_entities":
            return "识别 Token / 地址"
        case "marketdata", "market.read_snapshot":
            return "读取行情"
        case "onchain", "onchain.read_snapshot":
            return "读取链上数据"
        case "evidence":
            return "整理判断依据"
        case "memory", "save_memory", "memory.save":
            return "写入长期记忆"
        case "crystal", "crystal.create_or_update":
            return "生成情报卡"
        case "proposal", "proposal.create":
            return "生成行动建议"
        case "create_task":
            return "创建跟进任务"
        case "add_watchlist":
            return "加入观察列表"
        case "create_alert":
            return "创建预警"
        case "create_handoff", "create_handoff_draft", "handoff.write":
            return "生成交接包"
        case "private_preview_redacted":
            return "隐私预览已脱敏"
        case "message_token_market_onchain":
            return "微信 + 行情 + 链上证据"
        default:
            return raw.replacingOccurrences(of: "_", with: " ")
        }
    }

    static func shortRunLabel(_ raw: String) -> String {
        if raw.isEmpty || raw == "--" {
            return "--"
        }
        let cleaned = raw.replacingOccurrences(of: "run-", with: "")
        return String(cleaned.prefix(8))
    }

    static func sourceModeLabel(_ raw: String) -> String {
        let value = raw.lowercased()
        var parts: [String] = []
        if value.contains("fixture") || value.contains("mock") {
            parts.append("示例数据")
        }
        if value.contains("web3") || value.contains("cmc") {
            parts.append("链上/行情")
        }
        if value.contains("degraded") {
            parts.append("部分降级")
        }
        if value.contains("live") {
            parts.append("实时数据")
        }
        if parts.isEmpty {
            return label(raw)
        }
        return parts.joined(separator: " · ")
    }

    static func commandLabel(_ raw: String) -> String {
        let value = raw.lowercased()
        if value.contains("refresh") || value.contains("rerun") {
            return "最近已刷新"
        }
        if value.contains("initial") {
            return "初始状态"
        }
        if value.contains("running") {
            return "正在运行"
        }
        if value.contains("failed") {
            return "刷新失败"
        }
        if value.isEmpty || value == "--" {
            return "--"
        }
        return raw.replacingOccurrences(of: "_", with: " ")
    }

    static func color(for raw: String) -> Color {
        let value = raw.lowercased()
        if value.contains("failed") || value.contains("blocked") || value.contains("失败") || value.contains("阻断") {
            return RadarTheme.red
        }
        if value.contains("degraded") || value.contains("stale") || value.contains("confirmation") || value.contains("降级") || value.contains("过期") || value.contains("确认") {
            return RadarTheme.gold
        }
        return RadarTheme.green
    }
}
