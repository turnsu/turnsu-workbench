import Foundation
import AppKit
import SwiftUI
import UniformTypeIdentifiers

private struct LoopOpsRunLaunchCapture {
    let contract: LoopContract
    let launchChatScopeID: String
    let parentRunID: String?
    let localToolDrafts: [LoopOpsToolDraft]
    let pendingToolLogIDsByToolID: [String: String]
    let knowledgeSourceIDs: [String]
    weak var store: LoopOpsLocalStore?
}

struct LoopOpsRunSubmissionReport: Hashable {
    var queuedContractIDs: [String]
    var setupRequiredContractIDs: [String]
    var pendingContractIDs: [String]
    var failedContractIDs: [String]
    var acknowledgedRunIDs: [String]
    var errorMessage: String?

    init(
        queuedContractIDs: [String] = [],
        setupRequiredContractIDs: [String] = [],
        pendingContractIDs: [String] = [],
        failedContractIDs: [String] = [],
        acknowledgedRunIDs: [String] = [],
        errorMessage: String? = nil
    ) {
        self.queuedContractIDs = queuedContractIDs
        self.setupRequiredContractIDs = setupRequiredContractIDs
        self.pendingContractIDs = pendingContractIDs
        self.failedContractIDs = failedContractIDs
        self.acknowledgedRunIDs = acknowledgedRunIDs
        self.errorMessage = errorMessage
    }

    var queuedCount: Int { queuedContractIDs.count }
    var setupRequiredCount: Int { setupRequiredContractIDs.count }
    var pendingCount: Int { pendingContractIDs.count }
    var failedCount: Int { failedContractIDs.count }

    var status: String {
        if failedCount > 0 { return "failed" }
        if queuedCount > 0 { return "queued" }
        if pendingCount > 0 { return "pending_ack" }
        if setupRequiredCount > 0 { return "setup_required" }
        return "idle"
    }
}

@MainActor
final class DashboardViewModel: ObservableObject {
    @Published private(set) var snapshot: IntelligenceSnapshot = .empty
    @Published private(set) var logs: [AgentRunLog] = []
    @Published private(set) var capabilities: [Capability] = []
    @Published private(set) var policies: [PolicyDecision] = []
    @Published private(set) var envelope: PlannerEnvelope?
    @Published private(set) var copyStatus: String = "可复制"
    @Published private(set) var syncState: AgentSyncState = .idle
    @Published private(set) var artifactStatus: AgentRunArtifactStatus?
    @Published private(set) var terminalData: TerminalDataSnapshot = .empty
    @Published private(set) var refreshStatus: String = "idle · not_run"
    @Published var wechatLiveStatus: String = ""
    @Published private(set) var runtimeCommandStatus: String = "idle"
    @Published var selectedGroupID: UUID?
    @Published var selectedWindow: TimeWindow = .month
    @Published var selectedWorkspace: TerminalWorkspace = .home
    @Published var selectedTokenID: String?
    @Published var selectedMessageID: UUID?
    @Published var selectedEvidenceID: UUID?
    @Published var selectedAlertID: UUID?
    @Published var selectedArtifactPath: String?
    @Published var selectedCrystalID: UUID?
    @Published var selectedProposalID: UUID?
    @Published var selectedMemoryID: UUID?
    @Published var selectedHandoffID: UUID?
    @Published var selectedOperationsTab: OperationsDeckTab = .run
    @Published var searchQuery: String = ""
    @Published var agentDaemonStatus: AgentDaemonStatus = .unavailable
    @Published var agentSessions: [AgentSession] = []
    @Published var selectedAgentSessionID: String?
    @Published var agentMessages: [AgentMessage] = []
    @Published var agentStreamEvents: [AgentStreamEvent] = []
    @Published var agentSkills: [AgentSkillManifest] = []
    @Published var agentExtensions: [AgentExtensionManifest] = []
    @Published var selectedAgentSkillIDs: Set<String> = [
        "wechat-onchain-intelligence",
        "cmc-market-radar"
    ]
    @Published var selectedAgentExtensionIDs: Set<String> = [
        "wechat-cli-export-bridge",
        "cmc-skill-hub"
    ]
    @Published var selectedLoopOpsToolDraftIDs: Set<String> = []
    @Published var agentTasks: [AgentLongTask] = []
    @Published var agentToolCalls: [AgentToolCallRecord] = []
    @Published var agentRunManifest: AgentRunManifest?
    @Published var agentControlSummary: AgentControlPlaneSummary?
    @Published var agentContextSummary: AgentContextPlaneSummary?
    @Published var agentStrategyResults: [CMCStrategistResult] = []
    @Published var agentOpsSnapshot: AgentOpsSnapshot = AgentOpsRuntimeStore().read()
    @Published var selectedAgentEventID: String?
    @Published var selectedAgentInspector: AgentInspectorSelection = .overview
    @Published var agentRunDetailsExpanded: Bool = false
    @Published var agentPrompt: String = ""
    @Published var agentAttachments: [AgentAttachment] = []
    @Published var selectedAgentModelPreference: AgentModelPreferenceOption = .auto
    @Published var agentSubmitStatus: String = "legacy_client_disabled_use_product_api"
    @Published var loopOpsFocusedContractID: String?
    @Published var selectedLoopOpsRunID: String?
    @Published private(set) var lastLoopOpsRunSubmissionReport = LoopOpsRunSubmissionReport()
    @Published private(set) var loopOpsLastAcknowledgedRunID: String?
    @Published private(set) var loopOpsRunStatusOverridesByRunID: [String: String] = [:]
    @Published private(set) var agentFinalizingRunIDs: Set<String> = []
    @Published private(set) var agentFinalReadModelByRunID: [String: AgentFinalReadModel] = [:]
    @Published private(set) var agentCMCCapabilitySummaryByRunID: [String: CMCCapabilitySummary] = [:]
    @Published private(set) var agentCloudASRSummaryByRunID: [String: CloudASRSummary] = [:]
    @Published private(set) var agentCapabilityLoopByRunID: [String: CapabilityLoopReadModel] = [:]
    @Published private(set) var agentMemoryReadModelByRunID: [String: AgentMemoryReadModel] = [:]
    @Published private(set) var agentSubagentCoordinationByRunID: [String: SubagentCoordinationReadModel] = [:]

    private var backend: RuntimeBackend
    private let runDate: Date
    private var runCount = 0
    private let agentClient: AgentDaemonClient
    private let agentEventClient: AgentEventStreamClient
    private let agentRunReadModelStore: AgentRunReadModelStore
    private var agentRunStreamCoordinators: [String: AgentRunStreamCoordinator] = [:]
    private let agentRunCompletionCoordinator: AgentRunCompletionCoordinator
    private let agentAttachmentStore: AgentAttachmentStore
    private let agentToolRegistryStore: AgentToolRegistryStore
    private let agentOpsRuntimeStore: AgentOpsRuntimeStore
    private let strategyResultStore = CMCStrategyResultStore()
    private var activeStreamRunID: String?
    private var loopOpsRunCapturesByRunID: [String: LoopOpsRunLaunchCapture] = [:]

    // === Filter memoization (perf) ===========================================================
    // `filtered*` recomputed `.filter` on every body pass while searching. Cache by a signature
    // of (data version, query); rebuild only when either changes.
    private var filterDataVersion = 0
    private var filterSignature: String?
    private var memoFilteredMessages: [NormalizedWeChatMessage] = []
    private var memoFilteredTokens: [TokenEntity] = []
    private var memoFilteredCrystals: [IntelligenceCrystal] = []
    private var memoFilteredProposals: [AgentProposal] = []
    private var memoFilteredHandoffs: [HandoffPacket] = []
    private var memoFilteredWatchlistItems: [WatchlistItem] = []

