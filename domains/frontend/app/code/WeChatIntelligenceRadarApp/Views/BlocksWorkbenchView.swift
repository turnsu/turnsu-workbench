import AppKit
import SwiftUI

struct LoopOpsWorkbenchRunSelection: Hashable {
    let domain: WorkbenchDomain
    let taskID: String
    let acknowledgedRunID: String?
}

enum LoopOpsWorkbenchRunSelectionResolver {
    static func preferredSelection(
        runStates: [WorkbenchLoopRunState],
        selectedDomain: WorkbenchDomain,
        selectedRunID: String?,
        selectedTaskID: String?,
        acknowledgedRunID: String?,
        consumedAcknowledgedRunID: String?
    ) -> LoopOpsWorkbenchRunSelection? {
        if let selectedRunID,
           let run = runStates.first(where: { $0.task.runID == selectedRunID }) {
            return LoopOpsWorkbenchRunSelection(
                domain: run.domain,
                taskID: run.task.taskID,
                acknowledgedRunID: nil
            )
        }

        if let acknowledgedRunID,
           acknowledgedRunID != consumedAcknowledgedRunID,
           let run = runStates.first(where: { $0.task.runID == acknowledgedRunID }) {
            return LoopOpsWorkbenchRunSelection(
                domain: run.domain,
                taskID: run.task.taskID,
                acknowledgedRunID: acknowledgedRunID
            )
        }

        if let selectedTaskID,
           let run = runStates.first(where: { $0.task.taskID == selectedTaskID && $0.domain == selectedDomain }) {
            return LoopOpsWorkbenchRunSelection(domain: run.domain, taskID: run.task.taskID, acknowledgedRunID: nil)
        }

        guard let run = runStates.first(where: { $0.domain == selectedDomain }) else {
            return nil
        }
        return LoopOpsWorkbenchRunSelection(domain: run.domain, taskID: run.task.taskID, acknowledgedRunID: nil)
    }
}

struct BlocksWorkbenchView: View {
    @ObservedObject var viewModel: DashboardViewModel
    let metrics: WorkbenchLayoutMetrics
    @ObservedObject var loopOpsStore: LoopOpsLocalStore

    @State private var selectedDomain: WorkbenchDomain = .crypto
    @State private var selectedTaskID: String?
    @State private var selectedAcknowledgedRunID: String?
    @State private var detailPresented = false
    @State private var detailInitialTab: BlocksWorkbenchDetailTab = .review
    @State private var templatePickerPresented = false
    @State private var deleteCandidate: AgentLongTask?
    @State private var composerContract: LoopContract?
    @State private var reviewGuideExpanded = false

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
        let ledgerStates = loopOpsStore.runLedgers
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

    private var selectedDomainRuns: [WorkbenchLoopRunState] {
        runStates.filter { $0.domain == selectedDomain }
    }

    private var globalActiveQueueRuns: [WorkbenchLoopRunState] {
        runStates
            .filter { run in
                let status = run.task.status.lowercased()
                if BlocksTaskStatus.isRunning(run.task.status) || status.contains("review") {
                    return true
                }
                return !(BlocksTaskStatus.isCompleted(run.task.status)
                    || status.contains("failed")
                    || status.contains("error")
                    || status.contains("cancelled")
                    || status.contains("canceled"))
            }
            .sorted { lhs, rhs in
                if lhs.isRunning != rhs.isRunning { return lhs.isRunning }
                return lhs.task.updatedAt > rhs.task.updatedAt
            }
    }

    private var agentTaskSelectionTokens: [String] {
        viewModel.agentTasks.map { "\($0.taskID)|\($0.runID)|\($0.status)|\($0.updatedAt)" }
            + loopOpsStore.runLedgers.map { "ledger|\($0.runID)|\($0.status)|\($0.completedAt ?? "")" }
    }

    private var selectedRun: WorkbenchLoopRunState? {
        if let selectedTaskID,
           let run = runStates.first(where: { $0.task.taskID == selectedTaskID && $0.domain == selectedDomain }) {
            return run
        }
        return selectedDomainRuns.first
    }

    private var selectedTask: AgentLongTask? {
        selectedRun?.task
    }

    private var selectedContract: LoopContract? {
        let contracts = loopOpsStore.allContractsForDisplay.filter { $0.domain == selectedDomain }
        if let selectedRun,
           let ledger = loopOpsStore.runLedger(runID: selectedRun.task.runID),
           let matching = loopOpsStore.contract(for: ledger) {
            return matching
        }
        if let selectedRun,
           let loopType = selectedRun.capabilityLoop?.loopType,
           let matching = contracts.first(where: { $0.id == loopType || $0.name.localizedCaseInsensitiveContains(loopType) }) {
            return matching
        }
        return selectedRun == nil ? contracts.first : nil
    }

    private var chatScope: ChatScope {
        selectedRun == nil ? .global : .run
    }

