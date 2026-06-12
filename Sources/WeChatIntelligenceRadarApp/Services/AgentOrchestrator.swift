import Foundation

struct AgentRunResult: Hashable {
    let snapshot: IntelligenceSnapshot
    let logs: [AgentRunLog]
    let capabilities: [Capability]
    let policies: [PolicyDecision]
    let envelope: PlannerEnvelope
    let syncState: AgentSyncState
    let artifactStatus: AgentRunArtifactStatus?
    let terminalData: TerminalDataSnapshot
}

struct AgentOrchestrator {
    private let adapter: any WeChatDataAdapter
    private let cmcProvider: any Web3DataAdapter
    private let mockMarketProvider: any Web3DataAdapter
    private let web3SignalService: Web3SignalService
    private let briefingAgent: BriefingAgent
    private let policyGate: PolicyGate
    private let capabilityRegistry: CapabilityRegistry
    private let runStore: AgentRunStore
    private let normalizedWeChatStore: NormalizedWeChatStore
    private let tokenEntityStore: TokenEntityStore
    private let onchainSnapshotStore: OnchainSnapshotStore
    private let alertStore: AlertStore
    private let evidenceStore: EvidenceStore
    private let taskStore: TaskStore
    private let watchlistStore: WatchlistStore
    private let alertRuleStore: AlertRuleStore
    private let artifactManifestStore: ArtifactManifestStore
    private let runtimeHealthStore: RuntimeHealthStore
    private let crystalStore: CrystalStore
    private let proposalStore: ProposalStore
    private let memoryStore: MemoryStore
    private let handoffStore: HandoffStore
    private let proactiveSessionStore: ProactiveSessionStore
    private let bridgeStatusStore: BridgeStatusStore
    private let tokenResolver: TokenResolutionService
    private let onchainService: OnchainSnapshotService
    private let alertService: AlertGenerationService
    private let subagentManager: SubagentManager
    private let productBuilder: RuntimeProductBuilder
    private let pathResolver: RuntimePathResolver
    private let runIDProvider: () -> String

    init(
        adapter: any WeChatDataAdapter,
        cmcProvider: any Web3DataAdapter = CMCMarketDataProvider(),
        mockMarketProvider: any Web3DataAdapter = MockWeb3MarketDataAdapter(),
        web3SignalService: Web3SignalService = Web3SignalService(),
        briefingAgent: BriefingAgent = BriefingAgent(),
        policyGate: PolicyGate = PolicyGate(),
        capabilityRegistry: CapabilityRegistry = CapabilityRegistry(),
        runStore: AgentRunStore = AgentRunStore(),
        normalizedWeChatStore: NormalizedWeChatStore = NormalizedWeChatStore(),
        tokenEntityStore: TokenEntityStore = TokenEntityStore(),
        onchainSnapshotStore: OnchainSnapshotStore = OnchainSnapshotStore(),
        alertStore: AlertStore = AlertStore(),
        evidenceStore: EvidenceStore = EvidenceStore(),
        taskStore: TaskStore = TaskStore(),
        watchlistStore: WatchlistStore = WatchlistStore(),
        alertRuleStore: AlertRuleStore = AlertRuleStore(),
        artifactManifestStore: ArtifactManifestStore = ArtifactManifestStore(),
        runtimeHealthStore: RuntimeHealthStore = RuntimeHealthStore(),
        crystalStore: CrystalStore = CrystalStore(),
        proposalStore: ProposalStore = ProposalStore(),
        memoryStore: MemoryStore = MemoryStore(),
        handoffStore: HandoffStore = HandoffStore(),
        proactiveSessionStore: ProactiveSessionStore = ProactiveSessionStore(),
        bridgeStatusStore: BridgeStatusStore = BridgeStatusStore(),
        tokenResolver: TokenResolutionService = TokenResolutionService(),
        onchainService: OnchainSnapshotService = OnchainSnapshotService(),
        alertService: AlertGenerationService = AlertGenerationService(),
        subagentManager: SubagentManager = SubagentManager(),
        productBuilder: RuntimeProductBuilder = RuntimeProductBuilder(),
        pathResolver: RuntimePathResolver = RuntimePathResolver(),
        runIDProvider: @escaping () -> String = { "run-\(UUID().uuidString.lowercased())" }
    ) {
        self.adapter = adapter
        self.cmcProvider = cmcProvider
        self.mockMarketProvider = mockMarketProvider
        self.web3SignalService = web3SignalService
        self.briefingAgent = briefingAgent
        self.policyGate = policyGate
        self.capabilityRegistry = capabilityRegistry
        self.runStore = runStore
        self.normalizedWeChatStore = normalizedWeChatStore
        self.tokenEntityStore = tokenEntityStore
        self.onchainSnapshotStore = onchainSnapshotStore
        self.alertStore = alertStore
        self.evidenceStore = evidenceStore
        self.taskStore = taskStore
        self.watchlistStore = watchlistStore
        self.alertRuleStore = alertRuleStore
        self.artifactManifestStore = artifactManifestStore
        self.runtimeHealthStore = runtimeHealthStore
        self.crystalStore = crystalStore
        self.proposalStore = proposalStore
        self.memoryStore = memoryStore
        self.handoffStore = handoffStore
        self.proactiveSessionStore = proactiveSessionStore
        self.bridgeStatusStore = bridgeStatusStore
        self.tokenResolver = tokenResolver
        self.onchainService = onchainService
        self.alertService = alertService
        self.subagentManager = subagentManager
        self.productBuilder = productBuilder
        self.pathResolver = pathResolver
        self.runIDProvider = runIDProvider
    }

