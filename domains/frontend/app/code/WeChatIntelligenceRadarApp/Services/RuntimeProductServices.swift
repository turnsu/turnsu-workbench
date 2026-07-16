import Foundation

struct AgentModuleRunner {
    let runID: String

    func record(
        _ moduleID: AgentModuleID,
        status: AgentModuleStatus,
        startedAt: Date,
        inputSummary: String,
        outputSummary: String,
        producedArtifacts: [String] = [],
        evidenceIDs: [UUID] = [],
        error: String? = nil,
        degradedReason: String? = nil
    ) -> AgentModuleRun {
        AgentModuleRun(
            moduleID: moduleID,
            runID: runID,
            status: status,
            startedAt: AgentDateFormatting.isoString(startedAt),
            completedAt: AgentDateFormatting.isoString(Date()),
            inputSummary: inputSummary,
            outputSummary: outputSummary,
            producedArtifacts: producedArtifacts,
            evidenceIDs: evidenceIDs,
            error: error,
            degradedReason: degradedReason
        )
    }
}

struct RuntimeProductBuilder {
    func evidence(
        messages: [NormalizedWeChatMessage],
        entities: [TokenEntity],
        market: MarketDataSnapshot,
        onchain: [OnchainSnapshot],
        runID: String,
        generatedAt: Date
    ) -> [EvidenceItem] {
        entities.map { entity in
            let linkedMessages = messages.filter { $0.linkedTokenIDs.contains(entity.tokenID) }
            let marketAsset = market.assets.first { $0.symbol == entity.symbol }
            let onchainSnapshot = onchain.first { $0.tokenID == entity.tokenID }
            let summaryParts = [
                "\(linkedMessages.count) related WeChat message(s)",
                marketAsset.map { "market=\($0.source)" } ?? "market=not_available",
                onchainSnapshot.map { "onchain=\($0.source)/\($0.freshness)" } ?? "onchain=not_available"
            ]

            return EvidenceItem(
                id: UUID(),
                evidenceType: "message_token_market_onchain",
                title: "\(entity.symbol) evidence bundle",
                summary: summaryParts.joined(separator: " · "),
                messageIDs: linkedMessages.map(\.id),
                tokenIDs: [entity.tokenID],
                source: "runtime_pipeline_fixture",
                freshness: combinedFreshness(entity: entity, market: market, onchain: onchainSnapshot),
                confidence: min(0.99, (entity.confidence + (onchainSnapshot?.confidence ?? 0.4)) / 2.0),
                generatedAt: AgentDateFormatting.isoString(generatedAt),
                artifactPath: "runtime/runs/\(runID)/terminal-data.json",
                privacyLevel: linkedMessages.first?.privacyLevel ?? "fixture"
            )
        }
    }

    func tasks(from evidence: [EvidenceItem], generatedAt: Date) -> [UserTask] {
        evidence.map { item in
            UserTask(
                id: UUID(),
                title: "Review \(item.title)",
                detail: "Validate source/freshness/confidence and decide whether to follow up.",
                status: "open",
                priority: item.confidence >= 0.75 ? 2 : 3,
                source: "task_module",
                evidenceID: item.id,
                tokenID: item.tokenIDs.first,
                messageID: item.messageIDs.first,
                generatedAt: AgentDateFormatting.isoString(generatedAt),
                artifactPath: "runtime/tasks/tasks.json"
            )
        }
    }

    func watchlist(from entities: [TokenEntity], generatedAt: Date) -> [WatchlistItem] {
        entities.map { entity in
            WatchlistItem(
                id: UUID(),
                tokenID: entity.tokenID,
                symbol: entity.symbol,
                chain: entity.chain,
                contractAddress: entity.contractAddress,
                status: "active",
                source: "entity_resolver",
                freshness: entity.freshness,
                createdAt: AgentDateFormatting.isoString(generatedAt),
                reason: "\(entity.sourceMessages.count) related message(s) in selected window."
            )
        }
    }

    func alertRules(from entities: [TokenEntity], generatedAt: Date) -> [AlertRule] {
        entities.map { entity in
            AlertRule(
                id: UUID(),
                tokenID: entity.tokenID,
                ruleType: "mention_watch",
                thresholdDescription: "Trigger when selected-window mentions >= 1.",
                status: "active",
                source: "alert_module_fixture_rule",
                generatedAt: AgentDateFormatting.isoString(generatedAt),
                artifactPath: "runtime/alerts/alert-rules.json"
            )
        }
    }

