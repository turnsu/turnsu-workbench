import Foundation
@testable import WeChatIntelligenceRadarApp

func checkLoopOpsTemplateMigrationBuildsCodableContract() {
    let template = WorkbenchLoopTemplate.all.first { $0.id == "crypto-market-report-loop" }!
    let now = ISO8601DateFormatter().date(from: "2026-06-22T00:00:00Z")!
    let contract = LoopOpsLoopContract.fromTemplate(template, owner: "tester", now: now)

    loopOpsRequire(contract.schemaVersion == LoopOpsLoopContract.schemaVersion, "contract schema should be stable")
    loopOpsRequire(contract.id == "loop-contract-\(template.id)", "contract id should be template-derived")
    loopOpsRequire(contract.name == template.title, "contract should preserve template title")
    loopOpsRequire(contract.domain == .crypto, "contract should map workbench crypto domain")
    loopOpsRequire(contract.goal == template.subtitle, "contract should preserve template subtitle as goal")
    loopOpsRequire(contract.trigger == template.trigger, "contract should preserve trigger")
    loopOpsRequire(contract.stepSummary == template.stepsSummary, "contract should preserve step summary")
    loopOpsRequire(contract.feedbackGate == template.feedbackGate, "contract should preserve feedback gate")
    loopOpsRequire(contract.exitCondition == template.exitCondition, "contract should preserve exit condition")
    loopOpsRequire(contract.reviewBoundary == template.reviewBoundary, "contract should preserve review boundary")
    loopOpsRequire(contract.outputShape == template.outputShape, "contract should preserve output shape")
    loopOpsRequire(contract.scheduleMode == .manual, "migrated templates should start as manual loops")
    loopOpsRequire(contract.owner == "tester", "owner should be set by migration caller")
    loopOpsRequire(contract.visibility == .private, "migrated templates should default private")
    loopOpsRequire(contract.templateMigration?.legacySkillIDs == template.defaultSkillIDs, "migration should retain legacy skill ids for launch compatibility")
    loopOpsRequire(contract.templateMigration?.legacyExtensionIDs == template.defaultExtensionIDs, "migration should retain legacy extension ids for launch compatibility")
    loopOpsRequire(contract.inputBindings.contains { $0.kind == .prompt && $0.required }, "contract should expose a required prompt binding")
    loopOpsRequire(contract.userFacingCapabilityChain.contains { $0.title == "CoinMarketCap market radar" }, "legacy skill id should become a readable capability")

    let capabilityText = contract.userFacingCapabilityChain.map(\.title).joined(separator: " ")
    loopOpsRequire(!capabilityText.contains("cmc-market-radar"), "user-facing capability titles should not expose raw skill ids")
    loopOpsRequire(!capabilityText.contains("cmc-skill-hub"), "user-facing capability titles should not expose raw extension ids")

    let data = try! JSONEncoder.agentArtifactEncoder().encode(contract)
    let decoded = try! JSONDecoder.agentArtifactDecoder().decode(LoopOpsLoopContract.self, from: data)
    loopOpsRequire(decoded == contract, "contract should round-trip through JSON")
}

func checkLoopContractBridgeRoundTripsStrictJSONWithoutRawUserFacingIDs() {
    let template = WorkbenchLoopTemplate.all.first { $0.id == "crypto-market-report-loop" }!
    let now = ISO8601DateFormatter().date(from: "2026-06-22T00:00:00Z")!
    var uiContract = LoopContract.from(template: template, now: now)
    uiContract.knowledgeSourceIDs = ["knowledge-bridge-test"]
    uiContract.skillStackID = "skill-stack-bridge-test"

    loopOpsRequire(uiContract.capabilityChain.contains("CoinMarketCap market radar"), "UI contract should show readable capability labels")
    loopOpsRequire(!uiContract.capabilityChain.joined(separator: " ").contains("cmc-market-radar"), "UI capability chain should not expose raw skill ids")
    loopOpsRequire(!uiContract.capabilityChain.joined(separator: " ").contains("cmc-skill-hub"), "UI capability chain should not expose raw extension ids")

    let strictContract = uiContract.strictLoopOpsContract(status: .saved)
    let userFacingText = (strictContract.inputBindings.map(\.label)
        + strictContract.userFacingCapabilityChain.flatMap { [$0.title, $0.summary] }
        + [
            strictContract.name,
            strictContract.goal,
            strictContract.trigger,
            strictContract.feedbackGate,
            strictContract.exitCondition,
            strictContract.reviewBoundary,
            strictContract.outputShape
        ])
        .joined(separator: " ")

    loopOpsRequire(!userFacingText.contains("cmc-market-radar"), "strict user-facing fields should not expose raw skill ids")
    loopOpsRequire(!userFacingText.contains("cmc-skill-hub"), "strict user-facing fields should not expose raw extension ids")
    loopOpsRequire(strictContract.templateMigration?.legacySkillIDs == template.defaultSkillIDs, "strict bridge should keep launch skill ids in migration metadata")
    loopOpsRequire(strictContract.templateMigration?.legacyExtensionIDs == template.defaultExtensionIDs, "strict bridge should keep launch extension ids in migration metadata")

    let data = try! JSONEncoder.agentArtifactEncoder().encode(strictContract)
    let decodedStrict = try! JSONDecoder.agentArtifactDecoder().decode(LoopOpsLoopContract.self, from: data)
    let decodedUI = LoopContract.from(strictLoopOpsContract: decodedStrict)
    loopOpsRequire(decodedUI == uiContract, "UI contract should round-trip through strict LoopOps JSON")
    loopOpsRequire(decodedUI.knowledgeSourceIDs == ["knowledge-bridge-test"], "strict LoopOps JSON should preserve contract knowledge bindings")
    loopOpsRequire(decodedUI.skillStackID == "skill-stack-bridge-test", "strict LoopOps JSON should preserve Loop-to-Skill-Stack binding")
}

func checkLoopOpsLocalStoreStrictSnapshotsPreserveUILoopContracts() {
    let template = WorkbenchLoopTemplate.all.first { $0.id == "crypto-market-report-loop" }!
    let now = ISO8601DateFormatter().date(from: "2026-06-22T00:00:00Z")!
    let uiContract = LoopContract.from(template: template, now: now)
    let snapshots = LoopOpsLocalStore.strictLoopContractSnapshots(from: [uiContract])

    loopOpsRequire(snapshots.count == 1, "strict snapshot helper should convert one UI contract")
    loopOpsRequire(snapshots[0].status == .saved, "strict snapshots should be marked saved")
    loopOpsRequire(LoopContract.from(strictLoopOpsContract: snapshots[0]) == uiContract, "strict snapshot should preserve lightweight UI behavior")
    loopOpsRequire(!snapshots[0].userFacingCapabilityChain.map(\.title).joined(separator: " ").contains("cmc-market-radar"), "strict snapshot titles should hide raw skill ids")
}

func checkLoopOpsSkillBindingsDecodeAndRoundTrip() throws {
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
    loopOpsRequire(decoded.skillBindings.count == 3, "legacy contracts should synthesize ordered skill bindings")
    loopOpsRequire(decoded.knowledgeSourceIDs.isEmpty, "legacy contracts should decode without knowledge bindings")
    loopOpsRequire(decoded.skillStackID == nil, "legacy contracts should decode without a Skill Stack link")
    loopOpsRequire(decoded.orderedSkillIDs == ["cmc-market-radar", "market-regime-review"], "ordered skill ids should come from synthesized bindings")
    loopOpsRequire(decoded.orderedExtensionIDs == ["cmc-skill-hub"], "ordered extension ids should come from synthesized bindings")

    let stack = LoopOpsSkillStack(
        id: "stack-test",
        name: "Test Stack",
        summary: "A reusable stack.",
        bindings: decoded.skillBindings
    )
    let stackData = try JSONEncoder.agentArtifactEncoder().encode(stack)
    let roundTripped = try JSONDecoder.agentArtifactDecoder().decode(LoopOpsSkillStack.self, from: stackData)
    loopOpsRequire(roundTripped == stack, "skill stack should round-trip through JSON")

    let extensionOnly = decoded.replacingSkillBindings([
        LoopOpsSkillBinding(kind: .extensionPackage, id: "cmc-skill-hub", title: "CMC Skill Hub capability", order: 0, source: "test")
    ])
    loopOpsRequire(extensionOnly.orderedSkillIDs.isEmpty, "explicit extension-only path should not revive legacy skill ids")
    loopOpsRequire(extensionOnly.orderedExtensionIDs == ["cmc-skill-hub"], "explicit extension-only path should keep package id")

    var draft = LoopContractDraft.from(contract: decoded)
    draft.skillStackID = stack.id
    let materialized = draft.materialize(existing: decoded)
    loopOpsRequire(materialized.skillStackID == stack.id, "Loop Contract draft should persist the selected Skill Stack id")
}

func checkLoopOpsPromptIncludesOrderedSkillPath() {
    let template = WorkbenchLoopTemplate.all.first { $0.id == "crypto-market-report-loop" }!
    var contract = LoopContract.from(template: template)
    contract.knowledgeSourceIDs = ["knowledge-market-notes"]
    let prompt = contract.promptForRun(additionalInstruction: "Explain gaps.")

    loopOpsRequire(prompt.contains("Skill Path："), "run prompt should include ordered skill path")
    loopOpsRequire(prompt.contains("Inputs："), "run prompt should include input bindings")
    loopOpsRequire(prompt.contains("Knowledge Scope：knowledge-market-notes"), "run prompt should include bound knowledge scope")
    loopOpsRequire(prompt.contains("CoinMarketCap market radar -> Market regime review -> CMC Skill Hub capability"), "skill path should preserve user-facing order")
    loopOpsRequire(prompt.contains("本轮追加指令：Explain gaps."), "prompt should include follow-up instruction")
}

func checkLoopOpsContractCopyPreservesSkillBindingOrder() {
    let template = WorkbenchLoopTemplate.all.first { $0.id == "crypto-market-report-loop" }!
    let contract = LoopContract.from(template: template)
        .replacingSkillBindings([
            LoopOpsSkillBinding(kind: .extensionPackage, id: "cmc-skill-hub", title: "CMC Skill Hub capability", order: 0, source: "test"),
            LoopOpsSkillBinding(kind: .skill, id: "market-regime-review", title: "Market regime review", order: 1, source: "test"),
            LoopOpsSkillBinding(kind: .skill, id: "cmc-market-radar", title: "CoinMarketCap market radar", order: 2, source: "test")
        ])

    var clone = contract
    clone.id = "loop-copy"
    clone.name = "\(contract.name) Copy"
    clone.version = 1

    loopOpsRequire(clone.orderedSkillBindings.map(\.id) == ["cmc-skill-hub", "market-regime-review", "cmc-market-radar"], "contract copy should preserve skill binding order")
    loopOpsRequire(clone.orderedSkillIDs == ["market-regime-review", "cmc-market-radar"], "contract copy should preserve runtime skill id order")
    loopOpsRequire(clone.orderedExtensionIDs == ["cmc-skill-hub"], "contract copy should preserve runtime extension id order")
    checkLoopOpsBuilderDraftPatchParsesStructuredInstruction()
    checkLoopContractDraftAppliesBuilderInstructionPatch()
    checkLoopContractDraftAppliesNaturalLanguageChineseInstruction()
    checkLoopContractDraftInfersUnstructuredChineseInstruction()
    checkLoopContractDraftInfersUnstructuredEnglishInstruction()
    checkLoopOpsBuilderDraftPatchReceiptExplainsMatchedAndUnmatchedInstructions()
    checkLoopContractDraftReplacesExplicitBuilderSkillPath()
}

func checkLoopOpsSkillBindingCurrentOrderNormalizationSupportsPathMoves() {
    let bindings = [
        LoopOpsSkillBinding(kind: .skill, id: "cmc-market-radar", title: "CoinMarketCap market radar", order: 0, source: "test"),
        LoopOpsSkillBinding(kind: .extensionPackage, id: "cmc-skill-hub", title: "CMC Skill Hub capability", order: 1, source: "test"),
        LoopOpsSkillBinding(kind: .skill, id: "market-regime-review", title: "Market regime review", order: 2, source: "test")
    ]
    var moved = LoopOpsSkillBinding.ordered(bindings)
    moved.swapAt(0, 1)

    let normalizedMove = LoopOpsSkillBinding.normalizeCurrentOrder(moved)
    loopOpsRequire(
        normalizedMove.map(\.id) == ["cmc-skill-hub", "cmc-market-radar", "market-regime-review"],
        "current-order normalization should preserve the user-arranged execution path"
    )
    loopOpsRequire(normalizedMove.map(\.order) == [0, 1, 2], "current-order normalization should rewrite contiguous order values")
    loopOpsRequire(
        LoopOpsSkillBinding.ordered(moved).map(\.id) == ["cmc-market-radar", "cmc-skill-hub", "market-regime-review"],
        "sorting by stale order would undo a move and must not be used for path move persistence"
    )

    let stack = LoopOpsSkillStack(
        id: "normalized-move-stack",
        name: "Normalized Move Stack",
        summary: "Saved after a path move.",
        bindings: normalizedMove
    )
    loopOpsRequire(
        stack.bindings.map(\.id) == ["cmc-skill-hub", "cmc-market-radar", "market-regime-review"],
        "skill stacks should persist the normalized path order after move controls"
    )

    let selfDrop = LoopOpsSkillPathDropResolver.insert(
        bindings[1],
        before: bindings[1].dragID,
        into: bindings
    )
    loopOpsRequire(
        selfDrop.map(\.id) == ["cmc-market-radar", "cmc-skill-hub", "market-regime-review"],
        "dropping a skill path row onto itself should be a no-op"
    )
}

func checkLoopOpsBuilderDraftPatchParsesStructuredInstruction() {
    let patch = LoopOpsBuilderDraftPatch(
        instruction: """
        name: Daily BTC Review
        trigger: 每天早上 9 点
        input bindings: Watchlist; CMC evidence
        steps: 1. Ingest watchlist context; 2. Check stale CMC evidence; 3. Draft review memo
        feedback gate: Wait for analyst approval when evidence is stale
        review boundary: Review-only, no external publish
        exit condition: Stop after a review-ready memo has no open evidence gaps
        output shape: Markdown table plus three bullets
        Use CMC Skill Hub capability, CoinMarketCap market radar, CMC Skill Hub capability, then Market regime review.
        """,
        packages: loopOpsBuilderTestPackages()
    )

    loopOpsRequire(patch.stepMode == .replace, "explicit steps should replace the current step list")
    loopOpsRequire(patch.name == "Daily BTC Review", "builder patch should parse loop name")
    loopOpsRequire(patch.trigger == "每天早上 9 点", "builder patch should parse trigger")
    loopOpsRequire(patch.inputBindings == ["Watchlist", "CMC evidence"], "builder patch should parse input bindings")
    loopOpsRequire(
        patch.steps == [
            "Ingest watchlist context",
            "Check stale CMC evidence",
            "Draft review memo"
        ],
        "builder patch should parse numbered step text"
    )
    loopOpsRequire(patch.feedbackGate == "Wait for analyst approval when evidence is stale", "builder patch should parse feedback gate")
    loopOpsRequire(patch.reviewBoundary == "Review-only, no external publish", "builder patch should parse review boundary")
    loopOpsRequire(patch.exitCondition == "Stop after a review-ready memo has no open evidence gaps", "builder patch should parse exit condition")
    loopOpsRequire(patch.outputShape == "Markdown table plus three bullets", "builder patch should parse output shape")
    loopOpsRequire(
        patch.skillBindings.map(\.id) == ["cmc-skill-hub", "cmc-market-radar", "market-regime-review"],
        "builder patch should match skill packages in mention order without duplicates"
    )
    loopOpsRequire(patch.skillBindings.map(\.order) == [0, 1, 2], "matched bindings should be normalized to ordered positions")
    loopOpsRequire(patch.skillPathMode == .append, "freeform skill mentions should append to the current path")
    loopOpsRequire(patch.receiptStatus == "Structured patch staged", "builder patch receipt should report staged status before apply")
    loopOpsRequire(patch.receiptText.contains("Steps replaced: 3"), "builder patch receipt should summarize step replacement")
    loopOpsRequire(patch.receiptEvidence.contains("trigger=updated"), "builder patch receipt should expose trigger evidence")
    loopOpsRequire(patch.receiptEvidence.contains("skill_path=3"), "builder patch receipt should expose skill path evidence")
    loopOpsRequire(patch.receiptEvidence.contains("skill_path_mode=append"), "builder patch receipt should expose skill path mode")
}

