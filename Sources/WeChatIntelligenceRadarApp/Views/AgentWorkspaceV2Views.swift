import SwiftUI

struct AgentWorkspaceV2View: View {
    @ObservedObject var viewModel: DashboardViewModel
    @AppStorage("minimalWorkbench.agentRailCollapsed") private var agentRailCollapsed = false

    var body: some View {
        let thread = viewModel.agentThreadState
        // HSplitView gives native, drag-resizable dividers between the three panes.
        // Min/ideal/max widths keep the Inspector from getting cramped at any window size.
        HSplitView {
            AgentLeftRail(
                viewModel: viewModel,
                thread: thread,
                collapsed: agentRailCollapsed,
                toggleCollapsed: { withAnimation(RadarMotion.gentle) { agentRailCollapsed.toggle() } }
            )
            .frame(
                minWidth: agentRailCollapsed ? 64 : 200,
                idealWidth: agentRailCollapsed ? 64 : 248,
                maxWidth: agentRailCollapsed ? 64 : 380,
                maxHeight: .infinity
            )

            AgentThreadWorkspace(viewModel: viewModel, thread: thread)
                .frame(minWidth: 420, idealWidth: 660, maxWidth: .infinity, maxHeight: .infinity)
                .layoutPriority(1)

            if viewModel.selectedAgentInspector != .overview {
                AgentInspectorV2Panel(viewModel: viewModel, thread: thread)
                    .frame(minWidth: 280, idealWidth: 340, maxWidth: 520, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(RadarMotion.gentle, value: agentRailCollapsed)
    }
}

private struct AgentTopStatusBar: View {
    @ObservedObject var viewModel: DashboardViewModel
    let thread: AgentThreadState

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                ResearchSectionEyebrow(text: "Agent Operating Desk", icon: "sparkles.rectangle.stack")
                Text("任务对话 · 上下文组合 · 能力包调用 · 证据追踪")
                    .font(.system(size: 17, weight: .heavy, design: .rounded))
                    .foregroundStyle(RadarTheme.primaryText)
                Text("底层 provider / tool / module 仅写入 artifact；前台只让用户选择公开能力包。")
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(1)
            }

            Spacer()

            AgentStatusPill(
                label: thread.statusText,
                systemImage: "waveform.path.ecg",
                color: AgentUIStyle.threadColor(thread.status)
            )
            AgentStatusPill(label: daemonSummary, systemImage: "server.rack", color: daemonColor(daemonSummary))
                .frame(maxWidth: 210)
            AgentStatusPill(label: providerSummary, systemImage: "brain.head.profile", color: modelColor(providerSummary))
                .frame(maxWidth: 230)

            Button {
                viewModel.refreshAgentWorkspace()
            } label: {
                Label("刷新", systemImage: "arrow.clockwise")
            }
            .buttonStyle(ResearchSecondaryButtonStyle())
            .controlSize(.small)
        }
        .padding(14)
        .background(RadarTheme.heroGradient)
        .researchPanel(glow: true)
    }

    private func daemonColor(_ label: String) -> Color {
        label.contains("未连接") ? RadarTheme.gold : RadarTheme.green
    }

    private func modelColor(_ label: String) -> Color {
        label.contains("缺少") || label.contains("未配置") ? RadarTheme.gold : RadarTheme.green
    }

    private var daemonSummary: String {
        AgentWorkspaceV2Copy.daemonSummary(viewModel.agentDaemonStatus)
    }

    private var providerSummary: String {
        AgentWorkspaceV2Copy.providerSummary(viewModel.agentDaemonStatus)
    }
}

private struct AgentLeftRail: View {
    @ObservedObject var viewModel: DashboardViewModel
    let thread: AgentThreadState
    let collapsed: Bool
    let toggleCollapsed: () -> Void
    @State private var renamingSessionID: String?
    @State private var titleDraft = ""

    var body: some View {
        VStack(alignment: collapsed ? .center : .leading, spacing: 12) {
            HStack {
                if !collapsed {
                    Text("Agent")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Spacer()
                }
                Button(action: toggleCollapsed) {
                    Image(systemName: collapsed ? "sidebar.right" : "sidebar.left")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .frame(width: 30, height: 30)
                        .background(RadarTheme.tintSoft)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
                .buttonStyle(.plain)
            }

            if collapsed {
                CollapsedRailButton(icon: "bubble.left.and.text.bubble.right", selected: viewModel.selectedAgentSessionID != nil, action: toggleCollapsed)
            } else {
                RailSection(title: "Sessions", trailing: "\(viewModel.agentSessions.count)") {
                    if viewModel.agentSessions.isEmpty {
                        AgentSmallEmpty(text: "输入任务后会自动创建对话；历史任务会出现在这里。")
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 7) {
                                ForEach(viewModel.agentSessions) { session in
                                    AgentSessionRailRow(
                                        viewModel: viewModel,
                                        session: session,
                                        selected: viewModel.selectedAgentSessionID == session.sessionID,
                                        renamingSessionID: $renamingSessionID,
                                        titleDraft: $titleDraft
                                    )
                                }
                            }
                        }
                        .scrollIndicators(.hidden)
                    }
                }
            }

            Spacer(minLength: 0)
        }
        .padding(12)
        .researchPanel()
    }
}

private struct AgentAbilityPackage: Identifiable, Hashable {
    enum Kind: Hashable {
        case skill
        case extensionPackage
    }

    let id: String
    let title: String
    let description: String
    let status: String
    let selected: Bool
    let kind: Kind

    var kindLabel: String {
        switch kind {
        case .skill:
            return "能力"
        case .extensionPackage:
            return "扩展"
        }
    }

    @MainActor
    static func packages(from viewModel: DashboardViewModel) -> [AgentAbilityPackage] {
        let skills = viewModel.agentSkills.map { skill in
            AgentAbilityPackage(
                id: skill.skillID,
                title: skill.title,
                description: skill.permissionSummary ?? skill.description,
                status: skill.status,
                selected: viewModel.selectedAgentSkillIDs.contains(skill.skillID),
                kind: .skill
            )
        }
        let extensions = viewModel.agentExtensions.map { item in
            AgentAbilityPackage(
                id: item.extensionID,
                title: item.title,
                description: item.permissionSummary ?? item.description,
                status: item.status,
                selected: viewModel.selectedAgentExtensionIDs.contains(item.extensionID),
                kind: .extensionPackage
            )
        }
        return skills + extensions
    }
}

private struct AgentAbilityToggleRow: View {
    let ability: AgentAbilityPackage
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: ability.selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ability.selected ? RadarTheme.blue : RadarTheme.mutedText)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(ability.title)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                            .lineLimit(1)
                        Text(ability.kindLabel)
                            .font(.system(size: 8, weight: .medium))
                            .foregroundStyle(RadarTheme.mutedText)
                    }
                    Text(ability.description)
                        .font(.system(size: 9))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .railRow(selected: ability.selected)
        }
        .buttonStyle(.plain)
    }
}

