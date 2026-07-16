import AppKit
import Foundation
import SwiftUI

struct LoopOpsNativeVisualCapture: Codable, Hashable {
    var id: String
    var title: String
    var workspace: String
    var file: String
    var width: Int
    var height: Int
    var bytes: Int
    var sampledColorCount: Int
    var nonBlank: Bool
}

struct LoopOpsNativeVisualReport: Codable, Hashable {
    var captureID: String
    var created: String
    var outputDirectory: String
    var manifestPath: String
    var markdownPath: String
    var permissionModel: String
    var noSystemPermissions: Bool
    var externalUIAutomation: Bool
    var nativeAppKitClicksVerified: Bool
    var captureCount: Int
    var nonBlankCount: Int
    var captures: [LoopOpsNativeVisualCapture]
}

enum LoopOpsNativeVisualHarness {
    private struct Scenario {
        var id: String
        var title: String
        var workspace: TerminalWorkspace
        var width: Int
        var height: Int
    }

    @MainActor
    static func run() throws -> LoopOpsNativeVisualReport {
        let timestamp = timestampString()
        let captureID = "loopops-native-visual-\(timestamp)"
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        let outputDirectory = root
            .appendingPathComponent("domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/native-visual-audit", isDirectory: true)
            .appendingPathComponent(captureID, isDirectory: true)
        try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

        UserDefaults.standard.set(false, forKey: "minimalWorkbench.agentRailCollapsed")
        UserDefaults.standard.set(false, forKey: "minimalWorkbench.sidebarCollapsed")

        let scenarios = [
            Scenario(id: "01-workbench", title: "Workbench Run Result", workspace: .home, width: 1700, height: 980),
            Scenario(id: "02-loop-library", title: "Loop Library database", workspace: .inbox, width: 1280, height: 820),
            Scenario(id: "03-skill-os", title: "Skill OS and Tool Logs", workspace: .skills, width: 1280, height: 820),
            Scenario(id: "04-knowledge", title: "Knowledge library", workspace: .knowledge, width: 1280, height: 820),
            Scenario(id: "05-chat", title: "Global Chat workspace", workspace: .chat, width: 1280, height: 820),
            Scenario(id: "06-studio", title: "Studio builder", workspace: .studio, width: 1280, height: 820)
        ]

        let captures = try scenarios.map { scenario in
            try capture(scenario, outputDirectory: outputDirectory)
        }
        try require(captures.count == scenarios.count, "native visual capture should produce every scenario")
        try require(captures.allSatisfy(\.nonBlank), "native visual captures should be nonblank")

        let manifestPath = outputDirectory.appendingPathComponent("manifest.json")
        let markdownPath = outputDirectory.appendingPathComponent("README.md")
        let report = LoopOpsNativeVisualReport(
            captureID: captureID,
            created: timestamp,
            outputDirectory: outputDirectory.path,
            manifestPath: manifestPath.path,
            markdownPath: markdownPath.path,
            permissionModel: "offscreen NSHostingView render; no open, AppleScript, Accessibility, screen recording, Chrome/Safari, browser automation, or external AppKit click automation",
            noSystemPermissions: true,
            externalUIAutomation: false,
            nativeAppKitClicksVerified: false,
            captureCount: captures.count,
            nonBlankCount: captures.filter(\.nonBlank).count,
            captures: captures
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(report).write(to: manifestPath)
        try markdown(for: report).write(to: markdownPath, atomically: true, encoding: .utf8)
        return report
    }

    @MainActor
    private static func capture(_ scenario: Scenario, outputDirectory: URL) throws -> LoopOpsNativeVisualCapture {
        let size = NSSize(width: scenario.width, height: scenario.height)
        let storeRoot = outputDirectory
            .appendingPathComponent("store-\(scenario.id)", isDirectory: true)
        let store = LoopOpsLocalStore(
            rootURL: storeRoot.appendingPathComponent("light", isDirectory: true),
            strictJSONStore: LoopOpsLocalJSONStore(root: storeRoot.appendingPathComponent("strict", isDirectory: true))
        )
        seedStore(store, for: scenario)
        let view = DashboardView(initialWorkspace: scenario.workspace, loopOpsStore: store)
            .frame(width: size.width, height: size.height)
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(origin: .zero, size: size)
        host.setFrameSize(size)
        host.wantsLayer = true

        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = host
        window.backgroundColor = .windowBackgroundColor
        window.isReleasedWhenClosed = false

        for _ in 0..<8 {
            host.needsLayout = true
            host.layoutSubtreeIfNeeded()
            host.displayIfNeeded()
            window.contentView?.displayIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.04))
        }

        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            throw ContractCheckError("failed to allocate bitmap for \(scenario.id)")
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw ContractCheckError("failed to encode PNG for \(scenario.id)")
        }

        let fileURL = outputDirectory.appendingPathComponent("\(scenario.id).png")
        try data.write(to: fileURL)
        let sampledColorCount = sampledUniqueColorCount(data: data)
        let nonBlank = data.count > 12_000 && sampledColorCount >= 8
        try require(nonBlank, "native visual capture appears blank: \(scenario.id) bytes=\(data.count) colors=\(sampledColorCount)")

        return LoopOpsNativeVisualCapture(
            id: scenario.id,
            title: scenario.title,
            workspace: scenario.workspace.displayName,
            file: fileURL.path,
            width: scenario.width,
            height: scenario.height,
            bytes: data.count,
            sampledColorCount: sampledColorCount,
            nonBlank: nonBlank
        )
    }

    @MainActor
    private static func seedStore(_ store: LoopOpsLocalStore, for scenario: Scenario) {
        guard scenario.id == "01-workbench" else { return }
        let contract = LoopContract.from(template: WorkbenchLoopTemplate.templates(for: .crypto)[0])
        let runID = "visual-run-result-state"
        store.upsert(contract)
        let ledger = RunLedgerRow(
            id: runID,
            loopContractID: contract.id,
            runID: runID,
            title: contract.name,
            domain: contract.domain,
            status: "review_ready",
            startedAt: "2026-06-27T07:40:00.000Z",
            completedAt: "2026-06-27T07:42:00.000Z",
            inputsUsed: ["Workspace context", "Market notes"],
            finalAnswerPreview: "Review packet final answer is ready for manual review.",
            evidenceGaps: ["Confirm source timestamp"],
            blockedActions: [],
            reviewDecision: "needs_follow_up",
            followUpPrompts: ["Attach latest market note"],
            cloneable: true,
            replayable: true,
            skillPath: contract.orderedSkillPathLabels,
            lifecycleEvents: [
                "Queued · 2026-06-27T07:40:00.000Z",
                "Review packet · Packet created · 2026-06-27T07:41:00.000Z",
                "Knowledge attached · Market evidence note · 2026-06-27T07:42:00.000Z"
            ],
            knowledgeSourceIDs: ["visual-knowledge-source"]
        )
        store.captureRunLedger(ledger)
        let packet = ReviewPacketViewModel(
            id: "visual-review-packet",
            runID: runID,
            finalAnswer: "Review packet final answer is ready for manual review.",
            domainSummary: "Crypto review packet",
            claims: ["Market stance is review-ready."],
            evidenceGaps: ["Confirm source timestamp"],
            uncertainty: "medium",
            blockedActions: [],
            nextQuestions: ["Attach latest market note"],
            reviewDecision: "needs_follow_up",
            reviewNotes: "Visual seed for Run Result state review."
        )
        store.upsertReviewPacket(packet)
        store.upsertKnowledgeSource(LoopOpsKnowledgeSource(
            id: "visual-knowledge-source",
            title: "Market evidence note",
            kind: .blank,
            summary: "Reusable evidence attached to this visual run.",
            status: .ready,
            reuseMode: .attachToLoop,
            linkedRunID: runID,
            linkedRunIDs: [runID],
            sourceLabel: "Manual note"
        ))
        store.appendToolLog(LoopOpsToolLog(
            id: "visual-tool-log",
            toolID: "visual-tool",
            title: "Evidence freshness checker",
            status: "Run scoped",
            summary: "Checked selected run evidence.",
            inputSummary: "Run result and market notes",
            outputSummary: "Timestamp gap found.",
            durationLabel: "1s",
            reviewState: "Needs review",
            runID: runID,
            source: "Skill OS"
        ))
        store.appendMessage(
            scope: .run,
            scopeID: runID,
            title: contract.name,
            role: .user,
            text: "Summarize only this run's evidence gaps."
        )
    }

    private static func sampledUniqueColorCount(data: Data) -> Int {
        guard let bitmap = NSBitmapImageRep(data: data) else { return 0 }
        let width = max(bitmap.pixelsWide, 1)
        let height = max(bitmap.pixelsHigh, 1)
        var colors = Set<String>()
        let xStride = max(width / 24, 1)
        let yStride = max(height / 18, 1)
        var y = 0
        while y < height {
            var x = 0
            while x < width {
                if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) {
                    let r = Int((color.redComponent * 255).rounded())
                    let g = Int((color.greenComponent * 255).rounded())
                    let b = Int((color.blueComponent * 255).rounded())
                    let a = Int((color.alphaComponent * 255).rounded())
                    colors.insert("\(r),\(g),\(b),\(a)")
                }
                x += xStride
            }
            y += yStride
        }
        return colors.count
    }

    private static func markdown(for report: LoopOpsNativeVisualReport) -> String {
        var lines: [String] = [
            "# LoopOps Native Visual Audit",
            "",
            "- Capture ID: `\(report.captureID)`",
            "- Created: `\(report.created)`",
            "- Permission model: \(report.permissionModel)",
            "- No system permissions: `\(report.noSystemPermissions)`",
            "- External UI automation: `\(report.externalUIAutomation)`",
            "- Native AppKit/XCUITest clicks verified: `\(report.nativeAppKitClicksVerified)`",
            "- Capture count: `\(report.captureCount)`",
            "- Nonblank captures: `\(report.nonBlankCount)`",
            "",
            "## Captures",
            "",
            "| Surface | Workspace | Image | Size | Bytes | Sampled colors |",
            "| --- | --- | --- | --- | --- | --- |"
        ]
        for capture in report.captures {
            let imageName = URL(fileURLWithPath: capture.file).lastPathComponent
            lines.append("| \(capture.title) | \(capture.workspace) | [\(imageName)](\(imageName)) | \(capture.width)x\(capture.height) | \(capture.bytes) | \(capture.sampledColorCount) |")
        }
        lines.append(contentsOf: [
            "",
            "## Boundary",
            "",
            "These PNGs are rendered from the native SwiftUI `DashboardView` through an offscreen `NSHostingView`. They provide screenshot-level native surface evidence without opening the app or requesting Accessibility, AppleScript, screen recording, Chrome/Safari, or external AppKit click automation. They do not claim external pixel-click coverage or human approval."
        ])
        return lines.joined(separator: "\n") + "\n"
    }

    private static func timestampString() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        return formatter.string(from: Date())
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw ContractCheckError(message) }
    }
}