func checkLoopOpsBuilderDraftPatchReceiptExplainsMatchedAndUnmatchedInstructions() {
    let matched = LoopOpsBuilderDraftPatch(
        instruction: """
        steps: Collect inputs; Draft review packet
        output shape: Final answer and evidence gaps
        Use CoinMarketCap market radar.
        """,
        packages: loopOpsBuilderTestPackages()
    )

    loopOpsRequire(matched.receiptLines.contains("Steps replaced: 2"), "matched receipt should include parsed step count")
    loopOpsRequire(matched.receiptText.contains("Output shape: Final answer and evidence gaps"), "matched receipt should include output shape")
    loopOpsRequire(matched.receiptEvidence.contains("output_shape=updated"), "matched receipt evidence should include updated output shape")

    let unmatched = LoopOpsBuilderDraftPatch(
        instruction: "请帮我优化一下。",
        packages: loopOpsBuilderTestPackages()
    )
    loopOpsRequire(unmatched.hasChanges, "single freeform instruction still appends as a visible step")
    loopOpsRequire(unmatched.receiptText.contains("Steps appended: 1"), "freeform fallback receipt should explain appended step")

    let empty = LoopOpsBuilderDraftPatch(
        instruction: "",
        packages: loopOpsBuilderTestPackages()
    )
    loopOpsRequire(!empty.hasChanges, "empty instruction should not produce changes")
    loopOpsRequire(empty.receiptStatus == "No structured fields matched", "empty receipt should report no structured fields")
    loopOpsRequire(empty.receiptText.contains("Try name:"), "empty receipt should guide the next builder instruction")
}

func checkLoopOpsBuilderPacketLifecycleRequiresApplyBeforeMutation() {
    var draft = LoopContractDraft(
        id: "draft-builder-packet-test",
        name: "Builder Packet Test Loop",
        domain: .crypto,
        goal: "Review market evidence.",
        trigger: "Manual",
        inputBindingsText: "Workspace context",
        capabilityChainText: "CoinMarketCap market radar",
        skillBindings: [
            LoopOpsSkillBinding(kind: .skill, id: "cmc-market-radar", title: "CoinMarketCap market radar", order: 0, source: "test")
        ],
        stepSummaryText: "Collect inputs",
        feedbackGate: "Human review.",
        exitCondition: "Final answer.",
        reviewBoundary: "Review-only.",
        outputShape: "Summary.",
        prompt: "Run."
    )
    let originalSteps = draft.stepSummaryText
    let patch = LoopOpsBuilderDraftPatch(
        instruction: """
        steps: Collect inputs; Draft review packet
        output shape: Final answer and evidence gaps
        Use CoinMarketCap market radar, then Market regime review.
        """,
        packages: loopOpsBuilderTestPackages()
    )
    var packet = LoopOpsBuilderPacket(
        contractID: draft.id,
        instruction: "Update the builder path",
        patch: patch
    )

    loopOpsRequire(packet.status == .pending, "builder packet should start pending")
    loopOpsRequire(draft.stepSummaryText == originalSteps, "pending builder packet should leave the visible draft unchanged")
    loopOpsRequire(packet.diffRows.contains { $0.contains("Steps replaced") }, "builder packet should expose diff rows before apply")

    draft.apply(packet.patch)
    packet = packet.updating(status: .applied)
    loopOpsRequire(packet.status == .applied, "applied packet should record applied state")
    loopOpsRequire(draft.stepSummaryText == "Collect inputs\nDraft review packet", "apply should mutate the draft only after explicit action")
    loopOpsRequire(draft.outputShape == "Final answer and evidence gaps", "apply should update output shape")
    packet = packet.updating(status: .saved)
    loopOpsRequire(packet.status == .saved, "saved packet should record saved state after Save Loop")
}

func checkLoopContractDraftSkillStackLinkTracksExactPath() {
    var draft = LoopContractDraft(
        id: "draft-skill-stack-link-test",
        name: "Skill Stack Link Test Loop",
        domain: .crypto,
        goal: "Review market evidence.",
        trigger: "Manual",
        inputBindingsText: "Current workspace context",
        capabilityChainText: "",
        skillBindings: [],
        stepSummaryText: "Collect inputs",
        feedbackGate: "Human review.",
        exitCondition: "Final answer.",
        reviewBoundary: "Review-only.",
        outputShape: "Summary.",
        prompt: "Run."
    )
    let stack = LoopOpsSkillStack(
        id: "skill-stack-exact-link-test",
        name: "Exact Review Stack",
        summary: "Radar then review.",
        bindings: [
            LoopOpsSkillBinding(kind: .skill, id: "cmc-market-radar", title: "CoinMarketCap market radar", order: 0, source: "test"),
            LoopOpsSkillBinding(kind: .skill, id: "market-regime-review", title: "Market regime review", order: 1, source: "test")
        ]
    )

    draft.applySkillStack(stack)
    loopOpsRequire(draft.skillStackID == stack.id, "applying a Skill Stack should link the draft to that exact saved stack")
    loopOpsRequire(draft.skillBindings.map(\.id) == ["cmc-market-radar", "market-regime-review"], "applying a Skill Stack should materialize the ordered path")

    draft.applyCustomSkillBindings([
        LoopOpsSkillBinding(kind: .skill, id: "market-regime-review", title: "Market regime review", order: 0, source: "test")
    ])
    loopOpsRequire(draft.skillStackID == nil, "custom path edits should clear stale Skill Stack links")
    loopOpsRequire(draft.capabilityChainText == "Market regime review", "custom path edits should keep visible path notes in sync")
}

func checkLoopOpsBuilderDraftPatchAppliesSkillAndKnowledgeCommands() {
    let knowledge = LoopOpsKnowledgeSource(
        id: "knowledge-market-evidence-notes",
        title: "Market evidence notes",
        kind: .blank,
        summary: "Reusable market evidence context.",
        status: .ready,
        reuseMode: .attachToLoop,
        sourceLabel: "Manual note"
    )
    var draft = LoopContractDraft(
        id: "draft-builder-skill-command-test",
        name: "Builder Skill Command Test Loop",
        domain: .crypto,
        goal: "Review market evidence.",
        trigger: "Manual",
        inputBindingsText: "Current workspace context",
        capabilityChainText: "CoinMarketCap market radar\nCMC Skill Hub capability\nMarket regime review",
        skillBindings: [
            LoopOpsSkillBinding(kind: .skill, id: "cmc-market-radar", title: "CoinMarketCap market radar", order: 0, source: "test"),
            LoopOpsSkillBinding(kind: .extensionPackage, id: "cmc-skill-hub", title: "CMC Skill Hub capability", order: 1, enabled: false, source: "test"),
            LoopOpsSkillBinding(kind: .skill, id: "market-regime-review", title: "Market regime review", order: 2, source: "test")
        ],
        stepSummaryText: "Collect inputs",
        feedbackGate: "Human review.",
        exitCondition: "Final answer.",
        reviewBoundary: "Review-only.",
        outputShape: "Summary.",
        prompt: "Run.",
        skillStackID: "skill-stack-stale-link"
    )

    let patch = LoopOpsBuilderDraftPatch(
        instruction: """
        remove skill: Market regime review
        disable skill: CoinMarketCap market radar
        enable skill: CMC Skill Hub capability
        attach knowledge: Market evidence notes
        """,
        packages: loopOpsBuilderTestPackages(),
        knowledgeSources: [knowledge]
    )

    loopOpsRequire(patch.skillBindings.isEmpty, "remove and disable commands should not be reinterpreted as additive skill path mentions")
    loopOpsRequire(patch.removedSkillBindings.map(\.id) == ["market-regime-review"], "builder patch should parse skill removal commands")
    loopOpsRequire(patch.disabledSkillBindings.map(\.id) == ["cmc-market-radar"], "builder patch should parse skill disable commands")
    loopOpsRequire(patch.enabledSkillBindings.map(\.id) == ["cmc-skill-hub"], "builder patch should parse skill enable commands")
    loopOpsRequire(patch.knowledgeSourceIDs == [knowledge.id], "builder patch should attach ready knowledge by visible title")

    draft.apply(patch)
    loopOpsRequire(draft.skillStackID == nil, "path mutation commands should clear stale Skill Stack links")
    loopOpsRequire(draft.skillBindings.map(\.id) == ["cmc-market-radar", "cmc-skill-hub"], "remove command should delete the selected skill and normalize order")
    loopOpsRequire(draft.skillBindings.first { $0.id == "cmc-market-radar" }?.enabled == false, "disable command should turn off the selected skill")
    loopOpsRequire(draft.skillBindings.first { $0.id == "cmc-skill-hub" }?.enabled == true, "enable command should turn on the selected package")
    loopOpsRequire(draft.knowledgeSourceIDs == [knowledge.id], "knowledge command should persist the selected source on the draft")
    loopOpsRequire(patch.receiptEvidence.contains("skill_disable=1"), "receipt evidence should expose disabled skill count")
    loopOpsRequire(patch.receiptEvidence.contains("knowledge=1"), "receipt evidence should expose knowledge attachment count")
}

func checkLoopOpsBuilderPacketsPersistByContract() {
    MainActor.assumeIsolated {
        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let strictStore = LoopOpsLocalJSONStore(root: root.appendingPathComponent("strict", isDirectory: true))
        let patch = LoopOpsBuilderDraftPatch(
            instruction: """
            trigger: Weekdays at 09:00
            steps: Collect context; Draft review packet
            Use CoinMarketCap market radar.
            """,
            packages: loopOpsBuilderTestPackages()
        )
        let packet = LoopOpsBuilderPacket(
            id: "builder-packet-persist-test",
            contractID: "contract-a",
            instruction: "Update trigger and path",
            patch: patch
        )

        let store = LoopOpsLocalStore(
            rootURL: root.appendingPathComponent("light", isDirectory: true),
            seedTemplates: false,
            strictJSONStore: strictStore
        )
        store.upsertBuilderPacket(packet)
        loopOpsRequire(
            store.builderPackets(forContractID: "contract-a").map(\.id) == [packet.id],
            "builder packets should be queryable by contract id"
        )
        loopOpsRequire(
            store.builderPackets(forContractID: "contract-b").isEmpty,
            "builder packets should not leak into another contract"
        )

        let applied = store.updateBuilderPacket(id: packet.id, status: .applied)
        loopOpsRequire(applied?.status == .applied, "builder packet status updates should return the updated packet")
        loopOpsRequire(
            strictStore.readSnapshot().builderPackets.map(\.id) == [packet.id],
            "strict JSON snapshot should mirror builder packets"
        )
        let reloaded = LoopOpsLocalStore(
            rootURL: root.appendingPathComponent("light", isDirectory: true),
            seedTemplates: false,
            strictJSONStore: strictStore
        )
        loopOpsRequire(
            reloaded.builderPackets(forContractID: "contract-a").first?.status == .applied,
            "builder packet status should persist after store reload"
        )

        reloaded.reassignBuilderPackets(from: "contract-a", to: "contract-b")
        let reassigned = LoopOpsLocalStore(
            rootURL: root.appendingPathComponent("light", isDirectory: true),
            seedTemplates: false,
            strictJSONStore: strictStore
        )
        loopOpsRequire(
            reassigned.builderPackets(forContractID: "contract-a").isEmpty,
            "builder packet reassignment should remove the previous draft scope"
        )
        loopOpsRequire(
            reassigned.builderPackets(forContractID: "contract-b").map(\.id) == [packet.id],
            "builder packet reassignment should preserve packet order and id"
        )
    }
}

func checkLoopContractDraftAppliesBuilderInstructionPatch() {
    var draft = LoopContractDraft(
        id: "draft-builder-test",
        name: "Builder Test Loop",
        domain: .crypto,
        goal: "Track market evidence quality.",
        trigger: "Manual",
        inputBindingsText: "Current workspace context",
        capabilityChainText: "CoinMarketCap market radar",
        skillBindings: [
            LoopOpsSkillBinding(kind: .skill, id: "cmc-market-radar", title: "CoinMarketCap market radar", order: 0, source: "test")
        ],
        stepSummaryText: "Collect current context",
        feedbackGate: "Review if evidence is unclear.",
        exitCondition: "Stop after draft.",
        reviewBoundary: "review-only",
        outputShape: "Short memo",
        prompt: "Build the loop."
    )

    let patch = draft.applyBuilderInstruction(
        """
        name: Evidence Quality Loop
        trigger: every weekday at 09:00
        inputs: Watchlist; CMC evidence
        add step: Compare stale evidence against reviewer notes
        feedback gate: Wait for analyst sign-off before finalizing
        exit condition: Finish when the memo has no unresolved evidence gaps
        review boundary: Review-only; block external publishing
        output: One-page markdown brief with evidence table
        Use Market regime review, CMC Skill Hub capability, CoinMarketCap market radar, and CMC Skill Hub capability.
        """,
        packages: loopOpsBuilderTestPackages()
    )

    loopOpsRequire(patch.stepMode == .append, "add step instructions should append")
    loopOpsRequire(draft.name == "Evidence Quality Loop", "builder instruction should update loop name")
    loopOpsRequire(draft.trigger == "every weekday at 09:00", "builder instruction should update trigger")
    loopOpsRequire(draft.inputBindingsText == "Watchlist\nCMC evidence", "builder instruction should update input bindings")
    loopOpsRequire(
        loopOpsLines(draft.stepSummaryText) == [
            "Collect current context",
            "Compare stale evidence against reviewer notes"
        ],
        "builder instruction should append a unique step"
    )
    loopOpsRequire(draft.feedbackGate == "Wait for analyst sign-off before finalizing", "builder instruction should update feedback gate")
    loopOpsRequire(draft.exitCondition == "Finish when the memo has no unresolved evidence gaps", "builder instruction should update exit condition")
    loopOpsRequire(draft.reviewBoundary == "Review-only; block external publishing", "builder instruction should update review boundary")
    loopOpsRequire(draft.outputShape == "One-page markdown brief with evidence table", "builder instruction should update output shape")
    loopOpsRequire(
        draft.skillBindings.map(\.id) == ["market-regime-review", "cmc-skill-hub", "cmc-market-radar"],
        "builder instruction should reorder mentioned skills and packages without duplicates"
    )
    loopOpsRequire(
        loopOpsLines(draft.capabilityChainText) == ["Market regime review", "CMC Skill Hub capability", "CoinMarketCap market radar"],
        "capability chain text should mirror ordered skill bindings"
    )

    let contract = draft.materialize()
    loopOpsRequire(
        contract.orderedSkillBindings.map(\.id) == ["market-regime-review", "cmc-skill-hub", "cmc-market-radar"],
        "materialized contract should preserve builder skill path order"
    )
    loopOpsRequire(contract.orderedSkillIDs == ["market-regime-review", "cmc-market-radar"], "runtime skill ids should preserve skill-only order")
    loopOpsRequire(contract.orderedExtensionIDs == ["cmc-skill-hub"], "runtime extension ids should preserve extension order")
}

