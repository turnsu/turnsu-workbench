import Foundation

struct RuntimeBackend {
    private let repository: RuntimeRepository
    private(set) var state: RuntimeBackendState = .empty

    init(repository: RuntimeRepository = RuntimeRepository()) {
        self.repository = repository
    }

    mutating func execute(_ command: RuntimeCommand) -> RuntimeBackendState {
        switch command {
        case let .refreshRun(reason, selectedGroupID, window, date):
            let result = repository.refresh(date: date, selectedGroupID: selectedGroupID, window: window)
            var selection = state.selection
            if selection.selectedTokenID == nil {
                selection.selectedTokenID = result.terminalData.tokenEntities.first?.tokenID
            }
            state = RuntimeBackendState(result: result, selection: selection, commandStatus: "refresh:\(reason)")

        case let .selectMessage(messageID):
            state.selection.selectedMessageID = messageID
            state.selection.selectedEvidenceID = state.result.terminalData.evidenceItems.first { $0.messageIDs.contains(messageID) }?.id
            state.commandStatus = "selected_message"

        case let .openToken(tokenID):
            state.selection.selectedTokenID = tokenID
            state.selection.selectedEvidenceID = state.result.terminalData.evidenceItems.first { $0.tokenIDs.contains(tokenID) }?.id
            state.commandStatus = "opened_token"

        case let .createTaskFromMessage(messageID):
            let task = UserTask(
                id: UUID(),
                title: "Follow up selected message",
                detail: "Created from RuntimeCommand.createTaskFromMessage.",
                status: "open",
                priority: 2,
                source: "runtime_command",
                evidenceID: state.result.terminalData.evidenceItems.first { $0.messageIDs.contains(messageID) }?.id,
                tokenID: state.result.terminalData.normalizedMessages.first { $0.id == messageID }?.linkedTokenIDs.first,
                messageID: messageID,
                generatedAt: AgentDateFormatting.isoString(Date()),
                artifactPath: "runtime/tasks/tasks.json"
            )
            mutate(.appendTask(task))

        case let .addTokenToWatchlist(tokenID):
            guard let token = state.result.terminalData.tokenEntities.first(where: { $0.tokenID == tokenID }) else {
                state.commandStatus = "watchlist_failed_missing_token"
                return state
            }
            let item = WatchlistItem(
                id: UUID(),
                tokenID: token.tokenID,
                symbol: token.symbol,
                chain: token.chain,
                contractAddress: token.contractAddress,
                status: "active",
                source: "runtime_command",
                freshness: token.freshness,
                createdAt: AgentDateFormatting.isoString(Date()),
                reason: "Added from Token Terminal."
            )
            mutate(.appendWatchlistItem(item))

        case let .acknowledgeAlert(alertID):
            mutate(.updateAlertStatus(alertID: alertID, status: .acknowledged))

        case let .muteAlert(alertID):
            mutate(.updateAlertStatus(alertID: alertID, status: .muted))

        case let .resolveAlert(alertID):
            mutate(.updateAlertStatus(alertID: alertID, status: .resolved))

        case let .copyEvidence(evidenceID):
            state.selection.selectedEvidenceID = evidenceID
            state.commandStatus = "copy_evidence_ready"

        case let .openArtifactReference(path):
            state.selection.selectedArtifactPath = path
            state.commandStatus = "artifact_selected"

        case let .selectCrystal(crystalID):
            state.selection.selectedCrystalID = crystalID
            if let crystal = state.result.terminalData.proactive.crystals.first(where: { $0.id == crystalID }) {
                state.selection.selectedEvidenceID = crystal.evidenceRefs.first.flatMap { UUID(uuidString: $0.id) }
                state.selection.selectedTokenID = crystal.tokenRefs.first?.value ?? crystal.tokenRefs.first?.id
                state.selection.selectedProposalID = state.result.terminalData.proactive.proposals.first { proposal in
                    proposal.crystalRefs.contains { $0.id == crystal.id.uuidString }
                }?.id
            }
            state.commandStatus = "selected_crystal"

        case let .selectProposal(proposalID):
            state.selection.selectedProposalID = proposalID
            if let proposal = state.result.terminalData.proactive.proposals.first(where: { $0.id == proposalID }) {
                state.selection.selectedCrystalID = proposal.crystalRefs.first.flatMap { UUID(uuidString: $0.id) }
                state.selection.selectedEvidenceID = proposal.evidenceRefs.first.flatMap { UUID(uuidString: $0.id) }
                state.selection.selectedTokenID = proposal.tokenRefs.first?.value ?? proposal.tokenRefs.first?.id
            }
            state.commandStatus = "selected_proposal"

        case let .acceptProposal(proposalID):
            acceptProposal(proposalID)

        case let .rejectProposal(proposalID, reason):
            rejectProposal(proposalID, reason: reason)

        case let .createHandoff(crystalIDs):
            createHandoff(crystalIDs: crystalIDs)

        case let .archiveHandoff(handoffID):
            archiveHandoff(handoffID)

        case .purgeArchivedHandoffs:
            purgeArchivedHandoffs()

        case let .markCrystalUseful(crystalID):
            markCrystal(crystalID, status: .watching, memoryKind: .reviewNote, note: "Marked useful by local operator.")

        case let .markCrystalFalsePositive(crystalID, reason):
            markCrystal(crystalID, status: .falsePositive, memoryKind: .falsePositive, note: reason)

        case let .saveMemory(entry):
            var proactive = state.result.terminalData.proactive
            var memory = proactive.memory.filter { $0.id != entry.id && $0.status != .purged }
            memory.append(entry)
            proactive = proactive.withMemory(memory)
            _ = try? repository.persistMemory(memory)
            mutate(.setProactiveData(proactive))
            state.selection.selectedMemoryID = entry.id
            state.commandStatus = "memory_saved"

        case let .purgeMemory(memoryID):
            var proactive = state.result.terminalData.proactive
            let memory = proactive.memory.filter { $0.id != memoryID }
            proactive = proactive.withMemory(memory)
            _ = try? repository.persistMemory(memory)
            mutate(.setProactiveData(proactive))
            if state.selection.selectedMemoryID == memoryID { state.selection.selectedMemoryID = nil }
            state.commandStatus = "memory_purged"

        case let .loadBridgeArtifact(path):
            state.selection.selectedArtifactPath = path
            state.commandStatus = "bridge_artifact_selected"

        case let .importAgentProductMutations(runID):
            importAgentProductMutations(runID: runID)
        }

        return state
    }

