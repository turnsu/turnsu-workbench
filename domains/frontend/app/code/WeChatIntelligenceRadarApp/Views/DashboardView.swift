import AppKit
import SwiftUI

struct DashboardView: View {
    @StateObject private var viewModel: DashboardViewModel
    @StateObject private var loopOpsStore: LoopOpsLocalStore
    /// "system" / "light" / "dark" — drives the in-app appearance toggle.
    @AppStorage("radar.appearance") private var appearancePref = "system"

    init(initialWorkspace: TerminalWorkspace = .home, loopOpsStore: LoopOpsLocalStore? = nil) {
        _viewModel = StateObject(wrappedValue: DashboardViewModel(initialWorkspace: initialWorkspace))
        _loopOpsStore = StateObject(wrappedValue: loopOpsStore ?? LoopOpsLocalStore.defaultStore())
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

                    GeometryReader { proxy in
                        let metrics = WorkbenchLayoutMetrics(contentWidth: proxy.size.width)
                        Group {
                            if viewModel.selectedWorkspace == .agents {
                                workspaceContent(metrics: metrics)
                                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            } else {
                                ScrollView {
                                    workspaceContent(metrics: metrics)
                                        .frame(maxWidth: .infinity, alignment: .topLeading)
                                        .padding(.bottom, 8)
                                }
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                            }
                        }
                        .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
                        .id(workspaceGroupKey)
                        .transition(.asymmetric(
                            insertion: .opacity.combined(with: .offset(y: 10)),
                            removal: .opacity
                        ))
                    }
                    .animation(RadarMotion.smooth, value: workspaceGroupKey)
                }
                .padding(.leading, 14)
                .padding(.trailing, 18)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .padding(.leading, 14)

            LoopOpsToastStack(
                toasts: loopOpsStore.toasts,
                dismiss: { loopOpsStore.dismissToast(id: $0) },
                perform: { toastID, action in
                    loopOpsStore.performToastAction(action, toastID: toastID)
                }
            )
            .padding(.trailing, 22)
            .padding(.bottom, 22)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
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
        case .skills: return "skills"
        case .workforce: return "workforce"
        case .knowledge: return "knowledge"
        case .chat: return "chat"
        case .studio: return "studio"
        case .ops: return "ops"
        }
    }

    @ViewBuilder
    private func workspaceContent(metrics: WorkbenchLayoutMetrics) -> some View {
        switch viewModel.selectedWorkspace {
        case .home:
            BlocksWorkbenchView(viewModel: viewModel, metrics: metrics, loopOpsStore: loopOpsStore)
        case .inbox:
            LoopOpsLibraryView(viewModel: viewModel, store: loopOpsStore, metrics: metrics)
        case .skills:
            LoopOpsSkillOSView(viewModel: viewModel, store: loopOpsStore, metrics: metrics)
        case .workforce:
            LoopOpsWorkforceView(viewModel: viewModel, store: loopOpsStore, metrics: metrics)
        case .knowledge:
            LoopOpsKnowledgeView(store: loopOpsStore, metrics: metrics)
        case .chat:
            LoopOpsGlobalChatWorkspace(viewModel: viewModel, store: loopOpsStore, metrics: metrics)
        case .token, .watchlist:
            LibraryWorkspaceView(viewModel: viewModel, loopOpsStore: loopOpsStore, metrics: metrics)
        case .studio:
            LoopOpsStudioView(viewModel: viewModel, store: loopOpsStore, metrics: metrics)
        case .agents:
            AgentWorkspaceView(viewModel: viewModel)
        case .ops:
            OpsWorkspaceView(viewModel: viewModel, metrics: metrics)
        }
    }
}

private struct LoopOpsGlobalChatWorkspace: View {
    @ObservedObject var viewModel: DashboardViewModel
    @ObservedObject var store: LoopOpsLocalStore
    let metrics: WorkbenchLayoutMetrics

    private var sortedTasks: [AgentLongTask] {
        viewModel.agentTasks.sorted { $0.updatedAt > $1.updatedAt }
    }

    private var runStates: [WorkbenchLoopRunState] {
        let liveStates = sortedTasks.map { rawTask in
            let task = viewModel.loopOpsTaskApplyingLifecycleOverride(rawTask)
            let loop = viewModel.agentCapabilityLoopByRunID[task.runID]
            return WorkbenchLoopRunState(
                task: task,
                domain: WorkbenchBlockClassifier.domain(for: task, capabilityLoop: loop),
                capabilityLoop: loop,
                finalReadModel: viewModel.agentFinalReadModelByRunID[task.runID]
            )
        }
        let liveRunIDs = Set(liveStates.map { $0.task.runID })
        let ledgerStates = store.runLedgers
            .filter { !liveRunIDs.contains($0.runID) }
            .map { ledger in
                WorkbenchLoopRunState(
                    task: ledgerBackedTask(ledger),
                    domain: ledger.domain,
                    capabilityLoop: nil,
                    finalReadModel: nil
                )
            }
        return (liveStates + ledgerStates).sorted { $0.task.updatedAt > $1.task.updatedAt }
    }

    private var selectedRun: WorkbenchLoopRunState? {
        if let runID = viewModel.selectedLoopOpsRunID,
           let selected = runStates.first(where: { $0.task.runID == runID }) {
            return selected
        }
        return runStates.first
    }