func checkLoopContractDraftReplacesExplicitBuilderSkillPath() {
    var draft = LoopContractDraft(
        id: "draft-builder-replace-path-test",
        name: "Replace Path Test Loop",
        domain: .crypto,
        goal: "Track market evidence quality.",
        trigger: "Manual",
        inputBindingsText: "Current workspace context",
        capabilityChainText: "CoinMarketCap market radar\nCMC Skill Hub capability\nMarket regime review",
        skillBindings: [
            LoopOpsSkillBinding(kind: .skill, id: "cmc-market-radar", title: "CoinMarketCap market radar", order: 0, source: "test"),
            LoopOpsSkillBinding(kind: .extensionPackage, id: "cmc-skill-hub", title: "CMC Skill Hub capability", order: 1, source: "test"),
            LoopOpsSkillBinding(kind: .skill, id: "market-regime-review", title: "Market regime review", order: 2, source: "test")
        ],
        stepSummaryText: "Collect current context",
        feedbackGate: "Review if evidence is unclear.",
        exitCondition: "Stop after draft.",
        reviewBoundary: "Review-only.",
        outputShape: "Summary.",
        prompt: "Run."
    )

    let patch = LoopOpsBuilderDraftPatch(
        instruction: "skill path: Market regime review -> CMC Skill Hub capability",
        packages: loopOpsBuilderTestPackages()
    )
    loopOpsRequire(patch.skillPathMode == .replace, "explicit skill path field should replace the current path")

    draft.apply(patch)
    loopOpsRequire(
        draft.skillBindings.map(\.id) == ["market-regime-review", "cmc-skill-hub"],
        "explicit skill path patch should remove unmentioned existing skills"
    )
    loopOpsRequire(
        draft.capabilityChainText == "Market regime review\nCMC Skill Hub capability",
        "capability chain text should mirror the replaced path"
    )
}

func checkLoopContractDraftAppliesNaturalLanguageChineseInstruction() {
    var draft = LoopContractDraft(
        id: "draft-builder-zh-test",
        name: "中文 Builder Loop",
        domain: .crypto,
        goal: "复核 crypto market report。",
        trigger: "Manual",
        inputBindingsText: "Current workspace context",
        capabilityChainText: "CoinMarketCap market radar",
        skillBindings: [
            LoopOpsSkillBinding(kind: .skill, id: "cmc-market-radar", title: "CoinMarketCap market radar", order: 0, source: "test")
        ],
        stepSummaryText: "Collect current context",
        feedbackGate: "Review if evidence is unclear.",
        exitCondition: "Stop after draft.",
        reviewBoundary: "review-only",
        outputShape: "Short memo",
        prompt: "Build the loop."
    )

    let patch = draft.applyBuilderInstruction(
        """
        步骤：先读取大盘 regime，然后跑 perp scanner，再检查 on-chain scanner，最后输出 review packet
        调用顺序：CoinMarketCap market radar -> CMC Skill Hub capability -> Market regime review
        反馈：数据 stale 或证据不足时等待人工确认
        退出条件：review packet 没有开放证据缺口后停止
        输出格式：中文 final answer、evidence gaps、下一轮问题
        """,
        packages: loopOpsBuilderTestPackages()
    )

    loopOpsRequire(patch.stepMode == .replace, "Chinese builder instruction should replace explicit step field")
    loopOpsRequire(
        patch.steps == [
            "读取大盘 regime",
            "跑 perp scanner",
            "检查 on-chain scanner",
            "输出 review packet"
        ],
        "Chinese builder instruction should split natural sequencing words into visible steps"
    )
    loopOpsRequire(
        draft.skillBindings.map(\.id) == ["cmc-market-radar", "cmc-skill-hub", "market-regime-review"],
        "Chinese builder instruction should preserve explicit skill call order"
    )
    loopOpsRequire(draft.feedbackGate == "数据 stale 或证据不足时等待人工确认", "Chinese builder instruction should update feedback gate")
    loopOpsRequire(draft.exitCondition == "review packet 没有开放证据缺口后停止", "Chinese builder instruction should update exit condition")
    loopOpsRequire(draft.outputShape == "中文 final answer、evidence gaps、下一轮问题", "Chinese builder instruction should update output shape")

    let contract = draft.materialize()
    loopOpsRequire(
        contract.promptForRun().contains("Skill Path：CoinMarketCap market radar -> CMC Skill Hub capability -> Market regime review"),
        "materialized Chinese builder contract should carry ordered skill path into the run prompt"
    )
    loopOpsRequire(contract.orderedSkillIDs == ["cmc-market-radar", "market-regime-review"], "runtime skill ids should keep Chinese builder order")
    loopOpsRequire(contract.orderedExtensionIDs == ["cmc-skill-hub"], "runtime extension ids should keep Chinese builder package order")
}

func checkLoopContractDraftInfersUnstructuredChineseInstruction() {
    var draft = LoopContractDraft(
        id: "draft-builder-zh-freeform-test",
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
        packages: loopOpsBuilderTestPackages()
    )

    loopOpsRequire(patch.stepMode == .replace, "freeform Chinese sequencing should replace the visible step list")
    loopOpsRequire(
        loopOpsLines(draft.stepSummaryText) == [
            "CoinMarketCap market radar",
            "CMC Skill Hub capability",
            "Market regime review",
            "输出 review packet"
        ],
        "freeform Chinese sequencing should infer visible steps without requiring field labels"
    )
    loopOpsRequire(
        draft.skillBindings.map(\.id) == ["cmc-market-radar", "cmc-skill-hub", "market-regime-review"],
        "freeform Chinese instruction should infer skill path order from package mentions"
    )
    loopOpsRequire(draft.feedbackGate == "如果证据不足就等待人工确认", "freeform Chinese instruction should infer feedback gate from conditional review wording")
    loopOpsRequire(draft.exitCondition == "review packet 没有开放证据缺口", "freeform Chinese instruction should infer exit condition from completion wording")
    loopOpsRequire(draft.outputShape == "中文 final answer 和 evidence gap table", "freeform Chinese instruction should infer output shape from output wording")

    let contract = draft.materialize()
    loopOpsRequire(
        contract.promptForRun().contains("Skill Path：CoinMarketCap market radar -> CMC Skill Hub capability -> Market regime review"),
        "freeform Chinese contract should carry inferred ordered skill path into the run prompt"
    )
}

func checkLoopContractDraftInfersUnstructuredEnglishInstruction() {
    var draft = LoopContractDraft(
        id: "draft-builder-en-freeform-test",
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
        packages: loopOpsBuilderTestPackages()
    )

    loopOpsRequire(patch.stepMode == .replace, "freeform English sequencing should replace the visible step list")
    loopOpsRequire(
        loopOpsLines(draft.stepSummaryText) == [
            "CoinMarketCap market radar",
            "CMC Skill Hub capability",
            "Market regime review",
            "output a review packet"
        ],
        "freeform English sequencing should infer visible steps without preserving sequencing filler"
    )
    loopOpsRequire(
        draft.skillBindings.map(\.id) == ["cmc-market-radar", "cmc-skill-hub", "market-regime-review"],
        "freeform English instruction should infer skill path order from package mentions"
    )
    loopOpsRequire(draft.feedbackGate == "if evidence is stale wait for analyst confirmation", "freeform English instruction should infer review rule from conditional wording")
    loopOpsRequire(draft.exitCondition == "the review packet has no open evidence gaps", "freeform English instruction should infer exit condition from stop wording")
    loopOpsRequire(draft.outputShape == "an English final answer and evidence gap table", "freeform English instruction should infer output shape from output-as wording")

    let contract = draft.materialize()
    loopOpsRequire(
        contract.promptForRun().contains("Skill Path：CoinMarketCap market radar -> CMC Skill Hub capability -> Market regime review"),
        "freeform English contract should carry inferred ordered skill path into the run prompt"
    )
}