    func query(_ query: RuntimeQuery) -> Any? {
        switch query {
        case .currentState:
            return state
        case .selectedMessage:
            guard let id = state.selection.selectedMessageID else { return nil }
            return state.result.terminalData.normalizedMessages.first { $0.id == id }
        case .selectedToken:
            guard let id = state.selection.selectedTokenID else { return nil }
            return state.result.terminalData.tokenEntities.first { $0.tokenID == id }
        case .selectedEvidence:
            guard let id = state.selection.selectedEvidenceID else { return nil }
            return state.result.terminalData.evidenceItems.first { $0.id == id }
        case .selectedCrystal:
            guard let id = state.selection.selectedCrystalID else { return nil }
            return state.result.terminalData.proactive.crystals.first { $0.id == id }
        case .selectedProposal:
            guard let id = state.selection.selectedProposalID else { return nil }
            return state.result.terminalData.proactive.proposals.first { $0.id == id }
        case .selectedMemory:
            guard let id = state.selection.selectedMemoryID else { return nil }
            return state.result.terminalData.proactive.memory.first { $0.id == id }
        case .selectedHandoff:
            guard let id = state.selection.selectedHandoffID else { return nil }
            return state.result.terminalData.proactive.handoffs.first { $0.id == id }
        case .proactiveSession:
            return state.result.terminalData.proactive.latestSession
        case .bridgeStatus:
            return state.result.terminalData.proactive.bridgeStatuses
        case .artifactManifest:
            return state.result.terminalData.artifactManifest
        case .runtimeHealth:
            return state.result.terminalData.runtimeHealth
        }
    }