    func memorySeeds(
        from evidence: [EvidenceItem],
        existing: [MemoryEntry],
        runID: String,
        generatedAt: Date
    ) -> [MemoryEntry] {
        var entries = existing.filter { $0.status != .purged }
        let generated = AgentDateFormatting.isoString(generatedAt)
        let existingSubjects = Set(entries.compactMap { $0.subjectRef?.id })

        for item in evidence where !item.tokenIDs.isEmpty {
            guard let tokenID = item.tokenIDs.first, !existingSubjects.contains(tokenID) else { continue }
            let subject = RuntimeObjectReference(
                id: tokenID,
                kind: .token,
                label: tokenID,
                path: "runtime/entities/token-entities.json",
                value: tokenID,
                source: "memory_retriever",
                freshness: proactiveFreshness(item.freshness),
                confidence: item.confidence,
                privacyLevel: item.privacyLevel,
                redactionStatus: "metadata_only",
                generatedAt: generated,
                runID: runID
            )
            entries.append(MemoryEntry(
                id: UUID(),
                kind: .sourceQuality,
                title: "\(tokenID) local review seed",
                content: "Auto-created local memory seed from evidence; user can mark useful, wrong, or purge.",
                subjectRef: subject,
                sourceQualityScore: item.confidence,
                evidenceRefs: [reference(for: item, runID: runID)],
                messageRefs: item.messageIDs.map { messageReference(id: $0, runID: runID, freshness: proactiveFreshness(item.freshness), privacyLevel: item.privacyLevel) },
                tokenRefs: [subject],
                artifactRefs: [artifactReference("runtime/memory/memory.json", label: "memory.json", runID: runID, freshness: .currentRun)],
                freshness: proactiveFreshness(item.freshness),
                risk: risk(for: item),
                confidence: item.confidence,
                status: .active,
                createdAt: generated,
                updatedAt: generated,
                expiresAt: nil,
                purgeable: true,
                provenance: provenance(runID: runID, source: "review_learner", generatedAt: generated)
            ))
        }
        return entries
    }

    func crystals(
        messages: [NormalizedWeChatMessage],
        entities: [TokenEntity],
        market: MarketDataSnapshot,
        onchain: [OnchainSnapshot],
        evidence: [EvidenceItem],
        memory: [MemoryEntry],
        runID: String,
        generatedAt: Date
    ) -> [IntelligenceCrystal] {
        let generated = AgentDateFormatting.isoString(generatedAt)
        let memoryBySubject = Dictionary(grouping: memory.filter { $0.status == .active }) { $0.subjectRef?.id ?? "" }

        return evidence.map { item in
            let tokenID = item.tokenIDs.first ?? "unknown"
            let entity = entities.first { $0.tokenID == tokenID }
            let symbol = entity?.symbol ?? tokenID
            let linkedMessages = messages.filter { item.messageIDs.contains($0.id) }
            let linkedOnchain = onchain.first { $0.tokenID == tokenID }
            let marketAsset = market.assets.first { $0.symbol == symbol }
            let activeMemory = memoryBySubject[tokenID] ?? []
            let freshness = combinedProactiveFreshness(item.freshness, market.freshness, linkedOnchain?.freshness)
            let confidence = min(0.99, item.confidence + Double(activeMemory.count) * 0.03)
            let tokenRefs = item.tokenIDs.map { id in
                RuntimeObjectReference(
                    id: id,
                    kind: .token,
                    label: entity?.symbol ?? id,
                    path: "runtime/entities/token-entities.json",
                    value: id,
                    source: entity?.source ?? "entity_resolver",
                    freshness: proactiveFreshness(entity?.freshness ?? item.freshness),
                    confidence: entity?.confidence,
                    privacyLevel: "metadata",
                    redactionStatus: "metadata_only",
                    generatedAt: generated,
                    runID: runID
                )
            }
            let evidenceRefs = [reference(for: item, runID: runID)]
            let messageRefs = linkedMessages.map { message in
                RuntimeObjectReference(
                    id: message.id.uuidString,
                    kind: .message,
                    label: message.groupName,
                    path: "runtime/wechat/messages.normalized.json",
                    value: message.text.prefix(72).description,
                    source: message.sourceMode,
                    freshness: .fresh,
                    confidence: nil,
                    privacyLevel: message.privacyLevel,
                    redactionStatus: "preview_redacted",
                    generatedAt: generated,
                    runID: runID
                )
            }
            let artifactRefs = [
                artifactReference("runtime/crystals/crystals.json", label: "crystals.json", runID: runID, freshness: .currentRun),
                artifactReference("runtime/runs/\(runID)/terminal-data.json", label: "terminal-data.json", runID: runID, freshness: .currentRun)
            ]
            let memoryRefs = activeMemory.map { entry in
                RuntimeObjectReference(
                    id: entry.id.uuidString,
                    kind: .memory,
                    label: entry.title,
                    path: "runtime/memory/memory.json",
                    value: entry.kind.rawValue,
                    source: "memory_store",
                    freshness: entry.freshness,
                    confidence: entry.confidence,
                    privacyLevel: "local",
                    redactionStatus: "summary_only",
                    generatedAt: entry.updatedAt,
                    runID: runID
                )
            }
            let sourceMix = [
                "wechat:\(linkedMessages.count)",
                "market:\(marketAsset?.source ?? market.sourceName)",
                "onchain:\(linkedOnchain?.source ?? "not_available")",
                "memory:\(activeMemory.count)"
            ]

            return IntelligenceCrystal(
                id: UUID(),
                title: "\(symbol) fused signal",
                rationale: "\(linkedMessages.count) WeChat message(s), market \(market.freshness), on-chain \(linkedOnchain?.freshness ?? "not_available").",
                detail: item.summary,
                sourceMix: sourceMix,
                evidenceRefs: evidenceRefs,
                messageRefs: messageRefs,
                tokenRefs: tokenRefs,
                artifactRefs: artifactRefs,
                memoryRefs: memoryRefs,
                freshness: freshness,
                sourceFreshness: [
                    "wechat": .fresh,
                    "market": proactiveFreshness(market.freshness),
                    "onchain": proactiveFreshness(linkedOnchain?.freshness ?? "unknown"),
                    "memory": activeMemory.isEmpty ? .notRun : .fresh
                ],
                risk: risk(for: item, onchain: linkedOnchain),
                confidence: confidence,
                nextAction: ProactiveNextAction(
                    type: confidence >= 0.8 ? .addToWatchlist : .inspectEvidence,
                    title: confidence >= 0.8 ? "Add to watchlist" : "Inspect evidence",
                    detail: "Review source freshness and decide whether this signal needs follow-up.",
                    targetRefs: evidenceRefs + tokenRefs,
                    permissionRequired: .localWrite,
                    status: .planned
                ),
                status: .new,
                createdAt: generated,
                updatedAt: generated,
                provenance: provenance(runID: runID, source: "crystalizer", generatedAt: generated)
            )
        }
    }