    init(
        backend: RuntimeBackend = RuntimeBackend(),
        runDate: Date = Date(),
        initialWorkspace: TerminalWorkspace = .home,
        agentClient: AgentDaemonClient = AgentDaemonClient(),
        agentEventClient: AgentEventStreamClient = AgentEventStreamClient(),
        agentRunReadModelStore: AgentRunReadModelStore = AgentRunReadModelStore(),
        agentRunStreamCoordinator: AgentRunStreamCoordinator? = nil,
        agentRunCompletionCoordinator: AgentRunCompletionCoordinator = AgentRunCompletionCoordinator(),
        agentAttachmentStore: AgentAttachmentStore = AgentAttachmentStore(),
        agentToolRegistryStore: AgentToolRegistryStore = AgentToolRegistryStore(),
        agentOpsRuntimeStore: AgentOpsRuntimeStore = AgentOpsRuntimeStore()
    ) {
        self.backend = backend
        self.runDate = runDate
        self.selectedWorkspace = initialWorkspace
        self.agentClient = agentClient
        self.agentEventClient = agentEventClient
        self.agentRunReadModelStore = agentRunReadModelStore
        if let agentRunStreamCoordinator, let runID = agentRunStreamCoordinator.activeRunID {
            self.agentRunStreamCoordinators[runID] = agentRunStreamCoordinator
        }
        self.agentRunCompletionCoordinator = agentRunCompletionCoordinator
        self.agentAttachmentStore = agentAttachmentStore
        self.agentToolRegistryStore = agentToolRegistryStore
        self.agentOpsRuntimeStore = agentOpsRuntimeStore
        refresh(reason: "initial")
        refreshAgentWorkspace()
    }