    private mutating func importAgentProductMutations(runID: String) {
        guard let payload = AgentProductMutationStore().read(runID: runID) else {
            state.commandStatus = "agent_mutations_missing:\(runID)"
            return
        }

        var importedCount = 0
        if !payload.tasks.isEmpty {
            var tasks = state.result.terminalData.tasks
            let existing = Set(tasks.map(\.id))
            let incoming = payload.tasks.filter { !existing.contains($0.id) }
            tasks.append(contentsOf: incoming)
            importedCount += incoming.count
            _ = try? repository.persistTasks(tasks)
            state.result = state.result.withTerminalData(state.result.terminalData.withTasks(tasks))
        }

        if !payload.watchlistItems.isEmpty {
            var items = state.result.terminalData.watchlistItems
            let existing = Set(items.map(\.id))
            let incoming = payload.watchlistItems.filter { !existing.contains($0.id) }
            items.append(contentsOf: incoming)
            importedCount += incoming.count
            _ = try? repository.persistWatchlist(items)
            state.result = state.result.withTerminalData(state.result.terminalData.withWatchlist(items))
        }

        var proactive = state.result.terminalData.proactive
        if !payload.crystals.isEmpty {
            let existing = Set(proactive.crystals.map(\.id))
            let incoming = payload.crystals.filter { !existing.contains($0.id) }
            proactive = proactive.withCrystals(incoming + proactive.crystals)
            importedCount += incoming.count
            _ = try? repository.persistCrystals(proactive.crystals)
        }
        if !payload.proposals.isEmpty {
            let existing = Set(proactive.proposals.map(\.id))
            let incoming = payload.proposals.filter { !existing.contains($0.id) }
            proactive = proactive.withProposals(incoming + proactive.proposals)
            importedCount += incoming.count
            _ = try? repository.persistProposals(proactive.proposals)
        }
        if !payload.memory.isEmpty {
            let existing = Set(proactive.memory.map(\.id))
            let incoming = payload.memory.filter { !existing.contains($0.id) && $0.status != .purged }
            proactive = proactive.withMemory(incoming + proactive.memory.filter { $0.status != .purged })
            importedCount += incoming.count
            _ = try? repository.persistMemory(proactive.memory)
        }
        if !payload.handoffs.isEmpty {
            let existing = Set(proactive.handoffs.map(\.id))
            let incoming = payload.handoffs.filter { !existing.contains($0.id) }
            proactive = proactive.withHandoffs(incoming + proactive.handoffs)
            importedCount += incoming.count
            _ = try? repository.persistHandoffs(proactive.handoffs)
        }
        mutate(.setProactiveData(proactive))
        state.commandStatus = "agent_mutations_imported:\(runID):\(importedCount)"
    }

    private mutating func mutate(_ mutation: RuntimeMutation) {
        switch mutation {
        case let .setSelection(selection):
            state.selection = selection
        case let .appendTask(task):
            var tasks = state.result.terminalData.tasks
            tasks.append(task)
            _ = try? repository.persistTasks(tasks)
            state.result = state.result.withTerminalData(state.result.terminalData.withTasks(tasks))
            state.commandStatus = "task_created"
        case let .appendWatchlistItem(item):
            var items = state.result.terminalData.watchlistItems
            if !items.contains(where: { $0.tokenID == item.tokenID && $0.source == item.source }) {
                items.append(item)
            }
            _ = try? repository.persistWatchlist(items)
            state.result = state.result.withTerminalData(state.result.terminalData.withWatchlist(items))
            state.commandStatus = "watchlist_added"
        case let .updateAlertStatus(alertID, status):
            let alerts = state.result.terminalData.alerts.map { alert in
                guard alert.id == alertID else { return alert }
                return AlertRecord(
                    id: alert.id,
                    tokenID: alert.tokenID,
                    title: alert.title,
                    severity: alert.severity,
                    status: status.rawValue,
                    reason: alert.reason,
                    createdAt: alert.createdAt
                )
            }
            _ = try? repository.persistAlerts(alerts)
            state.result = state.result.withTerminalData(state.result.terminalData.withAlerts(alerts))
            state.commandStatus = "alert_\(status.rawValue)"
        case let .setCommandStatus(status):
            state.commandStatus = status
        case let .setProactiveData(proactive):
            state.result = state.result.withTerminalData(state.result.terminalData.withProactive(proactive))
        }
    }