private struct CollapsedRailButton: View {
    let icon: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(selected ? RadarTheme.blue : RadarTheme.secondaryText)
                .frame(width: 34, height: 34)
                .background(selected ? RadarTheme.tintStrong : RadarTheme.tintFaint)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

private struct AgentSessionRailRow: View {
    @ObservedObject var viewModel: DashboardViewModel
    let session: AgentSession
    let selected: Bool
    @Binding var renamingSessionID: String?
    @Binding var titleDraft: String

    private var isRenaming: Bool {
        renamingSessionID == session.sessionID
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if isRenaming {
                HStack(spacing: 6) {
                    TextField("会话名称", text: $titleDraft)
                        .textFieldStyle(.plain)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .onSubmit(commitRename)

                    Button(action: commitRename) {
                        Image(systemName: "checkmark")
                            .font(.system(size: 10, weight: .bold))
                    }
                    .buttonStyle(.plain)

                    Button(action: cancelRename) {
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .bold))
                    }
                    .buttonStyle(.plain)
                }
            } else {
                HStack(alignment: .top, spacing: 7) {
                    Button(action: { viewModel.selectAgentSession(session.sessionID) }) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(session.title)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                                .lineLimit(2)
                            Text("\(RuntimeStatusPresenter.label(session.status)) · \(shortRun(session.activeRunID))")
                                .font(.system(size: 9))
                                .foregroundStyle(RadarTheme.secondaryText)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)

                    Button(action: beginRename) {
                        Image(systemName: "pencil")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(RadarTheme.mutedText)
                            .frame(width: 22, height: 22)
                            .background(RadarTheme.tintFaint)
                            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .railRow(selected: selected)
        .contextMenu {
            Button("重命名") {
                beginRename()
            }
        }
    }

    private func beginRename() {
        renamingSessionID = session.sessionID
        titleDraft = session.title
    }

    private func commitRename() {
        viewModel.renameAgentSession(session.sessionID, title: titleDraft)
        renamingSessionID = nil
        titleDraft = ""
    }

    private func cancelRename() {
        renamingSessionID = nil
        titleDraft = ""
    }

    private func shortRun(_ runID: String?) -> String {
        guard let runID else { return "未开始" }
        return String(runID.replacingOccurrences(of: "run-", with: "").prefix(8))
    }
}

private struct AgentThreadWorkspace: View {
    @ObservedObject var viewModel: DashboardViewModel
    let thread: AgentThreadState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(thread.title == "Agent 工作空间" ? "Agent" : thread.title)
                        .font(RadarFont.display(20, .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(1)
                    Text("描述任务，选择能力包，Agent 会在本地写入记录。")
                        .font(.system(size: 12))
                        .foregroundStyle(RadarTheme.mutedText)
                        .lineLimit(1)
                }
                Spacer()
                Button("详情") {
                    if let event = viewModel.agentStreamEvents.last {
                        viewModel.selectAgentInspector(.event(event.eventID))
                    } else {
                        viewModel.selectAgentInspector(.policy("agent-boundary"))
                    }
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider()
                .overlay(RadarTheme.borderSoft)

            // VSplitView: drag the divider to trade height between the message stream and
            // the composer (e.g. give the input box more room for a long prompt).
            VSplitView {
                ScrollViewReader { proxy in
                    ScrollView {
                        // Lazy: only visible message rows render — keeps long threads smooth.
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if thread.messages.isEmpty {
                                AgentEmptyStateTemplates(viewModel: viewModel, templates: thread.availableTemplates)
                                    .frame(maxWidth: .infinity, alignment: .topLeading)
                            } else {
                                AgentTaskTemplateStrip(viewModel: viewModel, templates: thread.availableTemplates)
                            }

                            ForEach(thread.messages) { message in
                                AgentThreadMessageRow(
                                    viewModel: viewModel,
                                    message: message,
                                    isRunning: thread.status == .running && message.id == thread.messages.last?.id
                                )
                                    .id(message.id)
                                    .transition(.asymmetric(
                                        insertion: .opacity.combined(with: .offset(y: 12)),
                                        removal: .opacity
                                    ))
                            }
                            Color.clear.frame(height: 1).id("threadBottom")
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .animation(RadarMotion.spring, value: thread.messages.count)
                    }
                    .onChange(of: thread.messages.count) { _, _ in
                        withAnimation(RadarMotion.gentle) { proxy.scrollTo("threadBottom", anchor: .bottom) }
                    }
                    .onChange(of: thread.run.eventCount) { _, _ in
                        withAnimation(RadarMotion.gentle) { proxy.scrollTo("threadBottom", anchor: .bottom) }
                    }
                }
                .frame(minHeight: 200, maxHeight: .infinity)

                VStack(spacing: 0) {
                    AgentRunInlineStatus(thread: thread)
                        .padding(.horizontal, 12)
                        .padding(.top, 10)
                    AgentComposerBar(viewModel: viewModel, thread: thread)
                        .padding(12)
                }
                .frame(minHeight: 150, idealHeight: 198, maxHeight: 480)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .layoutPriority(1)
        }
        .researchPanel()
        .frame(maxHeight: .infinity)
    }
}

private struct AgentRunInlineStatus: View {
    let thread: AgentThreadState

    var body: some View {
        HStack(spacing: 8) {
            StatusDot(color: AgentUIStyle.runColor(thread.run.status), pulsing: thread.run.status == .running)
            Text(thread.run.latestStep)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(1)
            Text(thread.run.latestDetail)
                .font(.system(size: 11))
                .foregroundStyle(RadarTheme.mutedText)
                .lineLimit(1)
            Spacer()
            Text("\(thread.run.eventCount) 个事件")
                .font(.system(size: 10, design: .rounded))
                .foregroundStyle(RadarTheme.mutedText)
                .contentTransition(.numericText())
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(RadarTheme.tintFaint)
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .animation(RadarMotion.snappy, value: thread.run.eventCount)
    }
}

private struct AgentEmptyStateTemplates: View {
    @ObservedObject var viewModel: DashboardViewModel
    let templates: [AgentTaskTemplate]
    @State private var previewIndex = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("把任务交给 Agent")
                    .font(RadarFont.display(22, .bold))
                    .foregroundStyle(RadarTheme.primaryText)
                Text("描述目标，也可以先选择模板、图片、能力包和上下文。模板只会填充输入框，不会自动执行。")
                    .font(.system(size: 12))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }

            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(templates) { template in
                    Button(action: { viewModel.applyAgentTemplate(template) }) {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: template.icon)
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(RadarTheme.blue)
                                .frame(width: 24, height: 24)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(template.title)
                                    .font(.system(size: 12.5, weight: .semibold))
                                    .foregroundStyle(RadarTheme.primaryText)
                                    .lineLimit(2)
                                Text(template.subtitle)
                                    .font(.system(size: 10.5))
                                    .foregroundStyle(RadarTheme.secondaryText)
                                    .lineLimit(2)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(13)
                        .frame(maxWidth: .infinity, minHeight: 78, alignment: .topLeading)
                        .interactiveCard(cornerRadius: 13, hoverScale: 1.012)
                    }
                    .buttonStyle(.plain)
                }
            }

