import Foundation

enum LoopOpsInteractionID {
    static let buildNavigationGroup = "loopops.nav.build"
    static let buildAgentsList = "loopops.build.agents"
    static let buildToolsList = "loopops.build.tools"
    static let buildWorkforceList = "loopops.build.workforce"
    static let buildKnowledgeList = "loopops.build.knowledge"
    static let buildChatList = "loopops.build.chat"
    static let buildCreateButton = "loopops.build.create"
    static let runsMonitorTable = "loopops.monitor.runs"
    static let workbenchActiveQueue = "loopops.workbench.active-queue"
    static let workbenchActiveQueueRowPrefix = "loopops.workbench.active-queue.row"
    static let workbenchRunLifecycleActionPrefix = "loopops.workbench.run-lifecycle"
    static let workbenchRunResult = "loopops.workbench.run-result"
    static let workbenchRunChat = "loopops.workbench.run-chat"
    static let workbenchRunChatLocked = "loopops.workbench.run-chat.locked"
    static let workbenchReviewGuide = "loopops.workbench.review-guide"
    static let workbenchReviewGuideProgress = "loopops.workbench.review-guide.progress"
    static let workbenchReviewGuideChecklist = "loopops.workbench.review-guide.checklist"
    static let workbenchReviewGuideEvidenceMap = "loopops.workbench.review-guide.evidence-map"
    static let workbenchReviewGuideEvidenceMapCount = "loopops.workbench.review-guide.evidence-map-count"
    static let workbenchReviewGuideEvidenceRowPrefix = "loopops.workbench.review-guide.evidence"
    static let workbenchReviewGuideDecision = "loopops.workbench.review-guide.decision"
    static let workbenchReviewGuideDecisionStatus = "loopops.workbench.review-guide.decision-status"
    static let workbenchReviewGuideDecisionControls = "loopops.workbench.review-guide.decision-controls"
    static let workbenchReviewGuideDecisionPending = "loopops.workbench.review-guide.decision.pending"
    static let workbenchReviewGuideDecisionNeedsWork = "loopops.workbench.review-guide.decision.needs-work"
    static let workbenchReviewGuideDecisionApproved = "loopops.workbench.review-guide.decision.approved"
    static let workbenchReviewGuideDecisionBlockers = "loopops.workbench.review-guide.decision.blockers"
    static let workbenchReviewGuideDecisionNotes = "loopops.workbench.review-guide.decision.notes"
    static let workbenchReviewGuideDecisionRecord = "loopops.workbench.review-guide.decision-record"
    static let workbenchReviewGuideTraceability = "loopops.workbench.review-guide.traceability"
    static let workbenchReviewGuideTraceabilityCount = "loopops.workbench.review-guide.traceability-count"
    static let workbenchReviewGuideTraceabilityRowPrefix = "loopops.workbench.review-guide.traceability-row"
    static let workbenchReviewGuidePathPrefix = "loopops.workbench.review-guide.path"
    static let workbenchReviewGuideChecklistDonePrefix = "loopops.workbench.review-guide.checklist-done"
    static let scopedChatQuickControlPrefix = "loopops.chat.quick-controls"
    static let scopedChatScopeTargetPrefix = "loopops.chat.scope-target"
    static let scopedChatAttachMenuPrefix = "loopops.chat.attach-menu"
    static let scopedChatAttachmentsPrefix = "loopops.chat.attachments"
    static let workbenchContractRunPrefix = "loopops.workbench.contract"
    static let loopLibrary = "loopops.library"
    static let loopLibraryBatchRun = "loopops.library.batch-run"
    static let loopLibraryTemplateMarketplace = "loopops.library.marketplace"
    static let loopLibraryContractPrefix = "loopops.library.contract"
    static let loopLibraryOpenPrefix = "loopops.library.open"
    static let loopLibraryRunPrefix = "loopops.library.run"
    static let loopLibraryInstallPrefix = "loopops.library.install"
    static let loopLibraryClonePrefix = "loopops.library.clone"
    static let loopLibraryLedgerList = "loopops.library.ledgers"
    static let loopLibraryLedgerPrefix = "loopops.library.ledger"
    static let loopLibraryDetailRun = "loopops.library.detail.run"
    static let loopLibraryDetailInstall = "loopops.library.detail.install"
    static let loopLibraryDetailClone = "loopops.library.detail.clone"
    static let loopLibraryReviewPacket = "loopops.library.review-packet"
    static let loopLibraryReviewPacketHistory = "loopops.library.review-packet.history"
    static let loopLibraryReviewDecisionPrefix = "loopops.library.review-decision"
    static let loopLibraryShareSafeLog = "loopops.library.share-safe-log"
    static let workbenchRunReviewPacketHistory = "loopops.workbench.review-packet.history"
    static let skillOSLibrary = "loopops.skill-os.library"
    static let skillOSSearch = "loopops.skill-os.search"
    static let skillOSFilter = "loopops.skill-os.filter"
    static let skillOSColumns = "loopops.skill-os.columns"
    static let skillOSSort = "loopops.skill-os.sort"
    static let skillOSListMode = "loopops.skill-os.view.list"
    static let skillOSGridMode = "loopops.skill-os.view.grid"
    static let skillOSEnableAction = "loopops.skill-os.action.enable"
    static let skillOSDisableAction = "loopops.skill-os.action.disable"
    static let skillOSDeleteAction = "loopops.skill-os.action.delete"
    static let skillOSDetailPage = "loopops.skill-os.detail"
    static let skillOSStackLibrary = "loopops.skill-os.stacks"
    static let skillOSCreateTool = "loopops.skill-os.create-tool"
    static let skillOSCreateToolStart = "loopops.skill-os.create-tool.start"
    static let skillOSCreateToolScratch = "loopops.skill-os.create-tool.scratch"
    static let skillOSCreateToolInvent = "loopops.skill-os.create-tool.invent"
    static let skillOSCreateToolDefault = "loopops.skill-os.create-tool.default"
    static let skillOSCreateToolImport = "loopops.skill-os.create-tool.import"
    static let skillOSCreateToolName = "loopops.skill-os.create-tool.name"
    static let skillOSCreateToolDescription = "loopops.skill-os.create-tool.description"
    static let skillOSCreateToolIntegration = "loopops.skill-os.create-tool.integration"
    static let skillOSCreateToolInputScope = "loopops.skill-os.create-tool.input-scope"
    static let skillOSCreateToolOutput = "loopops.skill-os.create-tool.output"
    static let skillOSCreateToolReviewRule = "loopops.skill-os.create-tool.review-rule"
    static let skillOSToolLogs = "loopops.skill-os.logs"
    static let skillOSToolLogReviewChat = "loopops.skill-os.logs.review-chat"
    static let skillOSPackagePrefix = "loopops.skill-os.package"
    static let knowledgeNewMenu = "loopops.knowledge.new"
    static let knowledgeAttachLatestRun = "loopops.knowledge.attach-latest-run"
    static let knowledgeToastStack = "loopops.knowledge.toast-stack"
    static let studioSkillShelf = "loopops.studio.skill-shelf"
    static let studioContractEditor = "loopops.studio.contract-editor"
    static let studioKnowledge = "loopops.studio.knowledge"
    static let studioSkillStack = "loopops.studio.skill-stack"
    static let studioExecutionPath = "loopops.studio.execution-path"
    static let studioBuilderChat = "loopops.studio.builder-chat"
    static let studioBuilderPatchReceipt = "loopops.studio.builder-patch-receipt"
    static let studioBuilderPatchReceiptStatus = "loopops.studio.builder-patch-receipt.status"
    static let studioBuilderPacket = "loopops.studio.builder-packet"
    static let studioBuilderPacketDiffRows = "loopops.studio.builder-packet.diff-rows"
    static let studioBuilderPacketApply = "loopops.studio.builder-packet.apply"
    static let studioBuilderPacketReject = "loopops.studio.builder-packet.reject"
    static let studioBuilderPacketSave = "loopops.studio.builder-packet.save"
    static let studioSaveLoop = "loopops.studio.save-loop"
    static let studioRunPreview = "loopops.studio.run-preview"

