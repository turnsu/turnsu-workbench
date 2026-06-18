import AppKit
import SwiftUI

struct BlocksWorkbenchView: View {
    @ObservedObject var viewModel: DashboardViewModel
    let metrics: WorkbenchLayoutMetrics

    @State private var selectedDomain: WorkbenchDomain = .crypto
    @State private var selectedTaskID: String?
    @State private var detailPresented = false
    @State private var detailInitialTab: BlocksWorkbenchDetailTab = .review
    @State private var templatePickerPresented = false
    @State private var deleteCandidate: AgentLongTask?

    private var sortedTasks: [AgentLongTask] {
        viewModel.agentTasks.sorted { $0.updatedAt > $1.updatedAt }
    }

    private var runStates: [WorkbenchLoopRunState] {
        sortedTasks.map { task in
            let loop = viewModel.agentCapabilityLoopByRunID[task.runID]
            return WorkbenchLoopRunState(
                task: task,
                domain: WorkbenchBlockClassifier.domain(for: task, capabilityLoop: loop),
                capabilityLoop: loop,
                finalReadModel: viewModel.agentFinalReadModelByRunID[task.runID]
            )
        }
    }

    private var selectedDomainRuns: [WorkbenchLoopRunState] {
        runStates.filter { $0.domain == selectedDomain }
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
                finalCount: viewModel.agentFinalReadModelByRunID.count
            )

