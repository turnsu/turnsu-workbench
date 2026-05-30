import Foundation
@testable import WeChatIntelligenceRadarApp

let agentRuntimeChecks: Void = {
    checkWeb3SignalServiceDetectsCoreTickers()
    checkPolicyGateBlocksLiveWechatAndRequiresExportConfirmation()
    try! checkFixtureFileAdapterLoadsSampleJSONAndContracts()
    try! checkCMCProviderUsesFreshStoreSnapshot()
    try! checkCMCProviderMarksExpiredStoreSnapshotStale()
    checkTimeWindowFilteringChangesSnapshotSizeAndArtifactsWrite()
    checkDefaultMonthWindowGeneratesThreeCrystals()
    try! checkTerminalDataStoresCloseTheTokenLoop()
    checkRuntimeBackendProactiveCommands()
    checkAgentWorkspaceV2AdapterBuildsThreadAndApprovalCards()
    checkAgentRunManifestAndV2EventDecode()
    checkAgentWorkspaceAdapterUsesControlContextSummaries()
}()

private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    precondition(condition(), message)
}

private func checkWeb3SignalServiceDetectsCoreTickers() {
    let batch = try! MockWeChatDataAdapter().loadBatch(selectedGroupID: nil, date: testDate("2026-05-24T00:00:00Z"))
    let symbols = Web3SignalService().detectedSymbols(in: batch.messages)

    require(symbols == ["BTC", "ETH", "SOL"], "Expected BTC/ETH/SOL detection")
}

private func checkPolicyGateBlocksLiveWechatAndRequiresExportConfirmation() {
    let gate = PolicyGate()

    require(gate.check(.runLiveWeChatCLI).status == "blocked", "run_live_wechat_cli must be blocked")
    require(gate.check(.readLiveWeChat).status == "blocked", "read_live_wechat must be blocked")
    require(gate.check(.readWeChatCLIExportFile).status == "needs_confirmation", "export file import must require confirmation")
    require(gate.check(.readFixtureFile).status == "pass", "fixture file read must pass")
}

private func checkAgentWorkspaceV2AdapterBuildsThreadAndApprovalCards() {
    let tokenRef = RuntimeObjectReference(
        id: "bitcoin:btc",
        kind: .token,
        label: "BTC",
        path: "runtime/entities/token-entities.json",
        value: "bitcoin:btc",
        source: "test",
        freshness: .fresh,
        confidence: 0.9,
        privacyLevel: "local",
        redactionStatus: "pointer_only",
        generatedAt: nil,
        runID: "run-test"
    )
    let blockedCall = AgentToolCallRecord(
        id: "tool-call-1",
        toolName: "computer_use.request",
        status: "needs_confirmation",
        permission: "needs_confirmation",
        inputSummary: "request computer use proposal",
        outputSummary: "requires user confirmation",
        artifactPath: "runtime/agent/runs/run-test/tool-calls.json",
        detailsArtifactPath: "runtime/agent/runs/run-test/tool-details/tool-call-1.json",
        redactionStatus: "redacted_summary_only",
        createdAt: "2026-05-27T00:00:00.000Z"
    )
    let message = AgentMessage(
        id: "message-1",
        role: "user",
        content: [AgentContentPart(type: "text", text: "Use the current context.")],
        attachments: nil,
        contextRefs: [tokenRef],
        runID: nil,
        createdAt: "2026-05-27T00:00:00.000Z"
    )
    let state = AgentWorkspaceStateAdapter.makeThreadState(
        session: nil,
        messages: [message],
        streamEvents: [],
        toolCalls: [blockedCall],
        longTasks: [],
        daemonStatus: .unavailable
    )

    require(state.selectedContext.first?.title == "BTC", "V2 adapter must expose selected context chips")
    require(state.availableTemplates.count >= 4, "V2 adapter must provide task templates")
    require(state.messages.flatMap(\.parts).contains { $0.kind == .approvalRequest }, "Needs-confirmation tools must render as approval cards")
    require(state.run.displayID == "未开始", "Missing run should be user-readable")
}