    private mutating func acceptProposal(_ proposalID: UUID) {
        var proactive = state.result.terminalData.proactive
        guard let proposal = proactive.proposals.first(where: { $0.id == proposalID }) else {
            state.commandStatus = "proposal_missing"
            return
        }
        guard proposal.status == .proposed else {
            state.commandStatus = "proposal_already_\(proposal.status.rawValue)"
            return
        }

        let accepted = proposal.withStatus(.accepted, reason: "Accepted locally by operator.")
        proactive = proactive.withProposals(proactive.proposals.map { $0.id == proposalID ? accepted : $0 })
        _ = try? repository.persistProposals(proactive.proposals)

        switch proposal.action {
        case .addToWatchlist:
            if let tokenRef = proposal.tokenRefs.first,
               let tokenID = tokenRef.value ?? tokenRef.id as String?,
               let token = state.result.terminalData.tokenEntities.first(where: { $0.tokenID == tokenID }),
               !state.result.terminalData.watchlistItems.contains(where: { $0.tokenID == tokenID && $0.source == "proposal:\(proposalID.uuidString)" }) {
                let item = WatchlistItem(
                    id: UUID(),
                    tokenID: token.tokenID,
                    symbol: token.symbol,
                    chain: token.chain,
                    contractAddress: token.contractAddress,
                    status: "active",
                    source: "proposal:\(proposalID.uuidString)",
                    freshness: token.freshness,
                    createdAt: AgentDateFormatting.isoString(Date()),
                    reason: proposal.summary
                )
                mutate(.appendWatchlistItem(item))
            }
        case .createTask, .markReview, .requestBridgeRefresh, .saveMemory, .noOp, .createAlert, .createHandoffDraft:
            if !state.result.terminalData.tasks.contains(where: { $0.source == "proposal:\(proposalID.uuidString)" }) {
                let task = UserTask(
                    id: UUID(),
                    title: proposal.title,
                    detail: proposal.summary,
                    status: "open",
                    priority: proposal.risk == .high || proposal.risk == .critical ? 1 : 2,
                    source: "proposal:\(proposalID.uuidString)",
                    evidenceID: proposal.evidenceRefs.first.flatMap { UUID(uuidString: $0.id) },
                    tokenID: proposal.tokenRefs.first?.value ?? proposal.tokenRefs.first?.id,
                    messageID: proposal.messageRefs.first.flatMap { UUID(uuidString: $0.id) },
                    generatedAt: AgentDateFormatting.isoString(Date()),
                    artifactPath: "runtime/tasks/tasks.json"
                )
                mutate(.appendTask(task))
            }
        }

        mutate(.setProactiveData(proactive))
        state.selection.selectedProposalID = proposalID
        state.commandStatus = "proposal_accepted"
    }

    private mutating func rejectProposal(_ proposalID: UUID, reason: String) {
        var proactive = state.result.terminalData.proactive
        guard let proposal = proactive.proposals.first(where: { $0.id == proposalID }) else {
            state.commandStatus = "proposal_missing"
            return
        }
        let rejected = proposal.withStatus(.rejected, reason: reason)
        proactive = proactive.withProposals(proactive.proposals.map { $0.id == proposalID ? rejected : $0 })
        let memory = reviewMemory(title: "Rejected \(proposal.title)", content: reason, subject: proposal.crystalRefs.first, kind: .reviewNote, confidence: proposal.confidence)
        proactive = proactive.withMemory((proactive.memory.filter { $0.status != .purged }) + [memory])
        _ = try? repository.persistProposals(proactive.proposals)
        _ = try? repository.persistMemory(proactive.memory)
        mutate(.setProactiveData(proactive))
        state.selection.selectedProposalID = proposalID
        state.selection.selectedMemoryID = memory.id
        state.commandStatus = "proposal_rejected"
    }

    private mutating func createHandoff(crystalIDs: [UUID]) {
        var proactive = state.result.terminalData.proactive
        let selected = proactive.crystals.filter { crystalIDs.isEmpty || crystalIDs.contains($0.id) }
        guard !selected.isEmpty else {
            state.commandStatus = "handoff_failed_no_crystals"
            return
        }
        let packet = handoff(from: selected)
        proactive = proactive.withHandoffs([packet] + proactive.handoffs.filter { $0.id != packet.id })
        _ = try? repository.persistHandoffs(proactive.handoffs)
        mutate(.setProactiveData(proactive))
        state.selection.selectedHandoffID = packet.id
        state.commandStatus = "handoff_created"
    }

    private mutating func archiveHandoff(_ handoffID: UUID) {
        var proactive = state.result.terminalData.proactive
        guard proactive.handoffs.contains(where: { $0.id == handoffID }) else {
            state.commandStatus = "handoff_missing"
            return
        }
        let handoffs = proactive.handoffs.map { packet in
            packet.id == handoffID ? packet.withStatus(.archived) : packet
        }
        proactive = proactive.withHandoffs(handoffs)
        _ = try? repository.persistHandoffs(handoffs)
        mutate(.setProactiveData(proactive))
        state.selection.selectedHandoffID = handoffID
        state.commandStatus = "handoff_archived"
    }

