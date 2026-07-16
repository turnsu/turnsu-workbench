import SwiftUI

struct AgentWorkspaceV2View: View {
    @ObservedObject var viewModel: DashboardViewModel
    @AppStorage("minimalWorkbench.agentRailCollapsed") private var agentRailCollapsed = false
    @AppStorage("minimalWorkbench.phase3QueueCanvasPreferenceMigrated") private var phase3QueueCanvasPreferenceMigrated = false

    var body: some View {
        let thread = viewModel.agentThreadState
        HSplitView {
            AgentLeftRail(
                viewModel: viewModel,
                thread: thread,
                collapsed: agentRailCollapsed,
                toggleCollapsed: { withAnimation(RadarMotion.gentle) { agentRailCollapsed.toggle() } }
            )
            .frame(
                minWidth: agentRailCollapsed ? 64 : 200,
                idealWidth: agentRailCollapsed ? 64 : 300,
                maxWidth: agentRailCollapsed ? 64 : 420,
                maxHeight: .infinity
            )

            AgentThreadWorkspace(viewModel: viewModel, thread: thread)
                .frame(minWidth: 420, idealWidth: 760, maxWidth: .infinity, maxHeight: .infinity)
                .layoutPriority(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(RadarMotion.gentle, value: agentRailCollapsed)
        .onAppear {
            guard !phase3QueueCanvasPreferenceMigrated else { return }
            agentRailCollapsed = false
            phase3QueueCanvasPreferenceMigrated = true
        }
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
                    Text("工作队列")
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
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        AgentQueueSummary(tasks: viewModel.agentTasks)

                        RailSection(title: "QUEUE", trailing: "\(viewModel.agentTasks.count)") {
                            if viewModel.agentTasks.isEmpty {
                                AgentSmallEmpty(text: "暂无排队任务。")
                            } else {
                                LazyVStack(alignment: .leading, spacing: 7) {
                                    ForEach(viewModel.agentTasks.prefix(8)) { task in
                                        AgentTaskQueueRow(
                                            viewModel: viewModel,
                                            task: task,
                                            selected: viewModel.selectedAgentSessionID == task.sessionID
                                        )
                                    }
                                }
                            }
                        }

                        RailSection(title: "SESSIONS", trailing: "\(viewModel.agentSessions.count)") {
                            if viewModel.agentSessions.isEmpty {
                                AgentSmallEmpty(text: "暂无会话。")
                            } else {
                                LazyVStack(alignment: .leading, spacing: 7) {
                                    ForEach(viewModel.agentSessions.prefix(8)) { session in
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
                        }
                    }
                    .padding(.bottom, 4)
                }
                .scrollIndicators(.hidden)
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
    let category: String?

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
                kind: .skill,
                category: skill.category
            )
        }
        let extensions = viewModel.agentExtensions.map { item in
            AgentAbilityPackage(
                id: item.extensionID,
                title: item.title,
                description: item.permissionSummary ?? item.description,
                status: item.status,
                selected: viewModel.selectedAgentExtensionIDs.contains(item.extensionID),
                kind: .extensionPackage,
                category: item.category
            )
        }
        return skills + extensions
    }

    @MainActor
    static func workbenchPackages(from viewModel: DashboardViewModel) -> [AgentAbilityPackage] {
        packages(from: viewModel).filter(\.isWorkbenchVisible)
    }

    var isWorkbenchVisible: Bool {
        let value = "\(id) \(title) \(category ?? "")".lowercased()
        if value.contains("feishu") || value.contains("lark") || title.contains("飞书") {
            return false
        }
        if category?.lowercased() == "channel" {
            return false
        }
        return true
    }

    var domainLabel: String {
        let value = "\(id) \(title) \(category ?? "")".lowercased()
        if value.contains("office") || value.contains("meeting") || value.contains("document") || title.contains("会议") || title.contains("文档") {
            return "Office / Meeting"
        }
        if value.contains("cmc") || value.contains("market") || value.contains("token") || value.contains("wechat") || value.contains("onchain") || value.contains("crypto") || title.contains("市场") || title.contains("链上") || title.contains("微信") {
            return "Web3"
        }
        return "Local"
    }
}

private struct AgentQueueSummary: View {
    let tasks: [AgentLongTask]

    var body: some View {
        HStack(spacing: 8) {
            QueueMetric(label: "运行", value: runningCount, color: RadarTheme.blue)
            QueueMetric(label: "完成", value: completedCount, color: RadarTheme.green)
            QueueMetric(label: "阻断", value: blockedCount, color: RadarTheme.red)
        }
    }

    private var runningCount: Int {
        tasks.filter { status($0).contains("running") || status($0).contains("started") || status($0).contains("queued") }.count
    }

    private var completedCount: Int {
        tasks.filter { status($0).contains("completed") || status($0).contains("done") }.count
    }

    private var blockedCount: Int {
        tasks.filter { status($0).contains("blocked") || status($0).contains("failed") || status($0).contains("error") }.count
    }

    private func status(_ task: AgentLongTask) -> String {
        task.status.lowercased()
    }
}

private struct QueueMetric: View {
    let label: String
    let value: Int
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(value)")
                .font(.system(size: 16, weight: .bold, design: .rounded))
                .foregroundStyle(color)
                .contentTransition(.numericText())
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(RadarTheme.mutedText)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RadarTheme.tintFaint)
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

private struct AgentTaskQueueRow: View {
    @ObservedObject var viewModel: DashboardViewModel
    let task: AgentLongTask
    let selected: Bool
    @State private var confirmingDelete = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Button(action: { viewModel.selectAgentSession(task.sessionID) }) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(task.prompt)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    HStack(spacing: 6) {
                        StatusDot(color: statusColor, size: 6)
                        Text(RuntimeStatusPresenter.label(task.status))
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(statusColor)
                            .lineLimit(1)
                        Text(shortRun(task.runID))
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(RadarTheme.mutedText)
                            .lineLimit(1)
                    }