private func checkAgentRunManifestAndV2EventDecode() {
    let manifestJSON = """
    {
      "schemaVersion": "agent-run-manifest-v1",
      "runID": "run-test",
      "taskID": "task-test",
      "sessionID": "session-test",
      "status": "running",
      "currentStage": "context",
      "publicSurfaceOnly": true,
      "internalToolsExposed": false,
      "contextSummary": {
        "schemaVersion": "agent-context-plane-summary-v1",
        "runID": "run-test",
        "taskID": "task-test",
        "status": "pass",
        "sourceCount": 4,
        "chunkCount": 6,
        "selectedChunkCount": 6,
        "missingSourceCount": 0,
        "staleChunkCount": 0,
        "artifactPath": "runtime/agent/runs/run-test/context-bundle.json",
        "updatedAt": "2026-05-29T00:00:00.000Z"
      },
      "controlSummary": {
        "schemaVersion": "agent-control-plane-summary-v1",
        "runID": "run-test",
        "taskID": "task-test",
        "taskType": "token_onchain_review",
        "profileID": "sequential_research_mvp",
        "stage": "context",
        "toolIntentCount": 5,
        "policyDecisionCount": 5,
        "blockedPolicyCount": 0,
        "approvalDecisionCount": 0,
        "qaStatus": "pass",
        "modelReadinessStatus": "blocked_missing_provider_config",
        "artifactPath": "runtime/agent/runs/run-test/control-plane-manifest.json",
        "updatedAt": "2026-05-29T00:00:00.000Z"
      },
      "artifacts": [
        {"name": "run-manifest.json", "kind": "manifest", "stage": "run", "artifactPath": "runtime/agent/runs/run-test/run-manifest.json"}
      ],
      "redactionStatus": "summary_only",
      "updatedAt": "2026-05-29T00:00:00.000Z"
    }
    """.data(using: .utf8)!
    let eventJSON = """
    {
      "eventID": "evt-test",
      "timestamp": "2026-05-29T00:00:00.000Z",
      "type": "context_plane.bundle.created",
      "runID": "run-test",
      "taskID": "task-test",
      "stage": "context",
      "action": "context-plane",
      "actionIntent": "assemble_context",
      "riskLevel": "low",
      "artifactKind": "context_bundle",
      "contextSourceCount": 4,
      "contextChunkCount": 6,
      "status": "pass",
      "artifactPath": "runtime/agent/runs/run-test/context-bundle.json"
    }
    """.data(using: .utf8)!

    let manifest = try! JSONDecoder.agentArtifactDecoder().decode(AgentRunManifest.self, from: manifestJSON)
    let event = try! JSONDecoder.agentArtifactDecoder().decode(AgentStreamEvent.self, from: eventJSON)

    require(manifest.internalToolsExposed == false, "Run manifest must preserve hidden internal tool boundary")
    require(manifest.contextSummary?.sourceCount == 4, "Run manifest should decode context summary")
    require(event.stage == "context", "V2 stream event should decode stage")
    require(event.contextChunkCount == 6, "V2 stream event should decode context counts")
}