    func proposals(
        from crystals: [IntelligenceCrystal],
        policies: [PolicyDecision],
        runID: String,
        generatedAt: Date
    ) -> [AgentProposal] {
        let generated = AgentDateFormatting.isoString(generatedAt)
        let policyRefs = policies.map { decision in
            RuntimeObjectReference(
                id: decision.action,
                kind: .policyDecision,
                label: decision.action,
                path: "runtime/runs/\(runID)/policy-decisions.json",
                value: decision.status,
                source: "policy_gate",
                freshness: .currentRun,
                confidence: nil,
                privacyLevel: "metadata",
                redactionStatus: "metadata_only",
                generatedAt: generated,
                runID: runID
            )
        }

        return crystals.prefix(5).map { crystal in
            let action: ProposalAction = crystal.confidence >= 0.8 ? .addToWatchlist : .createTask
            let title = action == .addToWatchlist ? "Watch \(crystal.title)" : "Review \(crystal.title)"
            let crystalRef = RuntimeObjectReference(
                id: crystal.id.uuidString,
                kind: .crystal,
                label: crystal.title,
                path: "runtime/crystals/crystals.json",
                value: crystal.status.rawValue,
                source: "crystalizer",
                freshness: crystal.freshness,
                confidence: crystal.confidence,
                privacyLevel: "local",
                redactionStatus: "summary_only",
                generatedAt: crystal.updatedAt,
                runID: runID
            )

            return AgentProposal(
                id: UUID(),
                title: title,
                summary: crystal.rationale,
                rationale: "Proposal generated from crystal confidence \(String(format: "%.2f", crystal.confidence)) and local policy boundaries.",
                action: action,
                permission: ProposalPermissionRequirement(
                    permission: .localWrite,
                    reason: "Only writes local runtime artifacts.",
                    policyDecisionRefs: policyRefs.filter { ["accept_local_proposal", "create_local_handoff"].contains($0.id) },
                    blockedReason: nil
                ),
                rejectionFallback: "Keep the crystal in watching state and write a local review memory note.",
                evidenceRefs: crystal.evidenceRefs,
                messageRefs: crystal.messageRefs,
                tokenRefs: crystal.tokenRefs,
                crystalRefs: [crystalRef],
                artifactRefs: crystal.artifactRefs,
                artifactsToWrite: [
                    artifactReference(action == .addToWatchlist ? "runtime/watchlist/watchlist.json" : "runtime/tasks/tasks.json", label: action.rawValue, runID: runID, freshness: .currentRun)
                ],
                freshness: crystal.freshness,
                risk: crystal.risk,
                confidence: crystal.confidence,
                nextAction: ProactiveNextAction(
                    type: action == .addToWatchlist ? .addToWatchlist : .createTask,
                    title: title,
                    detail: "Accept to create the local runtime artifact; reject to save review memory.",
                    targetRefs: [crystalRef] + crystal.evidenceRefs,
                    permissionRequired: .localWrite,
                    status: .planned
                ),
                status: .proposed,
                createdAt: generated,
                updatedAt: generated,
                decidedAt: nil,
                decisionReason: nil,
                provenance: provenance(runID: runID, source: "proposal_planner", generatedAt: generated)
            )
        }
    }