    private var selectedContract: LoopContract? {
        if let selectedRun {
            return store.loopContracts.first { contract in
                selectedRun.task.prompt.contains(contract.name) || selectedRun.task.runID.contains(contract.id)
            } ?? store.loopContracts.first
        }
        return store.loopContracts.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                IconChip(systemName: "bubble.left.and.text.bubble.right", tint: RadarTheme.blue, size: 36)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Chat")
                        .font(RadarFont.display(24, .bold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Text("Workspace-level assistant for choosing loops, attaching context, and starting safe runs.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(RadarTheme.secondaryText)
                }
                Spacer()
                Text("Workspace scoped")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(RadarTheme.blue)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(RadarTheme.blue.opacity(0.12))
                    .clipShape(Capsule())
            }

            if metrics.isCompact {
                VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                    globalChat
                    contextRail
                }
            } else {
                HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                    globalChat
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    contextRail
                        .frame(width: min(330, max(280, metrics.supportColumnWidth)), alignment: .topLeading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func ledgerBackedTask(_ ledger: RunLedgerRow) -> AgentLongTask {
        let timestamp = ledger.completedAt ?? ledger.startedAt ?? AgentDateFormatting.isoString(Date())
        return AgentLongTask(
            taskID: "ledger-\(ledger.runID)",
            sessionID: "ledger-\(ledger.runID)",
            runID: ledger.runID,
            prompt: ledger.title,
            status: ledger.status,
            selectedToolNames: ledger.skillPath ?? [],
            selectedSkillIDs: [],
            selectedExtensionIDs: [],
            attachmentIDs: [],
            artifactPath: "",
            createdAt: ledger.startedAt ?? timestamp,
            updatedAt: timestamp
        )
    }

    private var globalChat: some View {
        LoopOpsScopedChatPanel(
            viewModel: viewModel,
            store: store,
            scope: .global,
            scopeID: "workspace",
            title: "Workspace Chat",
            selectedRun: selectedRun,
            selectedContract: selectedContract
        )
    }

    private var contextRail: some View {
        VStack(alignment: .leading, spacing: 12) {
            PanelHeader(icon: "scope", title: "Context", trailing: "\(store.knowledgeSources.count) sources")
            LoopOpsGlobalChatContextLine(label: "Selected Run", value: selectedRun?.task.runID ?? "No active run")
            LoopOpsGlobalChatContextLine(label: "Loop", value: selectedContract?.name ?? "Choose from Loop Library")
            LoopOpsGlobalChatContextLine(label: "Knowledge", value: "\(store.knowledgeSources.filter { $0.status == .ready }.count) ready")
            LoopOpsGlobalChatContextLine(label: "Boundary", value: "No publish, trading, or sending without explicit confirmation.")
        }
        .padding(14)
        .radarPanel()
    }
}

private struct LoopOpsGlobalChatContextLine: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
            Text(value)
                .font(.system(size: 12.5))
                .foregroundStyle(RadarTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct CommandDeskWorkspaceView: View {
    @ObservedObject var viewModel: DashboardViewModel
    let metrics: WorkbenchLayoutMetrics
    @State private var selectedTaskID: String?
    @State private var taskDetailPresented = false
    @State private var detailInitialTab: CommandDeskDetailTab = .evidence
    @State private var deleteCandidate: AgentLongTask?
    @State private var abilityPalettePresented = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            CommandDeskHeader(
                viewModel: viewModel,
                activeTaskCount: sortedTasks.count,
                selectedTask: selectedTask,
                focusComposer: {
                    viewModel.agentPrompt = ""
                }
            )

            workPanels

            CommandDeskComposer(
                viewModel: viewModel,
                metrics: metrics,
                abilityPalettePresented: $abilityPalettePresented
            )
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .onAppear {
            if selectedTaskID == nil {
                selectedTaskID = sortedTasks.first?.taskID
            }
        }
        .onChange(of: viewModel.agentTasks.map(\.taskID)) { _, taskIDs in
            if let selectedTaskID, taskIDs.contains(selectedTaskID) {
                return
            }
            selectedTaskID = taskIDs.first
        }
        .sheet(isPresented: $taskDetailPresented) {
            CommandDeskTaskDetailSheet(
                task: selectedTask,
                finalReadModel: selectedTask.flatMap { viewModel.agentFinalReadModelByRunID[$0.runID] },
                cmcSummary: selectedTask.flatMap { viewModel.agentCMCCapabilitySummaryByRunID[$0.runID] },
                cloudASRSummary: selectedTask.flatMap { viewModel.agentCloudASRSummaryByRunID[$0.runID] },
                capabilityLoop: selectedTask.flatMap { viewModel.agentCapabilityLoopByRunID[$0.runID] },
                memoryReadModel: selectedTask.flatMap { viewModel.agentMemoryReadModelByRunID[$0.runID] },
                subagentCoordination: selectedTask.flatMap { viewModel.agentSubagentCoordinationByRunID[$0.runID] },
                initialTab: detailInitialTab,
                diagnostics: selectedTask.map { viewModel.agentFinalDiagnostics(runID: $0.runID) } ?? []
            )
            .frame(minWidth: 620, minHeight: 520)
        }
        .confirmationDialog("删除这个任务？", isPresented: deleteConfirmationBinding) {
            Button("删除任务", role: .destructive) {
                if let deleteCandidate {
                    viewModel.deleteAgentTask(deleteCandidate.taskID)
                    if selectedTaskID == deleteCandidate.taskID {
                        selectedTaskID = nil
                    }
                }
                deleteCandidate = nil
            }
            Button("取消", role: .cancel) {
                deleteCandidate = nil
            }
        } message: {
            Text(deleteCandidate?.prompt ?? "任务记录会从本地队列移除。")
        }
        .onExitCommand {
            abilityPalettePresented = false
            taskDetailPresented = false
        }
    }

    private var sortedTasks: [AgentLongTask] {
        viewModel.agentTasks.sorted { lhs, rhs in lhs.updatedAt > rhs.updatedAt }
    }

    @ViewBuilder
    private var workPanels: some View {
        if metrics.isCompact {
            VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                queuePanel
                resultCanvas
            }
        } else {
            HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                queuePanel
                    .frame(width: metrics.queueColumnWidth)
                resultCanvas
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }

    private var queuePanel: some View {
        CommandDeskQueuePanel(
            tasks: sortedTasks,
            selectedTaskID: bindingSelectedTaskID,
            openTask: openTask(_:),
            requestDelete: { deleteCandidate = $0 }
        )
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private var resultCanvas: some View {
        CommandDeskResultCanvas(
            task: selectedTask,
            finalReadModel: selectedTask.flatMap { viewModel.agentFinalReadModelByRunID[$0.runID] },
            cmcSummary: selectedTask.flatMap { viewModel.agentCMCCapabilitySummaryByRunID[$0.runID] },
            cloudASRSummary: selectedTask.flatMap { viewModel.agentCloudASRSummaryByRunID[$0.runID] },
            capabilityLoop: selectedTask.flatMap { viewModel.agentCapabilityLoopByRunID[$0.runID] },
            diagnostics: selectedTask.map { viewModel.agentFinalDiagnostics(runID: $0.runID) } ?? [],
            openTask: {
                if let selectedTask {
                    openTask(selectedTask)
                }
            },
            openReview: {
                if selectedTask != nil {
                    detailInitialTab = .review
                    taskDetailPresented = true
                }
            },
            followUp: {
                if let loop = selectedTask.flatMap({ viewModel.agentCapabilityLoopByRunID[$0.runID] }),
                   let prompt = loop.followUpSuggestions.first?.prompt {
                    viewModel.agentPrompt = prompt
                } else if let selectedTask {
                    viewModel.agentPrompt = "基于这个任务继续追问：\(selectedTask.prompt)"
                }
            }
        )
    }

    private var selectedTask: AgentLongTask? {
        if let selectedTaskID,
           let task = sortedTasks.first(where: { $0.taskID == selectedTaskID }) {
            return task
        }
        return sortedTasks.first
    }

    private var bindingSelectedTaskID: Binding<String?> {
        Binding(
            get: { selectedTaskID ?? sortedTasks.first?.taskID },
            set: { selectedTaskID = $0 }
        )
    }

    private var deleteConfirmationBinding: Binding<Bool> {
        Binding(
            get: { deleteCandidate != nil },
            set: { if !$0 { deleteCandidate = nil } }
        )
    }

    private func openTask(_ task: AgentLongTask) {
        selectedTaskID = task.taskID
        viewModel.selectAgentSession(task.sessionID)
        detailInitialTab = .evidence
        taskDetailPresented = true
    }

}

private struct CommandDeskHeader: View {
    @ObservedObject var viewModel: DashboardViewModel
    let activeTaskCount: Int
    let selectedTask: AgentLongTask?
    let focusComposer: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center) {
                    titleBlock
                    Spacer(minLength: 18)
                    headerActions
                }
                VStack(alignment: .leading, spacing: 12) {
                    titleBlock
                    headerActions
                }
            }

            statusStrip
        }
        .padding(20)
        .background(RadarTheme.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Image(systemName: "calendar")
                    .font(.system(size: 11, weight: .semibold))
                Text(viewModel.headerDateText)
                    .font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(RadarTheme.blue)

            Text("Command Desk")
                .font(RadarFont.display(30, .bold))
                .foregroundStyle(RadarTheme.primaryText)
                .minimumScaleFactor(0.86)

            Text("Crypto 研究与 Office 草稿的统一工作台")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(1)
            Text("快速布置任务、读取 Agent 最终结果、连续追问，并在需要时进入证据、复核和交付详情。")
                .font(.system(size: 13))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(2)
                .lineSpacing(3)
                .frame(maxWidth: 760, alignment: .leading)
        }
    }

