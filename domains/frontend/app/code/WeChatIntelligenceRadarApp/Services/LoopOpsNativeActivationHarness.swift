import Foundation

struct LoopOpsNativeActivationTarget: Hashable {
    var interactionID: String
    var actionEvidence: String
    var surface: String
    var activatedInProcess: Bool
    var stateBacked: Bool
    var noSystemPermission: Bool
}

struct LoopOpsNativeActivationReport: Hashable {
    var targetCount: Int
    var activatedCount: Int
    var stateBackedCount: Int
    var noSystemPermissionCount: Int
    var nativeAppKitClickVerifiedCount: Int
    var targets: [LoopOpsNativeActivationTarget]
    var summaryLines: [String]
}

enum LoopOpsNativeActivationHarness {
    @MainActor
    static func run() throws -> LoopOpsNativeActivationReport {
        let uiReport = try LoopOpsAcceptanceHarness.runUIActionChecks()
        let replayReport = try LoopOpsAcceptanceHarness.runInteractionReplayCheck()
        let knownRequiredIDs = Set(LoopOpsInteractionID.requiredUISmokeIDs)

        let requiredEvidence = [
            "library_batch_run=true",
            "library_row_run=true",
            "library_unready_loop_setup=true",
            "active_queue_selection_changes_result=true",
            "workbench_review_guide_paths=true",
            "workbench_review_guide_checklist=true",
            "workbench_evidence_map_sources=4",
            "workbench_review_decision_board=true",
            "workbench_traceability_modules=8",
            "workbench_review_record_handoff=true",
            "workbench_review_record_preview=true",
            "workbench_review_state_persistence=true",
            "create_tool_starting_point=true",
            "create_tool_import_starting_point=true",
            "create_tool_form_fields=true",
            "new_tool=true",
            "tool_log_review_chat=true",
            "builder_packet_apply=true",
            "builder_packet_reject=true",
            "builder_packet_save=true",
            "global_chat_send=true",
            "run_chat_send=true",
            "run_chat_locked_scope=true",
            "run_lifecycle_actions=true",
            "run_lifecycle_updates_run_chat=true",
            "run_lifecycle_updates_share_safe_log=true"
        ]

        let replayByEvidence = Dictionary(uniqueKeysWithValues: replayReport.steps.map { ($0.actionEvidenceKey, $0) })
        let targets = try requiredEvidence.map { evidence in
            guard let step = replayByEvidence[evidence] else {
                throw ContractCheckError("native activation missing replay step for \(evidence)")
            }
            let requiredAnchor = knownRequiredIDs.contains(step.interactionID)
                || step.interactionID.hasPrefix(LoopOpsInteractionID.loopLibraryRunPrefix)
                || step.interactionID.hasPrefix(LoopOpsInteractionID.workbenchActiveQueueRowPrefix)
                || step.interactionID.hasPrefix(LoopOpsInteractionID.loopLibraryLedgerPrefix)
                || step.interactionID.hasPrefix(LoopOpsInteractionID.skillOSPackagePrefix)
                || step.interactionID.contains(".row.")
            try require(requiredAnchor, "native activation target should be anchored: \(step.interactionID)")
            return LoopOpsNativeActivationTarget(
                interactionID: step.interactionID,
                actionEvidence: evidence,
                surface: step.surface,
                activatedInProcess: step.replayVerified,
                stateBacked: step.stateMutationVerified,
                noSystemPermission: step.noSystemPermission
            )
        }

        try require(uiReport.summaryLines.contains("no_system_permissions=true"), "native activation should inherit no-permission UI action contract")
        try require(replayReport.nativeAppKitClickVerifiedCount == 0, "native activation should not claim external AppKit/XCUITest clicks")
        try require(targets.allSatisfy(\.activatedInProcess), "native activation should verify every target in process")
        try require(targets.allSatisfy(\.stateBacked), "native activation should have state-backed evidence")
        try require(targets.allSatisfy(\.noSystemPermission), "native activation should avoid permission-gated automation")

        let activatedCount = targets.filter(\.activatedInProcess).count
        let stateBackedCount = targets.filter(\.stateBacked).count
        let noPermissionCount = targets.filter(\.noSystemPermission).count
        return LoopOpsNativeActivationReport(
            targetCount: targets.count,
            activatedCount: activatedCount,
            stateBackedCount: stateBackedCount,
            noSystemPermissionCount: noPermissionCount,
            nativeAppKitClickVerifiedCount: replayReport.nativeAppKitClickVerifiedCount,
            targets: targets,
            summaryLines: [
                "in_process_activation=true",
                "swiftui_action_wiring_verified=true",
                "external_ui_automation=false",
                "no_system_permissions=true",
                "native_appkit_clicks_verified=false",
                "activation_targets=\(targets.count)",
                "activation_state_backed=\(stateBackedCount)"
            ]
        )
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw ContractCheckError(message) }
    }
}

private extension LoopOpsInteractionReplayStep {
    var actionEvidenceKey: String {
        switch action {
        case "Batch run selected loops":
            return "library_batch_run=true"
        case "Run loop from row":
            return "library_row_run=true"
        case "Route unready loop to Builder setup":
            return "library_unready_loop_setup=true"
        case "Select active queue row and keep run chat scoped":
            return "active_queue_selection_changes_result=true"
        case "Open Review Guide paths":
            return "workbench_review_guide_paths=true"
        case "Mark Review Guide checklist":
            return "workbench_review_guide_checklist=true"
        case "Review source evidence map":
            return "workbench_evidence_map_sources=4"
        case "Review agent-team traceability":
            return "workbench_traceability_modules=8"
        case "Set manual review decision":
            return "workbench_review_decision_board=true"
        case "Prepare manual review record handoff":
            return "workbench_review_record_handoff=true"
        case "Review manual record command preview":
            return "workbench_review_record_preview=true"
        case "Persist manual Review Guide state":
            return "workbench_review_state_persistence=true"
        case "Choose blank tool starting point":
            return "create_tool_starting_point=true"
        case "Choose Import tool starting point":
            return "create_tool_import_starting_point=true"
        case "Edit tool name, task description, and input scope":
            return "create_tool_form_fields=true"
        case "Create a new local tool draft":
            return "new_tool=true"
        case "Open Tool Log Review Chat":
            return "tool_log_review_chat=true"
        case "Apply Builder Packet":
            return "builder_packet_apply=true"
        case "Reject Builder Packet":
            return "builder_packet_reject=true"
        case "Save Builder Packet":
            return "builder_packet_save=true"
        case "Send workspace-scoped chat":
            return "global_chat_send=true"
        case "Send run-scoped chat":
            return "run_chat_send=true"
        case "Keep Run Result chat locked to run scope":
            return "run_chat_locked_scope=true"
        case "Apply run lifecycle actions":
            return "run_lifecycle_actions=true"
        case "Write run lifecycle event to Run Chat":
            return "run_lifecycle_updates_run_chat=true"
        case "Keep share-safe log after lifecycle action":
            return "run_lifecycle_updates_share_safe_log=true"
        default:
            return action
        }
    }
}
