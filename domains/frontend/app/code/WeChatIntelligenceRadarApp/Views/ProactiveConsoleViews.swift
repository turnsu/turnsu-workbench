import SwiftUI

struct CrystalConsoleView: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ProactiveSummaryStrip(viewModel: viewModel)

            HStack(alignment: .top, spacing: 14) {
                CrystalStreamView(viewModel: viewModel)
                    .frame(minWidth: 430, maxWidth: .infinity)

                VStack(alignment: .leading, spacing: 14) {
                    AgentProposalPanel(viewModel: viewModel)
                    HandoffBuilderView(viewModel: viewModel)
                    MemoryReviewView(viewModel: viewModel)
                }
                .frame(width: 330)
            }
        }
    }
}

private struct ProactiveSummaryStrip: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        // One unified strip with hairline dividers (not 4 floating cards).
        HStack(spacing: 0) {
            ProactiveMetric(title: "情报卡", value: "\(viewModel.terminalData.proactive.crystals.count)", detail: RuntimeStatusPresenter.label(viewModel.terminalData.proactive.freshness.rawValue))
            MetricDivider()
            ProactiveMetric(title: "行动建议", value: "\(viewModel.terminalData.proactive.proposals.count)", detail: proposalStatusText)
            MetricDivider()
            ProactiveMetric(title: "长期记忆", value: "\(viewModel.terminalData.proactive.memory.count)", detail: "本地")
            MetricDivider()
            ProactiveMetric(title: "交接包", value: "\(viewModel.terminalData.proactive.handoffs.count)", detail: RuntimeStatusPresenter.label(viewModel.terminalData.proactive.latestSession?.healthStatus ?? "--"))
        }
        .radarPanel()
    }

    private var proposalStatusText: String {
        let accepted = viewModel.terminalData.proactive.proposals.filter { $0.status == .accepted }.count
        return accepted == 0 ? "待处理" : "\(accepted) 已接受"
    }
}

private struct MetricDivider: View {
    var body: some View {
        Rectangle().fill(RadarTheme.border).frame(width: 1, height: 44)
    }
}

private struct ProactiveMetric: View {
    let title: String
    let value: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ResearchSectionEyebrow(text: title, icon: "bolt")
            Text(value)
                .font(.system(size: 26, weight: .heavy, design: .rounded))
                .foregroundStyle(RadarTheme.primaryText)
            Text(detail)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(1)
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct CrystalStreamView: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            let crystals = viewModel.filteredCrystals
            PanelHeader(icon: "sparkles.rectangle.stack", title: "情报流", trailing: "\(crystals.count)")

            if crystals.isEmpty {
                Text(viewModel.hasSearch ? "无匹配情报" : "暂无情报卡")
                    .font(.system(size: 12))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RadarTheme.tintFaint)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else {
                ForEach(crystals) { crystal in
                    CrystalCardView(
                        crystal: crystal,
                        selected: viewModel.selectedCrystal?.id == crystal.id,
                        action: { viewModel.selectCrystal(crystal.id) }
                    )
                }
            }
        }
        .padding(14)
        .radarPanel()
    }
}

private struct CrystalCardView: View {
    let crystal: IntelligenceCrystal
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(crystal.title)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                            .lineLimit(2)
                        Text(crystal.rationale)
                            .font(.system(size: 11))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .lineLimit(2)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(RuntimeStatusPresenter.label(crystal.freshness.rawValue))
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .foregroundStyle(color(for: crystal.freshness))
                        Text(String(format: "%.2f", crystal.confidence))
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundStyle(RadarTheme.green)
                    }
                }

                HStack(spacing: 6) {
                    ProactiveChip(text: "风险 \(RuntimeStatusPresenter.label(crystal.risk.rawValue))", color: riskColor)
                    ProactiveChip(text: "\(crystal.evidenceRefs.count) 证据", color: RadarTheme.blue)
                    ProactiveChip(text: RuntimeStatusPresenter.label(crystal.status.rawValue), color: RadarTheme.secondaryText)
                }

                Text(crystal.nextAction.title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(1)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .quietRow(selected: selected, cornerRadius: 13)
        }
        .buttonStyle(.plain)
    }

    private var riskColor: Color {
        switch crystal.risk {
        case .high, .critical:
            return RadarTheme.red
        case .medium:
            return RadarTheme.gold
        default:
            return RadarTheme.green
        }
    }

    private func color(for freshness: ProactiveFreshness) -> Color {
        switch freshness {
        case .fresh, .currentRun:
            return RadarTheme.green
        case .degraded, .stale, .fixture:
            return RadarTheme.gold
        case .blocked:
            return RadarTheme.red
        default:
            return RadarTheme.secondaryText
        }
    }
}