private func checkAgentWorkspaceAdapterUsesControlContextSummaries() {
    let context = AgentContextPlaneSummary(
        schemaVersion: "agent-context-plane-summary-v1",
        runID: "run-test",
        taskID: "task-test",
        status: "pass",
        sourceCount: 4,
        chunkCount: 6,
        selectedChunkCount: 6,
        missingSourceCount: 0,
        staleChunkCount: 0,
        artifactPath: "runtime/agent/runs/run-test/context-bundle.json",
        updatedAt: "2026-05-29T00:00:00.000Z"
    )
    let control = AgentControlPlaneSummary(
        schemaVersion: "agent-control-plane-summary-v1",
        runID: "run-test",
        taskID: "task-test",
        taskType: "token_onchain_review",
        profileID: "sequential_research_mvp",
        stage: "context",
        toolIntentCount: 5,
        policyDecisionCount: 5,
        blockedPolicyCount: 0,
        approvalDecisionCount: 0,
        qaStatus: "pass",
        modelReadinessStatus: "blocked_missing_provider_config",
        artifactPath: "runtime/agent/runs/run-test/control-plane-manifest.json",
        updatedAt: "2026-05-29T00:00:00.000Z"
    )
    let manifest = AgentRunManifest(
        schemaVersion: "agent-run-manifest-v1",
        runID: "run-test",
        taskID: "task-test",
        sessionID: "session-test",
        status: "running",
        currentStage: "context",
        publicSurfaceOnly: true,
        internalToolsExposed: false,
        selectedSkillIDs: ["wechat-onchain-intelligence"],
        selectedExtensionIDs: ["wechat-cli-export-bridge"],
        contextSummary: context,
        controlSummary: control,
        artifacts: [],
        redactionStatus: "summary_only",
        finalOutputPath: nil,
        toolCallCount: nil,
        updatedAt: "2026-05-29T00:00:00.000Z",
        completedAt: nil
    )
    let state = AgentWorkspaceStateAdapter.makeThreadState(
        session: nil,
        messages: [],
        streamEvents: [],
        toolCalls: [],
        runManifest: manifest,
        controlSummary: control,
        contextSummary: context,
        longTasks: [],
        daemonStatus: .unavailable
    )

    require(state.run.latestStep == "整理上下文", "Adapter should derive current stage from run manifest")
    require(state.run.latestDetail.contains("上下文 4 项 / 6 段"), "Adapter should expose lightweight context summary")
    require(state.controlSummary?.blockedPolicyCount == 0, "Adapter should preserve control summary for inspector")
}

private func checkFixtureFileAdapterLoadsSampleJSONAndContracts() throws {
    let batch = try WeChatFixtureFileAdapter().loadBatch(selectedGroupID: nil, date: testDate("2026-05-24T00:00:00Z"))

    require(batch.sourceMode == "fixture_file", "Fixture adapter must load messages.sample.json instead of hardcoded fallback")
    require(batch.messages.contains { $0.excerpt.contains("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") }, "Fixture file must include ETH CA sample")
    require(batch.messages.contains { $0.excerpt.contains("So11111111111111111111111111111111111111112") }, "Fixture file must include SOL CA sample")

    let resolver = TokenResolutionService()
    let normalized = resolver.normalize(messages: batch.messages, groups: batch.groups, sourceMode: batch.sourceMode)
    let entities = resolver.resolve(messages: normalized)
    let ethMessage = normalized.first { $0.extractedContracts.contains("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") }

    require(normalized.contains { $0.extractedContracts.contains("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") }, "ETH CA must be extracted from fixture text")
    require(normalized.contains { $0.extractedContracts.contains("So11111111111111111111111111111111111111112") }, "SOL CA must be extracted from fixture text")
    require(ethMessage?.extractedContracts.count == 1, "EVM CA extraction must not leak a nested base58 false positive")
    require(entities.contains { $0.tokenID == "ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" && $0.confidence >= 0.9 }, "ETH CA token entity must be resolved with high confidence")
    require(entities.contains { $0.tokenID == "solana:so11111111111111111111111111111111111111112" && $0.confidence >= 0.9 }, "SOL CA token entity must be resolved with high confidence")
}