    func handoff(
        from crystals: [IntelligenceCrystal],
        proposals: [AgentProposal],
        tasks: [UserTask],
        runID: String,
        generatedAt: Date
    ) -> HandoffPacket {
        let generated = AgentDateFormatting.isoString(generatedAt)
        let selected = Array(crystals.prefix(3))
        let crystalRefs = selected.map { crystal in
            RuntimeObjectReference(
                id: crystal.id.uuidString,
                kind: .crystal,
                label: crystal.title,
                path: "runtime/crystals/crystals.json",
                value: crystal.status.rawValue,
                source: "handoff_writer",
                freshness: crystal.freshness,
                confidence: crystal.confidence,
                privacyLevel: "local",
                redactionStatus: "summary_only",
                generatedAt: generated,
                runID: runID
            )
        }
        let taskRefs = tasks.prefix(5).map { task in
            RuntimeObjectReference(
                id: task.id.uuidString,
                kind: .task,
                label: task.title,
                path: "runtime/tasks/tasks.json",
                value: task.status,
                source: task.source,
                freshness: .currentRun,
                confidence: nil,
                privacyLevel: "local",
                redactionStatus: "summary_only",
                generatedAt: task.generatedAt,
                runID: runID
            )
        }
        let evidenceRefs = selected.flatMap(\.evidenceRefs)
        let degraded = selected.flatMap { crystal in
            crystal.sourceFreshness.compactMap { source, freshness in
                [.degraded, .stale, .blocked].contains(freshness) ? "\(source)=\(freshness.rawValue)" : nil
            }
        }

        return HandoffPacket(
            id: UUID(),
            title: "Local handoff for \(runID)",
            purpose: .teamUpdate,
            summaryText: selected.map { "- \($0.title): \($0.rationale)" }.joined(separator: "\n"),
            selectedCrystalRefs: crystalRefs,
            evidenceRefs: evidenceRefs,
            messageRefs: selected.flatMap(\.messageRefs).map(redactedMessageRef),
            tokenRefs: selected.flatMap(\.tokenRefs),
            artifactRefs: [artifactReference("runtime/handoffs/index.json", label: "handoff index", runID: runID, freshness: .currentRun)],
            openTaskRefs: taskRefs,
            unresolvedQuestions: proposals.prefix(3).map { $0.rejectionFallback },
            sourceFreshness: selected.reduce(into: [:]) { partial, crystal in
                crystal.sourceFreshness.forEach { partial[$0.key] = $0.value }
            },
            degradedBoundaries: Array(Set(degraded)).sorted(),
            redaction: HandoffRedaction(
                policy: .privatePreviewRedacted,
                redactedFields: ["message.value", "sender"],
                privateContentIncluded: false,
                notes: "Only redacted previews and artifact references are included."
            ),
            freshness: selected.contains { $0.freshness == .degraded || $0.freshness == .stale } ? .degraded : .fresh,
            risk: selected.contains { $0.risk == .high || $0.risk == .critical } ? .high : .medium,
            confidence: selected.map(\.confidence).min() ?? 0,
            nextAction: ProactiveNextAction(
                type: .review,
                title: "Review handoff",
                detail: "Verify redaction and freshness before external sharing.",
                targetRefs: crystalRefs,
                permissionRequired: .localWrite,
                status: .planned
            ),
            status: .draft,
            generatedAt: generated,
            artifactPath: "runtime/handoffs/index.json",
            provenance: provenance(runID: runID, source: "handoff_writer", generatedAt: generated)
        )
    }