            strategyPreview
        }
    }

    /// Preview of the structured strategy result card (sample data). Lets the user see the
    /// workbench output before a live CMC run; tapping opens the inspector.
    @ViewBuilder
    private var strategyPreview: some View {
        let previews = viewModel.agentStrategyPreviews
        if previews.indices.contains(previewIndex) {
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Text("策略结果卡预览")
                        .font(RadarFont.text(13, .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Spacer()
                    Text("样例数据 · 运行 CMC 能力包后替换为真实结果")
                        .font(.system(size: 10))
                        .foregroundStyle(RadarTheme.mutedText)
                }
                Picker("preview", selection: $previewIndex) {
                    Text("Alpha").tag(0)
                    Text("Perp").tag(1)
                    Text("Macro").tag(2)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .frame(width: 260)

                let result = previews[previewIndex]
                StrategyResultCard(result: result, onInspect: {
                    viewModel.selectAgentInspector(.strategyResult(result.id))
                })
                .id(previewIndex)
                .transition(.opacity.combined(with: .offset(y: 8)))
            }
            .padding(.top, 6)
            .animation(RadarMotion.smooth, value: previewIndex)
        }
    }
}

private struct AgentTaskTemplateStrip: View {
    @ObservedObject var viewModel: DashboardViewModel
    let templates: [AgentTaskTemplate]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(templates) { template in
                    Button(action: { viewModel.applyAgentTemplate(template) }) {
                        Label(template.title, systemImage: template.icon)
                        .font(.system(size: 10, weight: .semibold))
                        .lineLimit(1)
                        .foregroundStyle(RadarTheme.secondaryText)
                        .researchCapsule()
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct AgentThreadMessageRow: View {
    @ObservedObject var viewModel: DashboardViewModel
    let message: AgentThreadMessage
    var isRunning: Bool = false
    /// nil = follow run state (expanded while running, collapsed when done); set by user tap.
    @State private var processExpandedOverride: Bool? = nil

    var body: some View {
        let isUser = message.role == .user
        HStack(alignment: .top) {
            if isUser { Spacer(minLength: 48) }
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    Text(message.displayName)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(isUser ? RadarTheme.blue : RadarTheme.green)
                    Text(message.createdAt)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(RadarTheme.mutedText)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }

                if isUser {
                    ForEach(message.parts) { part in
                        AgentMessagePartView(viewModel: viewModel, part: part)
                    }
                } else {
                    assistantBody
                }
            }
            .padding(12)
            .frame(maxWidth: isUser ? 560 : .infinity, alignment: .leading)
            .background(isUser ? RadarTheme.panelElevated.opacity(0.72) : RadarTheme.panelElevated.opacity(0.42))
            .researchPanel(glow: hasConclusion)
            if !isUser { Spacer(minLength: 36) }
        }
    }

    // Conclusions / actions surface first; plan + tool-call steps collapse into 执行过程.
    @ViewBuilder
    private var assistantBody: some View {
        let outcome = message.parts.filter { !isProcessPart($0) }
        let process = message.parts.filter(isProcessPart)
        let expanded = processExpandedOverride ?? isRunning

        if outcome.isEmpty && !process.isEmpty {
            HStack(spacing: 7) {
                Image(systemName: "checkmark.seal")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(RadarTheme.secondaryText)
                Text("已整理执行步骤；展开「执行过程」查看，或配置模型 Key 后生成文本结论。")
                    .font(.system(size: 12))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            ForEach(outcome) { part in
                AgentMessagePartView(viewModel: viewModel, part: part)
            }
        }

        if !process.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    withAnimation(RadarMotion.snappy) { processExpandedOverride = !expanded }
                } label: {
                    HStack(spacing: 7) {
                        if isRunning {
                            StatusDot(color: RadarTheme.blue, size: 6, pulsing: true)
                        } else {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .bold))
                                .rotationEffect(.degrees(expanded ? 90 : 0))
                        }
                        Image(systemName: "list.bullet.indent")
                            .font(.system(size: 10, weight: .semibold))
                        Text(isRunning ? "执行过程 · 进行中" : "执行过程 · \(process.count) 步")
                            .font(.system(size: 11, weight: .semibold))
                        Spacer(minLength: 0)
                        Text(expanded ? "收起" : "展开")
                            .font(.system(size: 10))
                            .foregroundStyle(RadarTheme.mutedText)
                    }
                    .foregroundStyle(RadarTheme.secondaryText)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(RadarTheme.tintFaint)
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
                .buttonStyle(.plain)

                if expanded {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(process) { part in
                            AgentMessagePartView(viewModel: viewModel, part: part)
                        }
                    }
                    .padding(.leading, 4)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    private var hasConclusion: Bool {
        message.parts.contains { part in
            switch part {
            case .finalOutput, .strategyResult: return true
            default: return false
            }
        }
    }

    /// Process = the "thinking / steps": plan summary, tool/capability calls, evidence chips,
    /// and the deterministic plan-dump text. Outcome = strategy cards, final output, approval
    /// requests, attachments, errors, and substantive model text.
    private func isProcessPart(_ part: AgentMessagePart) -> Bool {
        switch part {
        case .planSummary, .capabilityCall, .evidence, .finalOutput:
            // finalOutput here is just an artifact/record pointer ("结果已保存到…json"); it
            // belongs in the collapsible process, not as a competing conclusion.
            return true
        case .text(_, let text):
            return isPlanDump(text)
        default:
            return false
        }
    }

    private func isPlanDump(_ text: String) -> Bool {
        text.contains("Agent Runtime Host") || text.contains("已选择 Skill") || text.hasPrefix("我已通过本地")
    }
}

private struct AgentMessagePartView: View {
    @ObservedObject var viewModel: DashboardViewModel
    let part: AgentMessagePart

    var body: some View {
        switch part {
        case .planSummary(_, let title, let summary, let evidenceRefs):
            AgentPlanSummaryBlock(text: "\(title)\n\(summary)", evidenceRefs: evidenceRefs)
        case .capabilityCall(let call):
            CapabilityCallCard(viewModel: viewModel, call: call)
        case .approvalRequest(let approval):
            ActionApprovalCard(viewModel: viewModel, approval: approval, call: nil)
        case .attachment(_, _, _, let attachment):
            AttachmentInlineCard(viewModel: viewModel, attachment: attachment)
        case .evidence(let chip):
            EvidenceSourceChips(chips: [chip], action: { chip in
                viewModel.selectAgentInspector(.context(chip.id))
            })
        case .strategyResult(let result):
            StrategyResultCard(result: result, onInspect: {
                viewModel.selectAgentInspector(.strategyResult(result.id))
            })
        case .finalOutput(_, let title, let summary, let artifactPath):
            FinalOutputCard(text: "\(title)\n\(summary)", artifactPath: artifactPath, action: { path in
                viewModel.selectAgentInspector(.artifact(path))
            })
        case .error(_, let title, let message):
            AgentErrorBlock(text: "\(title)：\(message)")
        case .text(_, let text):
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(RadarTheme.primaryText)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct AgentPlanSummaryBlock: View {
    let text: String
    let evidenceRefs: [AgentContextChip]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("计划摘要", systemImage: "list.bullet.clipboard")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(RadarTheme.green)
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(RadarTheme.primaryText)
                .fixedSize(horizontal: false, vertical: true)
            if !evidenceRefs.isEmpty {
                EvidenceSourceChips(chips: evidenceRefs, action: { _ in })
            }
        }
    }
}

private struct CapabilityCallCard: View {
    @ObservedObject var viewModel: DashboardViewModel
    let call: CapabilityCallState
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: { viewModel.selectAgentInspector(.toolCall(call.id)) }) {
                HStack(spacing: 8) {
                    AgentStatusDot(color: AgentUIStyle.capabilityColor(call.status))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(call.displayName)
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(RadarTheme.primaryText)
                            .lineLimit(1)
                        Text(call.summary)
                            .font(.system(size: 10))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .lineLimit(2)
                    }
                    Spacer()
                    Text(AgentWorkspaceV2Copy.statusLabel(call.status))
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(AgentUIStyle.capabilityColor(call.status))
                }
            }
            .buttonStyle(.plain)