    private mutating func purgeArchivedHandoffs() {
        var proactive = state.result.terminalData.proactive
        let active = proactive.handoffs.filter { $0.status != .archived }
        proactive = proactive.withHandoffs(active)
        _ = try? repository.purgeArchivedHandoffs(preserving: active)
        _ = try? repository.persistHandoffs(active)
        mutate(.setProactiveData(proactive))
        if let selected = state.selection.selectedHandoffID,
           !active.contains(where: { $0.id == selected }) {
            state.selection.selectedHandoffID = active.first?.id
        }
        state.commandStatus = "archived_handoffs_purged"
    }

    private mutating func markCrystal(_ crystalID: UUID, status: CrystalStatus, memoryKind: MemoryEntryKind, note: String) {
        var proactive = state.result.terminalData.proactive
        guard let crystal = proactive.crystals.first(where: { $0.id == crystalID }) else {
            state.commandStatus = "crystal_missing"
            return
        }
        let updated = crystal.withStatus(status)
        proactive = proactive.withCrystals(proactive.crystals.map { $0.id == crystalID ? updated : $0 })
        let memory = reviewMemory(title: "\(status.rawValue) \(crystal.title)", content: note, subject: crystalReference(crystal), kind: memoryKind, confidence: crystal.confidence)
        proactive = proactive.withMemory((proactive.memory.filter { $0.status != .purged }) + [memory])
        _ = try? repository.persistCrystals(proactive.crystals)
        _ = try? repository.persistMemory(proactive.memory)
        mutate(.setProactiveData(proactive))
        state.selection.selectedCrystalID = crystalID
        state.selection.selectedMemoryID = memory.id
        state.commandStatus = "crystal_\(status.rawValue)"
    }

    private func reviewMemory(title: String, content: String, subject: RuntimeObjectReference?, kind: MemoryEntryKind, confidence: Double) -> MemoryEntry {
        let generated = AgentDateFormatting.isoString(Date())
        return MemoryEntry(
            id: UUID(),
            kind: kind,
            title: title,
            content: content,
            subjectRef: subject,
            sourceQualityScore: confidence,
            evidenceRefs: [],
            messageRefs: [],
            tokenRefs: [],
            artifactRefs: [RuntimeObjectReference(id: "runtime/memory/memory.json", kind: .artifact, label: "memory.json", path: "runtime/memory/memory.json", value: nil, source: "runtime_backend", freshness: .currentRun, confidence: nil, privacyLevel: "local", redactionStatus: "summary_only", generatedAt: generated, runID: state.syncRunID)],
            freshness: .currentRun,
            risk: .low,
            confidence: confidence,
            status: .active,
            createdAt: generated,
            updatedAt: generated,
            expiresAt: nil,
            purgeable: true,
            provenance: ProactiveProvenance(runID: state.syncRunID, sessionID: state.result.terminalData.proactive.latestSession?.id, parentRunID: nil, moduleRunIDs: [], subagentRunIDs: [], policyDecisionRefs: [], source: "runtime_backend_review", generatedAt: generated)
        )
    }