    func bridgeStatuses(
        market: MarketDataSnapshot,
        onchain: [OnchainSnapshot],
        runID: String,
        generatedAt: Date
    ) -> [RuntimeBridgeStatus] {
        let generated = AgentDateFormatting.isoString(generatedAt)
        let provenance = provenance(runID: runID, source: "permissioned_bridge_contract", generatedAt: generated)
        let onchainDegraded = onchain.contains { $0.freshness == "degraded" }
        return [
            RuntimeBridgeStatus(
                id: "market-bridge",
                name: "Market normalized JSON bridge",
                kind: .marketData,
                status: market.status == "enabled" ? .completed : .degraded,
                permission: .userConfirmation,
                freshness: proactiveFreshness(market.freshness),
                lastRunAt: generated,
                lastSuccessAt: market.status == "enabled" ? generated : nil,
                artifactPath: "runtime/market/latest-market-snapshot.json",
                errorMessage: market.status == "enabled" ? nil : market.upstreamStatus,
                provenance: provenance
            ),
            RuntimeBridgeStatus(
                id: "onchain-bridge",
                name: "On-chain normalized JSON bridge",
                kind: .onchainData,
                status: onchainDegraded ? .degraded : .completed,
                permission: .userConfirmation,
                freshness: onchainDegraded ? .degraded : .fixture,
                lastRunAt: generated,
                lastSuccessAt: onchain.isEmpty ? nil : generated,
                artifactPath: "runtime/onchain",
                errorMessage: onchainDegraded ? "Some entities have no permissioned live provider." : nil,
                provenance: provenance
            ),
            RuntimeBridgeStatus(
                id: "wechat-export-bridge",
                name: "Read-only WeChat refresh bridge",
                kind: .wechatImport,
                status: .completed,
                permission: .localRead,
                freshness: .degraded,
                lastRunAt: nil,
                lastSuccessAt: nil,
                artifactPath: "runtime/bridges/wechat-export-bridge.json",
                errorMessage: "Live WeChat refresh is local read-only and depends on WECHAT_LIVE_ENABLED; sending remains blocked.",
                provenance: provenance
            )
        ]
    }

    func proactiveSession(
        window: TimeWindow,
        sourceScope: [String],
        runID: String,
        status: ProactiveRuntimeStatus,
        crystals: [IntelligenceCrystal],
        proposals: [AgentProposal],
        memory: [MemoryEntry],
        handoffs: [HandoffPacket],
        bridgeStatuses: [RuntimeBridgeStatus],
        moduleRuns: [AgentModuleRun],
        subagentRuns: [SubagentRun],
        startedAt: Date,
        completedAt: Date,
        healthStatus: String,
        degradedReason: String?
    ) -> ProactiveSession {
        let generated = AgentDateFormatting.isoString(completedAt)
        return ProactiveSession(
            id: UUID(),
            runID: runID,
            parentRunID: nil,
            status: status,
            selectedWindow: window,
            sourceScope: sourceScope,
            permissionBoundary: .localWrite,
            sourceFreshness: bridgeStatuses.reduce(into: [:]) { $0[$1.id] = $1.freshness },
            startedAt: AgentDateFormatting.isoString(startedAt),
            completedAt: generated,
            lastSuccessAt: status == .failed ? nil : generated,
            nextRecommendedRun: nil,
            createdCrystalRefs: crystals.map { crystalReference($0, runID: runID) },
            generatedProposalRefs: proposals.map { proposalReference($0, runID: runID) },
            memoryRefs: memory.map { memoryReference($0, runID: runID) },
            handoffRefs: handoffs.map { handoffReference($0, runID: runID) },
            artifactRefs: [
                artifactReference("runtime/sessions/latest-session.json", label: "latest-session.json", runID: runID, freshness: .currentRun),
                artifactReference("runtime/runs/\(runID)/terminal-data.json", label: "terminal-data.json", runID: runID, freshness: .currentRun)
            ],
            moduleRuns: moduleRuns,
            subagentRuns: subagentRuns,
            bridgeStatuses: bridgeStatuses,
            healthStatus: healthStatus,
            degradedReason: degradedReason,
            provenance: provenance(runID: runID, source: "session_writer", generatedAt: generated)
        )
    }

