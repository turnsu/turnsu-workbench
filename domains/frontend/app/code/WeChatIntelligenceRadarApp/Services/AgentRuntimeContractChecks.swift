import Foundation

enum AgentRuntimeContractChecks {
    @MainActor
    static func run() throws {
        try checkPolicyBoundary()
        try checkCMCProviderRequiresBackendSnapshot()
        try checkFixtureMarketSnapshotIsNotPromoted()
        try checkDaemonAuthTokenLoading()
        try checkLoopOpsSkillBindingsDecodeAndRoundTrip()
        try checkLoopOpsMarketplaceInstallCreatesWorkspaceCopy()
        try checkLoopOpsPromptIncludesOrderedSkillPath()
        try checkLoopOpsBuilderPatchReceiptExplainsContractChanges()
        try checkLoopOpsStudioDraftClearsPathAndMigratesBuilderChat()
        try checkLoopContractDraftInfersUnstructuredChineseInstruction()
        try checkLoopContractDraftInfersUnstructuredEnglishInstruction()
        try checkLoopOpsRunLaunchRequestsStayContractScoped()
        try checkLoopOpsRunSubmissionReportsPendingUntilDaemonAck()
        try checkLoopOpsWorkbenchSelectionResolverPrefersNewAck()
        try checkLoopOpsReconcileRunResultsFromPersistedLedgers()
        try checkLoopOpsLocalStorePersistsRunLedgerAndShareSafeLog()
        try checkLoopOpsPublicSkillPolicyHidesInternalPackages()
        try checkLoopOpsToolDraftsBecomeSkillOSPackages()
        try checkLoopOpsSkillOSUseAndBuildWritesStructuredLogs()
        try checkLoopOpsSkillOSRunContextAndPublicCopy()
        try checkLoopOpsKnowledgeToolModelsAndStoreRoundTrip()
        try checkLoopOpsKnowledgeRowsHideInternalTerms()
        try checkLoopOpsVisibleCopyHidesInternalTerms()
        try checkLoopOpsInteractionIDsCoverAcceptanceAnchors()
        _ = try LoopOpsAcceptanceHarness.run()
        _ = try LoopOpsAcceptanceHarness.runUIActionChecks()
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw ContractCheckError(message) }
    }

    private static func requireValue<T>(_ value: T?, _ message: String) throws -> T {
        guard let value else { throw ContractCheckError(message) }
        return value
    }

    private static func checkPolicyBoundary() throws {
        let gate = PolicyGate()
        try require(gate.check(.runLiveWeChatCLI).status == "blocked", "run_live_wechat_cli must remain blocked")
        try require(gate.check(.readLiveWeChat).status == "pass", "read_live_wechat read-only refresh should pass")
        try require(gate.check(.readWeChatCLIExportFile).status == "pass", "wechat export import should pass within local boundary")
        try require(gate.check(.requestMarketBridgeRefresh).status == "pass", "CMC bridge refresh should pass")
        try require(gate.check(.queryCMCMCP).status == "pass", "CMC normalized query policy should pass")
    }

    private static func checkCMCProviderRequiresBackendSnapshot() throws {
        let temp = try temporaryDirectory()
        let store = MarketSnapshotStore(pathResolver: RuntimePathResolver(root: temp))
        let market = CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: store))
            .fetchMarketData(for: ["BTC"], date: contractDate)
        try require(market.status != "enabled", "Swift CMC provider must not synthesize enabled live data")
        try require(market.assets.isEmpty, "Swift CMC provider should wait for backend normalized market artifacts")
    }

    private static func checkFixtureMarketSnapshotIsNotPromoted() throws {
        let temp = try temporaryDirectory()
        let store = MarketSnapshotStore(snapshotURL: temp.appendingPathComponent("market.json"))
        let snapshot = MarketDataSnapshot(
            status: "enabled",
            sourceName: "Fixture Store",
            provider: "fixtureProvider",
            generatedAt: AgentDateFormatting.isoString(contractDate),
            observedAt: AgentDateFormatting.isoString(contractDate),
            expiresAt: AgentDateFormatting.isoString(contractDate.addingTimeInterval(3600)),
            freshness: "fixture",
            lastVerifiedAt: AgentDateFormatting.isoString(contractDate),
            assets: [
                MarketAsset(
                    symbol: "BTC",
                    name: "Bitcoin",
                    priceUSD: 1,
                    percentChange24h: 0,
                    volume24hUSD: 0,
                    marketCapUSD: 0,
                    source: "fixture",
                    isLive: false
                )
            ],
            evidence: ["fixture"],
            upstreamStatus: "fixture"
        )
        try store.write(snapshot)
        let loaded = try requireSnapshot(store.load(now: contractDate))
        try require(loaded.status == "degraded", "fixture market snapshot must be degraded")
        try require(loaded.freshness == "fixture", "fixture market snapshot must not become fresh")
        try require(loaded.assets.allSatisfy { !$0.isLive }, "fixture market assets must not become live")
    }

    private static func checkDaemonAuthTokenLoading() throws {
        let temp = try temporaryDirectory()
        let authDir = temp.appendingPathComponent("runtime/agent", isDirectory: true)
        try FileManager.default.createDirectory(at: authDir, withIntermediateDirectories: true)
        let authURL = authDir.appendingPathComponent("auth-token.json")
        let payload = #"{"schemaVersion":"agent-daemon-auth-token-v1","token":"contract-token"}"#
        try payload.data(using: .utf8)?.write(to: authURL)
        try require(AgentDaemonAuth.loadToken(pathResolver: RuntimePathResolver(root: temp)) == "contract-token", "daemon auth token must load from runtime/agent/auth-token.json")
    }

    private static func checkLoopOpsSkillBindingsDecodeAndRoundTrip() throws {
        let legacyJSON = """
        {
          "id": "legacy-loop",
          "name": "Legacy Loop",
          "domain": "Crypto",
          "goal": "Legacy market scan",
          "trigger": "Manual",
          "inputBindings": ["Current workspace context"],
          "capabilityChain": ["CoinMarketCap market radar", "Market regime review"],
          "stepSummary": ["Scan", "Review"],
          "feedbackGate": "Human review.",
          "exitCondition": "Final answer.",
          "reviewBoundary": "review-only",
          "outputShape": "Summary",
          "runMode": "manual",
          "version": 1,
          "owner": "tester",
          "visibility": "private",
          "prompt": "Run legacy loop.",
          "defaultSkillIDs": ["cmc-market-radar", "market-regime-review"],
          "defaultExtensionIDs": ["cmc-skill-hub"],
          "createdAt": "2026-06-22T00:00:00.000Z",
          "updatedAt": "2026-06-22T00:00:00.000Z"
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder.agentArtifactDecoder().decode(LoopContract.self, from: legacyJSON)
        try require(decoded.skillBindings.count == 3, "legacy contracts should synthesize ordered skill bindings")
        try require(decoded.orderedSkillIDs == ["cmc-market-radar", "market-regime-review"], "ordered skill ids should come from synthesized bindings")
        try require(decoded.orderedExtensionIDs == ["cmc-skill-hub"], "ordered extension ids should come from synthesized bindings")

        let stableDate = ISO8601DateFormatter().date(from: "2026-06-22T00:00:00Z")!
        let stack = LoopOpsSkillStack(
            id: "stack-test",
            name: "Test Stack",
            summary: "A reusable stack.",
            bindings: decoded.skillBindings,
            createdAt: stableDate,
            updatedAt: stableDate
        )
        let stackData = try JSONEncoder.agentArtifactEncoder().encode(stack)
        let roundTripped = try JSONDecoder.agentArtifactDecoder().decode(LoopOpsSkillStack.self, from: stackData)
        try require(roundTripped == stack, "skill stack should round-trip through JSON")

        let extensionOnly = decoded.replacingSkillBindings([
            LoopOpsSkillBinding(kind: .extensionPackage, id: "cmc-skill-hub", title: "CMC Skill Hub capability", order: 0, source: "contract-check")
        ])
        try require(extensionOnly.orderedSkillIDs.isEmpty, "explicit extension-only path should not revive legacy skill ids")
        try require(extensionOnly.orderedExtensionIDs == ["cmc-skill-hub"], "explicit extension-only path should keep package id")

        let disabledPath = decoded.replacingSkillBindings([
            LoopOpsSkillBinding(
                kind: .skill,
                id: "cmc-market-radar",
                title: "CoinMarketCap market radar",
                order: 0,
                enabled: false,
                source: "contract-check"
            ),
            LoopOpsSkillBinding(
                kind: .extensionPackage,
                id: "cmc-skill-hub",
                title: "CMC Skill Hub capability",
                order: 1,
                source: "contract-check"
            )
        ])
        try require(disabledPath.orderedSkillIDs.isEmpty, "disabled skill bindings should not be selected for runs")
        try require(disabledPath.orderedExtensionIDs == ["cmc-skill-hub"], "enabled extension bindings should remain selected for runs")

        let emptyPath = decoded.replacingSkillBindings([])
        try require(!emptyPath.isRunnable, "contracts with no enabled skill path should not be runnable")
        try require(
            emptyPath.setupChecklistItems.contains { $0.localizedCaseInsensitiveContains("Skill Path") },
            "setup checklist should explain missing Skill Path"
        )
        try require(
            emptyPath.setupChecklistItems.allSatisfy { !$0.localizedCaseInsensitiveContains("feedback gate") },
            "setup checklist should not expose feedback-gate terminology"
        )
    }

    @MainActor
    private static func checkLoopOpsMarketplaceInstallCreatesWorkspaceCopy() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let seededStore = LoopOpsLocalStore(
            rootURL: root.appendingPathComponent("seeded", isDirectory: true),
            seedTemplates: true
        )
        let template = try requireCryptoTemplate(id: "crypto-market-report-loop")
        let marketplaceTemplate = LoopContract.from(template: template, now: contractDate)
        try require(seededStore.loopContracts.isEmpty, "first-run store should not persist marketplace starter loops as saved loops")
        try require(
            seededStore.allContractsForDisplay.contains { $0.id == marketplaceTemplate.id },
            "first-run store should still display starter loops as marketplace templates"
        )
        let firstRunListing = LoopOpsTemplateListing.from(
            contract: marketplaceTemplate,
            savedIDs: Set(seededStore.loopContracts.map(\.id)),
            workspaceCopyIDsByTemplateID: seededStore.installedWorkspaceCopyIDsByTemplateID
        )
        try require(firstRunListing.isInstallable, "first-run marketplace listing should be installable")
        try require(firstRunListing.source == .starter, "first-run marketplace listing should stay marked as Starter")

        let installRoot = root.appendingPathComponent("install", isDirectory: true)
        let store = LoopOpsLocalStore(
            rootURL: installRoot,
            seedTemplates: false
        )

        let beforeListing = LoopOpsTemplateListing.from(
            contract: marketplaceTemplate,
            savedIDs: [],
            workspaceCopyIDsByTemplateID: store.installedWorkspaceCopyIDsByTemplateID
        )
        try require(beforeListing.isInstallable, "marketplace template should be installable before a workspace copy exists")
        try require(beforeListing.installLabel == "Install to Studio", "marketplace template should advertise install action")
        try require(beforeListing.templateTypeLabel == "Template", "marketplace listing should expose a user-facing template type")
        try require(beforeListing.accessLabel == "Free", "marketplace listing should expose access state")
        try require(beforeListing.categoryLabel == marketplaceTemplate.domain.title, "marketplace listing should expose category")
        try require(!beforeListing.integrationLabels.isEmpty, "marketplace listing should expose integrations")
        try require(!beforeListing.requiredInputLabels.isEmpty, "marketplace listing should expose required inputs")
        try require(!beforeListing.requiredKnowledgeLabels.isEmpty, "marketplace listing should expose required knowledge")
        try require(!beforeListing.stepPreview.isEmpty, "marketplace listing should expose preview steps")
        try require(beforeListing.readinessChecklist.contains("Ready to run"), "ready marketplace listing should expose readable readiness detail")

        let copy = store.installTemplate(
            marketplaceTemplate,
            copyID: "workspace-\(marketplaceTemplate.id)-contract-check",
            now: contractDate
        )
        try require(copy.name == "\(marketplaceTemplate.name) Workspace Copy", "install should create an editable workspace copy")
        try require(copy.installedFromTemplateID == marketplaceTemplate.id, "workspace copy should keep source template id")
        try require(copy.workspaceCopyID == copy.id, "workspace copy should expose stable copy id")
        try require(store.installedWorkspaceCopyID(forTemplateID: marketplaceTemplate.id) == copy.id, "store should resolve installed copy from template id")

        let afterListing = LoopOpsTemplateListing.from(
            contract: marketplaceTemplate,
            savedIDs: [],
            workspaceCopyIDsByTemplateID: store.installedWorkspaceCopyIDsByTemplateID
        )
        try require(!afterListing.isInstallable, "marketplace template should stop showing install action after install")
        try require(afterListing.installLabel == "Installed", "marketplace template should show installed state")
        try require(afterListing.workspaceCopyID == copy.id, "marketplace listing should point to the installed workspace copy")
        try require(store.actionContract(for: afterListing).id == copy.id, "installed marketplace listing actions should resolve to the workspace copy")

        var draft = LoopContractDraft.from(contract: copy)
        draft.stepSummaryText += "\nConfirm workspace-specific inputs"
        let savedCopy = draft.materialize(existing: copy, now: contractDate.addingTimeInterval(60))
        try require(savedCopy.installedFromTemplateID == marketplaceTemplate.id, "Studio save should preserve installed source template id")
        try require(savedCopy.workspaceCopyID == copy.id, "Studio save should preserve workspace copy id")

        let strictCopy = savedCopy.strictLoopOpsContract(status: .saved)
        let restored = LoopContract.from(strictLoopOpsContract: strictCopy)
        try require(restored.installedFromTemplateID == marketplaceTemplate.id, "strict JSON bridge should preserve installed template source")

        let reloaded = LoopOpsLocalStore(rootURL: installRoot, seedTemplates: false)
        try require(reloaded.installedWorkspaceCopyID(forTemplateID: marketplaceTemplate.id) == copy.id, "workspace copy install should persist across store reload")
    }

    private static func checkLoopOpsPromptIncludesOrderedSkillPath() throws {
        let template = try requireCryptoTemplate(id: "crypto-market-report-loop")
        let contract = LoopContract.from(template: template)
        let prompt = contract.promptForRun(additionalInstruction: "Explain gaps.")

        try require(prompt.contains("Skill Path："), "run prompt should include ordered skill path")
        try require(prompt.contains("Inputs："), "run prompt should include input bindings")
        try require(
            prompt.contains("CoinMarketCap market radar -> Market regime review -> CMC Skill Hub capability"),
            "skill path should preserve user-facing order"
        )
        try require(prompt.contains("本轮追加指令：Explain gaps."), "prompt should include follow-up instruction")
    }

    private static func checkLoopOpsBuilderPatchReceiptExplainsContractChanges() throws {
        let patch = LoopOpsBuilderDraftPatch(
            instruction: """
            steps: Collect inputs; Draft review packet
            output shape: Final answer and evidence gaps
            Use CoinMarketCap market radar, CMC Skill Hub capability, then Market regime review.
            """,
            packages: builderTestPackages()
        )

        try require(patch.hasChanges, "Builder patch receipt fixture should produce changes")
        try require(patch.receiptStatus == "Structured patch staged", "Builder patch receipt should expose staged status")
        try require(patch.receiptText.contains("Steps replaced: 2"), "Builder patch receipt should summarize parsed steps")
        try require(patch.receiptText.contains("Skill path: CoinMarketCap market radar -> CMC Skill Hub capability -> Market regime review"), "Builder patch receipt should include ordered skill path")
        try require(patch.receiptText.contains("Output shape: Final answer and evidence gaps"), "Builder patch receipt should include output shape")
        try require(patch.receiptEvidence.contains("skill_path=3"), "Builder patch receipt evidence should include skill path count")

        let empty = LoopOpsBuilderDraftPatch(instruction: "", packages: builderTestPackages())
        try require(!empty.hasChanges, "empty Builder patch should not report changes")
        try require(empty.receiptStatus == "No structured fields matched", "empty Builder patch should guide user with no-match status")
        try require(empty.receiptText.contains("Try name:"), "empty Builder patch should explain usable labels")
    }

    @MainActor
    private static func checkLoopOpsStudioDraftClearsPathAndMigratesBuilderChat() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = LoopOpsLocalStore(rootURL: root, seedTemplates: false)
        let existing = LoopContract.from(template: try requireCryptoTemplate(id: "crypto-market-report-loop"))
        store.upsert(existing)

        var clearedDraft = LoopContractDraft.from(contract: existing)
        clearedDraft.skillBindings = []
        clearedDraft.capabilityChainText = ""
        let cleared = clearedDraft.materialize(existing: existing, now: contractDate)

        try require(cleared.skillBindings.isEmpty, "Studio-cleared skill path should stay empty")
        try require(cleared.defaultSkillIDs.isEmpty, "Studio-cleared skill path should not retain default skill ids")
        try require(cleared.defaultExtensionIDs.isEmpty, "Studio-cleared skill path should not retain default package ids")
        try require(cleared.orderedSkillIDs.isEmpty, "Studio-cleared skill path should not resurrect legacy skill ids")
        try require(cleared.orderedExtensionIDs.isEmpty, "Studio-cleared skill path should not resurrect legacy extension ids")
        try require(!cleared.isRunnable, "Studio-cleared skill path should force setup before Run Preview")
        try require(
            cleared.setupChecklistItems.contains { $0.localizedCaseInsensitiveContains("Skill Path") },
            "Studio-cleared skill path should explain the missing Skill Path"
        )
        store.upsert(cleared)
        try require(
            store.loopContracts.first(where: { $0.id == cleared.id })?.isRunnable == false,
            "Studio Save Draft should persist incomplete Loop pages"
        )
        let setupViewModel = DashboardViewModel()
        let setupReport = setupViewModel.runLoopContract(cleared, loopOpsStore: store)
        try require(setupReport.queuedCount == 0, "Run Preview should not queue incomplete saved drafts")
        try require(setupReport.setupRequiredContractIDs == [cleared.id], "Run Preview should route incomplete drafts to setup")
        try require(setupViewModel.selectedWorkspace == .studio, "incomplete draft run should focus Studio setup")

        let draftScopeID = "loop-draft-unsaved-contract-check"
        let savedScopeID = "loop-saved-contract-check"
        store.appendMessage(
            scope: .builder,
            scopeID: draftScopeID,
            title: "Unsaved Loop",
            role: .user,
            text: "Add CMC Skill Hub, then write a review checklist."
        )
        store.appendMessage(
            scope: .builder,
            scopeID: draftScopeID,
            title: "Unsaved Loop",
            role: .assistant,
            text: "Structured patch staged."
        )
        store.reassignBuilderThread(from: draftScopeID, to: savedScopeID, title: "Saved Loop")

        try require(store.existingThread(scope: .builder, scopeID: draftScopeID) == nil, "Builder Chat should leave the temporary draft scope after save")
        let migratedThread = try requireValue(
            store.existingThread(scope: .builder, scopeID: savedScopeID),
            "Builder Chat should migrate to the saved loop scope"
        )
        try require(migratedThread.title == "Saved Loop", "migrated Builder Chat should use the saved loop title")
        try require(migratedThread.messages.map(\.text) == ["Add CMC Skill Hub, then write a review checklist.", "Structured patch staged."], "migrated Builder Chat should keep its messages in order")
    }

    private static func checkLoopContractDraftInfersUnstructuredChineseInstruction() throws {
        var draft = LoopContractDraft(
            id: "draft-builder-zh-freeform-contract-check",
            name: "中文自由描述 Builder Loop",
            domain: .crypto,
            goal: "复核 crypto market report。",
            trigger: "Manual",
            inputBindingsText: "Current workspace context",
            capabilityChainText: "",
            skillBindings: [],
            stepSummaryText: "旧步骤",
            feedbackGate: "Review if evidence is unclear.",
            exitCondition: "Stop after draft.",
            reviewBoundary: "review-only",
            outputShape: "Short memo",
            prompt: "Build the loop."
        )

        let patch = draft.applyBuilderInstruction(
            """
            请把这个 loop 改成先用 CoinMarketCap market radar，然后用 CMC Skill Hub capability，再用 Market regime review，最后输出 review packet；如果证据不足就等待人工确认；完成条件是 review packet 没有开放证据缺口；输出为中文 final answer 和 evidence gap table。
            """,
            packages: builderTestPackages()
        )

        try require(patch.stepMode == .replace, "freeform Chinese sequencing should replace the visible step list")
        try require(
            lines(from: draft.stepSummaryText) == [
                "CoinMarketCap market radar",
                "CMC Skill Hub capability",
                "Market regime review",
                "输出 review packet"
            ],
            "freeform Chinese sequencing should infer visible steps without requiring field labels"
        )
        try require(
            draft.skillBindings.map(\.id) == ["cmc-market-radar", "cmc-skill-hub", "market-regime-review"],
            "freeform Chinese instruction should infer skill path order from package mentions"
        )
        try require(draft.feedbackGate == "如果证据不足就等待人工确认", "freeform Chinese instruction should infer feedback gate from conditional review wording")
        try require(draft.exitCondition == "review packet 没有开放证据缺口", "freeform Chinese instruction should infer exit condition from completion wording")
        try require(draft.outputShape == "中文 final answer 和 evidence gap table", "freeform Chinese instruction should infer output shape from output wording")

        let contract = draft.materialize()
        try require(
            contract.promptForRun().contains("Skill Path：CoinMarketCap market radar -> CMC Skill Hub capability -> Market regime review"),
            "freeform Chinese contract should carry inferred ordered skill path into the run prompt"
        )
    }

    private static func checkLoopContractDraftInfersUnstructuredEnglishInstruction() throws {
        var draft = LoopContractDraft(
            id: "draft-builder-en-freeform-contract-check",
            name: "English Freeform Builder Loop",
            domain: .crypto,
            goal: "Review crypto market report.",
            trigger: "Manual",
            inputBindingsText: "Current workspace context",
            capabilityChainText: "",
            skillBindings: [],
            stepSummaryText: "Old step",
            feedbackGate: "Review if evidence is unclear.",
            exitCondition: "Stop after draft.",
            reviewBoundary: "review-only",
            outputShape: "Short memo",
            prompt: "Build the loop."
        )

        let patch = draft.applyBuilderInstruction(
            """
            Please update this loop to first use CoinMarketCap market radar, then use CMC Skill Hub capability, then use Market regime review, finally output a review packet; if evidence is stale wait for analyst confirmation; stop when the review packet has no open evidence gaps; output as an English final answer and evidence gap table.
            """,
            packages: builderTestPackages()
        )

        try require(patch.stepMode == .replace, "freeform English sequencing should replace the visible step list")
        try require(
            lines(from: draft.stepSummaryText) == [
                "CoinMarketCap market radar",
                "CMC Skill Hub capability",
                "Market regime review",
                "output a review packet"
            ],
            "freeform English sequencing should infer visible steps without preserving sequencing filler"
        )
        try require(
            draft.skillBindings.map(\.id) == ["cmc-market-radar", "cmc-skill-hub", "market-regime-review"],
            "freeform English instruction should infer skill path order from package mentions"
        )
        try require(draft.feedbackGate == "if evidence is stale wait for analyst confirmation", "freeform English instruction should infer review rule from conditional wording")
        try require(draft.exitCondition == "the review packet has no open evidence gaps", "freeform English instruction should infer exit condition from stop wording")
        try require(draft.outputShape == "an English final answer and evidence gap table", "freeform English instruction should infer output shape from output-as wording")

        let contract = draft.materialize()
        try require(
            contract.promptForRun().contains("Skill Path：CoinMarketCap market radar -> CMC Skill Hub capability -> Market regime review"),
            "freeform English contract should carry inferred ordered skill path into the run prompt"
        )
    }

    private static func checkLoopOpsRunLaunchRequestsStayContractScoped() throws {
        let templates = WorkbenchLoopTemplate.templates(for: .crypto)
        try require(templates.count >= 4, "crypto loop templates should include market and trade review loops")
        let market = LoopContract.from(template: templates[0])
        let trade = LoopContract.from(template: templates[3]).replacingSkillBindings([
            LoopOpsSkillBinding(kind: .skill, id: "trade-plan-review", title: "Trade plan review", order: 0, source: "contract-check"),
            LoopOpsSkillBinding(kind: .extensionPackage, id: "cmc-skill-hub", title: "CMC Skill Hub capability", order: 1, source: "contract-check")
        ])

        let marketRequest = LoopOpsRunLaunchRequest(contract: market, launchID: "contract-check-market-launch-1")
        let marketRepeatRequest = LoopOpsRunLaunchRequest(contract: market, launchID: "contract-check-market-launch-2")
        let tradeRequest = LoopOpsRunLaunchRequest(
            contract: trade,
            additionalInstruction: "Only report review gaps.",
            launchID: "contract-check-trade-launch-1"
        )

        try require(marketRequest.contractID != tradeRequest.contractID, "batch launch requests should keep each contract id")
        try require(marketRepeatRequest.contractID == marketRequest.contractID, "repeat launch requests should keep their source contract id")
        try require(marketRequest.prompt.contains(market.name), "market request prompt should snapshot its contract name")
        try require(tradeRequest.prompt.contains(trade.name), "trade request prompt should snapshot its contract name")
        try require(tradeRequest.prompt.contains("本轮追加指令：Only report review gaps."), "launch request should carry follow-up instruction")
        try require(marketRequest.selectedSkillIDs == market.orderedSkillIDs, "market request should carry ordered skill ids from its contract")
        try require(tradeRequest.selectedSkillIDs == ["trade-plan-review"], "trade request should not inherit market skill ids")
        try require(tradeRequest.selectedExtensionIDs == ["cmc-skill-hub"], "trade request should keep its extension path")
        try require(marketRequest.chatScopeID != tradeRequest.chatScopeID, "run-scoped chats should be distinct per contract launch")
        try require(marketRequest.chatScopeID != marketRepeatRequest.chatScopeID, "same contract repeat launches should use distinct run chat scopes")
        try require(marketRequest.chatScopeID == "loop-run-\(market.id)-contract-check-market-launch-1", "launch chat scope should remain contract-readable and instance-scoped")
    }

    @MainActor
    private static func checkLoopOpsLocalStorePersistsRunLedgerAndShareSafeLog() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let lightRoot = root.appendingPathComponent("light", isDirectory: true)
        let strictStore = LoopOpsLocalJSONStore(root: root.appendingPathComponent("strict", isDirectory: true))
        let store = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false, strictJSONStore: strictStore)
        let template = try requireCryptoTemplate(id: "crypto-market-report-loop")
        let contract = LoopContract.from(template: template)
        store.upsert(contract)
        let task = AgentLongTask(
            taskID: "task-contract-ledger",
            sessionID: "session-contract-ledger",
            runID: "run-contract-ledger",
            prompt: contract.promptForRun(),
            status: "queued",
            selectedToolNames: [],
            selectedSkillIDs: contract.orderedSkillIDs,
            selectedExtensionIDs: contract.orderedExtensionIDs,
            attachmentIDs: [],
            artifactPath: "runtime/agent/runs/run-contract-ledger/task.json",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
        )
        let ledger = RunLedgerRow.from(task: task, contract: contract, finalReadModel: nil)
        store.captureRunLedger(ledger)
        store.appendMessage(scope: .run, scopeID: task.runID, title: contract.name, role: .user, text: "Explain evidence gaps.")

        var reloaded = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false)
        try require(reloaded.runLedgers.first?.runID == task.runID, "local LoopOps store should persist run ledger rows")
        try require(reloaded.runLedgers.first?.loopContractID == contract.id, "run ledger should retain originating contract id")
        try require(reloaded.shareSafeLogs.first?.id == task.runID, "share-safe preview should persist by run id")
        var sensitiveLedger = ledger
        sensitiveLedger.finalAnswerPreview = "Email a@b.com token=secret123 path /Users/test/private.json hash abcdefabcdefabcdefabcdefabcdefab"
        let redactedShare = ShareSafeLogPreview.from(ledger: sensitiveLedger)
        try require(!redactedShare.finalAnswerExcerpt.contains("a@b.com"), "share-safe excerpt should redact email addresses")
        try require(!redactedShare.finalAnswerExcerpt.contains("secret123"), "share-safe excerpt should redact credentials")
        try require(!redactedShare.finalAnswerExcerpt.contains("/Users/test"), "share-safe excerpt should redact local paths")

        let packet = ReviewPacketViewModel(
            id: task.runID,
            runID: task.runID,
            finalAnswer: "Reviewed final answer.",
            domainSummary: "Crypto review packet",
            claims: ["Reviewed final answer."],
            evidenceGaps: ["Needs one more source."],
            uncertainty: "review-needed",
            blockedActions: ["live trading"],
            nextQuestions: ["Refresh evidence?"],
            reviewDecision: "needs_follow_up"
        )
        store.upsertReviewPacket(packet)

        reloaded = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false)
        try require(reloaded.reviewPackets.first?.reviewDecision == "needs_follow_up", "review packet decision should persist")
        try require(reloaded.runLedgers.first?.reviewDecision == "needs_follow_up", "review packet upsert should update the matching run ledger decision")
        try require(
            reloaded.shareSafeLogs.first?.finalAnswerExcerpt == "Reviewed final answer.",
            "share-safe log should update from reviewed final answer"
        )
        let strictSnapshot = strictStore.readSnapshot()
        try require(strictSnapshot.contracts.first?.id == contract.id, "strict mirror should persist loop contract snapshot")
        try require(strictSnapshot.runLedgers.first?.runID == task.runID, "strict mirror should persist run ledger")
        try require(strictSnapshot.runLedgers.first?.loopContractSnapshot.id == contract.id, "strict ledger should retain contract snapshot")
        try require(strictSnapshot.reviewPackets.first?.loopContractID == contract.id, "strict review packet should retain contract id")
        try require(strictSnapshot.shareSafeLogs.first?.sourceRunID == task.runID, "strict share-safe log should retain source run id")
        try require(strictSnapshot.runLedgers.first?.reviewDecision?.decision == .needsFollowUp, "strict ledger should mirror review packet decision after packet upsert")
        try require(strictSnapshot.shareSafeLogs.first?.finalAnswerExcerpt == "Reviewed final answer.", "strict share-safe log should use reviewed final answer")
        try require(strictSnapshot.chatThreads.first?.runID == task.runID, "strict run chat thread should retain run id")

        let recovered = LoopOpsLocalStore(
            rootURL: root.appendingPathComponent("recovered-light", isDirectory: true),
            seedTemplates: false,
            strictJSONStore: strictStore
        )
        try require(recovered.loopContracts.first?.id == contract.id, "strict recovery should restore loop contracts into an empty light store")
        try require(recovered.runLedgers.first?.runID == task.runID, "strict recovery should restore run ledgers into an empty light store")
        try require(recovered.reviewPackets.first?.runID == task.runID, "strict recovery should restore review packets into an empty light store")
        try require(recovered.shareSafeLogs.first?.id == task.runID, "strict recovery should restore share-safe previews into an empty light store")
        try require(recovered.existingThread(scope: .run, scopeID: task.runID)?.messages.first?.text == "Explain evidence gaps.", "strict recovery should restore run-scoped chat into an empty light store")
    }

    private static func checkLoopOpsPublicSkillPolicyHidesInternalPackages() throws {
        let cmc = LoopOpsSkillPackage(
            kind: .extensionPackage,
            id: "cmc-skill-hub",
            title: "CMC Skill Hub capability",
            description: "Read-only crypto market evidence.",
            status: "available",
            selected: false,
            category: "marketData"
        )
        let channel = LoopOpsSkillPackage(
            kind: .extensionPackage,
            id: "feishu-live-channel",
            title: "Feishu live publish",
            description: "Outbound delivery channel.",
            status: "available",
            selected: false,
            category: "channel"
        )
        let provider = LoopOpsSkillPackage(
            kind: .skill,
            id: "raw-provider-gate",
            title: "Raw Provider Gate",
            description: "Internal runtime capability.",
            status: "available",
            selected: false,
            category: "provider"
        )
        let unknownCategory = LoopOpsSkillPackage(
            kind: .skill,
            id: "beta-experimental-socket",
            title: "Beta Experimental Socket",
            description: "Unreviewed capability.",
            status: "available",
            selected: false,
            category: "experimental"
        )
        let memory = LoopOpsSkillPackage(
            kind: .extensionPackage,
            id: "local-memory",
            title: "Local memory",
            description: "Internal long-term preference store.",
            status: "available",
            selected: false,
            category: "memory"
        )
        let legacyUncategorized = LoopOpsSkillPackage(
            kind: .skill,
            id: "legacy-review-helper",
            title: "Legacy Review Helper",
            description: "Older public skill manifest without a category.",
            status: "available",
            selected: false,
            category: nil
        )

        try require(cmc.isWorkbenchVisible, "Skill OS should show public read-only evidence packages")
        try require(!channel.isWorkbenchVisible, "Skill OS should hide outbound channel packages by schema category")
        try require(!provider.isWorkbenchVisible, "Skill OS should hide provider/gate internals by schema category")
        try require(!unknownCategory.isWorkbenchVisible, "Skill OS should hide categories outside the public allowlist")
        try require(!memory.isWorkbenchVisible, "Skill OS should hide memory packages from the public workspace")
        try require(legacyUncategorized.isWorkbenchVisible, "Skill OS should keep legacy public manifests with no category after safety filters pass")
    }

    @MainActor
    private static func checkLoopOpsToolDraftsBecomeSkillOSPackages() throws {
        let viewModel = DashboardViewModel()
        let draft = LoopOpsToolDraft(
            id: "tool-draft-local-review",
            name: "Local Review Tool",
            purpose: "Draft evidence gaps from a run result.",
            enabled: true,
            inputs: ["Run result", "Knowledge source"],
            visibleSteps: ["Collect context", "Check claims", "Write review packet"],
            outputShape: "Review packet",
            reviewPolicy: "Review-only"
        )

        let packages = LoopOpsSkillPackage.packages(from: viewModel, toolDrafts: [draft])
        guard let package = packages.first(where: { $0.id == draft.id }) else {
            throw ContractCheckError("tool draft should become a Skill OS package")
        }

        try require(package.title == "Local Review Tool", "tool draft package should keep draft name")
        try require(package.status == "Draft", "tool draft package should expose draft status")
        try require(package.category == "Local Tool", "tool draft package should be marked as a local tool")
        try require(package.domainLabel == "Local", "tool draft package should remain local by default")
        try require(package.selected, "tool draft package should expose durable enabled state")
        try require(package.binding(order: 0, source: "contract-check").id == draft.id, "tool draft package should be draggable into a skill path")
    }

    @MainActor
    private static func checkLoopOpsSkillOSUseAndBuildWritesStructuredLogs() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = LoopOpsLocalStore(rootURL: root, seedTemplates: false)
        let draft = LoopOpsToolDraft(
            id: "skill-os-use-contract-check",
            name: "Evidence Gap Finder",
            purpose: "Find missing review evidence.",
            enabled: true,
            integrationSource: "Local Tool",
            inputScope: "Run context",
            inputs: ["Run context", "Evidence notes"],
            visibleSteps: ["Collect context", "Check gaps"],
            outputShape: "Evidence gaps and next questions",
            reviewPolicy: "Review-only"
        )
        store.upsertToolDraft(draft)

        let failed = store.runLocalToolDraft(
            id: draft.id,
            inputValues: [:],
            now: contractDate,
            duration: 0
        )
        try require(failed?.status == "Failed", "empty Skill OS use should write failed log")
        try require(failed?.reviewState == "Needs input", "failed Skill OS use should show missing input state")
        try require(failed?.inputSummary == "No inputs provided.", "failed Skill OS use should summarize empty input")
        try require(failed?.errorSummary?.contains("Run context") == true, "failed Skill OS use should name missing inputs")

        let success = store.runLocalToolDraft(
            id: draft.id,
            inputValues: [
                "Run context": "BTC morning review",
                "Evidence notes": "Funding is stale; spot flow updated."
            ],
            now: contractDate.addingTimeInterval(10),
            duration: 0.2
        )
        try require(success?.status == "Submitting", "filled Skill OS use should write a submitted log before daemon acknowledgement")
        try require(success?.outputSummary == "Waiting for run confirmation.", "submitted Skill OS use should wait for run confirmation")
        try require(success?.reviewState == "Waiting for run confirmation", "submitted Skill OS use should expose the waiting state")
        try require(success?.errorSummary == nil, "submitted Skill OS use should not carry error summary")
        let acknowledged = try requireValue(
            success.flatMap { store.acknowledgeToolLogRun(logID: $0.id, runID: "run-skill-os-ack", runTitle: "Evidence Gap Finder") },
            "Skill OS use should update the same log after daemon acknowledgement"
        )
        try require(acknowledged.status == "Run scoped", "daemon acknowledgement should promote submitted Skill OS log")
        try require(acknowledged.runID == "run-skill-os-ack", "acknowledged Skill OS log should bind to the child run")

        let updated = store.updateToolDraftBuild(
            id: draft.id,
            integrationSource: "CMC Skill OS",
            inputScope: "Run result and attached Knowledge",
            inputs: ["Run context", "Evidence notes", "Review decision"],
            visibleSteps: ["Collect context", "Write review checklist"],
            outputShape: "Review checklist",
            reviewPolicy: "Review-only. Wait for confirmation before external action.",
            now: contractDate.addingTimeInterval(20)
        )
        try require(updated?.resolvedIntegrationSource == "CMC Skill OS", "Skill OS Build save should update source")
        try require(updated?.resolvedInputScope == "Run result and attached Knowledge", "Skill OS Build save should update input scope")
        try require(updated?.inputs == ["Run context", "Evidence notes", "Review decision"], "Skill OS Build save should update required inputs")
        try require(updated?.visibleSteps == ["Collect context", "Write review checklist"], "Skill OS Build save should update visible steps")
        try require(updated?.outputShape == "Review checklist", "Skill OS Build save should update output shape")
        try require(updated?.reviewPolicy == "Review-only. Wait for confirmation before external action.", "Skill OS Build save should update review rule")
        try require(store.toolLogs.first?.title == "Draft updated", "Skill OS Build save should write a Draft updated log")
        try require(store.toolLogs.first?.inputSummary == "3 inputs · 2 visible steps", "Skill OS Build log should summarize edited inputs and steps")
        try require(store.toolLogs.first?.outputSummary?.contains("Wait for confirmation") == true, "Skill OS Build log should summarize review rule")
    }

    @MainActor
    private static func checkLoopOpsSkillOSRunContextAndPublicCopy() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = LoopOpsLocalStore(rootURL: root, seedTemplates: false)
        let contract = LoopContract.from(template: try requireCryptoTemplate(id: "crypto-market-report-loop"))
        let task = loopOpsContractCheckTask(
            taskID: "task-skill-os-run-context",
            runID: "run-skill-os-context",
            status: "running",
            updatedAt: AgentDateFormatting.isoString(contractDate)
        )
        store.captureRunLedger(RunLedgerRow.from(task: task, contract: contract, finalReadModel: nil))

        let draft = LoopOpsToolDraft(
            id: "local-runtime-provider-gate-tool",
            name: "Local Gate Tool",
            purpose: "Review a run without exposing provider, runtime, or gate internals.",
            enabled: true,
            integrationSource: "Runtime Provider Gate",
            inputScope: "Selected run",
            inputs: ["Run context"],
            visibleSteps: ["Read selected run", "Write review checklist"],
            outputShape: "Review checklist",
            reviewPolicy: "Review-only"
        )
        store.upsertToolDraft(draft)

        let package = try requireValue(
            LoopOpsSkillPackage.packages(from: DashboardViewModel(), toolDrafts: [draft]).first { $0.id == draft.id },
            "local tool draft should surface as a Skill OS package"
        )
        let publicCopy = "\(package.title) \(package.description)".lowercased()
        try require(!publicCopy.contains("provider"), "Skill OS package copy should replace provider wording")
        try require(!publicCopy.contains("runtime"), "Skill OS package copy should replace runtime wording")
        try require(!publicCopy.contains("gate"), "Skill OS package copy should replace gate wording")
        try require(publicCopy.contains("review rule") || publicCopy.contains("source") || publicCopy.contains("workspace"), "Skill OS package copy should map internals to user-facing language")

        let log = try requireValue(
            store.runLocalToolDraft(
                id: draft.id,
                inputValues: ["Run context": "Selected run final answer and evidence gaps."],
                runID: task.runID,
                now: contractDate.addingTimeInterval(30)
            ),
            "Skill OS run should create a log"
        )
        try require(log.status == "Submitting", "Skill OS run with inputs should submit for LoopOps execution")
        try require(log.runID == task.runID, "Skill OS run should bind its log to the selected run")
        try require(store.logs(forRunID: task.runID).map(\.id).contains(log.id), "run-scoped log lookup should include Skill OS run log")

        let internalLog = LoopOpsToolLog(
            toolID: draft.id,
            title: "Provider runtime gate check",
            status: "Draft",
            summary: "Provider runtime gate summary.",
            inputSummary: "raw-provider runtime input",
            outputSummary: "gate output",
            errorSummary: "provider_only gate error",
            durationLabel: "instant",
            reviewState: "Runtime gate review",
            source: "Runtime Provider Gate",
            userLabel: "You",
            costLabel: "0 credits"
        )
        let publicLogCopy = [
            internalLog.publicTitle,
            internalLog.publicSummary,
            internalLog.publicInputSummary,
            internalLog.publicOutputOrErrorSummary,
            internalLog.publicReviewState,
            internalLog.publicSourceLabel
        ].joined(separator: " ").lowercased()
        try require(!publicLogCopy.contains("provider"), "Tool Log public copy should replace provider wording")
        try require(!publicLogCopy.contains("runtime"), "Tool Log public copy should replace runtime wording")
        try require(!publicLogCopy.contains("gate"), "Tool Log public copy should replace gate wording")
        try require(publicLogCopy.contains("source") || publicLogCopy.contains("workspace") || publicLogCopy.contains("review rule"), "Tool Log public copy should keep user-facing replacements")

        let source = store.materializeKnowledgeSource(
            id: "knowledge-\(log.id)",
            title: log.publicTitle,
            kind: .log,
            summary: log.publicOutputOrErrorSummary,
            sourceLabel: "Tool Log",
            linkedRunIDs: [task.runID],
            bodyMarkdown: """
            # \(log.publicTitle)

            Source: \(log.publicSourceLabel)
            Linked run: \(log.runID ?? "Not linked")

            ## Input
            \(log.publicInputSummary)

            ## Output
            \(log.publicOutputOrErrorSummary)
            """,
            tags: ["Tool Log", log.status],
            relatedToolLogIDs: [log.id]
        )
        try require(source.linkedRunIDs == [task.runID], "tool log knowledge source should keep the run link")
        try require(source.relatedToolLogIDs == [log.id], "tool log knowledge source should keep log relation")
        try require(source.bodyMarkdown?.contains("## Input") == true, "tool log knowledge source should persist input details")
        try require(source.bodyMarkdown?.contains("## Output") == true, "tool log knowledge source should persist output details")
    }

    @MainActor
    private static func checkLoopOpsRunSubmissionReportsPendingUntilDaemonAck() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = LoopOpsLocalStore(rootURL: root, seedTemplates: false)
        let contract = LoopContract.from(template: try requireCryptoTemplate(id: "crypto-market-report-loop"))
        store.upsert(contract)
        let session = loopOpsContractCheckSession(scenario: .success)
        let viewModel = DashboardViewModel(
            agentClient: AgentDaemonClient(baseURL: loopOpsContractCheckBaseURL, session: session, authToken: nil),
            agentEventClient: AgentEventStreamClient(baseURL: loopOpsContractCheckBaseURL, session: session, authToken: nil)
        )

        let report = viewModel.runLoopContract(contract, loopOpsStore: store)
        try require(report.status == "pending_ack", "runLoopContract should return pending before daemon acknowledgement")
        try require(report.queuedCount == 0, "pending loop submission must not be counted as queued")
        try waitForLoopOpsContractCheck("daemon ack") {
            viewModel.lastLoopOpsRunSubmissionReport.queuedContractIDs == [contract.id]
        }
        try require(viewModel.lastLoopOpsRunSubmissionReport.status == "queued", "daemon acknowledgement should promote loop submission to queued")
        try require(viewModel.loopOpsLastAcknowledgedRunID == "run-loopops-contract-check", "daemon acknowledgement should publish latest run id")
        try require(viewModel.selectedLoopOpsRunID == "run-loopops-contract-check", "daemon acknowledgement should select the new LoopOps run")
        try require(store.runLedger(runID: "run-loopops-contract-check")?.loopContractID == contract.id, "daemon acknowledgement should capture run ledger")

        let failedStore = LoopOpsLocalStore(rootURL: root.appendingPathComponent("failure", isDirectory: true), seedTemplates: false)
        failedStore.upsert(contract)
        let failedSession = loopOpsContractCheckSession(scenario: .submitFailure)
        let failedViewModel = DashboardViewModel(
            agentClient: AgentDaemonClient(baseURL: loopOpsContractCheckBaseURL, session: failedSession, authToken: nil),
            agentEventClient: AgentEventStreamClient(baseURL: loopOpsContractCheckBaseURL, session: failedSession, authToken: nil)
        )
        let failedReport = failedViewModel.runLoopContract(contract, loopOpsStore: failedStore)
        try require(failedReport.status == "pending_ack", "failed submit should also start as pending before daemon response")
        try waitForLoopOpsContractCheck("daemon failure") {
            failedViewModel.lastLoopOpsRunSubmissionReport.failedContractIDs == [contract.id]
        }
        try require(failedViewModel.lastLoopOpsRunSubmissionReport.status == "failed", "daemon submit failure should publish failed loop report")
        try require(failedStore.runLedgers.isEmpty, "daemon submit failure should not create queued ledger")
    }

    private static func checkLoopOpsWorkbenchSelectionResolverPrefersNewAck() throws {
        let oldTask = loopOpsContractCheckTask(
            taskID: "task-old",
            runID: "run-old",
            status: "running",
            updatedAt: "2026-06-24T00:00:00.000Z"
        )
        let newTask = loopOpsContractCheckTask(
            taskID: "task-new",
            runID: "run-new",
            status: "queued",
            updatedAt: "2026-06-24T00:01:00.000Z"
        )
        let runs = [
            WorkbenchLoopRunState(task: oldTask, domain: .crypto, capabilityLoop: nil, finalReadModel: nil),
            WorkbenchLoopRunState(task: newTask, domain: .crypto, capabilityLoop: nil, finalReadModel: nil)
        ]

        let selected = LoopOpsWorkbenchRunSelectionResolver.preferredSelection(
            runStates: runs,
            selectedDomain: .crypto,
            selectedRunID: nil,
            selectedTaskID: oldTask.taskID,
            acknowledgedRunID: newTask.runID,
            consumedAcknowledgedRunID: nil
        )
        try require(selected?.taskID == newTask.taskID, "new daemon acknowledgement should lock Workbench to the new run")
        try require(selected?.acknowledgedRunID == newTask.runID, "selection resolver should report the consumed acknowledgement")

        let preserved = LoopOpsWorkbenchRunSelectionResolver.preferredSelection(
            runStates: runs,
            selectedDomain: .crypto,
            selectedRunID: nil,
            selectedTaskID: oldTask.taskID,
            acknowledgedRunID: newTask.runID,
            consumedAcknowledgedRunID: newTask.runID
        )
        try require(preserved?.taskID == oldTask.taskID, "consumed acknowledgement should not repeatedly steal manual selection")
        try require(preserved?.acknowledgedRunID == nil, "preserved manual selection should not consume acknowledgement twice")

        let centralSelection = LoopOpsWorkbenchRunSelectionResolver.preferredSelection(
            runStates: runs,
            selectedDomain: .crypto,
            selectedRunID: oldTask.runID,
            selectedTaskID: newTask.taskID,
            acknowledgedRunID: newTask.runID,
            consumedAcknowledgedRunID: newTask.runID
        )
        try require(centralSelection?.taskID == oldTask.taskID, "explicit LoopOps run selection should drive Workbench result selection")
    }

    @MainActor
    private static func checkLoopOpsReconcileRunResultsFromPersistedLedgers() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let lightRoot = root.appendingPathComponent("light", isDirectory: true)
        let store = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false)
        let contract = LoopContract.from(template: try requireCryptoTemplate(id: "crypto-market-report-loop"))
        store.upsert(contract)

        let runningTask = loopOpsContractCheckTask(
            taskID: "task-running",
            runID: "run-running",
            status: "running",
            updatedAt: "2026-06-24T00:01:00.000Z"
        )
        let completedTask = loopOpsContractCheckTask(
            taskID: "task-completed",
            runID: "run-completed",
            status: "queued",
            updatedAt: "2026-06-24T00:00:00.000Z"
        )
        store.captureRunLedger(RunLedgerRow.from(task: runningTask, contract: contract, finalReadModel: nil))
        store.captureRunLedger(RunLedgerRow.from(task: completedTask, contract: contract, finalReadModel: nil))
        try writeLoopOpsContractCheckFinalReadModel(
            root: root,
            task: completedTask,
            finalText: "Completed answer from restarted daemon."
        )

        let resolver = AgentRuntimePathResolver(pathResolver: RuntimePathResolver(root: root))
        let viewModel = DashboardViewModel(
            agentRunReadModelStore: AgentRunReadModelStore(streamStore: AgentStreamStore(resolver: resolver))
        )
        viewModel.agentTasks = [runningTask]
        let reconciledCount = viewModel.reconcileLoopOpsRunResults(in: store)

        try require(reconciledCount == 2, "Workbench reconcile should visit active and persisted run ids")
        try require(store.runLedger(runID: runningTask.runID)?.status == "running", "active running task should refresh persisted ledger")
        try require(store.runLedger(runID: completedTask.runID)?.status == "completed", "final read model should refresh completed ledger")
        try require(
            store.reviewPacket(runID: completedTask.runID)?.finalAnswer.contains("Completed answer") == true,
            "completed reconcile should materialize review packet"
        )
        try require(
            viewModel.agentFinalReadModelByRunID[completedTask.runID]?.status == "completed",
            "completed reconcile should cache final read model for Run Result"
        )
    }

    @MainActor
    private static func checkLoopOpsKnowledgeToolModelsAndStoreRoundTrip() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let lightRoot = root.appendingPathComponent("light", isDirectory: true)
        let strictStore = LoopOpsLocalJSONStore(root: root.appendingPathComponent("strict", isDirectory: true))
        let store = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false, strictJSONStore: strictStore)
        let stableDate = ISO8601DateFormatter().date(from: "2026-06-22T00:00:00Z")!

        let knowledge = LoopOpsKnowledgeSource(
            id: "knowledge-test",
            title: "Market evidence notes",
            kind: .blank,
            summary: "Manual notes for the next loop.",
            status: .ready,
            reuseMode: .attachToLoop,
            sourceLabel: "Manual note",
            createdAt: stableDate,
            updatedAt: stableDate
        )
        store.upsertKnowledgeSource(knowledge)
        var editedKnowledge = knowledge
        editedKnowledge.title = "Edited market evidence notes"
        editedKnowledge.summary = "Reviewed notes that can be attached to a loop result."
        editedKnowledge.status = .needsReview
        editedKnowledge.reuseMode = .referenceOnly
        editedKnowledge.sourceLabel = "Manual review note"
        editedKnowledge.bodyMarkdown = "## Evidence notes\nReviewed run context and evidence gaps."
        editedKnowledge.tags = ["evidence", "review"]
        editedKnowledge.sourceURL = "https://example.com/review-notes"
        store.upsertKnowledgeSource(editedKnowledge)

        let materialized = store.materializeKnowledgeSource(
            id: "review-packet-source",
            title: "BTC review packet",
            kind: .review,
            summary: "Evidence gaps and review decision.",
            sourceLabel: "Review Packet",
            bodyMarkdown: "Claims, gaps, and review decision.",
            tags: ["Review Packet"],
            relatedReviewPacketIDs: ["packet-knowledge-test"]
        )
        let ledger = RunLedgerRow(
            id: "ledger-knowledge-test",
            loopContractID: "loop-knowledge-test",
            runID: "run-knowledge-test",
            title: "Knowledge attach run",
            domain: .crypto,
            status: "completed",
            startedAt: AgentDateFormatting.isoString(stableDate),
            completedAt: AgentDateFormatting.isoString(stableDate),
            inputsUsed: ["Workspace context"],
            finalAnswerPreview: "Review packet ready.",
            evidenceGaps: [],
            blockedActions: [],
            reviewDecision: "pending",
            followUpPrompts: [],
            cloneable: true,
            replayable: true,
            skillPath: ["CoinMarketCap market radar"]
        )
        store.captureRunLedger(ledger)
        try require(
            store.attachKnowledgeSource(id: materialized.id, toRunID: ledger.runID, runTitle: ledger.title),
            "materialized knowledge source should attach to a run ledger"
        )

        let binding = LoopOpsSkillBinding(
            kind: .skill,
            id: "cmc-market-radar",
            title: "CoinMarketCap market radar",
            order: 0,
            source: "contract-check"
        )
        let draft = LoopOpsToolDraft(
            id: "tool-draft-test",
            name: "Evidence freshness checker",
            purpose: "Check whether market evidence is stale before writing a review packet.",
            enabled: true,
            inputs: ["Workspace context"],
            visibleSteps: ["Collect inputs", "Write review packet"],
            outputShape: "Review packet",
            reviewPolicy: "Review-only",
            skillBindings: [binding],
            createdAt: stableDate,
            updatedAt: stableDate
        )
        store.upsertToolDraft(draft)

        let log = LoopOpsToolLog(
            id: "tool-log-test",
            toolID: draft.id,
            title: "Evidence freshness checker created",
            status: "Draft",
            summary: "Tool draft saved.",
            durationLabel: "instant",
            reviewState: "Review-only",
            createdAt: stableDate
        )
        store.appendToolLog(log)
        store.showToast(title: "Saved", detail: "Transient toast", tone: .success)

        let reloaded = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false)
        try require(reloaded.knowledgeSources.count == 2, "knowledge sources and materialized review rows should persist")
        let reloadedKnowledge = try requireValue(
            reloaded.knowledgeSources.first { $0.id == knowledge.id },
            "edited knowledge source should round-trip"
        )
        try require(reloadedKnowledge.title == "Edited market evidence notes", "knowledge source title edits should persist")
        try require(reloadedKnowledge.summary.contains("attached to a loop"), "knowledge source summary edits should persist")
        try require(reloadedKnowledge.status == .needsReview, "knowledge source status edits should persist")
        try require(reloadedKnowledge.reuseMode == .referenceOnly, "knowledge source reuse mode edits should persist")
        try require(reloadedKnowledge.bodyMarkdown?.contains("Evidence notes") == true, "knowledge page body should persist")
        try require(reloadedKnowledge.tags == ["evidence", "review"], "knowledge tags should persist")
        try require(reloadedKnowledge.sourceURL == "https://example.com/review-notes", "knowledge source URL should persist")
        let reloadedMaterialized = try requireValue(
            reloaded.knowledgeSources.first { $0.id == materialized.id },
            "materialized review knowledge source should round-trip"
        )
        try require(reloadedMaterialized.reuseMode == .attachToLoop, "attached materialized source should become loop-attachable")
        try require(reloadedMaterialized.linkedRunIDs == [ledger.runID], "attached materialized source should remember linked run")
        try require(reloadedMaterialized.relatedReviewPacketIDs == ["packet-knowledge-test"], "materialized source should preserve review relation")
        try require(
            reloaded.runLedger(runID: ledger.runID)?.knowledgeSourceIDs == [materialized.id],
            "run ledger should remember attached knowledge source"
        )
        try require(reloaded.toolDrafts.count == 1, "tool drafts should persist")
        try require(reloaded.toolDrafts[0].isEnabled, "tool draft enabled state should persist")
        try require(reloaded.toolDrafts[0].skillBindings.map(\.id) == ["cmc-market-radar"], "tool draft skill path should persist")
        try require(reloaded.toolLogs == [log], "tool logs should persist")
        try require(reloaded.toasts.isEmpty, "toast stack should be transient and not persist")

        let strictSnapshot = strictStore.readSnapshot()
        try require(
            Set(strictSnapshot.knowledgeSources.map(\.id)) == Set([knowledge.id, materialized.id]),
            "strict mirror should persist knowledge sources"
        )
        try require(
            strictSnapshot.knowledgeSources.first { $0.id == materialized.id }?.linkedRunIDs == [ledger.runID],
            "strict mirror should persist source-side run knowledge attachments"
        )
        try require(strictSnapshot.toolDrafts.map(\.id) == [draft.id], "strict mirror should persist tool drafts")
        try require(strictSnapshot.toolDrafts[0].isEnabled, "strict mirror should persist tool enabled state")
        try require(strictSnapshot.toolDrafts[0].skillBindings.map(\.id) == ["cmc-market-radar"], "strict mirror should persist ordered tool skill path")
        try require(strictSnapshot.toolLogs == [log], "strict mirror should persist tool logs")

        let recovered = LoopOpsLocalStore(
            rootURL: root.appendingPathComponent("recovered-light", isDirectory: true),
            seedTemplates: false,
            strictJSONStore: strictStore
        )
        try require(
            Set(recovered.knowledgeSources.map(\.id)) == Set([knowledge.id, materialized.id]),
            "strict recovery should restore knowledge sources"
        )
        try require(
            recovered.knowledgeSources.first { $0.id == materialized.id }?.linkedRunIDs == [ledger.runID],
            "strict recovery should restore source-side knowledge attachments"
        )
        try require(recovered.toolDrafts.map(\.id) == [draft.id], "strict recovery should restore tool drafts")
        try require(recovered.toolDrafts[0].isEnabled, "strict recovery should restore tool draft enabled state")
        try require(recovered.toolLogs == [log], "strict recovery should restore tool logs")
    }

    private static func checkLoopOpsInteractionIDsCoverAcceptanceAnchors() throws {
        let ids = LoopOpsInteractionID.requiredUISmokeIDs
        try require(Set(ids).count == ids.count, "interaction identifiers should be unique")
        try require(ids.contains(LoopOpsInteractionID.workbenchActiveQueue), "smoke ids should include active queue")
        try require(ids.contains(LoopOpsInteractionID.workbenchRunResult), "smoke ids should include run result")
        try require(ids.contains(LoopOpsInteractionID.workbenchRunChat), "smoke ids should include run chat")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuide), "smoke ids should include Workbench review guide")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideProgress), "smoke ids should include Workbench review guide progress")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideChecklist), "smoke ids should include Workbench review guide checklist")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideEvidenceMap), "smoke ids should include Workbench review guide evidence map")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideEvidenceMapCount), "smoke ids should include Workbench review guide evidence map count")
        try require(ids.contains(LoopOpsInteractionID.reviewGuideEvidenceRow("marketplace")), "smoke ids should include marketplace evidence row")
        try require(ids.contains(LoopOpsInteractionID.reviewGuideEvidenceRow("triple")), "smoke ids should include Triple evidence row")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideDecision), "smoke ids should include Workbench review guide decision board")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideDecisionStatus), "smoke ids should include Workbench review guide decision status")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideDecisionNeedsWork), "smoke ids should include Workbench review guide decision needs-work action")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideDecisionApproved), "smoke ids should include Workbench review guide decision approved action")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideDecisionBlockers), "smoke ids should include Workbench review guide decision blockers")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideDecisionNotes), "smoke ids should include Workbench review guide decision notes")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideRecordHandoff), "smoke ids should include Workbench review guide record handoff")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideRecordStatus), "smoke ids should include Workbench review guide record status")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideRecordPrepare), "smoke ids should include Workbench review guide record prepare action")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideRecordPreview), "smoke ids should include Workbench review guide record command preview")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuidePersistence), "smoke ids should include Workbench review guide local persistence status")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideTraceability), "smoke ids should include Workbench review guide traceability")
        try require(ids.contains(LoopOpsInteractionID.workbenchReviewGuideTraceabilityCount), "smoke ids should include Workbench review guide traceability count")
        try require(ids.contains(LoopOpsInteractionID.reviewGuideTraceabilityRow("marketplace-loop-library")), "smoke ids should include marketplace traceability row")
        try require(ids.contains(LoopOpsInteractionID.reviewGuideTraceabilityRow("agent-team-process")), "smoke ids should include agent-team process traceability row")
        try require(ids.contains(LoopOpsInteractionID.reviewGuidePath("library")), "smoke ids should include review guide Library path")
        try require(ids.contains(LoopOpsInteractionID.reviewGuidePath("skill-os")), "smoke ids should include review guide Skill OS path")
        try require(ids.contains(LoopOpsInteractionID.reviewGuidePath("knowledge")), "smoke ids should include review guide Knowledge path")
        try require(ids.contains(LoopOpsInteractionID.reviewGuidePath("chat")), "smoke ids should include review guide Chat path")
        try require(ids.contains(LoopOpsInteractionID.reviewGuideChecklistDone("library")), "smoke ids should include review guide Library checklist action")
        try require(ids.contains(LoopOpsInteractionID.reviewGuideChecklistDone("skill-os")), "smoke ids should include review guide Skill OS checklist action")
        try require(ids.contains(LoopOpsInteractionID.reviewGuideChecklistDone("knowledge")), "smoke ids should include review guide Knowledge checklist action")
        try require(ids.contains(LoopOpsInteractionID.reviewGuideChecklistDone("chat")), "smoke ids should include review guide Chat checklist action")
        try require(ids.contains(LoopOpsInteractionID.buildChatList), "smoke ids should include Build Chat list")
        try require(ids.contains(LoopOpsInteractionID.scopedChat(.global)), "smoke ids should include global chat")
        try require(ids.contains(LoopOpsInteractionID.scopedChatQuickControls(.global)), "smoke ids should include global chat quick controls")
        try require(ids.contains(LoopOpsInteractionID.scopedChatInput(.global)), "smoke ids should include global chat input")
        try require(ids.contains(LoopOpsInteractionID.scopedChatSend(.global)), "smoke ids should include global chat send")
        try require(ids.contains(LoopOpsInteractionID.scopedChat(.review)), "smoke ids should include review chat")
        try require(ids.contains(LoopOpsInteractionID.scopedChatQuickControls(.review)), "smoke ids should include review chat quick controls")
        try require(ids.contains(LoopOpsInteractionID.scopedChatInput(.review)), "smoke ids should include review chat input")
        try require(ids.contains(LoopOpsInteractionID.scopedChatSend(.review)), "smoke ids should include review chat send")
        try require(ids.contains(LoopOpsInteractionID.loopLibraryBatchRun), "smoke ids should include loop library batch run")
        try require(ids.contains(LoopOpsInteractionID.loopLibraryTemplateMarketplace), "smoke ids should include loop marketplace")
        try require(ids.contains(LoopOpsInteractionID.loopLibraryLedgerList), "smoke ids should include run ledger list")
        try require(ids.contains(LoopOpsInteractionID.loopLibraryDetailRun), "smoke ids should include loop detail run action")
        try require(ids.contains(LoopOpsInteractionID.loopLibraryDetailClone), "smoke ids should include loop detail clone action")
        try require(ids.contains(LoopOpsInteractionID.loopLibraryReviewPacket), "smoke ids should include review packet panel")
        try require(ids.contains(LoopOpsInteractionID.reviewDecision("reviewed")), "smoke ids should include reviewed decision")
        try require(ids.contains(LoopOpsInteractionID.reviewDecision("needs_follow_up")), "smoke ids should include needs-follow-up decision")
        try require(ids.contains(LoopOpsInteractionID.reviewDecision("blocked")), "smoke ids should include blocked decision")
        try require(ids.contains(LoopOpsInteractionID.loopLibraryShareSafeLog), "smoke ids should include share-safe log preview")
        try require(ids.contains(LoopOpsInteractionID.skillOSLibrary), "smoke ids should include Skill OS library")
        try require(ids.contains(LoopOpsInteractionID.skillOSCreateTool), "smoke ids should include Skill OS create tool")
        try require(ids.contains(LoopOpsInteractionID.skillOSToolLogs), "smoke ids should include Skill OS logs")
        try require(ids.contains(LoopOpsInteractionID.knowledgeNewMenu), "smoke ids should include Knowledge new menu")
        try require(ids.contains(LoopOpsInteractionID.knowledgeToastStack), "smoke ids should include toast stack")
        try require(ids.contains(LoopOpsInteractionID.studioExecutionPath), "smoke ids should include Studio execution path")
        try require(ids.contains(LoopOpsInteractionID.studioBuilderPatchReceipt), "smoke ids should include Studio Builder patch receipt")
        try require(ids.contains(LoopOpsInteractionID.studioBuilderPatchReceiptStatus), "smoke ids should include Studio Builder patch receipt status")

        let starterContract = try requireCryptoTemplate(id: "crypto-market-report-loop")
        let uiContract = LoopContract.from(template: starterContract)
        guard let firstBinding = uiContract.orderedSkillBindings.first else {
            throw ContractCheckError("expected starter loop to expose a skill binding")
        }
        let dynamicIDs = [
            LoopOpsInteractionID.contractSelect(uiContract.id),
            LoopOpsInteractionID.contractRow(uiContract.id),
            LoopOpsInteractionID.contractRunButton(uiContract.id),
            LoopOpsInteractionID.contractOpenButton(uiContract.id),
            LoopOpsInteractionID.workbenchContractRun(uiContract.id),
            LoopOpsInteractionID.workbenchActiveQueueRow("task-run-\(uiContract.id)"),
            LoopOpsInteractionID.ledgerRow("ledger-\(uiContract.id)"),
            LoopOpsInteractionID.skillPackage(firstBinding.id),
            LoopOpsInteractionID.skillPathRow(firstBinding.dragID),
            LoopOpsInteractionID.skillPathMoveUp(firstBinding.dragID),
            LoopOpsInteractionID.skillPathMoveDown(firstBinding.dragID),
            LoopOpsInteractionID.skillPathRemove(firstBinding.dragID)
        ]
        try require(Set(dynamicIDs).count == dynamicIDs.count, "dynamic interaction identifiers should be unique")
        try require(dynamicIDs.allSatisfy { $0.hasPrefix("loopops.") }, "dynamic interaction identifiers should stay in loopops namespace")
        try require(dynamicIDs.allSatisfy { !$0.contains(" ") && !$0.contains("\n") }, "dynamic interaction identifiers should be automation-safe")
    }

    private static func checkLoopOpsKnowledgeRowsHideInternalTerms() throws {
        let detail = loopOpsKnowledgeThreadDetail(messageCount: 2, reusableNoteCount: 1)
        let forbiddenTerms = ["memory", "provider", "runtime", "worker", "artifact", "schema"]
        let lowercasedDetail = detail.lowercased()
        try require(detail == "2 messages · 1 reusable note", "knowledge chat row should use user-facing reusable note copy")
        try require(forbiddenTerms.allSatisfy { !lowercasedDetail.contains($0) }, "knowledge chat row should not expose internal terms")
    }

    private static func checkLoopOpsVisibleCopyHidesInternalTerms() throws {
        let template = try requireCryptoTemplate(id: "crypto-market-report-loop")
        let contract = LoopContract.from(template: template)
        let prompt = contract.promptForRun(additionalInstruction: "Explain gaps.")
        let ledger = RunLedgerRow(
            id: "visible-copy-run",
            loopContractID: contract.id,
            runID: "visible-copy-run",
            title: contract.name,
            domain: contract.domain,
            status: "completed",
            startedAt: "2026-06-24T00:00:00.000Z",
            completedAt: "2026-06-24T00:01:00.000Z",
            inputsUsed: contract.inputBindings,
            finalAnswerPreview: "Final answer ready for review.",
            evidenceGaps: ["Needs one more source."],
            blockedActions: ["external publish"],
            reviewDecision: "pending",
            followUpPrompts: ["Refresh evidence?"],
            cloneable: true,
            replayable: true
        )
        let share = ShareSafeLogPreview.from(ledger: ledger)
        let visibleCopy = [
            "Loop Library",
            "Skill OS",
            "Studio",
            "Ops workspace",
            "Review Rule",
            "Review rule: \(contract.feedbackGate)",
            "Run in background\n\(contract.trigger)\nReview rule: \(contract.feedbackGate)\nExit: \(contract.exitCondition)",
            share.omittedSensitiveFieldsSummary,
            prompt
        ].joined(separator: "\n").lowercased()
        let forbiddenPhrases = [
            "feedback gate",
            "gate:",
            "runtime workspace",
            "provider details",
            "provider payloads",
            "legacy runtime selection ids",
            "raw artifact paths"
        ]

        try require(prompt.contains("Review Rule："), "run prompt should describe feedback constraints with user-facing review-rule copy")
        try require(!prompt.contains("Feedback Gate："), "run prompt should not expose gate terminology")
        try require(forbiddenPhrases.allSatisfy { !visibleCopy.contains($0) }, "LoopOps visible copy should hide runtime/provider/gate phrasing")
    }

    private enum LoopOpsContractCheckScenario {
        case success
        case submitFailure
    }

    private final class LoopOpsContractCheckURLProtocol: URLProtocol {
        nonisolated(unsafe) static var scenario: LoopOpsContractCheckScenario = .success

        override class func canInit(with request: URLRequest) -> Bool {
            request.url?.host == loopOpsContractCheckBaseURL.host
        }

        override class func canonicalRequest(for request: URLRequest) -> URLRequest {
            request
        }

        override func startLoading() {
            let response = Self.response(for: request)
            let httpResponse = HTTPURLResponse(
                url: request.url!,
                statusCode: response.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: response.headers
            )!
            client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: response.body)
            client?.urlProtocolDidFinishLoading(self)
        }

        override func stopLoading() {}

        private static func response(for request: URLRequest) -> (statusCode: Int, headers: [String: String], body: Data) {
            let method = request.httpMethod ?? "GET"
            let path = request.url?.path ?? ""
            if method == "GET", path == "/health" {
                return json(200, loopOpsContractCheckHealthJSON)
            }
            if method == "GET", path == "/capabilities" {
                return json(200, loopOpsContractCheckCapabilitiesJSON)
            }
            if method == "GET", path == "/sessions" {
                return json(200, #"{"schemaVersion":"agent-session-list-v1","sessions":[]}"#)
            }
            if method == "GET", path == "/tasks" {
                return json(200, #"{"schemaVersion":"agent-task-list-v1","tasks":[]}"#)
            }
            if method == "POST", path == "/sessions" {
                return json(200, loopOpsContractCheckSessionJSON(activeRunID: nil, messages: "[]"))
            }
            if method == "POST", path.hasSuffix("/messages/async") {
                switch scenario {
                case .success:
                    return json(200, loopOpsContractCheckAsyncResponseJSON)
                case .submitFailure:
                    return json(500, #"{"error":"daemon rejected loop submit"}"#)
                }
            }
            if method == "GET", path.hasPrefix("/runs/"), path.hasSuffix("/events") {
                return (200, ["Content-Type": "text/event-stream"], Data())
            }
            return json(404, #"{"error":"unexpected contract-check endpoint"}"#)
        }

        private static func json(_ statusCode: Int, _ value: String) -> (statusCode: Int, headers: [String: String], body: Data) {
            (statusCode, ["Content-Type": "application/json"], Data(value.utf8))
        }
    }

    private static let loopOpsContractCheckBaseURL = URL(string: "https://loopops-contract-check.test")!
    private static let loopOpsContractCheckTimestamp = "2026-06-24T00:00:00.000Z"

    private static func loopOpsContractCheckSession(scenario: LoopOpsContractCheckScenario) -> URLSession {
        LoopOpsContractCheckURLProtocol.scenario = scenario
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LoopOpsContractCheckURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static func waitForLoopOpsContractCheck(
        _ description: String,
        timeout: TimeInterval = 2,
        condition: () -> Bool
    ) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() {
                return
            }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
        throw ContractCheckError("Timed out waiting for \(description)")
    }

    private static var loopOpsContractCheckHealthJSON: String {
        """
        {
          "schemaVersion": "agent-runtime-host-health-v1",
          "status": "ok",
          "daemon": {
            "pid": 1,
            "host": "127.0.0.1",
            "port": 8797,
            "startedAt": "\(loopOpsContractCheckTimestamp)",
            "runtimeRoot": null
          },
          "providers": [],
          "capabilities": [],
          "skills": [],
          "extensions": [],
          "templates": [],
          "tools": [],
          "internalToolsExposed": false,
          "policy": {}
        }
        """
    }

    private static let loopOpsContractCheckCapabilitiesJSON = """
    {
      "capabilities": [],
      "skills": [],
      "extensions": [],
      "templates": [],
      "providers": [],
      "extensionPackages": [],
      "tools": [],
      "internalToolsExposed": false
    }
    """

    private static var loopOpsContractCheckAsyncResponseJSON: String {
        """
        {
          "schemaVersion": "agent-async-message-response-v1",
          "session": \(loopOpsContractCheckSessionJSON(activeRunID: "run-loopops-contract-check", messages: "[\(loopOpsContractCheckUserMessageJSON)]")),
          "task": \(loopOpsContractCheckTaskJSON),
          "runID": "run-loopops-contract-check",
          "taskID": "task-loopops-contract-check",
          "eventsURL": "/runs/run-loopops-contract-check/events",
          "artifactPath": "runtime/agent/runs/run-loopops-contract-check/task.json",
          "acceptedAt": "\(loopOpsContractCheckTimestamp)"
        }
        """
    }

    private static func loopOpsContractCheckSessionJSON(activeRunID: String?, messages: String) -> String {
        let activeRunValue = activeRunID.map { "\"\($0)\"" } ?? "null"
        return """
        {
          "schemaVersion": "agent-session-v1",
          "sessionID": "session-loopops-contract-check",
          "title": "LoopOps Contract Check",
          "createdAt": "\(loopOpsContractCheckTimestamp)",
          "updatedAt": "\(loopOpsContractCheckTimestamp)",
          "status": "active",
          "activeRunID": \(activeRunValue),
          "messages": \(messages)
        }
        """
    }

    private static var loopOpsContractCheckUserMessageJSON: String {
        """
        {
          "id": "message-loopops-contract-check",
          "role": "user",
          "content": [
            {
              "type": "text",
              "text": "Run LoopOps contract."
            }
          ],
          "attachments": [],
          "contextRefs": [],
          "runID": "run-loopops-contract-check",
          "createdAt": "\(loopOpsContractCheckTimestamp)"
        }
        """
    }

    private static var loopOpsContractCheckTaskJSON: String {
        let contract = LoopContract.from(template: WorkbenchLoopTemplate.templates(for: .crypto).first { $0.id == "crypto-market-report-loop" }!)
        let skillIDs = contract.orderedSkillIDs.map { "\"\($0)\"" }.joined(separator: ",")
        let extensionIDs = contract.orderedExtensionIDs.map { "\"\($0)\"" }.joined(separator: ",")
        return """
        {
          "taskID": "task-loopops-contract-check",
          "sessionID": "session-loopops-contract-check",
          "runID": "run-loopops-contract-check",
          "prompt": "Run LoopOps contract.",
          "status": "queued",
          "selectedToolNames": [],
          "selectedSkillIDs": [\(skillIDs)],
          "selectedExtensionIDs": [\(extensionIDs)],
          "attachmentIDs": [],
          "artifactPath": "runtime/agent/runs/run-loopops-contract-check/task.json",
          "createdAt": "\(loopOpsContractCheckTimestamp)",
          "updatedAt": "\(loopOpsContractCheckTimestamp)"
        }
        """
    }

    private static func loopOpsContractCheckTask(
        taskID: String,
        runID: String,
        status: String,
        updatedAt: String
    ) -> AgentLongTask {
        let contract = LoopContract.from(template: WorkbenchLoopTemplate.templates(for: .crypto).first { $0.id == "crypto-market-report-loop" }!)
        return AgentLongTask(
            taskID: taskID,
            sessionID: "session-\(runID)",
            runID: runID,
            prompt: contract.promptForRun(),
            status: status,
            selectedToolNames: [],
            selectedSkillIDs: contract.orderedSkillIDs,
            selectedExtensionIDs: contract.orderedExtensionIDs,
            attachmentIDs: [],
            artifactPath: "runtime/agent/runs/\(runID)/task.json",
            createdAt: loopOpsContractCheckTimestamp,
            updatedAt: updatedAt
        )
    }

    private static func writeLoopOpsContractCheckFinalReadModel(
        root: URL,
        task: AgentLongTask,
        finalText: String
    ) throws {
        let runDir = root
            .appendingPathComponent("runtime", isDirectory: true)
            .appendingPathComponent("agent", isDirectory: true)
            .appendingPathComponent("runs", isDirectory: true)
            .appendingPathComponent(task.runID, isDirectory: true)
        try FileManager.default.createDirectory(at: runDir, withIntermediateDirectories: true)
        let finalReadModel = AgentFinalReadModel(
            schemaVersion: "agent-final-read-model-v1",
            runID: task.runID,
            taskID: task.taskID,
            sessionID: task.sessionID,
            status: "completed",
            finalText: finalText,
            finalTextSource: "agent-final-read-model",
            outputGuardStatus: "passed",
            outputGuardReason: nil,
            cmcGateSummary: nil,
            productMutationPolicy: nil,
            generatedAt: "2026-06-24T00:01:00.000Z",
            artifactPath: "runtime/agent/runs/\(task.runID)/agent-final-read-model.json"
        )
        try JSONEncoder.agentArtifactEncoder()
            .encode(finalReadModel)
            .write(to: runDir.appendingPathComponent("agent-final-read-model.json"), options: [.atomic])
    }

    private static var contractDate: Date {
        ISO8601DateFormatter().date(from: "2026-05-24T00:00:00Z")!
    }

    private static func requireCryptoTemplate(id: String) throws -> WorkbenchLoopTemplate {
        guard let template = WorkbenchLoopTemplate.templates(for: .crypto).first(where: { $0.id == id }) else {
            throw ContractCheckError("missing crypto loop template \(id)")
        }
        return template
    }

    private static func requireSnapshot(_ snapshot: MarketDataSnapshot?) throws -> MarketDataSnapshot {
        guard let snapshot else { throw ContractCheckError("expected snapshot") }
        return snapshot
    }

    private static func builderTestPackages() -> [LoopOpsSkillPackage] {
        [
            LoopOpsSkillPackage(
                kind: .skill,
                id: "market-regime-review",
                title: "Market regime review",
                description: "Risk stance review.",
                status: "ready",
                selected: false,
                category: "Review"
            ),
            LoopOpsSkillPackage(
                kind: .extensionPackage,
                id: "cmc-skill-hub",
                title: "CMC Skill Hub capability",
                description: "Read-only crypto evidence.",
                status: "ready",
                selected: false,
                category: "Crypto"
            ),
            LoopOpsSkillPackage(
                kind: .skill,
                id: "cmc-market-radar",
                title: "CoinMarketCap market radar",
                description: "Market scan.",
                status: "ready",
                selected: false,
                category: "Crypto"
            )
        ]
    }

    private static func lines(from value: String) -> [String] {
        value
            .split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("wechat-radar-contract-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

struct ContractCheckError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}