    private var headerActions: some View {
        VStack(alignment: .trailing, spacing: 8) {
            HStack(spacing: 8) {
                CommandDeskMetric(label: "任务", value: "\(activeTaskCount)")
                CommandDeskMetric(label: "结果", value: "\(viewModel.agentFinalReadModelByRunID.count)")
                CommandDeskMetric(label: "草稿", value: "\(viewModel.terminalData.proactive.proposals.filter { $0.status == .proposed }.count)")
            }
            HStack(spacing: 8) {
                Button {
                    focusComposer()
                } label: {
                    Label("新建任务", systemImage: "plus")
                }
                .buttonStyle(ResearchPrimaryButtonStyle())

                Button {
                    viewModel.select(workspace: .inbox)
                } label: {
                    Label("打开历史", systemImage: "clock.arrow.circlepath")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
            }
        }
    }

    private var statusStrip: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], alignment: .leading, spacing: 8) {
            CommandDeskStatusPill(
                label: selectedTask.map { CommandDeskTaskStatus.label(for: $0.status) } ?? "无活动任务",
                color: selectedTask.map { CommandDeskTaskStatus.color(for: $0.status) } ?? RadarTheme.mutedText,
                icon: selectedTask.map { CommandDeskTaskStatus.icon(for: $0.status) } ?? "tray"
            )
            CommandDeskStatusPill(
                label: RuntimeStatusPresenter.label(viewModel.syncState.status.rawValue),
                color: RuntimeStatusPresenter.color(for: viewModel.syncState.status.rawValue),
                icon: "externaldrive"
            )
            if let selectedTask {
                Text(selectedTask.prompt)
                    .font(.system(size: 12))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct CommandDeskMetric: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(value)
                .font(.system(size: 18, weight: .semibold, design: .rounded))
                .foregroundStyle(RadarTheme.primaryText)
            Text(label)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(RadarTheme.mutedText)
        }
        .frame(minWidth: 46, alignment: .trailing)
    }
}

private struct CommandDeskStatusPill: View {
    let label: String
    let color: Color
    let icon: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(color.opacity(0.12))
        .overlay(Capsule().strokeBorder(color.opacity(0.20), lineWidth: 1))
        .clipShape(Capsule())
    }
}