            Button(action: { withAnimation(RadarMotion.snappy) { expanded.toggle() } }) {
                Label(expanded ? "收起记录" : "查看记录", systemImage: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .symbolEffect(.bounce, value: expanded)
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 5) {
                    InspectorRow(label: "权限", value: call.permissionLabel)
                    InspectorRow(label: "输入", value: call.inputsSummary)
                    InspectorRow(label: "输出", value: call.outputSummary)
                    ForEach(call.artifactRefs, id: \.self) { artifact in
                        let artifactText = artifact.path ?? artifact.label
                        Button(action: { viewModel.selectAgentInspector(.artifact(artifactText)) }) {
                            InspectorRow(label: "记录", value: artifactText)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RadarTheme.tintFaint)
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(11)
        .background(RadarTheme.tintSoft)
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

private struct ActionApprovalCard: View {
    @ObservedObject var viewModel: DashboardViewModel
    let approval: AgentApprovalState
    let call: CapabilityCallState?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: approval.status == .blocked ? "hand.raised.fill" : "checkmark.shield.fill")
                    .foregroundStyle(approval.status == .blocked ? RadarTheme.red : RadarTheme.gold)
                Text(approval.title)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
            }
            InspectorRow(label: "动作", value: approval.displayName)
            InspectorRow(label: "读取/写入", value: approval.dataBoundary)
            InspectorRow(label: "外发", value: approval.outboundBoundary)
            InspectorRow(label: "原因", value: approval.reason)
            InspectorRow(label: "拒绝后", value: approval.rejectionFallback)

            HStack(spacing: 8) {
                Button("查看边界") {
                    viewModel.selectAgentInspector(.policy(approval.id))
                }
                Button("拒绝") {
                    viewModel.selectAgentInspector(.policy(approval.id))
                }
                .disabled(approval.status == .blocked)
                if let call {
                    Button("查看能力") {
                        viewModel.selectAgentInspector(.toolCall(call.id))
                    }
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(10)
        .background((approval.status == .blocked ? RadarTheme.red : RadarTheme.gold).opacity(0.09))
        .overlay(
            RoundedRectangle(cornerRadius: 7)
                .stroke((approval.status == .blocked ? RadarTheme.red : RadarTheme.gold).opacity(0.55), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 7))
    }
}

private struct AttachmentInlineCard: View {
    @ObservedObject var viewModel: DashboardViewModel
    let attachment: AgentAttachment

    var body: some View {
        Button(action: { viewModel.selectAgentInspector(.attachment(attachment.attachmentID)) }) {
            HStack(spacing: 8) {
                Image(systemName: "photo")
                    .foregroundStyle(RadarTheme.blue)
                VStack(alignment: .leading, spacing: 3) {
                    Text(attachment.fileName)
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(1)
                    Text("\(attachment.mimeType) · sha256 \(attachment.sha256.prefix(10))")
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(1)
                }
                Spacer()
            }
            .padding(10)
            .background(RadarTheme.tintSoft)
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

private struct FinalOutputCard: View {
    let text: String
    let artifactPath: String?
    let action: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("结果", systemImage: "checkmark.seal")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(RadarTheme.green)
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(RadarTheme.primaryText)
                .fixedSize(horizontal: false, vertical: true)
            if let artifactPath {
                Button(action: { action(artifactPath) }) {
                    Label("查看记录文件", systemImage: "doc.text.magnifyingglass")
                        .font(.system(size: 10, weight: .semibold))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding(10)
        .background(RadarTheme.green.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 7))
    }
}

private struct AgentErrorBlock: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(RadarTheme.red)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct EvidenceSourceChips: View {
    let chips: [AgentContextChip]
    let action: (AgentContextChip) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(chips) { chip in
                    Button(action: { action(chip) }) {
                        AgentContextChipView(chip: chip, compact: true)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct AgentComposerBar: View {
    @ObservedObject var viewModel: DashboardViewModel
    let thread: AgentThreadState
    @State private var abilityPalettePresented = false
    @State private var abilitySearch = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if !viewModel.agentContextChips.isEmpty {
                ContextChipBar(chips: viewModel.agentContextChips) { chip in
                    viewModel.selectAgentInspector(.context(chip.id))
                }
            }

            if !viewModel.agentAttachments.isEmpty {
                AttachmentStrip(viewModel: viewModel, attachments: viewModel.agentAttachments)
            }

            SelectedAbilityChipBar(viewModel: viewModel) {
                abilityPalettePresented = true
            }

            VStack(alignment: .leading, spacing: 8) {
                TextEditor(text: $viewModel.agentPrompt)
                    .font(.system(size: 13))
                    .scrollContentBackground(.hidden)
                    .foregroundStyle(RadarTheme.primaryText)
                    .focused($composerFocused)
                    .frame(minHeight: 82, maxHeight: 130)
                    .padding(8)
                    .background(RadarTheme.panelElevated.opacity(composerFocused ? 0.75 : 0.62))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(composerFocused ? RadarTheme.blue.opacity(0.5) : RadarTheme.borderSoft, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(alignment: .topLeading) {
                        if viewModel.agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text("描述任务，输入 /add 添加能力…")
                                .font(.system(size: 13))
                                .foregroundStyle(RadarTheme.mutedText)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 14)
                                .allowsHitTesting(false)
                        }
                    }
                    .animation(RadarMotion.snappy, value: composerFocused)

                HStack(spacing: 8) {
                    Button(action: {
                        abilityPalettePresented = true
                    }) {
                        Label("Add", systemImage: "plus")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    .popover(isPresented: $abilityPalettePresented, arrowEdge: .bottom) {
                        AbilityPaletteView(
                            viewModel: viewModel,
                            searchText: $abilitySearch,
                            close: { abilityPalettePresented = false }
                        )
                        .frame(width: 360, height: 420)
                        .padding(12)
                    }

                    Button(action: { viewModel.pickAgentImageAttachment() }) {
                        Label("图片", systemImage: "photo.badge.plus")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())

                    Button(action: { viewModel.clearAgentAttachments() }) {
                        Label("清空附件", systemImage: "xmark.circle")
                    }
                    .disabled(viewModel.agentAttachments.isEmpty)
                    .buttonStyle(ResearchSecondaryButtonStyle())

                    Spacer()

                    Text(userStatus(viewModel.agentSubmitStatus))
                        .font(.system(size: 10))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(1)

                    Button(action: { viewModel.submitAgentPrompt() }) {
                        Label("开始任务", systemImage: "arrow.up.circle.fill")
                    }
                    .buttonStyle(ResearchPrimaryButtonStyle())
                    .controlSize(.small)
                    .disabled(viewModel.agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .controlSize(.small)
            }
        }
        .onChange(of: viewModel.agentPrompt) { _, newValue in
            if shouldOpenAbilityPalette(from: newValue) {
                abilityPalettePresented = true
            }
        }
    }

    private func shouldOpenAbilityPalette(from prompt: String) -> Bool {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed == "/add" || trimmed == "add" || trimmed.hasSuffix(" /add") || trimmed.hasSuffix(" add")
    }

    private func userStatus(_ raw: String) -> String {
        if raw.contains("daemon_unavailable") {
            return "后台服务未连接"
        }
        if raw.contains("attachment_ready") {
            return "图片已加入任务"
        }
        if raw.contains("draft_ready") {
            return "模板已填入输入框"
        }
        if raw.contains("submitting") {
            return "正在交给 Agent"
        }
        if raw.contains("run_completed") {
            return "任务记录已生成"
        }
        if raw.contains("prompt_empty") {
            return "请先描述任务"
        }
        return raw.replacingOccurrences(of: "_", with: " ")
    }
}

private struct SelectedAbilityChipBar: View {
    @ObservedObject var viewModel: DashboardViewModel
    let openPalette: () -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                Button(action: openPalette) {
                    Label("能力", systemImage: "square.stack.3d.up")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .researchCapsule()
                }
                .buttonStyle(.plain)

                ForEach(selectedAbilities) { ability in
                    Button(action: { toggle(ability) }) {
                        HStack(spacing: 5) {
                            Image(systemName: "checkmark.circle.fill")
                            Text(ability.title)
                                .lineLimit(1)
                        }
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(RadarTheme.blue)
                        .researchCapsule(active: true)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var selectedAbilities: [AgentAbilityPackage] {
        AgentAbilityPackage.packages(from: viewModel).filter(\.selected)
    }

    private func toggle(_ ability: AgentAbilityPackage) {
        switch ability.kind {
        case .skill:
            viewModel.toggleAgentSkill(ability.id)
        case .extensionPackage:
            viewModel.toggleAgentExtension(ability.id)
        }
        clearAddCommandToken()
    }

    private func clearAddCommandToken() {
        let prompt = viewModel.agentPrompt
        let lowercased = prompt.lowercased()
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == "/add" || trimmed.lowercased() == "add" {
            viewModel.agentPrompt = ""
            return
        }
        if lowercased.hasSuffix(" /add") {
            viewModel.agentPrompt = String(prompt.dropLast(5)).trimmingCharacters(in: .whitespacesAndNewlines)
            return
        }
        if lowercased.hasSuffix(" add") {
            viewModel.agentPrompt = String(prompt.dropLast(4)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}

private struct AbilityPaletteView: View {
    @ObservedObject var viewModel: DashboardViewModel
    @Binding var searchText: String
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("添加能力")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Text("勾选后会随本次任务一起发送")
                        .font(.system(size: 11))
                        .foregroundStyle(RadarTheme.mutedText)
                }
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .frame(width: 26, height: 26)
                        .background(RadarTheme.tintSoft)
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(RadarTheme.mutedText)
                TextField("搜索能力包…", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
            }
            .padding(10)
            .background(RadarTheme.tintSoft)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(filteredAbilities) { ability in
                        AgentAbilityToggleRow(ability: ability) {
                            toggle(ability)
                        }
                    }
                }
            }
        }
        .background(.ultraThinMaterial)
    }

    private var filteredAbilities: [AgentAbilityPackage] {
        let packages = AgentAbilityPackage.packages(from: viewModel)
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return packages }
        return packages.filter {
            $0.title.lowercased().contains(query) ||
                $0.description.lowercased().contains(query) ||
                $0.kindLabel.lowercased().contains(query)
        }
    }

    private func toggle(_ ability: AgentAbilityPackage) {
        switch ability.kind {
        case .skill:
            viewModel.toggleAgentSkill(ability.id)
        case .extensionPackage:
            viewModel.toggleAgentExtension(ability.id)
        }
    }
}

private struct SkillChipPicker: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(viewModel.agentSkills) { skill in
                    let selected = viewModel.selectedAgentSkillIDs.contains(skill.skillID)
                    Button(action: { viewModel.toggleAgentSkill(skill.skillID) }) {
                        HStack(spacing: 5) {
                            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                            Text(skill.title)
                                .lineLimit(1)
                        }
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(selected ? RadarTheme.green : RadarTheme.secondaryText)
                        .researchCapsule(active: selected)
                    }
                    .buttonStyle(.plain)
                }
                ForEach(viewModel.agentExtensions) { item in
                    let selected = viewModel.selectedAgentExtensionIDs.contains(item.extensionID)
                    Button(action: { viewModel.toggleAgentExtension(item.extensionID) }) {
                        HStack(spacing: 5) {
                            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                            Text(item.title)
                                .lineLimit(1)
                        }
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(selected ? RadarTheme.green : RadarTheme.secondaryText)
                        .researchCapsule(active: selected)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct ContextChipBar: View {
    let chips: [AgentContextChip]
    let action: (AgentContextChip) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                Text("上下文")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(RadarTheme.mutedText)
                ForEach(chips) { chip in
                    Button(action: { action(chip) }) {
                        AgentContextChipView(chip: chip, compact: true)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct AttachmentStrip: View {
    @ObservedObject var viewModel: DashboardViewModel
    let attachments: [AgentAttachment]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                Text("图片")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(RadarTheme.mutedText)
                ForEach(attachments) { attachment in
                    Button(action: { viewModel.selectAgentInspector(.attachment(attachment.attachmentID)) }) {
                        HStack(spacing: 6) {
                            Image(systemName: "photo")
                            Text(attachment.fileName)
                                .lineLimit(1)
                            Text(attachment.sha256.prefix(8))
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(RadarTheme.mutedText)
                        }
                        .font(.system(size: 10, weight: .semibold))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .background(RadarTheme.blue.opacity(0.12))
                        .foregroundStyle(RadarTheme.blue)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct AgentInspectorV2Panel: View {
    @ObservedObject var viewModel: DashboardViewModel
    let thread: AgentThreadState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                ResearchSectionEyebrow(text: "Inspector", icon: "sidebar.right")
                Spacer()
                Text(inspectorTitle)
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(RadarTheme.mutedText)
            }

            switch viewModel.selectedAgentInspector {
            case .overview:
                overview
            case .message(let id):
                if let message = thread.messages.first(where: { $0.id == id }) {
                    messageInspector(message)
                } else {
                    overview
                }
            case .toolCall(let id):
                if let call = toolCall(id) {
                    toolInspector(call)
                } else {
                    overview
                }
            case .attachment(let id):
                if let attachment = attachment(id) {
                    attachmentInspector(attachment)
                } else {
                    overview
                }
            case .event(let id):
                if let event = viewModel.agentStreamEvents.first(where: { $0.eventID == id }) {
                    eventInspector(event)
                } else {
                    overview
                }
            case .policy(let id):
                policyInspector(id)
            case .artifact(let path):
                artifactInspector(path)
            case .task(let id):
                if let task = viewModel.agentTasks.first(where: { $0.taskID == id }) {
                    taskInspector(task)
                } else {
                    overview
                }
            case .context(let id):
                if let chip = viewModel.agentContextChips.first(where: { $0.id == id }) {
                    contextInspector(chip)
                } else {
                    overview
                }
            case .strategyResult(let id):
                if let result = viewModel.strategyResult(id: id) {
                    StrategyInspectorView(result: result)
                } else {
                    overview
                }
            }

            Spacer(minLength: 0)
        }
        .animation(RadarMotion.smooth, value: viewModel.selectedAgentInspector)
        .padding(12)
        .researchPanel()
    }

    private var inspectorTitle: String {
        switch viewModel.selectedAgentInspector {
        case .overview:
            return "总览"
        case .message:
            return "消息"
        case .toolCall:
            return "能力"
        case .attachment:
            return "图片"
        case .event:
            return "事件"
        case .policy:
            return "边界"
        case .artifact:
            return "记录"
        case .task:
            return "任务"
        case .context:
            return "上下文"
        case .strategyResult:
            return "策略复核"
        }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 10) {
            InspectorSection(title: "当前任务", rows: [
                ("标题", thread.title),
                ("状态", thread.statusText),
                ("执行记录", AgentWorkspaceV2Copy.runDisplay(thread.compactRunState.runID)),
                ("阶段", AgentWorkspaceStateAdapter.stageLabel(thread.runManifest?.currentStage ?? thread.controlSummary?.stage ?? "idle")),
                ("上下文", thread.contextSummary.map { "\($0.sourceCount) 项 / \($0.chunkCount) 段" } ?? "--"),
                ("风险", thread.controlSummary.map { $0.blockedPolicyCount > 0 ? "有阻断项" : "边界正常" } ?? "--"),
                ("事件数", "\(thread.compactRunState.eventCount)")
            ])

            InspectorSection(title: "后台服务", rows: [
                ("连接", AgentWorkspaceV2Copy.daemonSummary(viewModel.agentDaemonStatus)),
                ("AI 模型", AgentWorkspaceV2Copy.providerSummary(viewModel.agentDaemonStatus)),
                ("提交状态", viewModel.agentSubmitStatus)
            ])

            InspectorSection(title: "安全边界", rows: [
                ("真实微信", RuntimeStatusPresenter.label(viewModel.agentDaemonStatus.policy?["liveWechat"] ?? "blocked")),
                ("微信 CLI", RuntimeStatusPresenter.label(viewModel.agentDaemonStatus.policy?["liveWechatCLI"] ?? "blocked")),
                ("交易/转账", RuntimeStatusPresenter.label(viewModel.agentDaemonStatus.policy?["trade"] ?? "blocked")),
                ("电脑操作", RuntimeStatusPresenter.label(viewModel.agentDaemonStatus.policy?["computerUse"] ?? "needs_confirmation"))
            ])
        }
    }

    private func messageInspector(_ message: AgentThreadMessage) -> some View {
        InspectorSection(title: "消息", rows: [
            ("角色", message.displayName),
            ("时间", message.createdAt),
            ("内容块", "\(message.parts.count)"),
            ("记录", message.linkedArtifacts.first?.path ?? message.linkedArtifacts.first?.label ?? "--")
        ])
    }

    private func toolInspector(_ call: CapabilityCallState) -> some View {
        InspectorSection(title: "能力调用", rows: [
            ("能力", call.displayName),
            ("状态", AgentWorkspaceV2Copy.statusLabel(call.status)),
            ("权限", call.permissionLabel),
            ("输入", call.inputsSummary),
            ("输出", call.outputSummary),
            ("记录", call.artifactRefs.first?.path ?? call.artifactRefs.first?.label ?? "--")
        ])
    }

    private func attachmentInspector(_ attachment: AgentAttachment) -> some View {
        InspectorSection(title: "图片附件", rows: [
            ("文件", attachment.fileName),
            ("类型", attachment.mimeType),
            ("大小", "\(attachment.sizeBytes) bytes"),
            ("sha256", attachment.sha256),
            ("状态", RuntimeStatusPresenter.label(attachment.status)),
            ("记录", attachment.artifactPath)
        ])
    }

    private func eventInspector(_ event: AgentStreamEvent) -> some View {
        InspectorSection(title: "运行事件", rows: [
            ("类型", event.type),
            ("状态", event.status ?? "--"),
            ("能力", AgentWorkspaceV2Copy.toolName(event.toolName ?? "--")),
            ("说明", event.reason ?? event.errorPreview ?? event.delta ?? "--"),
            ("记录", event.artifactPath ?? "--")
        ])
    }

    private func policyInspector(_ id: String) -> some View {
        InspectorSection(title: "安全边界", rows: [
            ("边界", id),
            ("真实微信", "本机只读已授权（经 wechat-cli），不发送"),
            ("外部动作", "交易、发消息、对外发布保持阻断"),
            ("Computer Use", "只生成申请，不直接控制 Mac"),
            ("密钥", "只读环境变量，不写入记录")
        ])
    }

    private func artifactInspector(_ path: String) -> some View {
        let item = thread.runManifest?.artifacts.first(where: { $0.artifactPath == path })
        return InspectorSection(title: "记录文件", rows: [
            ("路径", path),
            ("类型", item?.kind ?? "--"),
            ("阶段", item?.stage.map(AgentWorkspaceStateAdapter.stageLabel) ?? "--"),
            ("说明", "本地 runtime artifact，可用于复盘和追踪"),
            ("隐私", "不得包含 API key、Authorization header 或真实私聊原文")
        ])
    }

    private func taskInspector(_ task: AgentLongTask) -> some View {
        let selectedSurface = ((task.selectedSkillIDs ?? []) + (task.selectedExtensionIDs ?? []))
        return InspectorSection(title: "长期任务", rows: [
            ("目标", task.prompt),
            ("状态", RuntimeStatusPresenter.label(task.status)),
            ("执行记录", task.runID),
            ("能力", selectedSurface.isEmpty ? "自动判断" : selectedSurface.map(AgentWorkspaceV2Copy.surfaceName).joined(separator: "、")),
            ("记录", task.artifactPath)
        ])
    }

    private func contextInspector(_ chip: AgentContextChip) -> some View {
        InspectorSection(title: "上下文", rows: [
            ("类型", AgentWorkspaceV2Copy.kindName(chip.kind)),
            ("名称", chip.label),
            ("状态", chip.detail),
            ("置信度", chip.confidence.map { String(format: "%.2f", $0) } ?? "--"),
            ("记录", chip.path ?? "--")
        ])
    }

    private func toolCall(_ id: String) -> CapabilityCallState? {
        thread.capabilityCalls.first(where: { $0.id == id })
    }

    private func attachment(_ id: String) -> AgentAttachment? {
        if let pending = viewModel.agentAttachments.first(where: { $0.attachmentID == id }) {
            return pending
        }
        return thread.messages
            .flatMap(\.parts)
            .compactMap { part -> AgentAttachment? in
                if case .attachment(_, _, _, let attachment) = part {
                    return attachment
                }
                return nil
            }
            .first(where: { $0.attachmentID == id })
    }
}

private struct AgentCompactRunBar: View {
    @ObservedObject var viewModel: DashboardViewModel
    let thread: AgentThreadState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                AgentStatusDot(color: AgentUIStyle.runColor(thread.run.status))
                Text(thread.run.displayID)
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(1)
                Text(thread.run.latestStep)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(1)
                Text(thread.run.latestDetail)
                    .font(.system(size: 10))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(1)
                Spacer()
                Text("\(thread.run.eventCount) 个事件")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(RadarTheme.mutedText)
                Button("暂停") { viewModel.pauseSelectedAgentRun() }
                    .disabled(!thread.run.canPause)
                    .buttonStyle(ResearchSecondaryButtonStyle())
                Button("继续") { viewModel.resumeSelectedAgentRun() }
                    .disabled(!thread.run.canResume)
                    .buttonStyle(ResearchSecondaryButtonStyle())
                Button("取消") { viewModel.cancelSelectedAgentRun() }
                    .disabled(!thread.run.canCancel)
                    .buttonStyle(ResearchSecondaryButtonStyle())
                Button(viewModel.agentRunDetailsExpanded ? "收起记录" : "展开记录") {
                    viewModel.toggleAgentRunDetails()
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
            }
            .controlSize(.small)

            if viewModel.agentRunDetailsExpanded {
                LazyVGrid(columns: [
                    GridItem(.flexible(), spacing: 8),
                    GridItem(.flexible(), spacing: 8),
                    GridItem(.flexible(), spacing: 8)
                ], spacing: 8) {
                    ForEach(viewModel.agentStreamEvents.suffix(9)) { event in
                        Button(action: { viewModel.selectAgentInspector(.event(event.eventID)) }) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(AgentWorkspaceV2Copy.toolName(event.toolName ?? event.type))
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(RadarTheme.primaryText)
                                    .lineLimit(1)
                                Text(event.reason ?? event.delta ?? event.errorPreview ?? event.status ?? "--")
                                    .font(.system(size: 9))
                                    .foregroundStyle(RadarTheme.secondaryText)
                                    .lineLimit(2)
                            }
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RadarTheme.panelElevated.opacity(0.5))
                            .researchPanel()
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(10)
        .background(
            LinearGradient(
                colors: [RadarTheme.panel.opacity(0.72), RadarTheme.cyanBase.opacity(0.24), RadarTheme.purpleBase.opacity(0.18)],
                startPoint: .leading,
                endPoint: .trailing
            )
        )
        .researchPanel()
    }
}

private struct RailSection<Content: View>: View {
    let title: String
    let trailing: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(title)
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .tracking(1.2)
                    .foregroundStyle(RadarTheme.mutedText)
                Spacer()
                Text(trailing)
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(RadarTheme.mutedText)
            }
            content
        }
    }
}

private struct AgentSurfaceToggleRow: View {
    let title: String
    let subtitle: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 7) {
                Image(systemName: selected ? "checkmark.square.fill" : "square")
                    .foregroundStyle(selected ? RadarTheme.green : RadarTheme.mutedText)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.system(size: 9))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .railRow(selected: selected)
        }
        .buttonStyle(.plain)
    }
}

private struct AgentContextChipView: View {
    let chip: AgentContextChip
    let compact: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
            VStack(alignment: .leading, spacing: 2) {
                Text(chip.label)
                    .font(.system(size: compact ? 10 : 11, weight: .semibold))
                    .lineLimit(1)
                if !compact {
                    Text(chip.detail)
                        .font(.system(size: 9))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, compact ? 8 : 9)
        .padding(.vertical, compact ? 5 : 7)
        .background(AgentUIStyle.freshnessColor(chip.freshness).opacity(0.13))
        .foregroundStyle(AgentUIStyle.freshnessColor(chip.freshness))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var icon: String {
        switch chip.kind {
        case .token:
            return "bitcoinsign.circle"
        case .message:
            return "message"
        case .crystal:
            return "sparkle.magnifyingglass"
        case .handoff:
            return "doc.text"
        case .evidence:
            return "link"
        default:
            return "tag"
        }
    }
}

private struct AgentStatusPill: View {
    let label: String
    let systemImage: String
    let color: Color

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.system(size: 10, weight: .bold))
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(color.opacity(0.12))
        .foregroundStyle(color)
        .researchCapsule()
    }
}

private struct AgentStatusDot: View {
    let color: Color

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
    }
}

private struct AgentResultMiniRow: View {
    let icon: String
    let label: String
    let count: Int

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(RadarTheme.green)
                .frame(width: 14)
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(RadarTheme.primaryText)
            Spacer()
            Text("\(count)")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(RadarTheme.secondaryText)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(RadarTheme.panelElevated.opacity(0.4))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

private struct AgentSmallEmpty: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 10))
            .foregroundStyle(RadarTheme.secondaryText)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RadarTheme.panelElevated.opacity(0.32))
            .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

private struct InspectorSection: View {
    let title: String
    let rows: [(String, String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ResearchSectionEyebrow(text: title, icon: "square.text.square")
            ForEach(rows, id: \.0) { row in
                InspectorRow(label: row.0, value: row.1)
            }
        }
        .padding(10)
        .researchPanel()
    }
}

private struct InspectorRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label)
                .foregroundStyle(RadarTheme.mutedText)
                .frame(width: 64, alignment: .leading)
            Text(value.isEmpty ? "--" : value)
                .foregroundStyle(RadarTheme.primaryText)
                .lineLimit(3)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .font(.system(size: 10))
    }
}

