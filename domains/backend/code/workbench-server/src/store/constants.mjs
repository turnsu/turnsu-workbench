export const DEFAULT_MONGODB_URI = "mongodb://127.0.0.1:27017/?replicaSet=rs0";
export const DEFAULT_PRODUCT_DATABASE = "looloomi_workbench";
export const PRODUCT_REPLICA_SET = "rs0";

export const PRODUCT_COLLECTIONS = Object.freeze({
  users: "product_users",
  workspaces: "product_workspaces",
  memberships: "workspace_memberships",
  sessions: "product_sessions",
  skillAssets: "skill_assets",
  skills: "skills",
  skillDrafts: "skill_drafts",
  skillVersions: "skill_versions",
  skillTestRuns: "skill_test_runs",
  skillTestEvidence: "skill_test_evidence",
  skillValidations: "skill_validations",
  skillExecutionBindings: "skill_execution_bindings",
  templates: "templates",
  workflows: "workflows",
  workflowRevisions: "workflow_revisions",
  loopImports: "loop_imports",
  loopVersions: "loop_versions",
  assetReleases: "workspace_asset_releases",
  assetInstallations: "asset_installations",
  uploads: "upload_sessions",
  objects: "product_objects",
  resources: "workspace_resources",
  connections: "workspace_connections",
  connectionBindings: "workspace_connection_bindings",
  builderProposals: "builder_proposals",
  compileResults: "compile_results",
  executionPlans: "execution_plans",
  runs: "runs",
  runJobs: "run_jobs",
  runLeases: "run_leases",
  runCheckpoints: "run_checkpoints",
  runCommands: "run_commands",
  runNodeAttempts: "run_node_attempts",
  runEvents: "run_events",
  runTerminalTransitions: "run_terminal_transitions",
  runReadModels: "run_read_models",
  reviewDecisions: "review_decisions",
  idempotencyRecords: "idempotency_records",
  auditEvents: "audit_events",
});

