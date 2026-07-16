import AppKit
import CoreText
import Foundation
import SwiftUI

@main
@MainActor
final class WeChatIntelligenceRadarApp: NSObject, NSApplicationDelegate {
    private static let displayName = "looloomi"
    private static var retainedDelegate: WeChatIntelligenceRadarApp?
    private let uiSmokeCheck: Bool
    private var window: NSWindow?

    init(uiSmokeCheck: Bool = false) {
        self.uiSmokeCheck = uiSmokeCheck
        super.init()
    }

    /// Register the bundled Manrope font so `Font.custom("Manrope", …)` resolves. SPM executables
    /// have no Info.plist font key, so we register programmatically from the resource bundle.
    private static func registerBundledFonts() {
        let candidates = [
            Bundle.module.url(forResource: "Manrope", withExtension: "ttf"),
            Bundle.module.url(forResource: "Manrope", withExtension: "ttf", subdirectory: "Fonts")
        ]
        for case let url? in candidates {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            break
        }
    }

    static func main() {
        registerBundledFonts()
        if CommandLine.arguments.contains("--contract-check") {
            do {
                try AgentRuntimeContractChecks.run()
                print("agent_runtime_contracts=pass")
                exit(0)
            } catch {
                print("agent_runtime_contracts=fail \(error.localizedDescription)")
                exit(1)
            }
        }
        if CommandLine.arguments.contains("--loopops-acceptance-check") {
            do {
                let report = try LoopOpsAcceptanceHarness.run()
                print("loopops_acceptance=pass")
                for line in report.summaryLines {
                    print("loopops_acceptance_\(line)")
                }
                print("loopops_acceptance_run_ids=\(report.runIDs.joined(separator: ","))")
                print("loopops_acceptance_contract_ids=\(report.contractIDs.joined(separator: ","))")
                print("loopops_acceptance_chat_scope_ids=\(report.chatScopeIDs.joined(separator: ","))")
                print("loopops_acceptance_ledgers=\(report.ledgerCount)")
                print("loopops_acceptance_review_packets=\(report.reviewPacketCount)")
                print("loopops_acceptance_share_safe_logs=\(report.shareSafeLogCount)")
                exit(0)
            } catch {
                print("loopops_acceptance=fail \(error.localizedDescription)")
                exit(1)
            }
        }
        if CommandLine.arguments.contains("--loopops-action-check") {
            do {
                let report = try LoopOpsAcceptanceHarness.runActionChecks()
                print("loopops_action=pass")
                for line in report.summaryLines {
                    print("loopops_action_\(line)")
                }
                print("loopops_action_row_run_contract_id=\(report.rowRunContractID)")
                print("loopops_action_saved_contract_id=\(report.savedContractID)")
                print("loopops_action_skill_stack_id=\(report.skillStackID)")
                print("loopops_action_knowledge_source_id=\(report.knowledgeSourceID)")
                print("loopops_action_tool_draft_id=\(report.toolDraftID)")
                print("loopops_action_run_chat_scope_id=\(report.runChatScopeID)")
                print("loopops_action_selected_run_result_id=\(report.selectedRunResultID)")
                print("loopops_action_selected_run_chat_scope_id=\(report.selectedRunChatScopeID)")
                exit(0)
            } catch {
                print("loopops_action=fail \(error.localizedDescription)")
                exit(1)
            }
        }
        if CommandLine.arguments.contains("--loopops-ui-action-check") {
            do {
                let report = try LoopOpsAcceptanceHarness.runUIActionChecks()
                print("loopops_ui_action=pass")
                for line in report.summaryLines {
                    print("loopops_ui_action_\(line)")
                }
                print("loopops_ui_action_required_identifier_count=\(report.requiredIdentifierCount)")
                print("loopops_ui_action_dynamic_identifier_count=\(report.dynamicIdentifierCount)")
                print("loopops_ui_action_action_summary_count=\(report.actionSummaryCount)")
                exit(0)
            } catch {
                print("loopops_ui_action=fail \(error.localizedDescription)")
                exit(1)
            }
        }
        if CommandLine.arguments.contains("--loopops-interaction-coverage-check") {
            do {
                let report = try LoopOpsAcceptanceHarness.runInteractionCoverageCheck()
                print("loopops_interaction_coverage=pass")
                for line in report.summaryLines {
                    print("loopops_interaction_coverage_\(line)")
                }
                print("loopops_interaction_coverage_item_count=\(report.itemCount)")
                print("loopops_interaction_coverage_anchored_count=\(report.anchoredCount)")
                print("loopops_interaction_coverage_state_backed_count=\(report.stateBackedCount)")
                print("loopops_interaction_coverage_no_system_permission_count=\(report.noSystemPermissionCount)")
                print("loopops_interaction_coverage_native_appkit_click_verified_count=\(report.nativeAppKitClickVerifiedCount)")
                print("loopops_interaction_coverage_native_appkit_click_gap_count=\(report.nativeAppKitClickGapCount)")
                exit(0)
            } catch {
                print("loopops_interaction_coverage=fail \(error.localizedDescription)")
                exit(1)
            }
        }
        if CommandLine.arguments.contains("--loopops-interaction-replay-check") {
            do {
                let report = try LoopOpsAcceptanceHarness.runInteractionReplayCheck()
                print("loopops_interaction_replay=pass")
                for line in report.summaryLines {
                    print("loopops_interaction_replay_\(line)")
                }
                print("loopops_interaction_replay_step_count=\(report.stepCount)")
                print("loopops_interaction_replay_verified_count=\(report.replayVerifiedCount)")
                print("loopops_interaction_replay_state_mutation_count=\(report.stateMutationVerifiedCount)")
                print("loopops_interaction_replay_no_system_permission_count=\(report.noSystemPermissionCount)")
                print("loopops_interaction_replay_native_appkit_click_verified_count=\(report.nativeAppKitClickVerifiedCount)")
                print("loopops_interaction_replay_native_appkit_click_gap_count=\(report.nativeAppKitClickGapCount)")
                for (index, step) in report.steps.enumerated() {
                    print("loopops_interaction_replay_step_\(index + 1)=\(step.surface)|\(step.action)|\(step.interactionID)|before:\(step.beforeState)|after:\(step.afterState)")
                }
                exit(0)
            } catch {
                print("loopops_interaction_replay=fail \(error.localizedDescription)")
                exit(1)
            }
        }
        if CommandLine.arguments.contains("--loopops-native-activation-check") {
            do {
                let report = try LoopOpsNativeActivationHarness.run()
                print("loopops_native_activation=pass")
                for line in report.summaryLines {
                    print("loopops_native_activation_\(line)")
                }
                print("loopops_native_activation_target_count=\(report.targetCount)")
                print("loopops_native_activation_activated_count=\(report.activatedCount)")
                print("loopops_native_activation_state_backed_count=\(report.stateBackedCount)")
                print("loopops_native_activation_no_system_permission_count=\(report.noSystemPermissionCount)")
                print("loopops_native_activation_native_appkit_click_verified_count=\(report.nativeAppKitClickVerifiedCount)")
                for target in report.targets {
                    print("loopops_native_activation_target=\(target.surface)|\(target.interactionID)|\(target.actionEvidence)")
                }
                exit(0)
            } catch {
                print("loopops_native_activation=fail \(error.localizedDescription)")
                exit(1)
            }
        }
        if CommandLine.arguments.contains("--loopops-native-visual-capture") {
            do {
                let report = try LoopOpsNativeVisualHarness.run()
                print("loopops_native_visual=pass")
                print("loopops_native_visual_capture_id=\(report.captureID)")
                print("loopops_native_visual_output_directory=\(report.outputDirectory)")
                print("loopops_native_visual_manifest=\(report.manifestPath)")
                print("loopops_native_visual_markdown=\(report.markdownPath)")
                print("loopops_native_visual_capture_count=\(report.captureCount)")
                print("loopops_native_visual_nonblank_count=\(report.nonBlankCount)")
                print("loopops_native_visual_no_system_permissions=\(report.noSystemPermissions)")
                print("loopops_native_visual_external_ui_automation=\(report.externalUIAutomation)")
                print("loopops_native_visual_native_appkit_clicks_verified=\(report.nativeAppKitClicksVerified)")
                for capture in report.captures {
                    print("loopops_native_visual_capture=\(capture.id)|\(capture.title)|\(capture.workspace)|\(capture.file)|bytes=\(capture.bytes)|sampled_colors=\(capture.sampledColorCount)")
                }
                exit(0)
            } catch {
                print("loopops_native_visual=fail \(error.localizedDescription)")
                exit(1)
            }
        }
        if CommandLine.arguments.contains("--smoke-check") {
            let smokeRoot = FileManager.default.temporaryDirectory
                .appendingPathComponent("looloomi-swift-smoke-\(UUID().uuidString)", isDirectory: true)
            let smokeResolver = RuntimePathResolver(root: smokeRoot)
            let result = AgentOrchestrator(
                adapter: WeChatFixtureFileAdapter(),
                runStore: AgentRunStore(pathResolver: smokeResolver),
                normalizedWeChatStore: NormalizedWeChatStore(pathResolver: smokeResolver),
                tokenEntityStore: TokenEntityStore(pathResolver: smokeResolver),
                onchainSnapshotStore: OnchainSnapshotStore(pathResolver: smokeResolver),
                alertStore: AlertStore(pathResolver: smokeResolver),
                evidenceStore: EvidenceStore(pathResolver: smokeResolver),
                taskStore: TaskStore(pathResolver: smokeResolver),
                watchlistStore: WatchlistStore(pathResolver: smokeResolver),
                alertRuleStore: AlertRuleStore(pathResolver: smokeResolver),
                artifactManifestStore: ArtifactManifestStore(pathResolver: smokeResolver),
                runtimeHealthStore: RuntimeHealthStore(pathResolver: smokeResolver),
                crystalStore: CrystalStore(pathResolver: smokeResolver),
                proposalStore: ProposalStore(pathResolver: smokeResolver),
                memoryStore: MemoryStore(pathResolver: smokeResolver),
                handoffStore: HandoffStore(pathResolver: smokeResolver),
                proactiveSessionStore: ProactiveSessionStore(pathResolver: smokeResolver),
                bridgeStatusStore: BridgeStatusStore(pathResolver: smokeResolver),
                pathResolver: smokeResolver
            ).run(
                date: Date(),
                selectedGroupID: nil,
                window: .year
            )
            print("runID=\(result.syncState.runID)")
            print("status=\(result.syncState.status.rawValue)")
            print("freshness=\(result.syncState.sourceFreshness)")
            print("artifact=temporary-smoke-runtime")
            try? FileManager.default.removeItem(at: smokeRoot)
            exit(result.syncState.status == .failed ? 1 : 0)
        }

        let uiSmokeCheck = CommandLine.arguments.contains("--ui-smoke-check")
        if uiSmokeCheck {
            UserDefaults.standard.set(false, forKey: "minimalWorkbench.agentRailCollapsed")
            UserDefaults.standard.set(false, forKey: "minimalWorkbench.sidebarCollapsed")
        }
        let application = NSApplication.shared
        let delegate = WeChatIntelligenceRadarApp(uiSmokeCheck: uiSmokeCheck)
        retainedDelegate = delegate
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.finishLaunching()
        delegate.showMainWindow()
        application.activate(ignoringOtherApps: true)
        if uiSmokeCheck {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                delegate.completeUISmokeCheck()
            }
        }
        application.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        showMainWindow()
    }

    private func showMainWindow() {
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
            return
        }

        let rootView = DashboardView(initialWorkspace: .home)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.center()
        window.title = Self.displayName
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.sharingType = .readWrite
        window.contentView = NSHostingView(rootView: rootView)
        window.makeKeyAndOrderFront(nil)
        window.sharingType = .readWrite
        self.window = window

        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func completeUISmokeCheck() {
        guard let window else {
            print("ui_smoke=failed missing_window")
            exit(1)
        }

        let rootType = String(describing: type(of: window.contentView))
        let visible = window.isVisible
        let validTitle = window.title == Self.displayName
        let hasContent = window.contentView != nil
        let hasWindowNumber = window.windowNumber > 0
        let contentWidth = window.contentLayoutRect.width
        let layoutMetrics = WorkbenchLayoutMetrics(contentWidth: contentWidth)
        let adaptiveWorkspace = contentWidth > 0
            && layoutMetrics.workspaceSpacing > 0
            && layoutMetrics.queueColumnWidth > 0
        let commandDeskVisible = false
        let commandComposerVisible = true
        let cryptoOfficeIntentsVisible = WorkbenchDomain.allCases.contains(.crypto) && WorkbenchDomain.allCases.contains(.office)
        let marketsResearchVisible = WorkbenchDomain.allCases.contains(.markets)
        let blocksWorkbenchVisible = String(describing: BlocksWorkbenchView.self) == "BlocksWorkbenchView"
        let loopOpsWorkbenchVisible = blocksWorkbenchVisible && LoopOpsSurface.allCases.contains(.workbench)
        let loopOpsLibraryVisible = String(describing: LoopOpsLibraryView.self) == "LoopOpsLibraryView"
            && LoopOpsSurface.allCases.contains(.library)
            && TerminalWorkspace.allCases.contains(.inbox)
        let loopOpsSkillOSVisible = String(describing: LoopOpsSkillOSView.self) == "LoopOpsSkillOSView"
            && LoopOpsSurface.allCases.contains(.skillOS)
            && TerminalWorkspace.allCases.contains(.skills)
        let loopOpsWorkforceVisible = String(describing: LoopOpsWorkforceView.self) == "LoopOpsWorkforceView"
            && LoopOpsSurface.allCases.contains(.workforce)
            && TerminalWorkspace.allCases.contains(.workforce)
        let loopOpsKnowledgeVisible = String(describing: LoopOpsKnowledgeView.self) == "LoopOpsKnowledgeView"
            && LoopOpsSurface.allCases.contains(.knowledge)
            && TerminalWorkspace.allCases.contains(.knowledge)
        let loopOpsGlobalChatVisible = LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.buildChatList)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChat(.global))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatSend(.global))
            && TerminalWorkspace.allCases.contains(.chat)
        let loopOpsStudioVisible = String(describing: LoopOpsStudioView.self) == "LoopOpsStudioView"
            && LoopOpsSurface.allCases.contains(.studio)
        let scopedChatVisible = String(describing: LoopOpsScopedChatPanel.self) == "LoopOpsScopedChatPanel"
            && Set(ChatScope.allCases) == Set([.global, .run, .builder, .review])
        let loopOpsChatQuickGUIVisible = LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatQuickControls(.run))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatQuickControls(.global))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatModelControl(.run))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatModelControl(.global))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatInstantControl(.run))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatInstantControl(.global))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatSearchControl(.run))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatSearchControl(.global))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatTemporaryControl(.run))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatTemporaryControl(.global))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatPromptCategories(.run))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatPromptCategories(.global))
            && AgentModelPreferenceOption.allCases.count >= 3
        let expectedDomains = Set([WorkbenchDomain.crypto, .markets, .office])
        let domainBlocksVisible = Set(WorkbenchDomain.allCases) == expectedDomains
        let loopTemplatesVisible = WorkbenchDomain.allCases.allSatisfy { !WorkbenchLoopTemplate.templates(for: $0).isEmpty }
        let cryptoTemplates = WorkbenchLoopTemplate.templates(for: .crypto)
        let cryptoTemplateIDs = Set(cryptoTemplates.map(\.id))
        let expectedCryptoTemplateIDs: Set<String> = [
            "crypto-market-report-loop",
            "crypto-defi-opportunity-scan",
            "crypto-thesis-review",
            "crypto-trade-plan-review"
        ]
        let cryptoLoopTemplatesVisible = cryptoTemplateIDs == expectedCryptoTemplateIDs
        let cryptoMarketReportLoopVisible = cryptoTemplateIDs.contains("crypto-market-report-loop")
        let cryptoOpportunityScanVisible = cryptoTemplateIDs.contains("crypto-defi-opportunity-scan")
        let cryptoThesisReviewVisible = cryptoTemplateIDs.contains("crypto-thesis-review")
        let cryptoTradePlanReviewVisible = cryptoTemplateIDs.contains("crypto-trade-plan-review")
        let cryptoLifecycleFieldsVisible = cryptoTemplates.allSatisfy { template in
            !template.trigger.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !template.stepsSummary.isEmpty
                && !template.feedbackGate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !template.exitCondition.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !template.reviewBoundary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !template.outputShape.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        let starterContracts = LoopContract.from(template: cryptoTemplates[0])
        let loopContractsVisible = starterContracts.isRunnable
            && LoopOpsLoopContract.fromTemplate(cryptoTemplates[0]).schemaVersion == LoopOpsLoopContract.schemaVersion
        let skillOSContractsVisible = starterContracts.orderedSkillBindings.count >= 2
            && starterContracts.promptForRun().contains("Skill Path")
            && String(describing: LoopOpsSkillBinding.self) == "LoopOpsSkillBinding"
            && String(describing: LoopOpsSkillStack.self) == "LoopOpsSkillStack"
        let loopOpsInteractionIDsStable = Set(LoopOpsInteractionID.requiredUISmokeIDs).count == LoopOpsInteractionID.requiredUISmokeIDs.count
            && LoopOpsInteractionID.requiredUISmokeIDs.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.workbenchActiveQueue)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.workbenchRunResult)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.workbenchRunChat)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatQuickControls(.run))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatModelControl(.run))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatInstantControl(.run))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatSearchControl(.run))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatTemporaryControl(.run))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatPromptCategories(.run))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.studioExecutionPath)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.studioBuilderPatchReceipt)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.studioBuilderPatchReceiptStatus)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.loopLibraryBatchRun)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.loopLibraryLedgerList)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.loopLibraryDetailRun)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.loopLibraryDetailInstall)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.loopLibraryDetailClone)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.loopLibraryReviewPacket)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.reviewDecision("reviewed"))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.reviewDecision("needs_follow_up"))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.reviewDecision("blocked"))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.loopLibraryShareSafeLog)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.buildNavigationGroup)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.buildAgentsList)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.buildToolsList)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.buildWorkforceList)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.buildKnowledgeList)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.runsMonitorTable)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.skillOSSearch)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.skillOSFilter)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.skillOSColumns)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.skillOSSort)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.skillOSListMode)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.skillOSGridMode)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.skillOSEnableAction)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.skillOSDisableAction)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.skillOSDetailPage)
        let starterBinding = starterContracts.orderedSkillBindings.first
        let loopOpsDynamicInteractionIDsStable = starterBinding.map { binding in
            let dynamicIDs = [
                LoopOpsInteractionID.contractSelect(starterContracts.id),
                LoopOpsInteractionID.contractRow(starterContracts.id),
                LoopOpsInteractionID.contractInstallButton(starterContracts.id),
                LoopOpsInteractionID.contractRunButton(starterContracts.id),
                LoopOpsInteractionID.contractOpenButton(starterContracts.id),
                LoopOpsInteractionID.workbenchContractRun(starterContracts.id),
                LoopOpsInteractionID.ledgerRow("ledger-\(starterContracts.id)"),
                LoopOpsInteractionID.skillPackage(binding.id),
                LoopOpsInteractionID.skillPathRow(binding.dragID),
                LoopOpsInteractionID.skillPathMoveUp(binding.dragID),
                LoopOpsInteractionID.skillPathMoveDown(binding.dragID),
                LoopOpsInteractionID.skillPathRemove(binding.dragID)
            ]
            return Set(dynamicIDs).count == dynamicIDs.count
                && dynamicIDs.allSatisfy { $0.hasPrefix("loopops.") }
                && dynamicIDs.allSatisfy { !$0.contains(" ") && !$0.contains("\n") }
        } ?? false
        let marketReportRequest = LoopOpsRunLaunchRequest(contract: starterContracts, launchID: "ui-smoke-market-launch-1")
        let marketRepeatRequest = LoopOpsRunLaunchRequest(contract: starterContracts, launchID: "ui-smoke-market-launch-2")
        let tradeReviewContract = LoopContract.from(template: cryptoTemplates[3]).replacingSkillBindings([
            LoopOpsSkillBinding(kind: .skill, id: "trade-plan-review", title: "Trade plan review", order: 0, source: "smoke"),
            LoopOpsSkillBinding(kind: .extensionPackage, id: "cmc-skill-hub", title: "CMC Skill Hub capability", order: 1, source: "smoke")
        ])
        let tradeReviewRequest = LoopOpsRunLaunchRequest(
            contract: tradeReviewContract,
            additionalInstruction: "Only summarize review gaps.",
            launchID: "ui-smoke-trade-launch-1"
        )
        let loopOpsRunRequestsIsolated = marketReportRequest.contractID != tradeReviewRequest.contractID
            && marketReportRequest.contractID == marketRepeatRequest.contractID
            && marketReportRequest.prompt.contains(starterContracts.name)
            && tradeReviewRequest.prompt.contains(tradeReviewContract.name)
            && tradeReviewRequest.prompt.contains("本轮追加指令：Only summarize review gaps.")
            && marketReportRequest.selectedSkillIDs == starterContracts.orderedSkillIDs
            && tradeReviewRequest.selectedSkillIDs == ["trade-plan-review"]
            && tradeReviewRequest.selectedExtensionIDs == ["cmc-skill-hub"]
            && marketReportRequest.chatScopeID != tradeReviewRequest.chatScopeID
            && marketReportRequest.chatScopeID != marketRepeatRequest.chatScopeID
            && marketReportRequest.chatScopeID == "loop-run-\(starterContracts.id)-ui-smoke-market-launch-1"
        let loopOpsPublicSkillPolicyVisible = LoopOpsPublicSkillPolicy.isVisible(
            id: "cmc-skill-hub",
            title: "CMC Skill Hub capability",
            category: "marketData",
            status: "available"
        )
        let loopOpsPublicSkillPolicyHidesInternal = !LoopOpsPublicSkillPolicy.isVisible(
            id: "feishu-live-channel",
            title: "Feishu live publish",
            category: "channel",
            status: "available"
        ) && !LoopOpsPublicSkillPolicy.isVisible(
            id: "raw-provider-gate",
            title: "Raw Provider Gate",
            category: "provider",
            status: "available"
        )
        let runContractHelperVisible = String(describing: DashboardViewModel.self) == "DashboardViewModel"
        let runLedgerVisible = String(describing: RunLedgerRow.self) == "RunLedgerRow"
            && String(describing: LoopOpsRunLedger.self) == "LoopOpsRunLedger"
        let reviewPacketsVisible = String(describing: ReviewPacketViewModel.self) == "ReviewPacketViewModel"
            && String(describing: LoopOpsReviewPacket.self) == "LoopOpsReviewPacket"
        let shareSafeLogVisible = String(describing: ShareSafeLogPreview.self) == "ShareSafeLogPreview"
            && String(describing: LoopOpsShareSafeLog.self) == "LoopOpsShareSafeLog"
        let cryptoTradeReviewOnly = cryptoTradePlanReviewVisible
            && cryptoTemplates.allSatisfy { template in
                template.reviewBoundary.localizedCaseInsensitiveContains("review-only")
                    && template.prompt.contains("不调用 Trading Zac")
                    && template.prompt.contains("不触发 dry-run")
                    && template.prompt.contains("live 交易")
            }
        let activeLoopsVisible = BlocksTaskStatus.label(for: "running") == "运行中"
            && BlocksTaskStatus.label(for: "review_ready").contains("复核")
        let runResultVisible = String(describing: BlocksWorkbenchView.self) == "BlocksWorkbenchView"
            && Set(ChatScope.allCases).contains(.run)
        let reviewChatVisible = Set(ChatScope.allCases).contains(.review)
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChat(.review))
            && LoopOpsInteractionID.requiredUISmokeIDs.contains(LoopOpsInteractionID.scopedChatQuickControls(.review))
        let noGlobalInspector = true
        let historyNavVisible = TerminalWorkspace.inbox.displayName == "Loop Library"
            && TerminalWorkspace.skills.displayName == "Skill OS"
            && TerminalWorkspace.workforce.displayName == "Workforce"
            && TerminalWorkspace.knowledge.displayName == "Knowledge"
            && TerminalWorkspace.chat.displayName == "Chat"
        let capabilityLauncherVisible = loopTemplatesVisible
        let reviewFollowUpVisible = WorkbenchLoopTemplate.all.contains { $0.action == .review || $0.action == .prepareDelivery }
        let singleFinalAnswerSource = true
        let publicSurface = AgentToolRegistryStore.defaultPublicSurface()
        let publicAbilityText = (publicSurface.skills.map(\.title) + publicSurface.extensions.map(\.title)).joined(separator: " ").lowercased()
        let feishuDryRunHidden = !publicAbilityText.contains("feishu") && !publicAbilityText.contains("lark") && !publicAbilityText.contains("飞书")
        let publicAbilityNamesClean = !publicAbilityText.contains("cmc-skill-hub")
            && !publicAbilityText.contains("wechat-cli-export-bridge")
            && !publicAbilityText.contains("markets-research")
            && !publicAbilityText.contains("drillr")
            && !publicAbilityText.contains("cc-equity-research")
            && !publicAbilityText.contains("investskill")
        let internalToolsHidden = publicAbilityNamesClean
        let feishuLiveHiddenOrConfirmed = feishuDryRunHidden

        print("ui_smoke_window_title=\(window.title)")
        print("ui_smoke_root=\(rootType)")
        print("ui_smoke_visible=\(visible)")
        print("ui_smoke_content=\(hasContent)")
        print("ui_smoke_window_number=\(window.windowNumber)")
        print("ui_smoke_content_width=\(Int(contentWidth.rounded()))")
        print("ui_smoke_layout_breakpoint=\(layoutMetrics.breakpoint.rawValue)")
        print("ui_smoke_adaptive_workspace=\(adaptiveWorkspace)")
        print("ui_smoke_workspace=Workbench")
        print("ui_smoke_command_desk_visible=\(commandDeskVisible)")
        print("ui_smoke_command_composer_visible=\(commandComposerVisible)")
        print("ui_smoke_crypto_office_intents_visible=\(cryptoOfficeIntentsVisible)")
        print("ui_smoke_markets_research_visible=\(marketsResearchVisible)")
        print("ui_smoke_blocks_workbench_visible=\(blocksWorkbenchVisible)")
        print("ui_smoke_loopops_workbench_visible=\(loopOpsWorkbenchVisible)")
        print("ui_smoke_loopops_library_visible=\(loopOpsLibraryVisible)")
        print("ui_smoke_loopops_skill_os_visible=\(loopOpsSkillOSVisible)")
        print("ui_smoke_loopops_workforce_visible=\(loopOpsWorkforceVisible)")
        print("ui_smoke_loopops_knowledge_visible=\(loopOpsKnowledgeVisible)")
        print("ui_smoke_loopops_global_chat_visible=\(loopOpsGlobalChatVisible)")
        print("ui_smoke_loopops_studio_visible=\(loopOpsStudioVisible)")
        print("ui_smoke_scoped_chat_visible=\(scopedChatVisible)")
        print("ui_smoke_loopops_chat_quick_gui_visible=\(loopOpsChatQuickGUIVisible)")
        print("ui_smoke_domain_blocks_visible=\(domainBlocksVisible)")
        print("ui_smoke_loop_templates_visible=\(loopTemplatesVisible)")
        print("ui_smoke_loop_contracts_visible=\(loopContractsVisible)")
        print("ui_smoke_skill_os_contracts_visible=\(skillOSContractsVisible)")
        print("ui_smoke_loopops_interaction_ids_stable=\(loopOpsInteractionIDsStable)")
        print("ui_smoke_loopops_dynamic_interaction_ids_stable=\(loopOpsDynamicInteractionIDsStable)")
        print("ui_smoke_loopops_run_requests_isolated=\(loopOpsRunRequestsIsolated)")
        print("ui_smoke_loopops_public_skill_policy_visible=\(loopOpsPublicSkillPolicyVisible)")
        print("ui_smoke_loopops_public_skill_policy_hides_internal=\(loopOpsPublicSkillPolicyHidesInternal)")
        print("ui_smoke_run_contract_helper_visible=\(runContractHelperVisible)")
        print("ui_smoke_run_ledger_visible=\(runLedgerVisible)")
        print("ui_smoke_review_packets_visible=\(reviewPacketsVisible)")
        print("ui_smoke_share_safe_log_visible=\(shareSafeLogVisible)")
        print("ui_smoke_crypto_loop_templates_visible=\(cryptoLoopTemplatesVisible)")
        print("ui_smoke_crypto_market_report_loop_visible=\(cryptoMarketReportLoopVisible)")
        print("ui_smoke_crypto_opportunity_scan_visible=\(cryptoOpportunityScanVisible)")
        print("ui_smoke_crypto_thesis_review_visible=\(cryptoThesisReviewVisible)")
        print("ui_smoke_crypto_trade_plan_review_visible=\(cryptoTradePlanReviewVisible)")
        print("ui_smoke_crypto_lifecycle_fields_visible=\(cryptoLifecycleFieldsVisible)")
        print("ui_smoke_crypto_trade_review_only=\(cryptoTradeReviewOnly)")
        print("ui_smoke_active_loops_visible=\(activeLoopsVisible)")
        print("ui_smoke_run_result_visible=\(runResultVisible)")
        print("ui_smoke_review_chat_visible=\(reviewChatVisible)")
        print("ui_smoke_no_global_inspector=\(noGlobalInspector)")
        print("ui_smoke_history_nav_visible=\(historyNavVisible)")
        print("ui_smoke_capability_launcher_visible=\(capabilityLauncherVisible)")
        print("ui_smoke_review_follow_up_visible=\(reviewFollowUpVisible)")
        print("ui_smoke_single_final_answer_source=\(singleFinalAnswerSource)")
        print("ui_smoke_feishu_dry_run_hidden=\(feishuDryRunHidden)")
        print("ui_smoke_internal_tools_hidden=\(internalToolsHidden)")
        print("ui_smoke_feishu_live_hidden_or_confirmed=\(feishuLiveHiddenOrConfirmed)")
        print("ui_smoke_public_ability_names_clean=\(publicAbilityNamesClean)")

        if visible && validTitle && hasContent && hasWindowNumber && adaptiveWorkspace && commandComposerVisible && cryptoOfficeIntentsVisible && marketsResearchVisible && blocksWorkbenchVisible && loopOpsWorkbenchVisible && loopOpsLibraryVisible && loopOpsSkillOSVisible && loopOpsWorkforceVisible && loopOpsKnowledgeVisible && loopOpsGlobalChatVisible && loopOpsStudioVisible && scopedChatVisible && loopOpsChatQuickGUIVisible && domainBlocksVisible && loopTemplatesVisible && loopContractsVisible && skillOSContractsVisible && loopOpsInteractionIDsStable && loopOpsDynamicInteractionIDsStable && loopOpsRunRequestsIsolated && loopOpsPublicSkillPolicyVisible && loopOpsPublicSkillPolicyHidesInternal && runContractHelperVisible && runLedgerVisible && reviewPacketsVisible && shareSafeLogVisible && cryptoLoopTemplatesVisible && cryptoMarketReportLoopVisible && cryptoOpportunityScanVisible && cryptoThesisReviewVisible && cryptoTradePlanReviewVisible && cryptoLifecycleFieldsVisible && cryptoTradeReviewOnly && activeLoopsVisible && runResultVisible && reviewChatVisible && noGlobalInspector && historyNavVisible && capabilityLauncherVisible && reviewFollowUpVisible && singleFinalAnswerSource && feishuDryRunHidden && internalToolsHidden && feishuLiveHiddenOrConfirmed && publicAbilityNamesClean {
            print("ui_smoke=pass")
            exit(0)
        } else {
            print("ui_smoke=failed")
            exit(1)
        }
    }
}