func checkLoopOpsPublicSkillPolicyHidesInternalPackages() {
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
    let hiddenStatus = LoopOpsSkillPackage(
        kind: .skill,
        id: "loop-runtime-diagnostics",
        title: "Loop Runtime Diagnostics",
        description: "Internal diagnostics.",
        status: "hidden",
        selected: false,
        category: "research"
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

    loopOpsRequire(cmc.isWorkbenchVisible, "Skill OS should show public read-only evidence packages")
    loopOpsRequire(!channel.isWorkbenchVisible, "Skill OS should hide outbound channel packages by schema category")
    loopOpsRequire(!provider.isWorkbenchVisible, "Skill OS should hide provider/gate internals by schema category")
    loopOpsRequire(!hiddenStatus.isWorkbenchVisible, "Skill OS should hide packages marked hidden by status")
    loopOpsRequire(!unknownCategory.isWorkbenchVisible, "Skill OS should hide packages outside the public category allowlist")
    loopOpsRequire(!memory.isWorkbenchVisible, "Skill OS should hide memory packages from the public workspace")
    loopOpsRequire(legacyUncategorized.isWorkbenchVisible, "Skill OS should keep legacy public manifests with no category after safety filters pass")
}

func checkLoopOpsToolDraftsBecomeSkillOSPackages() {
    MainActor.assumeIsolated {
        let viewModel = DashboardViewModel()
        let draft = LoopOpsToolDraft(
            id: "tool-draft-local-review",
            name: "Local Review Tool",
            purpose: "Draft evidence gaps from a run result.",
            integrationSource: "Local Tool",
            inputScope: "Run context",
            inputs: ["Run result", "Knowledge source"],
            visibleSteps: ["Collect context", "Check claims", "Write review packet"],
            outputShape: "Review packet",
            reviewPolicy: "Review-only"
        )

        let packages = LoopOpsSkillPackage.packages(from: viewModel, toolDrafts: [draft])
        guard let package = packages.first(where: { $0.id == draft.id }) else {
            preconditionFailure("tool draft should become a Skill OS package")
        }

        loopOpsRequire(package.title == "Local Review Tool", "tool draft package should keep draft name")
        loopOpsRequire(package.status == "Draft", "tool draft package should expose draft status")
        loopOpsRequire(package.category == "Local Tool", "tool draft package should be marked as a local tool")
        loopOpsRequire(package.domainLabel == "Local", "tool draft package should remain local by default")
        loopOpsRequire(package.description.contains("Run context"), "tool draft package should expose structured input scope")
        loopOpsRequire(!viewModel.selectedAgentSkillIDs.contains(draft.id), "local tool drafts should not be selected as daemon skill ids")
        viewModel.toggleLoopOpsToolDraft(draft.id)
        loopOpsRequire(viewModel.selectedLoopOpsToolDraftIDs == Set([draft.id]), "local tool drafts should use the LoopOps local selection path")
        loopOpsRequire(package.binding(order: 0, source: "test").id == draft.id, "tool draft package should be draggable into a skill path")
    }
}

func checkLoopOpsLocalToolDraftLifecyclePersistsEnableAndDelete() {
    MainActor.assumeIsolated {
        let legacyJSON = """
        {
          "id": "legacy-tool-draft",
          "name": "Legacy Tool Draft",
          "purpose": "Decode before enabled existed.",
          "inputs": ["Run result"],
          "visibleSteps": ["Read result"],
          "outputShape": "Review packet",
          "reviewPolicy": "Review-only",
          "skillBindings": [],
          "createdAt": "2026-06-22T00:00:00.000Z",
          "updatedAt": "2026-06-22T00:00:00.000Z"
        }
        """.data(using: .utf8)!
        let legacyDraft = try! JSONDecoder.agentArtifactDecoder().decode(LoopOpsToolDraft.self, from: legacyJSON)
        loopOpsRequire(!legacyDraft.isEnabled, "legacy tool draft JSON should decode with disabled default")

        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = LoopOpsLocalStore(rootURL: root, seedTemplates: false)
        let draft = LoopOpsToolDraft(
            id: "tool-draft-lifecycle",
            name: "Lifecycle Tool",
            purpose: "Validate durable Skill OS lifecycle.",
            integrationSource: "Local Tool",
            inputScope: "Run context",
            inputs: ["Run result"],
            visibleSteps: ["Read result", "Write packet"],
            outputShape: "Review packet",
            reviewPolicy: "Review-only",
            skillBindings: [
                LoopOpsSkillBinding(kind: .skill, id: "cmc-market-radar", title: "CoinMarketCap market radar", order: 0, source: "test")
            ]
        )
        store.upsertToolDraft(draft)
        let enabled = store.setToolDraftEnabled(id: draft.id, enabled: true)
        loopOpsRequire(enabled?.isEnabled == true, "local tool draft enable state should update in memory")

        let stack = LoopOpsSkillStack(
            id: "stack-with-local-tool",
            name: "Stack With Local Tool",
            summary: "Includes a local tool draft.",
            bindings: [
                LoopOpsSkillBinding(kind: .skill, id: draft.id, title: draft.name, order: 0, source: "test"),
                LoopOpsSkillBinding(kind: .skill, id: "cmc-market-radar", title: "CoinMarketCap market radar", order: 1, source: "test")
            ]
        )
        store.upsertSkillStack(stack)

        let reloaded = LoopOpsLocalStore(rootURL: root, seedTemplates: false)
        loopOpsRequire(reloaded.toolDrafts.first?.isEnabled == true, "local tool draft enable state should persist after reload")
        loopOpsRequire(
            LoopOpsSkillPackage.packages(from: DashboardViewModel(), toolDrafts: reloaded.toolDrafts).first { $0.id == draft.id }?.selected == true,
            "Skill OS package selection should come from durable local tool state"
        )

        reloaded.deleteToolDraft(id: draft.id)
        loopOpsRequire(reloaded.toolDrafts.isEmpty, "deleted local tool draft should leave the Tool library")
        loopOpsRequire(
            reloaded.skillStacks.first(where: { $0.id == stack.id })?.bindings.map(\.id) == ["cmc-market-radar"],
            "deleting a local tool should remove stale bindings from saved Skill Stacks"
        )

        let afterDelete = LoopOpsLocalStore(rootURL: root, seedTemplates: false)
        loopOpsRequire(afterDelete.toolDrafts.isEmpty, "deleted local tool draft should stay deleted after reload")
        loopOpsRequire(
            afterDelete.skillStacks.first(where: { $0.id == stack.id })?.bindings.map(\.id) == ["cmc-market-radar"],
            "saved Skill Stacks should reload without deleted local tool bindings"
        )
    }
}

func checkLoopOpsLocalToolRunSelectionAndFollowUpsStayScoped() {
    MainActor.assumeIsolated {
        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let strictStore = LoopOpsLocalJSONStore(root: root.appendingPathComponent("strict", isDirectory: true))
        let store = LoopOpsLocalStore(
            rootURL: root.appendingPathComponent("light", isDirectory: true),
            seedTemplates: false,
            strictJSONStore: strictStore
        )
        let localDraft = LoopOpsToolDraft(
            id: "tool-draft-run-context",
            name: "Run Evidence Local Tool",
            purpose: "Review run evidence without becoming a daemon skill.",
            enabled: true,
            integrationSource: "Local Tool",
            inputScope: "Run result",
            inputs: ["Run result"],
            visibleSteps: ["Read final answer", "Write evidence gaps"],
            outputShape: "Review packet",
            reviewPolicy: "Review-only",
            skillBindings: [
                LoopOpsSkillBinding(kind: .skill, id: "cmc-market-radar", title: "CoinMarketCap market radar", order: 0, source: "test"),
                LoopOpsSkillBinding(kind: .extensionPackage, id: "cmc-skill-hub", title: "CMC Skill Hub capability", order: 1, source: "test")
            ]
        )
        store.upsertToolDraft(localDraft)

        let contract = LoopContract.from(template: WorkbenchLoopTemplate.templates(for: .crypto)[0])
            .replacingSkillBindings([
                LoopOpsSkillBinding(kind: .skill, id: localDraft.id, title: localDraft.name, order: 0, source: "studio"),
                LoopOpsSkillBinding(kind: .skill, id: "thesis-review", title: "Thesis review", order: 1, source: "studio")
            ])
        let selection = contract.resolvedRunSelection(toolDrafts: store.toolDrafts)
        loopOpsRequire(selection.localToolDrafts.map(\.id) == [localDraft.id], "run selection should preserve local tool drafts as local context")
        loopOpsRequire(selection.selectedSkillIDs == ["cmc-market-radar", "thesis-review"], "daemon skill ids should exclude local tool ids and include executable child skills")
        loopOpsRequire(selection.selectedExtensionIDs == ["cmc-skill-hub"], "daemon extension ids should include executable child extensions")
        loopOpsRequire(!selection.selectedSkillIDs.contains(localDraft.id), "local tool draft ids should never be submitted as daemon skill ids")

        store.appendMessage(scope: .run, scopeID: "parent-run", title: contract.name, role: .user, text: "Follow up on gaps.")
        store.recordFollowUpRun(parentRunID: "parent-run", childRunID: "child-run", title: contract.name)
        loopOpsRequire(store.existingThread(scope: .run, scopeID: "parent-run")?.followUpRunIDs == ["child-run"], "parent run chat should record child follow-up runs")

        let submittedLog = store.runLocalToolDraft(
            id: localDraft.id,
            inputValues: ["Run result": "Final answer with stale evidence."],
            runID: "parent-run"
        )
        loopOpsRequire(submittedLog?.status == "Submitting", "local tool use should start as a submitted log before daemon acknowledgement")
        loopOpsRequire(submittedLog?.runID == "parent-run", "submitted local tool log should stay linked to the active parent run while waiting")
        let acknowledgedLog = submittedLog.flatMap {
            store.acknowledgeToolLogRun(logID: $0.id, runID: "child-run", runTitle: contract.name)
        }
        loopOpsRequire(acknowledgedLog?.status == "Run scoped", "daemon acknowledgement should update the original tool log")
        loopOpsRequire(acknowledgedLog?.runID == "child-run", "acknowledged tool log should point to the child run result")
        loopOpsRequire(store.logs(forRunID: "child-run").map(\.id).contains(submittedLog?.id ?? ""), "child run log lookup should include the acknowledged Skill OS log")

        let failedSubmitLog = store.runLocalToolDraft(
            id: localDraft.id,
            inputValues: ["Run result": "Submission will fail."],
            runID: "parent-run"
        )
        let failedRunLog = failedSubmitLog.flatMap {
            store.failToolLogRun(logID: $0.id, errorMessage: "Daemon unavailable")
        }
        loopOpsRequire(failedRunLog?.status == "Failed", "daemon failure should update the original submitted tool log")
        loopOpsRequire(failedRunLog?.errorSummary == "Daemon unavailable", "failed tool log should retain the submit error for review")

        let reloaded = LoopOpsLocalStore(
            rootURL: root.appendingPathComponent("light", isDirectory: true),
            seedTemplates: false,
            strictJSONStore: strictStore
        )
        loopOpsRequire(reloaded.existingThread(scope: .run, scopeID: "parent-run")?.followUpRunIDs == ["child-run"], "follow-up run references should persist after reload")
        loopOpsRequire(reloaded.logs(forRunID: "child-run").map(\.id).contains(submittedLog?.id ?? ""), "acknowledged Skill OS tool log should persist with its child run link")
        loopOpsRequire(reloaded.toolLogs.first(where: { $0.id == submittedLog?.id })?.status == "Run scoped", "acknowledged Skill OS tool log status should persist after reload")
        loopOpsRequire(
            strictStore.readSnapshot().chatThreads.first(where: { $0.runID == "parent-run" })?.followUpRunReferences == ["child-run"],
            "strict chat thread should mirror follow-up run references"
        )
        loopOpsRequire(
            strictStore.readSnapshot().toolLogs.first(where: { $0.id == submittedLog?.id })?.runID == "child-run",
            "strict snapshot should mirror the acknowledged Skill OS run link"
        )
        loopOpsRequire(
            strictStore.readSnapshot().toolLogs.first(where: { $0.id == submittedLog?.id })?.status == "Run scoped",
            "strict snapshot should mirror the acknowledged Skill OS log status"
        )
    }
}

func checkLoopOpsToolLogCanonicalStatusAndReviewChatScope() {
    MainActor.assumeIsolated {
        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = LoopOpsLocalStore(rootURL: root, seedTemplates: false)

        let submitting = LoopOpsToolLog(
            toolID: "review-tool",
            title: "Review Tool submitted",
            status: "Submitting",
            summary: "Inputs passed local validation.",
            outputSummary: "Waiting for run confirmation.",
            durationLabel: "submitting",
            reviewState: "Waiting for run confirmation",
            source: "Skill OS"
        )
        let failed = LoopOpsToolLog(
            toolID: "review-tool",
            title: "Review Tool failed",
            status: "Failed",
            summary: "Tool run stopped before output.",
            inputSummary: "Evidence note: missing URL",
            errorSummary: "Missing required inputs: URL",
            durationLabel: "0s",
            reviewState: "Needs input",
            source: "Skill OS"
        )
        let runScoped = LoopOpsToolLog(
            toolID: "review-tool",
            title: "Review Tool acknowledged",
            status: "Run scoped",
            summary: "Background run acknowledged.",
            outputSummary: "Waiting for final answer in Run Result.",
            durationLabel: "running",
            reviewState: "Waiting for final answer",
            runID: "run-tool-review",
            source: "Skill OS"
        )

        loopOpsRequire(submitting.canonicalStatus == .submitting, "submitting status should normalize for filters")
        loopOpsRequire(failed.canonicalStatus == .failed, "failed status should normalize from error text")
        loopOpsRequire(runScoped.canonicalStatus == .running, "run scoped status should normalize as running")
        loopOpsRequire(runScoped.publicStatusLabel == "Run scoped", "public status should use canonical user-facing copy")
        loopOpsRequire(runScoped.reviewChatScopeID == "tool-log-\(runScoped.id)", "tool log review chat should have a stable scope id")

        store.appendToolLog(runScoped)
        store.appendMessage(
            scope: .review,
            scopeID: runScoped.reviewChatScopeID,
            title: "\(runScoped.publicTitle) review",
            role: .assistant,
            text: "Review context for \(runScoped.publicTitle). Status: \(runScoped.publicStatusLabel)."
        )
        store.appendMessage(scope: .run, scopeID: "run-tool-review", title: "Run Chat", role: .assistant, text: "Run chat note.")

        let reviewThread = store.existingThread(scope: .review, scopeID: runScoped.reviewChatScopeID)
        let runThread = store.existingThread(scope: .run, scopeID: "run-tool-review")

        loopOpsRequire(reviewThread?.messages.count == 1, "tool log review chat should persist a review-scoped context message")
        loopOpsRequire(reviewThread?.messages.first?.text.contains("Run scoped") == true, "review chat message should include canonical status")
        loopOpsRequire(runThread?.messages.map(\.text) == ["Run chat note."], "tool log review chat should not leak into run chat")
        loopOpsRequire(reviewThread?.id != runThread?.id, "review and run chat scopes should stay separated for the same tool run")
    }
}

func checkLoopOpsChatControlMetadataRoundTripsThroughStores() {
    MainActor.assumeIsolated {
        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let lightRoot = root.appendingPathComponent("light", isDirectory: true)
        let strictStore = LoopOpsLocalJSONStore(root: root.appendingPathComponent("strict", isDirectory: true))
        let store = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false, strictJSONStore: strictStore)
        let metadata = LoopOpsChatControlMetadata(
            model: "GPT-5",
            mode: "Deep",
            searchMode: .web,
            temporary: false,
            promptCategory: "Explore",
            attachmentSummaries: [
                "Knowledge: Market notes, Ready",
                "Tool Log: CMC scan, Run scoped"
            ]
        )
        let attachments = [
            LoopOpsChatAttachment(
                id: "attachment-market-notes",
                kind: .link,
                fileName: "Knowledge: Market notes",
                artifactPath: "knowledge://Market notes"
            )
        ]

        store.appendMessage(
            scope: .global,
            scopeID: "workspace",
            title: "Global Chat",
            role: .user,
            text: "Explore this market setup.",
            attachments: attachments,
            controlMetadata: metadata
        )

        let lightMessage = store.existingThread(scope: .global, scopeID: "workspace")?.messages.first
        loopOpsRequire(lightMessage?.controlMetadata == metadata, "light chat thread should keep chat control metadata on the user message")
        loopOpsRequire(lightMessage?.attachments == attachments, "light chat thread should keep structured attachment records on the user message")

        let strictMessage = strictStore.readSnapshot().chatThreads.first(where: { $0.id == "global-workspace" })?.messages.first
        loopOpsRequire(strictMessage?.controlMetadata == metadata, "strict chat thread should mirror chat control metadata")
        loopOpsRequire(strictMessage?.attachments == attachments, "strict chat thread should mirror structured message attachments")
        loopOpsRequire(
            strictStore.readSnapshot().chatThreads.first(where: { $0.id == "global-workspace" })?.attachments == attachments,
            "strict chat thread should expose thread-level attachment inventory"
        )

        let reloaded = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false, strictJSONStore: strictStore)
        let reloadedMessage = reloaded.existingThread(scope: .global, scopeID: "workspace")?.messages.first
        loopOpsRequire(reloadedMessage?.controlMetadata == metadata, "chat control metadata should survive store reload")
        loopOpsRequire(reloadedMessage?.attachments == attachments, "structured chat attachments should survive store reload")
    }
}

func checkLoopOpsRunLaunchRequestsStayContractScoped() {
    let templates = WorkbenchLoopTemplate.templates(for: .crypto)
    let market = LoopContract.from(template: templates[0])
    let trade = LoopContract.from(template: templates[3]).replacingSkillBindings([
        LoopOpsSkillBinding(kind: .skill, id: "trade-plan-review", title: "Trade plan review", order: 0, source: "test"),
        LoopOpsSkillBinding(kind: .extensionPackage, id: "cmc-skill-hub", title: "CMC Skill Hub capability", order: 1, source: "test")
    ])

    let marketRequest = LoopOpsRunLaunchRequest(contract: market, launchID: "test-market-launch-1")
    let marketRepeatRequest = LoopOpsRunLaunchRequest(contract: market, launchID: "test-market-launch-2")
    let tradeRequest = LoopOpsRunLaunchRequest(
        contract: trade,
        additionalInstruction: "Only report review gaps.",
        launchID: "test-trade-launch-1"
    )
    let readyKnowledge = LoopOpsKnowledgeSource(
        id: "knowledge-ready",
        title: "Ready market notes",
        kind: .blank,
        summary: "Ready notes for this run.",
        status: .ready,
        reuseMode: .attachToLoop,
        sourceLabel: "Manual"
    )
    let draftKnowledge = LoopOpsKnowledgeSource(
        id: "knowledge-draft",
        title: "Draft notes",
        kind: .blank,
        summary: "Do not attach yet.",
        status: .draft,
        reuseMode: .manual,
        sourceLabel: "Manual"
    )
    let knowledgeRequest = LoopOpsRunLaunchRequest(
        contract: market,
        knowledgeSources: [readyKnowledge, draftKnowledge],
        launchID: "test-market-launch-knowledge"
    )

    loopOpsRequire(marketRequest.contractID != tradeRequest.contractID, "batch launch requests should keep each contract id")
    loopOpsRequire(marketRepeatRequest.contractID == marketRequest.contractID, "repeat launch requests should keep their source contract id")
    loopOpsRequire(marketRequest.prompt.contains(market.name), "market request prompt should snapshot its contract name")
    loopOpsRequire(tradeRequest.prompt.contains(trade.name), "trade request prompt should snapshot its contract name")
    loopOpsRequire(tradeRequest.prompt.contains("本轮追加指令：Only report review gaps."), "launch request should carry follow-up instruction")
    loopOpsRequire(marketRequest.selectedSkillIDs == market.orderedSkillIDs, "market request should carry ordered skill ids from its contract")
    loopOpsRequire(tradeRequest.selectedSkillIDs == ["trade-plan-review"], "trade request should not inherit market skill ids")
    loopOpsRequire(tradeRequest.selectedExtensionIDs == ["cmc-skill-hub"], "trade request should keep its extension path")
    loopOpsRequire(marketRequest.chatScopeID != tradeRequest.chatScopeID, "run-scoped chats should be distinct per contract launch")
    loopOpsRequire(marketRequest.chatScopeID != marketRepeatRequest.chatScopeID, "same contract repeat launches should use distinct run chat scopes")
    loopOpsRequire(marketRequest.chatScopeID == "loop-run-\(market.id)-test-market-launch-1", "launch chat scope should remain contract-readable and instance-scoped")
    loopOpsRequire(knowledgeRequest.knowledgeSourceIDs == [readyKnowledge.id], "launch request should include only ready knowledge source ids")
    loopOpsRequire(knowledgeRequest.contextRefs.map(\.id) == [readyKnowledge.id], "launch request should turn ready knowledge into runtime context refs")
    loopOpsRequire(knowledgeRequest.prompt.contains("Knowledge Scope：Ready market notes (Manual)"), "launch prompt should name ready bound knowledge")
}