    static let requiredUISmokeIDs: [String] = [
        buildNavigationGroup,
        buildAgentsList,
        buildToolsList,
        buildWorkforceList,
        buildKnowledgeList,
        buildChatList,
        buildCreateButton,
        runsMonitorTable,
        workbenchActiveQueue,
        workbenchRunLifecycleAction(.pause),
        workbenchRunLifecycleAction(.resume),
        workbenchRunLifecycleAction(.complete),
        workbenchRunLifecycleAction(.fail),
        workbenchRunLifecycleAction(.cancel),
        workbenchRunLifecycleAction(.retry),
        workbenchRunResult,
        workbenchRunChat,
        workbenchRunChatLocked,
        workbenchReviewGuide,
        workbenchReviewGuideProgress,
        workbenchReviewGuideChecklist,
        workbenchReviewGuideEvidenceMap,
        workbenchReviewGuideEvidenceMapCount,
        reviewGuideEvidenceRow("marketplace"),
        reviewGuideEvidenceRow("knowledge"),
        reviewGuideEvidenceRow("tool"),
        reviewGuideEvidenceRow("triple"),
        workbenchReviewGuideDecision,
        workbenchReviewGuideDecisionStatus,
        workbenchReviewGuideDecisionControls,
        workbenchReviewGuideDecisionPending,
        workbenchReviewGuideDecisionNeedsWork,
        workbenchReviewGuideDecisionApproved,
        workbenchReviewGuideDecisionBlockers,
        workbenchReviewGuideDecisionNotes,
        workbenchReviewGuideDecisionRecord,
        workbenchReviewGuideTraceability,
        workbenchReviewGuideTraceabilityCount,
        reviewGuideTraceabilityRow("marketplace-loop-library"),
        reviewGuideTraceabilityRow("knowledge-toast"),
        reviewGuideTraceabilityRow("tool-skill-os-logs"),
        reviewGuideTraceabilityRow("triple-chat-quick-gui"),
        reviewGuideTraceabilityRow("workbench-run-result"),
        reviewGuideTraceabilityRow("studio-skill-path"),
        reviewGuideTraceabilityRow("no-permission-review"),
        reviewGuideTraceabilityRow("agent-team-process"),
        reviewGuidePath("library"),
        reviewGuidePath("skill-os"),
        reviewGuidePath("knowledge"),
        reviewGuidePath("chat"),
        reviewGuideChecklistDone("library"),
        reviewGuideChecklistDone("skill-os"),
        reviewGuideChecklistDone("knowledge"),
        reviewGuideChecklistDone("chat"),
        scopedChat(.global),
        scopedChatQuickControls(.global),
        scopedChatScopeTarget(.global),
        scopedChatAttachMenu(.global),
        scopedChatAttachments(.global),
        scopedChatModelControl(.global),
        scopedChatInstantControl(.global),
        scopedChatSearchControl(.global),
        scopedChatTemporaryControl(.global),
        scopedChatPromptCategories(.global),
        scopedChatInput(.global),
        scopedChatSend(.global),
        scopedChatQuickControls(.run),
        scopedChatScopeTarget(.run),
        scopedChatAttachMenu(.run),
        scopedChatAttachments(.run),
        scopedChatModelControl(.run),
        scopedChatInstantControl(.run),
        scopedChatSearchControl(.run),
        scopedChatTemporaryControl(.run),
        scopedChatPromptCategories(.run),
        scopedChatInput(.run),
        scopedChatSend(.run),
        scopedChat(.review),
        scopedChatQuickControls(.review),
        scopedChatScopeTarget(.review),
        scopedChatAttachMenu(.review),
        scopedChatAttachments(.review),
        scopedChatModelControl(.review),
        scopedChatInstantControl(.review),
        scopedChatSearchControl(.review),
        scopedChatTemporaryControl(.review),
        scopedChatPromptCategories(.review),
        scopedChatInput(.review),
        scopedChatSend(.review),
        loopLibrary,
        loopLibraryBatchRun,
        loopLibraryTemplateMarketplace,
        loopLibraryLedgerList,
        loopLibraryDetailRun,
        loopLibraryDetailInstall,
        loopLibraryDetailClone,
        loopLibraryReviewPacket,
        loopLibraryReviewPacketHistory,
        reviewDecision("reviewed"),
        reviewDecision("needs_follow_up"),
        reviewDecision("blocked"),
        loopLibraryShareSafeLog,
        workbenchRunReviewPacketHistory,
        skillOSLibrary,
        skillOSSearch,
        skillOSFilter,
        skillOSColumns,
        skillOSSort,
        skillOSListMode,
        skillOSGridMode,
        skillOSEnableAction,
        skillOSDisableAction,
        skillOSDeleteAction,
        skillOSDetailPage,
        skillOSStackLibrary,
        skillOSCreateTool,
        skillOSCreateToolStart,
        skillOSCreateToolScratch,
        skillOSCreateToolInvent,
        skillOSCreateToolDefault,
        skillOSCreateToolImport,
        skillOSCreateToolName,
        skillOSCreateToolDescription,
        skillOSCreateToolIntegration,
        skillOSCreateToolInputScope,
        skillOSCreateToolOutput,
        skillOSCreateToolReviewRule,
        skillOSToolLogs,
        skillOSToolLogReviewChat,
        knowledgeNewMenu,
        knowledgeAttachLatestRun,
        knowledgeToastStack,
        studioSkillShelf,
        studioContractEditor,
        studioKnowledge,
        studioSkillStack,
        studioExecutionPath,
        studioBuilderChat,
        studioBuilderPatchReceipt,
        studioBuilderPatchReceiptStatus,
        studioBuilderPacket,
        studioBuilderPacketDiffRows,
        studioBuilderPacketApply,
        studioBuilderPacketReject,
        studioBuilderPacketSave,
        studioSaveLoop,
        studioRunPreview
    ]