private struct CommandDeskQueuePanel: View {
    let tasks: [AgentLongTask]
    @Binding var selectedTaskID: String?
    let openTask: (AgentLongTask) -> Void
    let requestDelete: (AgentLongTask) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("任务栈")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
                Text("\(tasks.count)")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(RadarTheme.tintSoft)
                    .clipShape(Capsule())
            }

            if tasks.isEmpty {
                CommandDeskEmptyPanel(
                    icon: "tray",
                    title: "队列为空",
                    detail: "从底部输入 crypto 研究或 office 草稿任务。"
                )
            } else {
                VStack(spacing: 7) {
                    ForEach(tasks.prefix(8)) { task in
                        CommandDeskTaskRow(
                            task: task,
                            selected: selectedTaskID == task.taskID,
                            select: { selectedTaskID = task.taskID },
                            open: { openTask(task) },
                            delete: { requestDelete(task) }
                        )
                    }
                }
            }
        }
        .padding(16)
        .background(RadarTheme.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct CommandDeskTaskRow: View {
    let task: AgentLongTask
    let selected: Bool
    let select: () -> Void
    let open: () -> Void
    let delete: () -> Void
    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: select) {
            HStack(alignment: .center, spacing: 10) {
                StatusDot(color: CommandDeskTaskStatus.color(for: task.status), pulsing: CommandDeskTaskStatus.isRunning(task.status))
                VStack(alignment: .leading, spacing: 5) {
                    Text(task.prompt)
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(2)
                    HStack(spacing: 6) {
                        Text(CommandDeskTaskStatus.label(for: task.status))
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(CommandDeskTaskStatus.color(for: task.status))
                        Text(task.updatedAt)
                            .font(.system(size: 10.5))
                            .foregroundStyle(RadarTheme.mutedText)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if hovering || selected {
                    HStack(spacing: 5) {
                        Button(action: open) {
                            Image(systemName: "arrow.up.right")
                        }
                        .help("打开任务详情")
                        .buttonStyle(HoverIconButtonStyle(size: 28))
                        Button(action: delete) {
                            Image(systemName: "trash")
                        }
                        .help("删除任务")
                        .buttonStyle(HoverIconButtonStyle(size: 28))
                    }
                }
            }
            .padding(10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable()
        .focused($focused)
        .quietRow(selected: selected || focused, cornerRadius: 12)
        .onHover { hovering = $0 }
        .onTapGesture(count: 2, perform: open)
        .onKeyPress(.return) {
            if selected || focused {
                open()
                return .handled
            }
            return .ignored
        }
        .contextMenu {
            Button("打开任务", action: open)
            Button("删除任务", role: .destructive, action: delete)
        }
    }
}

private struct CommandDeskResultCanvas: View {
    let task: AgentLongTask?
    let finalReadModel: AgentFinalReadModel?
    let cmcSummary: CMCCapabilitySummary?
    let cloudASRSummary: CloudASRSummary?
    let capabilityLoop: CapabilityLoopReadModel?
    let diagnostics: [String]
    let openTask: () -> Void
    let openReview: () -> Void
    let followUp: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .firstTextBaseline) {
                Text("结果画布")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
                if let task {
                    CommandDeskStatusPill(
                        label: CommandDeskTaskStatus.label(for: task.status),
                        color: CommandDeskTaskStatus.color(for: task.status),
                        icon: CommandDeskTaskStatus.icon(for: task.status)
                    )
                }
            }

            if let task {
                VStack(alignment: .leading, spacing: 10) {
                    Text(task.prompt)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(2)
                    Text(previewText)
                        .font(.system(size: 13))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(5)
                        .lineSpacing(3)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if !cmcRenderBlocks.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(cmcRenderBlocks.prefix(2)) { block in
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(block.title ?? "CMC Skill Hub 返回")
                                        .font(.system(size: 11.5, weight: .semibold))
                                        .foregroundStyle(RadarTheme.blue)
                                    Text(block.body)
                                        .font(.system(size: 12.5))
                                        .foregroundStyle(RadarTheme.secondaryText)
                                        .lineLimit(3)
                                        .lineSpacing(2)
                                }
                            }
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RadarTheme.tintFaint)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }

                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 7)], alignment: .leading, spacing: 7) {
                        if let capabilityLoop {
                            CommandDeskStatusPill(label: loopStatus(capabilityLoop), color: RadarTheme.blue, icon: "arrow.triangle.2.circlepath")
                        }
                        if let cmcStatus {
                            CommandDeskStatusPill(label: cmcStatus, color: RadarTheme.blue, icon: "chart.line.uptrend.xyaxis")
                        }
                        if let cloudASRStatus {
                            CommandDeskStatusPill(label: cloudASRStatus, color: RadarTheme.blue, icon: "waveform.badge.magnifyingglass")
                        }
                        if let modelStatus {
                            CommandDeskStatusPill(label: modelStatus, color: RadarTheme.secondaryText, icon: "cpu")
                        }
                        ForEach(diagnostics.prefix(3), id: \.self) { item in
                            CommandDeskStatusPill(label: item, color: diagnosticColor(item), icon: "info.circle")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    HStack(spacing: 8) {
                        Button {
                            openTask()
                        } label: {
                            Label("打开任务", systemImage: "arrow.up.right")
                        }
                        .buttonStyle(ResearchPrimaryButtonStyle())

                        Button {
                            openReview()
                        } label: {
                            Label("人工复核", systemImage: "checkmark.seal")
                        }
                        .buttonStyle(ResearchSecondaryButtonStyle())

                        Button {
                            followUp()
                        } label: {
                            Label("追问", systemImage: "arrowshape.turn.up.left")
                        }
                        .buttonStyle(ResearchSecondaryButtonStyle())
                    }
                }
            } else {
                CommandDeskEmptyPanel(
                    icon: "sparkles",
                    title: "选择或创建一个任务",
                    detail: "这里只展示当前任务的最终答案、草稿状态和下一步动作。"
                )
            }
        }
        .padding(16)
        .background(RadarTheme.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var previewText: String {
        if let text = finalReadModel?.finalText, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return AgentOutputCopy.humanize(text)
        }
        if CommandDeskTaskStatus.isRunning(task?.status ?? "") {
            return "任务正在运行，完成后这里只显示本轮权威答案。"
        }
        return "尚未写入最终答案。"
    }

    private var cmcStatus: String? {
        guard let cmcSummary else { return nil }
        let result = (cmcSummary.renderBlocks?.isEmpty == false ? "renderable" : nil)
            ?? cmcSummary.skillHubDisplayStatus
            ?? cmcSummary.researchEvidenceStatus
            ?? "unknown"
        let prices = cmcSummary.priceSnapshotStatus ?? cmcSummary.diagnostics?.priceSnapshotStatus ?? (cmcSummary.allowConcretePrices == true ? "usable" : "blocked")
        return "CMC Skill Hub · result \(result) · prices \(prices)"
    }

    private var cmcRenderBlocks: [CMCRenderBlock] {
        cmcSummary?.renderBlocks?.filter { !$0.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? []
    }

    private var cloudASRStatus: String? {
        guard let summary = cloudASRSummary else { return nil }
        let status = summary.cloudASRStatus ?? summary.status
        let segments = summary.segmentCount ?? 0
        return "Cloud ASR · \(status) · \(segments) segments"
    }

    private var modelStatus: String? {
        guard let route = finalReadModel?.modelRouteSummary else { return nil }
        let final = route.finalModel ?? route.selectedTextModel
        guard let final, !final.isEmpty else { return nil }
        if route.fallbackUsed == true, let selected = route.selectedTextModel, selected != final {
            return "Model \(final) · fallback from \(selected)"
        }
        return "Model \(final)"
    }

    private func loopStatus(_ loop: CapabilityLoopReadModel) -> String {
        switch loop.loopType {
        case "crypto_market_loop": return "Crypto loop · \(loop.review.status)"
        case "office_work_loop": return "Office loop · \(loop.review.status)"
        case "multi_domain_loop": return "Mixed loop · \(loop.review.status)"
        default: return "Agent loop · \(loop.review.status)"
        }
    }

    private func diagnosticColor(_ item: String) -> Color {
        if item.localizedCaseInsensitiveContains("rewritten") || item.localizedCaseInsensitiveContains("discarded") {
            return RadarTheme.gold
        }
        if item.localizedCaseInsensitiveContains("empty") || item.localizedCaseInsensitiveContains("blocked") {
            return RadarTheme.mutedText
        }
        return RadarTheme.blue
    }
}