    private var chatScopeID: String {
        selectedRun?.task.runID ?? "domain-\(selectedDomain.rawValue)"
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

    private var blocks: [WorkbenchBlock] {
        WorkbenchDomain.allCases.map { domain in
            let runs = runStates.filter { $0.domain == domain }
            return WorkbenchBlock(
                domain: domain,
                activeLoopCount: runs.filter { BlocksTaskStatus.isRunning($0.task.status) }.count,
                reviewCount: runs.filter { $0.task.status.lowercased().contains("review") }.count,
                completedCount: runs.filter { BlocksTaskStatus.isCompleted($0.task.status) }.count
            )
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            BlocksWorkbenchHeader(
                activeLoopCount: runStates.filter(\.isRunning).count,
                selectedDomain: selectedDomain,
                selectedRun: selectedRun,
                finalCount: viewModel.agentFinalReadModelByRunID.count,
                loopCount: loopOpsStore.allContractsForDisplay.count
            )

            mainSurface

            LoopComposer(
                viewModel: viewModel,
                metrics: metrics,
                selectedDomain: $selectedDomain,
                templatePickerPresented: $templatePickerPresented,
                applyTemplate: applyTemplate(_:focusComposer:),
                submitTemplate: submitTemplate(_:),
                submitPrompt: submitCurrentPrompt,
                stageLocalContext: stageComposerContext(_:detail:)
            )
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .onAppear {
            syncRunResultsAndSelection()
        }
        .onChange(of: agentTaskSelectionTokens) { _, _ in
            syncRunResultsAndSelection()
        }
        .onChange(of: viewModel.loopOpsLastAcknowledgedRunID) { _, _ in
            syncRunResultsAndSelection()
        }
        .onChange(of: selectedTaskID) { _, taskID in
            guard let taskID,
                  let run = runStates.first(where: { $0.task.taskID == taskID }) else { return }
            viewModel.selectLoopOpsRun(run.task.runID)
        }
        .sheet(isPresented: $detailPresented) {
            BlocksWorkbenchDetailSheet(
                task: selectedTask,
                finalReadModel: selectedTask.flatMap { viewModel.agentFinalReadModelByRunID[$0.runID] },
                cmcSummary: selectedTask.flatMap { viewModel.agentCMCCapabilitySummaryByRunID[$0.runID] },
                cloudASRSummary: selectedTask.flatMap { viewModel.agentCloudASRSummaryByRunID[$0.runID] },
                capabilityLoop: selectedTask.flatMap { viewModel.agentCapabilityLoopByRunID[$0.runID] },
                memoryReadModel: selectedTask.flatMap { viewModel.agentMemoryReadModelByRunID[$0.runID] },
                subagentCoordination: selectedTask.flatMap { viewModel.agentSubagentCoordinationByRunID[$0.runID] },
                diagnostics: selectedTask.map { viewModel.agentFinalDiagnostics(runID: $0.runID) } ?? [],
                initialTab: detailInitialTab
            )
            .frame(minWidth: 640, minHeight: 540)
        }
        .confirmationDialog("删除这个 loop？", isPresented: deleteConfirmationBinding) {
            Button("删除 loop", role: .destructive) {
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
            Text(deleteCandidate?.prompt ?? "这只会移除本地任务队列记录。")
        }
        .onExitCommand {
            templatePickerPresented = false
            detailPresented = false
        }
    }

    private var blockRail: some View {
        BlocksRail(
            blocks: blocks,
            contracts: loopOpsStore.allContractsForDisplay.filter { $0.domain == selectedDomain },
            activeRuns: globalActiveQueueRuns,
            allRuns: runStates,
            selectedDomain: $selectedDomain,
            selectedTaskID: $selectedTaskID,
            applyContract: applyContract(_:focusComposer:),
            runContract: runContract(_:),
            openRun: openRun(_:),
            deleteRun: { deleteCandidate = $0.task },
            lifecycleAction: applyLifecycleAction(_:action:)
        )
    }

    @ViewBuilder
    private var mainSurface: some View {
        if metrics.isCompact {
            VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                blockRail
                resultColumn
                chatPanel
            }
        } else if metrics.isWide {
            HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                blockRail
                    .frame(width: metrics.queueColumnWidth)
                resultColumn
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                chatPanel
                    .frame(width: metrics.supportColumnWidth)
            }
        } else {
            HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                blockRail
                    .frame(width: metrics.queueColumnWidth)
                VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                    resultColumn
                    chatPanel
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }

    private var resultColumn: some View {
        VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
            LoopOpsWorkbenchResultHeader(
                selectedDomain: selectedDomain,
                selectedRun: selectedRun,
                runCount: selectedDomainRuns.count,
                reviewGuideExpanded: reviewGuideExpanded,
                toggleReviewGuide: {
                    withAnimation(RadarMotion.smooth) {
                        reviewGuideExpanded.toggle()
                    }
                }
            )
            resultCanvas
            if reviewGuideExpanded {
                LoopOpsWorkbenchReviewGuidePanel(openPath: openReviewGuidePath(_:))
            }
        }
    }

    private var resultCanvas: some View {
        BlocksResultCanvas(
            selectedDomain: selectedDomain,
            run: selectedRun,
            finalReadModel: selectedTask.flatMap { viewModel.agentFinalReadModelByRunID[$0.runID] },
            cmcSummary: selectedTask.flatMap { viewModel.agentCMCCapabilitySummaryByRunID[$0.runID] },
            cloudASRSummary: selectedTask.flatMap { viewModel.agentCloudASRSummaryByRunID[$0.runID] },
            capabilityLoop: selectedTask.flatMap { viewModel.agentCapabilityLoopByRunID[$0.runID] },
            ledger: selectedTask.flatMap { loopOpsStore.runLedger(runID: $0.runID) },
            reviewPacket: selectedTask.flatMap { loopOpsStore.reviewPacket(runID: $0.runID) },
            shareSafeLog: selectedTask.flatMap { loopOpsStore.shareSafeLog(runID: $0.runID) },
            runResultState: selectedTask.flatMap { loopOpsStore.runResultState(runID: $0.runID) },
            runChatThread: selectedTask.flatMap { loopOpsStore.existingThread(scope: .run, scopeID: $0.runID) },
            knowledgeSources: selectedTask.map { task in
                loopOpsStore.knowledgeSources.filter { $0.isLinked(toRunID: task.runID) }
            } ?? [],
            toolLogs: selectedTask.map { loopOpsStore.logs(forRunID: $0.runID) } ?? [],
            diagnostics: selectedTask.map { viewModel.agentFinalDiagnostics(runID: $0.runID) } ?? [],
            templates: WorkbenchLoopTemplate.templates(for: selectedDomain),
            openReview: {
                detailInitialTab = .review
                detailPresented = true
            },
            openEvidence: {
                detailInitialTab = .evidence
                detailPresented = true
            },
            followUp: followUpFromSelectedRun,
            applyTemplate: applyTemplate(_:focusComposer:)
        )
    }

    private var chatPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            LoopOpsScopedChatPanel(
                viewModel: viewModel,
                store: loopOpsStore,
                scope: chatScope,
                scopeID: chatScopeID,
                title: selectedRun?.promptTitle ?? "\(selectedDomain.title) control",
                selectedRun: selectedRun,
                selectedContract: selectedContract
            )
            if selectedRun != nil {
                BlocksStatusPill(label: "Locked to Run Chat", color: RadarTheme.blue, icon: "lock.fill")
                    .accessibilityIdentifier(LoopOpsInteractionID.workbenchRunChatLocked)
            }
        }
    }

    private var deleteConfirmationBinding: Binding<Bool> {
        Binding(
            get: { deleteCandidate != nil },
            set: { if !$0 { deleteCandidate = nil } }
        )
    }

    private func syncRunResultsAndSelection() {
        _ = viewModel.reconcileLoopOpsRunResults(in: loopOpsStore)
        guard let selection = LoopOpsWorkbenchRunSelectionResolver.preferredSelection(
            runStates: runStates,
            selectedDomain: selectedDomain,
            selectedRunID: viewModel.selectedLoopOpsRunID,
            selectedTaskID: selectedTaskID,
            acknowledgedRunID: viewModel.loopOpsLastAcknowledgedRunID,
            consumedAcknowledgedRunID: selectedAcknowledgedRunID
        ) else {
            selectedTaskID = nil
            return
        }
        selectedDomain = selection.domain
        selectedTaskID = selection.taskID
        if let runID = runStates.first(where: { $0.task.taskID == selection.taskID })?.task.runID {
            viewModel.selectLoopOpsRun(runID)
        }
        if let acknowledgedRunID = selection.acknowledgedRunID {
            selectedAcknowledgedRunID = acknowledgedRunID
        }
    }

    private func openReviewGuidePath(_ pathID: String) {
        switch pathID {
        case "library":
            viewModel.select(workspace: .inbox)
        case "skill-os":
            viewModel.select(workspace: .skills)
        case "knowledge":
            viewModel.select(workspace: .knowledge)
        case "chat":
            viewModel.select(workspace: .home)
            viewModel.agentPrompt = "Review current run with quick controls."
        default:
            viewModel.select(workspace: .home)
        }
    }

    private func openRun(_ run: WorkbenchLoopRunState) {
        selectedDomain = run.domain
        selectedTaskID = run.task.taskID
        viewModel.selectLoopOpsRun(run.task.runID)
        viewModel.selectAgentSession(run.task.sessionID)
        detailInitialTab = .review
        detailPresented = true
    }

    private func applyTemplate(_ template: WorkbenchLoopTemplate, focusComposer: Bool = true) {
        selectedDomain = template.domain
        composerContract = LoopContract.from(template: template)
        viewModel.agentPrompt = template.prompt
        let templateSkillIDs = Set(WorkbenchLoopTemplate.all.flatMap(\.defaultSkillIDs))
        let templateExtensionIDs = Set(WorkbenchLoopTemplate.all.flatMap(\.defaultExtensionIDs))
        viewModel.selectedAgentSkillIDs.subtract(templateSkillIDs)
        viewModel.selectedAgentExtensionIDs.subtract(templateExtensionIDs)
        for skillID in template.defaultSkillIDs {
            viewModel.selectedAgentSkillIDs.insert(skillID)
        }
        for extensionID in template.defaultExtensionIDs {
            viewModel.selectedAgentExtensionIDs.insert(extensionID)
        }
        viewModel.agentSubmitStatus = "draft_ready:\(template.id)"
        templatePickerPresented = false
    }

    private func applyContract(_ contract: LoopContract, focusComposer: Bool = true) {
        selectedDomain = contract.domain
        composerContract = contract
        viewModel.agentPrompt = contract.promptForRun()
        let contractSkillIDs = Set(loopOpsStore.allContractsForDisplay.flatMap(\.orderedSkillIDs))
        let contractExtensionIDs = Set(loopOpsStore.allContractsForDisplay.flatMap(\.orderedExtensionIDs))
        viewModel.selectedAgentSkillIDs.subtract(contractSkillIDs)
        viewModel.selectedAgentExtensionIDs.subtract(contractExtensionIDs)
        for skillID in contract.orderedSkillIDs {
            viewModel.selectedAgentSkillIDs.insert(skillID)
        }
        for extensionID in contract.orderedExtensionIDs {
            viewModel.selectedAgentExtensionIDs.insert(extensionID)
        }
        viewModel.agentSubmitStatus = "contract_ready:\(contract.id)"
        templatePickerPresented = false
    }

    private func runContract(_ contract: LoopContract) {
        selectedDomain = contract.domain
        composerContract = nil
        viewModel.runLoopContract(contract, loopOpsStore: loopOpsStore)
        templatePickerPresented = false
    }

    private func applyLifecycleAction(_ run: WorkbenchLoopRunState, action: LoopOpsRunLifecycleAction) {
        selectedDomain = run.domain
        selectedTaskID = run.task.taskID
        viewModel.applyLoopOpsRunLifecycleAction(action, runID: run.task.runID, loopOpsStore: loopOpsStore)
    }

    private func submitTemplate(_ template: WorkbenchLoopTemplate) {
        let contract = LoopContract.from(template: template)
        selectedDomain = contract.domain
        composerContract = nil
        viewModel.runLoopContract(contract, loopOpsStore: loopOpsStore, clearComposer: true)
        templatePickerPresented = false
    }

    private func submitCurrentPrompt() {
        let trimmed = viewModel.agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            viewModel.submitAgentPrompt()
            return
        }
        guard let contract = composerContract, contract.isRunnable else {
            viewModel.submitAgentPrompt()
            return
        }

        let canonicalPrompt = contract.promptForRun().trimmingCharacters(in: .whitespacesAndNewlines)
        let additionalInstruction = trimmed == canonicalPrompt ? nil : trimmed
        selectedDomain = contract.domain
        composerContract = nil
        viewModel.runLoopContract(
            contract,
            additionalInstruction: additionalInstruction,
            loopOpsStore: loopOpsStore,
            clearComposer: true
        )
    }

    private func stageComposerContext(_ title: String, detail: String) {
        let line = "[本地上下文] \(title)：\(detail)"
        let trimmed = viewModel.agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        viewModel.agentPrompt = trimmed.isEmpty ? line : "\(trimmed)\n\(line)"
        loopOpsStore.showToast(
            title: "本地上下文已暂存",
            detail: "\(title) 已加入输入区，不会打开系统选择器或权限弹窗。",
            tone: .info
        )
    }

    private func followUpFromSelectedRun() {
        if let loop = selectedTask.flatMap({ viewModel.agentCapabilityLoopByRunID[$0.runID] }),
           let prompt = loop.followUpSuggestions.first?.prompt {
            viewModel.agentPrompt = prompt
            selectedDomain = selectedRun?.domain ?? selectedDomain
            composerContract = selectedContract
            return
        }
        if let selectedTask {
            viewModel.agentPrompt = "基于这个 loop 继续追问：\(selectedTask.prompt)"
            composerContract = selectedContract
        }
    }
}

private struct BlocksWorkbenchHeader: View {
    let activeLoopCount: Int
    let selectedDomain: WorkbenchDomain
    let selectedRun: WorkbenchLoopRunState?
    let finalCount: Int
    let loopCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 18) {
                    titleBlock
                    Spacer(minLength: 12)
                    metricsBlock
                }
                VStack(alignment: .leading, spacing: 10) {
                    titleBlock
                    metricsBlock
                }
            }

            HStack(spacing: 7) {
                BlocksStatusPill(label: selectedDomain.title, color: selectedDomain.tint, icon: selectedDomain.systemImage)
                BlocksStatusPill(label: "\(activeLoopCount) active loops", color: activeLoopCount > 0 ? RadarTheme.blue : RadarTheme.mutedText, icon: "arrow.triangle.2.circlepath")
                if let selectedRun {
                    Text(selectedRun.promptTitle)
                        .font(.system(size: 12))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(1)
                }
            }
        }
        .padding(18)
        .background(RadarTheme.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Workbench")
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(RadarTheme.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.86)
            Text("Run loops, inspect answers, continue in chat and prepare review packets.")
                .font(.system(size: 13))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(2)
        }
    }

    private var metricsBlock: some View {
        HStack(spacing: 12) {
            BlocksMetric(label: "Loops", value: "\(loopCount)")
            BlocksMetric(label: "Active", value: "\(activeLoopCount)")
            BlocksMetric(label: "Answers", value: "\(finalCount)")
        }
    }
}