private enum AgentUIStyle {
    static func threadColor(_ status: AgentThreadStatus) -> Color {
        switch status {
        case .idle, .composing:
            return RadarTheme.secondaryText
        case .running:
            return RadarTheme.blue
        case .waitingForApproval:
            return RadarTheme.gold
        case .completed:
            return RadarTheme.green
        case .failed:
            return RadarTheme.red
        case .blocked:
            return RadarTheme.red
        case .paused, .cancelled:
            return RadarTheme.secondaryText
        }
    }

    static func capabilityColor(_ status: CapabilityCallDisplayStatus) -> Color {
        switch status {
        case .preparing:
            return RadarTheme.secondaryText
        case .running:
            return RadarTheme.blue
        case .waitingForApproval:
            return RadarTheme.gold
        case .completed:
            return RadarTheme.green
        case .failed, .blocked:
            return RadarTheme.red
        case .cancelled:
            return RadarTheme.secondaryText
        }
    }

    static func runColor(_ status: AgentCompactRunState.Status) -> Color {
        switch status {
        case .idle, .paused, .cancelled:
            return RadarTheme.secondaryText
        case .running:
            return RadarTheme.blue
        case .waitingForApproval:
            return RadarTheme.gold
        case .completed:
            return RadarTheme.green
        case .failed, .blocked:
            return RadarTheme.red
        }
    }