private enum CommandDeskMode: String, CaseIterable, Identifiable {
    case crypto = "Crypto"
    case markets = "Markets"
    case office = "Office"

    var id: String { rawValue }

    var title: String { rawValue }

    var icon: String {
        switch self {
        case .crypto: return "chart.line.uptrend.xyaxis"
        case .markets: return "building.columns"
        case .office: return "doc.text"
        }
    }

    var placeholder: String {
        switch self {
        case .crypto:
            return "追问 BTC、ETH、ETF、跨资产相关性，或让 CMC Skill Hub 返回可读结果…"
        case .markets:
            return "追问股票、财报、行业、跨资产 read-through，或让 Markets Research 生成研究草稿…"
        case .office:
            return "拖入会议材料、图片或文档，说明要写纪要、周报、方案或飞书草稿…"
        }
    }

    var quickPrompts: [(String, String)] {
        switch self {
        case .crypto:
            return [
                ("BTC thesis", "帮我复核 BTC 宏观 thesis：ETF 流、跨资产相关性和反证是否支持继续观察空头逻辑，只做研究结论。"),
                ("市场复盘", "总结今天 crypto 重点资产和交易机会，优先引用 CMC Skill Hub 返回内容，不添加未返回的具体价位。"),
                ("追问风险", "基于当前结果继续追问：哪些证据最弱，哪些需要下一轮 CMC 数据补齐？")
            ]
        case .markets:
            return [
                ("Company deep dive", "帮我对 NVDA 做 company deep dive，输出业务质量、财务问题、反证、证据缺口和下一轮复核任务；不要输出 BUY/HOLD/SELL。"),
                ("Earnings review", "帮我复核一家公司最新 earnings：收入质量、margin、guidance、管理层语气、风险和需要补充的材料。"),
                ("Cross-asset", "结合 crypto、equity、sector 和 macro read-through，找出值得继续研究的风险偏好线索，只输出研究候选和复核任务。")
            ]
        case .office:
            return [
                ("会议纪要", "基于我拖入的会议材料，写一版结构化会议纪要：结论、行动项、负责人、风险。"),
                ("文档草稿", "帮我把材料整理成一份可发给团队的文档草稿，语气清晰、克制、可执行。"),
                ("飞书预览", "生成一版飞书文档预览草稿，先不要发布，列出需要我确认的地方。")
            ]
        }
    }

    var launcherActions: [(String, String, String)] {
        switch self {
        case .crypto:
            return [
                ("Market loop", "arrow.triangle.2.circlepath", "启动一轮 CMC Skill Hub 市场扫描，给出可展示摘要、证据缺口和下一轮追问。"),
                ("Thesis review", "checkmark.seal", "复核一个 crypto thesis：只引用 CMC Skill Hub / 群消息 / 链上 evidence，区分可展示结果和价格门禁。"),
                ("Opportunity watch", "scope", "寻找潜在交易机会，但不输出 App 自行生成的入场、止损、止盈或关键价位。")
            ]
        case .markets:
            return [
                ("Company deep dive", "building.columns", "生成公司研究草稿：业务质量、财报线索、竞争格局、证据缺口和下一轮复核任务。"),
                ("Earnings review", "chart.bar.doc.horizontal", "复核 earnings 质量、guidance、管理层语气和异常项，只输出研究草稿。"),
                ("Thesis tracker", "checklist.checked", "把一个股票 thesis 拆成支持证据、反证、待补材料和人工 review 清单。"),
                ("Sector scan", "square.grid.3x3", "扫描行业 read-through，找出值得继续研究的公司、主题和宏观联动。")
            ]
        case .office:
            return [
                ("Meeting notes", "text.badge.checkmark", "整理会议材料为纪要：结论、行动项、owner、deadline、风险和待确认问题。"),
                ("Doc draft", "doc.text", "把拖入材料或口述要求整理成一版团队可读的文档草稿。"),
                ("Feishu preview", "square.and.pencil", "生成飞书文档预览草稿，保持 dry-run，不发布、不回复。")
            ]
        }
    }
}

private struct CommandDeskComposer: View {
    @ObservedObject var viewModel: DashboardViewModel
    let metrics: WorkbenchLayoutMetrics
    @Binding var abilityPalettePresented: Bool
    @FocusState private var focused: Bool
    @State private var mode: CommandDeskMode = .crypto