struct AgentProposalPanel: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "checklist.checked", title: "行动建议", trailing: RuntimeStatusPresenter.label(viewModel.selectedProposal?.status.rawValue ?? "--"))

            if let proposal = viewModel.selectedProposal {
                Text(proposal.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(2)
                Text(proposal.summary)
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(3)
                OpsRowCompact(label: "建议动作", value: RuntimeStatusPresenter.intentLabel(proposal.action.rawValue), status: RuntimeStatusPresenter.label(proposal.permission.permission.rawValue))
                OpsRowCompact(label: "风险", value: RuntimeStatusPresenter.label(proposal.risk.rawValue), status: String(format: "%.2f", proposal.confidence))
                HStack {
                    Button("接受") { viewModel.acceptSelectedProposal() }
                    Button("拒绝") { viewModel.rejectSelectedProposal() }
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .controlSize(.small)
            } else {
                Text("暂无建议")
                    .font(.system(size: 12))
                    .foregroundStyle(RadarTheme.secondaryText)
            }
        }
        .padding(14)
        .radarPanel()
    }
}

struct HandoffBuilderView: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "doc.badge.arrow.up", title: "交接包", trailing: RuntimeStatusPresenter.label(viewModel.selectedHandoff?.status.rawValue ?? "draft"))
            if let handoff = viewModel.selectedHandoff {
                Text(handoff.title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(1)
                Text(handoff.summaryText)
                    .font(.system(size: 10))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(4)
                OpsRowCompact(label: "隐私处理", value: RuntimeStatusPresenter.intentLabel(handoff.redaction.policy.rawValue), status: handoff.redaction.privateContentIncluded ? "需复核" : "安全")
            }
            HStack {
                Button("从当前情报生成") {
                    viewModel.createHandoffFromSelectedCrystal()
                }
                Button("归档") {
                    viewModel.archiveSelectedHandoff()
                }
                Button("清理归档") {
                    viewModel.purgeArchivedHandoffs()
                }
            }
            .buttonStyle(ResearchSecondaryButtonStyle())
            .controlSize(.small)
        }
        .padding(14)
        .radarPanel()
    }
}

struct MemoryReviewView: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "brain.head.profile", title: "记忆复盘", trailing: "\(viewModel.terminalData.proactive.memory.count)")
            if let memory = viewModel.selectedMemory ?? viewModel.terminalData.proactive.memory.first {
                OpsRowCompact(label: RuntimeStatusPresenter.intentLabel(memory.kind.rawValue), value: memory.title, status: RuntimeStatusPresenter.label(memory.status.rawValue))
                Text(memory.content)
                    .font(.system(size: 10))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(3)
            }
            HStack {
                Button("有用") { viewModel.markSelectedCrystalUseful() }
                Button("误报") { viewModel.markSelectedCrystalFalsePositive() }
            }
            .buttonStyle(ResearchSecondaryButtonStyle())
            .controlSize(.small)
        }
        .padding(14)
        .radarPanel()
    }
}

struct BridgeStatusPanel: View {
    let statuses: [RuntimeBridgeStatus]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "point.3.connected.trianglepath.dotted", title: "数据接入状态", trailing: "\(statuses.count)")
            ForEach(statuses) { status in
                OpsRowCompact(
                    label: status.name,
                    value: status.errorMessage ?? RuntimeStatusPresenter.action(for: status.freshness.rawValue),
                    status: "\(RuntimeStatusPresenter.label(status.status.rawValue)) · \(RuntimeStatusPresenter.label(status.freshness.rawValue))"
                )
            }
        }
        .padding(14)
        .radarPanel()
    }
}

private struct ProactiveChip: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }
}

private struct OpsRowCompact: View {
    let label: String
    let value: String
    let status: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(label)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(1)
                Spacer()
                Text(status)
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(RuntimeStatusPresenter.color(for: status))
                    .lineLimit(1)
            }
            Text(value)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(2)
        }
        .padding(9)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(RadarTheme.tintFaint))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(RadarTheme.borderSoft, lineWidth: 1))
    }
}
