import { readFile } from "node:fs/promises";

const baselineUrl = new URL("./001_pg_baseline.sql", import.meta.url);
const g3aSemanticAdaptersUrl = new URL("./002_g3a_semantic_adapters.sql", import.meta.url);
const g3bWorkflowRunPersistenceUrl = new URL("./003_g3b_workflow_run_persistence.sql", import.meta.url);
const g4AuthIdentityUrl = new URL("./004_g4_auth_identity.sql", import.meta.url);
const g4ArtifactMetadataUrl = new URL("./005_g4_artifact_metadata.sql", import.meta.url);
const g4WorkerTranscriptsUrl = new URL("./006_g4_worker_transcripts.sql", import.meta.url);
const g4SystemCatalogUrl = new URL("./007_g4_system_catalog.sql", import.meta.url);
const g4ConnectionWritesUrl = new URL("./008_g4_connection_writes.sql", import.meta.url);
const g4PersonalScopeActivationUrl = new URL("./009_g4_personal_scope_activation.sql", import.meta.url);
const g4WorkspaceInvitationIdentityUrl = new URL("./010_g4_workspace_invitation_identity.sql", import.meta.url);
const g5WorkItemPromotionUrl = new URL("./011_g5_work_item_promotion.sql", import.meta.url);
const g5WorkItemContinuationUrl = new URL("./012_g5_work_item_continuation.sql", import.meta.url);
const g5WorkItemThreadCommentsUrl = new URL("./013_g5_work_item_thread_comments.sql", import.meta.url);
const g5WorkItemDecisionRecordsUrl = new URL("./014_g5_work_item_decision_records.sql", import.meta.url);
const g3bNonExecutionNodeAttemptsUrl = new URL("./015_g3b_non_execution_node_attempts.sql", import.meta.url);
const g3bTerminalJobOwnershipUrl = new URL("./016_g3b_terminal_job_ownership.sql", import.meta.url);
const g3bRecoveredExecutionUnknownUrl = new URL("./017_g3b_recovered_execution_unknown.sql", import.meta.url);
const g3bReviewApprovalOutputUrl = new URL("./018_g3b_review_approval_output.sql", import.meta.url);
const g5AutomationPrincipalIdempotencyUrl = new URL("./019_g5_automation_principal_idempotency.sql", import.meta.url);
const g6ScopePolicyAutomationLifecycleUrl = new URL("./020_g6_scope_policy_automation_lifecycle.sql", import.meta.url);
const g3bReviewInboxProjectionUrl = new URL("./021_g3b_review_inbox_projection.sql", import.meta.url);
const g3bReviewRejectionCommandUrl = new URL("./022_g3b_review_rejection_command.sql", import.meta.url);
const g3bWorkflowRunCancellationCommandUrl = new URL("./023_g3b_workflow_run_cancellation_command.sql", import.meta.url);
const g1SessionDecisionCommandsUrl = new URL("./024_g1_session_decision_commands.sql", import.meta.url);
const g1NativeClientAuthUrl = new URL("./025_g1_native_client_auth.sql", import.meta.url);
const g2ProjectTeamWorkUrl = new URL("./026_g2_project_team_work.sql", import.meta.url);
const g2TeamWorkAgentEntryUrl = new URL("./027_g2_team_work_agent_entry.sql", import.meta.url);
const g2WorkItemContinuationAgentEntryUrl = new URL("./028_g2_work_item_continuation_agent_entry.sql", import.meta.url);
const g3DeviceControlPlaneUrl = new URL("./029_g3_device_control_plane.sql", import.meta.url);
const g3DeviceExecutionLeasesUrl = new URL("./030_g3_device_execution_leases.sql", import.meta.url);
const g1KernelSessionEventProjectionUrl = new URL("./031_g1_kernel_session_event_projection.sql", import.meta.url);
const g1AgentToolApprovalResumeUrl = new URL("./032_g1_agent_tool_approval_resume.sql", import.meta.url);