func checkLoopOpsUnreadyRunRoutesToBuilderSetup() {
    MainActor.assumeIsolated {
        var contract = LoopContract.from(template: WorkbenchLoopTemplate.templates(for: .crypto)[0])
        contract.id = "unready-setup-test"
        contract.name = "Unready Setup Test"
        contract.stepSummary = []
        contract.prompt = ""

        loopOpsRequire(!contract.isRunnable, "test contract should be missing run requirements")
        loopOpsRequire(contract.readinessLabel == "Needs setup", "unready contract should expose setup readiness")
        loopOpsRequire(contract.setupChecklistItems.contains("Add at least one visible step."), "setup checklist should include missing steps")
        loopOpsRequire(contract.setupChecklistItems.contains("Write the launch prompt."), "setup checklist should include missing launch prompt")
        loopOpsRequire(contract.setupChecklistItems.allSatisfy { !$0.localizedCaseInsensitiveContains("feedback gate") }, "setup checklist should hide feedback-gate terminology")
        loopOpsRequire(contract.setupPrompt.contains("Finish setup for Unready Setup Test"), "setup prompt should target the selected loop")

        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let lightRoot = root.appendingPathComponent("light", isDirectory: true)
        let strictStore = LoopOpsLocalJSONStore(root: root.appendingPathComponent("strict", isDirectory: true))
        let store = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false, strictJSONStore: strictStore)
        store.upsert(contract)
        let viewModel = DashboardViewModel()
        let report = viewModel.runLoopContract(contract, loopOpsStore: store)

        loopOpsRequire(report.queuedCount == 0, "unready contract should not enqueue a run")
        loopOpsRequire(report.setupRequiredContractIDs == [contract.id], "unready contract should return setup handoff ids")
        loopOpsRequire(viewModel.selectedWorkspace == .studio, "unready run should route to Studio for Builder Chat")
        loopOpsRequire(viewModel.loopOpsFocusedContractID == contract.id, "unready run should focus the missing contract")
        loopOpsRequire(viewModel.agentSubmitStatus == "loop_setup_needed:\(contract.id)", "unready run should expose setup status")
        loopOpsRequire(viewModel.agentPrompt.contains("Write the launch prompt."), "setup prompt should seed the composer")
        loopOpsRequire(
            store.existingThread(scope: .builder, scopeID: contract.id)?.messages.first?.text.contains("Setup needed before running") == true,
            "setup handoff should write a Builder Chat receipt"
        )
    }
}

func checkLoopOpsLocalStorePersistsRunLedgerAndShareSafeLog() {
    MainActor.assumeIsolated {
        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let lightRoot = root.appendingPathComponent("light", isDirectory: true)
        let strictStore = LoopOpsLocalJSONStore(root: root.appendingPathComponent("strict", isDirectory: true))

        let store = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false, strictJSONStore: strictStore)
        let contract = LoopContract.from(template: WorkbenchLoopTemplate.all.first { $0.id == "crypto-market-report-loop" }!)
        store.upsert(contract)
        let task = AgentLongTask(
            taskID: "task-local-ledger",
            sessionID: "session-local-ledger",
            runID: "run-local-ledger",
            prompt: contract.promptForRun(),
            status: "queued",
            selectedToolNames: [],
            selectedSkillIDs: contract.orderedSkillIDs,
            selectedExtensionIDs: contract.orderedExtensionIDs,
            attachmentIDs: [],
            artifactPath: "runtime/agent/runs/run-local-ledger/task.json",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
        )
        let queuedLedger = RunLedgerRow.from(task: task, contract: contract, finalReadModel: nil)
        store.captureRunLedger(queuedLedger)
        store.appendMessage(scope: .run, scopeID: task.runID, title: contract.name, role: .user, text: "Explain the evidence gap.")

        var reloaded = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false)
        loopOpsRequire(reloaded.runLedgers.count == 1, "local store should persist one run ledger")
        loopOpsRequire(reloaded.runLedgers[0].runID == task.runID, "persisted ledger should retain daemon run id")
        loopOpsRequire(reloaded.runLedgers[0].loopContractID == contract.id, "persisted ledger should retain loop contract id")
        loopOpsRequire(reloaded.shareSafeLogs.count == 1, "local store should persist matching share-safe log")
        loopOpsRequire(reloaded.shareSafeLogs[0].id == task.runID, "share-safe preview should be keyed by run id")

        let basePacket = ReviewPacketViewModel(
            id: task.runID,
            runID: task.runID,
            finalAnswer: "Final answer reviewed for durable ledger.",
            domainSummary: "Crypto review packet",
            claims: ["Final answer reviewed for durable ledger."],
            evidenceGaps: ["Need one more source."],
            uncertainty: "review-needed",
            blockedActions: ["Live trading handoff"],
            nextQuestions: ["Refresh evidence?"],
            reviewDecision: "pending"
        )
        let packet = basePacket.applyingReviewDecision(
            "needs_follow_up",
            notes: "Need one more evidence pass.",
            occurredAt: "2026-06-24T00:10:00.000Z"
        )
        store.upsertReviewPacket(packet)

        reloaded = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false)
        loopOpsRequire(reloaded.reviewPackets.first?.reviewDecision == "needs_follow_up", "review decision should persist")
        loopOpsRequire(reloaded.reviewPackets.first?.reviewNotes == "Need one more evidence pass.", "review notes should persist")
        loopOpsRequire(reloaded.reviewPackets.first?.eventHistory.last?.title == "Decision changed to needs_follow_up", "review decision event should persist")
        loopOpsRequire(reloaded.runLedgers.first?.reviewDecision == "needs_follow_up", "review packet upsert should update the matching ledger decision")
        loopOpsRequire(reloaded.runLedgers.first?.lifecycleEvents?.contains { $0.contains("Review packet · Decision changed to needs_follow_up") } == true, "review packet event should update run ledger timeline")
        loopOpsRequire(reloaded.shareSafeLogs.first?.finalAnswerExcerpt.contains("Final answer reviewed") == true, "share-safe log should update final answer excerpt")
        loopOpsRequire(
            reloaded.shareSafeLogs.first?.omittedSensitiveFieldsSummary.contains("Raw payloads") == true,
            "share-safe log should keep redaction boundary copy"
        )

        let strictSnapshot = strictStore.readSnapshot()
        loopOpsRequire(strictSnapshot.contracts.first?.id == contract.id, "strict mirror should persist loop contract snapshot")
        loopOpsRequire(strictSnapshot.runLedgers.first?.runID == task.runID, "strict mirror should persist run ledger")
        loopOpsRequire(strictSnapshot.runLedgers.first?.loopContractSnapshot.id == contract.id, "strict ledger should retain contract snapshot")
        loopOpsRequire(strictSnapshot.reviewPackets.first?.loopContractID == contract.id, "strict review packet should retain contract id")
        loopOpsRequire(strictSnapshot.reviewPackets.first?.reviewNotes == "Need one more evidence pass.", "strict review packet should mirror review notes")
        loopOpsRequire(strictSnapshot.reviewPackets.first?.eventHistory.last?.detail == "Need one more evidence pass.", "strict review packet should mirror event history")
        loopOpsRequire(strictSnapshot.shareSafeLogs.first?.sourceRunID == task.runID, "strict share-safe log should retain source run id")
        loopOpsRequire(strictSnapshot.runLedgers.first?.reviewDecision?.decision == .needsFollowUp, "strict ledger should mirror review packet decision after packet upsert")
        loopOpsRequire(strictSnapshot.shareSafeLogs.first?.finalAnswerExcerpt.contains("Final answer reviewed") == true, "strict share-safe log should use reviewed final answer")
        loopOpsRequire(strictSnapshot.shareSafeLogs.first?.reviewNotes == "Need one more evidence pass.", "strict share-safe log should use review notes")
        loopOpsRequire(strictSnapshot.chatThreads.first?.runID == task.runID, "strict run chat thread should retain run id")

        let legacyReviewPacketJSON = """
        {
          "id": "legacy-review-packet",
          "runID": "legacy-run",
          "finalAnswer": "Legacy final answer.",
          "domainSummary": "Legacy packet",
          "claims": ["Legacy claim"],
          "evidenceGaps": [],
          "uncertainty": "pending",
          "blockedActions": [],
          "nextQuestions": [],
          "reviewDecision": "pending"
        }
        """.data(using: .utf8)!
        let legacyPacket = try! JSONDecoder.agentArtifactDecoder().decode(ReviewPacketViewModel.self, from: legacyReviewPacketJSON)
        loopOpsRequire(legacyPacket.reviewNotes.isEmpty, "legacy light review packet should decode without review notes")
        loopOpsRequire(legacyPacket.eventHistory.isEmpty, "legacy light review packet should decode without event history")

        let legacyStrictReviewPacketJSON = """
        {
          "schemaVersion": "loopops-review-packet-v1",
          "id": "strict-legacy-review-packet",
          "runID": "strict-legacy-run",
          "loopContractID": "\(contract.id)",
          "finalAnswer": "Strict legacy final answer.",
          "domainSummary": "Strict legacy packet",
          "claims": [],
          "evidenceGaps": [],
          "uncertainty": "pending",
          "blockedActions": [],
          "nextQuestions": [],
          "reviewDecision": {
            "id": "legacy-decision",
            "decision": "pending",
            "reviewer": "tester",
            "decidedAt": null,
            "notes": "",
            "nextAction": null
          },
          "createdAt": "2026-06-24T00:00:00.000Z",
          "updatedAt": "2026-06-24T00:00:00.000Z"
        }
        """.data(using: .utf8)!
        let legacyStrictPacket = try! JSONDecoder.agentArtifactDecoder().decode(LoopOpsReviewPacket.self, from: legacyStrictReviewPacketJSON)
        loopOpsRequire(legacyStrictPacket.reviewNotes.isEmpty, "legacy strict review packet should decode without review notes")
        loopOpsRequire(legacyStrictPacket.eventHistory.isEmpty, "legacy strict review packet should decode without event history")
    }
}

func checkLoopOpsKnowledgeLifecycleRetryReadyAndAttachGuards() {
    MainActor.assumeIsolated {
        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let lightRoot = root.appendingPathComponent("light", isDirectory: true)
        let strictStore = LoopOpsLocalJSONStore(root: root.appendingPathComponent("strict", isDirectory: true))
        let store = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false, strictJSONStore: strictStore)
        let contract = LoopContract.from(template: WorkbenchLoopTemplate.all.first { $0.id == "crypto-market-report-loop" }!)
        store.upsert(contract)
        let task = AgentLongTask(
            taskID: "task-knowledge-lifecycle",
            sessionID: "session-knowledge-lifecycle",
            runID: "run-knowledge-lifecycle",
            prompt: contract.promptForRun(),
            status: "queued",
            selectedToolNames: [],
            selectedSkillIDs: contract.orderedSkillIDs,
            selectedExtensionIDs: contract.orderedExtensionIDs,
            attachmentIDs: [],
            artifactPath: "runtime/agent/runs/run-knowledge-lifecycle/task.json",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
        )
        store.captureRunLedger(RunLedgerRow.from(task: task, contract: contract, finalReadModel: nil))

        let created = store.createKnowledgeSource(kind: .website)
        loopOpsRequire(created.status == .needsReview, "website Knowledge should start in a review state")
        loopOpsRequire(created.visibleDocumentCount == 0, "new website Knowledge should not pretend documents were ingested")
        loopOpsRequire(created.normalizedImportProgress > 0, "new website Knowledge should expose setup progress")
        loopOpsRequire(created.canAttachToRun == false, "unreviewed Knowledge should not be attachable")
        loopOpsRequire(created.activity?.first?.contains("Website source created") == true, "created Knowledge should record activity")

        let blockedAttach = store.attachKnowledgeSource(id: created.id, toRunID: task.runID, runTitle: contract.name)
        loopOpsRequire(!blockedAttach, "unready Knowledge should be blocked from attaching to a run")
        loopOpsRequire(store.runLedger(runID: task.runID)?.knowledgeSourceIDs?.isEmpty != false, "blocked attach should not mutate the run ledger")
        loopOpsRequire(store.existingThread(scope: .run, scopeID: task.runID) == nil, "blocked attach should not write a Run Chat receipt")
        loopOpsRequire(store.knowledgeSources.first?.activity?.last?.contains("Attach blocked") == true, "blocked attach should be visible in source activity")

        let syncing = store.startKnowledgeSourceSetup(id: created.id)
        loopOpsRequire(syncing?.status == .syncing, "retry should move Knowledge into syncing")
        loopOpsRequire(syncing?.retryCount == 1, "retry should increment retry count")
        loopOpsRequire((syncing?.normalizedImportProgress ?? 0) >= 0.35, "retry should expose visible progress")

        let failed = store.failKnowledgeSourceSetup(id: created.id, errorSummary: "Missing URL")
        loopOpsRequire(failed?.status == .failed, "failed setup should record failed status")
        loopOpsRequire(failed?.errorSummary == "Missing URL", "failed setup should retain recoverable error text")
        loopOpsRequire(failed?.canRetrySetup == true, "failed setup should allow retry")

        let retried = store.startKnowledgeSourceSetup(id: created.id)
        loopOpsRequire(retried?.status == .syncing, "retry from failed should return to syncing")
        loopOpsRequire(retried?.errorSummary == nil, "retry should clear the previous setup error")
        loopOpsRequire(retried?.retryCount == 2, "retry from failed should increment retry count again")

        let ready = store.completeKnowledgeSourceSetup(id: created.id)
        loopOpsRequire(ready?.status == .ready, "complete setup should mark Knowledge ready")
        loopOpsRequire(ready?.canAttachToRun == true, "ready Knowledge should become attachable")
        loopOpsRequire(ready?.visibleDocumentCount == 1, "ready Knowledge should expose at least one reusable context unit")
        loopOpsRequire(ready?.lastSyncedAt != nil, "ready Knowledge should retain a last sync timestamp")

        let attached = store.attachKnowledgeSource(id: created.id, toRunID: task.runID, runTitle: contract.name)
        loopOpsRequire(attached, "ready Knowledge should attach to a run")
        loopOpsRequire(store.runLedger(runID: task.runID)?.knowledgeSourceIDs == [created.id], "ready attach should update run ledger knowledge ids")
        loopOpsRequire(
            store.existingThread(scope: .run, scopeID: task.runID)?.messages.first?.text.contains("Knowledge attached") == true,
            "ready attach should write a Run Chat receipt"
        )

        let strictSource = strictStore.readSnapshot().knowledgeSources.first { $0.id == created.id }
        loopOpsRequire(strictSource?.status == .ready, "strict snapshot should persist ready Knowledge status")
        loopOpsRequire(strictSource?.retryCount == 2, "strict snapshot should persist retry count")
        loopOpsRequire(strictSource?.lastSyncedAt != nil, "strict snapshot should persist last sync timestamp")
    }
}