    static func scopedChat(_ scope: ChatScope) -> String {
        switch scope {
        case .global:
            return "loopops.chat.global"
        case .run:
            return workbenchRunChat
        case .builder:
            return studioBuilderChat
        case .review:
            return "loopops.chat.review"
        }
    }

    static func scopedChatInput(_ scope: ChatScope) -> String {
        "\(scopedChat(scope)).input"
    }

    static func scopedChatSend(_ scope: ChatScope) -> String {
        "\(scopedChat(scope)).send"
    }

    static func scopedChatQuickControls(_ scope: ChatScope) -> String {
        "\(scopedChatQuickControlPrefix).\(scope.rawValue)"
    }

    static func scopedChatScopeTarget(_ scope: ChatScope) -> String {
        "\(scopedChatScopeTargetPrefix).\(scope.rawValue)"
    }

    static func scopedChatAttachMenu(_ scope: ChatScope) -> String {
        "\(scopedChatAttachMenuPrefix).\(scope.rawValue)"
    }

    static func scopedChatAttachments(_ scope: ChatScope) -> String {
        "\(scopedChatAttachmentsPrefix).\(scope.rawValue)"
    }

    static func scopedChatModelControl(_ scope: ChatScope) -> String {
        "\(scopedChatQuickControls(scope)).model"
    }