private struct LoopOpsWorkbenchResultHeader: View {
    let selectedDomain: WorkbenchDomain
    let selectedRun: WorkbenchLoopRunState?
    let runCount: Int
    let reviewGuideExpanded: Bool
    let toggleReviewGuide: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            IconChip(systemName: "rectangle.stack.fill", tint: selectedDomain.tint, size: 34)
            VStack(alignment: .leading, spacing: 4) {
                Text(selectedRun?.promptTitle ?? "\(selectedDomain.title) Run Result")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.86)
                Text(selectedRun == nil ? "Start a Loop from the shelf, then inspect the queue, answer, review packet and Run Chat here." : "Queue, final answer, review packet and Run Chat stay locked to this selected run.")
                    .font(.system(size: 12))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
            }
            Spacer(minLength: 12)
            HStack(spacing: 8) {
                BlocksStatusPill(label: "\(runCount) runs", color: selectedDomain.tint, icon: "list.bullet")
                Button {
                    toggleReviewGuide()
                } label: {
                    Label(reviewGuideExpanded ? "Hide Review Tools" : "Review Tools", systemImage: "checklist.checked")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
            }
        }
        .padding(14)
        .background(RadarTheme.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct LoopOpsReviewGuidePathItem: Identifiable, Hashable {
    let id: String
    let title: String
    let note: String
    let action: String
    let systemImage: String
    let checks: [String]
}

private struct LoopOpsTraceabilityRowItem: Identifiable, Hashable {
    let id: String
    let module: String
    let research: String
    let implementation: String
    let evidence: String
}

private struct LoopOpsEvidenceMapItem: Identifiable, Hashable {
    let id: String
    let source: String
    let applied: String
    let check: String
}

private struct LoopOpsWorkbenchReviewGuidePanel: View {
    let openPath: (String) -> Void

    @AppStorage("loopops.reviewGuide.startedPathIDs") private var startedPathIDsRaw = ""
    @AppStorage("loopops.reviewGuide.checkedPathIDs") private var checkedPathIDsRaw = ""
    @AppStorage("loopops.reviewGuide.reviewDecision") private var reviewDecision = "pending"
    @AppStorage("loopops.reviewGuide.reviewBlockers") private var reviewBlockers = "Native click-through evidence still needs human confirmation."
    @AppStorage("loopops.reviewGuide.reviewNotes") private var reviewNotes = "Check evidence map, traceability, queue isolation, Skill OS tool creation, and Knowledge attach."

    private let paths: [LoopOpsReviewGuidePathItem] = [
        LoopOpsReviewGuidePathItem(
            id: "library",
            title: "Loop Library",
            note: "Marketplace listing, readiness, run records",
            action: "Open Library",
            systemImage: "books.vertical",
            checks: ["Open an installed template detail", "Run a ready row", "Open run record or QA checklist back to result"]
        ),
        LoopOpsReviewGuidePathItem(
            id: "skill-os",
            title: "Skill OS",
            note: "Create Tool, Use validation, History",
            action: "Open Skill OS",
            systemImage: "square.stack.3d.up",
            checks: ["Create Import tool draft", "Check required input validation", "Open history in Review Chat"]
        ),
        LoopOpsReviewGuidePathItem(
            id: "knowledge",
            title: "Knowledge",
            note: "New source, attach, toast feedback",
            action: "Open Knowledge",
            systemImage: "tray.full",
            checks: ["Create a source", "Attach source to latest run", "Confirm Run Chat receipt"]
        ),
        LoopOpsReviewGuidePathItem(
            id: "chat",
            title: "Chat Control",
            note: "Model, Instant, Search, Temporary",
            action: "Open Chat",
            systemImage: "bubble.left.and.text.bubble.right",
            checks: ["Switch Run Chat and Review Chat", "Toggle Search or Temporary", "Send message without cross-run bleed"]
        )
    ]

    private let traceabilityRows: [LoopOpsTraceabilityRowItem] = [
        LoopOpsTraceabilityRowItem(id: "marketplace-loop-library", module: "Marketplace / Loop Library", research: "01 + screenshots 01-03", implementation: "Rows, detail, install, run", evidence: "product walkthrough"),
        LoopOpsTraceabilityRowItem(id: "knowledge-toast", module: "Knowledge / Toast", research: "02 + screenshots 04-05", implementation: "Source, attach, toast", evidence: "product walkthrough"),
        LoopOpsTraceabilityRowItem(id: "tool-skill-os-logs", module: "Skill OS / History", research: "03 + screenshots 06-09", implementation: "Create, Use, History", evidence: "product walkthrough"),
        LoopOpsTraceabilityRowItem(id: "triple-chat-quick-gui", module: "Chat controls", research: "04 + T3 walkthrough", implementation: "Run Chat composer", evidence: "quick controls"),
        LoopOpsTraceabilityRowItem(id: "workbench-run-result", module: "Workbench / Run Result", research: "05 + clickthrough", implementation: "Queue, answer, QA checklist", evidence: "multi-run review"),
        LoopOpsTraceabilityRowItem(id: "studio-skill-path", module: "Studio / Execution Path", research: "LoopOps v2 plan", implementation: "Stack, save, review", evidence: "ordered path"),
        LoopOpsTraceabilityRowItem(id: "no-permission-review", module: "Local-only review", research: "09 + 13", implementation: "Audit, record", evidence: "local-only flow"),
        LoopOpsTraceabilityRowItem(id: "agent-team-process", module: "Agent team process", research: "07 + 14", implementation: "Trace matrix", evidence: "8 modules")
    ]

    private let evidenceRows: [LoopOpsEvidenceMapItem] = [
        LoopOpsEvidenceMapItem(id: "marketplace", source: "Marketplace listing", applied: "Loop rows, readiness, clone and run", check: "Run a ready Loop or open detail"),
        LoopOpsEvidenceMapItem(id: "knowledge", source: "Knowledge and toast", applied: "Source list, attach feedback, transient toast", check: "Create Website source, attach to run"),
        LoopOpsEvidenceMapItem(id: "tool", source: "Tool builder history", applied: "Create Tool, Build, Use and History workflow", check: "Import a tool and open its history"),
        LoopOpsEvidenceMapItem(id: "triple", source: "Chat controls", applied: "Run Chat controls near composer", check: "Toggle Search or Temporary")
    ]

    private var completedCount: Int {
        paths.filter { checkedPathIDs.contains($0.id) }.count
    }

    private var startedPathIDs: Set<String> {
        pathIDSet(from: startedPathIDsRaw)
    }

    private var checkedPathIDs: Set<String> {
        pathIDSet(from: checkedPathIDsRaw)
    }

    private func pathIDSet(from rawValue: String) -> Set<String> {
        Set(rawValue.split(separator: ",").map(String.init))
    }

    private func encodedPathIDs(_ ids: Set<String>) -> String {
        ids.sorted().joined(separator: ",")
    }

    private func markPathStarted(_ id: String) {
        var ids = startedPathIDs
        ids.insert(id)
        startedPathIDsRaw = encodedPathIDs(ids)
    }

    private func togglePathChecked(_ id: String) {
        var startedIDs = startedPathIDs
        var checkedIDs = checkedPathIDs
        if checkedIDs.contains(id) {
            checkedIDs.remove(id)
        } else {
            startedIDs.insert(id)
            checkedIDs.insert(id)
        }
        startedPathIDsRaw = encodedPathIDs(startedIDs)
        checkedPathIDsRaw = encodedPathIDs(checkedIDs)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(alignment: .firstTextBaseline) {
                Label("Review Tools", systemImage: "checklist.checked")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
                Text("\(completedCount)/\(paths.count) checked")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideProgress)
            }

            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 10) {
                    pathList
                    checklist
                }
                VStack(alignment: .leading, spacing: 10) {
                    pathList
                    checklist
                }
            }

            evidenceMap

            traceability

            reviewDecisionBoard
        }
        .padding(13)
        .background(RadarTheme.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuide)
    }

    private var pathList: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(paths) { path in
                Button {
                    markPathStarted(path.id)
                    openPath(path.id)
                } label: {
                    HStack(alignment: .center, spacing: 9) {
                        IconChip(systemName: path.systemImage, tint: RadarTheme.blue, size: 28)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(path.title)
                                .font(.system(size: 12.4, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                            Text(path.note)
                                .font(.system(size: 10.8))
                                .foregroundStyle(RadarTheme.secondaryText)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        Text(path.action)
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(startedPathIDs.contains(path.id) ? RadarTheme.blue : RadarTheme.mutedText)
                    }
                    .padding(9)
                    .quietRow(selected: startedPathIDs.contains(path.id), cornerRadius: 11)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(LoopOpsInteractionID.reviewGuidePath(path.id))
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private var checklist: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(paths) { path in
                VStack(alignment: .leading, spacing: 7) {
                    HStack(alignment: .center, spacing: 8) {
                        Text(path.title)
                            .font(.system(size: 12.2, weight: .semibold))
                            .foregroundStyle(checkedPathIDs.contains(path.id) ? RadarTheme.green : RadarTheme.primaryText)
                        Spacer(minLength: 6)
                        Button(checkedPathIDs.contains(path.id) ? "Checked" : (startedPathIDs.contains(path.id) ? "Mark checked" : "Not started")) {
                            togglePathChecked(path.id)
                        }
                        .font(.system(size: 10.5, weight: .semibold))
                        .buttonStyle(ResearchSecondaryButtonStyle())
                        .accessibilityIdentifier(LoopOpsInteractionID.reviewGuideChecklistDone(path.id))
                    }

                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(path.checks, id: \.self) { check in
                            Label(check, systemImage: checkedPathIDs.contains(path.id) ? "checkmark.circle.fill" : "circle")
                                .font(.system(size: 10.8))
                                .foregroundStyle(checkedPathIDs.contains(path.id) ? RadarTheme.green : RadarTheme.secondaryText)
                                .lineLimit(1)
                        }
                    }
                }
                .padding(9)
                .background(RadarTheme.panelElevated)
                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideChecklist)
    }

    private var evidenceMap: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Evidence map")
                        .font(.system(size: 12.2, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Text("Reference source -> LoopOps check")
                        .font(.system(size: 10.8))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Text("\(evidenceRows.count) sources")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideEvidenceMapCount)
            }

            VStack(alignment: .leading, spacing: 0) {
                ForEach(evidenceRows) { item in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(item.source)
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                                .lineLimit(1)
                            Spacer(minLength: 8)
                            Text(item.check)
                                .font(.system(size: 10.4, weight: .semibold))
                                .foregroundStyle(RadarTheme.blue)
                                .lineLimit(1)
                        }
                        Text(item.applied)
                            .font(.system(size: 10.6))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .lineLimit(2)
                    }
                    .padding(.vertical, 7)
                    .overlay(alignment: .bottom) {
                        Rectangle()
                            .fill(RadarTheme.border.opacity(0.7))
                            .frame(height: 1)
                    }
                    .accessibilityIdentifier(LoopOpsInteractionID.reviewGuideEvidenceRow(item.id))
                }
            }
        }
        .padding(9)
        .background(RadarTheme.panelElevated)
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideEvidenceMap)
    }

    private var reviewDecisionBoard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("复核结论")
                        .font(.system(size: 12.2, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Text(reviewDecisionLabel)
                        .font(.system(size: 10.8, weight: .semibold))
                        .foregroundStyle(reviewDecision == "approved" ? RadarTheme.green : RadarTheme.secondaryText)
                        .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideDecisionStatus)
                }
                Spacer(minLength: 8)
                Text("人工复核")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.secondaryText)
            }

            HStack(spacing: 7) {
                Button("Set pending") { reviewDecision = "pending" }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideDecisionPending)
                Button("Mark needs work") { reviewDecision = "needs_work" }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideDecisionNeedsWork)
                Button("Mark approved") { reviewDecision = "approved" }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideDecisionApproved)
            }
            .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideDecisionControls)

            VStack(alignment: .leading, spacing: 5) {
                Text("阻断项")
                    .font(.system(size: 10.6, weight: .semibold))
                    .foregroundStyle(RadarTheme.secondaryText)
                TextField("阻断项", text: $reviewBlockers)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 10.8))
                    .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideDecisionBlockers)
            }

            VStack(alignment: .leading, spacing: 5) {
                Text("备注")
                    .font(.system(size: 10.6, weight: .semibold))
                    .foregroundStyle(RadarTheme.secondaryText)
                TextField("备注", text: $reviewNotes)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 10.8))
                    .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideDecisionNotes)
            }

            Text("该面板只保留当前 Swift 参考界面的本地审阅笔记，不作为产品功能或发布签收证据。")
                .font(.system(size: 10.8))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(2)
                .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideDecisionRecord)
        }
        .padding(9)
        .background(RadarTheme.panelElevated)
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideDecision)
    }

    private var reviewDecisionLabel: String {
        switch reviewDecision {
        case "approved":
            return "Approved by reviewer"
        case "needs_work":
            return "Needs work"
        default:
            return "Pending human review"
        }
    }

    private var traceability: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Agent team traceability")
                        .font(.system(size: 12.2, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Text("Research -> source -> evidence -> manual review")
                        .font(.system(size: 10.8))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Text("\(traceabilityRows.count) modules")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideTraceabilityCount)
            }

            VStack(alignment: .leading, spacing: 0) {
                ForEach(traceabilityRows) { item in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(item.module)
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                                .lineLimit(1)
                            Spacer(minLength: 8)
                            Text(item.evidence)
                                .font(.system(size: 10.4, weight: .semibold))
                                .foregroundStyle(RadarTheme.blue)
                                .lineLimit(1)
                        }
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(item.research)
                                .font(.system(size: 10.6))
                                .foregroundStyle(RadarTheme.secondaryText)
                                .lineLimit(1)
                            Text(item.implementation)
                                .font(.system(size: 10.6))
                                .foregroundStyle(RadarTheme.secondaryText)
                                .lineLimit(1)
                        }
                    }
                    .padding(.vertical, 7)
                    .overlay(alignment: .bottom) {
                        Rectangle()
                            .fill(RadarTheme.border.opacity(0.7))
                            .frame(height: 1)
                    }
                    .accessibilityIdentifier(LoopOpsInteractionID.reviewGuideTraceabilityRow(item.id))
                }
            }
        }
        .padding(9)
        .background(RadarTheme.panelElevated)
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .accessibilityIdentifier(LoopOpsInteractionID.workbenchReviewGuideTraceability)
    }
}