private func checkCMCProviderUsesFreshStoreSnapshot() throws {
    let temp = temporaryDirectory()
    let store = MarketSnapshotStore(snapshotURL: temp.appendingPathComponent("market.json"))
    let now = testDate("2026-05-24T00:00:00Z")
    let snapshot = MarketDataSnapshot(
        status: "enabled",
        sourceName: "Test Market Store",
        generatedAt: AgentDateFormatting.isoString(now),
        expiresAt: AgentDateFormatting.isoString(testDate("2026-05-25T00:00:00Z")),
        freshness: "fresh",
        lastVerifiedAt: AgentDateFormatting.isoString(now),
        assets: [
            MarketAsset(
                symbol: "BTC",
                name: "Bitcoin",
                priceUSD: 1,
                percentChange24h: 2,
                volume24hUSD: 3,
                marketCapUSD: 4,
                source: "test",
                isLive: true
            )
        ],
        evidence: ["test snapshot"],
        upstreamStatus: "test_fresh"
    )
    try store.write(snapshot)

    let provider = CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: store))
    let market = provider.fetchMarketData(for: ["BTC"], date: now)

    require(market.sourceName == "Test Market Store", "CMC provider should prefer fresh store snapshot")
    require(market.freshness == "fresh", "Fresh store snapshot should stay fresh")
    require(market.assets.first?.priceUSD == 1, "Fresh store asset price should be preserved")
}

private func checkCMCProviderMarksExpiredStoreSnapshotStale() throws {
    let temp = temporaryDirectory()
    let store = MarketSnapshotStore(snapshotURL: temp.appendingPathComponent("market.json"))
    let now = testDate("2026-05-24T00:00:00Z")
    let snapshot = MarketDataSnapshot(
        status: "enabled",
        sourceName: "Expired Store",
        generatedAt: "2026-05-21T00:00:00.000Z",
        expiresAt: "2026-05-22T00:00:00.000Z",
        freshness: "fresh",
        lastVerifiedAt: "2026-05-21T00:00:00.000Z",
        assets: [],
        evidence: ["expired"],
        upstreamStatus: "expired"
    )
    try store.write(snapshot)

    let provider = CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: store))
    let market = provider.fetchMarketData(for: ["BTC"], date: now)

    require(market.status == "degraded", "Expired store snapshot should be degraded")
    require(market.freshness == "stale", "Expired store snapshot should be stale")
}

private func checkTimeWindowFilteringChangesSnapshotSizeAndArtifactsWrite() {
    let temp = temporaryDirectory()
    let pathResolver = RuntimePathResolver(root: temp)
    let runStore = AgentRunStore(runsDirectory: pathResolver.runsDirectory)
    let marketStore = MarketSnapshotStore(pathResolver: pathResolver)
    let provider = CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: marketStore))
    let orchestrator = AgentOrchestrator(
        adapter: MockWeChatDataAdapter(),
        cmcProvider: provider,
        runStore: runStore,
        normalizedWeChatStore: NormalizedWeChatStore(pathResolver: pathResolver),
        tokenEntityStore: TokenEntityStore(pathResolver: pathResolver),
        onchainSnapshotStore: OnchainSnapshotStore(pathResolver: pathResolver),
        alertStore: AlertStore(pathResolver: pathResolver),
        evidenceStore: EvidenceStore(pathResolver: pathResolver),
        taskStore: TaskStore(pathResolver: pathResolver),
        watchlistStore: WatchlistStore(pathResolver: pathResolver),
        alertRuleStore: AlertRuleStore(pathResolver: pathResolver),
        artifactManifestStore: ArtifactManifestStore(pathResolver: pathResolver),
        runtimeHealthStore: RuntimeHealthStore(pathResolver: pathResolver),
        crystalStore: CrystalStore(pathResolver: pathResolver),
        proposalStore: ProposalStore(pathResolver: pathResolver),
        memoryStore: MemoryStore(pathResolver: pathResolver),
        handoffStore: HandoffStore(pathResolver: pathResolver),
        proactiveSessionStore: ProactiveSessionStore(pathResolver: pathResolver),
        bridgeStatusStore: BridgeStatusStore(pathResolver: pathResolver),
        pathResolver: pathResolver,
        runIDProvider: { "test-run" }
    )
    let now = testDate("2026-05-24T00:00:00Z")

    let day = orchestrator.run(date: now, selectedGroupID: nil, window: .day)
    let month = orchestrator.run(date: now, selectedGroupID: nil, window: .month)

    require(day.snapshot.signals.count < month.snapshot.signals.count, "Month window should include more signals than day")
    require(month.syncState.runID == "test-run", "Run ID should be surfaced")
    require(month.envelope.taskType == "wechat_onchain_terminal_runtime_refresh", "Planner taskType must use runtime refresh")
    require(month.artifactStatus?.lastWrittenFile == "logs.json", "Run artifacts should write logs.json last")
    require(FileManager.default.fileExists(atPath: temp.appendingPathComponent("runtime/runs/test-run/run.json").path), "Run artifact must exist")
    require(FileManager.default.fileExists(atPath: temp.appendingPathComponent("runtime/runs/test-run/module-runs.json").path), "Module runs artifact must exist")
}