    static func freshnessColor(_ freshness: ProactiveFreshness) -> Color {
        switch freshness {
        case .fresh, .currentRun:
            return RadarTheme.green
        case .fixture, .stale, .degraded:
            return RadarTheme.gold
        case .blocked:
            return RadarTheme.red
        case .notRun, .unknown:
            return RadarTheme.secondaryText
        }
    }

    static func rawStatusColor(_ raw: String) -> Color {
        let value = raw.lowercased()
        if value.contains("blocked") || value.contains("fail") || value.contains("error") {
            return RadarTheme.red
        }
        if value.contains("needs") || value.contains("stale") || value.contains("degraded") || value.contains("confirmation") {
            return RadarTheme.gold
        }
        if value.contains("pass") || value.contains("complete") || value.contains("enabled") || value.contains("ready") || value.contains("local") {
            return RadarTheme.green
        }
        if value.contains("run") {
            return RadarTheme.blue
        }
        return RadarTheme.secondaryText
    }
}

private enum AgentWorkspaceV2Copy {
    static func runDisplay(_ runID: String?) -> String {
        guard let runID, !runID.isEmpty else {
            return "未开始"
        }
        let cleaned = runID.replacingOccurrences(of: "run-", with: "")
        return "执行记录 \(cleaned.prefix(8))"
    }