func checkLoopOpsKnowledgeChatSourceDetachAndUndo() {
    MainActor.assumeIsolated {
        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let lightRoot = root.appendingPathComponent("light", isDirectory: true)
        let strictStore = LoopOpsLocalJSONStore(root: root.appendingPathComponent("strict", isDirectory: true))
        let store = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false, strictJSONStore: strictStore)
        let contract = LoopContract.from(template: WorkbenchLoopTemplate.all.first { $0.id == "crypto-market-report-loop" }!)
        store.upsert(contract)
        let task = AgentLongTask(
            taskID: "task-knowledge-detach",
            sessionID: "session-knowledge-detach",
            runID: "run-knowledge-detach",
            prompt: contract.promptForRun(),
            status: "queued",
            selectedToolNames: [],
            selectedSkillIDs: contract.orderedSkillIDs,
            selectedExtensionIDs: contract.orderedExtensionIDs,
            attachmentIDs: [],
            artifactPath: "runtime/agent/runs/run-knowledge-detach/task.json",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
        )
        store.captureRunLedger(RunLedgerRow.from(task: task, contract: contract, finalReadModel: nil))
        store.appendMessage(scope: .global, scopeID: "workspace", title: "Global Chat", role: .user, text: "Stage a website source for this market loop.")

        let staged = store.saveChatAttachmentAsKnowledge(
            kind: "Website",
            title: "Market source URL",
            status: "Needs URL",
            scope: .global,
            scopeID: "workspace"
        )
        loopOpsRequire(staged.kind == .website, "chat Website attachment should become a website Knowledge source")
        loopOpsRequire(staged.status == .needsReview, "incomplete chat attachment should enter needs review state")
        loopOpsRequire(staged.canAttachToRun == false, "needs-review chat source should not attach before ready")
        loopOpsRequire(staged.relatedChatThreadIDs?.isEmpty == false, "saved chat attachment should retain chat provenance")

        let ready = store.completeKnowledgeSourceSetup(id: staged.id)
        loopOpsRequire(ready?.status == .ready, "completed chat source should become ready")
        loopOpsRequire(store.attachKnowledgeSource(id: staged.id, toRunID: task.runID, runTitle: contract.name), "ready chat source should attach to run")
        loopOpsRequire(store.runLedger(runID: task.runID)?.knowledgeSourceIDs == [staged.id], "attach should write source id to run ledger")

        loopOpsRequire(store.detachKnowledgeSource(id: staged.id, fromRunID: task.runID, runTitle: contract.name), "attached source should detach from run")
        loopOpsRequire(store.runLedger(runID: task.runID)?.knowledgeSourceIDs?.isEmpty == true, "detach should remove source id from run ledger")
        loopOpsRequire(store.knowledgeSources.first { $0.id == staged.id }?.isLinked(toRunID: task.runID) == false, "detach should remove the run link from the source")
        loopOpsRequire(
            store.existingThread(scope: .run, scopeID: task.runID)?.messages.contains { $0.text.contains("Knowledge detached") } == true,
            "detach should leave a Run Chat receipt"
        )
        guard let toast = store.toasts.first, let action = toast.action else {
            loopOpsRequire(false, "detach should create an undo toast action")
            return
        }
        store.performToastAction(action, toastID: toast.id)
        loopOpsRequire(store.runLedger(runID: task.runID)?.knowledgeSourceIDs == [staged.id], "undo should restore source id to run ledger")
        loopOpsRequire(store.knowledgeSources.first { $0.id == staged.id }?.isLinked(toRunID: task.runID) == true, "undo should restore the source run link")
        loopOpsRequire(
            store.existingThread(scope: .run, scopeID: task.runID)?.messages.contains { $0.text.contains("Knowledge attached") } == true,
            "undo restore should leave an attach receipt in Run Chat"
        )

        let strictSource = strictStore.readSnapshot().knowledgeSources.first { $0.id == staged.id }
        loopOpsRequire(strictSource?.status == .ready, "strict snapshot should preserve restored Knowledge source")
        loopOpsRequire(strictSource?.linkedRunIDs == [task.runID], "strict snapshot should preserve restored run link")
    }
}

func checkDashboardViewModelReconcilesLoopOpsLedgerFromPersistedRows() {
    MainActor.assumeIsolated {
        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let lightRoot = root.appendingPathComponent("light", isDirectory: true)

        let store = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false)
        let contract = LoopContract.from(template: WorkbenchLoopTemplate.all.first { $0.id == "crypto-market-report-loop" }!)
        store.upsert(contract)
        let runID = "run-reconciled-ledger"
        let task = AgentLongTask(
            taskID: "task-reconciled-ledger",
            sessionID: "session-reconciled-ledger",
            runID: runID,
            prompt: contract.promptForRun(),
            status: "queued",
            selectedToolNames: [],
            selectedSkillIDs: contract.orderedSkillIDs,
            selectedExtensionIDs: contract.orderedExtensionIDs,
            attachmentIDs: [],
            artifactPath: "runtime/agent/runs/\(runID)/task.json",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
        )
        var queuedLedger = RunLedgerRow.from(task: task, contract: contract, finalReadModel: nil)
        queuedLedger.lifecycleEvents = ["Queued before reload"]
        queuedLedger.knowledgeSourceIDs = ["knowledge-existing"]
        store.captureRunLedger(queuedLedger)

        let runDir = root
            .appendingPathComponent("runtime", isDirectory: true)
            .appendingPathComponent("agent", isDirectory: true)
            .appendingPathComponent("runs", isDirectory: true)
            .appendingPathComponent(runID, isDirectory: true)
        try! FileManager.default.createDirectory(at: runDir, withIntermediateDirectories: true)
        let finalReadModel = AgentFinalReadModel(
            schemaVersion: "agent-final-read-model-v1",
            runID: runID,
            taskID: task.taskID,
            sessionID: task.sessionID,
            status: "completed",
            finalText: "Durable final answer for reload reconciliation.",
            finalTextSource: "agent-final-read-model",
            outputGuardStatus: "passed",
            outputGuardReason: nil,
            cmcGateSummary: nil,
            productMutationPolicy: nil,
            generatedAt: "2026-06-24T00:01:00.000Z",
            artifactPath: "runtime/agent/runs/\(runID)/agent-final-read-model.json"
        )
        try! JSONEncoder.agentArtifactEncoder().encode(finalReadModel)
            .write(to: runDir.appendingPathComponent("agent-final-read-model.json"), options: [.atomic])

        let reloadedStore = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false)
        let resolver = AgentRuntimePathResolver(pathResolver: RuntimePathResolver(root: root))
        let viewModel = DashboardViewModel(
            agentRunReadModelStore: AgentRunReadModelStore(streamStore: AgentStreamStore(resolver: resolver))
        )
        let reconciled = viewModel.reconcileLoopOpsRunResult(runID: runID, loopOpsStore: reloadedStore)

        loopOpsRequire(reconciled, "view model should reconcile a persisted LoopOps ledger without an in-memory launch capture")
        loopOpsRequire(viewModel.agentFinalReadModelByRunID[runID]?.finalText == finalReadModel.finalText, "reconciliation should cache the authoritative final read model")
        loopOpsRequire(reloadedStore.runLedger(runID: runID)?.status == "completed", "persisted ledger should adopt final read model status")
        loopOpsRequire(
            reloadedStore.runLedger(runID: runID)?.finalAnswerPreview.contains("Durable final answer") == true,
            "persisted ledger should adopt final answer preview"
        )
        loopOpsRequire(
            reloadedStore.runLedger(runID: runID)?.lifecycleEvents == ["Queued before reload"],
            "reconciliation should preserve existing ledger lifecycle logs"
        )
        loopOpsRequire(
            reloadedStore.runLedger(runID: runID)?.knowledgeSourceIDs == ["knowledge-existing"],
            "reconciliation should preserve attached knowledge source ids"
        )
        loopOpsRequire(
            reloadedStore.reviewPacket(runID: runID)?.finalAnswer.contains("Durable final answer") == true,
            "reconciliation should materialize the result panel review packet"
        )
        loopOpsRequire(
            reloadedStore.shareSafeLog(runID: runID)?.finalAnswerExcerpt.contains("Durable final answer") == true,
            "reconciliation should refresh the share-safe log excerpt"
        )

        let persistedAgain = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false)
        loopOpsRequire(
            persistedAgain.runLedger(runID: runID)?.finalAnswerPreview.contains("Durable final answer") == true,
            "reconciled ledger should survive local store reload"
        )
        loopOpsRequire(
            persistedAgain.reviewPacket(runID: runID)?.finalAnswer.contains("Durable final answer") == true,
            "reconciled review packet should survive local store reload"
        )
    }
}

func checkLoopOpsStrictContractDerivesRuntimeIDsWithoutMigration() {
    let timestamp = "2026-06-22T00:00:00.000Z"
    let strict = LoopOpsLoopContract(
        id: "strict-no-migration",
        name: "Strict No Migration",
        domain: .crypto,
        goal: "Run known capabilities without legacy metadata.",
        trigger: "Manual",
        inputBindings: [
            LoopOpsInputBinding(id: "strict-no-migration-prompt", label: "Prompt", kind: .prompt, required: true)
        ],
        userFacingCapabilityChain: [
            LoopOpsCapabilityReference(
                id: "capability-1",
                title: "CoinMarketCap market radar",
                summary: "Market evidence and candidate scanning.",
                category: .marketData
            ),
            LoopOpsCapabilityReference(
                id: "capability-2",
                title: "CMC Skill Hub capability",
                summary: "Read-only crypto market evidence capability.",
                category: .marketData
            )
        ],
        stepSummary: ["Scan", "Review"],
        feedbackGate: "Human review.",
        exitCondition: "Final answer.",
        reviewBoundary: "review-only",
        outputShape: "Summary.",
        scheduleMode: .manual,
        version: 1,
        owner: "tester",
        visibility: .private,
        status: .saved,
        createdAt: timestamp,
        updatedAt: timestamp,
        templateMigration: nil
    )

    let uiContract = LoopContract.from(strictLoopOpsContract: strict)
    loopOpsRequire(uiContract.orderedSkillIDs == ["cmc-market-radar"], "strict contract should derive known skill ids when migration metadata is absent")
    loopOpsRequire(uiContract.orderedExtensionIDs == ["cmc-skill-hub"], "strict contract should derive known extension ids when migration metadata is absent")
    loopOpsRequire(uiContract.promptForRun().contains("Skill Path："), "derived runtime ids should still produce a runnable skill path prompt")
}

func checkLoopOpsKnowledgeToolModelsAndStoreRoundTrip() {
    MainActor.assumeIsolated {
        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let lightRoot = root.appendingPathComponent("light", isDirectory: true)
        let strictStore = LoopOpsLocalJSONStore(root: root.appendingPathComponent("strict", isDirectory: true))
        let store = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false, strictJSONStore: strictStore)

        let knowledge = LoopOpsKnowledgeSource(
            id: "knowledge-test",
            title: "Market evidence notes",
            kind: .blank,
            summary: "Manual notes for the next loop.",
            status: .ready,
            reuseMode: .attachToLoop,
            sourceLabel: "Manual note"
        )
        store.upsertKnowledgeSource(knowledge)

        let binding = LoopOpsSkillBinding(
            kind: .skill,
            id: "cmc-market-radar",
            title: "CoinMarketCap market radar",
            order: 0,
            source: "test"
        )
        let draft = LoopOpsToolDraft(
            id: "tool-draft-test",
            name: "Evidence freshness checker",
            purpose: "Check whether market evidence is stale before writing a review packet.",
            enabled: true,
            integrationSource: "Local Tool",
            inputScope: "Review packet",
            inputs: ["Workspace context"],
            visibleSteps: ["Collect inputs", "Write review packet"],
            outputShape: "Review packet",
            reviewPolicy: "Review-only",
            skillBindings: [binding]
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
            source: "Local Tool"
        )
        store.appendToolLog(log)
        store.showToast(title: "Saved", detail: "Transient toast", tone: .success)

        let reloaded = LoopOpsLocalStore(rootURL: lightRoot, seedTemplates: false)
        loopOpsRequire(reloaded.knowledgeSources.count == 1, "knowledge sources should persist")
        loopOpsRequire(reloaded.knowledgeSources[0].id == knowledge.id, "knowledge source id should round-trip")
        loopOpsRequire(reloaded.knowledgeSources[0].reuseMode == .attachToLoop, "knowledge reuse mode should persist")
        loopOpsRequire(reloaded.toolDrafts.count == 1, "tool drafts should persist")
        loopOpsRequire(reloaded.toolDrafts[0].resolvedIntegrationSource == "Local Tool", "tool draft source should persist")
        loopOpsRequire(reloaded.toolDrafts[0].resolvedInputScope == "Review packet", "tool draft input scope should persist")
        loopOpsRequire(reloaded.toolDrafts[0].isEnabled, "tool draft enabled state should persist")
        loopOpsRequire(reloaded.toolDrafts[0].skillBindings.map(\.id) == ["cmc-market-radar"], "tool draft skill path should persist")
        loopOpsRequire(reloaded.toolLogs == [log], "tool logs should persist")
        loopOpsRequire(reloaded.toasts.isEmpty, "toast stack should be transient and not persist")

        let strictSnapshot = strictStore.readSnapshot()
        loopOpsRequire(strictSnapshot.knowledgeSources.map(\.id) == [knowledge.id], "strict mirror should persist knowledge sources")
        loopOpsRequire(strictSnapshot.toolDrafts.map(\.id) == [draft.id], "strict mirror should persist tool drafts")
        loopOpsRequire(strictSnapshot.toolDrafts[0].isEnabled, "strict mirror should persist tool enabled state")
        loopOpsRequire(strictSnapshot.toolDrafts[0].skillBindings.map(\.id) == ["cmc-market-radar"], "strict mirror should persist ordered tool skill path")
        loopOpsRequire(strictSnapshot.toolLogs == [log], "strict mirror should persist tool logs")

        let recovered = LoopOpsLocalStore(
            rootURL: root.appendingPathComponent("recovered-light", isDirectory: true),
            seedTemplates: false,
            strictJSONStore: strictStore
        )
        loopOpsRequire(recovered.knowledgeSources.map(\.id) == [knowledge.id], "strict recovery should restore knowledge sources")
        loopOpsRequire(recovered.toolDrafts.map(\.id) == [draft.id], "strict recovery should restore tool drafts")
        loopOpsRequire(recovered.toolDrafts[0].isEnabled, "strict recovery should restore tool draft enabled state")
        loopOpsRequire(recovered.toolLogs == [log], "strict recovery should restore tool logs")
    }
}

func checkLoopOpsRunLifecycleAndKnowledgeAttachBacksLedger() {
    MainActor.assumeIsolated {
        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let strictStore = LoopOpsLocalJSONStore(root: root.appendingPathComponent("strict", isDirectory: true))
        let store = LoopOpsLocalStore(
            rootURL: root.appendingPathComponent("light", isDirectory: true),
            seedTemplates: false,
            strictJSONStore: strictStore
        )
        let contract = LoopContract.from(template: WorkbenchLoopTemplate.templates(for: .crypto)[0])
        store.upsert(contract)
        let ledger = RunLedgerRow(
            id: "run-lifecycle-test",
            loopContractID: contract.id,
            runID: "run-lifecycle-test",
            title: contract.name,
            domain: contract.domain,
            status: "queued",
            startedAt: "2026-06-24T00:00:00.000Z",
            completedAt: nil,
            inputsUsed: contract.inputBindings,
            finalAnswerPreview: "尚未写入最终答案。",
            evidenceGaps: [],
            blockedActions: [],
            reviewDecision: "pending",
            followUpPrompts: [],
            cloneable: true,
            replayable: true,
            skillPath: contract.orderedSkillPathLabels,
            lifecycleEvents: ["Queued"]
        )
        store.captureRunLedger(ledger)

        _ = store.applyRunLifecycleAction(runID: ledger.runID, action: .pause)
        loopOpsRequire(store.runLedger(runID: ledger.runID)?.status == "paused", "pause action should update light ledger status")
        loopOpsRequire(store.runLedger(runID: ledger.runID)?.lifecycleEvents?.contains { $0.contains("Pause") } == true, "pause action should append lifecycle event")

        let knowledge = store.createKnowledgeSource(kind: .blank)
        loopOpsRequire(store.attachKnowledgeSource(id: knowledge.id, toRunID: ledger.runID, runTitle: ledger.title), "knowledge attach should succeed")
        let updatedLedger = store.runLedger(runID: ledger.runID)
        loopOpsRequire(updatedLedger?.knowledgeSourceIDs == [knowledge.id], "knowledge attach should write source id onto the run ledger")
        loopOpsRequire(updatedLedger?.lifecycleEvents?.contains { $0.contains("Knowledge attached") } == true, "knowledge attach should append timeline event")
        loopOpsRequire(store.knowledgeSources.first?.linkedRunIDs == [ledger.runID], "knowledge source should keep id-bound run links")
        let runReceiptText = store.existingThread(scope: .run, scopeID: ledger.runID)?.messages.map(\.text).joined(separator: "\n") ?? ""
        loopOpsRequire(runReceiptText.contains(knowledge.title), "run chat receipt should include the attached source title")
        loopOpsRequire(!runReceiptText.contains(knowledge.id), "run chat receipt should not expose the internal source id")

        let packet = ReviewPacketViewModel(
            id: "review-packet-run-lifecycle-test",
            runID: ledger.runID,
            finalAnswer: "Reviewed answer with reusable evidence.",
            domainSummary: "Review packet materialization",
            claims: ["Reviewed answer with reusable evidence."],
            evidenceGaps: ["Need source timestamp"],
            uncertainty: "medium",
            blockedActions: [],
            nextQuestions: [],
            reviewDecision: "reviewed"
        )
        store.upsertReviewPacket(packet)
        let reviewSource = store.materializeKnowledgeSource(
            id: "review-\(packet.id)",
            title: packet.domainSummary,
            kind: .review,
            summary: packet.finalAnswer,
            sourceLabel: "Review Packet"
        )
        loopOpsRequire(store.attachKnowledgeSource(id: reviewSource.id, toRunID: ledger.runID, runTitle: ledger.title), "review packet rows should materialize and attach as knowledge sources")

        store.appendMessage(scope: .review, scopeID: "review-chat-run-lifecycle-test", title: "Review chat", role: .assistant, text: "Reusable review chat note.")
        let chatSource = store.materializeKnowledgeSource(
            id: "chat-review-chat-run-lifecycle-test",
            title: "Review chat",
            kind: .chat,
            summary: "Reusable review chat note.",
            sourceLabel: "Review Chat"
        )
        loopOpsRequire(store.attachKnowledgeSource(id: chatSource.id, toRunID: ledger.runID, runTitle: ledger.title), "chat rows should materialize and attach as knowledge sources")
        loopOpsRequire(
            store.runLedger(runID: ledger.runID)?.knowledgeSourceIDs == [knowledge.id, reviewSource.id, chatSource.id],
            "ledger should keep attached source ids for source, review packet, and chat knowledge rows"
        )
        let strictKnowledgeIDs = strictStore.readSnapshot().knowledgeSources.map(\.id)
        loopOpsRequire(strictKnowledgeIDs.contains(reviewSource.id), "strict snapshot should persist materialized review knowledge")
        loopOpsRequire(strictKnowledgeIDs.contains(chatSource.id), "strict snapshot should persist materialized chat knowledge")
    }
}