                    Text(capabilityLabel)
                        .font(.system(size: 9))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            Button(role: .destructive, action: { confirmingDelete = true }) {
                Image(systemName: "trash")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(RadarTheme.red)
                    .frame(width: 22, height: 22)
                    .background(RadarTheme.red.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
            .buttonStyle(.plain)
            .help("删除任务记录")
        }
        .railRow(selected: selected)
        .contextMenu {
            Button("打开") {
                viewModel.selectAgentSession(task.sessionID)
            }
            Button("删除", role: .destructive) {
                confirmingDelete = true
            }
        }
        .confirmationDialog("删除这个任务？", isPresented: $confirmingDelete) {
            Button("删除", role: .destructive) {
                viewModel.deleteAgentTask(task.taskID)
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("只删除任务记录，不会清理无关文件。")
        }
    }

    private var statusColor: Color {
        let value = task.status.lowercased()
        if value.contains("blocked") || value.contains("failed") || value.contains("error") {
            return RadarTheme.red
        }
        if value.contains("completed") || value.contains("done") {
            return RadarTheme.green
        }
        if value.contains("running") || value.contains("started") || value.contains("queued") {
            return RadarTheme.blue
        }
        return RadarTheme.secondaryText
    }

    private var capabilityLabel: String {
        let ids = ((task.selectedSkillIDs ?? []) + (task.selectedExtensionIDs ?? []))
            .filter { id in
                let value = id.lowercased()
                return !value.contains("feishu") && !value.contains("lark")
            }
        guard !ids.isEmpty else { return "默认能力" }
        let domains = Set(ids.map(domainLabel)).sorted()
        return domains.joined(separator: " / ")
    }

    private func domainLabel(_ id: String) -> String {
        let value = id.lowercased()
        if value.contains("office") || value.contains("meeting") || value.contains("document") {
            return "Office"
        }
        if value.contains("cmc") || value.contains("market") || value.contains("token") || value.contains("wechat") || value.contains("onchain") {
            return "Web3"
        }
        return "Local"
    }

    private func shortRun(_ runID: String?) -> String {
        guard let runID else { return "未开始" }
        return String(runID.replacingOccurrences(of: "run-", with: "").prefix(8))
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
    @State private var confirmingDelete = false

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

                    VStack(spacing: 5) {
                        Button(action: beginRename) {
                            Image(systemName: "pencil")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(RadarTheme.mutedText)
                                .frame(width: 22, height: 22)
                                .background(RadarTheme.tintFaint)
                                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .help("重命名会话")

                        Button(role: .destructive, action: { confirmingDelete = true }) {
                            Image(systemName: "trash")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(RadarTheme.red)
                                .frame(width: 22, height: 22)
                                .background(RadarTheme.red.opacity(0.08))
                                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .help("删除会话")
                    }
                }
            }
        }
        .railRow(selected: selected)
        .contextMenu {
            Button("重命名") {
                beginRename()
            }
            Button("删除", role: .destructive) {
                confirmingDelete = true
            }
        }
        .confirmationDialog("删除这个会话？", isPresented: $confirmingDelete) {
            Button("删除", role: .destructive) {
                viewModel.deleteAgentSession(session.sessionID)
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("会话、任务和本地运行记录会一起删除。")
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
    @State private var followThreadBottom = true
    @State private var viewportHeight: CGFloat = 0
    @State private var bottomY: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            AgentCanvasHeader(viewModel: viewModel, thread: thread)
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
                                    isRunning: thread.status == .running && message.id == thread.messages.last?.id,
                                    isFinalizing: viewModel.isAgentRunFinalizing(message.runID)
                                )
                                    .id(message.id)
                                    .transition(.asymmetric(
                                        insertion: .opacity.combined(with: .offset(y: 12)),
                                        removal: .opacity
                                    ))
                            }
                            Color.clear
                                .frame(height: 1)
                                .id("threadBottom")
                                .background(
                                    GeometryReader { markerProxy in
                                        Color.clear.preference(
                                            key: AgentThreadBottomYPreferenceKey.self,
                                            value: markerProxy.frame(in: .named("agentThreadScroll")).maxY
                                        )
                                    }
                                )
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .animation(RadarMotion.spring, value: thread.messages.count)
                    }
                    .coordinateSpace(name: "agentThreadScroll")
                    .background(
                        GeometryReader { viewportProxy in
                            Color.clear.preference(key: AgentThreadViewportHeightPreferenceKey.self, value: viewportProxy.size.height)
                        }
                    )
                    .onPreferenceChange(AgentThreadViewportHeightPreferenceKey.self) { height in
                        viewportHeight = height
                        updateFollowBottom()
                    }
                    .onPreferenceChange(AgentThreadBottomYPreferenceKey.self) { y in
                        bottomY = y
                        updateFollowBottom()
                    }
                    .onChange(of: thread.messages.count) { _, _ in
                        guard followThreadBottom else { return }
                        withAnimation(RadarMotion.gentle) { proxy.scrollTo("threadBottom", anchor: .bottom) }
                    }
                    .onChange(of: thread.run.eventCount) { _, _ in
                        guard followThreadBottom else { return }
                        proxy.scrollTo("threadBottom", anchor: .bottom)
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

    private func updateFollowBottom() {
        guard viewportHeight > 0, bottomY > 0 else { return }
        let nearBottom = bottomY <= viewportHeight + 88
        if nearBottom != followThreadBottom {
            followThreadBottom = nearBottom
        }
    }
}

private struct AgentCanvasHeader: View {
    @ObservedObject var viewModel: DashboardViewModel
    let thread: AgentThreadState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(canvasTitle)
                        .font(RadarFont.display(20, .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(1)
                    Text(canvasSubtitle)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(RadarTheme.mutedText)
                        .lineLimit(1)
                }

                Spacer(minLength: 16)

                AgentStatusPill(
                    label: thread.statusText,
                    systemImage: statusIcon,
                    color: AgentUIStyle.threadColor(thread.status)
                )
                AgentStatusPill(
                    label: queueLabel,
                    systemImage: "tray.full",
                    color: RadarTheme.secondaryText
                )
            }