    var headerDateText: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy/MM/dd"
        return formatter.string(from: runDate)
    }

    var subtitle: String {
        "2026-04-24 - 2026-05-23 · 共 \(snapshot.groups.first?.memberCount ?? 0) 个群 · \(selectedWindow.rawValue)窗口"
    }

    func refresh(reason: String = "manual") {
        runCount += 1
        syncState = AgentSyncState(
            status: .running,
            runID: "pending",
            lastRunAt: AgentDateFormatting.isoString(Date()),
            lastSuccessAt: syncState.lastSuccessAt,
            sourceFreshness: syncState.sourceFreshness,
            errorMessage: nil,
            artifactPath: syncState.artifactPath
        )
        refreshStatus = "running · \(reason)"
        let state = backend.execute(.refreshRun(
            reason: reason,
            selectedGroupID: selectedGroupID,
            window: selectedWindow,
            date: runDate
        ))
        apply(state)
        if selectedTokenID == nil {
            selectedTokenID = terminalData.tokenEntities.first?.tokenID
        }
        refreshStatus = "\(syncState.status.rawValue) · \(syncState.sourceFreshness)"
        copyStatus = "可复制"
        appendLog(.info, "UI trigger=\(reason)，runID=\(syncState.runID)，window=\(selectedWindow.rawValue)，group=\(selectedGroupID?.uuidString.prefix(8) ?? "all")。")
    }

    /// Pull fresh live WeChat via the daemon (read-only wechat-cli), then re-run the local
    /// pipeline so the new messages flow in. Degrades to local data if the daemon is down or
    /// WeChat isn't initialized yet.
    func refreshWeChatLiveAndReload() async {
        wechatLiveStatus = "正在拉取实时微信…"
        do {
            let result = try await agentClient.refreshWechatLive()
            switch result.status {
            case "ok":
                wechatLiveStatus = "实时微信已更新（\(result.messages ?? 0) 条）"
            case "empty":
                wechatLiveStatus = "实时微信无新消息"
            case "disabled":
                wechatLiveStatus = "实时微信未启用"
            default:
                wechatLiveStatus = "实时微信未就绪：\(result.hint ?? result.reason ?? result.status)"
            }
        } catch {
            wechatLiveStatus = "历史 Swift 后台链路已停用，请使用 Web Product API"
        }
        refresh(reason: "wechat_live_refresh")
    }

    func select(group: ChatGroup?) {
        selectedGroupID = group?.id
        refresh(reason: group == nil ? "select_all_groups" : "select_group")
    }

    func updateWindow(_ window: TimeWindow) {
        selectedWindow = window
        refresh(reason: "change_time_window")
    }

    func copySummaryToPasteboard() {
        let text = """
        \(snapshot.briefing.title)
        \(snapshot.briefing.body)
        Web3: \(snapshot.web3.detectedSymbols.joined(separator: "/")) · \(snapshot.web3.status)
        Market source: \(snapshot.web3.market.sourceName) · \(snapshot.web3.market.upstreamStatus)
        """

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copyStatus = "已复制"
        appendLog(.info, "摘要已复制到剪贴板，包含 Web3 market context 状态。")
    }

    func select(workspace: TerminalWorkspace) {
        selectedWorkspace = workspace
    }

    func selectLoopOpsRun(_ runID: String?) {
        selectedLoopOpsRunID = runID
    }

    func openToken(_ tokenID: String) {
        apply(backend.execute(.openToken(tokenID)))
        selectedWorkspace = .token
    }

    func selectMessage(_ messageID: UUID) {
        apply(backend.execute(.selectMessage(messageID)))
    }

    func createTaskFromSelectedMessage() {
        guard let selectedMessageID else { return }
        apply(backend.execute(.createTaskFromMessage(selectedMessageID)))
        selectedOperationsTab = .tasks
    }

    func addSelectedTokenToWatchlist() {
        guard let selectedTokenID else { return }
        apply(backend.execute(.addTokenToWatchlist(selectedTokenID)))
        selectedWorkspace = .watchlist
    }

    func acknowledgeAlert(_ alertID: UUID) {
        apply(backend.execute(.acknowledgeAlert(alertID)))
    }

    func muteAlert(_ alertID: UUID) {
        apply(backend.execute(.muteAlert(alertID)))
    }

    func resolveAlert(_ alertID: UUID) {
        apply(backend.execute(.resolveAlert(alertID)))
    }

    func copySelectedEvidenceToPasteboard() {
        guard let evidence = selectedEvidence else { return }
        _ = backend.execute(.copyEvidence(evidence.id))
        let text = "\(evidence.title)\n\(evidence.summary)\nsource=\(evidence.source) freshness=\(evidence.freshness) confidence=\(String(format: "%.2f", evidence.confidence))"
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copyStatus = "Evidence copied"
        appendLog(.info, "Evidence copied: \(evidence.id.uuidString.prefix(8))。")
    }

    func openArtifactReference(_ path: String) {
        apply(backend.execute(.openArtifactReference(path)))
        selectedOperationsTab = .artifacts
    }

    func selectCrystal(_ crystalID: UUID) {
        apply(backend.execute(.selectCrystal(crystalID)))
    }

    func selectProposal(_ proposalID: UUID) {
        apply(backend.execute(.selectProposal(proposalID)))
    }

    func acceptSelectedProposal() {
        guard let selectedProposalID else { return }
        apply(backend.execute(.acceptProposal(selectedProposalID)))
        selectedOperationsTab = .tasks
    }

    func rejectSelectedProposal(reason: String = "Rejected from Agent Proposal panel.") {
        guard let selectedProposalID else { return }
        apply(backend.execute(.rejectProposal(selectedProposalID, reason: reason)))
        selectedOperationsTab = .logs
    }

    func createHandoffFromSelectedCrystal() {
        let ids = selectedCrystalID.map { [$0] } ?? terminalData.proactive.crystals.prefix(3).map(\.id)
        apply(backend.execute(.createHandoff(crystalIDs: ids)))
        selectedOperationsTab = .artifacts
    }

    func archiveSelectedHandoff() {
        guard let id = selectedHandoff?.id else { return }
        apply(backend.execute(.archiveHandoff(id)))
        selectedOperationsTab = .artifacts
    }

    func purgeArchivedHandoffs() {
        apply(backend.execute(.purgeArchivedHandoffs))
        selectedOperationsTab = .artifacts
    }

    func markSelectedCrystalUseful() {
        guard let selectedCrystalID else { return }
        apply(backend.execute(.markCrystalUseful(selectedCrystalID)))
    }

    func markSelectedCrystalFalsePositive() {
        guard let selectedCrystalID else { return }
        apply(backend.execute(.markCrystalFalsePositive(selectedCrystalID, reason: "Marked false positive from Crystal Stream.")))
    }

    /// Per-id variants so inline card actions don't have to change the current selection.
    func markCrystalUseful(_ id: UUID) {
        apply(backend.execute(.markCrystalUseful(id)))
    }

    func markCrystalFalsePositive(_ id: UUID) {
        apply(backend.execute(.markCrystalFalsePositive(id, reason: "Marked false positive inline.")))
    }

    func refreshAgentWorkspace() {
        let registry = agentToolRegistryStore.read()
        agentSkills = registry.skills
        agentExtensions = registry.extensions
        if selectedAgentSkillIDs.isEmpty {
            selectedAgentSkillIDs = Set(registry.skills.filter { $0.defaultSelected ?? false }.map(\.skillID))
        }
        if selectedAgentExtensionIDs.isEmpty {
            selectedAgentExtensionIDs = Set(registry.extensions.filter { $0.defaultSelected ?? false }.map(\.extensionID))
        }
        agentSessions = []
        agentTasks = []
        agentOpsSnapshot = agentOpsRuntimeStore.read()
        reloadSelectedAgentSession()
        Task {
            do {
                let status = try await agentClient.health()
                let remoteRegistry = try? await agentClient.capabilities()
                let remoteSessions = (try? await agentClient.listSessions()) ?? []
                let remoteTasks = (try? await agentClient.listTasks()) ?? []
                await MainActor.run {
                    self.agentDaemonStatus = status
                    self.agentSubmitStatus = "daemon:\(status.status)"
                    self.agentSessions = remoteSessions
                    self.agentTasks = remoteTasks
                    if let selected = self.selectedAgentSessionID,
                       !remoteSessions.contains(where: { $0.sessionID == selected }) {
                        self.selectedAgentSessionID = remoteSessions.first?.sessionID
                    } else if self.selectedAgentSessionID == nil {
                        self.selectedAgentSessionID = remoteSessions.first?.sessionID
                    }
                    self.reloadSelectedAgentSession()
                    let remoteSkills = remoteRegistry?.skills ?? []
                    let remoteExtensions = remoteRegistry?.extensions ?? []
                    if !remoteSkills.isEmpty {
                        self.agentSkills = remoteSkills
                    } else if self.agentSkills.isEmpty {
                        self.agentSkills = status.skills ?? []
                    }
                    if !remoteExtensions.isEmpty {
                        self.agentExtensions = remoteExtensions
                    } else if self.agentExtensions.isEmpty {
                        self.agentExtensions = status.extensions ?? []
                    }
                    self.agentOpsSnapshot = self.agentOpsRuntimeStore.read()
                }
            } catch {
                await MainActor.run {
                    self.agentDaemonStatus = .unavailable
                    self.agentSubmitStatus = "legacy_client_disabled_use_product_api"
                }
            }
        }
    }

    func selectAgentSession(_ sessionID: String) {
        selectedAgentSessionID = sessionID
        selectedAgentInspector = .message(sessionID)
        reloadSelectedAgentSession()
    }

    func renameAgentSession(_ sessionID: String, title: String) {
        Task {
            do {
                let updated = try await agentClient.renameSession(sessionID, title: title)
                let sessions = (try? await agentClient.listSessions()) ?? [updated]
                await MainActor.run {
                    self.agentSessions = sessions
                    if self.selectedAgentSessionID == sessionID {
                        self.agentMessages = updated.messages
                    }
                    self.agentSubmitStatus = "session_renamed"
                }
            } catch {
                await MainActor.run {
                    self.agentSubmitStatus = "session_rename_failed"
                }
            }
        }
    }

    func deleteAgentSession(_ sessionID: String) {
        Task {
            do {
                _ = try await agentClient.deleteSession(sessionID)
                let sessions = (try? await agentClient.listSessions()) ?? []
                let tasks = (try? await agentClient.listTasks()) ?? []
                await MainActor.run {
                    self.agentSessions = sessions
                    self.agentTasks = tasks
                    if self.selectedAgentSessionID == sessionID {
                        self.selectedAgentSessionID = sessions.first?.sessionID
                    }
                    self.agentSubmitStatus = "session_deleted"
                    self.reloadSelectedAgentSession()
                }
            } catch {
                await MainActor.run {
                    self.agentSubmitStatus = "session_delete_failed"
                }
            }
        }
    }

    func deleteAgentTask(_ taskID: String) {
        Task {
            do {
                _ = try await agentClient.deleteTask(taskID)
                let tasks = (try? await agentClient.listTasks()) ?? []
                await MainActor.run {
                    self.agentTasks = tasks
                    self.agentSubmitStatus = "task_deleted"
                }
            } catch {
                await MainActor.run {
                    self.agentSubmitStatus = "task_delete_failed"
                }
            }
        }
    }

    func toggleAgentSkill(_ skillID: String) {
        if selectedAgentSkillIDs.contains(skillID) {
            selectedAgentSkillIDs.remove(skillID)
        } else {
            selectedAgentSkillIDs.insert(skillID)
        }
    }

    func toggleAgentExtension(_ extensionID: String) {
        if selectedAgentExtensionIDs.contains(extensionID) {
            selectedAgentExtensionIDs.remove(extensionID)
        } else {
            selectedAgentExtensionIDs.insert(extensionID)
        }
    }

    func toggleLoopOpsToolDraft(_ draftID: String) {
        if selectedLoopOpsToolDraftIDs.contains(draftID) {
            selectedLoopOpsToolDraftIDs.remove(draftID)
        } else {
            selectedLoopOpsToolDraftIDs.insert(draftID)
        }
    }

    func pickAgentImageAttachment() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.jpeg, .png, .gif, .webP]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let attachment = try agentAttachmentStore.copyImage(from: url)
            agentAttachments.append(attachment)
            selectedAgentSkillIDs.insert("image-analysis")
            agentSubmitStatus = "attachment_ready"
        } catch {
            agentSubmitStatus = "attachment_failed:\(error.localizedDescription)"
        }
    }

    func pickAgentMediaAttachmentForCloudASR() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [
            UTType.audio,
            UTType.movie,
            UTType.mpeg4Movie
        ] + ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "mov", "mp4", "webm", "mkv"]
            .compactMap { UTType(filenameExtension: $0) }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let attachment = try agentAttachmentStore.copyMediaForCloudASR(from: url)
            agentAttachments.append(attachment)
            selectedAgentSkillIDs.insert("meeting-cloud-asr")
            selectedAgentSkillIDs.insert("meeting-minutes")
            selectedAgentExtensionIDs.insert("office-meeting-agent")
            agentSubmitStatus = "cloud_asr_attachment_ready"
        } catch {
            agentSubmitStatus = "attachment_failed:\(error.localizedDescription)"
        }
    }

    func clearAgentAttachments() {
        agentAttachments = []
        agentSubmitStatus = "attachments_cleared"
    }

    func applyAgentTemplate(_ template: AgentTaskTemplate) {
        agentPrompt = template.prompt
        for skillID in template.defaultSkillIDs {
            selectedAgentSkillIDs.insert(skillID)
        }
        for extensionID in template.defaultExtensionIDs {
            selectedAgentExtensionIDs.insert(extensionID)
        }
        agentSubmitStatus = "draft_ready:\(template.id)"
        selectedAgentInspector = .overview
    }

    func selectAgentInspector(_ selection: AgentInspectorSelection) {
        selectedAgentInspector = selection
        if case .event(let eventID) = selection {
            selectedAgentEventID = eventID
        }
    }

    func toggleAgentRunDetails() {
        agentRunDetailsExpanded.toggle()
    }

    func submitAgentPrompt() {
        let prompt = agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else {
            agentSubmitStatus = "prompt_empty"
            return
        }
        submitAgentPrompt(
            prompt: prompt,
            selectedSkillIDs: Array(selectedAgentSkillIDs).sorted(),
            selectedExtensionIDs: Array(selectedAgentExtensionIDs).sorted(),
            clearComposer: true,
            statusPrefix: "run_started",
            reuseSelectedSession: true
        )
    }

    @discardableResult
    func prepareLoopSetup(
        _ contract: LoopContract,
        loopOpsStore: LoopOpsLocalStore? = nil,
        source: String = "run"
    ) -> LoopOpsRunSubmissionReport {
        loopOpsFocusedContractID = contract.id
        agentPrompt = contract.setupPrompt
        selectedAgentSkillIDs = Set(contract.orderedSkillIDs)
        selectedAgentExtensionIDs = Set(contract.orderedExtensionIDs)
        agentSubmitStatus = "loop_setup_needed:\(contract.id)"
        select(workspace: .studio)
        loopOpsStore?.appendMessage(
            scope: .builder,
            scopeID: contract.id,
            title: contract.name,
            role: .assistant,
            text: "Setup needed before running \(contract.name). \(contract.setupChecklistItems.joined(separator: " "))"
        )
        loopOpsStore?.showToast(
            title: "Finish setup before running",
            detail: "\(contract.name) needs \(contract.setupChecklistItems.count) setup item(s).",
            tone: .warning
        )
        let report = LoopOpsRunSubmissionReport(setupRequiredContractIDs: [contract.id])
        lastLoopOpsRunSubmissionReport = report
        return report
    }

    @discardableResult
    func runLoopContract(
        _ contract: LoopContract,
        additionalInstruction: String? = nil,
        parentRunID: String? = nil,
        pendingToolLogIDsByToolID: [String: String] = [:],
        loopOpsStore: LoopOpsLocalStore? = nil,
        clearComposer: Bool = false
    ) -> LoopOpsRunSubmissionReport {
        guard contract.isRunnable else {
            return prepareLoopSetup(contract, loopOpsStore: loopOpsStore, source: "single")
        }
        let readyKnowledgeSources = loopOpsStore?.readyKnowledgeSources(for: contract) ?? []
        let request = LoopOpsRunLaunchRequest(
            contract: contract,
            knowledgeSources: readyKnowledgeSources,
            additionalInstruction: additionalInstruction
        )
        let resolvedSelection = contract.resolvedRunSelection(toolDrafts: loopOpsStore?.toolDrafts ?? [])
        if resolvedSelection.selectedSkillIDs.isEmpty,
           resolvedSelection.selectedExtensionIDs.isEmpty,
           resolvedSelection.localToolDrafts.isEmpty {
            return prepareLoopSetup(contract, loopOpsStore: loopOpsStore, source: "missing-skill-path")
        }
        let pendingReport = LoopOpsRunSubmissionReport(pendingContractIDs: [contract.id])
        lastLoopOpsRunSubmissionReport = pendingReport
        submitAgentPrompt(
            prompt: request.prompt,
            selectedSkillIDs: resolvedSelection.selectedSkillIDs,
            selectedExtensionIDs: resolvedSelection.selectedExtensionIDs,
            clearComposer: clearComposer,
            statusPrefix: "loop_started",
            reuseSelectedSession: false,
            extraContextRefs: request.contextRefs,
            includeSelectedAgentContext: false,
            loopOpsLaunch: LoopOpsRunLaunchCapture(
                contract: contract,
                launchChatScopeID: request.chatScopeID,
                parentRunID: parentRunID,
                localToolDrafts: resolvedSelection.localToolDrafts,
                pendingToolLogIDsByToolID: pendingToolLogIDsByToolID,
                knowledgeSourceIDs: request.knowledgeSourceIDs,
                store: loopOpsStore
            )
        )
        return pendingReport
    }

    @discardableResult
    func runLoopContracts(_ contracts: [LoopContract], loopOpsStore: LoopOpsLocalStore? = nil) -> LoopOpsRunSubmissionReport {
        let runnableContracts = contracts.filter(\.isRunnable)
        let setupRequiredContracts = contracts.filter { !$0.isRunnable }
        for contract in runnableContracts {
            runLoopContract(contract, loopOpsStore: loopOpsStore)
        }
        if let firstSetupContract = setupRequiredContracts.first {
            prepareLoopSetup(firstSetupContract, loopOpsStore: loopOpsStore, source: "batch")
        }
        let report = LoopOpsRunSubmissionReport(
            setupRequiredContractIDs: setupRequiredContracts.map(\.id),
            pendingContractIDs: runnableContracts.map(\.id)
        )
        lastLoopOpsRunSubmissionReport = report
        return report
    }

    func submitLoopOpsRunFollowUp(
        prompt: String,
        selectedRun: WorkbenchLoopRunState,
        loopOpsStore: LoopOpsLocalStore? = nil
    ) {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            agentSubmitStatus = "prompt_empty"
            return
        }
        let runInstruction = """
        基于当前选中的 Run 继续追问：\(trimmed)

        原任务：\(selectedRun.task.prompt)
        """
        submitAgentPrompt(
            prompt: runInstruction,
            selectedSkillIDs: selectedRun.task.selectedSkillIDs ?? [],
            selectedExtensionIDs: selectedRun.task.selectedExtensionIDs ?? [],
            clearComposer: false,
            statusPrefix: "run_followup_started",
            reuseSelectedSession: false,
            extraContextRefs: loopOpsStore?.contextReferences(forRunID: selectedRun.task.runID) ?? [],
            includeSelectedAgentContext: false,
            followUpParentRunID: selectedRun.task.runID,
            followUpStore: loopOpsStore
        )
    }

    private static func mergeContextRefs(_ references: [RuntimeObjectReference]) -> [RuntimeObjectReference] {
        var seen: Set<String> = []
        var merged: [RuntimeObjectReference] = []
        for reference in references {
            let key = "\(reference.kind.rawValue):\(reference.id)"
            guard seen.insert(key).inserted else { continue }
            merged.append(reference)
        }
        return merged
    }

    private func submitAgentPrompt(
        prompt: String,
        selectedSkillIDs: [String],
        selectedExtensionIDs: [String],
        clearComposer: Bool,
        statusPrefix: String,
        reuseSelectedSession: Bool,
        extraContextRefs: [RuntimeObjectReference] = [],
        includeSelectedAgentContext: Bool = true,
        loopOpsLaunch: LoopOpsRunLaunchCapture? = nil,
        followUpParentRunID: String? = nil,
        followUpStore: LoopOpsLocalStore? = nil
    ) {
        agentSubmitStatus = "submitting"
        let attachments = agentAttachments
        let refs = Self.mergeContextRefs((includeSelectedAgentContext ? agentContextRefs : []) + extraContextRefs)
        let modelPreference = selectedAgentModelPreference.requestPayload
        Task {
            do {
                let sessionID: String
                if reuseSelectedSession, let existing = selectedAgentSessionID {
                    sessionID = existing
                } else {
                    let session = try await agentClient.createSession(title: prompt.prefix(28).description)
                    sessionID = session.sessionID
                }
                let response = try await agentClient.postMessageAsync(
                    sessionID: sessionID,
                    prompt: prompt,
                    selectedSkillIDs: selectedSkillIDs,
                    selectedExtensionIDs: selectedExtensionIDs,
                    attachments: attachments,
                    contextRefs: refs,
                    modelPreference: modelPreference
                )
                await MainActor.run {
                    self.selectedAgentSessionID = response.session.sessionID
                    if clearComposer {
                        self.agentPrompt = ""
                        self.agentAttachments = []
                    }
                    self.agentSessions = [response.session] + self.agentSessions.filter { $0.sessionID != response.session.sessionID }
                    self.agentMessages = response.session.messages
                    self.agentTasks = [response.task] + self.agentTasks.filter { $0.taskID != response.task.taskID }
                    if let loopOpsLaunch {
                        self.loopOpsRunCapturesByRunID[response.runID] = loopOpsLaunch
                        self.loopOpsLastAcknowledgedRunID = response.runID
                        self.selectedLoopOpsRunID = response.runID
                        var report = self.lastLoopOpsRunSubmissionReport
                        report.queuedContractIDs = Array(Set(report.queuedContractIDs + [loopOpsLaunch.contract.id])).sorted()
                        report.acknowledgedRunIDs = Array(Set(report.acknowledgedRunIDs + [response.runID])).sorted()
                        report.pendingContractIDs.removeAll { $0 == loopOpsLaunch.contract.id }
                        self.lastLoopOpsRunSubmissionReport = report
                        if let store = loopOpsLaunch.store {
                            store.captureRunLedger(
                                RunLedgerRow.from(
                                    task: response.task,
                                    contract: loopOpsLaunch.contract,
                                    finalReadModel: nil,
                                    knowledgeSourceIDs: loopOpsLaunch.knowledgeSourceIDs
                                )
                            )
                            for sourceID in loopOpsLaunch.knowledgeSourceIDs {
                                store.attachKnowledgeSource(
                                    id: sourceID,
                                    toRunID: response.runID,
                                    runTitle: loopOpsLaunch.contract.name
                                )
                            }
                            if let parentRunID = loopOpsLaunch.parentRunID {
                                store.recordFollowUpRun(
                                    parentRunID: parentRunID,
                                    childRunID: response.runID,
                                    title: loopOpsLaunch.contract.name
                                )
                            }
                            for (_, logID) in loopOpsLaunch.pendingToolLogIDsByToolID {
                                store.acknowledgeToolLogRun(
                                    logID: logID,
                                    runID: response.runID,
                                    runTitle: loopOpsLaunch.contract.name
                                )
                            }
                            for draft in loopOpsLaunch.localToolDrafts {
                                if loopOpsLaunch.pendingToolLogIDsByToolID[draft.id] != nil {
                                    continue
                                }
                                store.appendToolLog(
                                    LoopOpsToolLog(
                                        toolID: draft.id,
                                        title: "\(draft.name) linked to run",
                                        status: "Run scoped",
                                        summary: "Local Tool was kept as reviewed run context. Executable Skill OS packages handled the live run.",
                                        durationLabel: "instant",
                                        reviewState: "No external action",
                                        runID: response.runID,
                                        source: draft.resolvedIntegrationSource,
                                        userLabel: "Run",
                                        costLabel: "0 credits"
                                    )
                                )
                            }
                            store.showToast(
                                title: "Loop queued",
                                detail: "\(loopOpsLaunch.contract.name) acknowledged and is running in the background.",
                                tone: .success
                            )
                        }
                    } else if let followUpParentRunID {
                        self.loopOpsLastAcknowledgedRunID = response.runID
                        self.selectedLoopOpsRunID = response.runID
                        followUpStore?.recordFollowUpRun(
                            parentRunID: followUpParentRunID,
                            childRunID: response.runID,
                            title: response.task.prompt
                        )
                    }
                    self.agentStreamEvents = []
                    self.agentToolCalls = []
                    self.agentRunManifest = nil
                    self.agentControlSummary = nil
                    self.agentContextSummary = nil
                    self.selectedAgentEventID = nil
                    self.agentSubmitStatus = "\(statusPrefix):\(response.runID)"
                    self.subscribeAgentEvents(runID: response.runID)
                    self.selectedAgentInspector = .task(response.task.taskID)
                    self.agentRunDetailsExpanded = false
                }
            } catch {
                await MainActor.run {
                    self.agentSubmitStatus = "submit_failed:\(error.localizedDescription)"
                    if let loopOpsLaunch {
                        self.lastLoopOpsRunSubmissionReport = LoopOpsRunSubmissionReport(
                            failedContractIDs: [loopOpsLaunch.contract.id],
                            errorMessage: error.localizedDescription
                        )
                        for (_, logID) in loopOpsLaunch.pendingToolLogIDsByToolID {
                            loopOpsLaunch.store?.failToolLogRun(
                                logID: logID,
                                errorMessage: error.localizedDescription
                            )
                        }
                        loopOpsLaunch.store?.showToast(
                            title: "Loop failed to start",
                            detail: error.localizedDescription,
                            tone: .error
                        )
                    }
                }
            }
        }
    }

    func pauseSelectedAgentRun() {
        controlSelectedAgentRun("pause")
    }

    func resumeSelectedAgentRun() {
        controlSelectedAgentRun("resume")
    }

    func cancelSelectedAgentRun() {
        controlSelectedAgentRun("cancel")
    }

    func loopOpsTaskApplyingLifecycleOverride(_ task: AgentLongTask) -> AgentLongTask {
        guard let status = loopOpsRunStatusOverridesByRunID[task.runID] else { return task }
        return AgentLongTask(
            taskID: task.taskID,
            sessionID: task.sessionID,
            runID: task.runID,
            prompt: task.prompt,
            status: status,
            selectedToolNames: task.selectedToolNames,
            selectedSkillIDs: task.selectedSkillIDs,
            selectedExtensionIDs: task.selectedExtensionIDs,
            attachmentIDs: task.attachmentIDs,
            artifactPath: task.artifactPath,
            createdAt: task.createdAt,
            updatedAt: AgentDateFormatting.isoString(Date())
        )
    }

    func applyLoopOpsRunLifecycleAction(
        _ action: LoopOpsRunLifecycleAction,
        runID: String,
        loopOpsStore: LoopOpsLocalStore?
    ) {
        loopOpsRunStatusOverridesByRunID[runID] = action.resultStatus
        _ = loopOpsStore?.applyRunLifecycleAction(runID: runID, action: action)
        agentSubmitStatus = "loop_run_\(action.rawValue):\(runID)"
        guard let backendAction = action.backendControlAction else { return }
        controlAgentRun(runID: runID, action: backendAction)
    }

    var selectedAgentSession: AgentSession? {
        agentSessions.first(where: { $0.sessionID == selectedAgentSessionID })
    }

    var selectedAgentRunID: String? {
        selectedAgentSession?.activeRunID ?? agentTasks.first?.runID
    }

    var selectedAgentEvent: AgentStreamEvent? {
        agentStreamEvents.first(where: { $0.eventID == selectedAgentEventID }) ?? agentStreamEvents.last
    }

    var agentAssistantText: String {
        agentAssistantText(for: activeStreamRunID)
    }

    func agentAssistantText(for runID: String?) -> String {
        Self.assistantText(from: agentStreamEvents, runID: runID)
    }

    nonisolated static func assistantText(from events: [AgentStreamEvent], runID: String?) -> String {
        guard let runID, !runID.isEmpty else { return "" }
        return events
            .filter { $0.runID == runID }
            .compactMap(\.delta)
            .joined()
    }

    func isAgentRunFinalizing(_ runID: String?) -> Bool {
        guard let runID else { return false }
        return agentFinalizingRunIDs.contains(runID)
    }

    func isActiveAgentStreamRun(_ runID: String?) -> Bool {
        guard let runID, !runID.isEmpty else { return false }
        return activeStreamRunID == runID
    }

    func agentRunMissingToolObservations(_ runID: String?) -> Bool {
        guard let runID else { return false }
        return !agentRunReadModelStore.hasToolObservations(runID: runID)
    }

    func agentFinalDiagnostics(runID: String?) -> [String] {
        guard let runID, let model = agentFinalReadModelByRunID[runID] else { return [] }
        var items: [String] = []
        let researchStatus = model.cmcGateSummary?.researchEvidence?.status ?? model.cmcGateSummary?.researchEvidenceStatus
        let allowConcretePrices = model.cmcGateSummary?.priceSnapshot?.allowConcretePrices ?? model.cmcGateSummary?.allowConcretePrices
        if researchStatus == "empty" {
            items.append("Evidence empty")
        }
        if allowConcretePrices == false {
            items.append("Prices blocked")
        }
        if model.outputGuardStatus == "rewritten" {
            items.append("Final rewritten")
        }
        if model.productMutationPolicy?.status == "discarded" {
            items.append("Mutations discarded")
        }
        return items
    }

    @discardableResult
    func reconcileLoopOpsRunResult(runID: String, loopOpsStore: LoopOpsLocalStore) -> Bool {
        let trimmedRunID = runID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedRunID.isEmpty else { return false }
        let finalReadModel = agentRunReadModelStore.readFinalReadModel(runID: trimmedRunID)
            ?? agentFinalReadModelByRunID[trimmedRunID]
        if let finalReadModel {
            agentFinalReadModelByRunID[trimmedRunID] = finalReadModel
        }
        return refreshLoopOpsLedgerIfPossible(
            runID: trimmedRunID,
            finalReadModel: finalReadModel,
            loopOpsStore: loopOpsStore
        )
    }

    @discardableResult
    func reconcileLoopOpsRunResults(in loopOpsStore: LoopOpsLocalStore) -> Int {
        let runIDs = Set(loopOpsStore.runLedgers.map(\.runID) + agentTasks.map(\.runID) + Array(loopOpsRunCapturesByRunID.keys))
        return runIDs.reduce(0) { count, runID in
            count + (reconcileLoopOpsRunResult(runID: runID, loopOpsStore: loopOpsStore) ? 1 : 0)
        }
    }

    var agentThreadState: AgentThreadState {
        AgentWorkspaceStateAdapter.makeThreadState(
            selectedSession: selectedAgentSession,
            messages: agentMessages,
            streamEvents: agentStreamEvents,
            toolCalls: agentToolCalls,
            runManifest: agentRunManifest,
            controlSummary: agentControlSummary,
            contextSummary: agentContextSummary,
            longTasks: agentTasks,
            daemonStatus: agentDaemonStatus,
            contextRefs: agentContextRefs,
            selectedSkillIDs: selectedAgentSkillIDs,
            selectedExtensionIDs: selectedAgentExtensionIDs,
            pendingAttachments: agentAttachments,
            draftPrompt: agentPrompt,
            selectedEventID: selectedAgentEventID,
            finalReadModelsByRunID: agentFinalReadModelByRunID,
            strategyResults: agentStrategyResults
        )
    }

    var agentContextChips: [AgentContextChip] {
        AgentWorkspaceStateAdapter.makeContextChips(from: agentContextRefs)
    }

    var agentContextRefs: [RuntimeObjectReference] {
        var refs: [RuntimeObjectReference] = []
        if let crystal = selectedCrystal {
            refs.append(RuntimeObjectReference(
                id: crystal.id.uuidString,
                kind: .crystal,
                label: crystal.title,
                path: "runtime/crystals/crystals.json",
                value: crystal.id.uuidString,
                source: "swift_agent_console_selection",
                freshness: crystal.freshness,
                confidence: crystal.confidence,
                privacyLevel: "local",
                redactionStatus: "pointer_only",
                generatedAt: crystal.updatedAt,
                runID: crystal.provenance.runID
            ))
        }
        if let token = selectedToken {
            refs.append(RuntimeObjectReference(
                id: token.tokenID,
                kind: .token,
                label: "\(token.symbol) · \(token.chain)",
                path: "runtime/entities/token-entities.json",
                value: token.tokenID,
                source: "swift_agent_console_selection",
                freshness: ProactiveFreshness(rawValue: token.freshness) ?? .unknown,
                confidence: token.confidence,
                privacyLevel: "local",
                redactionStatus: "pointer_only",
                generatedAt: nil,
                runID: syncState.runID
            ))
        }
        if let message = selectedMessage {
            refs.append(RuntimeObjectReference(
                id: message.id.uuidString,
                kind: .message,
                label: "\(message.groupName) · \(message.sender)",
                path: "runtime/wechat/messages.normalized.json",
                value: message.id.uuidString,
                source: "swift_agent_console_selection",
                freshness: .fixture,
                confidence: nil,
                privacyLevel: "private",
                redactionStatus: "pointer_only",
                generatedAt: AgentDateFormatting.isoString(message.sentAt),
                runID: syncState.runID
            ))
        }
        return refs
    }

    var selectedToken: TokenEntity? {
        terminalData.tokenEntities.first(where: { $0.tokenID == selectedTokenID }) ?? filteredTokens.first ?? terminalData.tokenEntities.first
    }

    var selectedMessage: NormalizedWeChatMessage? {
        terminalData.normalizedMessages.first(where: { $0.id == selectedMessageID })
    }

    var selectedEvidence: EvidenceItem? {
        if let selectedEvidenceID {
            return terminalData.evidenceItems.first(where: { $0.id == selectedEvidenceID })
        }
        if let selectedTokenID {
            return terminalData.evidenceItems.first(where: { $0.tokenIDs.contains(selectedTokenID) })
        }
        if let selectedMessageID {
            return terminalData.evidenceItems.first(where: { $0.messageIDs.contains(selectedMessageID) })
        }
        return terminalData.evidenceItems.first
    }

    var selectedAlert: AlertRecord? {
        terminalData.alerts.first(where: { $0.id == selectedAlertID }) ?? terminalData.alerts.first
    }

    var selectedCrystal: IntelligenceCrystal? {
        terminalData.proactive.crystals.first(where: { $0.id == selectedCrystalID }) ?? filteredCrystals.first ?? terminalData.proactive.crystals.first
    }

    var selectedProposal: AgentProposal? {
        if let selectedProposalID {
            return terminalData.proactive.proposals.first(where: { $0.id == selectedProposalID })
        }
        if hasSearch {
            return filteredProposals.first
        }
        if let selectedCrystal {
            return terminalData.proactive.proposals.first { proposal in
                proposal.crystalRefs.contains { $0.id == selectedCrystal.id.uuidString }
            }
        }
        return terminalData.proactive.proposals.first
    }

    var selectedMemory: MemoryEntry? {
        terminalData.proactive.memory.first(where: { $0.id == selectedMemoryID })
    }

    var selectedHandoff: HandoffPacket? {
        terminalData.proactive.handoffs.first(where: { $0.id == selectedHandoffID }) ?? filteredHandoffs.first ?? terminalData.proactive.handoffs.first
    }

    var selectedTokenMessages: [NormalizedWeChatMessage] {
        guard let token = selectedToken else { return [] }
        return filteredMessages.filter { $0.linkedTokenIDs.contains(token.tokenID) }
    }

    var selectedTokenMarket: MarketAsset? {
        guard let token = selectedToken else { return nil }
        return terminalData.marketSnapshots.flatMap(\.assets).first { $0.symbol == token.symbol }
    }

    var selectedTokenOnchain: OnchainSnapshot? {
        guard let token = selectedToken else { return nil }
        return terminalData.onchainSnapshots.first { $0.tokenID == token.tokenID }
    }

    var hasSearch: Bool {
        !normalizedSearchQuery.isEmpty
    }

    var filteredMessages: [NormalizedWeChatMessage] {
        rebuildFilterCacheIfNeeded()
        return memoFilteredMessages
    }

    var filteredTokens: [TokenEntity] {
        rebuildFilterCacheIfNeeded()
        return memoFilteredTokens
    }

    var filteredCrystals: [IntelligenceCrystal] {
        rebuildFilterCacheIfNeeded()
        return memoFilteredCrystals
    }

    var filteredProposals: [AgentProposal] {
        rebuildFilterCacheIfNeeded()
        return memoFilteredProposals
    }

    var filteredHandoffs: [HandoffPacket] {
        rebuildFilterCacheIfNeeded()
        return memoFilteredHandoffs
    }

    var filteredWatchlistItems: [WatchlistItem] {
        rebuildFilterCacheIfNeeded()
        return memoFilteredWatchlistItems
    }

    /// Recompute all filtered lists only when the data version or search query changed.
    /// Called from the `filtered*` getters (safe to mutate stored state from a class getter).
    private func rebuildFilterCacheIfNeeded() {
        let signature = "\(filterDataVersion)|\(normalizedSearchQuery)"
        guard filterSignature != signature else { return }
        filterSignature = signature

        guard hasSearch else {
            memoFilteredMessages = terminalData.normalizedMessages
            memoFilteredTokens = terminalData.tokenEntities
            memoFilteredCrystals = terminalData.proactive.crystals
            memoFilteredProposals = terminalData.proactive.proposals
            memoFilteredHandoffs = terminalData.proactive.handoffs
            memoFilteredWatchlistItems = terminalData.watchlistItems
            return
        }

        memoFilteredMessages = terminalData.normalizedMessages.filter { message in
            matchesSearch([
                message.groupName,
                message.sender,
                message.text,
                message.extractedSymbols.joined(separator: " "),
                message.extractedContracts.joined(separator: " "),
                message.linkedTokenIDs.joined(separator: " ")
            ])
        }
        memoFilteredTokens = terminalData.tokenEntities.filter { token in
            matchesSearch([
                token.tokenID,
                token.symbol,
                token.name,
                token.chain,
                token.contractAddress ?? "",
                token.aliases.joined(separator: " ")
            ])
        }
        memoFilteredCrystals = terminalData.proactive.crystals.filter { crystal in
            matchesSearch([
                crystal.title,
                crystal.rationale,
                crystal.detail,
                crystal.sourceMix.joined(separator: " "),
                crystal.tokenRefs.map { "\($0.label) \($0.id) \($0.value ?? "")" }.joined(separator: " ")
            ])
        }
        memoFilteredProposals = terminalData.proactive.proposals.filter { proposal in
            matchesSearch([
                proposal.title,
                proposal.summary,
                proposal.rationale,
                proposal.action.rawValue,
                proposal.tokenRefs.map { "\($0.label) \($0.id) \($0.value ?? "")" }.joined(separator: " ")
            ])
        }
        memoFilteredHandoffs = terminalData.proactive.handoffs.filter { handoff in
            matchesSearch([
                handoff.title,
                handoff.summaryText,
                handoff.status.rawValue,
                handoff.selectedCrystalRefs.map { $0.label }.joined(separator: " "),
                handoff.tokenRefs.map { "\($0.label) \($0.id) \($0.value ?? "")" }.joined(separator: " ")
            ])
        }
        memoFilteredWatchlistItems = terminalData.watchlistItems.filter { item in
            matchesSearch([
                item.tokenID,
                item.symbol,
                item.chain,
                item.contractAddress ?? "",
                item.reason,
                item.status
            ])
        }
    }

    private var normalizedSearchQuery: String {
        searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func matchesSearch(_ values: [String]) -> Bool {
        let query = normalizedSearchQuery
        guard !query.isEmpty else { return true }
        return values.contains { $0.lowercased().contains(query) }
    }

    private func appendLog(_ level: LogLevel, _ message: String) {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        logs.insert(AgentRunLog(level: level, message: message, timestamp: formatter.string(from: Date())), at: 0)
    }

    private func reloadSelectedAgentSession() {
        if let session = selectedAgentSession {
            agentMessages = session.messages
            agentStreamEvents = agentRunReadModelStore.readEvents(runID: session.activeRunID)
            agentToolCalls = agentRunReadModelStore.readToolCalls(runID: session.activeRunID)
            loadAgentRunReadModels(runID: session.activeRunID)
        } else {
            agentMessages = []
            agentStreamEvents = []
            agentToolCalls = []
            loadAgentRunReadModels(runID: nil)
        }
        selectedAgentEventID = agentStreamEvents.last?.eventID
    }

    private func loadAgentRunReadModels(runID: String?) {
        agentRunManifest = agentRunReadModelStore.readRunManifest(runID: runID)
        agentControlSummary = agentRunReadModelStore.readControlSummary(runID: runID)
        agentContextSummary = agentRunReadModelStore.readContextSummary(runID: runID)
        agentStrategyResults = strategyResultStore.results(forRunID: runID)
        if let runID, let finalReadModel = agentRunReadModelStore.readFinalReadModel(runID: runID) {
            agentFinalReadModelByRunID[runID] = finalReadModel
            refreshLoopOpsLedgerIfPossible(runID: runID, finalReadModel: finalReadModel)
        }
        if let runID, let cmcCapabilitySummary = agentRunReadModelStore.readCMCCapabilitySummary(runID: runID) {
            agentCMCCapabilitySummaryByRunID[runID] = cmcCapabilitySummary
        }
        if let runID, let cloudASRSummary = agentRunReadModelStore.readCloudASRSummary(runID: runID) {
            agentCloudASRSummaryByRunID[runID] = cloudASRSummary
        }
        if let runID, let capabilityLoop = agentRunReadModelStore.readCapabilityLoopReadModel(runID: runID) {
            agentCapabilityLoopByRunID[runID] = capabilityLoop
        }
        if let runID, let memoryReadModel = agentRunReadModelStore.readMemoryReadModel(runID: runID) {
            agentMemoryReadModelByRunID[runID] = memoryReadModel
        }
        if let runID, let subagentCoordination = agentRunReadModelStore.readSubagentCoordinationReadModel(runID: runID) {
            agentSubagentCoordinationByRunID[runID] = subagentCoordination
        }
    }

    @discardableResult
    private func refreshLoopOpsLedgerIfPossible(
        runID: String,
        finalReadModel: AgentFinalReadModel?,
        loopOpsStore: LoopOpsLocalStore? = nil
    ) -> Bool {
        let capture = loopOpsRunCapturesByRunID[runID]
        guard let store = loopOpsStore ?? capture?.store else {
            return false
        }
        let task = agentTasks.first(where: { $0.runID == runID })
        let existingLedger = store.runLedger(runID: runID)
        let refreshedLedger: RunLedgerRow
        if let capture, let task {
            refreshedLedger = RunLedgerRow.from(
                task: task,
                contract: capture.contract,
                finalReadModel: finalReadModel
            )
        } else if let existingLedger {
            var ledger = existingLedger
            if let finalReadModel {
                ledger.status = finalReadModel.status
                ledger.completedAt = finalReadModel.generatedAt
            } else if let task {
                ledger.status = task.status
                ledger.completedAt = task.updatedAt
            }
            refreshedLedger = ledger
        } else {
            return false
        }

        var ledger = mergeDurableLoopOpsFields(from: existingLedger, into: refreshedLedger)
        if let packet = refreshedLoopOpsReviewPacket(
            runID: runID,
            ledger: ledger,
            task: task,
            finalReadModel: finalReadModel,
            existingPacket: store.reviewPacket(runID: runID)
        ) {
            ledger = ledger.applyingReviewPacket(packet)
            store.captureRunLedger(ledger)
            store.upsertReviewPacket(packet)
        } else {
            store.captureRunLedger(ledger)
        }
        return true
    }

    private func refreshedLoopOpsReviewPacket(
        runID: String,
        ledger: RunLedgerRow,
        task: AgentLongTask?,
        finalReadModel: AgentFinalReadModel?,
        existingPacket: ReviewPacketViewModel?
    ) -> ReviewPacketViewModel? {
        guard finalReadModel != nil || existingPacket != nil || !ledger.finalAnswerPreview.isEmpty else {
            return nil
        }
        let packetTask = task ?? loopOpsSyntheticTask(from: ledger, finalReadModel: finalReadModel)
        var packet = ReviewPacketViewModel.from(
            task: packetTask,
            domain: ledger.domain,
            finalReadModel: finalReadModel
        )
        if finalReadModel == nil {
            packet.finalAnswer = ledger.finalAnswerPreview
            packet.claims = ledger.finalAnswerPreview.isEmpty ? [] : [String(ledger.finalAnswerPreview.prefix(140))]
            packet.evidenceGaps = ledger.evidenceGaps
            packet.blockedActions = ledger.blockedActions
        }
        if let existingPacket {
            packet.reviewDecision = existingPacket.reviewDecision
        } else {
            packet.reviewDecision = ledger.reviewDecision
        }
        if !ledger.followUpPrompts.isEmpty {
            packet.nextQuestions = ledger.followUpPrompts
        }
        packet.id = runID
        packet.runID = runID
        return packet
    }

    private func loopOpsSyntheticTask(from ledger: RunLedgerRow, finalReadModel: AgentFinalReadModel?) -> AgentLongTask {
        AgentLongTask(
            taskID: finalReadModel?.taskID ?? "task-\(ledger.runID)",
            sessionID: finalReadModel?.sessionID ?? "session-\(ledger.runID)",
            runID: ledger.runID,
            prompt: ledger.title,
            status: finalReadModel?.status ?? ledger.status,
            selectedToolNames: [],
            selectedSkillIDs: ledger.skillPath,
            selectedExtensionIDs: nil,
            attachmentIDs: [],
            artifactPath: finalReadModel?.artifactPath ?? "runtime/agent/runs/\(ledger.runID)/task.json",
            createdAt: ledger.startedAt ?? finalReadModel?.generatedAt ?? AgentDateFormatting.isoString(Date()),
            updatedAt: finalReadModel?.generatedAt ?? ledger.completedAt ?? AgentDateFormatting.isoString(Date())
        )
    }

    private func mergeDurableLoopOpsFields(from existingLedger: RunLedgerRow?, into refreshedLedger: RunLedgerRow) -> RunLedgerRow {
        guard let existingLedger else { return refreshedLedger }
        var ledger = refreshedLedger
        ledger.startedAt = ledger.startedAt ?? existingLedger.startedAt
        ledger.completedAt = ledger.completedAt ?? existingLedger.completedAt
        if ledger.inputsUsed.isEmpty {
            ledger.inputsUsed = existingLedger.inputsUsed
        }
        if ledger.followUpPrompts.isEmpty {
            ledger.followUpPrompts = existingLedger.followUpPrompts
        }
        if ledger.skillPath?.isEmpty != false {
            ledger.skillPath = existingLedger.skillPath
        }
        if ledger.lifecycleEvents?.isEmpty != false {
            ledger.lifecycleEvents = existingLedger.lifecycleEvents
        }
        ledger.knowledgeSourceIDs = existingLedger.knowledgeSourceIDs
        return ledger
    }

    /// Sample strategy results used for previewing the workbench cards before a live CMC run
    /// produces real artifacts. Clearly labeled `样例数据` in the UI.
    var agentStrategyPreviews: [CMCStrategistResult] {
        [.alphaSample, .perpSample, .macroSample]
    }

    /// Resolve a strategy result by id for the inspector — checks live results then previews.
    func strategyResult(id: String) -> CMCStrategistResult? {
        (agentStrategyResults + agentStrategyPreviews).first { $0.id == id }
    }

    private func subscribeAgentEvents(runID: String) {
        let coordinator = agentRunStreamCoordinators[runID] ?? AgentRunStreamCoordinator(eventClient: agentEventClient)
        agentRunStreamCoordinators[runID] = coordinator
        agentFinalizingRunIDs = agentRunCompletionCoordinator.finalizingRunIDs
        activeStreamRunID = runID
        coordinator.start(
            runID: runID,
            onFlush: { [weak self] events, terminal in
                guard let self else { return }
                if !events.isEmpty {
                    self.agentStreamEvents.append(contentsOf: events)
                    if self.activeStreamRunID == runID {
                        self.selectedAgentEventID = events.last?.eventID
                    }
                    if terminal == nil {
                        if self.activeStreamRunID == runID {
                            self.agentToolCalls = self.agentRunReadModelStore.readToolCalls(runID: runID)
                        }
                        self.loadAgentRunReadModels(runID: runID)
                    }
                }
                if let terminal {
                    self.startAgentFinalization(runID: runID, terminal: terminal)
                }
            },
            onFailure: { [weak self] error in
                guard let self else { return }
                self.agentSubmitStatus = "stream_failed:\(error.localizedDescription)"
                let localEvents = self.agentRunReadModelStore.readEvents(runID: runID)
                let existingEventIDs = Set(self.agentStreamEvents.map(\.eventID))
                self.agentStreamEvents.append(contentsOf: localEvents.filter { !existingEventIDs.contains($0.eventID) })
                if self.activeStreamRunID == runID {
                    self.agentToolCalls = self.agentRunReadModelStore.readToolCalls(runID: runID)
                    self.selectedAgentEventID = localEvents.last?.eventID
                }
                self.loadAgentRunReadModels(runID: runID)
            }
        )
    }

    private func startAgentFinalization(runID: String, terminal: AgentStreamEvent) {
        agentRunCompletionCoordinator.start(
            runID: runID,
            terminal: terminal,
            isRunActive: { [weak self] in
                self?.agentRunStreamCoordinators[runID] != nil
            },
            loadLocalReadModels: { [weak self] in
                guard let self else { return nil }
                if self.activeStreamRunID == runID {
                    self.agentToolCalls = self.agentRunReadModelStore.readToolCalls(runID: runID)
                }
                self.loadAgentRunReadModels(runID: runID)
                return self.agentFinalReadModelByRunID[runID]
            },
            importProductMutations: { [weak self] in
                guard let self else { return }
                let state = self.backend.execute(.importAgentProductMutations(runID: runID))
                self.apply(state)
            },
            refreshRemoteState: { [weak self] in
                await self?.refreshAgentRemoteState(runID: runID)
            },
            updateStatus: { [weak self] status, finalizingRunIDs in
                guard let self else { return }
                self.agentSubmitStatus = status
                self.agentFinalizingRunIDs = finalizingRunIDs
            }
        )
    }

    private func refreshAgentRemoteState(runID: String) async {
        let selectedID = selectedAgentSessionID
        let sessions = (try? await agentClient.listSessions()) ?? []
        let tasks = (try? await agentClient.listTasks()) ?? []
        let selected: AgentSession?
        if let selectedID {
            selected = try? await agentClient.getSession(selectedID)
        } else {
            selected = nil
        }
        agentSessions = sessions
        agentTasks = tasks
        if let selected {
            agentMessages = selected.messages
        }
    }

    private func controlSelectedAgentRun(_ action: String) {
        guard let runID = selectedAgentRunID else {
            agentSubmitStatus = "run_missing"
            return
        }
        controlAgentRun(runID: runID, action: action)
    }

    private func controlAgentRun(runID: String, action: String) {
        Task {
            do {
                _ = try await agentClient.control(runID: runID, action: action)
                await MainActor.run {
                    self.agentSubmitStatus = "run_\(action)"
                    self.refreshAgentWorkspace()
                }
            } catch {
                await MainActor.run {
                    self.agentSubmitStatus = "run_\(action)_failed:\(error.localizedDescription)"
                }
            }
        }
    }

    private func apply(_ state: RuntimeBackendState) {
        snapshot = state.result.snapshot
        logs = state.result.logs
        capabilities = state.result.capabilities
        policies = state.result.policies
        envelope = state.result.envelope
        syncState = state.result.syncState
        artifactStatus = state.result.artifactStatus
        terminalData = state.result.terminalData
        filterDataVersion &+= 1   // invalidate filtered-list memo cache
        runtimeCommandStatus = state.commandStatus
        selectedMessageID = state.selection.selectedMessageID
        selectedTokenID = state.selection.selectedTokenID ?? selectedTokenID
        selectedEvidenceID = state.selection.selectedEvidenceID
        selectedAlertID = state.selection.selectedAlertID
        selectedArtifactPath = state.selection.selectedArtifactPath
        selectedCrystalID = state.selection.selectedCrystalID ?? selectedCrystalID ?? state.result.terminalData.proactive.crystals.first?.id
        selectedProposalID = state.selection.selectedProposalID ?? selectedProposalID
        selectedMemoryID = state.selection.selectedMemoryID
        selectedHandoffID = state.selection.selectedHandoffID ?? selectedHandoffID
    }
}