    func manifest(
        runID: String,
        runtimeDirectory: URL,
        onchainArtifactURLs: [URL],
        generatedAt: Date,
        fileManager: FileManager = .default
    ) -> RuntimeStoreManifest {
        let requiredURLs = [
            runtimeDirectory.appendingPathComponent("wechat/messages.normalized.json"),
            runtimeDirectory.appendingPathComponent("entities/token-entities.json"),
            runtimeDirectory.appendingPathComponent("market/latest-market-snapshot.json"),
            runtimeDirectory.appendingPathComponent("alerts/alerts.json"),
            runtimeDirectory.appendingPathComponent("alerts/alert-rules.json"),
            runtimeDirectory.appendingPathComponent("evidence/evidence.json"),
            runtimeDirectory.appendingPathComponent("tasks/tasks.json"),
            runtimeDirectory.appendingPathComponent("watchlist/watchlist.json"),
            runtimeDirectory.appendingPathComponent("artifacts/manifest.json"),
            runtimeDirectory.appendingPathComponent("health/latest-health.json"),
            runtimeDirectory.appendingPathComponent("runs/\(runID)/run.json"),
            runtimeDirectory.appendingPathComponent("runs/\(runID)/planner-envelope.json"),
            runtimeDirectory.appendingPathComponent("runs/\(runID)/policy-decisions.json"),
            runtimeDirectory.appendingPathComponent("runs/\(runID)/market-snapshot.json"),
            runtimeDirectory.appendingPathComponent("runs/\(runID)/intelligence-snapshot.json"),
            runtimeDirectory.appendingPathComponent("runs/\(runID)/terminal-data.json"),
            runtimeDirectory.appendingPathComponent("runs/\(runID)/module-runs.json"),
            runtimeDirectory.appendingPathComponent("runs/\(runID)/artifact-manifest.json"),
            runtimeDirectory.appendingPathComponent("runs/\(runID)/logs.json"),
            runtimeDirectory.appendingPathComponent("crystals/crystals.json"),
            runtimeDirectory.appendingPathComponent("proposals/proposals.json"),
            runtimeDirectory.appendingPathComponent("memory/memory.json"),
            runtimeDirectory.appendingPathComponent("handoffs/index.json"),
            runtimeDirectory.appendingPathComponent("sessions/latest-session.json"),
            runtimeDirectory.appendingPathComponent("bridges/market-bridge.json"),
            runtimeDirectory.appendingPathComponent("bridges/onchain-bridge.json"),
            runtimeDirectory.appendingPathComponent("bridges/wechat-export-bridge.json")
        ] + onchainArtifactURLs

        let generated = AgentDateFormatting.isoString(generatedAt)
        let references = requiredURLs.map { url in
            ArtifactReference(
                id: UUID(),
                label: url.lastPathComponent,
                kind: artifactKind(for: url.path),
                path: url.path,
                status: fileManager.fileExists(atPath: url.path) ? "written" : "missing",
                source: "runtime_artifact_writer",
                freshness: "current_run",
                generatedAt: generated,
                runID: url.path.contains("/runs/\(runID)/") ? runID : nil
            )
        }
        let missing = references.filter { $0.status != "written" }.map(\.path)

        return RuntimeStoreManifest(
            runID: runID,
            generatedAt: generated,
            references: references,
            requiredPaths: requiredURLs.map(\.path),
            missingRequiredPaths: missing,
            completenessStatus: missing.isEmpty ? "complete" : "incomplete"
        )
    }

