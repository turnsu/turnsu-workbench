import AppKit
import CoreText
import Foundation
import SwiftUI

@main
@MainActor
final class WeChatIntelligenceRadarApp: NSObject, NSApplicationDelegate {
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
        if CommandLine.arguments.contains("--smoke-check") {
            let result = AgentOrchestrator(adapter: WeChatFixtureFileAdapter()).run(
                date: Date(),
                selectedGroupID: nil,
                window: .year
            )
            print("runID=\(result.syncState.runID)")
            print("status=\(result.syncState.status.rawValue)")
            print("freshness=\(result.syncState.sourceFreshness)")
            print("artifact=\(result.artifactStatus?.runDirectory ?? "--")")
            exit(result.syncState.status == .failed ? 1 : 0)
        }

        let uiSmokeCheck = CommandLine.arguments.contains("--ui-smoke-check")
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
        window.title = "WeChat Intelligence Radar"
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
        let validTitle = window.title == "WeChat Intelligence Radar"
        let hasContent = window.contentView != nil
        let hasWindowNumber = window.windowNumber > 0

        print("ui_smoke_window_title=\(window.title)")
        print("ui_smoke_root=\(rootType)")
        print("ui_smoke_visible=\(visible)")
        print("ui_smoke_content=\(hasContent)")
        print("ui_smoke_window_number=\(window.windowNumber)")
        print("ui_smoke_workspace=\(TerminalWorkspace.home.rawValue)")

        if visible && validTitle && hasContent && hasWindowNumber {
            print("ui_smoke=pass")
            exit(0)
        } else {
            print("ui_smoke=failed")
            exit(1)
        }
    }
}