    private func handoff(from crystals: [IntelligenceCrystal]) -> HandoffPacket {
        let generated = AgentDateFormatting.isoString(Date())
        let refs = crystals.map(crystalReference)
        return HandoffPacket(
            id: UUID(),
            title: "Selected crystal handoff",
            purpose: .teamUpdate,
            summaryText: crystals.map { "- \($0.title): \($0.rationale)" }.joined(separator: "\n"),
            selectedCrystalRefs: refs,
            evidenceRefs: crystals.flatMap(\.evidenceRefs),
            messageRefs: crystals.flatMap(\.messageRefs).map { ref in
                RuntimeObjectReference(id: ref.id, kind: ref.kind, label: ref.label, path: ref.path, value: "[redacted preview]", source: ref.source, freshness: ref.freshness, confidence: ref.confidence, privacyLevel: ref.privacyLevel, redactionStatus: "preview_redacted", generatedAt: ref.generatedAt, runID: ref.runID)
            },
            tokenRefs: crystals.flatMap(\.tokenRefs),
            artifactRefs: [RuntimeObjectReference(id: "runtime/handoffs/index.json", kind: .artifact, label: "handoffs", path: "runtime/handoffs/index.json", value: nil, source: "runtime_backend", freshness: .currentRun, confidence: nil, privacyLevel: "local", redactionStatus: "metadata_only", generatedAt: generated, runID: state.syncRunID)],
            openTaskRefs: state.result.terminalData.tasks.map { task in RuntimeObjectReference(id: task.id.uuidString, kind: .task, label: task.title, path: "runtime/tasks/tasks.json", value: task.status, source: task.source, freshness: .currentRun, confidence: nil, privacyLevel: "local", redactionStatus: "summary_only", generatedAt: task.generatedAt, runID: state.syncRunID) },
            unresolvedQuestions: state.result.terminalData.proactive.proposals.prefix(3).map(\.rejectionFallback),
            sourceFreshness: crystals.reduce(into: [:]) { partial, crystal in crystal.sourceFreshness.forEach { partial[$0.key] = $0.value } },
            degradedBoundaries: crystals.flatMap { crystal in crystal.sourceFreshness.compactMap { [.degraded, .stale, .blocked].contains($0.value) ? "\($0.key)=\($0.value.rawValue)" : nil } },
            redaction: HandoffRedaction(policy: .privatePreviewRedacted, redactedFields: ["message.value", "sender"], privateContentIncluded: false, notes: "Generated from selected crystals with redacted previews."),
            freshness: crystals.contains { $0.freshness == .degraded || $0.freshness == .stale } ? .degraded : .fresh,
            risk: crystals.contains { $0.risk == .high || $0.risk == .critical } ? .high : .medium,
            confidence: crystals.map(\.confidence).min() ?? 0,
            nextAction: ProactiveNextAction(type: .review, title: "Review handoff", detail: "Verify redaction and freshness before sharing.", targetRefs: refs, permissionRequired: .localWrite, status: .planned),
            status: .draft,
            generatedAt: generated,
            artifactPath: "runtime/handoffs/index.json",
            provenance: ProactiveProvenance(runID: state.syncRunID, sessionID: state.result.terminalData.proactive.latestSession?.id, parentRunID: nil, moduleRunIDs: [], subagentRunIDs: [], policyDecisionRefs: [], source: "runtime_backend_handoff", generatedAt: generated)
        )
    }

    private func crystalReference(_ crystal: IntelligenceCrystal) -> RuntimeObjectReference {
        RuntimeObjectReference(id: crystal.id.uuidString, kind: .crystal, label: crystal.title, path: "runtime/crystals/crystals.json", value: crystal.status.rawValue, source: "runtime_backend", freshness: crystal.freshness, confidence: crystal.confidence, privacyLevel: "local", redactionStatus: "summary_only", generatedAt: crystal.updatedAt, runID: state.syncRunID)
    }
}

private extension AgentRunResult {
    func withTerminalData(_ terminalData: TerminalDataSnapshot) -> AgentRunResult {
        AgentRunResult(
            snapshot: snapshot,
            logs: logs,
            capabilities: capabilities,
            policies: policies,
            envelope: envelope,
            syncState: syncState,
            artifactStatus: artifactStatus,
            terminalData: terminalData
        )
    }
}

private extension TerminalDataSnapshot {
    func withTasks(_ tasks: [UserTask]) -> TerminalDataSnapshot {
        copy(tasks: tasks)
    }

    func withWatchlist(_ items: [WatchlistItem]) -> TerminalDataSnapshot {
        copy(watchlistItems: items)
    }

    func withAlerts(_ alerts: [AlertRecord]) -> TerminalDataSnapshot {
        copy(alerts: alerts)
    }

    func withProactive(_ proactive: ProactiveRuntimeData) -> TerminalDataSnapshot {
        copy(proactive: proactive)
    }

    func copy(
        tasks: [UserTask]? = nil,
        watchlistItems: [WatchlistItem]? = nil,
        alerts: [AlertRecord]? = nil,
        proactive: ProactiveRuntimeData? = nil
    ) -> TerminalDataSnapshot {
        TerminalDataSnapshot(
            normalizedMessages: normalizedMessages,
            tokenEntities: tokenEntities,
            marketSnapshots: marketSnapshots,
            onchainSnapshots: onchainSnapshots,
            evidenceItems: evidenceItems,
            tasks: tasks ?? self.tasks,
            alerts: alerts ?? self.alerts,
            watchlistItems: watchlistItems ?? self.watchlistItems,
            alertRules: alertRules,
            artifactManifest: artifactManifest,
            runtimeHealth: runtimeHealth,
            moduleRuns: moduleRuns,
            subagentRuns: subagentRuns,
            sourceHealth: sourceHealth,
            proactive: proactive ?? self.proactive
        )
    }
}