    static func daemonSummary(_ status: AgentDaemonStatus) -> String {
        if let daemon = status.daemon {
            return "后台服务已连接 · 127.0.0.1:\(daemon.port)"
        }
        return status.status == "unavailable" ? "后台服务未连接" : "后台服务 \(RuntimeStatusPresenter.label(status.status))"
    }

    static func providerSummary(_ status: AgentDaemonStatus) -> String {
        if status.providers.isEmpty {
            return "AI 模型未检查"
        }
        let ready = status.providers.filter(\.ready).map { $0.model ?? $0.provider }
        if !ready.isEmpty {
            return "AI 模型可用：\(ready.joined(separator: " / "))"
        }
        let missing = status.providers.flatMap(\.missingEnv).joined(separator: ", ")
        return missing.isEmpty ? "AI 模型未配置" : "AI 模型缺少 \(missing)"
    }

    static func toolName(_ raw: String) -> String {
        switch raw {
        case "wechat.read_normalized_messages":
            return "微信 x 链上情报"
        case "token.resolve_entities":
            return "微信 x 链上情报"
        case "market.read_snapshot":
            return "CMC 市场雷达"
        case "onchain.read_snapshot":
            return "微信 x 链上情报"
        case "crystal.create_or_update":
            return "微信 x 链上情报"
        case "proposal.create":
            return "微信 x 链上情报"
        case "memory.save":
            return "本地记忆"
        case "handoff.write":
            return "交接包生成"
        case "image.analyze_with_kimi":
            return "图片理解"
        case "computer_use.request":
            return "申请电脑操作"
        case "wechat_cli.import_export_file":
            return "WeChatCLI 导出接入"
        case "wechat_cli.live_command":
            return "WeChatCLI 导出接入"
        case "cmc.read_market_evidence":
            return "CMC 市场雷达"
        case "cmc.detect_market_regime":
            return "市场状态复核"
        case "cmc.track_social_price_divergence":
            return "讨论与价格偏离"
        case "cmc.request_mcp_refresh":
            return "CMC Skill Hub"
        default:
            return raw.replacingOccurrences(of: "_", with: " ")
        }
    }