            HStack(spacing: 7) {
                CanvasSignalPill(title: "Evidence", value: evidenceLabel, color: evidenceColor)
                CanvasSignalPill(title: "Review", value: reviewLabel, color: reviewColor)
                CanvasSignalPill(title: "Policy", value: policyLabel, color: policyColor)
                diagnostics
                Spacer(minLength: 0)
            }

            if let cmcStatusLine {
                HStack(spacing: 7) {
                    CanvasSignalPill(title: "CMC Skill Hub", value: cmcStatusLine, color: cmcStatusColor)
                    Spacer(minLength: 0)
                }
            }
        }
    }

    @ViewBuilder
    private var diagnostics: some View {
        let items = viewModel.agentFinalDiagnostics(runID: thread.activeRunID)
        if !items.isEmpty {
            ForEach(items.prefix(3), id: \.self) { item in
                CanvasSignalPill(title: item, value: "", color: diagnosticColor(item), compact: true)
            }
        }
    }

    private var canvasTitle: String {
        thread.title == "Agent 工作空间" ? "Agent Work Canvas" : thread.title
    }

    private var canvasSubtitle: String {
        if let runID = thread.activeRunID {
            return "\(AgentWorkspaceV2Copy.runDisplay(runID)) · \(thread.run.latestStep)"
        }
        return "准备新任务"
    }

    private var queueLabel: String {
        let running = viewModel.agentTasks.filter { task in
            let value = task.status.lowercased()
            return value.contains("running") || value.contains("started") || value.contains("queued")
        }.count
        return running > 0 ? "\(running) active" : "\(viewModel.agentTasks.count) tasks"
    }

    private var statusIcon: String {
        switch thread.status {
        case .running:
            return "arrow.triangle.2.circlepath"
        case .completed:
            return "checkmark.seal"
        case .failed, .blocked:
            return "exclamationmark.triangle"
        case .waitingForApproval:
            return "hand.raised"
        default:
            return "circle.dotted"
        }
    }

    private var evidenceLabel: String {
        if let runID = thread.activeRunID,
           let summary = viewModel.agentCMCCapabilitySummaryByRunID[runID],
           summary.allowSkillHubResultDisplay == true {
            return "result"
        }
        if let runID = thread.activeRunID,
           let gate = viewModel.agentFinalReadModelByRunID[runID]?.cmcGateSummary,
           gate.allowSkillHubResultDisplay == true {
            return "result"
        }
        if let runID = thread.activeRunID,
           let model = viewModel.agentFinalReadModelByRunID[runID],
           let count = model.cmcGateSummary?.researchEvidence?.readableEvidenceCount ?? model.cmcGateSummary?.readableEvidenceCount {
            return count == 0 ? "empty" : "\(count)"
        }
        if let context = thread.contextSummary {
            return "\(context.sourceCount)"
        }
        return "--"
    }

    private var evidenceColor: Color {
        if evidenceLabel == "result" {
            return RadarTheme.green
        }
        if evidenceLabel == "empty" {
            return RadarTheme.gold
        }
        if evidenceLabel == "--" {
            return RadarTheme.secondaryText
        }
        return RadarTheme.green
    }

    private var cmcStatusLine: String? {
        guard let runID = thread.activeRunID else { return nil }
        if let summary = viewModel.agentCMCCapabilitySummaryByRunID[runID] {
            return [
                readableMountStatus(summary.mountStatus),
                readableTransportStatus(summary.transportStatus),
                readableResultStatus(summary.skillHubDisplayStatus, allowSkillHubResultDisplay: summary.allowSkillHubResultDisplay),
                readablePriceStatus(summary.priceSnapshotStatus, allowConcretePrices: summary.allowConcretePrices)
            ].joined(separator: " · ")
        }
        guard let gate = viewModel.agentFinalReadModelByRunID[runID]?.cmcGateSummary else { return nil }
        return [
            "mounted",
            readableTransportStatus(gate.transportStatus),
            readableResultStatus(gate.skillHubDisplayStatus ?? gate.skillHubDisplay?.status, allowSkillHubResultDisplay: gate.allowSkillHubResultDisplay ?? gate.skillHubDisplay?.allowSkillHubResultDisplay),
            readablePriceStatus(gate.priceSnapshotStatus, allowConcretePrices: gate.allowConcretePrices)
        ].joined(separator: " · ")
    }

    private var cmcStatusColor: Color {
        guard let runID = thread.activeRunID else { return RadarTheme.secondaryText }
        if let summary = viewModel.agentCMCCapabilitySummaryByRunID[runID] {
            if summary.transportStatus == "failed" || summary.transportStatus == "missing" {
                return RadarTheme.red
            }
            if summary.allowSkillHubResultDisplay == true || summary.skillHubDisplayStatus == "usable" || summary.priceSnapshotStatus == "usable" || summary.allowConcretePrices == true {
                return RadarTheme.green
            }
            return RadarTheme.gold
        }
        if let gate = viewModel.agentFinalReadModelByRunID[runID]?.cmcGateSummary {
            if gate.allowConcretePrices == true || gate.allowSkillHubResultDisplay == true || gate.skillHubDisplayStatus == "usable" || gate.researchEvidenceStatus == "usable" {
                return RadarTheme.green
            }
            return RadarTheme.gold
        }
        return RadarTheme.secondaryText
    }

    private func readableMountStatus(_ value: String?) -> String {
        value == "mounted" ? "mounted" : "not mounted"
    }

    private func readableTransportStatus(_ value: String?) -> String {
        switch value {
        case "ok":
            return "transport ok"
        case "failed":
            return "transport failed"
        case "missing", nil:
            return "transport missing"
        default:
            return "transport \(value ?? "unknown")"
        }
    }

    private func readableEvidenceStatus(_ value: String?, count: Int?) -> String {
        switch value {
        case "usable":
            return (count ?? 0) > 0 ? "evidence usable \(count ?? 0)" : "evidence usable"
        case "empty":
            return "evidence empty"
        case "missing", nil:
            return "evidence missing"
        default:
            return "evidence \(value ?? "unknown")"
        }
    }