private struct BlocksMetric: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(value)
                .font(.system(size: 17, weight: .semibold, design: .rounded))
                .foregroundStyle(RadarTheme.primaryText)
            Text(label)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(RadarTheme.mutedText)
        }
        .frame(minWidth: 48, alignment: .trailing)
    }
}

private struct BlocksRail: View {
    let blocks: [WorkbenchBlock]
    let contracts: [LoopContract]
    let activeRuns: [WorkbenchLoopRunState]
    let allRuns: [WorkbenchLoopRunState]
    @Binding var selectedDomain: WorkbenchDomain
    @Binding var selectedTaskID: String?
    let applyContract: (LoopContract, Bool) -> Void
    let runContract: (LoopContract) -> Void
    let openRun: (WorkbenchLoopRunState) -> Void
    let deleteRun: (WorkbenchLoopRunState) -> Void
    let lifecycleAction: (WorkbenchLoopRunState, LoopOpsRunLifecycleAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Loop Shelf")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(RadarTheme.primaryText)

            VStack(spacing: 7) {
                ForEach(blocks) { block in
                    Button {
                        selectedDomain = block.domain
                        selectedTaskID = allRuns.first(where: { $0.domain == block.domain })?.task.taskID
                    } label: {
                        BlocksDomainRow(block: block, selected: selectedDomain == block.domain)
                    }
                    .buttonStyle(.plain)
                }
            }

            Divider().overlay(RadarTheme.borderSoft)

            HStack {
                Text("Loop Pages")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
                Text("\(contracts.count)")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
            }

            VStack(spacing: 7) {
                ForEach(contracts.prefix(6)) { contract in
                    Button {
                        runContract(contract)
                    } label: {
                        BlocksContractRow(contract: contract)
                    }
                    .buttonStyle(.plain)
                    .help("Run in background\n\(contract.trigger)\nReview rule: \(contract.feedbackGate)\nExit: \(contract.exitCondition)")
                    .accessibilityIdentifier(LoopOpsInteractionID.workbenchContractRun(contract.id))
                    .contextMenu {
                        Button("Run") { runContract(contract) }
                        Button("Use in composer") { applyContract(contract, true) }
                    }
                }
            }

            Divider().overlay(RadarTheme.borderSoft)

            HStack {
                Text("Active Queue")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
                Text("\(activeRuns.count)")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
            }

            if activeRuns.isEmpty {
                BlocksEmptyRow(
                    icon: "tray",
                    title: "No queued runs",
                    detail: "Click a loop contract to run it in the background."
                )
                .accessibilityIdentifier(LoopOpsInteractionID.workbenchActiveQueue)
            } else {
                VStack(spacing: 7) {
                    ForEach(activeRuns) { run in
                        BlocksRunRow(
                            run: run,
                            selected: selectedTaskID == run.task.taskID,
                            select: {
                                selectedTaskID = run.task.taskID
                                selectedDomain = run.domain
                            },
                            open: { openRun(run) },
                            delete: { deleteRun(run) },
                            lifecycleAction: { action in lifecycleAction(run, action) }
                        )
                    }
                }
                .accessibilityIdentifier(LoopOpsInteractionID.workbenchActiveQueue)
            }
        }
        .padding(15)
        .background(RadarTheme.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct BlocksDomainRow: View {
    let block: WorkbenchBlock
    let selected: Bool

    var body: some View {
        HStack(spacing: 10) {
            IconChip(systemName: block.domain.systemImage, tint: block.domain.tint, size: 30)
            VStack(alignment: .leading, spacing: 3) {
                Text(block.domain.title)
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Text(block.domain.subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Text(block.statusText)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(selected ? block.domain.tint : RadarTheme.mutedText)
        }
        .padding(10)
        .quietRow(selected: selected, cornerRadius: 12)
    }
}

private struct BlocksContractRow: View {
    let contract: LoopContract

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: contract.domain.systemImage)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(contract.domain.tint)
                .frame(width: 20, height: 20)
            VStack(alignment: .leading, spacing: 3) {
                Text(contract.name)
                    .font(.system(size: 12.8, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(1)
                Text(contract.goal)
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
                Text(contract.trigger)
                    .font(.system(size: 10.5))
                    .foregroundStyle(RadarTheme.mutedText)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .quietRow(cornerRadius: 11)
    }
}

private struct BlocksRunRow: View {
    let run: WorkbenchLoopRunState
    let selected: Bool
    let select: () -> Void
    let open: () -> Void
    let delete: () -> Void
    let lifecycleAction: (LoopOpsRunLifecycleAction) -> Void
    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            StatusDot(color: BlocksTaskStatus.color(for: run.task.status), pulsing: run.isRunning)
            VStack(alignment: .leading, spacing: 4) {
                Text(run.promptTitle)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(run.statusLabel)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(BlocksTaskStatus.color(for: run.task.status))
                    Text(run.domain.title)
                        .font(.system(size: 10.5))
                        .foregroundStyle(RadarTheme.mutedText)
                }
                HStack(spacing: 5) {
                    ForEach(LoopOpsRunLifecycleAction.visibleActions(for: run.task.status)) { action in
                        Button {
                            lifecycleAction(action)
                        } label: {
                            Image(systemName: action.systemImage)
                        }
                        .help(action.title)
                        .buttonStyle(HoverIconButtonStyle(size: 24))
                        .accessibilityIdentifier(LoopOpsInteractionID.workbenchRunLifecycleAction(runID: run.task.runID, action: action))
                    }
                }
            }
            Spacer(minLength: 0)
            if hovering || selected {
                HStack(spacing: 5) {
                    Button(action: open) {
                        Image(systemName: "arrow.up.right")
                    }
                    .help("打开 loop 详情")
                    .buttonStyle(HoverIconButtonStyle(size: 28))
                    Button(action: delete) {
                        Image(systemName: "trash")
                    }
                    .help("删除 loop")
                    .buttonStyle(HoverIconButtonStyle(size: 28))
                }
            }
        }
        .padding(10)
        .contentShape(Rectangle())
        .focusable()
        .focused($focused)
        .quietRow(selected: selected || focused, cornerRadius: 12)
        .onHover { hovering = $0 }
        .onTapGesture(perform: select)
        .onTapGesture(count: 2, perform: open)
        .onKeyPress(.return) {
            if selected || focused {
                open()
                return .handled
            }
            return .ignored
        }
        .contextMenu {
            ForEach(LoopOpsRunLifecycleAction.visibleActions(for: run.task.status)) { action in
                Button(action.title) { lifecycleAction(action) }
            }
            Divider()
            Button("打开 loop", action: open)
            Button("删除 loop", role: .destructive, action: delete)
        }
        .accessibilityIdentifier(LoopOpsInteractionID.workbenchActiveQueueRow(run.task.runID))
    }
}

private struct LoopOpsRunOverviewCard: View {
    let run: WorkbenchLoopRunState
    let domain: WorkbenchDomain
    let answerStatus: String
    let capabilityLoop: CapabilityLoopReadModel?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                IconChip(systemName: domain.systemImage, tint: domain.tint, size: 32)
                VStack(alignment: .leading, spacing: 4) {
                    Text(run.promptTitle)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(2)
                    Text(subtitle)
                        .font(.system(size: 11.5))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                BlocksStatusPill(
                    label: run.statusLabel,
                    color: BlocksTaskStatus.color(for: run.task.status),
                    icon: BlocksTaskStatus.icon(for: run.task.status)
                )
            }

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 7)], alignment: .leading, spacing: 7) {
                LoopOpsMiniMetric(label: "Domain", value: domain.title)
                LoopOpsMiniMetric(label: "Answer", value: answerStatus)
                LoopOpsMiniMetric(label: "Review", value: capabilityLoop?.review.status ?? run.reviewLabel)
            }
        }
        .padding(12)
        .background(RadarTheme.panelElevated)
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    private var subtitle: String {
        if let goal = capabilityLoop?.userGoal?.trimmingCharacters(in: .whitespacesAndNewlines), !goal.isEmpty {
            return goal
        }
        return "Latest \(domain.title) loop result and review state."
    }
}