func checkLoopOpsRunResultStateAggregatesSelectedRunEvidence() {
    MainActor.assumeIsolated {
        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = LoopOpsLocalStore(rootURL: root, seedTemplates: false)
        let contract = LoopContract.from(template: WorkbenchLoopTemplate.templates(for: .crypto)[0])
        let runID = "run-result-state-test"
        store.upsert(contract)

        let ledger = RunLedgerRow(
            id: runID,
            loopContractID: contract.id,
            runID: runID,
            title: contract.name,
            domain: contract.domain,
            status: "review_ready",
            startedAt: "2026-06-24T00:00:00.000Z",
            completedAt: "2026-06-24T00:02:00.000Z",
            inputsUsed: ["Workspace context", "Market notes"],
            finalAnswerPreview: "Saved answer before packet.",
            evidenceGaps: [],
            blockedActions: [],
            reviewDecision: "pending",
            followUpPrompts: ["Refresh evidence."],
            cloneable: true,
            replayable: true,
            skillPath: contract.orderedSkillPathLabels,
            lifecycleEvents: [
                "Queued · 2026-06-24T00:00:00.000Z",
                "Review packet · Packet created · 2026-06-24T00:01:00.000Z"
            ],
            knowledgeSourceIDs: ["knowledge-run-result-state"]
        )
        store.captureRunLedger(ledger)

        let packet = ReviewPacketViewModel(
            id: "packet-run-result-state-test",
            runID: runID,
            finalAnswer: "Final answer from review packet.",
            domainSummary: "Crypto result state packet",
            claims: ["Final answer from review packet."],
            evidenceGaps: ["Need source timestamp"],
            uncertainty: "medium",
            blockedActions: [],
            nextQuestions: ["Attach latest market note?"],
            reviewDecision: "needs_follow_up"
        )
        store.upsertReviewPacket(packet)

        let knowledge = LoopOpsKnowledgeSource(
            id: "knowledge-run-result-state",
            title: "Market evidence note",
            kind: .blank,
            summary: "Reusable evidence for the selected run.",
            status: .ready,
            reuseMode: .attachToLoop,
            linkedRunID: runID,
            linkedRunIDs: [runID],
            sourceLabel: "Manual note"
        )
        store.upsertKnowledgeSource(knowledge)

        let toolLog = LoopOpsToolLog(
            id: "tool-log-run-result-state",
            toolID: "tool-result-state",
            title: "Evidence freshness checker",
            status: "Run scoped",
            summary: "Checked selected run evidence.",
            inputSummary: "Run result and market notes",
            outputSummary: "Timestamp gap found.",
            durationLabel: "1s",
            reviewState: "Needs review",
            runID: runID,
            source: "Skill OS"
        )
        store.appendToolLog(toolLog)
        store.appendMessage(scope: .run, scopeID: runID, title: contract.name, role: .user, text: "Review this run only.")
        store.appendMessage(scope: .global, scopeID: runID, title: "Workspace", role: .user, text: "Global text must not appear in run state.")

        guard let state = store.runResultState(runID: runID) else {
            preconditionFailure("run result state should derive from a saved ledger")
        }
        loopOpsRequire(state.runID == runID, "result state should keep selected run id")
        loopOpsRequire(state.loopContractID == contract.id, "result state should keep loop contract id")
        loopOpsRequire(state.reviewPacketID == packet.id, "result state should link the review packet")
        loopOpsRequire(state.shareSafeLogID == runID, "result state should link the share-safe log")
        loopOpsRequire(state.finalAnswer == "Final answer from review packet.", "result state should prefer review packet final answer")
        loopOpsRequire(state.finalAnswerStatus == "Review Packet", "result state should label packet-backed final answers")
        loopOpsRequire(state.readiness == .needsReview, "result state should surface evidence gaps as needs review")
        loopOpsRequire(state.evidenceGaps == ["Need source timestamp"], "result state should use packet evidence gaps")
        loopOpsRequire(state.toolLogIDs == [toolLog.id], "result state should keep run-scoped tool logs")
        loopOpsRequire(state.knowledgeSourceIDs == [knowledge.id], "result state should de-duplicate ledger and linked knowledge ids")
        loopOpsRequire(state.runChatMessageCount == 1, "result state should count only run-scoped chat messages")
        loopOpsRequire(state.runChatThreadID == "run-\(runID)", "result state should point at the run chat thread")
        loopOpsRequire(state.skillPath == contract.orderedSkillPathLabels, "result state should expose the ordered skill path")
        loopOpsRequire(state.inputSummary == ["Workspace context", "Market notes"], "result state should preserve input summary")
        loopOpsRequire(state.attempts.map(\.title) == ["Queued", "Review packet"], "result state should derive attempts from ledger timeline")
        loopOpsRequire(state.canClone && state.canReplay, "result state should preserve clone and replay affordances")

        let reloaded = LoopOpsLocalStore(rootURL: root, seedTemplates: false)
        guard let reloadedState = reloaded.runResultState(runID: runID) else {
            preconditionFailure("reloaded result state should derive from persisted run objects")
        }
        loopOpsRequire(reloadedState.reviewPacketID == packet.id, "reloaded result state should keep review packet link")
        loopOpsRequire(reloadedState.shareSafeLogID == runID, "reloaded result state should keep share-safe link")
        loopOpsRequire(reloadedState.toolLogIDs == [toolLog.id], "reloaded result state should keep tool log link")
        loopOpsRequire(reloadedState.knowledgeSourceIDs == [knowledge.id], "reloaded result state should keep knowledge link")
        loopOpsRequire(reloadedState.runChatMessageCount == 1, "reloaded result state should keep run chat isolation")
    }
}

func checkLoopOpsInteractionIDsCoverAcceptanceAnchors() {
    let ids = LoopOpsInteractionID.requiredUISmokeIDs
    loopOpsRequire(Set(ids).count == ids.count, "interaction identifiers should be unique")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.buildNavigationGroup), "smoke ids should include IA/Build navigation group")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.buildAgentsList), "smoke ids should include Build Agents list")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.buildToolsList), "smoke ids should include Build Tools list")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.buildWorkforceList), "smoke ids should include Build Workforce list")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.buildKnowledgeList), "smoke ids should include Build Knowledge list")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.buildChatList), "smoke ids should include Build Chat list")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.runsMonitorTable), "smoke ids should include Runs monitor table")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.workbenchActiveQueue), "smoke ids should include active queue")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.workbenchRunLifecycleAction(.pause)), "smoke ids should include queue lifecycle actions")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.workbenchRunResult), "smoke ids should include run result")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.workbenchRunChat), "smoke ids should include run chat")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.workbenchRunChatLocked), "smoke ids should include run chat lock indicator")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.workbenchReviewGuide), "smoke ids should include Workbench review guide")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.workbenchReviewGuideProgress), "smoke ids should include Workbench review guide progress")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.workbenchReviewGuideChecklist), "smoke ids should include Workbench review guide checklist")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.reviewGuidePath("library")), "smoke ids should include review guide Library path")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.reviewGuidePath("skill-os")), "smoke ids should include review guide Skill OS path")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.reviewGuidePath("knowledge")), "smoke ids should include review guide Knowledge path")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.reviewGuidePath("chat")), "smoke ids should include review guide Chat path")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.reviewGuideChecklistDone("library")), "smoke ids should include review guide Library checklist action")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.reviewGuideChecklistDone("skill-os")), "smoke ids should include review guide Skill OS checklist action")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.reviewGuideChecklistDone("knowledge")), "smoke ids should include review guide Knowledge checklist action")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.reviewGuideChecklistDone("chat")), "smoke ids should include review guide Chat checklist action")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.scopedChat(.global)), "smoke ids should include global chat")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.scopedChatQuickControls(.global)), "smoke ids should include global chat quick controls")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.scopedChatModelControl(.global)), "smoke ids should include global chat model control")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.scopedChatInstantControl(.global)), "smoke ids should include global chat instant control")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.scopedChatSearchControl(.global)), "smoke ids should include global chat search control")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.scopedChatTemporaryControl(.global)), "smoke ids should include global chat temporary control")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.scopedChatPromptCategories(.global)), "smoke ids should include global chat prompt categories")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.scopedChatQuickControls(.run)), "smoke ids should include run chat quick controls")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.scopedChatModelControl(.run)), "smoke ids should include run chat model control")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.scopedChatInstantControl(.run)), "smoke ids should include run chat instant control")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.scopedChatSearchControl(.run)), "smoke ids should include run chat search control")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.scopedChatTemporaryControl(.run)), "smoke ids should include run chat temporary control")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.scopedChatPromptCategories(.run)), "smoke ids should include run chat prompt categories")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.loopLibraryBatchRun), "smoke ids should include loop library batch run")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.loopLibraryTemplateMarketplace), "smoke ids should include loop marketplace")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.loopLibraryLedgerList), "smoke ids should include run ledger list")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.loopLibraryDetailRun), "smoke ids should include loop detail run action")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.loopLibraryDetailInstall), "smoke ids should include loop detail install action")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.loopLibraryDetailClone), "smoke ids should include loop detail clone action")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.loopLibraryReviewPacket), "smoke ids should include review packet panel")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.reviewDecision("reviewed")), "smoke ids should include reviewed decision")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.reviewDecision("needs_follow_up")), "smoke ids should include needs-follow-up decision")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.reviewDecision("blocked")), "smoke ids should include blocked decision")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.loopLibraryShareSafeLog), "smoke ids should include share-safe log preview")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSLibrary), "smoke ids should include Skill OS library")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSSearch), "smoke ids should include Skill OS search")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSFilter), "smoke ids should include Skill OS filter")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSColumns), "smoke ids should include Skill OS columns")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSSort), "smoke ids should include Skill OS sort")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSListMode), "smoke ids should include Skill OS list mode")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSGridMode), "smoke ids should include Skill OS grid mode")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSEnableAction), "smoke ids should include Skill OS enable action")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSDisableAction), "smoke ids should include Skill OS disable action")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSDetailPage), "smoke ids should include Skill OS detail page")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSCreateTool), "smoke ids should include Skill OS create tool")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSCreateToolInvent), "smoke ids should include Skill OS Invent tool starter")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSCreateToolDefault), "smoke ids should include Skill OS Default tool starter")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSCreateToolImport), "smoke ids should include Skill OS Import tool starter")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSCreateToolName), "smoke ids should include Skill OS tool name field")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSCreateToolDescription), "smoke ids should include Skill OS task description field")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSCreateToolIntegration), "smoke ids should include Skill OS source field")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSCreateToolInputScope), "smoke ids should include Skill OS input scope field")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSCreateToolOutput), "smoke ids should include Skill OS output field")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSCreateToolReviewRule), "smoke ids should include Skill OS review rule field")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.skillOSToolLogs), "smoke ids should include Skill OS logs")
    loopOpsRequire(LoopOpsInteractionID.skillOSToolLogReviewChat == "loopops.skill-os.logs.review-chat", "tool log review chat should have a stable interaction id")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.knowledgeNewMenu), "smoke ids should include Knowledge new menu")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.knowledgeToastStack), "smoke ids should include toast stack")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.studioKnowledge), "smoke ids should include Studio Knowledge binder")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.studioSkillStack), "smoke ids should include Studio Skill Stack binder")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.studioExecutionPath), "smoke ids should include Studio execution path")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.studioBuilderPacket), "smoke ids should include Builder Packet panel")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.studioBuilderPacketApply), "smoke ids should include Builder Packet apply action")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.studioBuilderPacketReject), "smoke ids should include Builder Packet reject action")
    loopOpsRequire(ids.contains(LoopOpsInteractionID.studioBuilderPacketSave), "smoke ids should include Builder Packet save action")

    let starterContract = LoopContract.from(template: WorkbenchLoopTemplate.templates(for: .crypto)[0])
    let firstBinding = starterContract.orderedSkillBindings[0]
    let dynamicIDs = [
        LoopOpsInteractionID.contractSelect(starterContract.id),
        LoopOpsInteractionID.contractRow(starterContract.id),
        LoopOpsInteractionID.contractInstallButton(starterContract.id),
        LoopOpsInteractionID.contractRunButton(starterContract.id),
        LoopOpsInteractionID.contractOpenButton(starterContract.id),
        LoopOpsInteractionID.workbenchContractRun(starterContract.id),
        LoopOpsInteractionID.workbenchActiveQueueRow("task-run-\(starterContract.id)"),
        LoopOpsInteractionID.ledgerRow("ledger-\(starterContract.id)"),
        LoopOpsInteractionID.skillPackage(firstBinding.id),
        LoopOpsInteractionID.skillPathRow(firstBinding.dragID),
        LoopOpsInteractionID.skillPathMoveUp(firstBinding.dragID),
        LoopOpsInteractionID.skillPathMoveDown(firstBinding.dragID),
        LoopOpsInteractionID.skillPathRemove(firstBinding.dragID)
    ]
    loopOpsRequire(Set(dynamicIDs).count == dynamicIDs.count, "dynamic interaction identifiers should be unique")
    loopOpsRequire(dynamicIDs.allSatisfy { $0.hasPrefix("loopops.") }, "dynamic interaction identifiers should stay in loopops namespace")
    loopOpsRequire(dynamicIDs.allSatisfy { !$0.contains(" ") && !$0.contains("\n") }, "dynamic interaction identifiers should be automation-safe")
}