    func run(date: Date, selectedGroupID: UUID?, window: TimeWindow) -> AgentRunResult {
        let runID = runIDProvider()
        let startedAt = Date()
        let envelope = PlannerEnvelope(
            goal: "刷新本地优先 WeChat x On-chain Intelligence Terminal runtime",
            taskType: "wechat_onchain_terminal_runtime_refresh",
            capabilitiesNeeded: ["wechat-fixture-ingestion", "entity-resolver", "market-data", "onchain-fixture", "evidence-store", "alert-task-store", "briefing-agent", "policy-gate"],
            toolPlan: ["ingest_fixture_messages", "resolve_token_entities", "load_market_snapshot", "build_onchain_snapshots", "write_evidence", "write_alerts_and_tasks", "synthesize_briefing", "verify_runtime_health"],
            stopConditions: ["live_wechat_access_requested", "wechat_cli_live_command_requested", "cmc_skill_hub_degraded_or_stale", "runtime_artifact_write_failed", "protected_reference_project_write_detected"]
        )

        let policies = [
            policyGate.check(.readMockFixture),
            policyGate.check(.readFixtureFile),
            policyGate.check(.readWeChatCLIExportFile),
            policyGate.check(.runLiveWeChatCLI),
            policyGate.check(.readLiveWeChat),
            policyGate.check(.queryCMCMCP),
            policyGate.check(.useMockMarketFixture),
            policyGate.check(.enrichWeb3Signals),
            policyGate.check(.generateBriefing),
            policyGate.check(.acceptLocalProposal),
            policyGate.check(.rejectProposal),
            policyGate.check(.createLocalHandoff),
            policyGate.check(.exportHandoffOutsideProject),
            policyGate.check(.requestMarketBridgeRefresh),
            policyGate.check(.requestOnchainBridgeRefresh),
            policyGate.check(.executeTrade),
            policyGate.check(.sendMessage),
            policyGate.check(.publishContent)
        ]

        var logs: [AgentRunLog] = [
            makeLog(.planner, "Planner Envelope 已生成：\(envelope.taskType)。"),
            makeLog(.policy, "Live WeChat policy: read-only refresh \(policyStatus(.readLiveWeChat, in: policies))；raw CLI \(policyStatus(.runLiveWeChatCLI, in: policies))。"),
            makeLog(.policy, "CMC Skill Hub policy: \(policyStatus(.queryCMCMCP, in: policies))；市场数据进入 normalized snapshot。")
        ]

        do {
            let moduleRunner = AgentModuleRunner(runID: runID)
            var moduleRuns: [AgentModuleRun] = []

            let ingestionStarted = Date()
            let loadedBatch = try adapter.loadBatch(selectedGroupID: selectedGroupID, date: date)
            let range = window.range(endingAt: date)
            let filteredMessages = loadedBatch.messages.filter { range.contains($0.sentAt) }
            let batch = WeChatRawBatch(
                groups: loadedBatch.groups,
                messages: filteredMessages,
                sourceMode: loadedBatch.sourceMode,
                notes: loadedBatch.notes
            )
            let normalizedMessages = tokenResolver.normalize(messages: batch.messages, groups: batch.groups, sourceMode: batch.sourceMode)
            moduleRuns.append(moduleRunner.record(
                .ingestion,
                status: .completed,
                startedAt: ingestionStarted,
                inputSummary: "\(loadedBatch.messages.count) source message(s), window=\(window.rawValue)",
                outputSummary: "\(normalizedMessages.count) normalized message(s)",
                producedArtifacts: ["runtime/wechat/messages.normalized.json"]
            ))

            let entityStarted = Date()
            let tokenEntities = tokenResolver.resolve(messages: normalizedMessages)
            moduleRuns.append(moduleRunner.record(
                .entityResolver,
                status: tokenEntities.isEmpty ? .degraded : .completed,
                startedAt: entityStarted,
                inputSummary: "\(normalizedMessages.count) normalized message(s)",
                outputSummary: "\(tokenEntities.count) token entity/entities",
                producedArtifacts: ["runtime/entities/token-entities.json"],
                degradedReason: tokenEntities.isEmpty ? "no token entity detected" : nil
            ))

            let marketStarted = Date()
            let symbols = web3SignalService.detectedSymbols(in: batch.messages)
            let requestedSymbols = symbols.isEmpty ? ["BTC", "ETH", "SOL"] : symbols
            let cmcMarket = cmcProvider.fetchMarketData(for: requestedSymbols, date: date)
            let fallbackMarket = mockMarketProvider.fetchMarketData(for: requestedSymbols, date: date)
            let web3 = web3SignalService.enrich(messages: batch.messages, cmcMarket: cmcMarket, fallbackMarket: fallbackMarket)
            moduleRuns.append(moduleRunner.record(
                .marketData,
                status: cmcMarket.status == "enabled" ? .completed : .degraded,
                startedAt: marketStarted,
                inputSummary: requestedSymbols.joined(separator: ","),
                outputSummary: "market status \(cmcMarket.status), freshness \(cmcMarket.freshness)",
                producedArtifacts: ["runtime/market/latest-market-snapshot.json"],
                degradedReason: cmcMarket.status == "enabled" ? nil : cmcMarket.upstreamStatus
            ))

            let onchainStarted = Date()
            let onchainSnapshots = onchainService.snapshots(for: tokenEntities, generatedAt: Date())
            let onchainDegraded = onchainSnapshots.contains { $0.freshness == "degraded" }
            moduleRuns.append(moduleRunner.record(
                .onchain,
                status: onchainDegraded ? .degraded : .completed,
                startedAt: onchainStarted,
                inputSummary: "\(tokenEntities.count) token entity/entities",
                outputSummary: "\(onchainSnapshots.count) on-chain snapshot(s)",
                producedArtifacts: ["runtime/onchain"],
                degradedReason: onchainDegraded ? "some entities missing CA/provider" : nil
            ))

            let evidenceStarted = Date()
            let evidenceItems = productBuilder.evidence(
                messages: normalizedMessages,
                entities: tokenEntities,
                market: cmcMarket,
                onchain: onchainSnapshots,
                runID: runID,
                generatedAt: Date()
            )
            moduleRuns.append(moduleRunner.record(
                .evidence,
                status: evidenceItems.isEmpty ? .degraded : .completed,
                startedAt: evidenceStarted,
                inputSummary: "\(tokenEntities.count) token entity/entities",
                outputSummary: "\(evidenceItems.count) evidence item(s)",
                producedArtifacts: ["runtime/evidence/evidence.json"],
                evidenceIDs: evidenceItems.map(\.id),
                degradedReason: evidenceItems.isEmpty ? "no evidence generated" : nil
            ))

            let memoryStarted = Date()
            let memoryEntries = productBuilder.memorySeeds(
                from: evidenceItems,
                existing: memoryStore.read(),
                runID: runID,
                generatedAt: Date()
            )
            moduleRuns.append(moduleRunner.record(
                .memory,
                status: memoryEntries.isEmpty ? .degraded : .completed,
                startedAt: memoryStarted,
                inputSummary: "\(evidenceItems.count) evidence item(s)",
                outputSummary: "\(memoryEntries.count) memory entry/entries available",
                producedArtifacts: ["runtime/memory/memory.json"],
                evidenceIDs: evidenceItems.map(\.id),
                degradedReason: memoryEntries.isEmpty ? "no memory generated" : nil
            ))

            let crystalStarted = Date()
            let crystals = productBuilder.crystals(
                messages: normalizedMessages,
                entities: tokenEntities,
                market: cmcMarket,
                onchain: onchainSnapshots,
                evidence: evidenceItems,
                memory: memoryEntries,
                runID: runID,
                generatedAt: Date()
            )
            moduleRuns.append(moduleRunner.record(
                .crystal,
                status: crystals.count >= 3 ? .completed : .degraded,
                startedAt: crystalStarted,
                inputSummary: "\(evidenceItems.count) evidence item(s), \(memoryEntries.count) memory entry/entries",
                outputSummary: "\(crystals.count) intelligence crystal(s)",
                producedArtifacts: ["runtime/crystals/crystals.json"],
                evidenceIDs: evidenceItems.map(\.id),
                degradedReason: crystals.count >= 3 ? nil : "fewer than 3 crystals generated"
            ))

            let proposalStarted = Date()
            let proposals = productBuilder.proposals(
                from: crystals,
                policies: policies,
                runID: runID,
                generatedAt: Date()
            )
            moduleRuns.append(moduleRunner.record(
                .proposal,
                status: proposals.isEmpty ? .degraded : .completed,
                startedAt: proposalStarted,
                inputSummary: "\(crystals.count) crystal(s)",
                outputSummary: "\(proposals.count) proposal(s)",
                producedArtifacts: ["runtime/proposals/proposals.json"],
                evidenceIDs: evidenceItems.map(\.id),
                degradedReason: proposals.isEmpty ? "no proposal generated" : nil
            ))

            let alertStarted = Date()
            let alerts = alertService.alerts(for: tokenEntities, messages: normalizedMessages, generatedAt: Date())
            let alertRules = productBuilder.alertRules(from: tokenEntities, generatedAt: Date())
            moduleRuns.append(moduleRunner.record(
                .alert,
                status: alerts.isEmpty ? .degraded : .completed,
                startedAt: alertStarted,
                inputSummary: "\(evidenceItems.count) evidence item(s)",
                outputSummary: "\(alerts.count) alert(s), \(alertRules.count) rule(s)",
                producedArtifacts: ["runtime/alerts/alerts.json", "runtime/alerts/alert-rules.json"],
                evidenceIDs: evidenceItems.map(\.id),
                degradedReason: alerts.isEmpty ? "no alert candidate generated" : nil
            ))

            let taskStarted = Date()
            let tasks = productBuilder.tasks(from: evidenceItems, generatedAt: Date())
            let watchlistItems = productBuilder.watchlist(from: tokenEntities, generatedAt: Date())
            moduleRuns.append(moduleRunner.record(
                .task,
                status: tasks.isEmpty ? .degraded : .completed,
                startedAt: taskStarted,
                inputSummary: "\(evidenceItems.count) evidence item(s)",
                outputSummary: "\(tasks.count) task(s), \(watchlistItems.count) watchlist item(s)",
                producedArtifacts: ["runtime/tasks/tasks.json", "runtime/watchlist/watchlist.json"],
                evidenceIDs: evidenceItems.map(\.id),
                degradedReason: tasks.isEmpty ? "no task generated" : nil
            ))

            let handoffStarted = Date()
            let handoffs = [
                productBuilder.handoff(
                    from: crystals,
                    proposals: proposals,
                    tasks: tasks,
                    runID: runID,
                    generatedAt: Date()
                )
            ]
            moduleRuns.append(moduleRunner.record(
                .handoff,
                status: handoffs.first?.selectedCrystalRefs.isEmpty == false ? .completed : .degraded,
                startedAt: handoffStarted,
                inputSummary: "\(crystals.count) crystal(s), \(tasks.count) task(s)",
                outputSummary: "handoff draft(s)=\(handoffs.count)",
                producedArtifacts: ["runtime/handoffs/index.json"],
                evidenceIDs: evidenceItems.map(\.id),
                degradedReason: handoffs.first?.selectedCrystalRefs.isEmpty == false ? nil : "no selected crystal for handoff"
            ))

            let briefingStarted = Date()
            let snapshot = briefingAgent.synthesize(batch: batch, web3: web3, date: date, window: window)
            moduleRuns.append(moduleRunner.record(
                .briefing,
                status: .completed,
                startedAt: briefingStarted,
                inputSummary: "\(snapshot.signals.count) signal(s)",
                outputSummary: "brief generated",
                producedArtifacts: ["runtime/runs/\(runID)/intelligence-snapshot.json"],
                evidenceIDs: evidenceItems.map(\.id)
            ))

            let capabilities = capabilityRegistry.capabilities(cmcStatus: cmcMarket.status, web3Status: web3.status)
            moduleRuns.append(moduleRunner.record(
                .qaPolicy,
                status: .completed,
                startedAt: Date(),
                inputSummary: "\(policies.count) policy decision(s), \(capabilities.count) capability/capabilities",
                outputSummary: "policy and capability boundaries checked",
                producedArtifacts: ["runtime/runs/\(runID)/policy-decisions.json"]
            ))

            let bridgeStatuses = productBuilder.bridgeStatuses(
                market: cmcMarket,
                onchain: onchainSnapshots,
                runID: runID,
                generatedAt: Date()
            )

            moduleRuns.append(moduleRunner.record(
                .session,
                status: .completed,
                startedAt: Date(),
                inputSummary: "\(crystals.count) crystal(s), \(proposals.count) proposal(s), \(bridgeStatuses.count) bridge contract(s)",
                outputSummary: "proactive session prepared",
                producedArtifacts: ["runtime/sessions/latest-session.json", "runtime/bridges"]
            ))

            var sourceHealth = [
                SourceHealth(source: "wechat_fixture", status: "enabled", freshness: batch.sourceMode.contains("degraded") ? "degraded" : "fresh", lastSuccessfulRefresh: AgentDateFormatting.isoString(Date()), artifactPath: "Sources/WeChatIntelligenceRadarApp/Fixtures/wechat/messages.sample.json", degradedReason: batch.sourceMode.contains("degraded") ? "fixture_file_fallback" : nil),
                SourceHealth(source: cmcMarket.sourceName, status: cmcMarket.status, freshness: cmcMarket.freshness, lastSuccessfulRefresh: cmcMarket.lastVerifiedAt, artifactPath: "runtime/market/latest-market-snapshot.json", degradedReason: cmcMarket.status == "enabled" ? nil : cmcMarket.upstreamStatus),
                SourceHealth(source: "onchain_fixture", status: onchainSnapshots.contains(where: { $0.freshness == "degraded" }) ? "degraded" : "enabled", freshness: onchainSnapshots.contains(where: { $0.freshness == "degraded" }) ? "degraded" : "fixture", lastSuccessfulRefresh: AgentDateFormatting.isoString(Date()), artifactPath: "runtime/onchain", degradedReason: onchainSnapshots.contains(where: { $0.freshness == "degraded" }) ? "some_entities_missing_contract_or_provider" : nil)
            ]
            let subagentRuns = compatibilitySubagentRuns(from: moduleRuns)
            sourceHealth.append(SourceHealth(source: "agent_module_manager", status: moduleRuns.contains(where: { $0.status == .failed }) ? "failed" : "enabled", freshness: "current_run", lastSuccessfulRefresh: AgentDateFormatting.isoString(Date()), artifactPath: "runtime/runs/\(runID)/module-runs.json", degradedReason: moduleRuns.first(where: { $0.status == .failed || $0.status == .degraded })?.degradedReason))

            let preliminarySession = productBuilder.proactiveSession(
                window: window,
                sourceScope: selectedGroupID.map { [$0.uuidString] } ?? ["all_groups"],
                runID: runID,
                status: .running,
                crystals: crystals,
                proposals: proposals,
                memory: memoryEntries,
                handoffs: handoffs,
                bridgeStatuses: bridgeStatuses,
                moduleRuns: moduleRuns,
                subagentRuns: subagentRuns,
                startedAt: startedAt,
                completedAt: Date(),
                healthStatus: "pending",
                degradedReason: nil
            )
            let preliminaryProactive = ProactiveRuntimeData(
                status: .running,
                generatedAt: AgentDateFormatting.isoString(Date()),
                freshness: .currentRun,
                risk: crystals.contains { $0.risk == .high || $0.risk == .critical } ? .high : .medium,
                confidence: crystals.map(\.confidence).min() ?? 0,
                nextAction: crystals.first?.nextAction,
                crystals: crystals,
                proposals: proposals,
                memory: memoryEntries,
                handoffs: handoffs,
                latestSession: preliminarySession,
                bridgeStatuses: bridgeStatuses
            )

            var preliminaryTerminalData = TerminalDataSnapshot(
                normalizedMessages: normalizedMessages,
                tokenEntities: tokenEntities,
                marketSnapshots: [cmcMarket],
                onchainSnapshots: onchainSnapshots,
                evidenceItems: evidenceItems,
                tasks: tasks,
                alerts: alerts,
                watchlistItems: watchlistItems,
                alertRules: alertRules,
                artifactManifest: .empty,
                runtimeHealth: .empty,
                moduleRuns: moduleRuns,
                subagentRuns: subagentRuns,
                sourceHealth: sourceHealth,
                proactive: preliminaryProactive
            )

            var storeArtifacts: [String] = []
            if let url = try? normalizedWeChatStore.write(normalizedMessages) { storeArtifacts.append(url.path) }
            if let url = try? tokenEntityStore.write(tokenEntities) { storeArtifacts.append(url.path) }
            let onchainArtifactURLs = (try? onchainSnapshotStore.write(onchainSnapshots)) ?? []
            storeArtifacts.append(contentsOf: onchainArtifactURLs.map(\.path))
            if let url = try? alertStore.write(alerts) { storeArtifacts.append(url.path) }
            if let url = try? alertRuleStore.write(alertRules) { storeArtifacts.append(url.path) }
            if let url = try? evidenceStore.write(evidenceItems) { storeArtifacts.append(url.path) }
            if let url = try? taskStore.write(tasks) { storeArtifacts.append(url.path) }
            if let url = try? watchlistStore.write(watchlistItems) { storeArtifacts.append(url.path) }
            if let url = try? crystalStore.write(crystals) { storeArtifacts.append(url.path) }
            if let url = try? proposalStore.write(proposals) { storeArtifacts.append(url.path) }
            if let url = try? memoryStore.write(memoryEntries) { storeArtifacts.append(url.path) }
            if let urls = try? handoffStore.write(handoffs) { storeArtifacts.append(contentsOf: urls.map(\.path)) }
            if let url = try? proactiveSessionStore.write(preliminarySession) { storeArtifacts.append(url.path) }
            if let urls = try? bridgeStatusStore.write(bridgeStatuses) { storeArtifacts.append(contentsOf: urls.map(\.path)) }
            _ = try? artifactManifestStore.write(.empty)
            _ = try? runtimeHealthStore.write(.empty)

            logs.append(makeLog(.info, "读取 \(loadedBatch.messages.count) 条 fixture 消息，window=\(window.rawValue)，range=\(AgentDateFormatting.displayString(range.start))...\(AgentDateFormatting.displayString(range.end))，过滤后 \(batch.messages.count) 条。"))
            logs.append(makeLog(.info, "Token entities: \(tokenEntities.map(\.symbol).joined(separator: ","))；runtime stores=\(storeArtifacts.count)。"))
            logs.append(makeLog(.info, "Evidence=\(evidenceItems.count)，tasks=\(tasks.count)，watchlist=\(watchlistItems.count)，alertRules=\(alertRules.count)。"))
            logs.append(makeLog(.info, "Crystals=\(crystals.count)，proposals=\(proposals.count)，memory=\(memoryEntries.count)，handoffs=\(handoffs.count)。"))
            logs.append(makeLog(.info, "Web3 detected symbols: \(requestedSymbols.joined(separator: ","))；marketSource=\(web3.market.sourceName)，status=\(web3.status)。"))
            logs.append(makeLog(.warning, "CMC evidence: \(cmcMarket.evidence.first ?? "no evidence")"))
            logs.append(makeLog(.info, "已生成 \(snapshot.signals.count) 条重点信号、\(snapshot.actions.count) 个可行动项。"))
            let completedAt = Date()
            var status: AgentSyncStatus = cmcMarket.status == "enabled" && cmcMarket.freshness == "fresh" ? .completed : .degraded
            var artifactStatus: AgentRunArtifactStatus?

            do {
                artifactStatus = try runStore.writeRun(
                    runID: runID,
                    startedAt: startedAt,
                    completedAt: completedAt,
                    envelope: envelope,
                    policies: policies,
                    marketSnapshot: cmcMarket,
                    intelligenceSnapshot: snapshot,
                    logs: logs,
                    syncStatus: status,
                    terminalData: preliminaryTerminalData
                )
            } catch {
                artifactStatus = .failed(runID: runID, error: error)
                logs.insert(makeLog(.warning, "Run artifact write failed: \(error)"), at: 0)
            }

            let manifest = productBuilder.manifest(
                runID: runID,
                runtimeDirectory: pathResolver.runtimeDirectory,
                onchainArtifactURLs: onchainArtifactURLs,
                generatedAt: Date()
            )
            let health = productBuilder.healthReport(
                runID: runID,
                runtimeDirectory: pathResolver.runtimeDirectory,
                market: cmcMarket,
                onchain: onchainSnapshots,
                policies: policies,
                manifest: manifest,
                generatedAt: Date()
            )
            _ = try? artifactManifestStore.write(manifest)
            _ = try? runtimeHealthStore.write(health)
            if health.overallStatus == "failed" {
                status = .failed
            } else if health.overallStatus == "degraded" || moduleRuns.contains(where: { $0.status == .degraded }) {
                status = .degraded
            }

            let finalSession = productBuilder.proactiveSession(
                window: window,
                sourceScope: selectedGroupID.map { [$0.uuidString] } ?? ["all_groups"],
                runID: runID,
                status: status == .failed ? .failed : status == .degraded ? .degraded : .completed,
                crystals: crystals,
                proposals: proposals,
                memory: memoryEntries,
                handoffs: handoffs,
                bridgeStatuses: bridgeStatuses,
                moduleRuns: moduleRuns,
                subagentRuns: subagentRuns,
                startedAt: startedAt,
                completedAt: Date(),
                healthStatus: health.overallStatus,
                degradedReason: health.checks.first(where: { $0.status == "degraded" || $0.status == "failed" })?.detail
            )
            _ = try? proactiveSessionStore.write(finalSession)
            let proactive = ProactiveRuntimeData(
                status: status == .failed ? .failed : status == .degraded ? .degraded : .completed,
                generatedAt: AgentDateFormatting.isoString(Date()),
                freshness: health.overallStatus == "pass" ? .fresh : .degraded,
                risk: crystals.contains { $0.risk == .high || $0.risk == .critical } ? .high : .medium,
                confidence: crystals.map(\.confidence).min() ?? 0,
                nextAction: crystals.first?.nextAction,
                crystals: crystals,
                proposals: proposals,
                memory: memoryEntries,
                handoffs: handoffs,
                latestSession: finalSession,
                bridgeStatuses: bridgeStatuses
            )

            let terminalData = TerminalDataSnapshot(
                normalizedMessages: normalizedMessages,
                tokenEntities: tokenEntities,
                marketSnapshots: [cmcMarket],
                onchainSnapshots: onchainSnapshots,
                evidenceItems: evidenceItems,
                tasks: tasks,
                alerts: alerts,
                watchlistItems: watchlistItems,
                alertRules: alertRules,
                artifactManifest: manifest,
                runtimeHealth: health,
                moduleRuns: moduleRuns,
                subagentRuns: subagentRuns,
                sourceHealth: sourceHealth,
                proactive: proactive
            )
            preliminaryTerminalData = terminalData

            do {
                artifactStatus = try runStore.writeRun(
                    runID: runID,
                    startedAt: startedAt,
                    completedAt: completedAt,
                    envelope: envelope,
                    policies: policies,
                    marketSnapshot: cmcMarket,
                    intelligenceSnapshot: snapshot,
                    logs: logs,
                    syncStatus: status,
                    terminalData: preliminaryTerminalData
                )
                logs.insert(makeLog(.info, "Run artifact written: \(artifactStatus?.lastWrittenFile ?? "--") @ \(artifactStatus?.runDirectory ?? "--")"), at: 0)
            } catch {
                artifactStatus = .failed(runID: runID, error: error)
                logs.insert(makeLog(.warning, "Final run artifact write failed: \(error)"), at: 0)
            }

            let syncState = AgentSyncState(
                status: artifactStatus?.errorMessage == nil ? status : .degraded,
                runID: runID,
                lastRunAt: AgentDateFormatting.isoString(completedAt),
                lastSuccessAt: status == .failed ? nil : AgentDateFormatting.isoString(completedAt),
                sourceFreshness: health.overallStatus == "pass" ? cmcMarket.freshness : health.overallStatus,
                errorMessage: artifactStatus?.errorMessage,
                artifactPath: artifactStatus?.runDirectory
            )

            return AgentRunResult(
                snapshot: snapshot,
                logs: logs,
                capabilities: capabilities,
                policies: policies,
                envelope: envelope,
                syncState: syncState,
                artifactStatus: artifactStatus,
                terminalData: preliminaryTerminalData
            )
        } catch {
            logs.append(makeLog(.warning, "Agent run failed: \(error.localizedDescription)"))
            let failedAt = Date()
            let syncState = AgentSyncState(
                status: .failed,
                runID: runID,
                lastRunAt: AgentDateFormatting.isoString(failedAt),
                lastSuccessAt: nil,
                sourceFreshness: "failed",
                errorMessage: error.localizedDescription,
                artifactPath: nil
            )
            return AgentRunResult(
                snapshot: .empty,
                logs: logs,
                capabilities: capabilityRegistry.capabilities(cmcStatus: "blocked", web3Status: "not_run"),
                policies: policies,
                envelope: envelope,
                syncState: syncState,
                artifactStatus: nil,
                terminalData: .empty
            )
        }
    }