const modelConfigurationCommandUrl = new URL("./033_model_configuration_command.sql", import.meta.url);
const privateAttachmentObjectsUrl = new URL("./034_private_attachment_objects.sql", import.meta.url);
const memberModelConfigurationUrl = new URL("./035_member_model_configuration.sql", import.meta.url);

export const POSTGRES_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: "001_pg_baseline",
    description: "Create the PostgreSQL Product Store schema ledger.",
    loadSql: () => readFile(baselineUrl, "utf8"),
  }),
  Object.freeze({
    version: "002_g3a_semantic_adapters",
    description: "Add product idempotency receipts for semantic adapters.",
    loadSql: () => readFile(g3aSemanticAdaptersUrl, "utf8"),
  }),
  Object.freeze({
    version: "003_g3b_workflow_run_persistence",
    description: "Add targeted B3 Workflow Run worker claims for semantic persistence.",
    loadSql: () => readFile(g3bWorkflowRunPersistenceUrl, "utf8"),
  }),
  Object.freeze({
    version: "004_g4_auth_identity",
    description: "Add PostgreSQL auth idempotency receipts for public account mutations.",
    loadSql: () => readFile(g4AuthIdentityUrl, "utf8"),
  }),
  Object.freeze({
    version: "005_g4_artifact_metadata",
    description: "Add PostgreSQL Artifact metadata lifecycle authority.",
    loadSql: () => readFile(g4ArtifactMetadataUrl, "utf8"),
  }),
  Object.freeze({
    version: "006_g4_worker_transcripts",
    description: "Add PostgreSQL Worker transcript lifecycle and safe audit authority.",
    loadSql: () => readFile(g4WorkerTranscriptsUrl, "utf8"),
  }),
  Object.freeze({
    version: "007_g4_system_catalog",
    description: "Make the global system catalog an explicit cross-workspace installation source.",
    loadSql: () => readFile(g4SystemCatalogUrl, "utf8"),
  }),
  Object.freeze({
    version: "008_g4_connection_writes",
    description: "Align the immutable PostgreSQL Connection revision guard with the public label update contract.",
    loadSql: () => readFile(g4ConnectionWritesUrl, "utf8"),
  }),
  Object.freeze({
    version: "009_g4_personal_scope_activation",
    description: "Create one self-owned personal authority scope for every activated workspace member.",
    loadSql: () => readFile(g4PersonalScopeActivationUrl, "utf8"),
  }),
  Object.freeze({
    version: "010_g4_workspace_invitation_identity",
    description: "Add durable invitations, OAuth identity binding, and SMTP outbox authority.",
    loadSql: () => readFile(g4WorkspaceInvitationIdentityUrl, "utf8"),
  }),
  Object.freeze({
    version: "011_g5_work_item_promotion",
    description: "Add atomic private-task Work Item promotion, safe Handoff Capsules, and revocable sharing.",
    loadSql: () => readFile(g5WorkItemPromotionUrl, "utf8"),
  }),
  Object.freeze({
    version: "012_g5_work_item_continuation",
    description: "Add personal Work Item continuations derived only from shared Handoff context.",
    loadSql: () => readFile(g5WorkItemContinuationUrl, "utf8"),
  }),
  Object.freeze({
    version: "013_g5_work_item_thread_comments",
    description: "Add governed, product-safe Work Item thread comments with Product Command lineage.",
    loadSql: () => readFile(g5WorkItemThreadCommentsUrl, "utf8"),
  }),
  Object.freeze({
    version: "014_g5_work_item_decision_records",
    description: "Add accountable-owner Work Item decisions with immutable Work Thread records.",
    loadSql: () => readFile(g5WorkItemDecisionRecordsUrl, "utf8"),
  }),
  Object.freeze({
    version: "015_g3b_non_execution_node_attempts",
    description: "Allow pure Workflow Input and Output attempts without synthetic Execution authority.",
    loadSql: () => readFile(g3bNonExecutionNodeAttemptsUrl, "utf8"),
  }),
  Object.freeze({
    version: "016_g3b_terminal_job_ownership",
    description: "Release active Workflow Run Job ownership after every terminal event.",
    loadSql: () => readFile(g3bTerminalJobOwnershipUrl, "utf8"),
  }),
  Object.freeze({
    version: "017_g3b_recovered_execution_unknown",
    description: "Fence recovered Workflow Run executions without replaying an unknown Invocation.",
    loadSql: () => readFile(g3bRecoveredExecutionUnknownUrl, "utf8"),
  }),
  Object.freeze({
    version: "018_g3b_review_approval_output",
    description: "Persist approved ReviewGate output in the review aggregate transaction.",
    loadSql: () => readFile(g3bReviewApprovalOutputUrl, "utf8"),
  }),
  Object.freeze({
    version: "019_g5_automation_principal_idempotency",
    description: "Partition Product idempotency by canonical user or non-user workspace principals.",
    loadSql: () => readFile(g5AutomationPrincipalIdempotencyUrl, "utf8"),
  }),
  Object.freeze({
    version: "020_g6_scope_policy_automation_lifecycle",
    description: "Add explicit Scope Policy activation and Automation lifecycle command authority.",
    loadSql: () => readFile(g6ScopePolicyAutomationLifecycleUrl, "utf8"),
  }),
  Object.freeze({
    version: "021_g3b_review_inbox_projection",
    description: "Project pending Workflow Run reviews into the recipient-authorized Inbox.",
    loadSql: () => readFile(g3bReviewInboxProjectionUrl, "utf8"),
  }),
  Object.freeze({
    version: "022_g3b_review_rejection_command",
    description: "Reject a pending Workflow Run review through the canonical cancellation command.",
    loadSql: () => readFile(g3bReviewRejectionCommandUrl, "utf8"),
  }),
  Object.freeze({
    version: "023_g3b_workflow_run_cancellation_command",
    description: "Accept explicit Workflow Run cancellation commands through the PostgreSQL event ledger.",
    loadSql: () => readFile(g3bWorkflowRunCancellationCommandUrl, "utf8"),
  }),
  Object.freeze({
    version: "024_g1_session_decision_commands",
    description: "Bind Agent Handoff and Module proposal decisions to explicit PostgreSQL Product Commands.",
    loadSql: () => readFile(g1SessionDecisionCommandsUrl, "utf8"),
  }),
  Object.freeze({
    version: "025_g1_native_client_auth",
    description: "Add PKCE-bound native client sessions with rotating refresh credentials.",
    loadSql: () => readFile(g1NativeClientAuthUrl, "utf8"),
  }),
  Object.freeze({
    version: "026_g2_project_team_work",
    description: "Add Project-backed Team Work, scoped membership, and auditable direct Work Item lifecycle commands.",
    loadSql: () => readFile(g2ProjectTeamWorkUrl, "utf8"),
  }),
  Object.freeze({
    version: "027_g2_team_work_agent_entry",
    description: "Accept a new Team Work Item, personal continuation, and first Agent Turn atomically.",
    loadSql: () => readFile(g2TeamWorkAgentEntryUrl, "utf8"),
  }),
  Object.freeze({
    version: "028_g2_work_item_continuation_agent_entry",
    description: "Accept a Work Item continuation branch and first Agent Turn atomically.",
    loadSql: () => readFile(g2WorkItemContinuationAgentEntryUrl, "utf8"),
  }),
  Object.freeze({
    version: "029_g3_device_control_plane",
    description: "Add PKCE-bound native Device registration, heartbeat readiness, and revocation authority.",
    loadSql: () => readFile(g3DeviceControlPlaneUrl, "utf8"),
  }),
  Object.freeze({
    version: "030_g3_device_execution_leases",
    description: "Bind Desktop dispatch and result intake to durable Device execution leases and fences.",
    loadSql: () => readFile(g3DeviceExecutionLeasesUrl, "utf8"),
  }),
  Object.freeze({
    version: "031_g1_kernel_session_event_projection",
    description: "Project Product-authorized Worker Kernel events into the existing Agent Session ledger.",
    loadSql: () => readFile(g1KernelSessionEventProjectionUrl, "utf8"),
  }),
  Object.freeze({
    version: "032_g1_agent_tool_approval_resume",
    description: "Persist Product-owned Agent Tool approvals and command-driven resumptive Agent Turns.",
    loadSql: () => readFile(g1AgentToolApprovalResumeUrl, "utf8"),
  }),
  Object.freeze({
    version: "033_model_configuration_command",
    description: "Configure personal models through explicit Product authority and atomic Secret Bindings.",
    loadSql: () => readFile(modelConfigurationCommandUrl, "utf8"),
  }),
  Object.freeze({
    version: "034_private_attachment_objects",
    description: "Allow personal uploads of equal content to retain independent storage lifetimes.",
    loadSql: () => readFile(privateAttachmentObjectsUrl, "utf8"),
  }),
  Object.freeze({
    version: "035_member_model_configuration",
    description: "Provision a member's private model through explicit administrator authority.",
    loadSql: () => readFile(memberModelConfigurationUrl, "utf8"),
  }),
  Object.freeze({
    version: "036_work_item_workflow_runs",
    description: "Bind declared shared Loop results to a Work Item and its existing Run authority.",
    loadSql: () => readFile(new URL("./036_work_item_workflow_runs.sql", import.meta.url), "utf8"),
  }),
  Object.freeze({
    version: "037_skill_next_version_draft",
    description: "Allow a new private draft while preserving the existing published Skill version.",
    loadSql: () => readFile(new URL("./037_skill_next_version_draft.sql", import.meta.url), "utf8"),
  }),
  Object.freeze({
    version: "038_project_file_revisions",
    description: "Preserve project file revisions and concurrent conflicts behind Product membership and commands.",
    loadSql: () => readFile(new URL("./038_project_file_revisions.sql", import.meta.url), "utf8"),
  }),
  Object.freeze({
    version: "039_workflow_cancellation_transition",
    description: "Allow Broker cancellation transitions only after a governed Workflow Run cancellation command.",
    loadSql: () => readFile(new URL("./039_workflow_cancellation_transition.sql", import.meta.url), "utf8"),
  }),
  Object.freeze({
    version: "040_local_loop_trial_receipts",
    description: "Record private human-reviewed local Loop trial evidence without granting cloud execution readiness.",
    loadSql: () => readFile(new URL("./040_local_loop_trial_receipts.sql", import.meta.url), "utf8"),
  }),
  Object.freeze({
    version: "041_native_loop_releases",
    description: "Publish immutable native Agent recipes and exact Skill pins through the existing workspace library without managed execution readiness.",
    loadSql: () => readFile(new URL("./041_native_loop_releases.sql", import.meta.url), "utf8"),
  }),
  Object.freeze({version:"042_member_agent_requests",description:"Bind explicit member Agent consent to existing Product commands and execution authority.",loadSql:()=>readFile(new URL("./042_member_agent_requests.sql",import.meta.url),"utf8")}),
  Object.freeze({version:"043_member_agent_request_lists",description:"Index actor-scoped member request discovery without a second inbox store.",loadSql:()=>readFile(new URL("./043_member_agent_request_lists.sql",import.meta.url),"utf8")}),
  Object.freeze({version:"044_work_item_result_reviews",description:"Bind immutable team result review events to exact shared entries.",loadSql:()=>readFile(new URL("./044_work_item_result_reviews.sql",import.meta.url),"utf8")}),
  Object.freeze({version:"045_project_file_tombstones",description:"Preserve recoverable file deletions as versioned tombstones in the existing project revision chain.",loadSql:()=>readFile(new URL("./045_project_file_tombstones.sql",import.meta.url),"utf8")}),
]);