    static func scopedChatInstantControl(_ scope: ChatScope) -> String {
        "\(scopedChatQuickControls(scope)).instant"
    }

    static func scopedChatSearchControl(_ scope: ChatScope) -> String {
        "\(scopedChatQuickControls(scope)).search"
    }

    static func scopedChatTemporaryControl(_ scope: ChatScope) -> String {
        "\(scopedChatQuickControls(scope)).temporary"
    }

    static func scopedChatPromptCategories(_ scope: ChatScope) -> String {
        "\(scopedChatQuickControls(scope)).prompt-categories"
    }

    static func contractSelect(_ id: String) -> String {
        "\(loopLibraryContractPrefix).\(id).select"
    }

    static func skillPathRow(_ id: String) -> String {
        "\(studioExecutionPath).row.\(id)"
    }

    static func skillPathMoveUp(_ id: String) -> String {
        "\(skillPathRow(id)).move-up"
    }

    static func skillPathMoveDown(_ id: String) -> String {
        "\(skillPathRow(id)).move-down"
    }

    static func skillPathRemove(_ id: String) -> String {
        "\(skillPathRow(id)).remove"
    }

    static func contractRow(_ id: String) -> String {
        "\(loopLibraryContractPrefix).\(id)"
    }

    static func contractRunButton(_ id: String) -> String {
        "\(loopLibraryRunPrefix).\(id)"
    }

    static func contractInstallButton(_ id: String) -> String {
        "\(loopLibraryInstallPrefix).\(id)"
    }

    static func contractCloneButton(_ id: String) -> String {
        "\(loopLibraryClonePrefix).\(id)"
    }

    static func workbenchContractRun(_ id: String) -> String {
        "\(workbenchContractRunPrefix).\(id).run"
    }

    static func workbenchActiveQueueRow(_ taskID: String) -> String {
        "\(workbenchActiveQueueRowPrefix).\(taskID)"
    }

    static func workbenchRunLifecycleAction(_ action: LoopOpsRunLifecycleAction) -> String {
        "\(workbenchRunLifecycleActionPrefix).\(action.rawValue)"
    }