    static func surfaceName(_ raw: String) -> String {
        switch raw {
        case "wechat-onchain-intelligence":
            return "微信 x 链上情报"
        case "cmc-market-radar":
            return "CMC 市场雷达"
        case "market-regime-review":
            return "市场状态复核"
        case "social-price-divergence":
            return "讨论与价格偏离"
        case "image-analysis":
            return "图片理解"
        case "long-task":
            return "长期任务"
        case "handoff-writer":
            return "交接包生成"
        case "wechat-cli-export-bridge":
            return "WeChatCLI 导出接入"
        case "cmc-skill-hub":
            return "CMC Skill Hub"
        case "local-memory":
            return "本地记忆"
        default:
            return raw.replacingOccurrences(of: "-", with: " ")
        }
    }

    static func permissionLabel(_ raw: String) -> String {
        let value = raw.lowercased()
        if value.contains("blocked") {
            return "已阻断"
        }
        if value.contains("needs_confirmation") || value.contains("confirmation") {
            return "需要确认"
        }
        if value.contains("pass") || value.contains("local") {
            return "本地可用"
        }
        return raw.isEmpty ? "未声明" : RuntimeStatusPresenter.label(raw)
    }

    static func statusLabel(_ status: CapabilityCallDisplayStatus) -> String {
        switch status {
        case .preparing:
            return "准备中"
        case .running:
            return "运行中"
        case .waitingForApproval:
            return "等待确认"
        case .completed:
            return "已完成"
        case .failed:
            return "失败"
        case .blocked:
            return "已阻断"
        case .cancelled:
            return "已取消"
        }
    }

    static func kindName(_ kind: RuntimeObjectReferenceKind) -> String {
        switch kind {
        case .evidence:
            return "证据"
        case .message:
            return "微信消息"
        case .token:
            return "Token"
        case .artifact:
            return "记录文件"
        case .marketSnapshot:
            return "行情快照"
        case .onchainSnapshot:
            return "链上快照"
        case .memory:
            return "记忆"
        case .crystal:
            return "情报卡"
        case .proposal:
            return "行动建议"
        case .handoff:
            return "交接包"
        case .session:
            return "对话任务"
        case .task:
            return "长期任务"
        case .alert:
            return "预警"
        case .watchlist:
            return "观察项"
        case .moduleRun:
            return "处理模块"
        case .subagentRun:
            return "子任务"
        case .policyDecision:
            return "安全边界"
        case .source:
            return "数据源"
        }
    }
}

private struct AgentRailRowModifier: ViewModifier {
    let selected: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 9, style: .continuous)
        content
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                shape.fill(
                    selected ? RadarTheme.blue.opacity(0.14)
                        : (hovering ? RadarTheme.tintSoft : RadarTheme.panelElevated.opacity(0.4))
                )
            )
            .overlay(
                shape.strokeBorder(
                    selected ? RadarTheme.blue.opacity(0.5)
                        : (hovering ? RadarTheme.borderStrong : RadarTheme.borderSoft.opacity(0.6)),
                    lineWidth: 1
                )
            )
            .clipShape(shape)
            .animation(RadarMotion.snappy, value: hovering)
            .animation(RadarMotion.spring, value: selected)
            .onHover { hovering = $0 }
    }
}

private extension View {
    func railRow(selected: Bool) -> some View {
        modifier(AgentRailRowModifier(selected: selected))
    }
}