    private func makeLog(_ level: LogLevel, _ message: String) -> AgentRunLog {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return AgentRunLog(level: level, message: message, timestamp: formatter.string(from: Date()))
    }

    private func compatibilitySubagentRuns(from modules: [AgentModuleRun]) -> [SubagentRun] {
        modules.map { module in
            SubagentRun(
                runID: "\(module.runID)-\(module.moduleID.rawValue)",
                parentRunID: module.runID,
                agentType: subagentType(for: module.moduleID),
                taskScope: module.inputSummary,
                status: subagentStatus(for: module.status),
                startedAt: module.startedAt,
                completedAt: module.completedAt,
                inputSummary: module.inputSummary,
                outputSummary: module.outputSummary,
                artifact: module.producedArtifacts.first ?? "--",
                error: module.error ?? module.degradedReason
            )
        }
    }

    private func subagentType(for moduleID: AgentModuleID) -> SubagentType {
        switch moduleID {
        case .ingestion:
            return .ingestion
        case .entityResolver:
            return .entityResolver
        case .marketData:
            return .marketData
        case .onchain:
            return .onchain
        case .memory:
            return .memory
        case .crystal:
            return .crystal
        case .evidence:
            return .evidence
        case .proposal:
            return .proposal
        case .handoff:
            return .handoff
        case .session:
            return .session
        case .alert:
            return .alert
        case .task:
            return .task
        case .briefing:
            return .briefing
        case .qaPolicy:
            return .qaPolicy
        case .review:
            return .review
        }
    }

    private func subagentStatus(for status: AgentModuleStatus) -> SubagentStatus {
        switch status {
        case .planned:
            return .planned
        case .running:
            return .running
        case .completed:
            return .completed
        case .degraded:
            return .degraded
        case .failed:
            return .failed
        case .skipped:
            return .skipped
        }
    }

    private func policyStatus(_ action: AgentAction, in policies: [PolicyDecision]) -> String {
        policies.first(where: { $0.action == action.rawValue })?.status ?? "unknown"
    }

    private func completedAtCandidate() -> Date {
        Date()
    }
}