func checkLoopOpsBuildNavigationSurfacesAreRoutable() {
    loopOpsRequire(TerminalWorkspace.allCases.contains(.home), "Build IA should expose Tasks monitor route")
    loopOpsRequire(TerminalWorkspace.allCases.contains(.inbox), "Build IA should expose Agents / Loop Library route")
    loopOpsRequire(TerminalWorkspace.allCases.contains(.skills), "Build IA should expose Tools / Skill OS route")
    loopOpsRequire(TerminalWorkspace.allCases.contains(.workforce), "Build IA should expose Workforce route")
    loopOpsRequire(TerminalWorkspace.allCases.contains(.knowledge), "Build IA should expose Knowledge route")
    loopOpsRequire(TerminalWorkspace.allCases.contains(.chat), "Build IA should expose Chat route")
    loopOpsRequire(TerminalWorkspace.allCases.contains(.studio), "Build IA should expose Studio route")
    loopOpsRequire(LoopOpsSurface.allCases.contains(.workbench), "LoopOps surfaces should include workbench")
    loopOpsRequire(LoopOpsSurface.allCases.contains(.library), "LoopOps surfaces should include library")
    loopOpsRequire(LoopOpsSurface.allCases.contains(.skillOS), "LoopOps surfaces should include skill OS")
    loopOpsRequire(LoopOpsSurface.allCases.contains(.workforce), "LoopOps surfaces should include workforce")
    loopOpsRequire(LoopOpsSurface.allCases.contains(.knowledge), "LoopOps surfaces should include knowledge")
    loopOpsRequire(LoopOpsSurface.allCases.contains(.studio), "LoopOps surfaces should include studio")
}

func checkLoopOpsLocalStoreRunScopedChatsStayIsolated() {
    MainActor.assumeIsolated {
        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = LoopOpsLocalStore(rootURL: root, seedTemplates: false)

        store.appendMessage(scope: .run, scopeID: "run-a", title: "Run A", role: .user, text: "Inspect run A only.")
        store.appendMessage(scope: .run, scopeID: "run-b", title: "Run B", role: .assistant, text: "Run B final answer.")
        store.appendMessage(scope: .global, scopeID: "run-a", title: "Global", role: .user, text: "Global thread should not leak.")

        let runA = store.existingThread(scope: .run, scopeID: "run-a")
        let runB = store.existingThread(scope: .run, scopeID: "run-b")
        let globalA = store.existingThread(scope: .global, scopeID: "run-a")

        loopOpsRequire(runA?.messages.map(\.text) == ["Inspect run A only."], "run-scoped chat A should keep only run A messages")
        loopOpsRequire(runB?.messages.map(\.text) == ["Run B final answer."], "run-scoped chat B should keep only run B messages")
        loopOpsRequire(globalA?.messages.map(\.text) == ["Global thread should not leak."], "global chat should not satisfy run scoped lookup")
        loopOpsRequire(runA?.id != globalA?.id, "run and global scopes should use distinct thread ids for the same scope id")
    }
}

func checkLoopOpsKnowledgeRowsHideInternalTerms() {
    let detail = loopOpsKnowledgeThreadDetail(messageCount: 2, reusableNoteCount: 1)
    let forbiddenTerms = ["memory", "provider", "runtime", "worker", "artifact", "schema"]
    let lowercasedDetail = detail.lowercased()
    loopOpsRequire(detail == "2 messages · 1 reusable notes", "knowledge chat row should use user-facing reusable note copy")
    loopOpsRequire(forbiddenTerms.allSatisfy { !lowercasedDetail.contains($0) }, "knowledge chat row should not expose internal terms")

    MainActor.assumeIsolated {
        let root = loopOpsTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = LoopOpsLocalStore(rootURL: root, seedTemplates: false)
        store.appendMessage(scope: .run, scopeID: "knowledge-row-run", title: "Run Chat", role: .assistant, text: "Reusable note.")
        store.appendToolLog(
            LoopOpsToolLog(
                toolID: "knowledge-tool",
                title: "Tool result",
                status: "Queued",
                summary: "Queued for run.",
                durationLabel: "queued",
                reviewState: "Waiting for answer",
                source: "Skill OS"
            )
        )
        let source = store.createKnowledgeSource(kind: .blank)
        loopOpsRequire(store.knowledgeSources.map(\.id) == [source.id], "Knowledge collection rows should come from saved sources only")
        loopOpsRequire(!store.knowledgeSources.contains { $0.kind == .chat || $0.kind == .log || $0.kind == .review }, "derived chat/log/review material should not appear until saved as sources")

        let materialized = store.materializeKnowledgeSource(
            id: "knowledge-chat-materialized",
            title: "Run Chat note",
            kind: .chat,
            summary: "Saved conversation excerpt.",
            sourceLabel: "Conversation",
            relatedChatThreadIDs: ["knowledge-row-run"]
        )
        loopOpsRequire(store.knowledgeSources.contains { $0.id == materialized.id && $0.kind == .chat }, "derived material should appear only after explicit save as source")
    }
}

func checkLoopOpsVisibleCopyHidesInternalTerms() {
    let template = WorkbenchLoopTemplate.all.first { $0.id == "crypto-market-report-loop" }!
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

    loopOpsRequire(prompt.contains("Review Rule："), "run prompt should describe feedback constraints with user-facing review-rule copy")
    loopOpsRequire(!prompt.contains("Feedback Gate："), "run prompt should not expose gate terminology")
    loopOpsRequire(forbiddenPhrases.allSatisfy { !visibleCopy.contains($0) }, "LoopOps visible copy should hide runtime/provider/gate phrasing")
}

func checkLoopOpsLocalJSONStoreRoundTripsObjects() throws {
    let root = loopOpsTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }

    let timestamp = "2026-06-22T00:00:00.000Z"
    let stableDate = ISO8601DateFormatter().date(from: "2026-06-22T00:00:00Z")!
    let template = WorkbenchLoopTemplate.all.first { $0.id == "crypto-market-report-loop" }!
    let contract = LoopOpsLoopContract.fromTemplate(
        template,
        owner: "tester",
        now: stableDate
    )
    let store = LoopOpsLocalJSONStore(root: root)

    try store.upsertContract(contract)
    try store.upsertContract(contract)

    let chatThread = LoopOpsChatThread(
        id: "chat-thread-test",
        scope: .builder,
        title: "Builder chat",
        messages: [
            LoopOpsChatMessage(
                id: "message-test",
                role: .user,
                text: "Build this market loop.",
                referencedContractID: contract.id,
                createdAt: timestamp
            )
        ],
        generatedLoopDraftID: contract.id,
        loopContractID: contract.id,
        createdAt: timestamp,
        updatedAt: timestamp
    )
    try store.upsertChatThread(chatThread)
    try store.upsertChatThread(chatThread)

    let gap = LoopOpsEvidenceGap(
        id: "gap-test",
        title: "Missing fresh confirmation",
        detail: "The run needs a newer market evidence pass.",
        severity: .warning
    )
    let blockedAction = LoopOpsBlockedAction(
        id: "blocked-action-test",
        label: "Live execution",
        reason: "LoopOps v2 remains review-only."
    )
    let decision = LoopOpsReviewDecision(
        id: "decision-test",
        decision: .needsFollowUp,
        reviewer: "tester",
        decidedAt: timestamp,
        notes: "Need one more evidence pass.",
        nextAction: "Ask a run-scoped follow-up."
    )
    let reviewPacket = LoopOpsReviewPacket(
        id: "review-packet-test",
        runID: "run-test",
        loopContractID: contract.id,
        finalAnswer: "Final answer should be reviewable.",
        domainSummary: "Crypto market loop summary.",
        claims: [
            LoopOpsReviewClaim(
                id: "claim-test",
                text: "Market stance needs review.",
                supportLevel: .mixed,
                evidenceReferences: ["final-answer-test"]
            )
        ],
        evidenceGaps: [gap],
        uncertainty: "Medium",
        blockedActions: [blockedAction],
        nextQuestions: ["What changed after the next evidence pass?"],
        reviewDecision: decision,
        createdAt: timestamp,
        updatedAt: timestamp
    )
    try store.upsertReviewPacket(reviewPacket)

    let runLedger = LoopOpsRunLedger(
        id: "run-ledger-test",
        loopContractSnapshot: contract,
        runID: "run-test",
        startedAt: timestamp,
        completedAt: timestamp,
        inputsUsed: contract.inputBindings,
        statusTimeline: [
            LoopOpsStatusTimelineEvent(
                id: "timeline-started",
                status: .running,
                title: "Started",
                occurredAt: timestamp
            ),
            LoopOpsStatusTimelineEvent(
                id: "timeline-review",
                status: .reviewNeeded,
                title: "Review needed",
                occurredAt: timestamp
            )
        ],
        finalAnswerPointer: LoopOpsFinalAnswerPointer(
            id: "final-answer-test",
            artifactPath: "runtime/agent/runs/run-test/agent-final-read-model.json",
            excerpt: "Final answer should be reviewable."
        ),
        evidenceGaps: [gap],
        blockedActions: [blockedAction],
        reviewDecision: decision,
        followUpPrompts: ["Refresh evidence and compare stance."],
        cloneReplayMetadata: LoopOpsCloneReplayMetadata(sourceRunID: "run-test")
    )
    try store.upsertRunLedger(runLedger)

    let shareSafeLog = LoopOpsShareSafeLog.from(
        runLedger: runLedger,
        reviewPacket: reviewPacket,
        id: "share-safe-log-test",
        createdAt: timestamp
    )
    try store.upsertShareSafeLog(shareSafeLog)

    let knowledge = LoopOpsKnowledgeSource(
        id: "knowledge-json-test",
        title: "Market source notes",
        kind: .blank,
        summary: "Strict JSON knowledge should survive.",
        status: .ready,
        reuseMode: .attachToLoop,
        linkedRunID: "run-test",
        linkedRunIDs: ["run-test"],
        activity: ["Attached to run-test"],
        sourceLabel: "Manual note",
        createdAt: stableDate,
        updatedAt: stableDate
    )
    try store.upsertKnowledgeSource(knowledge)

    let binding = LoopOpsSkillBinding(
        kind: .skill,
        id: "cmc-market-radar",
        title: "CoinMarketCap market radar",
        order: 0,
        source: "json-store-test"
    )
    let skillStack = LoopOpsSkillStack(
        id: "skill-stack-json-test",
        name: "Evidence stack",
        summary: "Reusable evidence review path.",
        bindings: [binding],
        createdAt: stableDate,
        updatedAt: stableDate
    )
    try store.upsertSkillStack(skillStack)
    try store.upsertSkillStack(skillStack)

    let toolDraft = LoopOpsToolDraft(
        id: "tool-draft-json-test",
        name: "Evidence freshness checker",
        purpose: "Check evidence age before writing a review packet.",
        integrationSource: "Local Tool",
        inputScope: "Run result",
        inputs: ["Run result"],
        visibleSteps: ["Collect context", "Check freshness"],
        outputShape: "Review packet",
        reviewPolicy: "Review-only",
        skillBindings: [binding],
        createdAt: stableDate,
        updatedAt: stableDate
    )
    try store.upsertToolDraft(toolDraft)

    let toolLog = LoopOpsToolLog(
        id: "tool-log-json-test",
        toolID: toolDraft.id,
        title: "Evidence freshness checker created",
        status: "Draft",
        summary: "Tool draft saved.",
        durationLabel: "instant",
        reviewState: "Review-only",
        runID: "run-test",
        source: "Local Tool",
        createdAt: stableDate
    )
    try store.upsertToolLog(toolLog)

    let builderPatch = LoopOpsBuilderDraftPatch(
        instruction: "skill path: CoinMarketCap market radar",
        packages: loopOpsBuilderTestPackages()
    )
    let builderPacket = LoopOpsBuilderPacket(
        id: "builder-packet-json-test",
        contractID: contract.id,
        instruction: "Update the skill path",
        patch: builderPatch,
        status: .applied,
        createdAt: stableDate,
        updatedAt: stableDate
    )
    try store.upsertBuilderPacket(builderPacket)
    try store.upsertBuilderPacket(builderPacket)

    let snapshot = store.readSnapshot()
    loopOpsRequire(snapshot.contracts == [contract], "contract upsert should replace by id")
    loopOpsRequire(snapshot.chatThreads == [chatThread], "chat thread upsert should replace by id")
    loopOpsRequire(snapshot.reviewPackets == [reviewPacket], "review packet should round-trip")
    loopOpsRequire(snapshot.runLedgers == [runLedger], "run ledger should round-trip")
    loopOpsRequire(snapshot.shareSafeLogs == [shareSafeLog], "share-safe log should round-trip")
    loopOpsRequire(snapshot.skillStacks == [skillStack], "skill stacks should round-trip")
    loopOpsRequire(snapshot.knowledgeSources == [knowledge], "knowledge sources should round-trip")
    loopOpsRequire(snapshot.toolDrafts == [toolDraft], "tool drafts should round-trip")
    loopOpsRequire(snapshot.toolLogs == [toolLog], "tool logs should round-trip")
    loopOpsRequire(snapshot.builderPackets == [builderPacket], "builder packets should round-trip")
    loopOpsRequire(snapshot.shareSafeLogs[0].redactedLoopSummary.name == contract.name, "share-safe log should keep redacted loop summary")
    loopOpsRequire(snapshot.shareSafeLogs[0].finalAnswerExcerpt == "Final answer should be reviewable.", "share-safe log should keep final answer excerpt")
    loopOpsRequire(snapshot.shareSafeLogs[0].omittedSensitiveFieldsSummary.contains("local setup selections"), "share-safe log should describe omitted local-only fields")

    let encodedLog = String(data: try JSONEncoder.agentArtifactEncoder().encode(shareSafeLog), encoding: .utf8)!
    loopOpsRequire(!encodedLog.contains("runtime/agent/runs"), "share-safe log should not include raw artifact paths")
    loopOpsRequire(!encodedLog.contains("cmc-market-radar"), "share-safe log should not include legacy skill ids")
    loopOpsRequire(FileManager.default.fileExists(atPath: store.contractsURL.path), "contracts store file should exist")
    loopOpsRequire(FileManager.default.fileExists(atPath: store.shareSafeLogsURL.path), "share-safe store file should exist")
    loopOpsRequire(FileManager.default.fileExists(atPath: store.skillStacksURL.path), "skill stacks store file should exist")
    loopOpsRequire(FileManager.default.fileExists(atPath: store.knowledgeSourcesURL.path), "knowledge sources store file should exist")
    loopOpsRequire(FileManager.default.fileExists(atPath: store.toolDraftsURL.path), "tool drafts store file should exist")
    loopOpsRequire(FileManager.default.fileExists(atPath: store.toolLogsURL.path), "tool logs store file should exist")
    loopOpsRequire(FileManager.default.fileExists(atPath: store.builderPacketsURL.path), "builder packets store file should exist")
}

private func loopOpsRequire(_ condition: @autoclosure () -> Bool, _ message: String) {
    precondition(condition(), message)
}

private func loopOpsBuilderTestPackages() -> [LoopOpsSkillPackage] {
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

private func loopOpsLines(_ value: String) -> [String] {
    value
        .split(whereSeparator: \.isNewline)
        .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
}

private func loopOpsTemporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("loopops-v2-tests-\(UUID().uuidString)", isDirectory: true)
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