private func checkDefaultMonthWindowGeneratesThreeCrystals() {
    let temp = temporaryDirectory()
    let pathResolver = RuntimePathResolver(root: temp)
    let orchestrator = AgentOrchestrator(
        adapter: WeChatFixtureFileAdapter(),
        cmcProvider: CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: MarketSnapshotStore(pathResolver: pathResolver))),
        runStore: AgentRunStore(runsDirectory: pathResolver.runsDirectory),
        normalizedWeChatStore: NormalizedWeChatStore(pathResolver: pathResolver),
        tokenEntityStore: TokenEntityStore(pathResolver: pathResolver),
        onchainSnapshotStore: OnchainSnapshotStore(pathResolver: pathResolver),
        alertStore: AlertStore(pathResolver: pathResolver),
        evidenceStore: EvidenceStore(pathResolver: pathResolver),
        taskStore: TaskStore(pathResolver: pathResolver),
        watchlistStore: WatchlistStore(pathResolver: pathResolver),
        alertRuleStore: AlertRuleStore(pathResolver: pathResolver),
        artifactManifestStore: ArtifactManifestStore(pathResolver: pathResolver),
        runtimeHealthStore: RuntimeHealthStore(pathResolver: pathResolver),
        crystalStore: CrystalStore(pathResolver: pathResolver),
        proposalStore: ProposalStore(pathResolver: pathResolver),
        memoryStore: MemoryStore(pathResolver: pathResolver),
        handoffStore: HandoffStore(pathResolver: pathResolver),
        proactiveSessionStore: ProactiveSessionStore(pathResolver: pathResolver),
        bridgeStatusStore: BridgeStatusStore(pathResolver: pathResolver),
        pathResolver: pathResolver,
        runIDProvider: { "month-crystal-run" }
    )

    let result = orchestrator.run(date: testDate("2026-05-26T00:00:00Z"), selectedGroupID: nil, window: .month)

    require(result.terminalData.proactive.crystals.count >= 3, "Default month path should generate at least 3 crystals")
    require(Set(result.terminalData.proactive.crystals.map(\.title)).isSuperset(of: ["BTC fused signal", "ETH fused signal", "SOL fused signal"]), "Default month path should include BTC/ETH/SOL crystals")
    require(result.terminalData.moduleRuns.first { $0.moduleID == .crystal }?.status == .completed, "Crystal module should complete when 3 crystals are present")
}