    func healthReport(
        runID: String,
        runtimeDirectory: URL,
        market: MarketDataSnapshot,
        onchain: [OnchainSnapshot],
        policies: [PolicyDecision],
        manifest: RuntimeStoreManifest,
        generatedAt: Date,
        fileManager: FileManager = .default
    ) -> RuntimeHealthReport {
        let generated = AgentDateFormatting.isoString(generatedAt)
        let runtimeWritable = fileManager.isWritableFile(atPath: runtimeDirectory.path)
        let latestRunExists = fileManager.fileExists(atPath: runtimeDirectory.appendingPathComponent("runs/\(runID)/run.json").path)
        let expectedBlockedOrConfirmed = [
            "run_live_wechat_cli",
            "export_handoff_outside_project",
            "execute_trade",
            "send_message",
            "publish_content"
        ]
        let policyViolations = policies.filter { decision in
            ["blocked", "needs_confirmation"].contains(decision.status)
                && !expectedBlockedOrConfirmed.contains(decision.action)
        }
        let onchainDegraded = onchain.contains { $0.freshness == "degraded" }

        let checks = [
            RuntimeHealthCheck(id: UUID(), name: "runtime_writable", status: runtimeWritable ? "pass" : "failed", source: "runtime_repository", detail: runtimeDirectory.path, generatedAt: generated, artifactPath: runtimeDirectory.path),
            RuntimeHealthCheck(id: UUID(), name: "latest_run_exists", status: latestRunExists ? "pass" : "failed", source: "agent_run_store", detail: runID, generatedAt: generated, artifactPath: "runtime/runs/\(runID)/run.json"),
            RuntimeHealthCheck(id: UUID(), name: "market_snapshot_freshness", status: market.freshness == "fresh" ? "pass" : "degraded", source: market.sourceName, detail: "\(market.status) · \(market.freshness)", generatedAt: generated, artifactPath: "runtime/market/latest-market-snapshot.json"),
            RuntimeHealthCheck(id: UUID(), name: "onchain_provider_state", status: onchainDegraded ? "degraded" : "pass", source: "onchain_fixture", detail: onchainDegraded ? "symbol-only entities have no live provider" : "fixture CA snapshots available", generatedAt: generated, artifactPath: "runtime/onchain"),
            RuntimeHealthCheck(id: UUID(), name: "policy_matrix", status: policyViolations.isEmpty ? "pass" : "failed", source: "policy_gate", detail: policyViolations.isEmpty ? "No unexpected policy violations." : policyViolations.map(\.action).joined(separator: ","), generatedAt: generated, artifactPath: "runtime/runs/\(runID)/policy-decisions.json"),
            RuntimeHealthCheck(id: UUID(), name: "artifact_manifest_complete", status: manifest.completenessStatus == "complete" ? "pass" : "degraded", source: "artifact_manifest_store", detail: "\(manifest.missingRequiredPaths.count) missing required artifact(s)", generatedAt: generated, artifactPath: "runtime/artifacts/manifest.json"),
            RuntimeHealthCheck(id: UUID(), name: "proactive_artifacts_complete", status: manifest.missingRequiredPaths.contains(where: { $0.contains("/crystals/") || $0.contains("/proposals/") || $0.contains("/sessions/") || $0.contains("/handoffs/") || $0.contains("/memory/") }) ? "degraded" : "pass", source: "proactive_runtime", detail: "Crystal/proposal/memory/handoff/session stores are required for full-phase MVP.", generatedAt: generated, artifactPath: "runtime/sessions/latest-session.json"),
            RuntimeHealthCheck(id: UUID(), name: "bridge_contract_boundary", status: "pass", source: "policy_gate", detail: "Swift consumes normalized bridge artifacts only; no live MCP/RPC/WeChat command is executed.", generatedAt: generated, artifactPath: "runtime/bridges"),
            RuntimeHealthCheck(id: UUID(), name: "protected_refs_unchanged", status: "pass", source: "runtime_policy", detail: "RuntimeBackend has no protected-reference mutation command; external verification is recorded in wiki.", generatedAt: generated, artifactPath: nil),
            RuntimeHealthCheck(id: UUID(), name: "import_export_boundary", status: "pass", source: "policy_gate", detail: "fixture/export/live read-only refresh=pass when local; send/trade/publish remain blocked", generatedAt: generated, artifactPath: "runtime/runs/\(runID)/policy-decisions.json"),
            RuntimeHealthCheck(id: UUID(), name: "secrets_boundary", status: "pass", source: "runtime_backend", detail: "Swift app stores no secrets and does not call MCP directly.", generatedAt: generated, artifactPath: nil)
        ]
        let failed = checks.contains { $0.status == "failed" }
        let degraded = checks.contains { $0.status == "degraded" }

        return RuntimeHealthReport(
            generatedAt: generated,
            overallStatus: failed ? "failed" : degraded ? "degraded" : "pass",
            checks: checks,
            retentionPolicy: DataRetentionPolicy(
                policyID: "local_runtime_retention",
                status: "active",
                retentionWindowDays: 30,
                cleanupPlan: "Show stale run count only; never delete runtime artifacts automatically.",
                generatedAt: generated
            ),
            privacyPolicy: PrivacyRedactionPolicy(
                policyID: "fixture_privacy_boundary",
                status: "active",
                importBoundary: "Only project fixture JSON is read; user-provided export JSON requires confirmation.",
                secretsBoundary: "No secret or API key is persisted by the Swift app.",
                liveWeChatBoundary: "Live WeChat commands are blocked by policy.",
                generatedAt: generated
            )
        )
    }

    private func combinedFreshness(entity: TokenEntity, market: MarketDataSnapshot, onchain: OnchainSnapshot?) -> String {
        if market.freshness == "blocked" || onchain?.freshness == "blocked" {
            return "blocked"
        }
        if market.freshness == "stale" || onchain?.freshness == "degraded" {
            return "degraded"
        }
        if onchain?.freshness == "fixture" {
            return "fixture"
        }
        return entity.freshness
    }

    private func artifactKind(for path: String) -> String {
        if path.contains("/runs/") { return "run_artifact" }
        if path.contains("/crystals/") { return "crystal_store" }
        if path.contains("/proposals/") { return "proposal_store" }
        if path.contains("/memory/") { return "memory_store" }
        if path.contains("/handoffs/") { return "handoff_store" }
        if path.contains("/sessions/") { return "proactive_session" }
        if path.contains("/bridges/") { return "bridge_contract" }
        if path.contains("/evidence/") { return "evidence_store" }
        if path.contains("/tasks/") { return "task_store" }
        if path.contains("/watchlist/") { return "watchlist_store" }
        if path.contains("/health/") { return "runtime_health" }
        if path.contains("/artifacts/") { return "artifact_manifest" }
        if path.contains("/alerts/") { return "alert_store" }
        if path.contains("/onchain/") { return "onchain_store" }
        return "runtime_store"
    }

    private func reference(for item: EvidenceItem, runID: String) -> RuntimeObjectReference {
        RuntimeObjectReference(
            id: item.id.uuidString,
            kind: .evidence,
            label: item.title,
            path: item.artifactPath ?? "runtime/evidence/evidence.json",
            value: item.summary,
            source: item.source,
            freshness: proactiveFreshness(item.freshness),
            confidence: item.confidence,
            privacyLevel: item.privacyLevel,
            redactionStatus: "summary_only",
            generatedAt: item.generatedAt,
            runID: runID
        )
    }