export const PRODUCT_INDEX_DEFINITIONS = Object.freeze([
  {
    collection: PRODUCT_COLLECTIONS.users,
    indexes: [{ key: { userId: 1 }, options: { unique: true, name: "userId_1" } }],
  },
  {
    collection: PRODUCT_COLLECTIONS.workspaces,
    indexes: [{ key: { workspaceId: 1 }, options: { unique: true, name: "workspaceId_1" } }],
  },
  {
    collection: PRODUCT_COLLECTIONS.memberships,
    indexes: [
      { key: { workspaceId: 1, userId: 1 }, options: { unique: true, name: "workspaceId_1_userId_1" } },
      { key: { userId: 1, workspaceId: 1 }, options: { name: "userId_1_workspaceId_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.sessions,
    indexes: [
      { key: { sessionId: 1 }, options: { unique: true, name: "sessionId_1" } },
      { key: { tokenHash: 1 }, options: { unique: true, name: "tokenHash_1" } },
      { key: { expiresAt: 1 }, options: { name: "expiresAt_ttl", expireAfterSeconds: 0 } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.skillAssets,
    indexes: [
      { key: { skillId: 1 }, options: { unique: true, name: "skillId_1" } },
      { key: { workspaceId: 1, lifecycle: 1, updatedAt: -1 }, options: { name: "workspaceId_1_lifecycle_1_updatedAt_-1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.skills,
    indexes: [
      {
        key: { skillId: 1, version: 1 },
        options: { unique: true, name: "skillId_1_version_1" },
      },
      { key: { status: 1, category: 1 }, options: { name: "status_1_category_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.skillDrafts,
    indexes: [
      { key: { skillDraftId: 1 }, options: { unique: true, name: "skillDraftId_1" } },
      { key: { workspaceId: 1, skillId: 1, revision: -1 }, options: { name: "workspaceId_1_skillId_1_revision_-1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.skillVersions,
    indexes: [
      { key: { skillVersionId: 1 }, options: { unique: true, name: "skillVersionId_1" } },
      { key: { workspaceId: 1, skillId: 1, version: 1 }, options: { unique: true, name: "workspaceId_1_skillId_1_version_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.skillTestRuns,
    indexes: [
      { key: { testRunId: 1 }, options: { unique: true, name: "testRunId_1" } },
      { key: { workspaceId: 1, skillId: 1, skillDraftId: 1, completedAt: -1 }, options: { name: "workspaceId_1_skillId_1_skillDraftId_1_completedAt_-1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.skillTestEvidence,
    indexes: [
      { key: { testRunId: 1 }, options: { unique: true, name: "testRunId_1" } },
      { key: { workspaceId: 1, skillDraftId: 1, draftRevision: 1, contentHash: 1 }, options: { name: "workspaceId_1_skillDraftId_1_revision_1_contentHash_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.skillValidations,
    indexes: [
      { key: { validationId: 1 }, options: { unique: true, name: "validationId_1" } },
      { key: { workspaceId: 1, skillId: 1, skillDraftId: 1, draftRevision: 1, contentHash: 1, status: 1 }, options: { name: "workspaceId_1_skillId_1_skillDraftId_1_revision_1_contentHash_1_status_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.skillExecutionBindings,
    indexes: [
      { key: { executionBindingId: 1 }, options: { unique: true, name: "executionBindingId_1" } },
      { key: { validationId: 1 }, options: { unique: true, name: "validationId_1" } },
      { key: { workspaceId: 1, skillDraftId: 1, draftRevision: 1, contentHash: 1, packageHash: 1 }, options: { unique: true, name: "workspaceId_1_skillDraftId_1_revision_1_contentHash_1_packageHash_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.templates,
    indexes: [
      {
        key: { templateId: 1, templateVersion: 1 },
        options: { unique: true, name: "templateId_1_templateVersion_1" },
      },
      { key: { category: 1 }, options: { name: "category_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.workflows,
    indexes: [
      {
        key: { workflowId: 1 },
        options: { unique: true, name: "workflowId_1" },
      },
      {
        key: { workspaceId: 1, updatedAt: -1 },
        options: { name: "workspaceId_1_updatedAt_-1" },
      },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.workflowRevisions,
    indexes: [
      {
        key: { revisionId: 1 },
        options: { unique: true, name: "revisionId_1" },
      },
      {
        key: { workflowId: 1, revisionNumber: 1 },
        options: { unique: true, name: "workflowId_1_revisionNumber_1" },
      },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.loopImports,
    indexes: [
      { key: { importId: 1 }, options: { unique: true, name: "importId_1" } },
      { key: { workspaceId: 1, updatedAt: -1 }, options: { name: "workspaceId_1_updatedAt_-1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.loopVersions,
    indexes: [
      { key: { loopVersionId: 1 }, options: { unique: true, name: "loopVersionId_1" } },
      { key: { workspaceId: 1, workflowId: 1, version: 1 }, options: { unique: true, name: "workspaceId_1_workflowId_1_version_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.assetReleases,
    indexes: [
      { key: { releaseId: 1 }, options: { unique: true, name: "releaseId_1" } },
      { key: { sourceWorkspaceId: 1, assetKind: 1, assetId: 1, versionId: 1 }, options: { unique: true, name: "sourceWorkspaceId_1_asset_1_version_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.assetInstallations,
    indexes: [
      { key: { installationId: 1 }, options: { unique: true, name: "installationId_1" } },
      { key: { workspaceId: 1, releaseId: 1 }, options: { unique: true, name: "workspaceId_1_releaseId_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.uploads,
    indexes: [
      { key: { uploadId: 1 }, options: { unique: true, name: "uploadId_1" } },
      { key: { workspaceId: 1, updatedAt: -1 }, options: { name: "workspaceId_1_updatedAt_-1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.objects,
    indexes: [
      { key: { objectId: 1 }, options: { unique: true, name: "objectId_1" } },
      { key: { workspaceId: 1, contentHash: 1 }, options: { unique: true, name: "workspaceId_1_contentHash_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.resources,
    indexes: [
      { key: { resourceId: 1 }, options: { unique: true, name: "resourceId_1" } },
      { key: { workspaceId: 1, updatedAt: -1 }, options: { name: "workspaceId_1_updatedAt_1" } },
      { key: { workspaceId: 1, contentHash: 1 }, options: { name: "workspaceId_1_contentHash_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.connections,
    indexes: [
      { key: { connectionId: 1 }, options: { unique: true, name: "connectionId_1" } },
      { key: { workspaceId: 1, label: 1 }, options: { unique: true, name: "workspaceId_1_label_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.connectionBindings,
    indexes: [
      {
        key: { workspaceId: 1, targetKind: 1, targetId: 1, requirementId: 1 },
        options: { unique: true, name: "workspaceId_1_target_1_requirementId_1" },
      },
      { key: { workspaceId: 1, connectionId: 1 }, options: { name: "workspaceId_1_connectionId_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.builderProposals,
    indexes: [
      { key: { proposalId: 1 }, options: { unique: true, name: "proposalId_1" } },
      { key: { workspaceId: 1, workflowId: 1, createdAt: -1 }, options: { name: "workspaceId_1_workflowId_1_createdAt_-1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.compileResults,
    indexes: [
      {
        key: { workflowRevisionId: 1, compiledAt: -1 },
        options: { name: "workflowRevisionId_1_compiledAt_-1" },
      },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.executionPlans,
    indexes: [
      { key: { planId: 1 }, options: { unique: true, name: "planId_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.runs,
    indexes: [
      { key: { runId: 1 }, options: { unique: true, name: "runId_1" } },
      {
        key: { workflowId: 1, updatedAt: -1 },
        options: { name: "workflowId_1_updatedAt_-1" },
      },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.runJobs,
    indexes: [
      { key: { runJobId: 1 }, options: { unique: true, name: "runJobId_1" } },
      { key: { runId: 1 }, options: { unique: true, name: "runId_1" } },
      { key: { status: 1, queuedAt: 1 }, options: { name: "status_1_queuedAt_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.runLeases,
    indexes: [{ key: { runId: 1 }, options: { unique: true, name: "runId_1" } }],
  },
  {
    collection: PRODUCT_COLLECTIONS.runCheckpoints,
    indexes: [
      { key: { checkpointId: 1 }, options: { unique: true, name: "checkpointId_1" } },
      { key: { runId: 1, sequence: 1 }, options: { unique: true, name: "runId_1_sequence_1" } },
      { key: { runId: 1, attemptId: 1, sequence: 1 }, options: { unique: true, name: "runId_1_attemptId_1_sequence_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.runCommands,
    indexes: [
      { key: { runCommandId: 1 }, options: { unique: true, name: "runCommandId_1" } },
      { key: { runId: 1, requestedAt: 1 }, options: { name: "runId_1_requestedAt_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.runNodeAttempts,
    indexes: [
      {
        key: { runId: 1, nodeId: 1, attempt: 1 },
        options: { unique: true, name: "runId_1_nodeId_1_attempt_1" },
      },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.runEvents,
    indexes: [
      {
        key: { runId: 1, sequence: 1 },
        options: { unique: true, name: "runId_1_sequence_1" },
      },
      { key: { eventId: 1 }, options: { unique: true, name: "eventId_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.runTerminalTransitions,
    indexes: [
      { key: { terminalTransitionId: 1 }, options: { unique: true, name: "terminalTransitionId_1" } },
      { key: { runId: 1 }, options: { unique: true, name: "runId_1" } },
      { key: { logicalEventId: 1 }, options: { unique: true, name: "logicalEventId_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.reviewDecisions,
    indexes: [
      {
        key: { decisionId: 1 },
        options: { unique: true, name: "decisionId_1" },
      },
      {
        key: { runId: 1, decidedAt: 1 },
        options: { name: "runId_1_decidedAt_1" },
      },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.runReadModels,
    indexes: [
      { key: { runId: 1 }, options: { unique: true, name: "runId_1" } },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.idempotencyRecords,
    indexes: [
      {
        key: { scope: 1, key: 1 },
        options: { unique: true, name: "scope_1_key_1" },
      },
    ],
  },
  {
    collection: PRODUCT_COLLECTIONS.auditEvents,
    indexes: [
      { key: { occurredAt: -1 }, options: { name: "occurredAt_-1" } },
    ],
  },
]);

export const PRODUCT_TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
});
