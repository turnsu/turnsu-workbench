import Combine
import Foundation

@MainActor
final class LoopOpsLocalStore: ObservableObject {
    @Published private(set) var loopContracts: [LoopContract]
    @Published private(set) var chatThreads: [ChatThread]
    @Published private(set) var reviewPackets: [ReviewPacketViewModel]
    @Published private(set) var runLedgers: [RunLedgerRow]
    @Published private(set) var shareSafeLogs: [ShareSafeLogPreview]
    @Published private(set) var skillStacks: [LoopOpsSkillStack]
    @Published private(set) var knowledgeSources: [LoopOpsKnowledgeSource]
    @Published private(set) var toolDrafts: [LoopOpsToolDraft]
    @Published private(set) var toolLogs: [LoopOpsToolLog]
    @Published private(set) var builderPackets: [LoopOpsBuilderPacket]
    @Published private(set) var toasts: [LoopOpsToast]

    private let rootURL: URL
    private let fileManager: FileManager
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let strictJSONStore: LoopOpsLocalJSONStore?

    static func defaultStore() -> LoopOpsLocalStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let root = base
            .appendingPathComponent("looloomi", isDirectory: true)
            .appendingPathComponent("loopops", isDirectory: true)
        return LoopOpsLocalStore(rootURL: root, strictJSONStore: LoopOpsLocalJSONStore())
    }

    init(
        rootURL: URL,
        fileManager: FileManager = .default,
        seedTemplates: Bool = true,
        strictJSONStore: LoopOpsLocalJSONStore? = nil
    ) {
        self.rootURL = rootURL
        self.fileManager = fileManager
        self.strictJSONStore = strictJSONStore
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.encoder = encoder
        self.decoder = decoder
        self.loopContracts = []
        self.chatThreads = []
        self.reviewPackets = []
        self.runLedgers = []
        self.shareSafeLogs = []
        self.skillStacks = []
        self.knowledgeSources = []
        self.toolDrafts = []
        self.toolLogs = []
        self.builderPackets = []
        self.toasts = []
        load(seedTemplates: seedTemplates)
    }

    var starterContracts: [LoopContract] {
        WorkbenchLoopTemplate.all.map { LoopContract.from(template: $0) }
    }

    var allContractsForDisplay: [LoopContract] {
        let savedIDs = Set(loopContracts.map(\.id))
        return loopContracts + starterContracts.filter { !savedIDs.contains($0.id) }
    }

    func installedWorkspaceCopyID(forTemplateID templateID: String) -> String? {
        loopContracts.first { $0.installedFromTemplateID == templateID }?.workspaceCopyID
            ?? loopContracts.first { $0.installedFromTemplateID == templateID }?.id
    }

    func installedWorkspaceCopy(forTemplateID templateID: String) -> LoopContract? {
        loopContracts.first { $0.installedFromTemplateID == templateID }
    }

    func actionContract(for listing: LoopOpsTemplateListing) -> LoopContract {
        guard listing.source == .starter,
              let workspaceCopy = installedWorkspaceCopy(forTemplateID: listing.contract.id) else {
            return listing.contract
        }
        return workspaceCopy
    }

    var installedWorkspaceCopyIDsByTemplateID: [String: String] {
        var values: [String: String] = [:]
        for contract in loopContracts {
            guard let templateID = contract.installedFromTemplateID else { continue }
            values[templateID] = contract.workspaceCopyID ?? contract.id
        }
        return values
    }

    var starterSkillStacks: [LoopOpsSkillStack] {
        [
            LoopOpsSkillStack(
                id: "skill-stack-crypto-market",
                name: "Crypto Market OS",
                summary: "CMC market scan, regime review, and read-only market package.",
                bindings: LoopOpsSkillBinding.from(
                    skillIDs: ["cmc-market-radar", "market-regime-review"],
                    extensionIDs: ["cmc-skill-hub"],
                    source: "starter-stack"
                )
            ),
            LoopOpsSkillStack(
                id: "skill-stack-markets-research",
                name: "Markets Research OS",
                summary: "Company, earnings, thesis, and markets research package.",
                bindings: LoopOpsSkillBinding.from(
                    skillIDs: ["equity-company-deep-dive", "equity-thesis-tracker", "equity-earnings-review"],
                    extensionIDs: ["markets-research"],
                    source: "starter-stack"
                )
            ),
            LoopOpsSkillStack(
                id: "skill-stack-office-draft",
                name: "Office Draft OS",
                summary: "Meeting transcription, minutes, document draft, and delivery preview.",
                bindings: LoopOpsSkillBinding.from(
                    skillIDs: ["meeting-cloud-asr", "meeting-minutes", "document-generation"],
                    extensionIDs: ["office-meeting-agent"],
                    source: "starter-stack"
                )
            )
        ]
    }

    var allSkillStacksForDisplay: [LoopOpsSkillStack] {
        let savedIDs = Set(skillStacks.map(\.id))
        return skillStacks + starterSkillStacks.filter { !savedIDs.contains($0.id) }
    }

    nonisolated static func strictLoopContractSnapshots(from contracts: [LoopContract]) -> [LoopOpsLoopContract] {
        contracts.map { $0.strictLoopOpsContract(status: .saved) }
    }

    func strictLoopContractSnapshots(includeStarterContracts: Bool = false) -> [LoopOpsLoopContract] {
        let contracts = includeStarterContracts ? allContractsForDisplay : loopContracts
        return Self.strictLoopContractSnapshots(from: contracts)
    }

    func upsert(_ contract: LoopContract) {
        if let index = loopContracts.firstIndex(where: { $0.id == contract.id }) {
            loopContracts[index] = contract
        } else {
            loopContracts.append(contract)
        }
        loopContracts.sort { $0.updatedAt > $1.updatedAt }
        saveLoopContracts()
    }

    func deleteContract(id: String) {
        loopContracts.removeAll { $0.id == id }
        saveLoopContracts()
    }

    func clone(_ contract: LoopContract) -> LoopContract {
        var copy = contract
        copy.id = "loop-\(UUID().uuidString)"
        copy.name = "\(contract.name) Copy"
        copy.version = 1
        copy.installedFromTemplateID = contract.installedFromTemplateID ?? contract.id
        copy.workspaceCopyID = copy.id
        copy.createdAt = Date()
        copy.updatedAt = copy.createdAt
        loopContracts.insert(copy, at: 0)
        saveLoopContracts()
        return copy
    }

    func installTemplate(_ template: LoopContract, copyID: String? = nil, now: Date = Date()) -> LoopContract {
        if let existing = loopContracts.first(where: { $0.installedFromTemplateID == template.id }) {
            return existing
        }

        var copy = template
        copy.id = copyID ?? "workspace-\(template.id)-\(UUID().uuidString)"
        copy.name = "\(template.name) Workspace Copy"
        copy.version = 1
        copy.owner = "local-user"
        copy.visibility = "private"
        copy.installedFromTemplateID = template.id
        copy.workspaceCopyID = copy.id
        copy.createdAt = now
        copy.updatedAt = now
        loopContracts.insert(copy, at: 0)
        saveLoopContracts()
        return copy
    }

    func upsertSkillStack(_ stack: LoopOpsSkillStack) {
        var copy = stack
        copy.bindings = LoopOpsSkillBinding.ordered(copy.bindings)
        copy.updatedAt = Date()
        if let index = skillStacks.firstIndex(where: { $0.id == copy.id }) {
            skillStacks[index] = copy
        } else {
            skillStacks.append(copy)
        }
        skillStacks.sort { $0.updatedAt > $1.updatedAt }
        saveSkillStacks()
    }

    func deleteSkillStack(id: String) {
        skillStacks.removeAll { $0.id == id }
        saveSkillStacks()
    }

    func upsertKnowledgeSource(_ source: LoopOpsKnowledgeSource) {
        var copy = source
        copy.updatedAt = Date()
        if let index = knowledgeSources.firstIndex(where: { $0.id == copy.id }) {
            knowledgeSources[index] = copy
        } else {
            knowledgeSources.insert(copy, at: 0)
        }
        knowledgeSources.sort { $0.updatedAt > $1.updatedAt }
        saveKnowledgeSources()
    }

    func readyKnowledgeSources(ids: [String]) -> [LoopOpsKnowledgeSource] {
        guard !ids.isEmpty else { return [] }
        let sourceByID = Dictionary(uniqueKeysWithValues: knowledgeSources.map { ($0.id, $0) })
        return ids.compactMap { sourceByID[$0] }.filter(\.canAttachToRun)
    }

    func readyKnowledgeSources(for contract: LoopContract) -> [LoopOpsKnowledgeSource] {
        readyKnowledgeSources(ids: contract.knowledgeSourceIDs)
    }

    func contextReferences(forKnowledgeSourceIDs ids: [String], runID: String? = nil) -> [RuntimeObjectReference] {
        readyKnowledgeSources(ids: ids).map { $0.runtimeContextReference(runID: runID) }
    }

    func contextReferences(forRunID runID: String) -> [RuntimeObjectReference] {
        if let ledger = runLedger(runID: runID),
           let sourceIDs = ledger.knowledgeSourceIDs,
           !sourceIDs.isEmpty {
            return contextReferences(forKnowledgeSourceIDs: sourceIDs, runID: runID)
        }
        return knowledgeSources
            .filter { $0.canAttachToRun && $0.isLinked(toRunID: runID) }
            .map { $0.runtimeContextReference(runID: runID) }
    }

    @discardableResult
    func createKnowledgeSource(kind: LoopOpsKnowledgeSourceKind) -> LoopOpsKnowledgeSource {
        let now = Date()
        let status = defaultKnowledgeStatus(for: kind)
        let source = LoopOpsKnowledgeSource(
            title: "\(kind.title) source",
            kind: kind,
            summary: defaultKnowledgeSummary(for: kind),
            status: status,
            reuseMode: kind == .blank ? .manual : .referenceOnly,
            activity: [defaultKnowledgeActivity(for: kind, status: status, now: now)],
            sourceLabel: defaultKnowledgeSourceLabel(for: kind),
            documentCount: 0,
            importProgress: defaultKnowledgeProgress(for: status),
            retryCount: 0,
            createdAt: now,
            updatedAt: now
        )
        upsertKnowledgeSource(source)
        showToast(
            title: "Knowledge source created",
            detail: "\(kind.title) 已加入 Knowledge · \(status.title)。",
            tone: .success
        )
        return source
    }

    @discardableResult
    func materializeKnowledgeSource(
        id: String,
        title: String,
        kind: LoopOpsKnowledgeSourceKind,
        summary: String,
        sourceLabel: String,
        linkedRunIDs: [String]? = nil,
        bodyMarkdown: String? = nil,
        tags: [String]? = nil,
        sourceURL: String? = nil,
        relatedReviewPacketIDs: [String]? = nil,
        relatedChatThreadIDs: [String]? = nil,
        relatedToolLogIDs: [String]? = nil
    ) -> LoopOpsKnowledgeSource {
        if let existing = knowledgeSources.first(where: { $0.id == id }) {
            return existing
        }
        let now = Date()
        let source = LoopOpsKnowledgeSource(
            id: id,
            title: title,
            kind: kind,
            summary: summary,
            status: .ready,
            reuseMode: .attachToLoop,
            linkedRunID: linkedRunIDs?.last,
            linkedRunIDs: linkedRunIDs,
            sourceLabel: sourceLabel,
            bodyMarkdown: bodyMarkdown,
            tags: tags,
            sourceURL: sourceURL,
            documentCount: bodyMarkdown?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? 1 : 0,
            importProgress: 1,
            retryCount: 0,
            lastSyncedAt: now,
            relatedReviewPacketIDs: relatedReviewPacketIDs,
            relatedChatThreadIDs: relatedChatThreadIDs,
            relatedToolLogIDs: relatedToolLogIDs,
            createdAt: now,
            updatedAt: now
        )
        upsertKnowledgeSource(source)
        return source
    }

    @discardableResult
    func saveChatAttachmentAsKnowledge(
        kind rawKind: String,
        title rawTitle: String,
        status rawStatus: String,
        scope: ChatScope,
        scopeID: String
    ) -> LoopOpsKnowledgeSource {
        let now = Date()
        let kind = knowledgeKind(forChatAttachmentKind: rawKind)
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "\(kind.title) from \(scope.title)"
            : rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let statusText = rawStatus.trimmingCharacters(in: .whitespacesAndNewlines)
        let needsReview = statusText.localizedCaseInsensitiveContains("needs")
            || statusText.localizedCaseInsensitiveContains("missing")
        let sourceStatus: LoopOpsKnowledgeSourceStatus = needsReview ? .needsReview : .ready
        let threadID = existingThread(scope: scope, scopeID: scopeID)?.id
        let body = [
            "Saved from \(scope.title).",
            statusText.isEmpty ? nil : "Attachment state: \(statusText)."
        ]
            .compactMap { $0 }
            .joined(separator: "\n")
        let source = LoopOpsKnowledgeSource(
            title: title,
            kind: kind,
            summary: "\(kind.title) attachment saved from \(scope.title).",
            status: sourceStatus,
            reuseMode: needsReview ? .referenceOnly : .attachToLoop,
            activity: ["Saved from \(scope.title) · \(AgentDateFormatting.isoString(now))"],
            sourceLabel: "\(scope.title) attachment",
            bodyMarkdown: body,
            tags: [kind.title, scope.title],
            documentCount: needsReview ? 0 : 1,
            importProgress: needsReview ? 0.2 : 1,
            retryCount: 0,
            lastSyncedAt: needsReview ? nil : now,
            relatedChatThreadIDs: threadID.map { [$0] },
            createdAt: now,
            updatedAt: now
        )
        upsertKnowledgeSource(source)
        showToast(
            title: "Saved to Knowledge",
            detail: needsReview ? "\(source.title) needs review before attach." : "\(source.title) can now be attached.",
            tone: needsReview ? .warning : .success
        )
        return source
    }

    @discardableResult
    func attachKnowledgeSource(
        id sourceID: String,
        toRunID runID: String,
        runTitle: String,
        showFeedback: Bool = true
    ) -> Bool {
        guard let index = knowledgeSources.firstIndex(where: { $0.id == sourceID }) else {
            return false
        }
        var source = knowledgeSources[index]
        guard source.canAttachToRun else {
            var activity = source.activity ?? []
            activity.append("Attach blocked; source is \(source.status.title) · \(AgentDateFormatting.isoString(Date()))")
            source.activity = Array(activity.suffix(10))
            source.updatedAt = Date()
            knowledgeSources[index] = source
            knowledgeSources.sort { $0.updatedAt > $1.updatedAt }
            saveKnowledgeSources()
            if showFeedback {
                showToast(
                    title: "Knowledge not ready",
                    detail: "\(source.title) needs review before it can be attached.",
                    tone: .warning
                )
            }
            return false
        }
        source.linkedRunID = runID
        var linkedRunIDs = source.linkedRunIDs ?? []
        if !linkedRunIDs.contains(runID) {
            linkedRunIDs.append(runID)
        }
        source.linkedRunIDs = linkedRunIDs
        var activity = source.activity ?? []
        activity.append("Attached to \(runTitle) · \(AgentDateFormatting.isoString(Date()))")
        source.activity = Array(activity.suffix(10))
        source.reuseMode = .attachToLoop
        source.updatedAt = Date()
        knowledgeSources[index] = source
        knowledgeSources.sort { $0.updatedAt > $1.updatedAt }
        saveKnowledgeSources()
        if let ledger = runLedger(runID: runID) {
            captureRunLedger(
                ledger.attachingKnowledgeSource(
                    id: sourceID,
                    title: source.title,
                    occurredAt: AgentDateFormatting.isoString(Date())
                )
            )
        }
        appendMessage(
            scope: .run,
            scopeID: runID,
            title: runTitle,
            role: .assistant,
            text: "Knowledge attached: \(source.title). It can inform follow-up review for this run."
        )
        if showFeedback {
            showToast(
                title: "Knowledge attached",
                detail: "\(source.title) 已加入 Run Chat。",
                tone: .success
            )
        }
        return true
    }

    @discardableResult
    func detachKnowledgeSource(id sourceID: String, fromRunID runID: String, runTitle: String) -> Bool {
        guard let index = knowledgeSources.firstIndex(where: { $0.id == sourceID }) else {
            return false
        }
        var source = knowledgeSources[index]
        let wasLinked = source.isLinked(toRunID: runID)
        var linkedRunIDs = source.linkedRunIDs ?? []
        linkedRunIDs.removeAll { $0 == runID }
        if source.linkedRunID == runID {
            source.linkedRunID = linkedRunIDs.last
        }
        source.linkedRunIDs = linkedRunIDs
        guard wasLinked || runLedger(runID: runID)?.knowledgeSourceIDs?.contains(sourceID) == true else {
            return false
        }
        let now = AgentDateFormatting.isoString(Date())
        var activity = source.activity ?? []
        activity.append("Detached from \(runTitle) · \(now)")
        source.activity = Array(activity.suffix(10))
        source.updatedAt = Date()
        knowledgeSources[index] = source
        knowledgeSources.sort { $0.updatedAt > $1.updatedAt }
        saveKnowledgeSources()
        if let ledger = runLedger(runID: runID) {
            captureRunLedger(
                ledger.detachingKnowledgeSource(
                    id: sourceID,
                    title: source.title,
                    occurredAt: now
                )
            )
        }
        appendMessage(
            scope: .run,
            scopeID: runID,
            title: runTitle,
            role: .assistant,
            text: "Knowledge detached: \(source.title). It will no longer be used for this run unless restored."
        )
        showToast(
            title: "Knowledge detached",
            detail: "\(source.title) removed from \(runTitle).",
            tone: .warning,
            action: LoopOpsToast.Action(
                title: "Undo",
                kind: .undoKnowledgeDetach(sourceID: sourceID, runID: runID)
            )
        )
        return true
    }

    @discardableResult
    func restoreKnowledgeAttachment(sourceID: String, runID: String) -> Bool {
        let runTitle = runLedger(runID: runID)?.title ?? "selected run"
        guard attachKnowledgeSource(id: sourceID, toRunID: runID, runTitle: runTitle, showFeedback: false) else {
            return false
        }
        if let source = knowledgeSources.first(where: { $0.id == sourceID }) {
            showToast(
                title: "Knowledge restored",
                detail: "\(source.title) is attached to \(runTitle) again.",
                tone: .success
            )
        }
        return true
    }

    @discardableResult
    func startKnowledgeSourceSetup(id sourceID: String) -> LoopOpsKnowledgeSource? {
        guard let index = knowledgeSources.firstIndex(where: { $0.id == sourceID }) else {
            return nil
        }
        var source = knowledgeSources[index]
        let now = Date()
        source.status = .syncing
        source.importProgress = max(source.normalizedImportProgress, 0.35)
        source.errorSummary = nil
        source.retryCount = (source.retryCount ?? 0) + 1
        var activity = source.activity ?? []
        activity.append("Setup sync started · \(AgentDateFormatting.isoString(now))")
        source.activity = Array(activity.suffix(10))
        source.updatedAt = now
        knowledgeSources[index] = source
        knowledgeSources.sort { $0.updatedAt > $1.updatedAt }
        saveKnowledgeSources()
        showToast(
            title: "Knowledge syncing",
            detail: "\(source.title) is being prepared for review.",
            tone: .info
        )
        return source
    }

    @discardableResult
    func completeKnowledgeSourceSetup(id sourceID: String) -> LoopOpsKnowledgeSource? {
        guard let index = knowledgeSources.firstIndex(where: { $0.id == sourceID }) else {
            return nil
        }
        var source = knowledgeSources[index]
        let now = Date()
        source.status = .ready
        source.reuseMode = .attachToLoop
        source.importProgress = 1
        source.errorSummary = nil
        source.documentCount = max(source.visibleDocumentCount, 1)
        source.lastSyncedAt = now
        var activity = source.activity ?? []
        activity.append("Marked ready · \(AgentDateFormatting.isoString(now))")
        source.activity = Array(activity.suffix(10))
        source.updatedAt = now
        knowledgeSources[index] = source
        knowledgeSources.sort { $0.updatedAt > $1.updatedAt }
        saveKnowledgeSources()
        showToast(
            title: "Knowledge ready",
            detail: "\(source.title) can now be attached to loops and runs.",
            tone: .success
        )
        return source
    }

    @discardableResult
    func failKnowledgeSourceSetup(id sourceID: String, errorSummary: String) -> LoopOpsKnowledgeSource? {
        guard let index = knowledgeSources.firstIndex(where: { $0.id == sourceID }) else {
            return nil
        }
        var source = knowledgeSources[index]
        let now = Date()
        source.status = .failed
        source.importProgress = source.normalizedImportProgress
        source.errorSummary = errorSummary
        var activity = source.activity ?? []
        activity.append("Setup failed · \(errorSummary) · \(AgentDateFormatting.isoString(now))")
        source.activity = Array(activity.suffix(10))
        source.updatedAt = now
        knowledgeSources[index] = source
        knowledgeSources.sort { $0.updatedAt > $1.updatedAt }
        saveKnowledgeSources()
        showToast(
            title: "Knowledge failed",
            detail: errorSummary,
            tone: .warning
        )
        return source
    }

    func upsertToolDraft(_ draft: LoopOpsToolDraft) {
        var copy = draft
        copy.skillBindings = LoopOpsSkillBinding.ordered(copy.skillBindings)
        copy.updatedAt = Date()
        if let index = toolDrafts.firstIndex(where: { $0.id == copy.id }) {
            toolDrafts[index] = copy
        } else {
            toolDrafts.insert(copy, at: 0)
        }
        toolDrafts.sort { $0.updatedAt > $1.updatedAt }
        saveToolDrafts()
    }

    @discardableResult
    func setToolDraftEnabled(id: String, enabled: Bool) -> LoopOpsToolDraft? {
        guard let index = toolDrafts.firstIndex(where: { $0.id == id }) else {
            return nil
        }
        var copy = toolDrafts[index]
        copy.enabled = enabled
        copy.updatedAt = Date()
        toolDrafts[index] = copy
        toolDrafts.sort { $0.updatedAt > $1.updatedAt }
        saveToolDrafts()
        return copy
    }

    @discardableResult
    func updateToolDraftBuild(
        id: String,
        integrationSource: String? = nil,
        inputScope: String? = nil,
        inputs: [String]? = nil,
        visibleSteps: [String],
        outputShape: String,
        reviewPolicy: String? = nil,
        now: Date = Date()
    ) -> LoopOpsToolDraft? {
        guard let index = toolDrafts.firstIndex(where: { $0.id == id }) else {
            return nil
        }
        let cleanIntegration = integrationSource?.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanInputScope = inputScope?.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanInputs = inputs?
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let cleanSteps = visibleSteps
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let cleanOutput = outputShape.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanReviewPolicy = reviewPolicy?.trimmingCharacters(in: .whitespacesAndNewlines)
        var copy = toolDrafts[index]
        if let cleanIntegration, !cleanIntegration.isEmpty {
            copy.integrationSource = cleanIntegration
        }
        if let cleanInputScope, !cleanInputScope.isEmpty {
            copy.inputScope = cleanInputScope
        }
        if let cleanInputs, !cleanInputs.isEmpty {
            copy.inputs = cleanInputs
        }
        copy.visibleSteps = cleanSteps.isEmpty ? copy.visibleSteps : cleanSteps
        copy.outputShape = cleanOutput.isEmpty ? copy.outputShape : cleanOutput
        if let cleanReviewPolicy, !cleanReviewPolicy.isEmpty {
            copy.reviewPolicy = cleanReviewPolicy
        }
        copy.updatedAt = now
        toolDrafts[index] = copy
        toolDrafts.sort { $0.updatedAt > $1.updatedAt }
        saveToolDrafts()
        appendToolLog(
            LoopOpsToolLog(
                toolID: copy.id,
                title: "Draft updated",
                status: "Draft updated",
                summary: "Tool source, inputs, review rule and expected output were saved.",
                inputSummary: "\(copy.inputs.count) inputs · \(copy.visibleSteps.count) visible steps",
                outputSummary: "\(copy.outputSummary) · \(copy.reviewPolicy)",
                durationLabel: "instant",
                reviewState: "Ready for review",
                source: "Skill OS",
                userLabel: "You",
                costLabel: "0 credits",
                createdAt: now
            )
        )
        return copy
    }

    func deleteToolDraft(id: String) {
        toolDrafts.removeAll { $0.id == id }
        loopContracts = loopContracts.map { contract in
            let filteredBindings = contract.skillBindings.filter { $0.id != id }
            guard filteredBindings.count != contract.skillBindings.count else { return contract }
            return contract.replacingSkillBindings(filteredBindings)
        }
        skillStacks = skillStacks.map { stack in
            var copy = stack
            copy.bindings = LoopOpsSkillBinding.ordered(copy.bindings.filter { $0.id != id })
            copy.updatedAt = Date()
            return copy
        }
        saveToolDrafts()
        saveLoopContracts()
        saveSkillStacks()
    }

    func appendToolLog(_ log: LoopOpsToolLog) {
        toolLogs.insert(log, at: 0)
        toolLogs = Array(toolLogs.prefix(80))
        saveToolLogs()
    }

    @discardableResult
    func updateToolLogRunLink(logID: String, runID: String?) -> LoopOpsToolLog? {
        guard let index = toolLogs.firstIndex(where: { $0.id == logID }) else {
            return nil
        }
        toolLogs[index].runID = runID
        saveToolLogs()
        return toolLogs[index]
    }

    @discardableResult
    func acknowledgeToolLogRun(logID: String, runID: String, runTitle: String) -> LoopOpsToolLog? {
        guard let index = toolLogs.firstIndex(where: { $0.id == logID }) else {
            return nil
        }
        toolLogs[index].status = "Run scoped"
        toolLogs[index].summary = "Background run acknowledged for \(runTitle). Review the final answer in Run Result."
        toolLogs[index].outputSummary = "Waiting for final answer in Run Result."
        toolLogs[index].errorSummary = nil
        toolLogs[index].durationLabel = "running"
        toolLogs[index].reviewState = "Waiting for final answer"
        toolLogs[index].runID = runID
        toolLogs[index].userLabel = "Run"
        toolLogs[index].costLabel = "Pending"
        saveToolLogs()
        return toolLogs[index]
    }

    @discardableResult
    func failToolLogRun(logID: String, errorMessage: String) -> LoopOpsToolLog? {
        guard let index = toolLogs.firstIndex(where: { $0.id == logID }) else {
            return nil
        }
        toolLogs[index].status = "Failed"
        toolLogs[index].summary = "Tool run did not reach the background queue."
        toolLogs[index].errorSummary = errorMessage
        toolLogs[index].durationLabel = "stopped"
        toolLogs[index].reviewState = "Needs review"
        toolLogs[index].costLabel = "0 credits"
        saveToolLogs()
        return toolLogs[index]
    }

    @discardableResult
    func runLocalToolDraft(
        id: String,
        inputValues: [String: String],
        runID: String? = nil,
        now: Date = Date(),
        duration: TimeInterval = 0.2
    ) -> LoopOpsToolLog? {
        guard let draft = toolDrafts.first(where: { $0.id == id }) else {
            return nil
        }
        let missingInputs = draft.missingInputNames(from: inputValues)
        let inputSummary = draft.inputSummary(from: inputValues)
        let log: LoopOpsToolLog
        if missingInputs.isEmpty {
            log = LoopOpsToolLog(
                toolID: draft.id,
                title: "\(draft.name) submitted",
                status: "Submitting",
                summary: "Inputs passed local validation. Waiting for background run confirmation.",
                inputSummary: inputSummary,
                outputSummary: "Waiting for run confirmation.",
                durationLabel: duration <= 0 ? "submitting" : formattedToolDuration(duration),
                reviewState: "Waiting for run confirmation",
                runID: runID,
                source: "Skill OS",
                userLabel: "You",
                costLabel: nil,
                createdAt: now
            )
        } else {
            let error = "Missing required inputs: \(missingInputs.joined(separator: ", "))"
            log = LoopOpsToolLog(
                toolID: draft.id,
                title: "\(draft.name) run failed",
                status: "Failed",
                summary: "Tool run stopped before output.",
                inputSummary: inputSummary,
                errorSummary: error,
                durationLabel: "0s",
                reviewState: "Needs input",
                runID: runID,
                source: "Skill OS",
                userLabel: "You",
                costLabel: "0 credits",
                createdAt: now
            )
        }
        appendToolLog(log)
        return log
    }

    func logs(forToolID id: String) -> [LoopOpsToolLog] {
        toolLogs.filter { $0.toolID == id }
    }

    func logs(forRunID runID: String) -> [LoopOpsToolLog] {
        toolLogs.filter { $0.runID == runID }
    }

    func builderPackets(forContractID contractID: String) -> [LoopOpsBuilderPacket] {
        builderPackets
            .filter { $0.contractID == contractID }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    func upsertBuilderPacket(_ packet: LoopOpsBuilderPacket) {
        var copy = packet
        copy.updatedAt = Date()
        if let index = builderPackets.firstIndex(where: { $0.id == copy.id }) {
            builderPackets[index] = copy
        } else {
            builderPackets.insert(copy, at: 0)
        }
        builderPackets.sort { $0.updatedAt > $1.updatedAt }
        saveBuilderPackets()
    }

    func updateBuilderPacket(id: String, status: LoopOpsBuilderPacketStatus) -> LoopOpsBuilderPacket? {
        guard let index = builderPackets.firstIndex(where: { $0.id == id }) else { return nil }
        let updated = builderPackets[index].updating(status: status)
        builderPackets[index] = updated
        builderPackets.sort { $0.updatedAt > $1.updatedAt }
        saveBuilderPackets()
        return updated
    }

    func reassignBuilderPackets(from oldContractID: String, to newContractID: String) {
        guard oldContractID != newContractID else { return }
        var didChange = false
        builderPackets = builderPackets.map { packet in
            guard packet.contractID == oldContractID else { return packet }
            var copy = packet
            copy.contractID = newContractID
            copy.updatedAt = Date()
            didChange = true
            return copy
        }
        if didChange {
            builderPackets.sort { $0.updatedAt > $1.updatedAt }
            saveBuilderPackets()
        }
    }

    func reassignBuilderThread(from oldScopeID: String, to newScopeID: String, title: String) {
        guard oldScopeID != newScopeID else { return }
        guard let index = chatThreads.firstIndex(where: { $0.scope == .builder && $0.scopeID == oldScopeID }) else { return }
        var thread = chatThreads[index]
        thread.id = "\(ChatScope.builder.rawValue)-\(newScopeID)"
        thread.scopeID = newScopeID
        thread.title = title
        thread.updatedAt = Date()
        chatThreads.remove(at: index)
        if let existingIndex = chatThreads.firstIndex(where: { $0.scope == .builder && $0.scopeID == newScopeID }) {
            var existing = chatThreads[existingIndex]
            existing.messages.append(contentsOf: thread.messages)
            existing.updatedAt = Date()
            chatThreads[existingIndex] = existing
        } else {
            chatThreads.insert(thread, at: 0)
        }
        chatThreads.sort { $0.updatedAt > $1.updatedAt }
        saveChatThreads()
    }

    func showToast(
        title: String,
        detail: String,
        tone: LoopOpsToast.Tone = .info,
        action: LoopOpsToast.Action? = nil
    ) {
        toasts.insert(LoopOpsToast(title: title, detail: detail, tone: tone, action: action), at: 0)
        toasts = Array(toasts.prefix(4))
    }

    func dismissToast(id: String) {
        toasts.removeAll { $0.id == id }
    }

    func performToastAction(_ action: LoopOpsToast.Action, toastID: String) {
        switch action.kind {
        case let .undoKnowledgeDetach(sourceID, runID):
            _ = restoreKnowledgeAttachment(sourceID: sourceID, runID: runID)
        }
        dismissToast(id: toastID)
    }

    func thread(scope: ChatScope, scopeID: String, title: String? = nil) -> ChatThread {
        if let existing = chatThreads.first(where: { $0.scope == scope && $0.scopeID == scopeID }) {
            return existing
        }
        let now = Date()
        let thread = ChatThread(
            id: "\(scope.rawValue)-\(scopeID)",
            scope: scope,
            scopeID: scopeID,
            title: title ?? scope.title,
            generatedLoopDraftID: nil,
            followUpRunIDs: [],
            memoryCandidates: [],
            messages: [],
            updatedAt: now
        )
        chatThreads.insert(thread, at: 0)
        saveChatThreads()
        return thread
    }

    func existingThread(scope: ChatScope, scopeID: String) -> ChatThread? {
        chatThreads.first { $0.scope == scope && $0.scopeID == scopeID }
    }

    func appendMessage(
        scope: ChatScope,
        scopeID: String,
        title: String? = nil,
        role: ChatMessage.Role,
        text: String,
        attachments: [LoopOpsChatAttachment] = [],
        controlMetadata: LoopOpsChatControlMetadata? = nil
    ) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var thread = thread(scope: scope, scopeID: scopeID, title: title)
        thread.messages.append(ChatMessage(
            id: UUID().uuidString,
            role: role,
            text: trimmed,
            createdAt: Date(),
            attachments: attachments,
            controlMetadata: controlMetadata
        ))
        thread.updatedAt = Date()
        if let index = chatThreads.firstIndex(where: { $0.id == thread.id }) {
            chatThreads[index] = thread
        } else {
            chatThreads.insert(thread, at: 0)
        }
        chatThreads.sort { $0.updatedAt > $1.updatedAt }
        saveChatThreads()
    }

    func recordFollowUpRun(parentRunID: String, childRunID: String, title: String? = nil) {
        guard !parentRunID.isEmpty, !childRunID.isEmpty else { return }
        var thread = thread(scope: .run, scopeID: parentRunID, title: title)
        if !thread.followUpRunIDs.contains(childRunID) {
            thread.followUpRunIDs.append(childRunID)
        }
        thread.updatedAt = Date()
        if let index = chatThreads.firstIndex(where: { $0.id == thread.id }) {
            chatThreads[index] = thread
        } else {
            chatThreads.insert(thread, at: 0)
        }
        chatThreads.sort { $0.updatedAt > $1.updatedAt }
        saveChatThreads()
    }

    func upsertReviewPacket(_ packet: ReviewPacketViewModel) {
        if let index = reviewPackets.firstIndex(where: { $0.id == packet.id }) {
            reviewPackets[index] = packet
        } else {
            reviewPackets.append(packet)
        }
        if let index = runLedgers.firstIndex(where: { $0.runID == packet.runID }) {
            let updatedLedger = normalize(runLedgers[index].applyingReviewPacket(packet))
            runLedgers[index] = updatedLedger
            runLedgers.sort { ledgerSortKey($0) > ledgerSortKey($1) }
            upsertShareSafeLogInMemory(ShareSafeLogPreview.from(ledger: updatedLedger))
            saveReviewRunState()
        } else {
            saveReviewPackets()
        }
    }

    func reviewPacket(runID: String) -> ReviewPacketViewModel? {
        reviewPackets.first { $0.runID == runID }
    }

    func upsertRunLedger(_ ledger: RunLedgerRow) {
        let normalized = normalize(ledger)
        upsertRunLedgerInMemory(normalized)
        runLedgers.sort { ledgerSortKey($0) > ledgerSortKey($1) }
        saveRunLedgers()
    }

    func runLedger(runID: String) -> RunLedgerRow? {
        runLedgers.first { $0.runID == runID }
    }

    func runResultState(runID: String) -> LoopOpsRunResultState? {
        guard let ledger = runLedger(runID: runID) else {
            return nil
        }
        let ledgerKnowledgeIDs = Set(ledger.knowledgeSourceIDs ?? [])
        let linkedKnowledgeSources = knowledgeSources.filter { source in
            source.isLinked(toRunID: runID) || ledgerKnowledgeIDs.contains(source.id)
        }
        return LoopOpsRunResultState.from(
            ledger: ledger,
            reviewPacket: reviewPacket(runID: runID),
            shareSafeLog: shareSafeLog(runID: runID),
            runChatThread: existingThread(scope: .run, scopeID: runID),
            toolLogs: logs(forRunID: runID),
            knowledgeSources: linkedKnowledgeSources
        )
    }

    func runResultStates() -> [LoopOpsRunResultState] {
        runLedgers.compactMap { runResultState(runID: $0.runID) }
    }

    @discardableResult
    func applyRunLifecycleAction(
        runID: String,
        action: LoopOpsRunLifecycleAction,
        note: String? = nil
    ) -> RunLedgerRow? {
        guard let ledger = runLedger(runID: runID) else { return nil }
        let occurredAt = AgentDateFormatting.isoString(Date())
        var updated = ledger.applyingLifecycleAction(action, occurredAt: occurredAt)
        if let note = note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
            var events = updated.lifecycleEvents ?? []
            events.append(note)
            updated.lifecycleEvents = Array(events.suffix(12))
        }
        captureRunLedger(updated)
        appendMessage(
            scope: .run,
            scopeID: runID,
            title: updated.title,
            role: .assistant,
            text: "\(action.title) applied. Current run status: \(action.resultStatus)."
        )
        return updated
    }

    func upsertShareSafeLog(_ log: ShareSafeLogPreview) {
        upsertShareSafeLogInMemory(log)
        saveShareSafeLogs()
    }

    func shareSafeLog(runID: String) -> ShareSafeLogPreview? {
        shareSafeLogs.first { $0.id == runID }
    }

    func captureRunLedger(_ ledger: RunLedgerRow) {
        let normalized = normalize(ledger)
        upsertRunLedgerInMemory(normalized)
        runLedgers.sort { ledgerSortKey($0) > ledgerSortKey($1) }
        upsertShareSafeLogInMemory(ShareSafeLogPreview.from(ledger: normalized))
        saveRunAndShareState()
    }

    private func load(seedTemplates: Bool) {
        try? fileManager.createDirectory(at: rootURL, withIntermediateDirectories: true)
        loopContracts = load([LoopContract].self, from: loopContractsURL) ?? []
        chatThreads = load([ChatThread].self, from: chatThreadsURL) ?? []
        reviewPackets = load([ReviewPacketViewModel].self, from: reviewPacketsURL) ?? []
        runLedgers = load([RunLedgerRow].self, from: runLedgersURL) ?? []
        shareSafeLogs = load([ShareSafeLogPreview].self, from: shareSafeLogsURL) ?? []
        skillStacks = load([LoopOpsSkillStack].self, from: skillStacksURL) ?? []
        knowledgeSources = load([LoopOpsKnowledgeSource].self, from: knowledgeSourcesURL) ?? []
        toolDrafts = load([LoopOpsToolDraft].self, from: toolDraftsURL) ?? []
        toolLogs = load([LoopOpsToolLog].self, from: toolLogsURL) ?? []
        builderPackets = load([LoopOpsBuilderPacket].self, from: builderPacketsURL) ?? []
        let recoveredFromStrictStore = recoverMissingStateFromStrictStore()
        if seedTemplates && skillStacks.isEmpty {
            skillStacks = starterSkillStacks
            saveSkillStacks()
        }
        if recoveredFromStrictStore {
            saveRecoveredLightState()
        }
    }

    @discardableResult
    private func recoverMissingStateFromStrictStore() -> Bool {
        guard let strictJSONStore else { return false }
        let snapshot = strictJSONStore.readSnapshot()
        var didRecover = false

        let strictContracts = uniqueStrictContracts(from: snapshot)
        for contract in strictContracts.map(LoopContract.from(strictLoopOpsContract:)) {
            if let index = loopContracts.firstIndex(where: { $0.id == contract.id }) {
                if contract.updatedAt > loopContracts[index].updatedAt {
                    loopContracts[index] = contract
                    didRecover = true
                }
            } else {
                loopContracts.append(contract)
                didRecover = true
            }
        }

        for thread in snapshot.chatThreads.map(lightChatThread(from:)) {
            if let index = chatThreads.firstIndex(where: { $0.scope == thread.scope && $0.scopeID == thread.scopeID }) {
                if thread.updatedAt > chatThreads[index].updatedAt {
                    chatThreads[index] = thread
                    didRecover = true
                }
            } else {
                chatThreads.append(thread)
                didRecover = true
            }
        }

        for packet in snapshot.reviewPackets.map(lightReviewPacket(from:)) {
            if !reviewPackets.contains(where: { $0.id == packet.id }) {
                reviewPackets.append(packet)
                didRecover = true
            }
        }

        for ledger in snapshot.runLedgers.map(lightRunLedger(from:)) {
            if !runLedgers.contains(where: { $0.runID == ledger.runID }) {
                runLedgers.append(ledger)
                didRecover = true
            }
        }

        for log in snapshot.shareSafeLogs.map(lightShareSafeLog(from:)) {
            if !shareSafeLogs.contains(where: { $0.id == log.id }) {
                shareSafeLogs.append(log)
                didRecover = true
            }
        }

        for stack in snapshot.skillStacks {
            if let index = skillStacks.firstIndex(where: { $0.id == stack.id }) {
                if stack.updatedAt > skillStacks[index].updatedAt {
                    skillStacks[index] = stack
                    didRecover = true
                }
            } else {
                skillStacks.append(stack)
                didRecover = true
            }
        }

        for source in snapshot.knowledgeSources {
            if let index = knowledgeSources.firstIndex(where: { $0.id == source.id }) {
                if source.updatedAt > knowledgeSources[index].updatedAt {
                    knowledgeSources[index] = source
                    didRecover = true
                }
            } else {
                knowledgeSources.append(source)
                didRecover = true
            }
        }

        for draft in snapshot.toolDrafts {
            let orderedDraft = LoopOpsToolDraft(
                id: draft.id,
                name: draft.name,
                purpose: draft.purpose,
                enabled: draft.isEnabled,
                integrationSource: draft.integrationSource,
                inputScope: draft.inputScope,
                inputs: draft.inputs,
                visibleSteps: draft.visibleSteps,
                outputShape: draft.outputShape,
                reviewPolicy: draft.reviewPolicy,
                skillBindings: draft.skillBindings,
                createdAt: draft.createdAt,
                updatedAt: draft.updatedAt
            )
            if let index = toolDrafts.firstIndex(where: { $0.id == orderedDraft.id }) {
                if orderedDraft.updatedAt > toolDrafts[index].updatedAt {
                    toolDrafts[index] = orderedDraft
                    didRecover = true
                }
            } else {
                toolDrafts.append(orderedDraft)
                didRecover = true
            }
        }

        for log in snapshot.toolLogs {
            if let index = toolLogs.firstIndex(where: { $0.id == log.id }) {
                if log.createdAt > toolLogs[index].createdAt {
                    toolLogs[index] = log
                    didRecover = true
                }
            } else {
                toolLogs.append(log)
                didRecover = true
            }
        }

        for packet in snapshot.builderPackets {
            if let index = builderPackets.firstIndex(where: { $0.id == packet.id }) {
                if packet.updatedAt > builderPackets[index].updatedAt {
                    builderPackets[index] = packet
                    didRecover = true
                }
            } else {
                builderPackets.append(packet)
                didRecover = true
            }
        }

        loopContracts.sort { $0.updatedAt > $1.updatedAt }
        chatThreads.sort { $0.updatedAt > $1.updatedAt }
        runLedgers.sort { ledgerSortKey($0) > ledgerSortKey($1) }
        skillStacks.sort { $0.updatedAt > $1.updatedAt }
        knowledgeSources.sort { $0.updatedAt > $1.updatedAt }
        toolDrafts.sort { $0.updatedAt > $1.updatedAt }
        toolLogs.sort { $0.createdAt > $1.createdAt }
        builderPackets.sort { $0.updatedAt > $1.updatedAt }
        toolLogs = Array(toolLogs.prefix(80))
        return didRecover
    }

    private func uniqueStrictContracts(from snapshot: LoopOpsLocalStoreSnapshot) -> [LoopOpsLoopContract] {
        var seen: Set<String> = []
        var contracts: [LoopOpsLoopContract] = []
        for contract in snapshot.contracts + snapshot.runLedgers.map(\.loopContractSnapshot) where !seen.contains(contract.id) {
            seen.insert(contract.id)
            contracts.append(contract)
        }
        return contracts
    }

    private func saveRecoveredLightState() {
        saveLoopContracts()
        saveChatThreads()
        saveReviewPackets()
        saveRunLedgers()
        saveShareSafeLogs()
        saveKnowledgeSources()
        saveToolDrafts()
        saveToolLogs()
    }

    private func lightChatThread(from thread: LoopOpsChatThread) -> ChatThread {
        let scope = ChatScope(strictChatScope: thread.scope)
        let updatedAt = AgentDateFormatting.parse(thread.updatedAt) ?? Date()
        return ChatThread(
            id: thread.id,
            scope: scope,
            scopeID: lightScopeID(from: thread, scope: scope),
            title: thread.title,
            generatedLoopDraftID: thread.generatedLoopDraftID,
            followUpRunIDs: thread.followUpRunReferences,
            memoryCandidates: thread.memoryCandidates.map(\.summary),
            messages: thread.messages.map { message in
                ChatMessage(
                    id: message.id,
                    role: ChatMessage.Role(strictRole: message.role),
                    text: message.text,
                    createdAt: AgentDateFormatting.parse(message.createdAt) ?? updatedAt,
                    controlMetadata: message.controlMetadata
                )
            },
            updatedAt: updatedAt
        )
    }

    private func lightScopeID(from thread: LoopOpsChatThread, scope: ChatScope) -> String {
        if scope == .run, let runID = thread.runID { return runID }
        if scope == .review, let reviewPacketID = thread.reviewPacketID { return reviewPacketID }
        if scope == .builder, let loopContractID = thread.loopContractID { return loopContractID }
        if let generatedLoopDraftID = thread.generatedLoopDraftID { return generatedLoopDraftID }
        let prefix = "\(scope.rawValue)-"
        if thread.id.hasPrefix(prefix) {
            return String(thread.id.dropFirst(prefix.count))
        }
        return thread.id
    }

    private func lightReviewPacket(from packet: LoopOpsReviewPacket) -> ReviewPacketViewModel {
        ReviewPacketViewModel(
            id: packet.id,
            runID: packet.runID,
            finalAnswer: packet.finalAnswer,
            domainSummary: packet.domainSummary,
            claims: packet.claims.map(\.text),
            evidenceGaps: packet.evidenceGaps.map(\.detail),
            uncertainty: packet.uncertainty,
            blockedActions: packet.blockedActions.map(\.label),
            nextQuestions: packet.nextQuestions,
            reviewDecision: lightReviewDecision(packet.reviewDecision),
            reviewNotes: packet.reviewNotes,
            eventHistory: packet.eventHistory
        )
    }

    private func lightRunLedger(from ledger: LoopOpsRunLedger) -> RunLedgerRow {
        let contract = ledger.loopContractSnapshot
        let finalAnswer = ledger.finalAnswerPointer?.excerpt?.trimmingCharacters(in: .whitespacesAndNewlines)
        return RunLedgerRow(
            id: ledger.runID,
            loopContractID: contract.id,
            runID: ledger.runID,
            title: contract.name,
            domain: contract.domain.workbenchDomain,
            status: ledger.statusTimeline.last?.status.rawValue ?? LoopOpsRunStatus.queued.rawValue,
            startedAt: ledger.startedAt,
            completedAt: ledger.completedAt,
            inputsUsed: ledger.inputsUsed.isEmpty ? [contract.domain.title, "Workspace context"] : ledger.inputsUsed.map(\.label),
            finalAnswerPreview: finalAnswer?.isEmpty == false ? finalAnswer! : "尚未写入最终答案。",
            evidenceGaps: ledger.evidenceGaps.map(\.detail),
            blockedActions: ledger.blockedActions.map(\.label),
            reviewDecision: ledger.reviewDecision.map(lightReviewDecision) ?? "pending",
            followUpPrompts: ledger.followUpPrompts,
            cloneable: ledger.cloneReplayMetadata.canClone,
            replayable: ledger.cloneReplayMetadata.canReplay
        )
    }

    private func lightShareSafeLog(from log: LoopOpsShareSafeLog) -> ShareSafeLogPreview {
        ShareSafeLogPreview(
            id: lightShareSafeLogID(from: log),
            title: log.redactedLoopSummary.name,
            redactedLoopSummary: "\(log.redactedLoopSummary.domain.title) loop · share-safe",
            redactedTimeline: log.redactedRunTimeline.map(\.title),
            finalAnswerExcerpt: log.finalAnswerExcerpt,
            reviewNotes: log.reviewNotes.isEmpty ? [] : [log.reviewNotes],
            cloneInstructions: log.cloneInstructions,
            omittedSensitiveFieldsSummary: log.omittedSensitiveFieldsSummary.joined(separator: ", ")
        )
    }

    private func lightShareSafeLogID(from log: LoopOpsShareSafeLog) -> String {
        if let sourceRunID = log.sourceRunID { return sourceRunID }
        let prefix = "share-safe-log-"
        if log.id.hasPrefix(prefix) {
            return String(log.id.dropFirst(prefix.count))
        }
        return log.id
    }

    private func lightReviewDecision(_ decision: LoopOpsReviewDecision) -> String {
        let notes = decision.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        return notes.isEmpty ? decision.decision.rawValue : notes
    }

    private func saveLoopContracts() {
        save(loopContracts, to: loopContractsURL)
        synchronizeStrictStore()
    }

    private func saveChatThreads() {
        save(chatThreads, to: chatThreadsURL)
        synchronizeStrictStore()
    }

    private func saveReviewPackets() {
        save(reviewPackets, to: reviewPacketsURL)
        synchronizeStrictStore()
    }

    private func saveRunLedgers() {
        save(runLedgers, to: runLedgersURL)
        synchronizeStrictStore()
    }

    private func saveShareSafeLogs() {
        save(shareSafeLogs, to: shareSafeLogsURL)
        synchronizeStrictStore()
    }

    private func saveSkillStacks() {
        save(skillStacks, to: skillStacksURL)
        synchronizeStrictStore()
    }

    private func saveKnowledgeSources() {
        save(knowledgeSources, to: knowledgeSourcesURL)
        synchronizeStrictStore()
    }

    private func saveToolDrafts() {
        save(toolDrafts, to: toolDraftsURL)
        synchronizeStrictStore()
    }

    private func saveToolLogs() {
        save(toolLogs, to: toolLogsURL)
        synchronizeStrictStore()
    }

    private func saveBuilderPackets() {
        save(builderPackets, to: builderPacketsURL)
        synchronizeStrictStore()
    }

    private func formattedToolDuration(_ duration: TimeInterval) -> String {
        let clamped = max(0, duration)
        if clamped < 1 {
            return String(format: "%.1fs", clamped)
        }
        return String(format: "%.0fs", clamped)
    }

    private func normalize(_ ledger: RunLedgerRow) -> RunLedgerRow {
        var copy = ledger
        if copy.inputsUsed.isEmpty {
            copy.inputsUsed = [copy.domain.title, "Workspace context"]
        }
        return copy
    }

    private func upsertRunLedgerInMemory(_ ledger: RunLedgerRow) {
        if let index = runLedgers.firstIndex(where: { $0.id == ledger.id }) {
            runLedgers[index] = ledger
        } else {
            runLedgers.insert(ledger, at: 0)
        }
    }

    private func upsertShareSafeLogInMemory(_ log: ShareSafeLogPreview) {
        if let index = shareSafeLogs.firstIndex(where: { $0.id == log.id }) {
            shareSafeLogs[index] = log
        } else {
            shareSafeLogs.insert(log, at: 0)
        }
    }

    private func saveRunAndShareState() {
        save(runLedgers, to: runLedgersURL)
        save(shareSafeLogs, to: shareSafeLogsURL)
        synchronizeStrictStore()
    }

    private func saveReviewRunState() {
        save(reviewPackets, to: reviewPacketsURL)
        save(runLedgers, to: runLedgersURL)
        save(shareSafeLogs, to: shareSafeLogsURL)
        synchronizeStrictStore()
    }

    private func ledgerSortKey(_ ledger: RunLedgerRow) -> String {
        ledger.completedAt ?? ledger.startedAt ?? ledger.runID
    }

    private func synchronizeStrictStore() {
        guard let strictJSONStore else { return }
        do {
            _ = try strictJSONStore.writeSnapshot(strictSnapshotFromLightState())
        } catch {
            assertionFailure("Failed to synchronize LoopOps strict store: \(error.localizedDescription)")
        }
    }

    private func strictSnapshotFromLightState() -> LoopOpsLocalStoreSnapshot {
        let strictRunLedgers = runLedgers.compactMap(strictRunLedger(from:))
        let strictReviewPackets = reviewPackets.map(strictReviewPacket(from:))
        let strictShareSafeLogs = shareSafeLogs.compactMap { log -> LoopOpsShareSafeLog? in
            guard let strictLedger = strictRunLedgers.first(where: { $0.runID == log.id }) else {
                return nil
            }
            let strictPacket = strictReviewPackets.first { $0.runID == log.id }
            return LoopOpsShareSafeLog.from(
                runLedger: strictLedger,
                reviewPacket: strictPacket,
                id: "share-safe-log-\(log.id)"
            )
        }

        return LoopOpsLocalStoreSnapshot(
            contracts: Self.strictLoopContractSnapshots(from: loopContracts),
            chatThreads: chatThreads.map(strictChatThread(from:)),
            runLedgers: strictRunLedgers,
            reviewPackets: strictReviewPackets,
            shareSafeLogs: strictShareSafeLogs,
            skillStacks: skillStacks,
            knowledgeSources: knowledgeSources,
            toolDrafts: toolDrafts,
            toolLogs: toolLogs,
            builderPackets: builderPackets
        )
    }

    private func strictChatThread(from thread: ChatThread) -> LoopOpsChatThread {
        let updatedAt = AgentDateFormatting.isoString(thread.updatedAt)
        return LoopOpsChatThread(
            id: thread.id,
            scope: LoopOpsChatScope(chatScope: thread.scope),
            title: thread.title,
            messages: thread.messages.map { message in
                LoopOpsChatMessage(
                    id: message.id,
                    role: LoopOpsChatRole(chatRole: message.role),
                    text: message.text,
                    attachments: message.attachments,
                    controlMetadata: message.controlMetadata,
                    referencedRunID: thread.scope == .run ? thread.scopeID : nil,
                    referencedReviewPacketID: thread.scope == .review ? thread.scopeID : nil,
                    createdAt: AgentDateFormatting.isoString(message.createdAt)
                )
            },
            attachments: Array(thread.messages.flatMap(\.attachments).prefix(20)),
            generatedLoopDraftID: thread.generatedLoopDraftID,
            followUpRunReferences: thread.followUpRunIDs,
            memoryCandidates: thread.memoryCandidates.map { LoopOpsMemoryCandidate(summary: $0, sourceMessageID: nil) },
            runID: thread.scope == .run ? thread.scopeID : nil,
            reviewPacketID: thread.scope == .review ? thread.scopeID : nil,
            createdAt: updatedAt,
            updatedAt: updatedAt
        )
    }

    private func strictReviewPacket(from packet: ReviewPacketViewModel) -> LoopOpsReviewPacket {
        LoopOpsReviewPacket(
            id: packet.id,
            runID: packet.runID,
            loopContractID: runLedger(runID: packet.runID)?.loopContractID,
            finalAnswer: packet.finalAnswer,
            domainSummary: packet.domainSummary,
            claims: packet.claims.map { claim in
                LoopOpsReviewClaim(
                    text: claim,
                    supportLevel: .unreviewed,
                    evidenceReferences: []
                )
            },
            evidenceGaps: packet.evidenceGaps.map { gap in
                LoopOpsEvidenceGap(
                    title: "Evidence gap",
                    detail: gap,
                    severity: .warning
                )
            },
            uncertainty: packet.uncertainty,
            blockedActions: packet.blockedActions.map { action in
                LoopOpsBlockedAction(
                    label: action,
                    reason: "Blocked by LoopOps review boundary."
                )
            },
            nextQuestions: packet.nextQuestions,
            reviewDecision: strictReviewDecision(packet.reviewDecision, notes: packet.reviewNotes),
            reviewNotes: packet.reviewNotes,
            eventHistory: packet.eventHistory
        )
    }

    private func strictRunLedger(from ledger: RunLedgerRow) -> LoopOpsRunLedger? {
        guard let contract = contract(for: ledger) else { return nil }
        let strictContract = contract.strictLoopOpsContract(status: .saved)
        let strictPacket = reviewPacket(runID: ledger.runID).map(strictReviewPacket(from:))
        return LoopOpsRunLedger(
            id: "run-ledger-\(ledger.runID)",
            loopContractSnapshot: strictContract,
            runID: ledger.runID,
            startedAt: ledger.startedAt ?? ledger.completedAt ?? AgentDateFormatting.isoString(Date()),
            completedAt: ledger.completedAt,
            inputsUsed: strictContract.inputBindings,
            statusTimeline: [
                LoopOpsStatusTimelineEvent(
                    id: "timeline-\(ledger.runID)-status",
                    status: strictRunStatus(ledger.status),
                    title: ledger.status,
                    detail: ledger.title,
                    occurredAt: ledger.completedAt ?? ledger.startedAt ?? AgentDateFormatting.isoString(Date())
                )
            ],
            finalAnswerPointer: strictFinalAnswerPointer(from: ledger),
            evidenceGaps: ledger.evidenceGaps.map { gap in
                LoopOpsEvidenceGap(
                    title: "Evidence gap",
                    detail: gap,
                    severity: .warning
                )
            },
            blockedActions: ledger.blockedActions.map { action in
                LoopOpsBlockedAction(
                    label: action,
                    reason: "Blocked by LoopOps review boundary."
                )
            },
            reviewDecision: strictPacket?.reviewDecision ?? strictReviewDecision(ledger.reviewDecision),
            followUpPrompts: ledger.followUpPrompts,
            cloneReplayMetadata: LoopOpsCloneReplayMetadata(
                canClone: ledger.cloneable,
                canReplay: ledger.replayable,
                sourceRunID: ledger.runID
            )
        )
    }

    private func strictFinalAnswerPointer(from ledger: RunLedgerRow) -> LoopOpsFinalAnswerPointer? {
        let trimmed = ledger.finalAnswerPreview.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != "尚未写入最终答案。" else { return nil }
        return LoopOpsFinalAnswerPointer(
            id: "final-answer-\(ledger.runID)",
            title: "Final answer",
            artifactPath: nil,
            excerpt: String(trimmed.prefix(800))
        )
    }

    func contract(for ledger: RunLedgerRow) -> LoopContract? {
        if let id = ledger.loopContractID,
           let found = allContractsForDisplay.first(where: { $0.id == id }) {
            return found
        }
        return allContractsForDisplay.first { $0.name == ledger.title }
    }

    private func strictRunStatus(_ value: String) -> LoopOpsRunStatus {
        let normalized = value.lowercased()
        if normalized.contains("cancel") { return .cancelled }
        if normalized.contains("fail") || normalized.contains("error") { return .failed }
        if normalized.contains("block") { return .blocked }
        if normalized.contains("review") { return .reviewNeeded }
        if normalized.contains("complete") || normalized.contains("done") || normalized.contains("success") { return .completed }
        if normalized.contains("running") || normalized.contains("active") { return .running }
        return .queued
    }

    private func strictReviewDecision(_ value: String, notes explicitNotes: String = "") -> LoopOpsReviewDecision {
        let normalized = value.lowercased()
        let decision: LoopOpsReviewDecisionKind
        if normalized.contains("follow") {
            decision = .needsFollowUp
        } else if normalized.contains("block") {
            decision = .blocked
        } else if normalized.contains("reject") {
            decision = .rejected
        } else if normalized.contains("reviewed") || normalized.contains("approve") {
            decision = .approved
        } else {
            decision = .pending
        }
        let notes = explicitNotes.trimmingCharacters(in: .whitespacesAndNewlines)
        return LoopOpsReviewDecision(
            decision: decision,
            reviewer: "local-user",
            decidedAt: decision == .pending ? nil : AgentDateFormatting.isoString(Date()),
            notes: notes.isEmpty ? value : notes,
            nextAction: decision == .needsFollowUp ? "Ask a run-scoped follow-up." : nil
        )
    }

    private func defaultKnowledgeSummary(for kind: LoopOpsKnowledgeSourceKind) -> String {
        switch kind {
        case .blank:
            return "空白知识页，可写入 loop 背景、判断依据或复核说明。"
        case .upload:
            return "待绑定本地文件；只作为 run context，不自动外发。"
        case .website:
            return "待粘贴网页来源；进入 loop 前需要确认 freshness。"
        case .integration:
            return "待连接外部来源；复用前保持显式 review。"
        case .run:
            return "来自一次 loop run 的可复用上下文。"
        case .review:
            return "来自 review packet 的结论、缺口与下一步问题。"
        case .chat:
            return "来自 scoped chat 的追问和记忆候选。"
        case .log:
            return "来自 Skill OS history 的输入、输出和复核状态。"
        }
    }

    private func defaultKnowledgeStatus(for kind: LoopOpsKnowledgeSourceKind) -> LoopOpsKnowledgeSourceStatus {
        switch kind {
        case .blank:
            return .draft
        case .integration:
            return .syncing
        case .upload, .website:
            return .needsReview
        case .run, .review, .chat, .log:
            return .ready
        }
    }

    private func defaultKnowledgeProgress(for status: LoopOpsKnowledgeSourceStatus) -> Double {
        switch status {
        case .draft:
            return 0
        case .needsReview:
            return 0.1
        case .syncing:
            return 0.35
        case .ready:
            return 1
        case .stale:
            return 0.5
        case .failed:
            return 0
        }
    }

    private func knowledgeKind(forChatAttachmentKind rawKind: String) -> LoopOpsKnowledgeSourceKind {
        let value = rawKind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.contains("website") || value.contains("web") || value.contains("url") {
            return .website
        }
        if value.contains("file") || value.contains("upload") || value.contains("document") {
            return .upload
        }
        if value.contains("skill") || value.contains("tool") {
            return .log
        }
        return .chat
    }

    private func defaultKnowledgeActivity(for kind: LoopOpsKnowledgeSourceKind, status: LoopOpsKnowledgeSourceStatus, now: Date) -> String {
        "\(kind.title) source created · \(status.title) · \(AgentDateFormatting.isoString(now))"
    }

    private func defaultKnowledgeSourceLabel(for kind: LoopOpsKnowledgeSourceKind) -> String {
        switch kind {
        case .blank: return "Manual note"
        case .upload: return "Local upload"
        case .website: return "Website import"
        case .integration: return "Connected source"
        case .run: return "Loop run"
        case .review: return "Review packet"
        case .chat: return "Scoped chat"
        case .log: return "Tool log"
        }
    }

    private func load<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(type, from: data)
    }

    private func save<T: Encodable>(_ value: T, to url: URL) {
        do {
            try fileManager.createDirectory(at: rootURL, withIntermediateDirectories: true)
            let data = try encoder.encode(value)
            try data.write(to: url, options: [.atomic])
        } catch {
            assertionFailure("Failed to save LoopOps store: \(error.localizedDescription)")
        }
    }

    private var loopContractsURL: URL {
        rootURL.appendingPathComponent("loop-contracts.json")
    }

    private var chatThreadsURL: URL {
        rootURL.appendingPathComponent("chat-threads.json")
    }

    private var reviewPacketsURL: URL {
        rootURL.appendingPathComponent("review-decisions.json")
    }

    private var runLedgersURL: URL {
        rootURL.appendingPathComponent("run-ledgers.json")
    }

    private var shareSafeLogsURL: URL {
        rootURL.appendingPathComponent("share-safe-logs.json")
    }

    private var skillStacksURL: URL {
        rootURL.appendingPathComponent("skill-stacks.json")
    }

    private var knowledgeSourcesURL: URL {
        rootURL.appendingPathComponent("knowledge-sources.json")
    }

    private var toolDraftsURL: URL {
        rootURL.appendingPathComponent("tool-drafts.json")
    }

    private var toolLogsURL: URL {
        rootURL.appendingPathComponent("tool-logs.json")
    }

    private var builderPacketsURL: URL {
        rootURL.appendingPathComponent("builder-packets.json")
    }
}

private extension LoopOpsChatScope {
    init(chatScope: ChatScope) {
        switch chatScope {
        case .global:
            self = .global
        case .run:
            self = .run
        case .builder:
            self = .builder
        case .review:
            self = .review
        }
    }
}

private extension ChatScope {
    init(strictChatScope: LoopOpsChatScope) {
        switch strictChatScope {
        case .global:
            self = .global
        case .run:
            self = .run
        case .builder:
            self = .builder
        case .review:
            self = .review
        }
    }
}

private extension LoopOpsChatRole {
    init(chatRole: ChatMessage.Role) {
        switch chatRole {
        case .user:
            self = .user
        case .assistant:
            self = .assistant
        case .system:
            self = .system
        }
    }
}

private extension ChatMessage.Role {
    init(strictRole: LoopOpsChatRole) {
        switch strictRole {
        case .user:
            self = .user
        case .assistant:
            self = .assistant
        case .system:
            self = .system
        }
    }
}
