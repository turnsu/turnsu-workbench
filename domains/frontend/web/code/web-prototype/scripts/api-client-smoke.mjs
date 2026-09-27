import assert from "node:assert/strict";

import {
  encodeBytesBase64,
  formatSkillPackageBytes,
  isTerminalRunStatus,
  RUN_EVENT_TYPES,
  RUN_TERMINAL_STATUSES,
  WorkbenchApiError,
  createWorkbenchApiClient,
} from "../src/api/client.js";
import {
  importSkillRepositoryPackage,
  inspectResumableSkillPackage,
  runRefetchInterval,
  workflowRunsRefetchInterval,
} from "../src/api/queries.js";

const requests = [];
const response = (data, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get(name) { return headers[name.toLowerCase()] ?? null; } },
  async json() { return data; },
});
const workspaceResponse = (data) => response(data, {
  headers: { "cache-control": "no-store" },
});
const workspaceEnvelope = ({ csrfToken, userId, workspaceId }) => ({
  schemaVersion: "workbench-api-v1",
  data: {
    workspace: {
      workspaceId,
      name: "Test workspace",
      capabilities: {
        builderProposal: false,
        resources: false,
        maxParallelism: 1,
      },
      createdAt: "2026-07-10T09:00:00.000Z",
      updatedAt: "2026-07-10T09:00:00.000Z",
    },
    session: {
      csrfToken,
      expiresAt: "2026-07-10T10:00:00.000Z",
      userId,
      workspaceId,
    },
  },
  requestId: `request-${workspaceId}`,
});
const authUser = {
  userId: "user-1",
  username: "owner.local",
  role: "admin",
  disabled: false,
  createdAt: "2026-07-10T09:00:00.000Z",
  updatedAt: "2026-07-10T09:00:00.000Z",
};
const authResultEnvelope = ({ user = authUser, workspaceId = "workspace-1" } = {}) => ({
  schemaVersion: "workbench-api-v1",
  data: { user, workspaceId },
  requestId: `request-auth-${workspaceId}`,
});
const authStatusEnvelope = ({ authenticated = true } = {}) => ({
  schemaVersion: "workbench-api-v1",
  data: {
    registrationOpen: false,
    bootstrapRequired: false,
    bootstrapAvailable: false,
    authenticated,
    ...(authenticated ? { user: authUser, workspaceId: "workspace-1" } : {}),
  },
  requestId: "request-auth-status",
});
const workspaceFeatureReadinessEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: {
    schemaVersion: "workbench-v1",
    workspaceId: "workspace-1",
    workspaceRole: "admin",
    evaluatedAt: "2026-07-10T09:00:00.000Z",
    actions: {
      promptSkill: {},
      scriptSkill: {},
      registeredToolSkill: {},
      skillDirectoryImport: {},
      skillZipImport: {},
      publicGithubSkillImport: {},
      serverSkillImport: {},
      blankLoop: {},
      stagedLoopProposal: {},
      connectionSetup: {},
      workspaceResource: {},
    },
    support: {
      readyRuntimeIds: [],
      registeredToolPackageCount: 0,
      selectableBuilderModelCount: 0,
      readyAttachmentMediaTypes: [],
      unavailableAttachmentMediaTypes: [],
    },
  },
  requestId: "request-readiness-1",
};
const inboxEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: {
    items: [{
      schemaVersion: "workbench-v1",
      itemId: "inbox-review-1",
      workspaceId: "workspace-1",
      objectKind: "review",
      objectId: "run-review-1",
      reason: "review_required",
      severity: "warning",
      title: "A run needs review",
      actionRoute: "/loops/workflow-1/runs/run-review-1",
      createdAt: "2026-07-10T09:00:00.000Z",
    }],
    count: 1,
    page: { nextCursor: null, hasMore: false },
  },
  requestId: "request-inbox-1",
};
const automationCandidateEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: [{
    loopVersionId: "loop-daily-v1",
    workflowId: "workflow-daily",
    scopeId: "scope-personal",
    name: "Daily brief",
    description: "Creates the daily brief.",
    version: "1.0.0",
    inputBindings: [{
      bindingId: "resource-brief-1.0.0",
      inputKey: "resource-brief",
      label: "Daily brief source",
      source: {
        kind: "resource",
        resourceId: "resource-brief",
        version: "1.0.0",
        contentHash: `sha256:${"a".repeat(64)}`,
      },
    }],
    connectionRequirements: [{
      requirementId: "calendar-read",
      capabilityKey: "calendar.read",
      description: "Read calendar events.",
      requiredEffects: ["calendar.read"],
      eligibleConnectionIds: ["connection-1"],
    }],
  }],
  page: { nextCursor: null, hasMore: false },
  requestId: "request-automation-candidates",
};
const automationEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: {
    schemaVersion: "workbench-v1",
    variant: "daily_cron_v1",
    automationId: "automation-daily",
    workspaceId: "workspace-1",
    scopeId: "scope-personal",
    ownerId: "user-1",
    displayName: "Daily brief",
    loopVersionId: "loop-daily-v1",
    loopContentHash: `sha256:${"b".repeat(64)}`,
    triggerRevision: 1,
    trigger: { kind: "daily_cron", expression: "0 9 * * *", timezone: "Asia/Hong_Kong" },
    inputBindings: [{
      bindingId: "resource-brief-1.0.0",
      inputKey: "resource-brief",
      source: {
        kind: "resource",
        resourceId: "resource-brief",
        version: "1.0.0",
        contentHash: `sha256:${"a".repeat(64)}`,
      },
    }],
    connectionBindings: [{
      requirementId: "calendar-read",
      connectionId: "connection-1",
      revision: 1,
      secretBindingId: "secret-calendar",
      storeBindingRevision: 1,
    }],
    executionLocationPolicy: "cloud",
    modelPolicy: { policyRevisionId: "model-policy-1", modelProfileRevisionIds: ["model-revision-1"] },
    budgetPolicy: { maxCostUsdMicros: 1_000_000, maxRuntimeSeconds: 600 },
    approvalPolicy: {
      policyRevisionId: "scope-policy-1",
      permissionMode: { mode: "auto", autoApprovedEffectClasses: ["execute"] },
    },
    misfirePolicy: { kind: "run_once", maxLatenessSeconds: 300 },
    dedupePolicy: { kind: "scheduled_occurrence" },
    grantId: "automation-grant-1",
    grantRevision: 1,
    grantExpiresAt: "2026-08-30T09:00:00.000Z",
    grantReviewAt: "2026-08-20T09:00:00.000Z",
    status: "active",
    blockedReasonCode: null,
    nextRunAt: "2026-08-14T01:00:00.000Z",
    lastRunAt: null,
    lastOutcome: null,
    failureStreak: 0,
    revision: 1,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  },
  requestId: "request-automation-daily",
};
const automationOccurrencesEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: [{
    occurrenceId: "automation-occurrence-1",
    automationId: "automation-daily",
    workflowId: "workflow-daily",
    triggerRevision: 1,
    scheduledFor: "2026-08-14T01:00:00.000Z",
    localScheduleDate: "2026-08-14",
    dedupeKey: "automation-daily:1:2026-08-14",
    status: "accepted",
    commandId: "product-command-automation-1",
    runId: "run-automation-1",
    runStatus: "waiting_review",
    reasonCode: null,
    createdAt: "2026-08-14T01:00:00.000Z",
    updatedAt: "2026-08-14T01:00:00.000Z",
  }],
  page: { nextCursor: null, hasMore: false },
  requestId: "request-automation-occurrences",
};
const deviceEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: {
    schemaVersion: "workbench-v1",
    deviceId: "device-owner-mac",
    workspaceId: "workspace-1",
    ownerUserId: "user-1",
    displayName: "Owner Mac",
    platform: "macos",
    architecture: "arm64",
    appVersion: "0.3.0",
    workerProtocolVersion: "workbench-device-worker-v1",
    publicIdentity: `sha256:${"e".repeat(64)}`,
    capabilityInventory: ["file_read", "notification"],
    registrationStatus: "active",
    health: "ready",
    lastSeenAt: "2026-08-13T00:00:00.000Z",
    updateRequired: false,
    revision: 1,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    revokedAt: null,
  },
  requestId: "request-device-owner-mac",
};
const scopeEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: {
    schemaVersion: "workbench-v1",
    scopeId: "scope-personal",
    workspaceId: "workspace-1",
    kind: "personal",
    ownerUserId: "user-1",
    policy: {
      policyRevisionId: "scope-policy-1",
      observationTier: "private",
      defaultPermission: { mode: "auto", autoApprovedEffectClasses: ["execute"] },
    },
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  },
  requestId: "request-scope-policy",
};
const projectEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: {
    schemaVersion: "workbench-v1",
    projectId: "project-launch",
    workspaceId: "workspace-1",
    scopeId: "scope-project-launch",
    title: "Launch readiness",
    objective: "Prepare the release with an accountable team.",
    status: "active",
    accountableOwnerUserId: "user-1",
    members: [
      { userId: "user-1", role: "owner" },
      { userId: "user-teammate", role: "member" },
    ],
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    archivedAt: null,
  },
  requestId: "request-project-launch",
};
const teamWorkItemEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: {
    schemaVersion: "workbench-v1",
    workItemId: "work-item-launch",
    workspaceId: "workspace-1",
    projectId: "project-launch",
    title: "Validate release readiness",
    objective: "Validate the release path and record the decision.",
    status: "ready",
    priority: "high",
    accountableOwnerUserId: "user-1",
    requestorUserId: "user-1",
    members: [
      {
        userId: "user-1",
        roles: ["accountable_owner", "requestor"],
        accessGrant: { grantId: "grant-owner", workItemId: "work-item-launch", userId: "user-1", access: "owner", status: "active", createdAt: "2026-08-13T00:00:00.000Z", revokedAt: null },
      },
      {
        userId: "user-teammate",
        roles: ["participant"],
        accessGrant: { grantId: "grant-teammate", workItemId: "work-item-launch", userId: "user-teammate", access: "contribute", status: "active", createdAt: "2026-08-13T00:00:00.000Z", revokedAt: null },
      },
    ],
    source: { kind: "team_work_item" },
    dueAt: null,
    workThreadId: "work-thread-launch",
    authorizedBranchRefs: [],
    linkedLoopRef: null,
    runRefs: [],
    artifactRefs: [],
    decisionRefs: [],
    proposalRefs: [],
    blockedReason: null,
    nextAction: "Start validation.",
    createdByUserId: "user-1",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    completedAt: null,
  },
  requestId: "request-team-work-item",
};
const fetchImpl = async (url, options = {}) => {
  requests.push({ url, options });
  if (url.endsWith("/devices/device-owner-mac/revoke") && options.method === "POST") {
    return response({
      ...deviceEnvelope,
      data: {
        ...deviceEnvelope.data,
        registrationStatus: "revoked",
        health: "revoked",
        revision: 2,
        revokedAt: "2026-08-13T00:01:00.000Z",
        updatedAt: "2026-08-13T00:01:00.000Z",
      },
    }, { headers: { "cache-control": "private, no-store" } });
  }
  if (url.endsWith("/devices")) {
    return response({
      ...deviceEnvelope,
      data: [deviceEnvelope.data],
      page: { nextCursor: null, hasMore: false },
    }, { headers: { "cache-control": "private, no-store" } });
  }
  if (/\/automations\/automation-daily\/occurrences(?:\?|$)/.test(url)) {
    return response(automationOccurrencesEnvelope, {
      headers: { "cache-control": "private, no-store" },
    });
  }
  if (url.endsWith("/automations/automation-daily") && options.method === "PATCH") {
    return response({
      ...automationEnvelope,
      data: {
        ...automationEnvelope.data,
        displayName: "Daily brief, revised",
        revision: 2,
        triggerRevision: 2,
        grantRevision: 2,
      },
    }, { headers: { "cache-control": "private, no-store", etag: '"automationv1:automation-daily:2"' } });
  }
  if (url.endsWith("/automations/automation-daily")) {
    return response(automationEnvelope, {
      headers: { "cache-control": "private, no-store", etag: '"automationv1:automation-daily:1"' },
    });
  }
  if (url.endsWith("/automations") && options.method === "POST") {
    return response(automationEnvelope, {
      status: 201,
      headers: { "cache-control": "private, no-store", etag: '"automationv1:automation-daily:1"' },
    });
  }
  if (url.includes("/automations?") && !url.includes("/automations/candidates")) {
    return response({
      ...automationEnvelope,
      data: [automationEnvelope.data],
      page: { nextCursor: null, hasMore: false },
    }, { headers: { "cache-control": "private, no-store" } });
  }
  if (url.endsWith("/projects") && options.method === "POST") {
    return response(projectEnvelope, { status: 201, headers: { "cache-control": "no-store", etag: '"projectv1:project-launch:1"' } });
  }
  if (url.endsWith("/projects/project-launch/members") && options.method === "PUT") {
    return response(projectEnvelope, { headers: { "cache-control": "no-store", etag: '"projectv1:project-launch:2"' } });
  }
  if (url.endsWith("/projects/project-launch")) {
    return response(projectEnvelope, { headers: { "cache-control": "no-store", etag: '"projectv1:project-launch:1"' } });
  }
  if (url.includes("/projects?")) {
    return response({ ...projectEnvelope, data: [projectEnvelope.data], page: { nextCursor: null, hasMore: false } }, { headers: { "cache-control": "no-store" } });
  }
  if (url.endsWith("/work-items/agent-entry") && options.method === "POST") {
    return response({
      schemaVersion: "workbench-api-v1",
      data: {
        workItem: teamWorkItemEnvelope.data,
        continuation: {
          continuationId: "work-item-continuation-owner",
          workItemId: "work-item-launch",
          agentSessionId: "agent-session-owner-work-entry",
          handoffId: "handoff-launch",
          createdAt: "2026-08-13T00:00:00.000Z",
        },
        turn: {
          schemaVersion: "workbench-v1",
          turnId: "agent-turn-work-entry",
          sessionId: "agent-session-owner-work-entry",
          productCommandId: "product-command-work-entry",
          sequence: 1,
          kind: "agent_message",
          status: "queued",
          modelRoutingState: "pinned",
          requestedModelRevisionId: "model-revision-chat-1",
          actualModelRevisionId: null,
          sessionEpoch: 1,
          turnFence: 1,
          input: { message: "Create the first launch checklist." },
          result: null,
          artifactRefs: [],
          queuedAt: "2026-08-13T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
      },
      requestId: "request-team-work-agent-entry",
    }, { status: 202, headers: { "cache-control": "no-store", etag: '"workv1:work-item-launch:1"' } });
  }
  if (url.endsWith("/work-items") && options.method === "POST") {
    return response(teamWorkItemEnvelope, { status: 201, headers: { "cache-control": "no-store", etag: '"workv1:work-item-launch:1"' } });
  }
  if (url.endsWith("/work-items/work-item-launch") && options.method === "PATCH") {
    return response({ ...teamWorkItemEnvelope, data: { ...teamWorkItemEnvelope.data, status: "active" } }, { headers: { "cache-control": "no-store", etag: '"workv1:work-item-launch:2"' } });
  }
  if (url.includes("/work-items?") && !url.includes("promotion-participants")) {
    return response({ ...teamWorkItemEnvelope, data: [teamWorkItemEnvelope.data], page: { nextCursor: null, hasMore: false } }, { headers: { "cache-control": "no-store" } });
  }
  if (url.includes("/automations/candidates")) {
    return response(automationCandidateEnvelope, {
      headers: { "cache-control": "private, no-store" },
    });
  }
  if (url.endsWith("/scopes/scope-personal") && options.method === "GET") {
    return response(scopeEnvelope, {
      headers: { "cache-control": "private, no-store", etag: '"scopev1:scope-personal:1:scope-policy-1"' },
    });
  }
  if (url.endsWith("/scopes/scope-personal/policy") && options.method === "PATCH") {
    return response(scopeEnvelope, {
      headers: { "cache-control": "private, no-store", etag: '"scopev1:scope-personal:2:scope-policy-2"' },
    });
  }
  if (url.endsWith("/auth/status")) {
    return response(authStatusEnvelope(), { headers: { "cache-control": "no-store" } });
  }
  if (url.endsWith("/workspace/feature-readiness")) {
    return response(workspaceFeatureReadinessEnvelope, {
      headers: { "cache-control": "private, no-store" },
    });
  }
  if (url.includes("/inbox")) {
    return response(inboxEnvelope, {
      headers: { "cache-control": "private, no-store" },
    });
  }
  if (url.endsWith("/workspace")) {
    return workspaceResponse(workspaceEnvelope({
      csrfToken: "c".repeat(32),
      userId: "user-1",
      workspaceId: "workspace-1",
    }));
  }
  if (url.endsWith("/agent-sessions/session-1/proposals/agent-proposal-1/apply")) {
    return response({ data: {
      proposalId: "agent-proposal-1",
      sessionId: "session-1",
      branchId: "branch-1",
      objectKind: "skill_draft",
      objectId: "skill-1",
      baseVersionId: "draft-1:1",
      summary: "Update the description.",
      operations: [{ op: "replace", path: "/description", value: "Updated." }],
      status: "accepted",
      createdAt: "2026-07-29T00:00:00.000Z",
      decidedAt: "2026-07-29T00:01:00.000Z",
    } });
  }
  if (url.endsWith("/agent-sessions/session-1/proposals/agent-proposal-1/reject")) {
    return response({ data: {
      proposalId: "agent-proposal-1",
      sessionId: "session-1",
      branchId: "branch-1",
      objectKind: "skill_draft",
      objectId: "skill-1",
      baseVersionId: "draft-1:1",
      summary: "Update the description.",
      operations: [{ op: "replace", path: "/description", value: "Updated." }],
      status: "rejected",
      createdAt: "2026-07-29T00:00:00.000Z",
      decidedAt: "2026-07-29T00:01:00.000Z",
    } });
  }
  if (url.endsWith("/agent-sessions/session-1/proposals/agent-proposal-1")) {
    return response({ data: {
      proposalId: "agent-proposal-1",
      sessionId: "session-1",
      branchId: "branch-1",
      objectKind: "skill_draft",
      objectId: "skill-1",
      baseVersionId: "draft-1:1",
      summary: "Update the description.",
      operations: [{ op: "replace", path: "/description", value: "Updated." }],
      status: "proposed",
      createdAt: "2026-07-29T00:00:00.000Z",
    } });
  }
  if (url.endsWith("/attachments/attachment-1/retry")) {
    return response({ data: { attachment: {
      attachmentId: "attachment-1",
      filename: "notes.md",
      mediaType: "text/markdown",
      sizeBytes: 5,
      status: "ready",
      ref: { attachmentId: "attachment-1", version: 1, contentHash: "sha256:attachment" },
    } } });
  }
  if (url.endsWith("/attachments/attachment-1") && options.method === "DELETE") {
    return response({ data: { attachmentId: "attachment-1", status: "deleted" } });
  }
  if (url.endsWith("/attachments/attachment-1")) {
    return response({ data: { attachment: {
      attachmentId: "attachment-1",
      filename: "notes.md",
      mediaType: "text/markdown",
      sizeBytes: 5,
      status: "ready",
      ref: { attachmentId: "attachment-1", version: 1, contentHash: "sha256:attachment" },
    } } });
  }
  if (url.endsWith("/attachments") && options.method === "POST") {
    return response({ data: { attachment: {
      attachmentId: "attachment-1",
      filename: "notes.md",
      mediaType: "text/markdown",
      sizeBytes: 5,
      status: "ready",
      ref: { attachmentId: "attachment-1", version: 1, contentHash: "sha256:attachment" },
    } } }, { status: 201 });
  }
  if (url.endsWith("/attachments")) {
    return response({ data: { items: [], page: { hasMore: false } } });
  }
  if (url.endsWith("/session")) {
    return response({
      data: {
        session: { userId: "user-1", activeWorkspaceId: "workspace-1" },
        membership: { userId: "user-1", workspaceId: "workspace-1", role: "viewer" },
      },
    });
  }
  if (url.endsWith("/skill-assets")) {
    return response({ data: [{ skill: { skillId: "skill-1" }, draft: null, latestVersion: null }] });
  }
  if (url.endsWith("/uploads")) {
    return response({ data: { uploadId: "upload-1", state: "selecting" } }, { status: 201 });
  }
  if (url.endsWith("/uploads/repository")) {
    return response({ data: { uploadId: "upload-repository-1", state: "ready_draft", ingestMethod: "repository" } }, { status: 201 });
  }
  if (url.endsWith("/uploads/upload-1/chunks/1")) {
    return response({ data: {
      uploadId: "upload-1",
      state: "selecting",
      ingestMethod: "resumable",
      transfer: { chunkSizeBytes: 524288, totalChunks: 2, receivedChunks: [0, 1], receivedBytes: 700000, complete: true },
    } });
  }
  if (url.endsWith("/uploads/upload-1/complete")) {
    return response({ data: { uploadId: "upload-1", state: "ready_draft", ingestMethod: "resumable" } });
  }
  if (url.endsWith("/uploads/upload-1") && (!options.method || options.method === "GET")) {
    return response({ data: {
      uploadId: "upload-1",
      state: "selecting",
      ingestMethod: "resumable",
      transfer: { chunkSizeBytes: 524288, totalChunks: 2, receivedChunks: [0], receivedBytes: 524288, complete: false },
    } });
  }
  if (url.endsWith("/uploads/upload-1/package")) {
    return response({ data: { uploadId: "upload-1", state: "ready_draft" } });
  }
  if (url.endsWith("/uploads/upload-1/promote")) {
    return response({ data: { uploadId: "upload-1", state: "promoted" } });
  }
  if (url.endsWith("/resources") && options.method === "POST") {
    return response({ data: { resourceId: "resource-1", version: "1.0.0", label: "Meeting notes" } }, { status: 201 });
  }
  if (url.endsWith("/resources")) {
    return response({ data: [{ resourceId: "resource-1", version: "1.0.0", label: "Meeting notes" }] });
  }
  if (url.endsWith("/resources/resource-1")) {
    return response({ data: { resourceId: "resource-1", version: "1.0.0", label: "Meeting notes" } });
  }
  if (url.endsWith("/connections/connection-1/validate")) {
    return response({ data: {
      connectionId: "connection-1",
      capabilityKey: "calendar.read",
      label: "Team calendar",
      configuration: { permissionSummary: "Read shared event details." },
      status: "connected",
      validation: { status: "valid" },
      revision: 3,
    } }, { headers: { etag: '"cnv1:connection-1:3"' } });
  }
  if (url.endsWith("/connections/connection-1") && options.method === "PATCH") {
    return response({ data: {
      connectionId: "connection-1",
      capabilityKey: "calendar.read",
      label: "Team calendar",
      configuration: { permissionSummary: "Read shared event details." },
      status: "needs_setup",
      validation: { status: "never_checked" },
      revision: 2,
    } }, { headers: { etag: '"cnv1:connection-1:2"' } });
  }
  if (url.endsWith("/connections/connection-1")) {
    return response({ data: {
      connectionId: "connection-1",
      capabilityKey: "calendar.read",
      label: "Team calendar",
      configuration: { permissionSummary: "Read event titles." },
      status: "needs_setup",
      validation: { status: "never_checked" },
      revision: 1,
    } }, { headers: { etag: '"cnv1:connection-1:1"' } });
  }
  if (url.endsWith("/connections") && options.method === "POST") {
    return response({ data: {
      connectionId: "connection-1",
      capabilityKey: "calendar.read",
      label: "Team calendar",
      configuration: { permissionSummary: "Read event titles." },
      status: "needs_setup",
      validation: { status: "never_checked" },
      revision: 1,
    } }, { status: 201, headers: { etag: '"cnv1:connection-1:1"' } });
  }
  if (url.endsWith("/connections")) {
    return response({ data: [{
      connectionId: "connection-1",
      capabilityKey: "calendar.read",
      label: "Team calendar",
      configuration: { permissionSummary: "Read event titles." },
      status: "needs_setup",
      validation: { status: "never_checked" },
      revision: 1,
    }] });
  }
  if (url.endsWith("/skills/skill-1/drafts/draft-1")) {
    return response({ data: { skillDraftId: "draft-1" } }, { headers: { etag: '"skill-draft-1:1"' } });
  }
  if (url.endsWith("/skills/skill-1/drafts/draft-1/package") && options.method === "PUT") {
    return response({ data: { skillDraftId: "draft-1", revision: 2 } }, { headers: { etag: '"skill-draft-1:2"' } });
  }
  if (url.endsWith("/skills/skill-1/drafts/draft-1/package")) {
    return response({ data: { skillId: "skill-1", skillDraftId: "draft-1", revision: 1, files: [
      { path: "SKILL.md", kind: "instructions", sizeBytes: 12, content: "# Sample" },
      { path: "scripts/main.py", kind: "script", sizeBytes: 12, content: 'print("ok")' },
    ] } });
  }
  if (url.endsWith("/skills/skill-1/drafts/draft-1/tests") && options.method === "POST") {
    return response({ data: { testRunId: "skill-test-run-1", status: "passed" } }, { status: 202 });
  }
  if (url.endsWith("/skills/skill-1/tests/skill-test-run-1")) {
    return response({ data: { testRunId: "skill-test-run-1", status: "passed" } });
  }
  if (url.endsWith("/skills/skill-1/drafts/draft-1/validations") && options.method === "POST") {
    return response({ data: { validationId: "skill-validation-1", status: "passed" } }, { status: 202 });
  }
  if (url.endsWith("/skills/skill-1/validations/skill-validation-1")) {
    return response({ data: { validationId: "skill-validation-1", status: "passed" } });
  }
  if (url.endsWith("/skills/skill-1/drafts") && options.method === "POST") {
    return response({ data: { skillDraftId: "draft-2" } }, { status: 201, headers: { etag: '"skill-draft-2:1"' } });
  }
  if (url.endsWith("/skills/skill-1/drafts/draft-2") && options.method === "PATCH") {
    return response({ data: { skillDraftId: "draft-2" } }, { headers: { etag: '"skill-draft-2:2"' } });
  }
  if (url.endsWith("/skills/skill-1/versions")) {
    return response({ data: [
      { skillVersionId: "skill-version-2", skillId: "skill-1", version: "2.0.0", name: "Meeting actions", description: "Finds clear follow-up actions.", category: "Meetings", validation: { status: "passed", testedAt: "2026-07-13T02:00:00.000Z" }, publishedBy: "user-1", publishedAt: "2026-07-13T02:00:00.000Z" },
      { skillVersionId: "skill-version-1", skillId: "skill-1", version: "1.0.0", name: "Meeting actions", description: "Finds follow-up actions.", category: "Meetings", validation: { status: "passed", testedAt: "2026-07-12T02:00:00.000Z" }, publishedBy: "user-1", publishedAt: "2026-07-12T02:00:00.000Z" },
    ] });
  }
  if (url.endsWith("/skills/skill-1/usage")) {
    return response({ data: { skillId: "skill-1", latestVersionId: "skill-version-2", latestVersion: "2.0.0", affectedWorkflows: [] } });
  }
  if (url.endsWith("/skills/skill-1/versions/skill-version-1/diff/skill-version-2")) {
    return response({ data: { skillId: "skill-1", fromVersionId: "skill-version-1", fromVersion: "1.0.0", toVersionId: "skill-version-2", toVersion: "2.0.0", entries: [{ field: "purpose", changed: true, summary: "The Skill description changed.", severity: "info" }] } });
  }
  if (url.endsWith("/skills/skill-1/deprecate")) {
    return response({ data: { skillId: "skill-1", lifecycle: "deprecated" } });
  }
  if (url.endsWith("/skills/skill-1/publish")) {
    return response({ data: { skill: { skillId: "skill-1" }, version: { skillVersionId: "skill-version-1" }, release: { releaseId: "release-skill-1" } } });
  }
  if (url.endsWith("/skills") && options.method === "POST") {
    return response({ data: { skill: { skillId: "skill-1" }, draft: { skillDraftId: "draft-1" } } }, { status: 201 });
  }
  if (url.endsWith("/loops")) {
    return response({ data: { workflow: { workflowId: "workflow-new" }, revision: { revisionId: "revision-new" } } }, { status: 201 });
  }
  if (url.endsWith("/team-library")) {
    return response({ data: [{ releaseId: "release-1", assetKind: "loop" }] });
  }
  if (url.endsWith("/installations")) {
    return response({ data: [{ installationId: "installation-1", pinnedVersionId: "skill-version-1" }] });
  }
  if (url.endsWith("/installations/installation-1")) {
    return response({ data: { installationId: "installation-1", pinnedVersionId: "skill-version-1" } });
  }
  if (url.endsWith("/install")) {
    return response({ data: { installationId: "installation-1" } }, { status: 201 });
  }
  if (url.includes("/revisions/")) {
    return response({ data: { revisionId: "revision-1" } }, { headers: { etag: '"workflow-1:1"' } });
  }
  if (url.endsWith("/compile")) {
    return response({ data: { status: "ready" } });
  }
  if (url.endsWith("/publish")) {
    return response({ data: { loopVersion: { loopVersionId: "loop-version-1" }, release: { releaseId: "release-published" } } }, { status: 201 });
  }
  if (url.endsWith("/cancel")) {
    return response({
      schemaVersion: "workbench-api-v1",
      data: { runId: "run-1" },
      requestId: "request-run-cancel",
    }, { status: 202 });
  }
  if (url.endsWith("/retry")) {
    return response({
      schemaVersion: "workbench-api-v1",
      data: { runId: "run-2" },
      requestId: "request-run-retry",
    }, { status: 202 });
  }
  if (url.endsWith("/work-items/promotion-participants")) {
    return response({
      schemaVersion: "workbench-api-v1",
      data: [{
        userId: "user-teammate",
        displayName: "Teammate",
        username: "teammate",
        role: "member",
      }],
      page: { nextCursor: null, hasMore: false },
      requestId: "request-work-item-participants",
    }, { headers: { "cache-control": "no-store" } });
  }
  if (url.endsWith("/work-items/work-item-launch/continuations")) {
    return response({
      schemaVersion: "workbench-api-v1",
      data: {
        continuationId: "work-item-continuation-teammate",
        workItemId: "work-item-launch",
        agentSessionId: "agent-session-teammate",
        handoffId: "handoff-launch",
        createdAt: "2026-08-11T00:00:00.000Z",
      },
      requestId: "request-work-item-continuation",
    }, { status: 201, headers: { "cache-control": "no-store" } });
  }
  if (url.endsWith("/work-items/work-item-launch/agent-entry") && options.method === "POST") {
    return response({
      schemaVersion: "workbench-api-v1",
      data: {
        continuation: {
          continuationId: "work-item-continuation-teammate",
          workItemId: "work-item-launch",
          agentSessionId: "agent-session-teammate",
          handoffId: "handoff-launch",
          createdAt: "2026-08-11T00:00:00.000Z",
        },
        turn: {
          schemaVersion: "workbench-v1",
          turnId: "agent-turn-continuation-entry",
          sessionId: "agent-session-teammate",
          productCommandId: "product-command-continuation-entry",
          sequence: 1,
          kind: "agent_message",
          status: "queued",
          modelRoutingState: "pinned",
          requestedModelRevisionId: "model-revision-chat-1",
          actualModelRevisionId: null,
          sessionEpoch: 1,
          turnFence: 1,
          input: { message: "Continue the release readiness work from the shared handoff." },
          result: null,
          artifactRefs: [],
          queuedAt: "2026-08-13T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
      },
      requestId: "request-work-item-continuation-agent-entry",
    }, { status: 202, headers: { "cache-control": "no-store" } });
  }
  if (url.endsWith("/work-items/work-item-launch/thread-entries") && options.method === "POST") {
    return response({
      schemaVersion: "workbench-api-v1",
      data: {
        entryId: "work-thread-entry-comment",
        workItemId: "work-item-launch",
        workThreadId: "work-thread-launch",
        sequence: 2,
        kind: "comment",
        summary: "I will validate provider readiness for the team.",
        handoffId: null,
        decisionId: null,
        artifactId: null,
        contentHash: `sha256:${"d".repeat(64)}`,
        createdByUserId: "user-1",
        occurredAt: "2026-08-11T00:00:00.000Z",
      },
      requestId: "request-work-item-comment",
    }, { status: 201, headers: { "cache-control": "no-store" } });
  }
  if (url.endsWith("/work-items/work-item-launch/decisions") && options.method === "POST") {
    return response({
      schemaVersion: "workbench-api-v1",
      data: {
        decisionId: "work-item-decision-provider-readiness",
        workItemId: "work-item-launch",
        question: "Which readiness action should the team take?",
        options: ["Proceed", "Validate first"],
        chosenOutcome: "Validate first",
        rationale: "The accountable owner accepts the validation time.",
        evidenceRefs: ["evidence-provider-readiness"],
        affectedObjects: [{ kind: "workflow", id: "workflow-launch" }],
        authorUserId: "user-1",
        approverUserId: "user-1",
        supersedesDecisionId: null,
        createdAt: "2026-08-12T00:00:00.000Z",
      },
      requestId: "request-work-item-decision",
    }, { status: 201, headers: { "cache-control": "no-store" } });
  }
  if (url.endsWith("/runs")) {
    return response({
      code: "workflow_execution_not_ready",
      message: "Compile this workflow first.",
      details: { workflowId: "workflow-1" },
      retryable: false,
      requestId: "request-1",
    }, { status: 409 });
  }
  throw new Error(`unexpected_url:${url}`);
};

const eventSources = [];
class FakeEventSource {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.listeners = new Map();
    eventSources.push(this);
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
}

const api = createWorkbenchApiClient({
  fetchImpl,
  eventSourceFactory: (url, options) => new FakeEventSource(url, options),
  idFactory: () => "idem-fixed",
});

for (const retiredMethod of [
  "duplicateLoop",
  "createLoopImport",
  "getLoopImport",
  "commitLoopImport",
  "exportLoop",
  "getRunComparison",
  "createLoopDraftFromRun",
  "createLoopSkillUpdate",
  "getLoopSkillUpdatePreview",
  "generateLoopProposal",
  "getLoopProposal",
  "applyLoopProposal",
  "dismissLoopProposal",
  "adoptInstallationRelease",
  "useTeamReleaseAsStartingPoint",
  "forkTeamLoopRelease",
]) {
  assert.equal(api[retiredMethod], undefined, `${retiredMethod} must not remain on the public ProductClient`);
}

await api.bootstrap();
assert.equal((await api.authStatus()).data.workspaceId, "workspace-1");
const devices = await api.listDevices();
assert.equal(devices.data[0].deviceId, "device-owner-mac");
assert.equal(devices.data[0].publicIdentity, `sha256:${"e".repeat(64)}`);
assert.match(requests.at(-1).url, /\/devices$/);
assert.equal(requests.at(-1).options.credentials, "same-origin");
const revokedDevice = await api.revokeDevice("device-owner-mac", {
  reason: "Lost device",
}, { idempotencyKey: "device-revoke" });
assert.equal(revokedDevice.data.registrationStatus, "revoked");
assert.equal(requests.at(-1).options.method, "POST");
assert.equal(requests.at(-1).options.headers.get("X-Workbench-CSRF"), "c".repeat(32));
assert.equal(requests.at(-1).options.headers.get("Idempotency-Key"), "device-revoke");
assert.deepEqual(JSON.parse(requests.at(-1).options.body).data, { reason: "Lost device" });
const automations = await api.listAutomations({ status: "active", limit: 10 });
assert.equal(automations.data[0].automationId, "automation-daily");
assert.equal(automations.data[0].grantExpiresAt, "2026-08-30T09:00:00.000Z");
assert.match(requests.at(-1).url, /\/automations\?status=active&limit=10$/);
const automation = await api.getAutomation("automation-daily");
assert.equal(automation.etag, '"automationv1:automation-daily:1"');
assert.equal(automation.data.grantReviewAt, "2026-08-20T09:00:00.000Z");
const revisedAutomation = await api.reviseAutomation("automation-daily", {
  displayName: "Daily brief, revised",
  loopVersionId: "loop-daily-v1",
  trigger: { kind: "daily_cron", expression: "0 10 * * *", timezone: "Asia/Hong_Kong" },
  inputBindings: automation.data.inputBindings,
  connectionBindings: [{ requirementId: "calendar-read", connectionId: "connection-1" }],
  budgetPolicy: { maxCostUsdMicros: 2_000_000, maxRuntimeSeconds: 900 },
  misfirePolicy: { kind: "run_once", maxLatenessSeconds: 600 },
  grantExpiresAt: "2026-08-30T09:00:00.000Z",
  grantReviewAt: "2026-08-20T09:00:00.000Z",
}, { ifMatch: automation.etag, idempotencyKey: "automation-revise" });
assert.equal(revisedAutomation.etag, '"automationv1:automation-daily:2"');
assert.equal(revisedAutomation.data.displayName, "Daily brief, revised");
assert.equal(requests.at(-1).options.headers.get("If-Match"), automation.etag);
assert.equal(requests.at(-1).options.headers.get("Idempotency-Key"), "automation-revise");
assert.equal(JSON.parse(requests.at(-1).options.body).data.grantReviewAt, "2026-08-20T09:00:00.000Z");
const automationOccurrences = await api.listAutomationOccurrences("automation-daily", { limit: 10 });
assert.equal(automationOccurrences.data[0].workflowId, "workflow-daily");
assert.equal(automationOccurrences.data[0].runStatus, "waiting_review");
assert.match(requests.at(-1).url, /\/automations\/automation-daily\/occurrences\?limit=10$/);
const automationCandidates = await api.listAutomationCandidates({ scopeId: "scope-personal", limit: 10 });
assert.equal(automationCandidates.data[0].connectionRequirements[0].eligibleConnectionIds[0], "connection-1");
assert.match(requests.at(-1).url, /\/automations\/candidates\?scopeId=scope-personal&limit=10$/);
const scope = await api.getScope("scope-personal");
assert.equal(scope.etag, '"scopev1:scope-personal:1:scope-policy-1"');
const revisedScope = await api.reviseScopePolicy("scope-personal", {
  observationTier: "private",
  defaultPermission: { mode: "auto", autoApprovedEffectClasses: ["execute"] },
}, { ifMatch: scope.etag, idempotencyKey: "scope-policy-update" });
assert.equal(revisedScope.etag, '"scopev1:scope-personal:2:scope-policy-2"');
assert.equal(requests.at(-1).options.headers.get("If-Match"), scope.etag);
const projects = await api.listProjects({ status: "active", limit: 10 });
assert.equal(projects.data[0].projectId, "project-launch");
assert.match(requests.at(-1).url, /\/projects\?status=active&limit=10$/);
const project = await api.getProject("project-launch");
assert.equal(project.etag, '"projectv1:project-launch:1"');
const createdProject = await api.createProject({
  title: "Launch readiness",
  objective: "Prepare the release with an accountable team.",
  members: [{ userId: "user-teammate" }],
}, { idempotencyKey: "project-create" });
assert.equal(createdProject.data.projectId, "project-launch");
assert.equal(createdProject.etag, '"projectv1:project-launch:1"');
assert.equal(requests.at(-1).options.headers.get("Idempotency-Key"), "project-create");
const revisedProject = await api.reviseProjectMembers("project-launch", {
  members: [{ userId: "user-teammate" }],
}, { ifMatch: project.etag, idempotencyKey: "project-members" });
assert.equal(revisedProject.etag, '"projectv1:project-launch:2"');
assert.equal(requests.at(-1).options.headers.get("If-Match"), project.etag);
const workItems = await api.listWorkItems({ projectId: "project-launch", limit: 10 });
assert.equal(workItems.data[0].workItemId, "work-item-launch");
assert.match(requests.at(-1).url, /\/work-items\?projectId=project-launch&limit=10$/);
const createdWorkItem = await api.createTeamWorkItem({
  projectId: "project-launch",
  title: "Validate release readiness",
  objective: "Validate the release path and record the decision.",
  summary: "A safe release handoff.",
  priority: "high",
  dueAt: null,
  members: [{ userId: "user-teammate", access: "contribute", roles: ["participant"] }],
}, { idempotencyKey: "team-work-create" });
assert.equal(createdWorkItem.etag, '"workv1:work-item-launch:1"');
assert.equal(requests.at(-1).options.headers.get("Idempotency-Key"), "team-work-create");
const teamWorkAgentEntry = await api.createTeamWorkItemAgentEntry({
  projectId: "project-launch",
  title: "Agent-led launch checklist",
  objective: "Produce the first accountable launch checklist.",
  summary: "Only this safe handoff is shared with the team.",
  modelProfileId: "model-profile-chat-1",
  initialTask: { message: "Create the first launch checklist." },
}, { idempotencyKey: "team-work-agent-entry" });
assert.equal(teamWorkAgentEntry.data.continuation.agentSessionId, "agent-session-owner-work-entry");
assert.equal(teamWorkAgentEntry.data.turn.productCommandId, "product-command-work-entry");
assert.equal(teamWorkAgentEntry.etag, '"workv1:work-item-launch:1"');
assert.match(requests.at(-1).url, /\/work-items\/agent-entry$/);
assert.equal(requests.at(-1).options.method, "POST");
assert.equal(requests.at(-1).options.headers.get("Idempotency-Key"), "team-work-agent-entry");
assert.deepEqual(JSON.parse(requests.at(-1).options.body).data.initialTask, {
  message: "Create the first launch checklist.",
});
const updatedWorkItem = await api.updateTeamWorkItem("work-item-launch", {
  status: "active",
}, { ifMatch: createdWorkItem.etag, idempotencyKey: "team-work-update" });
assert.equal(updatedWorkItem.data.status, "active");
assert.equal(updatedWorkItem.etag, '"workv1:work-item-launch:2"');
assert.equal(requests.at(-1).options.headers.get("If-Match"), createdWorkItem.etag);
const promotionParticipants = await api.listWorkItemPromotionParticipants();
assert.deepEqual(promotionParticipants.data, [{
  userId: "user-teammate",
  displayName: "Teammate",
  username: "teammate",
  role: "member",
}]);
assert.match(requests.at(-1).url, /\/work-items\/promotion-participants$/);
const continuation = await api.createWorkItemContinuation("work-item-launch", {
  idempotencyKey: "continue-work-item-launch",
});
assert.equal(continuation.data.agentSessionId, "agent-session-teammate");
assert.match(requests.at(-1).url, /\/work-items\/work-item-launch\/continuations$/);
assert.equal(requests.at(-1).options.method, "POST");
assert.equal(requests.at(-1).options.headers.get("Idempotency-Key"), "continue-work-item-launch");
assert.deepEqual(JSON.parse(requests.at(-1).options.body).data, {});
const continuationAgentEntry = await api.createWorkItemContinuationAgentEntry("work-item-launch", {
  modelProfileId: "model-profile-chat-1",
  initialTask: { message: "Continue the release readiness work from the shared handoff." },
}, { idempotencyKey: "continue-work-item-agent-entry" });
assert.equal(continuationAgentEntry.data.continuation.agentSessionId, "agent-session-teammate");
assert.equal(continuationAgentEntry.data.turn.productCommandId, "product-command-continuation-entry");
assert.match(requests.at(-1).url, /\/work-items\/work-item-launch\/agent-entry$/);
assert.equal(requests.at(-1).options.method, "POST");
assert.equal(requests.at(-1).options.headers.get("Idempotency-Key"), "continue-work-item-agent-entry");
assert.deepEqual(JSON.parse(requests.at(-1).options.body).data, {
  modelProfileId: "model-profile-chat-1",
  initialTask: { message: "Continue the release readiness work from the shared handoff." },
});
const workItemComment = await api.createWorkItemThreadComment("work-item-launch", {
  content: "I will validate provider readiness for the team.",
}, { idempotencyKey: "comment-work-item-launch" });
assert.equal(workItemComment.data.kind, "comment");
assert.match(requests.at(-1).url, /\/work-items\/work-item-launch\/thread-entries$/);
assert.equal(requests.at(-1).options.method, "POST");
assert.equal(requests.at(-1).options.headers.get("Idempotency-Key"), "comment-work-item-launch");
assert.deepEqual(JSON.parse(requests.at(-1).options.body).data, {
  content: "I will validate provider readiness for the team.",
});
const workItemDecision = await api.recordWorkItemDecision("work-item-launch", {
  question: "Which readiness action should the team take?",
  options: ["Proceed", "Validate first"],
  chosenOutcome: "Validate first",
  rationale: "The accountable owner accepts the validation time.",
  evidenceRefs: ["evidence-provider-readiness"],
  affectedObjects: [{ kind: "workflow", id: "workflow-launch" }],
}, { idempotencyKey: "decision-work-item-launch" });
assert.equal(workItemDecision.data.approverUserId, "user-1");
assert.match(requests.at(-1).url, /\/work-items\/work-item-launch\/decisions$/);
assert.equal(requests.at(-1).options.method, "POST");
assert.equal(requests.at(-1).options.headers.get("Idempotency-Key"), "decision-work-item-launch");
assert.equal(JSON.parse(requests.at(-1).options.body).data.chosenOutcome, "Validate first");
const readinessController = new AbortController();
assert.equal(
  (await api.getWorkspaceFeatureReadiness({ signal: readinessController.signal })).data.workspaceId,
  "workspace-1",
);
assert.equal(
  requests.find(({ url }) => url.endsWith("/workspace/feature-readiness")).options.signal,
  readinessController.signal,
);
const inboxController = new AbortController();
const inbox = await api.getInbox({ cursor: "cursor:2", limit: 25 }, {
  signal: inboxController.signal,
});
assert.equal(inbox.data.count, 1);
const inboxRequest = requests.find(({ url }) => url.includes("/inbox"));
assert.match(inboxRequest.url, /cursor=cursor%3A2&limit=25$/);
assert.equal(inboxRequest.options.signal, inboxController.signal);
const agentProposal = await api.getAgentProposal("session-1", "agent-proposal-1");
assert.equal(agentProposal.data.status, "proposed");
assert.match(requests.at(-1).url, /\/agent-sessions\/session-1\/proposals\/agent-proposal-1$/);
const acceptedAgentProposal = await api.applyAgentProposal(
  "session-1",
  "agent-proposal-1",
  { idempotencyKey: "agent-proposal-apply-1" },
);
assert.equal(acceptedAgentProposal.data.status, "accepted");
assert.equal(requests.at(-1).options.method, "POST");
assert.equal(requests.at(-1).options.headers["Idempotency-Key"], "agent-proposal-apply-1");
assert.deepEqual(JSON.parse(requests.at(-1).options.body).data, {});
const rejectedAgentProposal = await api.rejectAgentProposal(
  "session-1",
  "agent-proposal-1",
  { idempotencyKey: "agent-proposal-reject-1" },
);
assert.equal(rejectedAgentProposal.data.status, "rejected");
assert.equal(requests.at(-1).options.headers["Idempotency-Key"], "agent-proposal-reject-1");
const attachment = await api.createAttachment({
  filename: "notes.md",
  mediaType: "text/markdown",
  sizeBytes: 5,
  contentBase64: "bm90ZXM=",
}, { idempotencyKey: "attachment-upload-1" });
assert.equal(attachment.data.attachment.ref.attachmentId, "attachment-1");
assert.equal(requests.at(-1).options.headers["Idempotency-Key"], "attachment-upload-1");
assert.equal(JSON.parse(requests.at(-1).options.body).data.filename, "notes.md");
await api.retryAttachment("attachment-1", { idempotencyKey: "attachment-retry-1" });
assert.match(requests.at(-1).url, /\/attachments\/attachment-1\/retry$/);
await api.deleteAttachment("attachment-1", { idempotencyKey: "attachment-delete-1" });
assert.equal(requests.at(-1).options.method, "DELETE");
const activeSession = await api.getActiveSession();
assert.equal(activeSession.data.membership.role, "viewer");
assert.match(requests.at(-1).url, /\/session$/);
const skillAssets = await api.listSkillAssets();
assert.equal(skillAssets.data[0].skill.skillId, "skill-1");
assert.match(requests.at(-1).url, /\/skill-assets$/);
const resources = await api.listResources();
assert.equal(resources.data[0].resourceId, "resource-1");
await api.createResource({ label: "Meeting notes", mediaType: "text/markdown", contentBase64: "Tm90ZXM=" });
assert.match(requests.at(-1).url, /\/resources$/);
assert.equal(JSON.parse(requests.at(-1).options.body).data.label, "Meeting notes");
const connections = await api.listConnections();
assert.equal(connections.data[0].capabilityKey, "calendar.read");
const createdConnection = await api.createConnection({
  capabilityKey: "calendar.read",
  label: "Team calendar",
  configuration: { accountLabel: "Team calendar", permissionSummary: "Read event titles." },
});
assert.equal(createdConnection.etag, '"cnv1:connection-1:1"');
const connectionCreateRequest = requests.at(-1);
assert.equal(connectionCreateRequest.options.method, "POST");
assert.equal(JSON.parse(connectionCreateRequest.options.body).data.capabilityKey, "calendar.read");
const updatedConnection = await api.updateConnection(
  "connection-1",
  { label: "Team calendar", configuration: { accountLabel: "Team calendar", permissionSummary: "Read shared event details." }, enabled: true },
  { ifMatch: createdConnection.etag },
);
assert.equal(updatedConnection.etag, '"cnv1:connection-1:2"');
assert.equal(requests.at(-1).options.method, "PATCH");
assert.equal(requests.at(-1).options.headers["If-Match"], '"cnv1:connection-1:1"');
const validatedConnection = await api.validateConnection(
  "connection-1",
  { ifMatch: updatedConnection.etag },
);
assert.equal(validatedConnection.data.validation.status, "valid");
assert.match(requests.at(-1).url, /\/connections\/connection-1\/validate$/);
assert.deepEqual(JSON.parse(requests.at(-1).options.body).data, {});
assert.equal(requests.at(-1).options.headers["If-Match"], '"cnv1:connection-1:2"');
const revision = await api.getWorkflowRevision("workflow-1", "revision-1");
assert.equal(revision.etag, '"workflow-1:1"');
await api.compileWorkflow("workflow-1", "revision-1");
const compileRequest = requests.at(-1);
assert.equal(compileRequest.options.credentials, "same-origin");
assert.equal(compileRequest.options.headers["Idempotency-Key"], "idem-fixed");
assert.equal(compileRequest.options.headers["X-Workbench-CSRF"], "c".repeat(32));
assert.equal(JSON.parse(compileRequest.options.body).schemaVersion, "workbench-api-v1");

const createdLoop = await api.createLoop({
  name: "Action follow-up",
  description: "Turn decisions into follow-up work.",
  definition: {
    goal: "Turn meeting decisions into follow-up work.",
    context: "",
    constraints: [],
    doneWhen: ["The follow-up is clear."],
    verify: [],
    expectedResult: "A clear follow-up.",
    stopRules: [],
  },
});
assert.equal(createdLoop.data.workflow.workflowId, "workflow-new");
const createRequest = requests.at(-1);
assert.match(createRequest.url, /\/loops$/);
assert.equal(JSON.parse(createRequest.options.body).data.name, "Action follow-up");

const canonicalPackage = formatSkillPackageBytes([
  { path: "scripts/main.py", contentBase64: "cHJpbnQoJ29rJykK" },
  { path: "SKILL.md", contentBase64: "IyBQcm9vZgo=" },
]);
assert.equal(
  new TextDecoder().decode(canonicalPackage),
  '{"format":"workbench-skill-package-v1","files":[{"path":"scripts/main.py","content":"cHJpbnQoJ29rJykK"},{"path":"SKILL.md","content":"IyBQcm9vZgo="}]}\n',
);
assert.equal(encodeBytesBase64(canonicalPackage), Buffer.from(canonicalPackage).toString("base64"));

const resumableData = {
  name: "Resume proof",
  description: "Checks missing chunk transfer.",
  category: "Tests",
  filename: "resume-proof.skill",
  sizeBytes: 400000,
  files: [{ path: "SKILL.md", contentBase64: Buffer.alloc(400000, 97).toString("base64") }],
};
const resumableCalls = [];
const resumableProgress = [];
let declaredPackageBytes = 0;
const resumableResult = await inspectResumableSkillPackage({
  api: {
    async createUpload(data, options) {
      declaredPackageBytes = data.sizeBytes;
      resumableCalls.push({ operation: "create", data, options });
      return { data: { uploadId: "upload-resume-1" } };
    },
    async getUpload(uploadId) {
      resumableCalls.push({ operation: "get", uploadId });
      return { data: {
        uploadId,
        state: "selecting",
        sizeBytes: declaredPackageBytes,
        ingestMethod: "resumable",
        transfer: { chunkSizeBytes: 524288, totalChunks: 2, receivedChunks: [0], receivedBytes: 524288, complete: false },
      } };
    },
    async uploadChunk(uploadId, chunkIndex, data, options) {
      resumableCalls.push({ operation: "chunk", uploadId, chunkIndex, data, options });
      return { data: {
        uploadId,
        state: "selecting",
        sizeBytes: declaredPackageBytes,
        ingestMethod: "resumable",
        transfer: { chunkSizeBytes: 524288, totalChunks: 2, receivedChunks: [0, 1], receivedBytes: declaredPackageBytes, complete: true },
      } };
    },
    async completeUpload(uploadId, options) {
      resumableCalls.push({ operation: "complete", uploadId, options });
      return { data: {
        uploadId,
        state: "ready_draft",
        sizeBytes: declaredPackageBytes,
        ingestMethod: "resumable",
        transfer: { chunkSizeBytes: 524288, totalChunks: 2, receivedChunks: [0, 1], receivedBytes: declaredPackageBytes, complete: true },
      } };
    },
  },
  data: resumableData,
  idempotencyKey: "resume-proof",
  onProgress: (progress) => resumableProgress.push(progress),
});
assert.ok(declaredPackageBytes > resumableData.sizeBytes, "the upload declares canonical envelope bytes");
assert.deepEqual(resumableCalls.map((call) => call.operation), ["create", "get", "chunk", "complete"]);
assert.equal(resumableCalls[0].data.ingestMethod, "resumable");
assert.equal(resumableCalls[0].options.idempotencyKey, "resume-proof:upload");
assert.equal(resumableCalls[2].chunkIndex, 1, "the server-confirmed first chunk must be skipped");
assert.equal(resumableCalls[2].options.idempotencyKey, "resume-proof:chunk:1");
assert.equal(resumableCalls[3].options.idempotencyKey, "resume-proof:complete");
assert.equal(resumableProgress.at(-1).phase, "checking");
assert.equal(resumableProgress.at(-1).percent, 100);
assert.equal(resumableResult.upload.state, "ready_draft");
assert.equal(resumableResult.metadata, resumableData);
assert.equal(resumableResult.idempotencyKey, "resume-proof");

const repositoryProgress = [];
let repositoryRequest;
const repositoryData = {
  name: "Repository proof",
  description: "Checks strict import data.",
  category: "Tests",
  repositoryUrl: "https://github.com/openai/example",
  ref: "main",
  skillDirectory: "skills/proof",
};
const repositoryResult = await importSkillRepositoryPackage({
  api: {
    async importSkillRepository(data, options) {
      repositoryRequest = { data, options };
      return { data: {
        uploadId: "upload-repository-proof",
        state: "ready_draft",
        sizeBytes: 100,
        transfer: { receivedBytes: 100 },
      } };
    },
  },
  data: repositoryData,
  idempotencyKey: "repository-proof",
  onProgress: (progress) => repositoryProgress.push(progress),
});
assert.deepEqual(repositoryRequest.data, {
  repositoryUrl: repositoryData.repositoryUrl,
  ref: "main",
  skillDirectory: "skills/proof",
});
assert.equal(repositoryRequest.options.idempotencyKey, "repository-proof");
assert.deepEqual(repositoryProgress.map((progress) => progress.phase), ["importing", "checking"]);
assert.equal(repositoryResult.metadata, repositoryData);
assert.equal(repositoryResult.idempotencyKey, "repository-proof");

const upload = await api.createUpload({
  filename: "meeting-action.skill-package",
  sizeBytes: 42,
  mediaType: "application/vnd.looloomi.skill-package+json",
});
assert.equal(upload.data.uploadId, "upload-1");
const uploadRequest = requests.at(-1);
assert.match(uploadRequest.url, /\/uploads$/);
assert.equal(JSON.parse(uploadRequest.options.body).data.filename, "meeting-action.skill-package");

await api.uploadSkillPackage("upload-1", {
  files: [{ path: "SKILL.md", contentBase64: "IyBzYW1wbGU=" }],
});
const packageRequest = requests.at(-1);
assert.match(packageRequest.url, /\/uploads\/upload-1\/package$/);
assert.equal(JSON.parse(packageRequest.options.body).data.files[0].path, "SKILL.md");

const uploadStatus = await api.getUpload("upload-1");
assert.deepEqual(uploadStatus.data.transfer.receivedChunks, [0]);
const chunkBytes = canonicalPackage.subarray(0, 8);
await api.uploadChunk("upload-1", 1, {
  contentBase64: encodeBytesBase64(chunkBytes),
}, { idempotencyKey: "inspect-1:chunk:1" });
const chunkRequest = requests.at(-1);
assert.match(chunkRequest.url, /\/uploads\/upload-1\/chunks\/1$/);
assert.equal(chunkRequest.options.method, "PUT");
assert.equal(chunkRequest.options.headers["Idempotency-Key"], "inspect-1:chunk:1");
assert.equal(JSON.parse(chunkRequest.options.body).data.contentBase64, Buffer.from(chunkBytes).toString("base64"));

await api.completeUpload("upload-1", { idempotencyKey: "inspect-1:complete" });
const completeRequest = requests.at(-1);
assert.match(completeRequest.url, /\/uploads\/upload-1\/complete$/);
assert.deepEqual(JSON.parse(completeRequest.options.body).data, {});
assert.equal(completeRequest.options.headers["Idempotency-Key"], "inspect-1:complete");

const importedUpload = await api.importSkillRepository({
  repositoryUrl: "https://github.com/openai/example",
  ref: "main",
  skillDirectory: "skills/proof",
}, { idempotencyKey: "import-1" });
assert.equal(importedUpload.data.ingestMethod, "repository");
const importRequest = requests.at(-1);
assert.match(importRequest.url, /\/uploads\/repository$/);
assert.equal(importRequest.options.headers["Idempotency-Key"], "import-1");
assert.equal(JSON.parse(importRequest.options.body).data.skillDirectory, "skills/proof");

await api.promoteUpload("upload-1");
assert.match(requests.at(-1).url, /\/uploads\/upload-1\/promote$/);

const createdSkill = await api.createSkill({
  name: "Meeting action extractor",
  description: "Finds accountable follow-up actions.",
  category: "Meetings",
  uploadId: "upload-1",
});
assert.equal(createdSkill.data.skill.skillId, "skill-1");
const createSkillRequest = requests.at(-1);
assert.match(createSkillRequest.url, /\/skills$/);
assert.equal(JSON.parse(createSkillRequest.options.body).data.uploadId, "upload-1");

const draftPackage = await api.getSkillDraftPackage("skill-1", "draft-1");
assert.equal(draftPackage.data.files[0].path, "SKILL.md");
assert.equal(JSON.stringify(draftPackage.data).includes("contentHash"), false);
const replacedPackage = await api.replaceSkillDraftPackage(
  "skill-1",
  "draft-1",
  { uploadId: "upload-1" },
  { ifMatch: '"skill-draft-1:1"' },
);
assert.equal(replacedPackage.etag, '"skill-draft-1:2"');
assert.equal(requests.at(-1).options.method, "PUT");
assert.equal(JSON.parse(requests.at(-1).options.body).data.uploadId, "upload-1");

const skillDraft = await api.getSkillDraft("skill-1", "draft-1");
assert.equal(skillDraft.etag, '"skill-draft-1:1"');
const testRun = await api.createSkillTest(
  "skill-1",
  "draft-1",
  {
    testCase: {
      name: "Extract one action",
      purpose: "Check the uploaded Skill with supplied notes.",
      input: { meetingNotes: "Ari sends the brief Friday." },
      expectedOutput: { actionCount: 1 },
      timeoutSeconds: 30,
    },
  },
  { ifMatch: skillDraft.etag, idempotencyKey: "idem-skill-test-1" },
);
assert.equal(testRun.data.testRunId, "skill-test-run-1");
assert.match(requests.at(-1).url, /\/skills\/skill-1\/drafts\/draft-1\/tests$/);
assert.equal(requests.at(-1).options.headers["If-Match"], '"skill-draft-1:1"');
assert.equal(requests.at(-1).options.headers["Idempotency-Key"], "idem-skill-test-1");

const validation = await api.createSkillValidation(
  "skill-1",
  "draft-1",
  { testRunIds: ["skill-test-run-1"], permissionAcknowledged: true },
  { ifMatch: skillDraft.etag, idempotencyKey: "idem-skill-validation-1" },
);
assert.equal(validation.data.validationId, "skill-validation-1");
assert.match(requests.at(-1).url, /\/skills\/skill-1\/drafts\/draft-1\/validations$/);
assert.equal(requests.at(-1).options.headers["If-Match"], '"skill-draft-1:1"');
assert.equal(requests.at(-1).options.headers["Idempotency-Key"], "idem-skill-validation-1");

await api.getSkillTestRun("skill-1", "skill-test-run-1");
assert.match(requests.at(-1).url, /\/skills\/skill-1\/tests\/skill-test-run-1$/);
await api.getSkillValidation("skill-1", "skill-validation-1");
assert.match(requests.at(-1).url, /\/skills\/skill-1\/validations\/skill-validation-1$/);
const publishedSkill = await api.publishSkill(
  "skill-1",
  { version: "1.0.0", releaseNotes: "First verified release." },
  { ifMatch: skillDraft.etag },
);
assert.equal(publishedSkill.data.version.skillVersionId, "skill-version-1");
assert.equal(publishedSkill.data.release.releaseId, "release-skill-1");
const publishSkillRequest = requests.at(-1);
assert.match(publishSkillRequest.url, /\/skills\/skill-1\/publish$/);
assert.equal(publishSkillRequest.options.headers["If-Match"], '"skill-draft-1:1"');

const nextDraft = await api.createNextSkillDraft(
  "skill-1",
  { baseVersionId: "skill-version-1" },
  { ifMatch: skillDraft.etag },
);
assert.equal(nextDraft.data.skillDraftId, "draft-2");
assert.equal(requests.at(-1).options.headers["If-Match"], '"skill-draft-1:1"');
const updatedDraft = await api.updateSkillDraft(
  "skill-1",
  "draft-2",
  { description: "Clearer meeting actions." },
  { ifMatch: nextDraft.etag },
);
assert.equal(updatedDraft.etag, '"skill-draft-2:2"');
assert.equal(requests.at(-1).options.method, "PATCH");
const versions = await api.listSkillVersions("skill-1");
assert.deepEqual(versions.data.map((item) => item.version), ["2.0.0", "1.0.0"]);
assert.match(requests.at(-1).url, /\/skills\/skill-1\/versions$/);
assert.equal("executionRef" in versions.data[0], false);
const usage = await api.getSkillUsage("skill-1");
assert.equal(usage.data.latestVersion, "2.0.0");
const skillDiff = await api.getSkillVersionDiff("skill-1", "skill-version-1", "skill-version-2");
assert.equal(skillDiff.data.entries[0].field, "purpose");
const retiredSkill = await api.deprecateSkill("skill-1", { reason: "A newer version is available." });
assert.equal(retiredSkill.data.lifecycle, "deprecated");
assert.match(requests.at(-1).url, /\/skills\/skill-1\/deprecate$/);
assert.equal(JSON.parse(requests.at(-1).options.body).data.reason, "A newer version is available.");
const published = await api.publishLoop("workflow-new", { version: "1.0.0", releaseNotes: "First team release.", startingPoint: true }, { ifMatch: '"wfv1:workflow-new:1"' });
assert.equal(published.data.release.releaseId, "release-published");
const publishRequest = requests.at(-1);
assert.match(publishRequest.url, /\/loops\/workflow-new\/publish$/);
assert.equal(publishRequest.options.headers["If-Match"], '"wfv1:workflow-new:1"');
assert.equal(JSON.parse(publishRequest.options.body).data.startingPoint, true);
const library = await api.listTeamLibrary();
assert.equal(library.data[0].releaseId, "release-1");
const installations = await api.listInstallations();
assert.equal(installations.data[0].installationId, "installation-1");
const connectionBindings = [{ requirementId: "calendar.read", connectionId: "connection-1" }];
const installed = await api.installTeamRelease("release-1", { connectionIds: ["connection-1"], connectionBindings });
assert.equal(installed.data.installationId, "installation-1");
assert.deepEqual(JSON.parse(requests.at(-1).options.body).data.connectionBindings, connectionBindings);

await assert.rejects(
  () => api.startRun("workflow-1", { workflowRevisionId: "revision-1", inputs: {}, resourceRefs: [] }),
  (error) => error instanceof WorkbenchApiError
    && error.code === "workflow_execution_not_ready"
    && error.status === 409,
);

const cancelled = await api.cancelRun("run-1", { reason: "Stop this test run." });
assert.equal(cancelled.data.runId, "run-1");
const cancelRequest = requests.at(-1);
assert.match(cancelRequest.url, /\/runs\/run-1\/cancel$/);
assert.equal(JSON.parse(cancelRequest.options.body).data.reason, "Stop this test run.");

const retried = await api.retryRun("run-1", { reason: "Try the saved workflow again." });
assert.equal(retried.data.runId, "run-2");
const retryRequest = requests.at(-1);
assert.match(retryRequest.url, /\/runs\/run-1\/retry$/);
assert.equal(JSON.parse(retryRequest.options.body).data.reason, "Try the saved workflow again.");

const recoveryRequests = [];
let recoveryWorkspaceCalls = 0;
let recoveryCompileCalls = 0;
const recoveringApi = createWorkbenchApiClient({
  idFactory: () => "idem-restart-safe",
  async fetchImpl(url, options = {}) {
    recoveryRequests.push({ url, options });
    if (url.endsWith("/workspace")) {
      recoveryWorkspaceCalls += 1;
      return workspaceResponse(workspaceEnvelope({
        csrfToken: (recoveryWorkspaceCalls === 1 ? "a" : "b").repeat(32),
        userId: "user-recovery",
        workspaceId: "workspace-recovery",
      }));
    }
    if (url.endsWith("/compile")) {
      recoveryCompileCalls += 1;
      if (recoveryCompileCalls === 1) {
        return response({
          code: "session_required",
          message: "A Workbench session is required.",
          details: {},
          retryable: true,
          requestId: "request-session-restart",
        }, { status: 401 });
      }
      return response({ data: { status: "ready" } });
    }
    throw new Error(`unexpected_recovery_url:${url}`);
  },
});
await recoveringApi.bootstrap();
await recoveringApi.compileWorkflow("workflow-restart", "revision-restart");
const recoveryCompiles = recoveryRequests.filter((entry) => entry.url.endsWith("/compile"));
assert.equal(recoveryWorkspaceCalls, 2);
assert.equal(recoveryCompiles.length, 2);
assert.equal(recoveryCompiles[0].options.headers["Idempotency-Key"], "idem-restart-safe");
assert.equal(recoveryCompiles[1].options.headers["Idempotency-Key"], "idem-restart-safe");
assert.equal(recoveryCompiles[0].options.headers["X-Workbench-CSRF"], "a".repeat(32));
assert.equal(recoveryCompiles[1].options.headers["X-Workbench-CSRF"], "b".repeat(32));

let concurrentWorkspaceCalls = 0;
const concurrentRequests = [];
const concurrentApi = createWorkbenchApiClient({
  idFactory: () => "idem-concurrent",
  async fetchImpl(url, options = {}) {
    concurrentRequests.push({ url, options });
    if (url.endsWith("/workspace")) {
      concurrentWorkspaceCalls += 1;
      if (concurrentWorkspaceCalls === 2) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return workspaceResponse(workspaceEnvelope({
        csrfToken: (concurrentWorkspaceCalls === 1 ? "a" : "b").repeat(32),
        userId: "user-concurrent",
        workspaceId: "workspace-concurrent",
      }));
    }
    if (url.endsWith("/compile")) {
      if (options.headers["X-Workbench-CSRF"] === "a".repeat(32)) {
        return response({
          code: "session_required",
          message: "A Workbench session is required.",
          details: {},
          retryable: true,
          requestId: "request-concurrent-session-restart",
        }, { status: 401 });
      }
      return response({ data: { status: "ready" } });
    }
    throw new Error("unexpected_concurrent_url:" + url);
  },
});
await concurrentApi.bootstrap();
await Promise.all([
  concurrentApi.compileWorkflow("workflow-a", "revision-a", { idempotencyKey: "idem-a" }),
  concurrentApi.compileWorkflow("workflow-b", "revision-b", { idempotencyKey: "idem-b" }),
]);
assert.equal(concurrentWorkspaceCalls, 2, "concurrent 401 responses must share one session refresh");
const concurrentRetries = concurrentRequests.filter((entry) => (
  entry.url.endsWith("/compile") && entry.options.headers["X-Workbench-CSRF"] === "b".repeat(32)
));
assert.equal(concurrentRetries.length, 2);
assert.deepEqual(
  concurrentRetries.map((entry) => entry.options.headers["Idempotency-Key"]).sort(),
  ["idem-a", "idem-b"],
);

let principalWorkspaceCalls = 0;
let principalMutationCalls = 0;
const principalApi = createWorkbenchApiClient({
  idFactory: () => "idem-principal-fence",
  async fetchImpl(url) {
    if (url.endsWith("/workspace")) {
      principalWorkspaceCalls += 1;
      const userId = principalWorkspaceCalls === 1 ? "user-a" : "user-b";
      return workspaceResponse(workspaceEnvelope({
        csrfToken: (principalWorkspaceCalls === 1 ? "a" : "b").repeat(32),
        userId,
        workspaceId: "workspace-shared",
      }));
    }
    if (url.endsWith("/compile")) {
      principalMutationCalls += 1;
      return response({
        code: "csrf_invalid",
        message: "The signed-in user changed.",
        details: {},
        retryable: false,
        requestId: "request-principal-changed",
      }, { status: 403 });
    }
    throw new Error(`unexpected_principal_url:${url}`);
  },
});
await principalApi.bootstrap();
await assert.rejects(
  principalApi.compileWorkflow("workflow-principal", "revision-principal"),
  (error) => error?.code === "workbench_principal_changed",
);
assert.equal(principalWorkspaceCalls, 2);
assert.equal(
  principalMutationCalls,
  1,
  "a mutation rejected under one principal must not replay after the cookie switches users",
);

const authFlowRequests = [];
const invitationEnvelope = {
  invitationId: "invitation-1",
  workspaceId: "workspace-1",
  email: "member@example.test",
  role: "member",
  status: "pending",
  expiresAt: "2026-08-12T00:00:00.000Z",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  deliveryStatus: "queued",
};
const authFlowApi = createWorkbenchApiClient({
  idFactory: () => "register-idempotency-1",
  async fetchImpl(url, options = {}) {
    authFlowRequests.push({ url, options });
    if (url.endsWith("/workspace")) {
      return workspaceResponse(workspaceEnvelope({
        csrfToken: "s".repeat(32),
        userId: "user-1",
        workspaceId: "workspace-1",
      }));
    }
    if (url.endsWith("/auth/register")) {
      return response(authResultEnvelope(), {
        status: 201,
        headers: { "cache-control": "no-store" },
      });
    }
    if (url.endsWith("/auth/login")) {
      return response(authResultEnvelope(), { headers: { "cache-control": "no-store" } });
    }
    if (url.endsWith("/auth/logout")) {
      return response({
        schemaVersion: "workbench-api-v1",
        data: { revoked: true },
        requestId: "request-logout-1",
      }, { headers: { "cache-control": "no-store" } });
    }
    if (url.endsWith("/auth/invitations/inspect")) {
      return response({
        schemaVersion: "workbench-api-v1",
        data: { invitationId: "invitation-1", expiresAt: invitationEnvelope.expiresAt, providers: ["google"] },
        requestId: "request-invitation-inspect",
      }, { headers: { "cache-control": "no-store" } });
    }
    if (url.endsWith("/auth/oauth/google/start")) {
      return response({
        schemaVersion: "workbench-api-v1",
        data: { authorizationUrl: "https://accounts.example.test/authorize?state=opaque" },
        requestId: "request-oauth-start",
      }, { headers: { "cache-control": "no-store" } });
    }
    if (url.endsWith("/workspace/invitations")) {
      if (options.method === "GET") {
        return response({
          schemaVersion: "workbench-api-v1",
          data: [invitationEnvelope],
          page: { nextCursor: null, hasMore: false },
          requestId: "request-invitation-list",
        }, { headers: { "cache-control": "no-store" } });
      }
      return response({
        schemaVersion: "workbench-api-v1",
        data: { invitation: invitationEnvelope },
        requestId: "request-invitation-create",
      }, { status: 201, headers: { "cache-control": "no-store" } });
    }
    throw new Error(`unexpected_auth_flow_url:${url}`);
  },
});
await authFlowApi.bootstrap();
assert.equal((await authFlowApi.register({
  username: "owner.local",
  password: "correct horse",
})).data.workspaceId, "workspace-1");
assert.equal((await authFlowApi.login({
  username: "owner.local",
  password: "correct horse",
})).data.workspaceId, "workspace-1");
assert.equal((await authFlowApi.inspectInvitation("v1~invitation~invite-1~opaque")).data.invitationId, "invitation-1");
assert.equal((await authFlowApi.startOAuth("google", {
  token: "v1~invitation~invite-1~opaque",
})).data.authorizationUrl.startsWith("https://"), true);
assert.equal((await authFlowApi.createInvitation({ email: "member@example.test" })).data.invitation.status, "pending");
assert.equal((await authFlowApi.listInvitations()).data[0].email, "member@example.test");
assert.equal((await authFlowApi.logout()).data.revoked, true);
const registerRequest = authFlowRequests.find(({ url }) => url.endsWith("/auth/register"));
const loginRequest = authFlowRequests.find(({ url }) => url.endsWith("/auth/login"));
const logoutRequest = authFlowRequests.find(({ url }) => url.endsWith("/auth/logout"));
const inspectInvitationRequest = authFlowRequests.find(({ url }) => url.endsWith("/auth/invitations/inspect"));
const startOAuthRequest = authFlowRequests.find(({ url }) => url.endsWith("/auth/oauth/google/start"));
const createInvitationRequest = authFlowRequests.find(({ url, options }) => (
  url.endsWith("/workspace/invitations") && options.method === "POST"
));
assert.equal(registerRequest.options.headers.get("Idempotency-Key"), "register-idempotency-1");
assert.equal(registerRequest.options.headers.get("X-Workbench-CSRF"), null);
assert.equal(loginRequest.options.headers.get("X-Workbench-CSRF"), null);
assert.equal(logoutRequest.options.headers.get("X-Workbench-CSRF"), "s".repeat(32));
assert.equal(inspectInvitationRequest.options.headers.get("X-Workbench-CSRF"), null);
assert.equal(startOAuthRequest.options.headers.get("X-Workbench-CSRF"), null);
assert.equal(createInvitationRequest.options.headers.get("X-Workbench-CSRF"), "s".repeat(32));
const authFlowFetchCount = authFlowRequests.length;
await assert.rejects(
  authFlowApi.logout(),
  (error) => error?.code === "workspace_session_required",
);
assert.equal(authFlowRequests.length, authFlowFetchCount, "logout without a session stops before fetch");

let mismatchedAuthFetchCount = 0;
const mismatchedAuthApi = createWorkbenchApiClient({
  async fetchImpl(url) {
    mismatchedAuthFetchCount += 1;
    if (url.endsWith("/auth/login")) {
      return response(authResultEnvelope(), { headers: { "cache-control": "no-store" } });
    }
    if (url.endsWith("/workspace")) {
      return workspaceResponse(workspaceEnvelope({
        csrfToken: "m".repeat(32),
        userId: "user-other",
        workspaceId: "workspace-1",
      }));
    }
    throw new Error(`unexpected_mismatched_auth_url:${url}`);
  },
});
await assert.rejects(
  mismatchedAuthApi.login({ username: "owner.local", password: "correct horse" }),
  (error) => error?.code === "auth_session_principal_mismatch",
);
const mismatchFetchCountAfterLogin = mismatchedAuthFetchCount;
await assert.rejects(
  mismatchedAuthApi.logout(),
  (error) => error?.code === "workspace_session_required",
);
assert.equal(
  mismatchedAuthFetchCount,
  mismatchFetchCountAfterLogin,
  "a mismatched auth/session principal must clear the local mutation session",
);

const events = [];
const expectedRunEventTypes = [
  "run.queued",
  "run.started",
  "node.started",
  "node.progress",
  "node.completed",
  "node.failed",
  "review.requested",
  "run.paused",
  "run.cancellation_requested",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.partial",
  "run.effect_outcome_unknown",
];
assert.deepEqual(RUN_EVENT_TYPES, expectedRunEventTypes);
assert.deepEqual(RUN_TERMINAL_STATUSES, [
  "completed",
  "failed",
  "cancelled",
  "partial",
  "effect_outcome_unknown",
]);
for (const status of RUN_TERMINAL_STATUSES) assert.equal(isTerminalRunStatus(status), true);
for (const status of ["queued", "running", "waiting_review", "paused", "cancellation_requested"]) {
  assert.equal(isTerminalRunStatus(status), false);
}
assert.equal(runRefetchInterval({ state: { data: { data: { run: { status: "partial" } } } } }), false);
assert.equal(runRefetchInterval({ state: { data: { data: { run: { status: "effect_outcome_unknown" } } } } }), false);
assert.equal(runRefetchInterval({ state: { data: { data: { run: { status: "cancellation_requested" } } } } }), 1_000);
assert.equal(workflowRunsRefetchInterval({
  state: { data: { data: [{ status: "completed" }, { status: "partial" }] } },
}), false);
assert.equal(workflowRunsRefetchInterval({
  state: { data: { data: [{ status: "partial" }, { status: "running" }] } },
}), 1_000);
const stream = api.openRunEventStream("run-1", {
  after: 4,
  onEvent: (event) => events.push(event),
});
assert.equal(eventSources[0].url, "/api/workbench/v1/runs/run-1/events?after=4");
assert.equal(eventSources[0].options.withCredentials, true);
assert.ok(RUN_EVENT_TYPES.every((type) => eventSources[0].listeners.has(type)));
for (const [index, type] of RUN_EVENT_TYPES.entries()) {
  eventSources[0].emit(type, { runId: "run-1", sequence: index + 5, type });
}
assert.deepEqual(events.map((event) => event.type), expectedRunEventTypes);
stream.close();
assert.equal(eventSources[0].closed, true);

let visualReviewFetchCount = 0;
const visualReviewApi = createWorkbenchApiClient({
  reviewMode: "visual-only",
  async fetchImpl(url) {
    visualReviewFetchCount += 1;
    if (url.endsWith("/auth/login")) {
      return response(authResultEnvelope({
        user: { ...authUser, userId: "visual-reviewer", username: "visual.review" },
        workspaceId: "workspace-visual",
      }), { headers: { "cache-control": "no-store" } });
    }
    if (url.endsWith("/workspace")) {
      return workspaceResponse(workspaceEnvelope({
        csrfToken: "v".repeat(32),
        userId: "visual-reviewer",
        workspaceId: "workspace-visual",
      }));
    }
    throw new Error(`visual_review_mutation_reached_fetch:${url}`);
  },
});
await visualReviewApi.bootstrap();
await visualReviewApi.login({ username: "visual-reviewer", password: "review-only" });
assert.equal(
  visualReviewFetchCount,
  3,
  "visual-only review may use only login plus its read-only workspace refresh to establish identity",
);
await assert.rejects(
  visualReviewApi.createResource({
    label: "Must not be written",
    mediaType: "text/plain",
    contentBase64: "bm8=",
  }),
  (error) => error?.code === "visual_review_mutation_forbidden",
);
assert.equal(visualReviewFetchCount, 3, "visual-only business mutations must be blocked before fetch");

console.log("web_api_client_smoke=pass");