    private var trimmedPrompt: String {
        viewModel.agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var submitting: Bool {
        viewModel.agentSubmitStatus.localizedCaseInsensitiveContains("submitting")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            composerHeader

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 112), spacing: 7)], alignment: .leading, spacing: 7) {
                ForEach(mode.quickPrompts, id: \.0) { prompt in
                    Button {
                        viewModel.agentPrompt = prompt.1
                        focused = true
                    } label: {
                        Text(prompt.0)
                            .lineLimit(1)
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    .controlSize(.small)
                }
            }

            CommandDeskCapabilityLauncher(mode: mode) { prompt in
                viewModel.agentPrompt = prompt
                focused = true
            }

            composerInput
        }
        .padding(15)
        .background(RadarTheme.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var composerHeader: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                composerTitle
                Spacer(minLength: 12)
                modelPicker
                modePicker
                CommandDeskAbilityStrip(packages: CommandDeskAbilityPackage.workbenchPackages(from: viewModel))
            }
            VStack(alignment: .leading, spacing: 9) {
                composerTitle
                HStack(spacing: 8) {
                    modelPicker
                    modePicker
                    CommandDeskAbilityStrip(packages: CommandDeskAbilityPackage.workbenchPackages(from: viewModel))
                    Spacer(minLength: 0)
                }
            }
        }
    }

    private var composerTitle: some View {
        HStack(spacing: 8) {
            IconChip(systemName: "command", tint: RadarTheme.blue, size: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text("Command Composer")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Text(statusText)
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.mutedText)
            }
        }
    }

    private var modePicker: some View {
        Picker("任务类型", selection: $mode) {
            ForEach(CommandDeskMode.allCases) { item in
                Label(item.title, systemImage: item.icon).tag(item)
            }
        }
        .labelsHidden()
        .pickerStyle(.segmented)
        .frame(width: metrics.isCompact ? 246 : 294)
    }

    private var modelPicker: some View {
        Picker("Model", selection: $viewModel.selectedAgentModelPreference) {
            ForEach(AgentModelPreferenceOption.allCases) { item in
                Text(item.title).tag(item)
            }
        }
        .pickerStyle(.menu)
        .frame(width: metrics.isCompact ? 128 : 168)
        .help("选择文本模型；失败时后端会按安全 fallback 链继续尝试")
    }

    @ViewBuilder
    private var composerInput: some View {
        if metrics.isCompact {
            VStack(alignment: .leading, spacing: 10) {
                promptEditor
                HStack(spacing: 9) {
                    addAbilityButton
                    imageAttachmentButton
                    if mode == .office {
                        mediaAttachmentButton
                    }
                    Spacer(minLength: 0)
                    clearPromptButton
                    submitButton
                }
            }
        } else {
            HStack(alignment: .bottom, spacing: 10) {
                addAbilityButton
                imageAttachmentButton
                if mode == .office {
                    mediaAttachmentButton
                }
                promptEditor
                clearPromptButton
                submitButton
            }
        }
    }

    private var addAbilityButton: some View {
        Button {
            abilityPalettePresented = true
        } label: {
            Label("Add", systemImage: "plus")
        }
        .help("打开能力包")
        .buttonStyle(ResearchSecondaryButtonStyle())
        .popover(isPresented: $abilityPalettePresented, arrowEdge: .bottom) {
            CommandDeskAbilityPalette(viewModel: viewModel)
                .frame(width: 420, height: 430)
        }
    }

    private var imageAttachmentButton: some View {
        Button {
            viewModel.pickAgentImageAttachment()
        } label: {
            Image(systemName: "photo.on.rectangle")
        }
        .help("添加图片附件")
        .buttonStyle(HoverIconButtonStyle(size: 38))
        .disabled(submitting)
    }

    private var mediaAttachmentButton: some View {
        Button {
            viewModel.pickAgentMediaAttachmentForCloudASR()
        } label: {
            Image(systemName: "waveform")
        }
        .help("添加会议音视频附件；将通过云端转写 · 阿里云百炼 · OSS 临时上传")
        .buttonStyle(HoverIconButtonStyle(size: 38))
        .disabled(submitting)
    }

    private var promptEditor: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $viewModel.agentPrompt)
                .font(.system(size: 14))
                .scrollContentBackground(.hidden)
                .foregroundStyle(RadarTheme.primaryText)
                .focused($focused)
                .frame(minHeight: 56, maxHeight: 108)
                .padding(11)
                .background(RadarTheme.tintFaint)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(focused ? RadarTheme.blue.opacity(0.55) : RadarTheme.borderSoft, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .onChange(of: viewModel.agentPrompt) { _, newValue in
                    if newValue.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("/add") {
                        abilityPalettePresented = true
                    }
                }

            if trimmedPrompt.isEmpty {
                Text(mode.placeholder)
                    .font(.system(size: 14))
                    .foregroundStyle(RadarTheme.mutedText)
                    .padding(.horizontal, 17)
                    .padding(.vertical, 20)
                    .allowsHitTesting(false)
            }
        }
    }

    private var clearPromptButton: some View {
        Button {
            viewModel.clearAgentAttachments()
        } label: {
            Image(systemName: "xmark.circle")
        }
        .help("清空附件")
        .buttonStyle(HoverIconButtonStyle(size: 38))
        .disabled(viewModel.agentAttachments.isEmpty || submitting)
    }

    private var submitButton: some View {
        Button {
            viewModel.submitAgentPrompt()
        } label: {
            if submitting {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 20, height: 20)
            } else {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
            }
        }
        .help("提交任务，快捷键 Command Return")
        .buttonStyle(ResearchPrimaryButtonStyle())
        .disabled(trimmedPrompt.isEmpty || submitting)
        .keyboardShortcut(.return, modifiers: [.command])
    }

    private var statusText: String {
        if viewModel.agentAttachments.isEmpty {
            return userStatus(viewModel.agentSubmitStatus)
        }
        return "\(userStatus(viewModel.agentSubmitStatus)) · \(viewModel.agentAttachments.count) 个附件"
    }

    private func userStatus(_ raw: String) -> String {
        if raw.contains("daemon_unavailable") { return "后台服务未连接" }
        if raw.contains("submitting") { return "正在交给 Agent" }
        if raw.contains("run_completed") { return "任务记录已生成" }
        if raw.contains("draft_ready") { return "草稿已填入" }
        if raw.contains("cloud_asr_attachment_ready") { return "云端转写附件已就绪" }
        if raw.contains("prompt_empty") { return "请输入任务" }
        return "就绪"
    }
}

private struct CommandDeskCapabilityLauncher: View {
    let mode: CommandDeskMode
    let launch: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: "square.grid.2x2")
                    .font(.system(size: 10, weight: .semibold))
                Text("Capability Launcher")
                    .font(.system(size: 11, weight: .semibold))
                Text(loopLabel)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(RadarTheme.mutedText)
            }
            .foregroundStyle(RadarTheme.secondaryText)

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 7)], alignment: .leading, spacing: 7) {
                ForEach(mode.launcherActions, id: \.0) { action in
                    Button {
                        launch(action.2)
                    } label: {
                        Label(action.0, systemImage: action.1)
                            .lineLimit(1)
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    .controlSize(.small)
                    .help(action.2)
                }
            }
        }
        .padding(10)
        .background(RadarTheme.tintFaint)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var loopLabel: String {
        switch mode {
        case .crypto: return "Crypto loops"
        case .markets: return "Markets loops"
        case .office: return "Office loops"
        }
    }
}

private struct CommandDeskAbilityStrip: View {
    let packages: [CommandDeskAbilityPackage]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(packages.filter(\.selected).prefix(3)) { item in
                Text(item.title)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.blue)
                    .lineLimit(1)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(RadarTheme.blue.opacity(0.12))
                    .clipShape(Capsule())
            }
            if packages.filter(\.selected).isEmpty {
                Text("可按需添加能力包")
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.mutedText)
            }
        }
    }
}

private struct CommandDeskAbilityPalette: View {
    @ObservedObject var viewModel: DashboardViewModel
    @State private var search = ""