private struct LoopOpsRunResultObjectStrip: View {
    let run: WorkbenchLoopRunState
    let answerStatus: String
    let hasReviewPacket: Bool
    let hasShareSafeLog: Bool
    let knowledgeCount: Int
    let toolLogCount: Int
    let chatMessageCount: Int
    let readiness: LoopOpsRunResultReadiness?

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 7)], alignment: .leading, spacing: 7) {
            BlocksStatusPill(label: blocksLoopOpsRunInstanceLabel(run.task.runID), color: RadarTheme.secondaryText, icon: "number")
            if let readiness {
                BlocksStatusPill(label: readiness.title, color: readinessColor, icon: readinessIcon)
            }
            BlocksStatusPill(label: "Answer \(answerStatus)", color: RadarTheme.blue, icon: "doc.text")
            BlocksStatusPill(label: hasReviewPacket ? "Review Packet ready" : "Review Packet pending", color: hasReviewPacket ? RadarTheme.green : RadarTheme.gold, icon: "checkmark.seal")
            BlocksStatusPill(label: hasShareSafeLog ? "Share log ready" : "Share log pending", color: hasShareSafeLog ? RadarTheme.green : RadarTheme.mutedText, icon: "square.and.arrow.up")
            BlocksStatusPill(label: "\(knowledgeCount) sources", color: knowledgeCount > 0 ? RadarTheme.green : RadarTheme.mutedText, icon: "link")
            BlocksStatusPill(label: "\(toolLogCount) tool logs", color: toolLogCount > 0 ? RadarTheme.blue : RadarTheme.mutedText, icon: "clock.arrow.circlepath")
            BlocksStatusPill(label: "\(chatMessageCount) chat messages", color: RadarTheme.blue, icon: "bubble.left.and.text.bubble.right")
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RadarTheme.panelElevated.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
    }

    private var readinessColor: Color {
        switch readiness {
        case .ready: return RadarTheme.green
        case .needsReview: return RadarTheme.gold
        case .blocked: return RadarTheme.red
        case .waiting, nil: return RadarTheme.mutedText
        }
    }

    private var readinessIcon: String {
        switch readiness {
        case .ready: return "checkmark.circle"
        case .needsReview: return "person.crop.circle.badge.questionmark"
        case .blocked: return "hand.raised"
        case .waiting, nil: return "clock"
        }
    }
}

private struct LoopOpsRunTypedStatePanel: View {
    let state: LoopOpsRunResultState

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label("Result State", systemImage: "list.bullet.rectangle")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
                BlocksStatusPill(label: state.readiness.title, color: readinessColor, icon: readinessIcon)
            }

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 7)], alignment: .leading, spacing: 7) {
                LoopOpsMiniMetric(label: "Attempts", value: "\(state.attempts.count)")
                LoopOpsMiniMetric(label: "Review", value: state.reviewDecision)
                LoopOpsMiniMetric(label: "Run Chat", value: "\(state.runChatMessageCount) messages")
                LoopOpsMiniMetric(label: "Objects", value: "\(state.knowledgeSourceIDs.count + state.toolLogIDs.count) linked")
            }

            if !state.skillPath.isEmpty {
                Text(state.skillPath.prefix(5).joined(separator: " -> "))
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
            }

            if let latestAttempt = state.attempts.sorted(by: { $0.order < $1.order }).last {
                Text("\(latestAttempt.title): \(latestAttempt.detail)")
                    .font(.system(size: 11.5))
                    .foregroundStyle(RadarTheme.mutedText)
                    .lineLimit(2)
            }
        }
        .padding(12)
        .background(RadarTheme.panelElevated.opacity(0.46))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
    }

    private var readinessColor: Color {
        switch state.readiness {
        case .ready: return RadarTheme.green
        case .needsReview: return RadarTheme.gold
        case .blocked: return RadarTheme.red
        case .waiting: return RadarTheme.mutedText
        }
    }

    private var readinessIcon: String {
        switch state.readiness {
        case .ready: return "checkmark.circle"
        case .needsReview: return "person.crop.circle.badge.questionmark"
        case .blocked: return "hand.raised"
        case .waiting: return "clock"
        }
    }
}

private struct LoopOpsResolvedRunAnswer {
    var text: String
    var source: String?
    var outputGuardStatus: String?
    var isPending: Bool
    var statusLabel: String
}

private struct LoopOpsFinalAnswerCard: View {
    let text: String
    let source: String?
    let outputGuardStatus: String?
    let pending: Bool
    let running: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label("Authoritative Answer", systemImage: "doc.text")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
                BlocksStatusPill(label: statusLabel, color: statusColor, icon: statusIcon)
            }
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(pending ? RadarTheme.secondaryText : RadarTheme.primaryText)
                .lineLimit(pending ? 3 : 12)
                .lineSpacing(3)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 7) {
                if let source, !source.isEmpty {
                    BlocksStatusPill(label: readableSourceLabel(source), color: RadarTheme.secondaryText, icon: "checkmark.seal")
                }
                if let outputGuardStatus, !outputGuardStatus.isEmpty {
                    BlocksStatusPill(label: readableGuardLabel(outputGuardStatus), color: outputGuardStatus == "pass" ? RadarTheme.green : RadarTheme.gold, icon: "shield")
                }
            }
        }
        .padding(12)
        .background(RadarTheme.tintFaint)
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    private var statusLabel: String {
        if running { return "running" }
        return pending ? "waiting" : "final"
    }

    private var statusIcon: String {
        if running { return "arrow.triangle.2.circlepath" }
        return pending ? "clock" : "checkmark.circle"
    }

    private var statusColor: Color {
        if running { return RadarTheme.blue }
        return pending ? RadarTheme.mutedText : RadarTheme.green
    }

    private func readableSourceLabel(_ source: String) -> String {
        let value = source.lowercased()
        if value.contains("deterministic") { return "structured answer" }
        if value.contains("model") { return "agent answer" }
        if value.contains("artifact") { return "saved answer" }
        return "answer source"
    }

    private func readableGuardLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "pass", "passed":
            return "safety clear"
        case "rewritten":
            return "safety revised"
        case "blocked":
            return "safety blocked"
        default:
            return "safety checked"
        }
    }
}

private struct LoopOpsReviewBoundaryCard: View {
    let domain: WorkbenchDomain
    let capabilityLoop: CapabilityLoopReadModel?
    let finalReadModel: AgentFinalReadModel?
    let cmcSummary: CMCCapabilitySummary?
    let cloudASRSummary: CloudASRSummary?

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Label("复核边界", systemImage: "checkmark.shield")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
                BlocksStatusPill(label: reviewStatus, color: domain.tint, icon: "person.crop.circle.badge.checkmark")
            }
            Text(boundaryText)
                .font(.system(size: 11.8))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(4)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 7)], alignment: .leading, spacing: 7) {
                ForEach(boundaryFacts, id: \.self) { fact in
                    BlocksStatusPill(label: fact, color: RadarTheme.secondaryText, icon: "checkmark.circle")
                }
            }
        }
        .padding(12)
        .background(domain.tint.opacity(0.07))
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(domain.tint.opacity(0.16), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    private var reviewStatus: String {
        capabilityLoop?.review.status ?? finalReadModel?.status ?? "pending"
    }

    private var boundaryText: String {
        switch domain {
        case .crypto:
            return "Research and trade-plan drafts are QA-only. No Trading Zac, dry-run, live trading, WeChat send, or external publish."
        case .markets:
            return "Research drafts can be reviewed, cloned, and continued. The App does not turn them into execution advice."
        case .office:
            return "Drafts and meeting outputs require review before delivery; Feishu publish/reply remains confirmation-gated."
        }
    }

    private var boundaryFacts: [String] {
        var facts: [String] = []
        if let mutation = finalReadModel?.productMutationPolicy?.status {
            facts.append("mutations \(mutation)")
        }
        if let priceStatus = cmcSummary?.priceSnapshotStatus {
            facts.append("prices \(priceStatus)")
        }
        if let asr = cloudASRSummary?.cloudASRStatus {
            facts.append("ASR \(asr)")
        }
        if facts.isEmpty {
            facts.append("manual review")
        }
        return facts
    }
}