    static func workbenchRunLifecycleAction(runID: String, action: LoopOpsRunLifecycleAction) -> String {
        "\(workbenchRunLifecycleActionPrefix).\(runID).\(action.rawValue)"
    }

    static func reviewGuidePath(_ id: String) -> String {
        "\(workbenchReviewGuidePathPrefix).\(id)"
    }

    static func reviewGuideChecklistDone(_ id: String) -> String {
        "\(workbenchReviewGuideChecklistDonePrefix).\(id)"
    }

    static func reviewGuideEvidenceRow(_ id: String) -> String {
        "\(workbenchReviewGuideEvidenceRowPrefix).\(id)"
    }

    static func reviewGuideTraceabilityRow(_ id: String) -> String {
        "\(workbenchReviewGuideTraceabilityRowPrefix).\(id)"
    }

    static func contractOpenButton(_ id: String) -> String {
        "\(loopLibraryOpenPrefix).\(id)"
    }

    static func ledgerRow(_ id: String) -> String {
        "\(loopLibraryLedgerPrefix).\(id)"
    }

    static func reviewDecision(_ value: String) -> String {
        "\(loopLibraryReviewDecisionPrefix).\(value)"
    }

    static func skillPackage(_ id: String) -> String {
        "\(skillOSPackagePrefix).\(id)"
    }
}

struct LoopOpsRunLaunchRequest: Hashable {
    var launchID: String
    var contractID: String
    var contractName: String
    var prompt: String
    var selectedSkillIDs: [String]
    var selectedExtensionIDs: [String]
    var knowledgeSourceIDs: [String]
    var contextRefs: [RuntimeObjectReference]
    var chatScopeID: String

    init(
        contract: LoopContract,
        knowledgeSources: [LoopOpsKnowledgeSource] = [],
        additionalInstruction: String? = nil,
        launchID: String = UUID().uuidString
    ) {
        self.launchID = launchID
        contractID = contract.id
        contractName = contract.name
        let readySources = knowledgeSources.filter(\.canAttachToRun)
        let knowledgeSummary = readySources.isEmpty
            ? nil
            : readySources.map { "\($0.title) (\($0.sourceLabel))" }.joined(separator: " / ")
        prompt = contract.promptForRun(
            additionalInstruction: additionalInstruction,
            knowledgeScopeSummary: knowledgeSummary
        )
        selectedSkillIDs = contract.orderedSkillIDs
        selectedExtensionIDs = contract.orderedExtensionIDs
        knowledgeSourceIDs = readySources.map(\.id)
        contextRefs = readySources.map { $0.runtimeContextReference() }
        chatScopeID = "loop-run-\(contract.id)-\(launchID)"
    }
}

struct LoopOpsResolvedRunSelection: Hashable {
    var selectedSkillIDs: [String]
    var selectedExtensionIDs: [String]
    var localToolDrafts: [LoopOpsToolDraft]
}

extension LoopContract {
    func resolvedRunSelection(toolDrafts: [LoopOpsToolDraft]) -> LoopOpsResolvedRunSelection {
        let draftByID = Dictionary(uniqueKeysWithValues: toolDrafts.map { ($0.id, $0) })
        var skillIDs: [String] = []
        var extensionIDs: [String] = []
        var localDrafts: [LoopOpsToolDraft] = []

        func appendUnique(_ value: String, to values: inout [String]) {
            guard !value.isEmpty, !values.contains(value) else { return }
            values.append(value)
        }

        func appendBinding(_ binding: LoopOpsSkillBinding) {
            switch binding.kind {
            case .skill:
                if let draft = draftByID[binding.id] {
                    guard draft.isEnabled else { return }
                    if !localDrafts.contains(where: { $0.id == draft.id }) {
                        localDrafts.append(draft)
                    }
                    for innerBinding in LoopOpsSkillBinding.ordered(draft.skillBindings) where draftByID[innerBinding.id] == nil {
                        appendBinding(innerBinding)
                    }
                } else if binding.id.hasPrefix("tool-draft-") {
                    return
                } else {
                    appendUnique(binding.id, to: &skillIDs)
                }
            case .extensionPackage:
                appendUnique(binding.id, to: &extensionIDs)
            }
        }

        for binding in activeSkillBindings {
            appendBinding(binding)
        }

        return LoopOpsResolvedRunSelection(
            selectedSkillIDs: skillIDs,
            selectedExtensionIDs: extensionIDs,
            localToolDrafts: localDrafts
        )
    }
}