private func checkTerminalDataStoresCloseTheTokenLoop() throws {
    let temp = temporaryDirectory()
    let pathResolver = RuntimePathResolver(root: temp)
    let marketStore = MarketSnapshotStore(pathResolver: pathResolver)
    let orchestrator = AgentOrchestrator(
        adapter: WeChatFixtureFileAdapter(),
        cmcProvider: CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: marketStore)),
        runStore: AgentRunStore(runsDirectory: pathResolver.runsDirectory),
        normalizedWeChatStore: NormalizedWeChatStore(pathResolver: pathResolver),
        tokenEntityStore: TokenEntityStore(pathResolver: pathResolver),
        onchainSnapshotStore: OnchainSnapshotStore(pathResolver: pathResolver),
        alertStore: AlertStore(pathResolver: pathResolver),
        evidenceStore: EvidenceStore(pathResolver: pathResolver),
        taskStore: TaskStore(pathResolver: pathResolver),
        watchlistStore: WatchlistStore(pathResolver: pathResolver),
        alertRuleStore: AlertRuleStore(pathResolver: pathResolver),
        artifactManifestStore: ArtifactManifestStore(pathResolver: pathResolver),
        runtimeHealthStore: RuntimeHealthStore(pathResolver: pathResolver),
        crystalStore: CrystalStore(pathResolver: pathResolver),
        proposalStore: ProposalStore(pathResolver: pathResolver),
        memoryStore: MemoryStore(pathResolver: pathResolver),
        handoffStore: HandoffStore(pathResolver: pathResolver),
        proactiveSessionStore: ProactiveSessionStore(pathResolver: pathResolver),
        bridgeStatusStore: BridgeStatusStore(pathResolver: pathResolver),
        pathResolver: pathResolver,
        runIDProvider: { "terminal-test-run" }
    )

    let result = orchestrator.run(date: testDate("2026-05-24T00:00:00Z"), selectedGroupID: nil, window: .year)
    let runtime = pathResolver.runtimeDirectory
    let runDirectory = runtime.appendingPathComponent("runs/terminal-test-run", isDirectory: true)

    require(result.snapshot.sourceMode == "fixture_file", "Terminal loop should use editable fixture JSON")
    require(result.terminalData.normalizedMessages.count >= 7, "Terminal loop should normalize fixture messages")
    require(result.terminalData.tokenEntities.contains { $0.tokenID == "ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, "Terminal loop should persist ETH CA entity")
    require(result.terminalData.tokenEntities.contains { $0.tokenID == "solana:so11111111111111111111111111111111111111112" }, "Terminal loop should persist SOL CA entity")
    require(result.terminalData.onchainSnapshots.contains { $0.contractAddress == "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" && $0.source == "fixture_onchain_snapshot" }, "On-chain snapshot should be generated for ETH CA")
    require(result.terminalData.evidenceItems.contains { $0.tokenIDs.contains("ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") }, "Evidence store should include ETH token evidence")
    require(result.terminalData.tasks.contains { $0.tokenID == "ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, "Task store should include ETH follow-up task")
    require(result.terminalData.alerts.contains { $0.tokenID == "ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, "Alert store should include ETH mention watch")
    require(result.terminalData.watchlistItems.contains { $0.tokenID == "ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, "Watchlist store should include ETH watchlist item")
    require(result.terminalData.alertRules.contains { $0.tokenID == "ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, "Alert rules should include ETH mention watch rule")
    require(result.terminalData.moduleRuns.contains { $0.moduleID == .evidence && !$0.producedArtifacts.isEmpty }, "Agent module pipeline should include evidence module")
    require(result.terminalData.moduleRuns.contains { $0.moduleID == .task && !$0.producedArtifacts.isEmpty }, "Agent module pipeline should include task module")
    require(result.terminalData.artifactManifest.completenessStatus == "complete", "Artifact manifest should be complete")
    require(!result.terminalData.runtimeHealth.checks.isEmpty, "Runtime health checks should be generated")
    require(result.terminalData.sourceHealth.contains { $0.source == "agent_module_manager" }, "Ops source health should include agent module manager")
    require(result.terminalData.proactive.crystals.count >= 3, "Full-phase runtime should generate at least 3 crystals")
    require(result.terminalData.proactive.crystals.allSatisfy { !$0.evidenceRefs.isEmpty && !$0.tokenRefs.isEmpty && !$0.nextAction.title.isEmpty }, "Each crystal should carry evidence, token refs, and next action")
    require(result.terminalData.proactive.proposals.count >= 3, "Full-phase runtime should generate proposals from crystals")
    require(result.terminalData.proactive.memory.count >= 3, "Full-phase runtime should write local memory seeds")
    require(result.terminalData.proactive.handoffs.count == 1, "Full-phase runtime should create a local handoff draft")
    require(result.terminalData.proactive.latestSession?.runID == "terminal-test-run", "Proactive session should preserve run provenance")
    require(result.terminalData.proactive.bridgeStatuses.map(\.id).sorted() == ["market-bridge", "onchain-bridge", "wechat-export-bridge"], "Bridge contracts should be represented")
    require(result.terminalData.proactive.handoffs.allSatisfy { !$0.redaction.privateContentIncluded }, "Handoff drafts must keep private content redacted")
    require(result.terminalData.moduleRuns.contains { $0.moduleID == .crystal && !$0.producedArtifacts.isEmpty }, "Agent module pipeline should include crystalizer module")
    require(result.terminalData.moduleRuns.contains { $0.moduleID == .proposal && !$0.producedArtifacts.isEmpty }, "Agent module pipeline should include proposal planner module")
    require(result.terminalData.moduleRuns.contains { $0.moduleID == .handoff && !$0.producedArtifacts.isEmpty }, "Agent module pipeline should include handoff writer module")
    require(result.terminalData.moduleRuns.contains { $0.moduleID == .session && !$0.producedArtifacts.isEmpty }, "Agent module pipeline should include session writer module")

    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("wechat/messages.normalized.json").path), "Normalized WeChat store must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("entities/token-entities.json").path), "Token entity store must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("onchain/Ethereum/0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.json").path), "ETH on-chain artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("alerts/alerts.json").path), "Alert artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("alerts/alert-rules.json").path), "Alert rules artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("evidence/evidence.json").path), "Evidence artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("tasks/tasks.json").path), "Task artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("watchlist/watchlist.json").path), "Watchlist artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("artifacts/manifest.json").path), "Artifact manifest must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("health/latest-health.json").path), "Runtime health artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("crystals/crystals.json").path), "Crystal artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("proposals/proposals.json").path), "Proposal artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("memory/memory.json").path), "Memory artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("handoffs/index.json").path), "Handoff index must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("sessions/latest-session.json").path), "Proactive session artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("bridges/market-bridge.json").path), "Market bridge contract artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("bridges/onchain-bridge.json").path), "On-chain bridge contract artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("bridges/wechat-export-bridge.json").path), "WeChat export bridge contract artifact must be written")
    require(FileManager.default.fileExists(atPath: runDirectory.appendingPathComponent("terminal-data.json").path), "Run terminal-data artifact must be written")
    require(FileManager.default.fileExists(atPath: runDirectory.appendingPathComponent("module-runs.json").path), "Run agent module timeline artifact must be written")
    require(FileManager.default.fileExists(atPath: runDirectory.appendingPathComponent("artifact-manifest.json").path), "Run artifact manifest must be written")

    let moduleData = try Data(contentsOf: runDirectory.appendingPathComponent("module-runs.json"))
    let moduleRuns = try JSONDecoder.agentArtifactDecoder().decode([AgentModuleRun].self, from: moduleData)
    require(moduleRuns.count >= 9, "All runtime agent capability modules should be represented")
    require(moduleRuns.allSatisfy { !$0.inputSummary.isEmpty && !$0.outputSummary.isEmpty }, "Agent module runs must record input and output summaries")
}