    private func readableResultStatus(_ value: String?, allowSkillHubResultDisplay: Bool?) -> String {
        if allowSkillHubResultDisplay == true || value == "usable" {
            return "result usable"
        }
        switch value {
        case "empty":
            return "result empty"
        case "failed":
            return "result failed"
        case "missing", nil:
            return "result missing"
        default:
            return "result \(value ?? "unknown")"
        }
    }

    private func readablePriceStatus(_ value: String?, allowConcretePrices: Bool?) -> String {
        if allowConcretePrices == true || value == "usable" {
            return "prices usable"
        }
        if value == "blocked" {
            return "prices blocked"
        }
        if value == "missing" || value == nil {
            return "prices missing"
        }
        return "prices \(value ?? "unknown")"
    }

    private var reviewLabel: String {
        switch thread.run.status {
        case .completed:
            return "pass"
        case .failed, .blocked:
            return "hold"
        case .running, .waitingForApproval:
            return "open"
        default:
            return "--"
        }
    }

    private var reviewColor: Color {
        switch reviewLabel {
        case "pass":
            return RadarTheme.green
        case "hold":
            return RadarTheme.red
        case "open":
            return RadarTheme.blue
        default:
            return RadarTheme.secondaryText
        }
    }

    private var policyLabel: String {
        if let control = thread.controlSummary {
            return control.blockedPolicyCount > 0 ? "blocked" : "safe"
        }
        if thread.approvals.contains(where: { $0.status == .needsApproval }) {
            return "confirm"
        }
        return "safe"
    }

    private var policyColor: Color {
        switch policyLabel {
        case "blocked":
            return RadarTheme.red
        case "confirm":
            return RadarTheme.gold
        default:
            return RadarTheme.green
        }
    }

    private func diagnosticColor(_ item: String) -> Color {
        item.contains("blocked") || item.contains("discarded") ? RadarTheme.gold : RadarTheme.secondaryText
    }
}

private struct CanvasSignalPill: View {
    let title: String
    let value: String
    let color: Color
    var compact = false

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 5, height: 5)
            Text(title)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(color)
                .lineLimit(1)
            if !value.isEmpty {
                Text(value)
                    .font(.system(size: 9, weight: .semibold, design: .rounded))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, compact ? 7 : 8)
        .padding(.vertical, 5)
        .background(color.opacity(0.09))
        .overlay(
            Capsule().strokeBorder(color.opacity(0.22), lineWidth: 1)
        )
        .clipShape(Capsule())
    }
}

private struct AgentThreadViewportHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct AgentThreadBottomYPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
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
                StrategyResultCard(result: result)
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