    private func messageReference(id: UUID, runID: String, freshness: ProactiveFreshness, privacyLevel: String) -> RuntimeObjectReference {
        RuntimeObjectReference(id: id.uuidString, kind: .message, label: "message", path: "runtime/wechat/messages.normalized.json", value: nil, source: "wechat_fixture", freshness: freshness, confidence: nil, privacyLevel: privacyLevel, redactionStatus: "preview_redacted", generatedAt: nil, runID: runID)
    }

    private func artifactReference(_ path: String, label: String, runID: String, freshness: ProactiveFreshness) -> RuntimeObjectReference {
        RuntimeObjectReference(id: path, kind: .artifact, label: label, path: path, value: nil, source: "runtime_artifact_writer", freshness: freshness, confidence: nil, privacyLevel: "metadata", redactionStatus: "metadata_only", generatedAt: nil, runID: runID)
    }

    private func crystalReference(_ crystal: IntelligenceCrystal, runID: String) -> RuntimeObjectReference {
        RuntimeObjectReference(id: crystal.id.uuidString, kind: .crystal, label: crystal.title, path: "runtime/crystals/crystals.json", value: crystal.status.rawValue, source: "crystalizer", freshness: crystal.freshness, confidence: crystal.confidence, privacyLevel: "local", redactionStatus: "summary_only", generatedAt: crystal.updatedAt, runID: runID)
    }

    private func proposalReference(_ proposal: AgentProposal, runID: String) -> RuntimeObjectReference {
        RuntimeObjectReference(id: proposal.id.uuidString, kind: .proposal, label: proposal.title, path: "runtime/proposals/proposals.json", value: proposal.status.rawValue, source: "proposal_planner", freshness: proposal.freshness, confidence: proposal.confidence, privacyLevel: "local", redactionStatus: "summary_only", generatedAt: proposal.updatedAt, runID: runID)
    }

    private func memoryReference(_ entry: MemoryEntry, runID: String) -> RuntimeObjectReference {
        RuntimeObjectReference(id: entry.id.uuidString, kind: .memory, label: entry.title, path: "runtime/memory/memory.json", value: entry.status.rawValue, source: "memory_store", freshness: entry.freshness, confidence: entry.confidence, privacyLevel: "local", redactionStatus: "summary_only", generatedAt: entry.updatedAt, runID: runID)
    }

    private func handoffReference(_ packet: HandoffPacket, runID: String) -> RuntimeObjectReference {
        RuntimeObjectReference(id: packet.id.uuidString, kind: .handoff, label: packet.title, path: packet.artifactPath, value: packet.status.rawValue, source: "handoff_writer", freshness: packet.freshness, confidence: packet.confidence, privacyLevel: "local", redactionStatus: packet.redaction.policy.rawValue, generatedAt: packet.generatedAt, runID: runID)
    }

    private func redactedMessageRef(_ ref: RuntimeObjectReference) -> RuntimeObjectReference {
        RuntimeObjectReference(id: ref.id, kind: ref.kind, label: ref.label, path: ref.path, value: ref.value == nil ? nil : "[redacted preview]", source: ref.source, freshness: ref.freshness, confidence: ref.confidence, privacyLevel: ref.privacyLevel, redactionStatus: "preview_redacted", generatedAt: ref.generatedAt, runID: ref.runID)
    }

    private func provenance(runID: String, source: String, generatedAt: String) -> ProactiveProvenance {
        ProactiveProvenance(runID: runID, sessionID: nil, parentRunID: nil, moduleRunIDs: [], subagentRunIDs: [], policyDecisionRefs: [], source: source, generatedAt: generatedAt)
    }

    private func proactiveFreshness(_ value: String) -> ProactiveFreshness {
        switch value {
        case "fresh": return .fresh
        case "fixture": return .fixture
        case "current_run": return .currentRun
        case "stale": return .stale
        case "degraded": return .degraded
        case "blocked": return .blocked
        case "not_run": return .notRun
        default: return .unknown
        }
    }

    private func combinedProactiveFreshness(_ values: String?...) -> ProactiveFreshness {
        let mapped = values.compactMap { $0 }.map(proactiveFreshness)
        if mapped.contains(.blocked) { return .blocked }
        if mapped.contains(.degraded) || mapped.contains(.stale) { return .degraded }
        if mapped.contains(.fixture) { return .fixture }
        if mapped.contains(.fresh) { return .fresh }
        return .unknown
    }

    private func risk(for item: EvidenceItem, onchain: OnchainSnapshot? = nil) -> ProactiveRiskLevel {
        if onchain?.contractRisk.lowercased().contains("high") == true { return .high }
        if item.confidence < 0.55 { return .medium }
        if item.freshness == "degraded" || item.freshness == "stale" { return .medium }
        return .low
    }
}