private struct LoopOpsMiniMetric: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(RadarTheme.mutedText)
            Text(value)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(RadarTheme.primaryText)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct BlocksResultCanvas: View {
    let selectedDomain: WorkbenchDomain
    let run: WorkbenchLoopRunState?
    let finalReadModel: AgentFinalReadModel?
    let cmcSummary: CMCCapabilitySummary?
    let cloudASRSummary: CloudASRSummary?
    let capabilityLoop: CapabilityLoopReadModel?
    let ledger: RunLedgerRow?
    let reviewPacket: ReviewPacketViewModel?
    let shareSafeLog: ShareSafeLogPreview?
    let runResultState: LoopOpsRunResultState?
    let runChatThread: ChatThread?
    let knowledgeSources: [LoopOpsKnowledgeSource]
    let toolLogs: [LoopOpsToolLog]
    let diagnostics: [String]
    let templates: [WorkbenchLoopTemplate]
    let openReview: () -> Void
    let openEvidence: () -> Void
    let followUp: () -> Void
    let applyTemplate: (WorkbenchLoopTemplate, Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(canvasTitle)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Text(canvasSubtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(2)
                }
                Spacer()
                if let run {
                    BlocksStatusPill(label: run.statusLabel, color: BlocksTaskStatus.color(for: run.task.status), icon: BlocksTaskStatus.icon(for: run.task.status))
                }
            }

            if let run {
                selectedRunContent(run)
            } else {
                emptyDomainContent
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(RadarTheme.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityIdentifier(LoopOpsInteractionID.workbenchRunResult)
    }

    private var canvasTitle: String {
        "\(selectedDomain.title) Run Result"
    }

    private var canvasSubtitle: String {
        switch selectedDomain {
        case .crypto:
            return "Market data、price context、evidence gaps and review notes."
        case .markets:
            return "Equity / macro / cross-asset draft、evidence gaps 和 review tasks。"
        case .office:
            return "Meeting transcript、document draft、review state and delivery preview."
        }
    }

    private func selectedRunContent(_ run: WorkbenchLoopRunState) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            LoopOpsRunOverviewCard(
                run: run,
                domain: selectedDomain,
                answerStatus: resolvedAnswer.statusLabel,
                capabilityLoop: capabilityLoop
            )

            LoopOpsRunResultObjectStrip(
                run: run,
                answerStatus: runResultState?.finalAnswerStatus ?? resolvedAnswer.statusLabel,
                hasReviewPacket: runResultState?.reviewPacketID != nil || reviewPacket != nil,
                hasShareSafeLog: runResultState?.shareSafeLogID != nil || shareSafeLog != nil,
                knowledgeCount: runResultState?.knowledgeSourceIDs.count ?? knowledgeSources.count,
                toolLogCount: runResultState?.toolLogIDs.count ?? toolLogs.count,
                chatMessageCount: runResultState?.runChatMessageCount ?? runChatThread?.messages.count ?? 0,
                readiness: runResultState?.readiness
            )

            if let runResultState {
                LoopOpsRunTypedStatePanel(state: runResultState)
            }

            LoopOpsFinalAnswerCard(
                text: resolvedAnswer.text,
                source: resolvedAnswer.source,
                outputGuardStatus: resolvedAnswer.outputGuardStatus,
                pending: resolvedAnswer.isPending,
                running: BlocksTaskStatus.isRunning(run.task.status)
            )

            if finalReadModel != nil {
                domainRenderBlocks
            }

            LoopOpsReviewBoundaryCard(
                domain: selectedDomain,
                capabilityLoop: capabilityLoop,
                finalReadModel: finalReadModel,
                cmcSummary: cmcSummary,
                cloudASRSummary: cloudASRSummary
            )

            loopOpsArtifactSections(run)

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 7)], alignment: .leading, spacing: 7) {
                if let capabilityLoop {
                    BlocksStatusPill(label: loopStatus(capabilityLoop), color: selectedDomain.tint, icon: "arrow.triangle.2.circlepath")
                }
                if let cmcStatus {
                    BlocksStatusPill(label: cmcStatus, color: RadarTheme.blue, icon: "chart.line.uptrend.xyaxis")
                }
                if let cloudASRStatus {
                    BlocksStatusPill(label: cloudASRStatus, color: RadarTheme.green, icon: "waveform.badge.magnifyingglass")
                }
                if let modelStatus {
                    BlocksStatusPill(label: modelStatus, color: RadarTheme.secondaryText, icon: "cpu")
                }
                ForEach(diagnostics.prefix(3), id: \.self) { item in
                    BlocksStatusPill(label: item, color: diagnosticColor(item), icon: "info.circle")
                }
            }

            HStack(spacing: 8) {
                Button(action: followUp) {
                    Label("Continue", systemImage: "arrowshape.turn.up.left")
                }
                .buttonStyle(ResearchPrimaryButtonStyle())

                Button(action: openReview) {
                    Label(run.reviewLabel, systemImage: "checkmark.seal")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())

                Button(action: openEvidence) {
                    Label("Evidence", systemImage: "doc.text.magnifyingglass")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
            }
        }
    }

    private func loopOpsArtifactSections(_ run: WorkbenchLoopRunState) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let ledger {
                LoopOpsRunTimelinePanel(ledger: ledger)
            }
            if let packet = reviewPacket {
                LoopOpsRunReviewPacketPanel(packet: packet)
            }
            if let shareSafeLog {
                LoopOpsRunArtifactPanel(
                    icon: "square.and.arrow.up",
                    title: "Share Preview",
                    trailing: "redacted",
                    rows: [
                        ("Summary", shareSafeLog.redactedLoopSummary),
                        ("Excerpt", shareSafeLog.finalAnswerExcerpt),
                        ("Omitted", shareSafeLog.omittedSensitiveFieldsSummary)
                    ]
                )
            }
            if !knowledgeSources.isEmpty {
                LoopOpsRunArtifactPanel(
                    icon: "link.badge.plus",
                    title: "Knowledge",
                    trailing: "\(knowledgeSources.count)",
                    rows: knowledgeSources.map { ($0.title, "\($0.kind.title) · \($0.summary)") }
                )
            }
            if !toolLogs.isEmpty {
                LoopOpsRunArtifactPanel(
                    icon: "clock.arrow.circlepath",
                    title: "Run Tool Logs",
                    trailing: "\(toolLogs.count)",
                    rows: toolLogs.prefix(4).map { ($0.publicTitle, "\($0.publicStatusLabel) · \($0.publicOutputOrErrorSummary)") }
                )
            }
            LoopOpsRunArtifactPanel(
                icon: "bubble.left.and.text.bubble.right",
                title: "Run Chat",
                trailing: "locked",
                rows: [
                    ("Scope", "Locked to the selected run result."),
                    ("Messages", "\(runChatThread?.messages.count ?? 0) saved messages"),
                    ("Latest", runChatThread?.messages.last?.text ?? "No Run Chat message yet.")
                ]
            )
        }
    }

    @ViewBuilder
    private var domainRenderBlocks: some View {
        if selectedDomain == .crypto, !cmcRenderBlocks.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                ForEach(cmcRenderBlocks.prefix(3)) { block in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(AgentOutputCopy.humanize(block.title ?? "CMC Skill Hub 返回"))
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(RadarTheme.blue)
                        Text(AgentOutputCopy.humanize(block.body))
                            .font(.system(size: 12.5))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .lineLimit(4)
                            .lineSpacing(2)
                    }
                    if block.id != cmcRenderBlocks.prefix(3).last?.id {
                        Divider().overlay(RadarTheme.borderSoft)
                    }
                }
            }
            .padding(11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RadarTheme.tintFaint)
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        }

        if selectedDomain == .office, let summary = cloudASRSummary {
            BlocksInfoStrip(
                icon: "waveform.badge.magnifyingglass",
                tint: RadarTheme.green,
                title: summary.userVisibleLabel ?? "云端转写 · 阿里云百炼 · OSS 临时上传",
                detail: "Status \(summary.cloudASRStatus ?? summary.status), segments \(summary.segmentCount ?? 0), review \(summary.needsTranscriptReview == true ? "needed" : "clear")"
            )
        }

        if selectedDomain == .markets {
            BlocksInfoStrip(
                icon: "checklist.checked",
                tint: RadarTheme.indigo,
                title: "Markets research draft",
                detail: "输出研究草稿、反证、证据缺口和下一轮复核任务，不展示 BUY/HOLD/SELL。"
            )
        }
    }

    private var emptyDomainContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            BlocksEmptyRow(
                icon: selectedDomain.systemImage,
                title: "选择一个 \(selectedDomain.title) loop",
                detail: selectedDomain.placeholder
            )
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 8)], alignment: .leading, spacing: 8) {
                ForEach(templates) { template in
                    Button {
                        applyTemplate(template, true)
                    } label: {
                        BlocksTemplateCard(template: template)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var resolvedAnswer: LoopOpsResolvedRunAnswer {
        if let text = finalReadModel?.finalText.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            return LoopOpsResolvedRunAnswer(
                text: AgentOutputCopy.humanize(text),
                source: finalReadModel?.finalTextSource,
                outputGuardStatus: finalReadModel?.outputGuardStatus,
                isPending: false,
                statusLabel: "authoritative"
            )
        }
        if let text = reviewPacket?.finalAnswer.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            return LoopOpsResolvedRunAnswer(
                text: AgentOutputCopy.humanize(text),
                source: "review packet",
                outputGuardStatus: reviewPacket?.reviewDecision,
                isPending: false,
                statusLabel: "review packet"
            )
        }
        if let text = runResultState?.finalAnswer.trimmingCharacters(in: .whitespacesAndNewlines),
           !text.isEmpty,
           runResultState?.finalAnswerStatus != "Waiting" {
            return LoopOpsResolvedRunAnswer(
                text: AgentOutputCopy.humanize(text),
                source: "result state",
                outputGuardStatus: runResultState?.reviewDecision,
                isPending: false,
                statusLabel: runResultState?.finalAnswerStatus.lowercased() ?? "saved"
            )
        }
        if let text = ledger?.finalAnswerPreview.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            return LoopOpsResolvedRunAnswer(
                text: AgentOutputCopy.humanize(text),
                source: "saved answer",
                outputGuardStatus: ledger?.reviewDecision,
                isPending: false,
                statusLabel: "saved"
            )
        }
        if BlocksTaskStatus.isRunning(run?.task.status ?? "") {
            return LoopOpsResolvedRunAnswer(
                text: "Loop 正在运行。完成后这里只显示本轮权威答案。",
                source: nil,
                outputGuardStatus: nil,
                isPending: true,
                statusLabel: "running"
            )
        }
        return LoopOpsResolvedRunAnswer(
            text: "尚未写入最终答案。",
            source: nil,
            outputGuardStatus: nil,
            isPending: true,
            statusLabel: "pending"
        )
    }

    private var cmcRenderBlocks: [CMCRenderBlock] {
        cmcSummary?.renderBlocks?.filter { !$0.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? []
    }

    private var cmcStatus: String? {
        guard let cmcSummary else { return nil }
        let result = (cmcSummary.renderBlocks?.isEmpty == false ? "renderable" : nil)
            ?? cmcSummary.skillHubDisplayStatus
            ?? cmcSummary.researchEvidenceStatus
            ?? "unknown"
        let prices = cmcSummary.priceSnapshotStatus ?? cmcSummary.diagnostics?.priceSnapshotStatus ?? (cmcSummary.allowConcretePrices == true ? "usable" : "blocked")
        return "Market data \(result), prices \(prices)"
    }

    private var cloudASRStatus: String? {
        guard let cloudASRSummary else { return nil }
        return "Transcript \(cloudASRSummary.cloudASRStatus ?? cloudASRSummary.status), \(cloudASRSummary.segmentCount ?? 0) segments"
    }

    private var modelStatus: String? {
        guard let route = finalReadModel?.modelRouteSummary else { return nil }
        let final = route.finalModel ?? route.selectedTextModel
        guard let final, !final.isEmpty else { return nil }
        if route.fallbackUsed == true, let selected = route.selectedTextModel, selected != final {
            return "Agent answer \(final), fallback"
        }
        return "Agent answer \(final)"
    }

    private func loopStatus(_ loop: CapabilityLoopReadModel) -> String {
        "\(loop.title), \(loop.review.status)"
    }

    private func diagnosticColor(_ item: String) -> Color {
        if item.localizedCaseInsensitiveContains("rewritten") || item.localizedCaseInsensitiveContains("discarded") {
            return RadarTheme.gold
        }
        if item.localizedCaseInsensitiveContains("empty") || item.localizedCaseInsensitiveContains("blocked") {
            return RadarTheme.mutedText
        }
        return selectedDomain.tint
    }
}

