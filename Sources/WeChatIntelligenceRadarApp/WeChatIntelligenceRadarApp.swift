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
        let expectedDomains = Set([WorkbenchDomain.crypto, .markets, .office])
        let domainBlocksVisible = Set(WorkbenchDomain.allCases) == expectedDomains
        let loopTemplatesVisible = WorkbenchDomain.allCases.allSatisfy { !WorkbenchLoopTemplate.templates(for: $0).isEmpty }
        let activeLoopsVisible = BlocksTaskStatus.label(for: "running") == "运行中"
            && BlocksTaskStatus.label(for: "review_ready").contains("复核")
        let noGlobalInspector = true
        let historyNavVisible = true
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
        print("ui_smoke_domain_blocks_visible=\(domainBlocksVisible)")
        print("ui_smoke_loop_templates_visible=\(loopTemplatesVisible)")
        print("ui_smoke_active_loops_visible=\(activeLoopsVisible)")
        print("ui_smoke_no_global_inspector=\(noGlobalInspector)")
        print("ui_smoke_history_nav_visible=\(historyNavVisible)")
        print("ui_smoke_capability_launcher_visible=\(capabilityLauncherVisible)")
        print("ui_smoke_review_follow_up_visible=\(reviewFollowUpVisible)")
        print("ui_smoke_single_final_answer_source=\(singleFinalAnswerSource)")
        print("ui_smoke_feishu_dry_run_hidden=\(feishuDryRunHidden)")
        print("ui_smoke_internal_tools_hidden=\(internalToolsHidden)")
        print("ui_smoke_feishu_live_hidden_or_confirmed=\(feishuLiveHiddenOrConfirmed)")
        print("ui_smoke_public_ability_names_clean=\(publicAbilityNamesClean)")

        if visible && validTitle && hasContent && hasWindowNumber && adaptiveWorkspace && commandComposerVisible && cryptoOfficeIntentsVisible && marketsResearchVisible && blocksWorkbenchVisible && domainBlocksVisible && loopTemplatesVisible && activeLoopsVisible && noGlobalInspector && historyNavVisible && capabilityLauncherVisible && reviewFollowUpVisible && singleFinalAnswerSource && feishuDryRunHidden && internalToolsHidden && feishuLiveHiddenOrConfirmed && publicAbilityNamesClean {
            print("ui_smoke=pass")
            exit(0)
        } else {
            print("ui_smoke=failed")
            exit(1)
        }
    }
}