    private var groups: [(String, [CommandDeskAbilityPackage])] {
        let packages = CommandDeskAbilityPackage.workbenchPackages(from: viewModel).filter { item in
            guard !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return true }
            let query = search.lowercased()
            return item.title.lowercased().contains(query) || item.description.lowercased().contains(query)
        }
        let ordered = ["Markets", "Crypto", "Office", "Local"]
        return ordered.compactMap { domain in
            let items = packages.filter { $0.domainLabel == domain }
            return items.isEmpty ? nil : (domain, items)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("能力包")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(RadarTheme.primaryText)
            TextField("搜索能力包", text: $search)
                .textFieldStyle(.roundedBorder)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(groups, id: \.0) { group in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(group.0)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(RadarTheme.mutedText)
                            ForEach(group.1) { item in
                                Button {
                                    toggle(item)
                                } label: {
                                    HStack(alignment: .top, spacing: 10) {
                                        Image(systemName: item.selected ? "checkmark.circle.fill" : "circle")
                                            .foregroundStyle(item.selected ? RadarTheme.blue : RadarTheme.mutedText)
                                            .font(.system(size: 15, weight: .semibold))
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(item.title)
                                                .font(.system(size: 13, weight: .semibold))
                                                .foregroundStyle(RadarTheme.primaryText)
                                                .lineLimit(1)
                                            Text(item.description)
                                                .font(.system(size: 11))
                                                .foregroundStyle(RadarTheme.secondaryText)
                                                .lineLimit(2)
                                        }
                                        Spacer()
                                        Text(item.kindLabel)
                                            .font(.system(size: 10.5, weight: .semibold))
                                            .foregroundStyle(RadarTheme.mutedText)
                                    }
                                    .padding(10)
                                    .quietRow(selected: item.selected, cornerRadius: 11)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
        }
        .padding(16)
        .background(RadarTheme.panel)
    }

    private func toggle(_ item: CommandDeskAbilityPackage) {
        switch item.kind {
        case .skill:
            viewModel.toggleAgentSkill(item.id)
        case .extensionPackage:
            viewModel.toggleAgentExtension(item.id)
        }
    }
}

private struct CommandDeskAbilityPackage: Identifiable, Hashable {
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
    static func workbenchPackages(from viewModel: DashboardViewModel) -> [CommandDeskAbilityPackage] {
        let skills = viewModel.agentSkills.map { skill in
            CommandDeskAbilityPackage(
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
            CommandDeskAbilityPackage(
                id: item.extensionID,
                title: item.title,
                description: item.permissionSummary ?? item.description,
                status: item.status,
                selected: viewModel.selectedAgentExtensionIDs.contains(item.extensionID),
                kind: .extensionPackage,
                category: item.category
            )
        }
        return (skills + extensions).filter(\.isWorkbenchVisible)
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
        if value.contains("markets") || value.contains("equity") || value.contains("stock") || value.contains("sector") || value.contains("earnings") || value.contains("company") || value.contains("thesis") || value.contains("cross-asset") || title.contains("财报") || title.contains("股票") || title.contains("行业") || title.contains("公司") {
            return "Markets"
        }
        if value.contains("office") || value.contains("meeting") || value.contains("document") || title.contains("会议") || title.contains("文档") {
            return "Office"
        }
        if value.contains("cmc") || value.contains("market") || value.contains("token") || value.contains("wechat") || value.contains("onchain") || value.contains("crypto") || title.contains("市场") || title.contains("链上") || title.contains("微信") {
            return "Crypto"
        }
        return "Local"
    }
}

private struct CommandDeskTaskDetailSheet: View {
    let task: AgentLongTask?
    let finalReadModel: AgentFinalReadModel?
    let cmcSummary: CMCCapabilitySummary?
    let cloudASRSummary: CloudASRSummary?
    let capabilityLoop: CapabilityLoopReadModel?
    let memoryReadModel: AgentMemoryReadModel?
    let subagentCoordination: SubagentCoordinationReadModel?
    let initialTab: CommandDeskDetailTab
    let diagnostics: [String]
    @State private var tab: CommandDeskDetailTab = .evidence
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(task?.prompt ?? "任务详情")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(2)
                    Text(task.map { "Run \($0.runID)" } ?? "未选择任务")
                        .font(.system(size: 11))
                        .foregroundStyle(RadarTheme.mutedText)
                }
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(HoverIconButtonStyle(size: 32))
            }