private struct LoopOpsRunReviewPacketPanel: View {
    let packet: ReviewPacketViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Review Packet", systemImage: "checkmark.seal")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
                BlocksStatusPill(
                    label: blocksLoopOpsReviewDecisionDisplay(packet.reviewDecision),
                    color: blocksLoopOpsReviewDecisionColor(packet.reviewDecision),
                    icon: "checkmark.circle"
                )
            }

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 7)], alignment: .leading, spacing: 7) {
                LoopOpsRunPacketMetric(label: "Claims", value: packet.claims.count, icon: "text.quote")
                LoopOpsRunPacketMetric(label: "Gaps", value: packet.evidenceGaps.count, icon: "exclamationmark.triangle")
                LoopOpsRunPacketMetric(label: "Blocked", value: packet.blockedActions.count, icon: "hand.raised")
                LoopOpsRunPacketMetric(label: "Next", value: packet.nextQuestions.count, icon: "arrow.turn.down.right")
            }

            BlocksLoopOpsKeyValue(label: "Evidence gaps", value: packet.evidenceGaps.isEmpty ? "No visible evidence gap recorded." : packet.evidenceGaps.joined(separator: "\n"))
            BlocksLoopOpsKeyValue(label: "Next questions", value: packet.nextQuestions.isEmpty ? "No follow-up question recorded." : packet.nextQuestions.joined(separator: "\n"))
            if !packet.blockedActions.isEmpty {
                BlocksLoopOpsKeyValue(label: "Blocked actions", value: packet.blockedActions.joined(separator: "\n"))
            }
            if !packet.reviewNotes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                BlocksLoopOpsKeyValue(label: "Review notes", value: packet.reviewNotes)
            }
            if !packet.eventHistory.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Review history")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                    ForEach(Array(packet.eventHistory.suffix(4).reversed())) { event in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(event.title)
                                .font(.system(size: 11.5, weight: .medium))
                                .foregroundStyle(RadarTheme.primaryText)
                                .lineLimit(1)
                            Text("\(event.actor) · \(event.occurredAt)")
                                .font(.system(size: 10.5))
                                .foregroundStyle(RadarTheme.mutedText)
                                .lineLimit(1)
                            if !event.detail.isEmpty {
                                Text(event.detail)
                                    .font(.system(size: 11))
                                    .foregroundStyle(RadarTheme.secondaryText)
                                    .lineLimit(2)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
                .accessibilityIdentifier(LoopOpsInteractionID.workbenchRunReviewPacketHistory)
            }
            BlocksLoopOpsKeyValue(label: "Uncertainty", value: packet.uncertainty)
        }
        .padding(11)
        .background(RadarTheme.panelElevated)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct LoopOpsRunPacketMetric: View {
    let label: String
    let value: Int
    let icon: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
            Text("\(value)")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(RadarTheme.primaryText)
            Text(label)
                .font(.system(size: 10.5))
                .foregroundStyle(RadarTheme.mutedText)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(RadarTheme.panel.opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct LoopOpsRunTimelinePanel: View {
    let ledger: RunLedgerRow

    private var events: [String] {
        ledger.lifecycleEvents?.isEmpty == false
            ? ledger.lifecycleEvents!
            : ["\(ledger.status) · \(ledger.completedAt ?? ledger.startedAt ?? "本地记录")"]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Label("Timeline", systemImage: "list.bullet.clipboard")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
                BlocksStatusPill(label: RuntimeStatusPresenter.label(ledger.status), color: ledger.domain.tint, icon: "clock")
            }
            VStack(alignment: .leading, spacing: 5) {
                ForEach(events.suffix(5), id: \.self) { event in
                    Text(event)
                        .font(.system(size: 11.5))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(2)
                }
            }
            if let skillPath = ledger.skillPath, !skillPath.isEmpty {
                Text("Execution Path: \(skillPath.joined(separator: " -> "))")
                    .font(.system(size: 10.8))
                    .foregroundStyle(RadarTheme.mutedText)
                    .lineLimit(2)
            }
        }
        .padding(11)
        .background(RadarTheme.panelElevated)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct LoopOpsRunArtifactPanel: View {
    let icon: String
    let title: String
    let trailing: String
    let rows: [(String, String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Label(title, systemImage: icon)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
                Text(trailing)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
            }
            ForEach(rows.indices, id: \.self) { index in
                let row = rows[index]
                BlocksLoopOpsKeyValue(label: row.0, value: row.1)
            }
        }
        .padding(11)
        .background(RadarTheme.panelElevated)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct BlocksLoopOpsKeyValue: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
            Text(value)
                .font(.system(size: 11.8))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private func blocksLoopOpsReviewDecisionDisplay(_ value: String) -> String {
    let normalized = value
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "-", with: "_")
        .lowercased()
    switch normalized {
    case "", "pending":
        return "Pending"
    case "reviewed", "approved":
        return "Reviewed"
    case "needs_follow_up", "needsfollowup":
        return "Needs follow-up"
    case "blocked":
        return "Blocked"
    case "rejected":
        return "Rejected"
    default:
        return normalized.split(separator: "_").map { $0.capitalized }.joined(separator: " ")
    }
}

private func blocksLoopOpsReviewDecisionColor(_ value: String) -> Color {
    let normalized = value
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "-", with: "_")
        .lowercased()
    switch normalized {
    case "reviewed", "approved":
        return RadarTheme.green
    case "needs_follow_up", "needsfollowup":
        return RadarTheme.gold
    case "blocked", "rejected":
        return RadarTheme.red
    default:
        return RadarTheme.blue
    }
}

private func blocksLoopOpsRunInstanceLabel(_ runID: String) -> String {
    let trimmed = runID.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "Run instance" }
    return "Run \(String(trimmed.suffix(8)))"
}

private struct BlocksTemplateCard: View {
    let template: WorkbenchLoopTemplate

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            IconChip(systemName: template.systemImage, tint: template.domain.tint, size: 30)
            Text(template.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(RadarTheme.primaryText)
                .lineLimit(1)
            Text(template.subtitle)
                .font(.system(size: 11.5))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(2)
            Text("Review rule: \(template.feedbackGate)")
                .font(.system(size: 10.5))
                .foregroundStyle(RadarTheme.mutedText)
                .lineLimit(2)
            Text(template.action.rawValue)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(template.domain.tint)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RadarTheme.tintFaint)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct LoopComposer: View {
    @ObservedObject var viewModel: DashboardViewModel
    let metrics: WorkbenchLayoutMetrics
    @Binding var selectedDomain: WorkbenchDomain
    @Binding var templatePickerPresented: Bool
    let applyTemplate: (WorkbenchLoopTemplate, Bool) -> Void
    let submitTemplate: (WorkbenchLoopTemplate) -> Void
    let submitPrompt: () -> Void
    let stageLocalContext: (String, String) -> Void

    @FocusState private var focused: Bool

    private var trimmedPrompt: String {
        viewModel.agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var submitting: Bool {
        viewModel.agentSubmitStatus.localizedCaseInsensitiveContains("submitting")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            header
            quickPrompts
            inputArea
        }
        .padding(15)
        .background(RadarTheme.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var header: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                title
                Spacer(minLength: 12)
                modelPicker
                domainPicker
                abilitySummary
            }
            VStack(alignment: .leading, spacing: 9) {
                title
                HStack(spacing: 8) {
                    modelPicker
                    domainPicker
                    abilitySummary
                    Spacer(minLength: 0)
                }
            }
        }
    }