private extension AgentProposal {
    func withStatus(_ status: ProposalStatus, reason: String?) -> AgentProposal {
        AgentProposal(
            id: id,
            title: title,
            summary: summary,
            rationale: rationale,
            action: action,
            permission: permission,
            rejectionFallback: rejectionFallback,
            evidenceRefs: evidenceRefs,
            messageRefs: messageRefs,
            tokenRefs: tokenRefs,
            crystalRefs: crystalRefs,
            artifactRefs: artifactRefs,
            artifactsToWrite: artifactsToWrite,
            freshness: freshness,
            risk: risk,
            confidence: confidence,
            nextAction: nextAction,
            status: status,
            createdAt: createdAt,
            updatedAt: AgentDateFormatting.isoString(Date()),
            decidedAt: AgentDateFormatting.isoString(Date()),
            decisionReason: reason,
            provenance: provenance
        )
    }
}

private extension HandoffPacket {
    func withStatus(_ status: HandoffStatus) -> HandoffPacket {
        HandoffPacket(
            id: id,
            title: title,
            purpose: purpose,
            summaryText: summaryText,
            selectedCrystalRefs: selectedCrystalRefs,
            evidenceRefs: evidenceRefs,
            messageRefs: messageRefs,
            tokenRefs: tokenRefs,
            artifactRefs: artifactRefs,
            openTaskRefs: openTaskRefs,
            unresolvedQuestions: unresolvedQuestions,
            sourceFreshness: sourceFreshness,
            degradedBoundaries: degradedBoundaries,
            redaction: redaction,
            freshness: freshness,
            risk: risk,
            confidence: confidence,
            nextAction: nextAction,
            status: status,
            generatedAt: generatedAt,
            artifactPath: artifactPath,
            provenance: provenance
        )
    }
}

private extension IntelligenceCrystal {
    func withStatus(_ status: CrystalStatus) -> IntelligenceCrystal {
        IntelligenceCrystal(
            id: id,
            title: title,
            rationale: rationale,
            detail: detail,
            sourceMix: sourceMix,
            evidenceRefs: evidenceRefs,
            messageRefs: messageRefs,
            tokenRefs: tokenRefs,
            artifactRefs: artifactRefs,
            memoryRefs: memoryRefs,
            freshness: freshness,
            sourceFreshness: sourceFreshness,
            risk: risk,
            confidence: confidence,
            nextAction: nextAction,
            status: status,
            createdAt: createdAt,
            updatedAt: AgentDateFormatting.isoString(Date()),
            provenance: provenance
        )
    }
}

private extension ProactiveRuntimeData {
    func withCrystals(_ crystals: [IntelligenceCrystal]) -> ProactiveRuntimeData {
        copy(crystals: crystals)
    }

    func withProposals(_ proposals: [AgentProposal]) -> ProactiveRuntimeData {
        copy(proposals: proposals)
    }

    func withMemory(_ memory: [MemoryEntry]) -> ProactiveRuntimeData {
        copy(memory: memory)
    }

    func withHandoffs(_ handoffs: [HandoffPacket]) -> ProactiveRuntimeData {
        copy(handoffs: handoffs)
    }

    private func copy(
        crystals: [IntelligenceCrystal]? = nil,
        proposals: [AgentProposal]? = nil,
        memory: [MemoryEntry]? = nil,
        handoffs: [HandoffPacket]? = nil
    ) -> ProactiveRuntimeData {
        ProactiveRuntimeData(
            status: status,
            generatedAt: AgentDateFormatting.isoString(Date()),
            freshness: freshness,
            risk: risk,
            confidence: confidence,
            nextAction: nextAction,
            crystals: crystals ?? self.crystals,
            proposals: proposals ?? self.proposals,
            memory: memory ?? self.memory,
            handoffs: handoffs ?? self.handoffs,
            latestSession: latestSession,
            bridgeStatuses: bridgeStatuses
        )
    }
}

private extension RuntimeBackendState {
    var syncRunID: String? {
        result.syncState.runID == "--" ? nil : result.syncState.runID
    }
}