/// Maps internal jargon the model occasionally leaks into user-facing product terms.
/// Belt-and-suspenders alongside the system prompt — these tokens only ever mean the product
/// concept in this app's domain, so the substitution is safe.
enum AgentOutputCopy {
    static func humanize(_ s: String) -> String {
        let cleaned = normalizedMarkdown(s)
        if cleaned.isEmpty && !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "后台调用参数已隐藏；请查看执行状态与最终结论。"
        }
        return cleaned
    }

    static func normalizedMarkdown(_ s: String) -> String {
        let cleaned = stripInternalSurface(stripProcessPreamble(s.replacingOccurrences(of: "水晶", with: "情报卡")))
        return normalizeMarkdownBoundaries(cleaned)
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func metadataLabel(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "--" }
        if containsInternalSurface(trimmed) {
            return "本机记录已保存"
        }
        return readableBackendTerms(trimmed)
    }

    private static func stripProcessPreamble(_ s: String) -> String {
        s.components(separatedBy: .newlines)
            .filter { line in
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return true }
                if trimmed.range(of: #"^(计划|上下文验证)\s*\d*[:：]?"#, options: .regularExpression) != nil {
                    return false
                }
                if trimmed.range(of: #"^(我将|我会|接下来|先).*(刷新|扫描|读取|拉取|调用|静默|过程|计划|上下文验证|开始)"#, options: .regularExpression) != nil {
                    return false
                }
                if trimmed.contains("整个过程") && trimmed.contains("最终") {
                    return false
                }
                return true
            }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func stripInternalSurface(_ s: String) -> String {
        var withoutToolBlocks = s
        for pattern in [
            #"<looloomi-tool-calls[\s\S]*?(?:</looloomi-tool-calls>|$)"#,
            #"<function_calls[\s\S]*?(?:</function_calls>|$)"#,
            #"<invoke\b[\s\S]*?(?:</invoke>|$)"#
        ] {
            withoutToolBlocks = withoutToolBlocks.replacingOccurrences(
                of: pattern,
                with: "",
                options: [.regularExpression, .caseInsensitive]
            )
        }
        return withoutToolBlocks
            .components(separatedBy: .newlines)
            .compactMap { line -> String? in
                if containsHardInternalSurface(line) {
                    return nil
                }
                let readable = readableBackendTerms(line)
                if containsHardInternalSurface(readable) || containsInternalSurface(readable) {
                    return nil
                }
                return readable
            }
            .joined(separator: "\n")
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func containsHardInternalSurface(_ s: String) -> Bool {
        let patterns = [
            #"</?looloomi-tool-calls\b"#,
            #"</?function_calls\b"#,
            #"</?invoke\b"#,
            #"</?callname\b"#,
            #"\binvokename\s*="#,
            #"\bparametername\s*="#,
            #"\bparameters?\s*="#,
            #"</?parameter\b"#,
            #"\bruntime/(agent|market|runs|ops)/"#,
            #"/Users/[^\s>\"']+"#,
            #"\b(tool-observations|tool-calls|run-manifest|context-bundle|final-output|provider-status)\.json\b"#,
            #"\b(office|channel\.feishu)\.[a-z0-9_.-]+\b"#,
            #"\bmarkets\.[a-z0-9_.-]+\b"#,
            #"^\s*[-*]?\s*(Skill|Extension)\s*[：:]\s*(自动判断|[a-z0-9_.-]+(\s*,\s*[a-z0-9_.-]+)*)\s*$"#,
            #"\b(artifactPath|detailsArtifactPath|runID|taskID|sessionID|schemaVersion|cmcFreshnessGate|outputGuard|artifactKind|inputSummary|outputSummary|redactionStatus)\b"#
        ]
        return patterns.contains { pattern in
            s.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
        }
    }

    private static func containsInternalSurface(_ s: String) -> Bool {
        let patterns = [
            #"</?looloomi-tool-calls\b"#,
            #"</?function_calls\b"#,
            #"</?invoke\b"#,
            #"</?callname\b"#,
            #"\binvokename\s*="#,
            #"\bparametername\s*="#,
            #"\bparameters?\s*="#,
            #"</?parameter\b"#,
            #"\bruntime/(agent|market|runs|ops)/"#,
            #"/Users/[^\s>\"']+"#,
            #"\b(tool-observations|tool-calls|run-manifest|context-bundle|final-output|provider-status)\.json\b"#,
            #"\b(office|channel\.feishu)\.[a-z0-9_.-]+\b"#,
            #"\bmarkets\.[a-z0-9_.-]+\b"#,
            #"\b(mcpProvider|cmcRestProvider|normalizedFileProvider|fixtureProvider|mcpHttpProvider)\b"#,
            #"^\s*[-*]?\s*(Skill|Extension)\s*[：:]\s*(自动判断|[a-z0-9_.-]+(\s*,\s*[a-z0-9_.-]+)*)\s*$"#,
            #"\b(cmc-skill-hub|cmc-market-radar|wechat-cli-export-bridge|wechat-onchain-intelligence|market-regime-review|social-price-divergence|office-meeting-agent|feishu-agent-bridge|markets-research|equity-company-deep-dive|equity-earnings-review|equity-thesis-tracker|equity-sector-scan|macro-cross-asset-readthrough|drillr|cc-equity-research|InvestSkill)\b"#,
            #"\b(artifactPath|detailsArtifactPath|runID|taskID|sessionID|schemaVersion|cmcFreshnessGate|outputGuard|artifactKind|inputSummary|outputSummary|redactionStatus)\b"#
        ]
        return patterns.contains { pattern in
            s.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
        }
    }

    private static func readableBackendTerms(_ s: String) -> String {
        s.replacingOccurrences(of: "normalizedFileProvider", with: "本地缓存")
            .replacingOccurrences(of: "fixtureProvider", with: "样例数据")
            .replacingOccurrences(of: "mcpHttpProvider", with: "CoinMarketCap MCP")
            .replacingOccurrences(of: "cmcRestProvider", with: "CoinMarketCap 实时接口")
            .replacingOccurrences(of: "mcpProvider", with: "CoinMarketCap MCP")
            .replacingOccurrences(of: "cmc-skill-hub", with: "CMC Skill Hub 能力包")
            .replacingOccurrences(of: "cmc-market-radar", with: "CMC 市场雷达")
            .replacingOccurrences(of: "wechat-cli-export-bridge", with: "WeChat 能力包")
            .replacingOccurrences(of: "wechat-onchain-intelligence", with: "WeChat 链上情报")
            .replacingOccurrences(of: "market-regime-review", with: "市场体制复核")
            .replacingOccurrences(of: "social-price-divergence", with: "社交价格分歧")
            .replacingOccurrences(of: "office-meeting-agent", with: "Office / Meeting 能力包")
            .replacingOccurrences(of: "feishu-agent-bridge", with: "Feishu dry-run 通道")
            .replacingOccurrences(of: "markets-research", with: "Markets Research 能力包")
            .replacingOccurrences(of: "equity-company-deep-dive", with: "Company Deep Dive")
            .replacingOccurrences(of: "equity-earnings-review", with: "Earnings Review")
            .replacingOccurrences(of: "equity-thesis-tracker", with: "Thesis Tracker")
            .replacingOccurrences(of: "equity-sector-scan", with: "Sector Scan")
            .replacingOccurrences(of: "macro-cross-asset-readthrough", with: "Macro / Cross-asset")
            .replacingOccurrences(of: "cc-equity-research", with: "equity research workflow")
            .replacingOccurrences(of: "InvestSkill", with: "equity research framework")
            .replacingOccurrences(of: "investskill", with: "equity research framework")
            .replacingOccurrences(of: "drillr", with: "equity provider")
            .replacingOccurrences(of: "tool_observations_missing", with: "缺少可信工具观测记录")
            .replacingOccurrences(of: "concrete_market_values_without_fresh_gate", with: "具体价位未通过实时数据校验")
            .replacingOccurrences(of: "raw_internal_fields_removed", with: "已隐藏后台调用字段")
            .replacingOccurrences(of: #"\bfresh\b"#, with: "最新", options: .regularExpression)
            .replacingOccurrences(of: #"\blive\b"#, with: "实时", options: .regularExpression)
            .replacingOccurrences(of: #"\bdegraded\b"#, with: "降级", options: .regularExpression)
            .replacingOccurrences(of: "_", with: " ")
    }

    private static func normalizeMarkdownBoundaries(_ s: String) -> String {
        var normalized = s
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        normalized = normalized.replacingOccurrences(
            of: #"(?m)^\s*#{1,6}\s*$\n?"#,
            with: "",
            options: .regularExpression
        )
        normalized = normalized.replacingOccurrences(
            of: #"(?m)(市场雷达\s*Alpha\s*研究候选)(数据新鲜度\s*[:：])"#,
            with: "## $1\n- **数据新鲜度**：",
            options: .regularExpression
        )

        let sectionLabels = "(结论|关键证据|证据与来源|行动建议|风险边界/数据缺口|风险边界|数据缺口|数据来源与可信度说明|数据来源与可信度|三场景推演|场景推演|盘面定性)"
        let fieldLabels = "(核心逻辑|关键价位|支撑观察|阻力观察|突破确认线|目标观察阻力|反证|后续观察条件|数据来源状态)"
        let replacements: [(String, String)] = [
            (#"(?m)([^\n])\s*(#{1,4}\s*\S)"#, "$1\n$2"),
            (#"(?m)(^|[。；;])\s*__SECTION_LABELS__\s*[:：]\s*"#, "$1\n## $2\n"),
            (#"(?m)^__SECTION_LABELS__\s+(\S)"#, "## $1\n$2"),
            (#"(?m)([^\n])\s+__SECTION_LABELS__\s+(\S)"#, "$1\n## $2\n$3"),
            (#"(?m)(^|[。；;])\s*(候选\s*\d{1,2}\s*[:：]\s*)"#, "$1\n### $2"),
            (#"(?m)([^\n])\s+(候选\s*\d{1,2}\s*[:：]\s*)"#, "$1\n### $2"),
            (#"(?m)(^|[。；;])\s*__FIELD_LABELS__\s*[:：]\s*"#, "$1\n- **$2**："),
            (#"(?m)([^\n])\s+-\s*__FIELD_LABELS__\s*[:：]\s*"#, "$1\n- **$2**："),
            (#"(?m)([^\n])\s+__FIELD_LABELS__\s*[:：]\s*"#, "$1\n- **$2**："),
            (#"(?m)([。；;])\s*(\d{1,2}[.)]\s*\S)"#, "$1\n$2"),
            (#"(?m)([^\n])(\s{1,3}[-*]\s+\S)"#, "$1\n$2"),
            (#"(?m)([^\n])(\s{0,2}•\s*\S)"#, "$1\n$2")
        ]
        for (patternTemplate, template) in replacements {
            let pattern = patternTemplate
                .replacingOccurrences(of: "__SECTION_LABELS__", with: sectionLabels)
                .replacingOccurrences(of: "__FIELD_LABELS__", with: fieldLabels)
            normalized = normalized.replacingOccurrences(
                of: pattern,
                with: template,
                options: .regularExpression
            )
        }
        return normalized
    }

    static func streamingSegments(_ s: String) -> [LiveAssistantSegment] {
        var segments: [LiveAssistantSegment] = []
        for block in MarkdownParser.parse(s) {
            switch block {
            case .heading(_, let text):
                append(stripInlineMarkdown(text), kind: .heading, to: &segments)
            case .bullet(let text):
                append(stripInlineMarkdown(text), kind: .bullet, to: &segments)
            case .ordered(let marker, let text):
                append(stripInlineMarkdown(text), kind: .ordered(marker), to: &segments)
            case .table(let header, let rows):
                let line = ([header] + rows)
                    .prefix(3)
                    .map { $0.prefix(4).joined(separator: "  ·  ") }
                    .joined(separator: " / ")
                append(stripInlineMarkdown(line), kind: .table, to: &segments)
            case .paragraph(let text), .code(let text):
                append(stripInlineMarkdown(text), kind: .text, to: &segments)
            case .rule:
                continue
            }
        }
        return segments
    }

    private static func append(_ text: String, kind: LiveAssistantSegment.Kind, to segments: inout [LiveAssistantSegment]) {
        for (offset, chunk) in sentenceChunks(text).enumerated() where !chunk.isEmpty {
            let segmentKind = offset == 0 ? kind : .text
            segments.append(.init(id: segments.count, kind: segmentKind, text: chunk))
        }
    }

    private static func sentenceChunks(_ text: String, softLimit: Int = 92) -> [String] {
        guard text.count > softLimit else { return [text] }
        var chunks: [String] = []
        var current = ""
        for char in text {
            current.append(char)
            if current.count >= softLimit, "。；;.!?？".contains(char) {
                chunks.append(current.trimmingCharacters(in: .whitespaces))
                current.removeAll(keepingCapacity: true)
            } else if current.count >= softLimit + 22 {
                chunks.append(current.trimmingCharacters(in: .whitespaces))
                current.removeAll(keepingCapacity: true)
            }
        }
        let tail = current.trimmingCharacters(in: .whitespaces)
        if !tail.isEmpty { chunks.append(tail) }
        return chunks
    }

    private static func stripInlineMarkdown(_ text: String) -> String {
        text
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "__", with: "")
            .replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespaces)
    }
}

struct LiveAssistantSegment: Identifiable, Equatable {
    enum Kind: Equatable {
        case heading
        case bullet
        case ordered(String)
        case table
        case text
    }

    let id: Int
    let kind: Kind
    let text: String
}

/// Live model output during a run. Streaming uses a lightweight line renderer; the completed
/// message still uses full MarkdownBlocksView. This avoids reparsing rich markdown/tables on
/// every token flush while keeping the final answer polished.
private struct LiveAssistantStream: View {
    let text: String
    var statusText: String = "正在生成"
    var statusColor: Color = RadarTheme.blue

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(AgentOutputCopy.streamingSegments(text)) { segment in
                LiveAssistantSegmentView(segment: segment)
            }
            HStack(spacing: 6) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 5, height: 5)
                Text(statusText)
                    .font(.system(size: 10))
                    .foregroundStyle(RadarTheme.mutedText)
            }
            .padding(.top, 2)
        }
    }
}

private struct LiveAssistantSegmentView: View {
    let segment: LiveAssistantSegment

    var body: some View {
        switch segment.kind {
        case .heading:
            Text(segment.text)
                .font(.system(size: 13.5, weight: .bold))
                .foregroundStyle(RadarTheme.primaryText)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        case .bullet:
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Circle()
                    .fill(RadarTheme.gold)
                    .frame(width: 4, height: 4)
                    .offset(y: -1)
                liveText(segment.text, color: RadarTheme.secondaryText)
            }
        case .ordered(let marker):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(marker)
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(RadarTheme.blue)
                liveText(segment.text, color: RadarTheme.secondaryText)
            }
        case .table:
            liveText(segment.text, size: 11.5, color: RadarTheme.secondaryText)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(RadarTheme.tintFaint)
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        case .text:
            liveText(segment.text)
        }
    }

    private func liveText(_ text: String, size: CGFloat = 12.5, color: Color = RadarTheme.primaryText) -> some View {
        Text(text)
            .font(.system(size: size, weight: .medium))
            .foregroundStyle(color)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }
}

private struct AgentThreadMessageRow: View {
    @ObservedObject var viewModel: DashboardViewModel
    let message: AgentThreadMessage
    var isRunning: Bool = false
    var isFinalizing: Bool = false

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
                    if showHistoryGuardNotice {
                        AgentNoticeBlock(
                            title: "历史输出未通过当前数据门禁",
                            summary: "这条历史结果缺少可信工具观测记录，只作为历史文本保留，不作为实时市场事实。",
                            tone: .warning
                        )
                    }
                    assistantBody
                }
            }
            .padding(12)
            .frame(maxWidth: isUser ? 560 : .infinity, alignment: .leading)
            // User bubble gets a faint accent wash to read distinct; assistant is a clean panel.
            .background(isUser ? RadarTheme.blue.opacity(0.07) : Color.clear)
            .researchPanel(glow: hasConclusion)
            if !isUser { Spacer(minLength: 36) }
        }
    }

    // Claude-style: while running, the live model text streams as the headline; tool/plan steps
    // tuck into a collapsed 执行过程 (no longer a wall of cards). When done, the persisted
    // conclusion parts take over.
    @ViewBuilder
    private var assistantBody: some View {
        let outcome = message.parts.filter { !isProcessPart($0) }
        let process = message.parts.filter(isProcessPart)
        let liveText = isRunning ? viewModel.agentAssistantText(for: message.runID) : ""
        let showLive = isRunning && !liveText.isEmpty

        if showLive {
            LiveAssistantStream(
                text: liveText,
                statusText: isFinalizing ? "已完成，正在整理结果" : "正在生成",
                statusColor: isFinalizing ? RadarTheme.green : RadarTheme.blue
            )
        } else if outcome.isEmpty && isFinalizing, !viewModel.agentAssistantText(for: message.runID).isEmpty {
            LiveAssistantStream(
                text: viewModel.agentAssistantText(for: message.runID),
                statusText: "已完成，正在整理结果",
                statusColor: RadarTheme.green
            )
        } else if outcome.isEmpty && !process.isEmpty {
            AgentProcessStreamLine(parts: process, isRunning: isRunning)
        } else {
            ForEach(outcome) { part in
                AgentMessagePartView(viewModel: viewModel, part: part)
            }
        }

        if !process.isEmpty && (showLive || !outcome.isEmpty) {
            AgentProcessStreamLine(parts: process, isRunning: isRunning || isFinalizing)
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
        case .planSummary, .capabilityCall, .evidence, .finalOutput, .strategyResult:
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

    private var showHistoryGuardNotice: Bool {
        guard !isRunning, !isFinalizing, message.role == .assistant, message.runID != nil else { return false }
        guard !viewModel.isActiveAgentStreamRun(message.runID) else { return false }
        guard isPersistedAssistantTextMessage else { return false }
        return viewModel.agentRunMissingToolObservations(message.runID)
    }

    private var isPersistedAssistantTextMessage: Bool {
        var hasText = false
        for part in message.parts {
            switch part {
            case .text:
                hasText = true
            case .evidence:
                continue
            case .planSummary, .capabilityCall, .approvalRequest, .strategyResult, .finalOutput, .attachment, .error, .notice:
                return false
            }
        }
        return hasText
    }
}

private struct AgentProcessStreamLine: View {
    let parts: [AgentMessagePart]
    let isRunning: Bool

    var body: some View {
        HStack(spacing: 7) {
            StatusDot(color: isRunning ? RadarTheme.blue : RadarTheme.green, size: 6, pulsing: isRunning)
            Text(statusText)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(RadarTheme.tintFaint)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var statusText: String {
        let labels = uniqueLabels.prefix(3).joined(separator: " / ")
        if labels.isEmpty {
            return isRunning ? "正在读取上下文并生成回复" : "执行记录已保存"
        }
        return isRunning ? "正在处理：\(labels)" : "已处理：\(labels)"
    }

    private var uniqueLabels: [String] {
        var seen = Set<String>()
        return parts.compactMap { label(for: $0) }.filter { seen.insert($0).inserted }
    }

    private func label(for part: AgentMessagePart) -> String? {
        switch part {
        case .capabilityCall(let call):
            return call.displayName
        case .planSummary:
            return "内部编排"
        case .evidence:
            return "证据"
        case .finalOutput:
            return "结果记录"
        case .strategyResult:
            return "策略结果"
        case .text:
            return "上下文"
        default:
            return nil
        }
    }
}

private struct AgentNoticeBlock: View {
    let title: String
    let summary: String
    let tone: AgentNoticeTone

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: tone == .warning ? "exclamationmark.triangle.fill" : "info.circle.fill")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(tint)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 10.5, weight: .bold))
                    .foregroundStyle(tint)
                    .lineLimit(1)
                Text(summary)
                    .font(.system(size: 10))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background(tint.opacity(0.08))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(tint.opacity(0.24), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var tint: Color {
        tone == .warning ? RadarTheme.gold : RadarTheme.blue
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
            AttachmentInlineCard(attachment: attachment)
        case .evidence(let chip):
            EvidenceSourceChips(chips: [chip])
        case .strategyResult(let result):
            StrategyResultCard(result: result)
        case .finalOutput(_, let title, let summary, let artifactPath):
            FinalOutputCard(text: "\(title)\n\(summary)", artifactPath: artifactPath)
        case .notice(_, let title, let summary, let tone):
            AgentNoticeBlock(title: title, summary: summary, tone: tone)
        case .error(_, let title, let message):
            AgentErrorBlock(text: "\(title)：\(message)")
        case .text(_, let text):
            MarkdownBlocksView(raw: AgentOutputCopy.humanize(text))
        }
    }
}

private struct AgentPlanSummaryBlock: View {
    let text: String
    let evidenceRefs: [AgentContextChip]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("内部编排记录", systemImage: "list.bullet.clipboard")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(RadarTheme.green)
            MarkdownBlocksView(raw: AgentOutputCopy.humanize(text))
            if !evidenceRefs.isEmpty {
                EvidenceSourceChips(chips: evidenceRefs)
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
            Button(action: { withAnimation(RadarMotion.snappy) { expanded.toggle() } }) {
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
                    if !call.artifactRefs.isEmpty {
                        InspectorRow(label: "记录", value: "本机记录已保存")
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
            // Boundary detail is shown inline below — no side-panel needed.
            InspectorRow(label: "动作", value: approval.displayName)
            InspectorRow(label: "读取/写入", value: approval.dataBoundary)
            InspectorRow(label: "外发", value: approval.outboundBoundary)
            InspectorRow(label: "原因", value: approval.reason)
            InspectorRow(label: "拒绝后", value: approval.rejectionFallback)
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
    let attachment: AgentAttachment

    var body: some View {
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
}

private struct FinalOutputCard: View {
    let text: String
    let artifactPath: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("结果", systemImage: "checkmark.seal")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(RadarTheme.green)
            // Visual digest extracted from the prose (degrades to nothing if not found),
            // then the markdown-rendered body — replaces the old raw-text dump.
            let humanized = AgentOutputCopy.humanize(text)
            AgentSignalDigestView(digest: AgentSignalExtractor.extract(from: humanized))
            MarkdownBlocksView(raw: humanized)
            if artifactPath != nil {
                Label("本机结果记录已保存", systemImage: "doc.text")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(RadarTheme.mutedText)
                    .lineLimit(1)
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

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(chips) { chip in
                    AgentContextChipView(chip: chip, compact: true)
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
                ContextChipBar(chips: viewModel.agentContextChips)
            }

            if !viewModel.agentAttachments.isEmpty {
                AttachmentStrip(attachments: viewModel.agentAttachments)
            }

            WorkbenchAbilityStrip(viewModel: viewModel) {
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
                    .background(RadarTheme.panelWash)
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

private struct AgentAbilityGroup: Identifiable {
    var id: String { label }
    let label: String
    let items: [AgentAbilityPackage]
}

private struct WorkbenchAbilityStrip: View {
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

                ForEach(groupedAbilities) { group in
                    Text(group.label)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(RadarTheme.mutedText)
                        .padding(.leading, group.id == groupedAbilities.first?.id ? 0 : 4)

                    ForEach(group.items) { ability in
                        Button(action: { toggle(ability) }) {
                            HStack(spacing: 5) {
                                Image(systemName: ability.selected ? "checkmark.circle.fill" : "circle")
                                Text(ability.title)
                                    .lineLimit(1)
                            }
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(ability.selected ? RadarTheme.blue : RadarTheme.secondaryText)
                            .researchCapsule(active: ability.selected)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var groupedAbilities: [AgentAbilityGroup] {
        let packages = AgentAbilityPackage.workbenchPackages(from: viewModel)
        let order = ["Web3", "Office / Meeting", "Local"]
        return order.compactMap { label in
            let items = packages.filter { $0.domainLabel == label }
            return items.isEmpty ? nil : AgentAbilityGroup(label: label, items: items)
        }
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
        let packages = AgentAbilityPackage.workbenchPackages(from: viewModel)
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

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                Text("上下文")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(RadarTheme.mutedText)
                ForEach(chips) { chip in
                    AgentContextChipView(chip: chip, compact: true)
                }
            }
        }
    }
}

private struct AttachmentStrip: View {
    let attachments: [AgentAttachment]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                Text("图片")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(RadarTheme.mutedText)
                ForEach(attachments) { attachment in
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
            }
        }
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
                let diagnostics = viewModel.agentFinalDiagnostics(runID: thread.activeRunID)
                if !diagnostics.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(diagnostics, id: \.self) { item in
                            Text(item)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(RadarTheme.secondaryText)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(RadarTheme.tintFaint))
                                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(RadarTheme.borderSoft, lineWidth: 1))
                        }
                    }
                }
                LazyVGrid(columns: [
                    GridItem(.flexible(), spacing: 8),
                    GridItem(.flexible(), spacing: 8),
                    GridItem(.flexible(), spacing: 8)
                ], spacing: 8) {
                    ForEach(viewModel.agentStreamEvents.suffix(9)) { event in
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
                        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(RadarTheme.tintFaint))
                        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(RadarTheme.borderSoft, lineWidth: 1))
                    }
                }
            }
        }
        .padding(10)
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

private struct AgentSmallEmpty: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 10))
            .foregroundStyle(RadarTheme.secondaryText)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RadarTheme.tintFaint)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
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
            Text(AgentOutputCopy.metadataLabel(value))
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
            return "Agent 能力源未检查"
        }
        let ready = status.providers
            .filter { ($0.connected ?? $0.ready) && ($0.degraded ?? false) == false }
            .map(providerDisplayName)
        if !ready.isEmpty {
            return "Agent 能力源可用：\(ready.joined(separator: " / "))"
        }
        let missing = status.providers.flatMap(\.missingEnv).joined(separator: ", ")
        return missing.isEmpty ? "Agent 能力源未配置" : "Agent 能力源缺少 \(missing)"
    }

    static func providerDisplayName(_ provider: AgentDaemonStatus.ProviderStatus) -> String {
        switch provider.provider {
        case "coinmarketcap":
            if provider.connected == true {
                return "CMC MCP"
            }
            if provider.configured == true {
                return provider.providerType == "cmcRestProvider" ? "CMC REST" : "CMC 已配置"
            }
            return "CMC 未配置"
        case "wechat-cli":
            return provider.ready ? "WeChatCLI 只读" : "WeChatCLI 未启用"
        default:
            return provider.model ?? provider.provider
        }
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
        case "office.meeting_minutes.draft":
            return "会议纪要"
        case "office.document.draft":
            return "文档草稿"
        case "office.document_revision.draft":
            return "文档修订"
        case "channel.feishu.dry_run":
            return "后台通道预演"
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
                        : (hovering ? RadarTheme.tintSoft : RadarTheme.tintFaint)
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