private func checkRuntimeBackendProactiveCommands() {
    let temp = temporaryDirectory()
    let pathResolver = RuntimePathResolver(root: temp)
    let orchestrator = AgentOrchestrator(
        adapter: WeChatFixtureFileAdapter(),
        cmcProvider: CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: MarketSnapshotStore(pathResolver: pathResolver))),
        runStore: AgentRunStore(runsDirectory: pathResolver.runsDirectory),
        normalizedWeChatStore: NormalizedWeChatStore(pathResolver: pathResolver),
        tokenEntityStore: TokenEntityStore(pathResolver: pathResolver),
        onchainSnapshotStore: OnchainSnapshotStore(pathResolver: pathResolver),
        alertStore: AlertStore(pathResolver: pathResolver),
        evidenceStore: EvidenceStore(pathResolver: pathResolver),
        taskStore: TaskStore(pathResolver: pathResolver),
        watchlistStore: WatchlistStore(pathResolver: pathResolver),
        alertRuleStore: AlertRuleStore(pathResolver: pathResolver),
        artifactManifestStore: ArtifactManifestStore(pathResolver: pathResolver),
        runtimeHealthStore: RuntimeHealthStore(pathResolver: pathResolver),
        crystalStore: CrystalStore(pathResolver: pathResolver),
        proposalStore: ProposalStore(pathResolver: pathResolver),
        memoryStore: MemoryStore(pathResolver: pathResolver),
        handoffStore: HandoffStore(pathResolver: pathResolver),
        proactiveSessionStore: ProactiveSessionStore(pathResolver: pathResolver),
        bridgeStatusStore: BridgeStatusStore(pathResolver: pathResolver),
        pathResolver: pathResolver,
        runIDProvider: { "backend-proactive-run" }
    )
    let repository = RuntimeRepository(
        orchestrator: orchestrator,
        taskStore: TaskStore(pathResolver: pathResolver),
        watchlistStore: WatchlistStore(pathResolver: pathResolver),
        alertStore: AlertStore(pathResolver: pathResolver),
        crystalStore: CrystalStore(pathResolver: pathResolver),
        proposalStore: ProposalStore(pathResolver: pathResolver),
        memoryStore: MemoryStore(pathResolver: pathResolver),
        handoffStore: HandoffStore(pathResolver: pathResolver)
    )
    var backend = RuntimeBackend(repository: repository)
    var state = backend.execute(.refreshRun(reason: "test", selectedGroupID: nil, window: .year, date: testDate("2026-05-24T00:00:00Z")))

    let crystalID = state.result.terminalData.proactive.crystals.first!.id
    state = backend.execute(.selectCrystal(crystalID))
    require(state.selection.selectedCrystalID == crystalID, "selectCrystal should update runtime selection")

    let proposalID = state.result.terminalData.proactive.proposals.first!.id
    state = backend.execute(.acceptProposal(proposalID))
    require(state.result.terminalData.proactive.proposals.first { $0.id == proposalID }?.status == .accepted, "acceptProposal should update local proposal status")
    let watchlistCount = state.result.terminalData.watchlistItems.count
    state = backend.execute(.acceptProposal(proposalID))
    require(state.result.terminalData.watchlistItems.count == watchlistCount, "acceptProposal should be idempotent")

    let secondProposalID = state.result.terminalData.proactive.proposals.dropFirst().first!.id
    state = backend.execute(.rejectProposal(secondProposalID, reason: "test reject"))
    require(state.result.terminalData.proactive.proposals.first { $0.id == secondProposalID }?.status == .rejected, "rejectProposal should update local proposal status")
    require(state.result.terminalData.proactive.memory.contains { $0.content == "test reject" }, "rejectProposal should write review memory")

    let memoryID = state.result.terminalData.proactive.memory.first!.id
    state = backend.execute(.purgeMemory(memoryID))
    require(!state.result.terminalData.proactive.memory.contains { $0.id == memoryID }, "purgeMemory should remove memory from runtime query state")

    state = backend.execute(.createHandoff(crystalIDs: [crystalID]))
    let handoffID = state.result.terminalData.proactive.handoffs.first!.id
    require(state.result.terminalData.proactive.handoffs.contains { $0.selectedCrystalRefs.contains { $0.id == crystalID.uuidString } }, "createHandoff should write selected crystal handoff")

    state = backend.execute(.archiveHandoff(handoffID))
    require(state.result.terminalData.proactive.handoffs.first { $0.id == handoffID }?.status == .archived, "archiveHandoff should mark the selected handoff archived")

    state = backend.execute(.purgeArchivedHandoffs)
    require(!state.result.terminalData.proactive.handoffs.contains { $0.id == handoffID }, "purgeArchivedHandoffs should remove archived handoffs from runtime state")
}

private func testDate(_ value: String) -> Date {
    ISO8601DateFormatter().date(from: value)!
}

private func temporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("wechat-radar-tests-\(UUID().uuidString)", isDirectory: true)
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