            if metrics.isCompact {
                VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                    blockRail
                    resultCanvas
                }
            } else {
                HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                    blockRail
                        .frame(width: metrics.queueColumnWidth)
                    resultCanvas
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                }
            }

            LoopComposer(
                viewModel: viewModel,
                metrics: metrics,
                selectedDomain: $selectedDomain,
                templatePickerPresented: $templatePickerPresented,
                applyTemplate: applyTemplate(_:focusComposer:),
                submitTemplate: submitTemplate(_:)
            )
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .onAppear {
            if selectedTaskID == nil {
                selectedTaskID = selectedDomainRuns.first?.task.taskID
            }
        }
        .onChange(of: viewModel.agentTasks.map(\.taskID)) { _, taskIDs in
            guard let selectedTaskID,
                  taskIDs.contains(selectedTaskID),
                  runStates.contains(where: { $0.task.taskID == selectedTaskID && $0.domain == selectedDomain }) else {
                self.selectedTaskID = selectedDomainRuns.first?.task.taskID
                return
            }
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
            templates: WorkbenchLoopTemplate.templates(for: selectedDomain),
            activeRuns: selectedDomainRuns,
            allRuns: runStates,
            selectedDomain: $selectedDomain,
            selectedTaskID: $selectedTaskID,
            applyTemplate: applyTemplate(_:focusComposer:),
            openRun: openRun(_:),
            deleteRun: { deleteCandidate = $0.task }
        )
    }

    private var resultCanvas: some View {
        BlocksResultCanvas(
            selectedDomain: selectedDomain,
            run: selectedRun,
            finalReadModel: selectedTask.flatMap { viewModel.agentFinalReadModelByRunID[$0.runID] },
            cmcSummary: selectedTask.flatMap { viewModel.agentCMCCapabilitySummaryByRunID[$0.runID] },
            cloudASRSummary: selectedTask.flatMap { viewModel.agentCloudASRSummaryByRunID[$0.runID] },
            capabilityLoop: selectedTask.flatMap { viewModel.agentCapabilityLoopByRunID[$0.runID] },
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

    private var deleteConfirmationBinding: Binding<Bool> {
        Binding(
            get: { deleteCandidate != nil },
            set: { if !$0 { deleteCandidate = nil } }
        )
    }

    private func openRun(_ run: WorkbenchLoopRunState) {
        selectedDomain = run.domain
        selectedTaskID = run.task.taskID
        viewModel.selectAgentSession(run.task.sessionID)
        detailInitialTab = .review
        detailPresented = true
    }

    private func applyTemplate(_ template: WorkbenchLoopTemplate, focusComposer: Bool = true) {
        selectedDomain = template.domain
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

    private func submitTemplate(_ template: WorkbenchLoopTemplate) {
        applyTemplate(template, focusComposer: false)
        viewModel.submitAgentPrompt()
    }

    private func followUpFromSelectedRun() {
        if let loop = selectedTask.flatMap({ viewModel.agentCapabilityLoopByRunID[$0.runID] }),
           let prompt = loop.followUpSuggestions.first?.prompt {
            viewModel.agentPrompt = prompt
            selectedDomain = selectedRun?.domain ?? selectedDomain
            return
        }
        if let selectedTask {
            viewModel.agentPrompt = "基于这个 loop 继续追问：\(selectedTask.prompt)"
        }
    }
}

private struct BlocksWorkbenchHeader: View {
    let activeLoopCount: Int
    let selectedDomain: WorkbenchDomain
    let selectedRun: WorkbenchLoopRunState?
    let finalCount: Int

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
            Text("Blocks Workbench")
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(RadarTheme.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.86)
            Text("Domain blocks, reusable loops, review and follow-up in one work surface.")
                .font(.system(size: 13))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(2)
        }
    }

    private var metricsBlock: some View {
        HStack(spacing: 12) {
            BlocksMetric(label: "Blocks", value: "\(WorkbenchDomain.allCases.count)")
            BlocksMetric(label: "Active", value: "\(activeLoopCount)")
            BlocksMetric(label: "Finals", value: "\(finalCount)")
        }
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
    let templates: [WorkbenchLoopTemplate]
    let activeRuns: [WorkbenchLoopRunState]
    let allRuns: [WorkbenchLoopRunState]
    @Binding var selectedDomain: WorkbenchDomain
    @Binding var selectedTaskID: String?
    let applyTemplate: (WorkbenchLoopTemplate, Bool) -> Void
    let openRun: (WorkbenchLoopRunState) -> Void
    let deleteRun: (WorkbenchLoopRunState) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Domain Blocks")
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
                Text("Loop Templates")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Spacer()
                Text("\(templates.count)")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
            }

            VStack(spacing: 7) {
                ForEach(templates) { template in
                    Button {
                        applyTemplate(template, true)
                    } label: {
                        BlocksTemplateRow(template: template)
                    }
                    .buttonStyle(.plain)
                    .help(template.prompt)
                }
            }

            Divider().overlay(RadarTheme.borderSoft)

            HStack {
                Text("Active Loops")
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
                    title: "暂无 loop",
                    detail: "选择一个 template 填入 composer。"
                )
            } else {
                VStack(spacing: 7) {
                    ForEach(activeRuns.prefix(8)) { run in
                        BlocksRunRow(
                            run: run,
                            selected: selectedTaskID == run.task.taskID,
                            select: {
                                selectedTaskID = run.task.taskID
                                selectedDomain = run.domain
                            },
                            open: { openRun(run) },
                            delete: { deleteRun(run) }
                        )
                    }
                }
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

private struct BlocksTemplateRow: View {
    let template: WorkbenchLoopTemplate

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: template.systemImage)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(template.domain.tint)
                .frame(width: 20, height: 20)
            VStack(alignment: .leading, spacing: 3) {
                Text(template.title)
                    .font(.system(size: 12.8, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(1)
                Text(template.subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.secondaryText)
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
    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 9) {
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
            Button("打开 loop", action: open)
            Button("删除 loop", role: .destructive, action: delete)
        }
    }
}

private struct BlocksResultCanvas: View {
    let selectedDomain: WorkbenchDomain
    let run: WorkbenchLoopRunState?
    let finalReadModel: AgentFinalReadModel?
    let cmcSummary: CMCCapabilitySummary?
    let cloudASRSummary: CloudASRSummary?
    let capabilityLoop: CapabilityLoopReadModel?
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
    }

    private var canvasTitle: String {
        "\(selectedDomain.title) Loop Canvas"
    }

    private var canvasSubtitle: String {
        switch selectedDomain {
        case .crypto:
            return "CMC returned result、market markdown、价格和证据说明。"
        case .markets:
            return "Equity / macro / cross-asset draft、evidence gaps 和 review tasks。"
        case .office:
            return "会议纪要、文档草稿、Cloud ASR 状态和交付预览。"
        }
    }

    private func selectedRunContent(_ run: WorkbenchLoopRunState) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(run.promptTitle)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(RadarTheme.primaryText)
                .lineLimit(2)

            Text(previewText)
                .font(.system(size: 13))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(8)
                .lineSpacing(3)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            if finalReadModel != nil {
                domainRenderBlocks
            }

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

    @ViewBuilder
    private var domainRenderBlocks: some View {
        if selectedDomain == .crypto, !cmcRenderBlocks.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                ForEach(cmcRenderBlocks.prefix(3)) { block in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(block.title ?? "CMC Skill Hub 返回")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(RadarTheme.blue)
                        Text(block.body)
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

    private var previewText: String {
        if let text = finalReadModel?.finalText.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            return AgentOutputCopy.humanize(text)
        }
        if BlocksTaskStatus.isRunning(run?.task.status ?? "") {
            return "Loop 正在运行。完成后这里只显示 AgentFinalReadModel 的最终答案。"
        }
        return "尚未写入最终答案。"
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
        return "CMC result \(result), prices \(prices)"
    }

    private var cloudASRStatus: String? {
        guard let cloudASRSummary else { return nil }
        return "Cloud ASR \(cloudASRSummary.cloudASRStatus ?? cloudASRSummary.status), \(cloudASRSummary.segmentCount ?? 0) segments"
    }

    private var modelStatus: String? {
        guard let route = finalReadModel?.modelRouteSummary else { return nil }
        let final = route.finalModel ?? route.selectedTextModel
        guard let final, !final.isEmpty else { return nil }
        if route.fallbackUsed == true, let selected = route.selectedTextModel, selected != final {
            return "Model \(final), fallback"
        }
        return "Model \(final)"
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
        .help("选择文本模型；失败时后端会按安全 fallback 链继续尝试")
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
            Text("skills routed by backend")
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
                .help(template.subtitle)
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
                    Text(task.map { "Run \($0.runID)" } ?? "未选择 loop")
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
                lines.append("最终答案：\(finalReadModel.finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "尚未生成" : "已生成")")
                lines.append("输出复核：\(finalReadModel.outputGuardStatus)")
            }
            return lines
        case .review:
            var lines = capabilityLoop.map { ["Loop：\($0.title)", "复核状态：\($0.review.status)", "可复核：\($0.review.ready ? "是" : "否")"] } ?? []
            lines.append(contentsOf: diagnostics)
            return lines.isEmpty ? ["No review diagnostic flags."] : lines
        case .policy:
            guard let policy = finalReadModel?.productMutationPolicy else {
                return ["Product mutation policy unavailable."]
            }
            return ["工作台写入：\(policy.status)", "原因：\(policy.reason ?? "none")"]
        case .cmc:
            guard let cmcSummary else {
                return ["CMC Skill Hub summary unavailable for this run."]
            }
            return [
                "能力包：CMC Skill Hub",
                "挂载：\(cmcSummary.mountStatus ?? "unknown")",
                "调用：\(cmcSummary.transportStatus ?? "unknown")",
                "结果：\(cmcSummary.skillHubDisplayStatus ?? cmcSummary.researchEvidenceStatus ?? "unknown")",
                "价格：\(cmcSummary.priceSnapshotStatus ?? "unknown")",
                "结构化证据：\(cmcSummary.readableEvidenceCount ?? 0)"
            ]
        case .asr:
            guard let cloudASRSummary else {
                return ["Cloud ASR summary unavailable for this run."]
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
                return ["Capability loop read model unavailable for this run."]
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
                return ["Memory read model unavailable for this run."]
            }
            var lines = [
                "记忆状态：\(memoryReadModel.status)",
                "写入策略：\(memoryReadModel.writePolicy.status)",
                "原因：\(memoryReadModel.reason ?? memoryReadModel.writePolicy.reason ?? "none")"
            ]
            if !memoryReadModel.candidateMemories.isEmpty {
                lines.append("候选记忆：\(memoryReadModel.candidateMemories.map(\.title).joined(separator: ", "))")
            }
            return lines
        case .subagents:
            guard let subagentCoordination else {
                return ["Subagent coordination read model unavailable for this run."]
            }
            return [
                "协作状态：\(subagentCoordination.status)",
                "运行模式：\(subagentCoordination.mode)",
                "计划角色：\(subagentCoordination.plannedRoles.joined(separator: ", "))",
                "安全边界：\(subagentCoordination.blockedOperations.isEmpty ? "无额外阻断" : "高影响操作需确认")"
            ]
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
        case .memory: return "Memory"
        case .subagents: return "Subagents"
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