    private var title: some View {
        HStack(spacing: 8) {
            IconChip(systemName: "command", tint: selectedDomain.tint, size: 28)
            VStack(alignment: .leading, spacing: 1) {
            Text("Loop Composer")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
            Text(statusText)
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.mutedText)
            }
        }
    }

    private var domainPicker: some View {
        Picker("Block", selection: $selectedDomain) {
            ForEach(WorkbenchDomain.allCases) { domain in
                Label(domain.title, systemImage: domain.systemImage).tag(domain)
            }
        }
        .labelsHidden()
        .pickerStyle(.segmented)
        .frame(width: metrics.isCompact ? 246 : 300)
    }

    private var modelPicker: some View {
        Picker("Model", selection: $viewModel.selectedAgentModelPreference) {
            ForEach(AgentModelPreferenceOption.allCases) { item in
                Text(item.title).tag(item)
            }
        }
        .pickerStyle(.menu)
        .frame(width: metrics.isCompact ? 128 : 168)
        .help("选择文本模型；不可用时会自动尝试备用路径")
    }

    private var abilitySummary: some View {
        HStack(spacing: 6) {
            Text(selectedDomain.title)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(selectedDomain.tint)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(selectedDomain.tint.opacity(0.12))
                .clipShape(Capsule())
            Text("能力自动匹配")
                .font(.system(size: 10.5))
                .foregroundStyle(RadarTheme.mutedText)
                .lineLimit(1)
        }
    }

    private var quickPrompts: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 132), spacing: 7)], alignment: .leading, spacing: 7) {
            ForEach(WorkbenchLoopTemplate.templates(for: selectedDomain)) { template in
                Button {
                    applyTemplate(template, true)
                    focused = true
                } label: {
                    Label(template.title, systemImage: template.systemImage)
                        .lineLimit(1)
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .controlSize(.small)
                .help("\(template.trigger)\nReview rule: \(template.feedbackGate)")
            }
        }
    }

    @ViewBuilder
    private var inputArea: some View {
        if metrics.isCompact {
            VStack(alignment: .leading, spacing: 10) {
                promptEditor
                HStack(spacing: 9) {
                    templateButton
                    imageAttachmentButton
                    if selectedDomain == .office {
                        mediaAttachmentButton
                    }
                    Spacer(minLength: 0)
                    clearPromptButton
                    submitButton
                }
            }
        } else {
            HStack(alignment: .bottom, spacing: 10) {
                templateButton
                imageAttachmentButton
                if selectedDomain == .office {
                    mediaAttachmentButton
                }
                promptEditor
                clearPromptButton
                submitButton
            }
        }
    }

    private var templateButton: some View {
        Button {
            templatePickerPresented = true
        } label: {
            Label("Loops", systemImage: "square.grid.2x2")
        }
        .help("打开当前 block 的 loop templates")
        .buttonStyle(ResearchSecondaryButtonStyle())
        .popover(isPresented: $templatePickerPresented, arrowEdge: .bottom) {
            LoopTemplatePicker(
                selectedDomain: selectedDomain,
                applyTemplate: { template in
                    applyTemplate(template, true)
                    focused = true
                },
                submitTemplate: submitTemplate
            )
            .frame(width: 430, height: 430)
        }
    }

    private var imageAttachmentButton: some View {
        Button {
            stageLocalContext("图片说明", "请在这里补充图片要点，提交后作为本轮上下文。")
            focused = true
        } label: {
            Image(systemName: "photo.on.rectangle")
        }
        .help("暂存图片说明，不打开系统选择器")
        .buttonStyle(HoverIconButtonStyle(size: 38))
        .disabled(submitting)
    }

    private var mediaAttachmentButton: some View {
        Button {
            stageLocalContext("会议说明", "请在这里补充会议摘要或待转写线索，提交后作为本轮上下文。")
            focused = true
        } label: {
            Image(systemName: "waveform")
        }
        .help("暂存会议说明，不打开系统选择器")
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
                .frame(minHeight: 58, maxHeight: 110)
                .padding(11)
                .background(RadarTheme.tintFaint)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(focused ? selectedDomain.tint.opacity(0.60) : RadarTheme.borderSoft, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .onChange(of: viewModel.agentPrompt) { _, newValue in
                    if newValue.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("/add") {
                        templatePickerPresented = true
                    }
                }

            if trimmedPrompt.isEmpty {
                Text(selectedDomain.placeholder)
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
            viewModel.agentPrompt = ""
        } label: {
            Image(systemName: "xmark.circle")
        }
        .help("清空输入和附件")
        .buttonStyle(HoverIconButtonStyle(size: 38))
        .disabled((trimmedPrompt.isEmpty && viewModel.agentAttachments.isEmpty) || submitting)
    }

    private var submitButton: some View {
        Button {
            submitPrompt()
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
        .help("提交 loop，快捷键 Command Return")
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
        if raw.contains("submitting") { return "正在运行 loop" }
        if raw.contains("run_completed") { return "loop 已完成" }
        if raw.contains("draft_ready") { return "template 已填入" }
        if raw.contains("cloud_asr_attachment_ready") { return "云端转写附件已就绪" }
        if raw.contains("prompt_empty") { return "请输入 loop 目标" }
        return "就绪"
    }
}

private struct LoopTemplatePicker: View {
    let selectedDomain: WorkbenchDomain
    let applyTemplate: (WorkbenchLoopTemplate) -> Void
    let submitTemplate: (WorkbenchLoopTemplate) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(selectedDomain.title) Loop Templates")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(RadarTheme.primaryText)
            Text("选择一个 loop 填入 composer，或直接运行。")
                .font(.system(size: 12))
                .foregroundStyle(RadarTheme.secondaryText)

            ScrollView {
                VStack(spacing: 8) {
                    ForEach(WorkbenchLoopTemplate.templates(for: selectedDomain)) { template in
                        HStack(alignment: .top, spacing: 10) {
                            IconChip(systemName: template.systemImage, tint: template.domain.tint, size: 30)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(template.title)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(RadarTheme.primaryText)
                                Text(template.subtitle)
                                    .font(.system(size: 11.5))
                                    .foregroundStyle(RadarTheme.secondaryText)
                                    .lineLimit(2)
                                Text("Trigger: \(template.trigger)")
                                    .font(.system(size: 11))
                                    .foregroundStyle(RadarTheme.mutedText)
                                    .lineLimit(2)
                                VStack(alignment: .leading, spacing: 2) {
                                    ForEach(template.stepsSummary.prefix(3), id: \.self) { step in
                                        HStack(alignment: .top, spacing: 5) {
                                            Circle()
                                                .fill(template.domain.tint)
                                                .frame(width: 4, height: 4)
                                                .padding(.top, 6)
                                            Text(step)
                                                .font(.system(size: 10.8))
                                                .foregroundStyle(RadarTheme.secondaryText)
                                                .lineLimit(2)
                                        }
                                    }
                                }
                                Text("Review rule: \(template.feedbackGate)")
                                    .font(.system(size: 10.8, weight: .medium))
                                    .foregroundStyle(RadarTheme.primaryText)
                                    .lineLimit(2)
                                Text("Exit: \(template.exitCondition)")
                                    .font(.system(size: 10.8))
                                    .foregroundStyle(RadarTheme.mutedText)
                                    .lineLimit(2)
                                Text(template.reviewBoundary)
                                    .font(.system(size: 10.5, weight: .semibold))
                                    .foregroundStyle(template.domain.tint)
                                    .lineLimit(2)
                                HStack(spacing: 7) {
                                    Button("Use") {
                                        applyTemplate(template)
                                    }
                                    .buttonStyle(ResearchSecondaryButtonStyle())
                                    .controlSize(.small)
                                    Button(template.action.rawValue) {
                                        submitTemplate(template)
                                    }
                                    .buttonStyle(ResearchPrimaryButtonStyle())
                                    .controlSize(.small)
                                }
                            }
                            Spacer()
                        }
                        .padding(10)
                        .quietRow(cornerRadius: 12)
                    }
                }
            }
        }
        .padding(16)
        .background(RadarTheme.panel)
    }
}

private struct BlocksInfoStrip: View {
    let icon: String
    let tint: Color
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            IconChip(systemName: icon, tint: tint, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Text(detail)
                    .font(.system(size: 11.5))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(3)
            }
            Spacer(minLength: 0)
        }
        .padding(11)
        .background(tint.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
}

private struct BlocksStatusPill: View {
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

private struct BlocksEmptyRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            IconChip(systemName: icon, tint: RadarTheme.mutedText, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Text(detail)
                    .font(.system(size: 11.5))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(3)
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

private struct BlocksWorkbenchDetailSheet: View {
    let task: AgentLongTask?
    let finalReadModel: AgentFinalReadModel?
    let cmcSummary: CMCCapabilitySummary?
    let cloudASRSummary: CloudASRSummary?
    let capabilityLoop: CapabilityLoopReadModel?
    let memoryReadModel: AgentMemoryReadModel?
    let subagentCoordination: SubagentCoordinationReadModel?
    let diagnostics: [String]
    let initialTab: BlocksWorkbenchDetailTab

    @State private var tab: BlocksWorkbenchDetailTab = .review
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(task?.prompt ?? "Loop detail")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(2)
                    Text(task == nil ? "未选择 loop" : "已选择当前 loop")
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
                ForEach(BlocksWorkbenchDetailTab.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .pickerStyle(.segmented)

            ScrollView {
                detailBlock(title: tab.title, lines: lines(for: tab))
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
        .background(RadarTheme.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func lines(for tab: BlocksWorkbenchDetailTab) -> [String] {
        switch tab {
        case .evidence:
            var lines = diagnostics
            if let finalReadModel {
                let outputReview = readableOutputReview(finalReadModel.outputGuardStatus)
                lines.append("最终答案：\(finalReadModel.finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "尚未生成" : "已生成")")
                lines.append("安全复核：\(outputReview)")
            }
            return lines
        case .review:
            var lines = capabilityLoop.map { ["Loop：\($0.title)", "复核状态：\($0.review.status)", "可复核：\($0.review.ready ? "是" : "否")"] } ?? []
            lines.append(contentsOf: diagnostics)
            return lines.isEmpty ? ["暂无复核提示。"] : lines
        case .policy:
            guard let policy = finalReadModel?.productMutationPolicy else {
                return ["暂无工作台写入策略。"]
            }
            return ["工作台写入：\(policy.status)", "原因：\(policy.reason ?? "无")"]
        case .cmc:
            guard let cmcSummary else {
                return ["本轮暂无 CMC Skill Hub 摘要。"]
            }
            let evidenceCount = cmcSummary.readableEvidenceCount ?? 0
            return [
                "能力包：CMC Skill Hub",
                "挂载：\(cmcSummary.mountStatus ?? "unknown")",
                "调用：\(cmcSummary.transportStatus ?? "unknown")",
                "结果：\(cmcSummary.skillHubDisplayStatus ?? cmcSummary.researchEvidenceStatus ?? "unknown")",
                "价格：\(cmcSummary.priceSnapshotStatus ?? "unknown")",
                "结构化证据：\(evidenceCount)"
            ]
        case .asr:
            guard let cloudASRSummary else {
                return ["本轮暂无云端转写摘要。"]
            }
            var lines = [
                "转写状态：\(cloudASRSummary.cloudASRStatus ?? cloudASRSummary.status)",
                "转写方式：\(cloudASRSummary.userVisibleLabel ?? "云端转写 · 阿里云百炼 · OSS 临时上传")",
                "片段数：\(cloudASRSummary.segmentCount ?? 0)",
                "逐字稿复核：\(cloudASRSummary.needsTranscriptReview == true ? "需要" : "不需要")"
            ]
            if let reason = cloudASRSummary.reason, !reason.isEmpty {
                lines.append("原因：\(reason)")
            }
            return lines
        case .loop:
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
        case .memory:
            guard let memoryReadModel else {
                return ["本轮暂无上下文摘要。"]
            }
            var lines = [
                "上下文状态：\(memoryReadModel.status)",
                "写入策略：\(memoryReadModel.writePolicy.status)",
                "原因：\(memoryReadModel.reason ?? memoryReadModel.writePolicy.reason ?? "none")"
            ]
            if !memoryReadModel.candidateMemories.isEmpty {
                lines.append("候选上下文：\(memoryReadModel.candidateMemories.map(\.title).joined(separator: ", "))")
            }
            return lines
        case .subagents:
            guard let subagentCoordination else {
                return ["本轮暂无协作团队摘要。"]
            }
            return [
                "协作状态：\(subagentCoordination.status)",
                "运行模式：\(subagentCoordination.mode)",
                "计划角色：\(subagentCoordination.plannedRoles.joined(separator: ", "))",
                "安全边界：\(subagentCoordination.blockedOperations.isEmpty ? "无额外阻断" : "高影响操作需确认")"
            ]
        }
    }

    private func readableOutputReview(_ status: String) -> String {
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

private enum BlocksWorkbenchDetailTab: String, CaseIterable, Identifiable {
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
        case .memory: return "Context"
        case .subagents: return "Agent Team"
        }
    }
}

enum BlocksTaskStatus {
    static func label(for status: String) -> String {
        let value = status.lowercased()
        if value.contains("blocked") { return "阻断" }
        if value.contains("failed") || value.contains("error") { return "失败" }
        if value.contains("review") { return "待复核" }
        if value.contains("completed") || value.contains("done") { return "完成" }
        if isRunning(status) { return "运行中" }
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

    static func isCompleted(_ status: String) -> Bool {
        let value = status.lowercased()
        return value.contains("completed") || value.contains("done")
    }
}