            Picker("Detail", selection: $tab) {
                ForEach(CommandDeskDetailTab.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .pickerStyle(.segmented)

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    switch tab {
                    case .evidence:
                        detailBlock(
                            title: "Evidence",
                            lines: evidenceLines
                        )
                    case .review:
                        detailBlock(
                            title: "Review",
                            lines: reviewLines
                        )
                    case .policy:
                        detailBlock(
                            title: "Policy",
                            lines: policyLines
                        )
                    case .cmc:
                        detailBlock(
                            title: "CMC Skill Hub",
                            lines: cmcLines
                        )
                    case .asr:
                        detailBlock(
                            title: "Cloud ASR",
                            lines: asrLines
                        )
                    case .loop:
                        detailBlock(
                            title: "Capability Loop",
                            lines: loopLines
                        )
                    case .memory:
                        detailBlock(
                            title: "Memory",
                            lines: memoryLines
                        )
                    case .subagents:
                        detailBlock(
                            title: "Subagents",
                            lines: subagentLines
                        )
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(18)
        .background(RadarTheme.background)
        .onAppear {
            tab = initialTab
        }
        .onExitCommand {
            dismiss()
        }
    }

    @ViewBuilder
    private func detailBlock(title: String, lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(RadarTheme.primaryText)
            if lines.isEmpty {
                Text("暂无可展示信息。")
                    .font(.system(size: 13))
                    .foregroundStyle(RadarTheme.secondaryText)
            } else {
                ForEach(lines, id: \.self) { line in
                    HStack(alignment: .top, spacing: 8) {
                        Circle()
                            .fill(RadarTheme.blue)
                            .frame(width: 5, height: 5)
                            .padding(.top, 6)
                        Text(line)
                            .font(.system(size: 13))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RadarTheme.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var evidenceLines: [String] {
        var lines = diagnostics
        if let finalReadModel {
            let answerSource = readableSource(finalReadModel.finalTextSource)
            let answerReview = readableReview(finalReadModel.outputGuardStatus)
            lines.append("答案来源：\(answerSource)")
            lines.append("安全复核：\(answerReview)")
        }
        return lines
    }

    private var reviewLines: [String] {
        var lines: [String] = []
        if let status = finalReadModel?.status {
            lines.append("最终答案状态：\(status)")
        }
        if diagnostics.isEmpty {
            lines.append("暂无复核提示。")
        } else {
            lines.append(contentsOf: diagnostics)
        }
        return lines
    }

    private var policyLines: [String] {
        guard let policy = finalReadModel?.productMutationPolicy else {
            return ["暂无工作台写入策略。"]
        }
        return [
            "工作台写入：\(policy.status)",
            "原因：\(policy.reason ?? "无")"
        ]
    }

    private var cmcLines: [String] {
        guard let cmcSummary else {
            return ["本轮暂无 CMC Skill Hub 摘要。"]
        }
        let evidenceCount = cmcSummary.readableEvidenceCount ?? 0
        return [
            "挂载：\(cmcSummary.mountStatus ?? "unknown")",
            "调用：\(cmcSummary.transportStatus ?? "unknown")",
            "结果：\(cmcSummary.skillHubDisplayStatus ?? cmcSummary.researchEvidenceStatus ?? "unknown")",
            "价格：\(cmcSummary.priceSnapshotStatus ?? "unknown")",
            "结构化证据：\(evidenceCount)"
        ]
    }

    private var asrLines: [String] {
        guard let cloudASRSummary else {
            return ["本轮暂无云端转写摘要。"]
        }
        var lines = [
            "状态：\(cloudASRSummary.cloudASRStatus ?? cloudASRSummary.status)",
            "服务：\(cloudASRSummary.provider ?? "阿里云百炼")",
            "方式：\(cloudASRSummary.userVisibleLabel ?? "云端转写 · 阿里云百炼 · OSS 临时上传")",
            "片段数：\(cloudASRSummary.segmentCount ?? 0)",
            "逐字稿复核：\(cloudASRSummary.needsTranscriptReview == true ? "需要" : "不需要")"
        ]
        if let reason = cloudASRSummary.reason, !reason.isEmpty {
            lines.append("原因：\(reason)")
        }
        return lines
    }

    private var loopLines: [String] {
        guard let capabilityLoop else {
            return ["本轮暂无 loop 摘要。"]
        }
        var lines = [
            "Loop：\(capabilityLoop.title)",
            "复核：\(capabilityLoop.review.status)",
            "下一步动作：\(capabilityLoop.review.actionLabel ?? "Review")"
        ]
        if !capabilityLoop.capabilityPackages.isEmpty {
            lines.append("能力包：\(capabilityLoop.capabilityPackages.map(\.displayName).joined(separator: ", "))")
        }
        if !capabilityLoop.followUpSuggestions.isEmpty {
            lines.append("建议追问：\(capabilityLoop.followUpSuggestions.map(\.title).joined(separator: ", "))")
        }
        return lines
    }

    private var memoryLines: [String] {
        guard let memoryReadModel else {
            return ["本轮暂无记忆摘要。"]
        }
        var lines = [
            "记忆状态：\(memoryReadModel.status)",
            "写入策略：\(memoryReadModel.writePolicy.status)",
            "原因：\(memoryReadModel.reason ?? memoryReadModel.writePolicy.reason ?? "无")"
        ]
        if !memoryReadModel.candidateMemories.isEmpty {
            lines.append("候选记忆：\(memoryReadModel.candidateMemories.map(\.title).joined(separator: ", "))")
        }
        return lines
    }

    private var subagentLines: [String] {
        guard let subagentCoordination else {
            return ["本轮暂无子任务协作摘要。"]
        }
        return [
            "协作状态：\(subagentCoordination.status)",
            "运行模式：\(subagentCoordination.mode)",
            "计划角色：\(subagentCoordination.plannedRoles.joined(separator: ", "))",
            "安全边界：\(subagentCoordination.blockedOperations.isEmpty ? "无额外阻断" : "高影响操作需确认")"
        ]
    }

    private func readableSource(_ source: String) -> String {
        let value = source.lowercased()
        if value.contains("deterministic") { return "结构化答案" }
        if value.contains("model") { return "Agent 答案" }
        if value.contains("artifact") { return "已保存答案" }
        return "答案来源已记录"
    }

    private func readableReview(_ status: String) -> String {
        switch status.lowercased() {
        case "pass", "passed":
            return "通过"
        case "rewritten":
            return "已修订"
        case "blocked":
            return "已阻断"
        default:
            return "已检查"
        }
    }
}

private enum CommandDeskDetailTab: String, CaseIterable, Identifiable {
    case evidence
    case review
    case policy
    case cmc
    case asr
    case loop
    case memory
    case subagents

    var id: String { rawValue }

    var title: String {
        switch self {
        case .evidence: return "Evidence"
        case .review: return "Review"
        case .policy: return "Policy"
        case .cmc: return "CMC"
        case .asr: return "ASR"
        case .loop: return "Loop"
        case .memory: return "Memory"
        case .subagents: return "Subagents"
        }
    }
}

private struct CommandDeskEmptyPanel: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            IconChip(systemName: icon, tint: RadarTheme.mutedText, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Text(detail)
                    .font(.system(size: 12))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(RadarTheme.tintFaint)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private enum CommandDeskTaskStatus {
    static func label(for status: String) -> String {
        let value = status.lowercased()
        if value.contains("blocked") { return "阻断" }
        if value.contains("failed") || value.contains("error") { return "失败" }
        if value.contains("review") { return "待复核" }
        if value.contains("completed") || value.contains("done") { return "完成" }
        if value.contains("running") || value.contains("started") || value.contains("queued") { return "运行中" }
        return RuntimeStatusPresenter.label(status)
    }

    static func icon(for status: String) -> String {
        let value = status.lowercased()
        if value.contains("blocked") || value.contains("failed") || value.contains("error") { return "exclamationmark.triangle" }
        if value.contains("review") { return "checkmark.seal" }
        if value.contains("completed") || value.contains("done") { return "checkmark.circle" }
        if isRunning(status) { return "bolt.horizontal" }
        return "circle"
    }

    static func color(for status: String) -> Color {
        let value = status.lowercased()
        if value.contains("blocked") || value.contains("failed") || value.contains("error") { return RadarTheme.red }
        if value.contains("review") { return RadarTheme.gold }
        if value.contains("completed") || value.contains("done") { return RadarTheme.green }
        if isRunning(status) { return RadarTheme.blue }
        return RadarTheme.mutedText
    }

    static func isRunning(_ status: String) -> Bool {
        let value = status.lowercased()
        return value.contains("running") || value.contains("started") || value.contains("queued") || value.contains("submitted")
    }
}
