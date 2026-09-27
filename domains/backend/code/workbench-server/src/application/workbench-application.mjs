import {
  AUTHORIZATION_CAPABILITIES,
  AgentTurnUsageSchema,
  Check,
  StagedLoopProposalSchema,
  WorkflowSchema,
} from "@looloomi/workbench-contracts";
import { createHash } from "node:crypto";

import { listBuiltinAgentDefinitions } from "../agents/agent-definitions.mjs";
import { mergeSkillDraftProposal } from "../agents/agent-proposal-merge.mjs";
import {
  compileWorkflowV1,
} from "../compiler/index.mjs";
import {
  connectionApprovalSnapshot,
  createWorkspaceConnectionService,
  validateRequiredConnectionBindings,
} from "../connections/workspace-connection-service.mjs";
import { applyBuilderOperations } from "../proposals/index.mjs";
import {
  applyWorkflowAgentOperations,
  mergeWorkflowProposal,
} from "../proposals/three-way-proposal-merge.mjs";
import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash, formatSkillDraftEtag } from "../store/serialization.mjs";
import { initialLoopDraft } from "../loops/initial-loop-draft.mjs";
import {
  resolvePinnedSkill,
} from "../skills/published-skill-definition.mjs";
import { scaffoldSkillDraftPackage as scaffoldGovernedSkillDraftPackage } from "../skills/skill-runtime-catalog.mjs";
import { evaluateWorkspaceFeatureReadiness } from "./workspace-feature-readiness.mjs";
import { buildProductTrace } from "../observability/product-trace-service.mjs";
import { ObjectAccessPolicy } from "../authorization/index.mjs";

const PAGE = Object.freeze({ nextCursor: null, hasMore: false });
const STABLE_SYSTEM_INBOX_TIME = "1970-01-01T00:00:00.000Z";
const clone = (value) => structuredClone(value);
const proposalExpiry = (createdAt) => new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString();
const encodeInboxCursor = (item) => Buffer.from(
  JSON.stringify({ createdAt: item.createdAt, itemId: item.itemId }),
  "utf8",
).toString("base64url");
const decodeInboxCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value?.createdAt !== "string" || typeof value?.itemId !== "string") throw new Error();
    return value;
  } catch {
    throw storeError("cursor_invalid", "Inbox cursor is invalid.");
  }
};
const encodeModelCatalogCursor = (profile) => Buffer.from(
  JSON.stringify({ displayName: profile.displayName, profileId: profile.profileId }),
  "utf8",
).toString("base64url");
const decodeModelCatalogCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value?.displayName !== "string" || typeof value?.profileId !== "string") throw new Error();
    return value;
  } catch {
    throw storeError("cursor_invalid", "Model catalog cursor is invalid.");
  }
};
const inboxItem = ({
  workspaceId,
  objectKind,
  objectId,
  reason,
  severity,
  title,
  actionRoute,
  createdAt,
}) => ({
  schemaVersion: "workbench-v1",
  itemId: `inbox-${createHash("sha256")
    .update(`${workspaceId}:${objectKind}:${objectId}`)
    .digest("hex")
    .slice(0, 48)}`,
  workspaceId,
  objectKind,
  objectId,
  reason,
  severity,
  title,
  actionRoute,
  createdAt,
});
const unavailableModelTitle = (displayName) => {
  const name = String(displayName || "Model");
  const bounded = name.length > 181 ? `${name.slice(0, 180)}…` : name;
  return `${bounded} is unavailable`;
};
const agentProposalActionRoute = (proposal) => {
  const proposalId = encodeURIComponent(proposal.proposalId);
  return `/?session=${encodeURIComponent(proposal.sessionId)}&proposal=${proposalId}`;
};
const listInboxRecords = (repository, filter) => (
  typeof repository.listAllForReadModel === "function"
    ? repository.listAllForReadModel(filter)
    : repository.listWhere(filter, { limit: 1000 })
);
const listInboxRuns = (repository, workspaceId) => (
  typeof repository.listAllByWorkspaceForReadModel === "function"
    ? repository.listAllByWorkspaceForReadModel(workspaceId)
    : repository.listByWorkspace(workspaceId, { limit: 1000 })
);

const storeError = (code, message, details = {}) => new ProductStoreError(code, message, details);
const COMPILE_MODEL_ROUTE_ERROR_CODES = new Set([
  "model_route_unresolved",
  "model_profile_not_found",
  "model_profile_forbidden",
  "model_capability_mismatch",
  "model_revision_unavailable",
]);

function compileModelRouteErrorCode(code) {
  return COMPILE_MODEL_ROUTE_ERROR_CODES.has(code) ? code : "model_route_unresolved";
}

function resultPage(value) {
  if (Array.isArray(value)) return { data: value, page: value.page ?? PAGE };
  return { data: value.data ?? value.items ?? [], page: value.page ?? PAGE };
}

function projectRunTaskStatus(status) {
  if (status === "waiting_review" || status === "paused") return "waiting_review";
  if (["queued", "running", "completed", "failed", "cancelled"].includes(status)) return status;
  return status === "blocked" ? "blocked" : "idle";
}

async function resolveWorkspaceDefaultModel({
  modelCatalog,
  workspaceId,
  userId,
  capability,
  requiredCapabilities,
}) {
  if (!modelCatalog?.getWorkspacePolicy || !modelCatalog?.resolveCurrentProfile) return null;
  const policy = await modelCatalog.getWorkspacePolicy(workspaceId, { userId });
  const profileId = policy?.defaultProfileIdsByCapability?.[capability];
  if (!profileId) return null;
  return modelCatalog.resolveCurrentProfile({
    profileId,
    workspaceId,
    userId,
    capabilities: requiredCapabilities,
    requireReady: true,
  });
}

function productSafeInvocation(invocation) {
  return {
    invocationId: invocation.invocationId,
    attemptId: invocation.attemptId,
    mode: invocation.mode,
    isolation: invocation.isolation,
    status: invocation.status,
    requestedModelRevisionId: invocation.result?.requestedModelRevisionId
      ?? invocation.request?.modelProfileRevisionId
      ?? invocation.request?.metadata?.modelProfileRevisionId
      ?? null,
    actualModelRevisionId: invocation.result?.actualModelRevisionId ?? null,
    artifactRefs: clone(invocation.result?.artifactRefs ?? []),
    ...(invocation.result?.usage ? { usage: Object.fromEntries(
      Object.keys(AgentTurnUsageSchema.properties)
        .filter((key) => invocation.result.usage[key] !== undefined)
        .map((key) => [key, invocation.result.usage[key]]),
    ) } : {}),
    createdAt: invocation.createdAt,
    startedAt: invocation.startedAt ?? null,
    finishedAt: invocation.finishedAt ?? null,
  };
}

function requireRepository(store, name) {
  const repository = store.repositories?.[name];
  if (!repository) throw new TypeError(`workbench_repository_missing:${name}`);
  return repository;
}

function readinessFromProbe(probe) {
  const ready = probe?.ready === true || probe?.status === "ready";
  return {
    status: ready ? "ready" : "blocked",
    reason: probe?.code ?? probe?.reason ?? "skill_runtime_unavailable",
  };
}

function productSafeSkillDefinition(skill) {
  return {
    schemaVersion: skill.schemaVersion,
    skillId: skill.skillId,
    version: skill.version,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    display: clone(skill.display),
    inputSchema: clone(skill.inputSchema),
    outputSchema: clone(skill.outputSchema),
    risk: clone(skill.risk),
    dependencies: clone(skill.dependencies ?? []),
    setupChecks: clone(skill.setupChecks ?? []),
    execution: skill.executionRef?.executionMode === "model"
      ? {
        executionMode: "model",
        requiredModelCapability: skill.executionRef.requiredModelCapability,
      }
      : { executionMode: skill.executionRef?.executionMode },
    usageCount: skill.usageCount ?? 0,
    readiness: clone(skill.readiness),
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

function productSafeSkillRecord(skill, userId, { canCreateVersion = true } = {}) {
  // `archived` is a governed terminal state after deprecation. V1 exposes no
  // ordinary user action that can enter or leave it.
  const allowedActions = [];
  if (skill.ownerId === userId && skill.lifecycle === "draft") {
    allowedActions.push("edit");
  } else if (skill.ownerId === userId && skill.lifecycle === "tested") {
    allowedActions.push("edit", "publish");
  } else if (skill.ownerId === userId && skill.lifecycle === "published" && skill.latestPublishedVersionId) {
    if (canCreateVersion) allowedActions.push("create_version");
    allowedActions.push("retire");
  }
  return {
    schemaVersion: skill.schemaVersion,
    skillId: skill.skillId,
    visibility: skill.visibility,
    lifecycle: skill.lifecycle,
    ...(skill.retirement ? {
      retirement: {
        reason: skill.retirement.reason,
        retiredAt: skill.retirement.retiredAt,
      },
    } : {}),
    currentDraftId: skill.currentDraftId ?? null,
    latestPublishedVersionId: skill.latestPublishedVersionId ?? null,
    allowedActions,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

function productSafeSkillDraft(draft) {
  if (!draft) return null;
  return {
    schemaVersion: draft.schemaVersion,
    skillDraftId: draft.skillDraftId,
    skillId: draft.skillId,
    baseVersionId: draft.baseVersionId ?? null,
    revision: draft.revision,
    name: draft.name,
    description: draft.description,
    category: draft.category,
    inputSchema: clone(draft.inputSchema),
    outputSchema: clone(draft.outputSchema),
    risk: clone(draft.risk),
    dependencies: clone(draft.dependencies ?? []),
    connectionRequirements: clone(draft.connectionRequirements ?? []),
    fileCount: draft.files?.length ?? 0,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

function productSafeWorkflow(workflow) {
  return Object.fromEntries(Object.keys(WorkflowSchema.properties)
    .filter((key) => Object.hasOwn(workflow, key)).map((key) => [key, clone(workflow[key])]));
}

function productSafeStagedLoopProposal(proposal) {
  // Internal generation state and request hashes never belong to the public proposal.
  const value = Object.fromEntries(Object.keys(StagedLoopProposalSchema.properties)
    .filter((key) => Object.hasOwn(proposal, key))
    .map((key) => [key, clone(proposal[key])]));
  if (!Check(StagedLoopProposalSchema, value)) {
    throw storeError("builder_proposal_invalid", "The staged Loop proposal could not be verified.");
  }
  return value;
}

function productSafePublishedSkillVersion(version) {
  if (!version) return null;
  return {
    schemaVersion: version.schemaVersion,
    skillVersionId: version.skillVersionId,
    skillId: version.skillId,
    version: version.version,
    name: version.name,
    description: version.description,
    category: version.category,
    inputSchema: clone(version.inputSchema),
    outputSchema: clone(version.outputSchema),
    risk: clone(version.risk),
    dependencies: clone(version.dependencies ?? []),
    connectionRequirements: clone(version.connectionRequirements ?? []),
    validation: {
      status: version.validation?.status ?? "not_started",
      testedAt: version.validation?.testedAt ?? null,
    },
    publishedAt: version.publishedAt,
  };
}

function productSafeSkillVersionSummary(version) {
  return {
    skillVersionId: version.skillVersionId,
    skillId: version.skillId,
    version: version.version,
    name: version.name,
    description: version.description,
    category: version.category,
    validation: {
      status: version.validation?.status ?? "not_started",
      testedAt: version.validation?.testedAt ?? null,
    },
    publishedAt: version.publishedAt,
  };
}

function productSafeSkillTestRun(record) {
  return {
    schemaVersion: record.schemaVersion,
    testRunId: record.testRunId,
    skillId: record.skillId,
    skillDraftId: record.skillDraftId,
    testCase: clone(record.testCase),
    status: record.status,
    diagnostics: clone(record.diagnostics ?? []),
    outputPreview: clone(record.outputPreview ?? null),
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
  };
}

function productSafeSkillValidation(record) {
  return {
    schemaVersion: record.schemaVersion,
    validationId: record.validationId,
    skillId: record.skillId,
    skillDraftId: record.skillDraftId,
    draftRevision: record.draftRevision,
    testRunIds: clone(record.testRunIds ?? []),
    permissionAcknowledged: record.permissionAcknowledged === true,
    status: record.status,
    diagnostics: clone(record.diagnostics ?? []),
    runtimeSummary: clone(record.runtimeSummary),
    createdAt: record.createdAt,
    completedAt: record.completedAt ?? null,
  };
}

function productSafeSkillRelease(release) {
  return {
    schemaVersion: release.schemaVersion,
    releaseId: release.releaseId,
    assetKind: release.assetKind,
    assetId: release.assetId,
    versionId: release.versionId,
    ...(release.version ? { version: release.version } : {}),
    visibility: release.visibility,
    startingPoint: release.startingPoint,
    releaseNotes: release.releaseNotes,
    dependencies: clone(release.dependencies ?? []),
    publishedAt: release.publishedAt,
  };
}

export function createExecutionResolver({ store } = {}) {
  if (!store || typeof store.connect !== "function") {
    throw new TypeError("workbench_store_required");
  }
  return async ({ workflowId, revisionId } = {}) => {
    if (!workflowId || !revisionId) {
      throw storeError("workflow_execution_not_ready", "A saved Workflow revision is required.");
    }
    await store.connect();
    const revisions = requireRepository(store, "workflowRevisions");
    const compileResults = requireRepository(store, "compileResults");
    const revision = await revisions.get(workflowId, revisionId);
    const workflow = store.repositories.workflows?.getInternal
      ? await store.repositories.workflows.getInternal(workflowId)
      : null;
    const compileResult = await compileResults.getLatest(revisionId);
    const plan = compileResult?.executionPlan;
    if (
      !revision
      || compileResult?.status !== "ready"
      || !plan
      || plan.workflowId !== workflowId
      || plan.workflowRevisionId !== revisionId
    ) {
      throw storeError(
        "workflow_execution_not_ready",
        "Compile this saved Workflow revision before starting a run.",
        { workflowId, revisionId },
      );
    }
    const pinnedSkills = new Map();
    const skillVersions = [];
    for (const ref of plan.pinnedSkills ?? []) {
      const resolved = await resolvePinnedSkill({
        repositories: store.repositories,
        skillRef: ref,
        workspaceId: workflow?.workspaceId,
      });
      const definition = resolved.definition;
      if (!definition?.executionRef) {
        throw storeError(
          "pinned_skill_contract_missing",
          "A pinned Skill version is no longer available.",
          { skillId: ref.skillId, version: ref.version },
        );
      }
      pinnedSkills.set(`${ref.skillId}:${ref.version}`, {
        definition: clone(definition),
        executionRef: clone(definition.executionRef),
      });
      if (resolved.skillVersion) skillVersions.push(clone(resolved.skillVersion));
    }
    const resources = new Map();
    for (const ref of revision.resourceRefs ?? []) {
      const resource = await requireRepository(store, "resources").get(ref.resourceId, {
        workspaceId: workflow?.workspaceId,
      });
      if (!resource || resource.version !== ref.version || resource.readiness?.status !== "ready") {
        throw storeError("workflow_execution_not_ready", "Attached material is not ready to use.", { resourceId: ref.resourceId });
      }
      resources.set(`${ref.resourceId}:${ref.version}`, clone(resource));
    }
    const connectionBindings = store.repositories.connectionBindings?.listByTarget
      ? await store.repositories.connectionBindings.listByTarget({
        workspaceId: workflow?.workspaceId,
        targetKind: "workflow_revision",
        targetId: revisionId,
      })
      : [];
    const connectionRequirementIds = [...new Set(
      (plan.steps ?? [])
        .flatMap((step) => step?.capabilities?.connectionIds ?? [])
        .filter((requirementId) => typeof requirementId === "string" && requirementId.length > 0),
    )].sort();
    const validatedConnectionBindings = connectionRequirementIds.length
      ? await validateRequiredConnectionBindings({
        requirements: connectionRequirementIds.map((requirementId) => ({
          requirementId,
          required: true,
        })),
        connectionBindings: connectionBindings.filter((binding) =>
          connectionRequirementIds.includes(binding.requirementId)),
        repositories: store.repositories,
        workspaceId: workflow?.workspaceId,
      })
      : [];
    const resolvedConnectionBindings = await Promise.all(
      validatedConnectionBindings.map(async (binding) => {
        const connection = await store.repositories.connections.get(binding.connectionId, {
          workspaceId: workflow?.workspaceId,
        });
        if (!connection || !Number.isInteger(connection.revision)) {
          throw storeError(
            "connection_rebind_required",
            "The selected Connection revision is unavailable.",
            { requirementId: binding.requirementId, connectionId: binding.connectionId },
          );
        }
        return connectionApprovalSnapshot(connection, {
          requirementId: binding.requirementId,
        });
      }),
    );
    return {
      revision: clone(revision),
      compileResult: clone(compileResult),
      skills: pinnedSkills,
      skillVersions,
      resources,
      connectionBindings: clone(resolvedConnectionBindings),
      connectionIds: [...new Set(
        resolvedConnectionBindings.map((binding) => binding.connectionId),
      )].sort(),
      workspaceId: workflow?.workspaceId ?? null,
    };
  };
}

export function createWorkbenchApplication({
  store,
  agentRuntime,
  agentProposalService = null,
  executionBroker = null,
  admissionController = null,
  agentTurnRunner = null,
  agentProposalReadModel = null,
  agentProposalLifecycle = null,
  agentToolApprovalLifecycle = null,
  agentHandoffLifecycle = null,
  workItemLifecycle = null,
  memoryService = null,
  artifactService = null,
  modelCatalog = null,
  modelConfiguration = null,
  modelService = null,
  runner,
  skillDraftLifecycle = null,
  skillReadModel = null,
  loopDraftLifecycle = null,
  workflowCompileLifecycle = null,
  workflowReadModel = null,
  builderProposalReadModel = null,
  builderProposalLifecycle = null,
  inboxReadModel = null,
  workspaceReadModel = null,
  objectReadModel = null,
  compatibilityCatalogReadModel = null,
  nativeSkillPackageReader = null,
  teamLibraryReadModel = null,
  teamLibraryLifecycle = null,
  systemCatalogService = null,
  workspaceAuthorizer = null,
  skillUploadService = null,
  serverSkillImportService = null,
  skillValidationService = null,
  skillValidationContextResolver = null,
  skillTestRunner = null,
  skillRuntimeCatalog = [],
  registeredToolCatalog = [],
  textResourceService = null,
  inputAttachmentService = null,
  connectionDriverRegistry = null,
  connectionService: injectedConnectionService = null,
  trustedSkillActivationRegistry = null,
  commandIntake = null,
  skillCommandIntake = null,
  skillCommandAuthorizer = null,
  workflowCommandAuthorizer = null,
  idempotentMutationPort = null,
  externalMutationPort = null,
  automationLifecycle = null,
  deviceLifecycle = null,
  memberAgentService = null,
  sessionDomainReadModel = null,
  objectAccessPolicy = new ObjectAccessPolicy(),
  clock = () => new Date().toISOString(),
  idFactory = (kind) => `${kind}-${crypto.randomUUID()}`,
  workspaceId = "workspace-local",
  userId = "user-local",
} = {}) {
  if (!store || typeof store.connect !== "function") throw new TypeError("workbench_store_required");

  const productCommandIntake = commandIntake;
  const productSkillCommandIntake = skillCommandIntake ?? productCommandIntake;
  const resolveSkillValidationContext = skillValidationContextResolver
    ?? (typeof store.resolveSkillValidationContext === "function"
      ? (input) => store.resolveSkillValidationContext(input)
      : null);
  const skillActionAvailability = Object.freeze({
    canCreateVersion: store.persistenceDriver !== "postgres"
      || typeof skillDraftLifecycle?.createNextSkillDraft === "function"
      || typeof store.createNextSkillDraft === "function",
  });

  const runIdempotentMutation = (options, mutation) => {
    if (idempotentMutationPort?.run) return idempotentMutationPort.run(options, mutation);
    if (typeof store.runIdempotentMutation !== "function") {
      throw new TypeError("workbench_idempotency_required");
    }
    return store.runIdempotentMutation(options, mutation);
  };

  const ready = () => store.connect();
  const loadWorkflow = async (workflowId, { workspaceId: requestedWorkspaceId, session } = {}) => {
    if (workflowReadModel) {
      return workflowReadModel.getWorkflow({ workflowId, workspaceId: requestedWorkspaceId });
    }
    if (typeof store.getWorkflow !== "function") {
      throw storeError("workflow_read_unavailable", "Workflow reads are not available.", { workflowId });
    }
    return store.getWorkflow(workflowId, { workspaceId: requestedWorkspaceId, ...(session ? { session } : {}) });
  };
  const connectionService = injectedConnectionService ?? createWorkspaceConnectionService({
    store,
    driverRegistry: connectionDriverRegistry,
    clock,
    idFactory,
  });
  // The legacy service is a repository facade.  Only an explicitly injected
  // owner (the PostgreSQL composition) may replace the readiness read path.
  const readinessConnectionService = injectedConnectionService?.list
    ? injectedConnectionService
    : null;
  const runExternalMutation = (options, mutation) => {
    if (externalMutationPort?.run) return externalMutationPort.run(options, mutation);
    if (typeof store.runIdempotentExternalMutation !== "function") {
      throw new TypeError("workbench_external_idempotency_required");
    }
    return store.runIdempotentExternalMutation(options, (operationId) => mutation(operationId));
  };
  const resolveAuth = async (auth, minimumRole = "viewer") => {
    const context = {
      userId: auth?.userId ?? userId,
      workspaceId: auth?.activeWorkspaceId ?? auth?.workspaceId ?? workspaceId,
      role: auth?.role ?? "owner",
      principalKind: auth?.principalKind ?? "user",
      clientSessionId: auth?.clientSessionId ?? null,
      clientKind: auth?.clientKind ?? null,
      devicePublicKey: auth?.devicePublicKey ?? null,
      capabilities: Array.isArray(auth?.capabilities) ? [...auth.capabilities] : [],
      capabilitiesDeclared: Array.isArray(auth?.capabilities),
    };
    const authorizationOwner = workspaceAuthorizer ?? store;
    if (auth && typeof authorizationOwner.authorizeWorkspace === "function") {
      const membership = await authorizationOwner.authorizeWorkspace({
        userId: context.userId,
        workspaceId: context.workspaceId,
        minimumRole,
      });
      if (membership?.role) context.role = membership.role;
    }
    return context;
  };
  const listPersistedAccessGrants = async ({
    objectKind,
    objectId,
    context,
    session,
  }) => (
    typeof store.listActiveObjectAccessGrants === "function"
      ? store.listActiveObjectAccessGrants({
          workspaceId: context.workspaceId,
          objectKind,
          objectId,
          principalId: context.userId,
          session,
        })
      : []
  );
  const requireSkillDraftAccess = async ({
    skillId,
    draftId,
    context,
    access = "read",
    session,
  } = {}) => {
    if (!skillReadModel && typeof store.getSkillDraft !== "function") {
      throw storeError("skill_draft_unavailable", "Skill drafts are not available.");
    }
    const value = skillReadModel
      ? await skillReadModel.getSkillDraft({ skillId, draftId, workspaceId: context.workspaceId })
      : await store.getSkillDraft({ skillId, draftId, workspaceId: context.workspaceId, session });
    const persistedGrants = await listPersistedAccessGrants({
      objectKind: "skill_draft",
      objectId: draftId,
      context,
      session,
    });
    const ownsBranch = value.skill.ownerId === context.userId;
    if (access !== "read" && !ownsBranch) {
      // V1 has personal Draft branches. Object grants can expose a governed
      // read surface, but collaborators change the canonical Draft only via a
      // proposal reviewed/applied by its owner.
      throw storeError("skill_not_found", "Skill not found.", { skillId });
    }
    const grantedCapabilities = persistedGrants.flatMap((grant) => grant.capabilities ?? []);
    const compatibilityCapabilities = ownsBranch && !context.capabilitiesDeclared
      ? AUTHORIZATION_CAPABILITIES
      : [...new Set([...context.capabilities, ...grantedCapabilities])];
    const operation = ({
      read: "read",
      edit: "update",
      execute: "execute",
      publish: "publish",
    })[access] ?? "read";
    const decision = objectAccessPolicy.evaluate({
      principal: {
        principalId: context.userId,
        kind: context.principalKind,
        workspaceId: context.workspaceId,
        workspaceRole: context.role,
        capabilities: compatibilityCapabilities,
      },
      target: {
        objectKind: "skill_draft",
        objectId: draftId,
        workspaceId: value.skill.workspaceId ?? context.workspaceId,
        ownerPrincipalId: value.skill.ownerId,
        visibility: "private",
        grants: persistedGrants.map(({ principalId, role }) => ({ principalId, role })),
      },
      operation,
    });
    if (!decision.allowed) {
      throw storeError("skill_not_found", "Skill not found.", { skillId });
    }
    return value;
  };
  const requireAgentObjectAccess = async ({
    objectKind,
    objectId,
    context,
    session,
    access = "read",
  } = {}) => {
    if (!objectKind && !objectId) return;
    if (objectKind === "skill_draft") {
      const loaded = skillReadModel
        ? await skillReadModel.getDraftById({ draftId: objectId, workspaceId: context.workspaceId })
        : null;
      const draft = loaded?.draft ?? await requireRepository(store, "skillDrafts").get(objectId, {
        workspaceId: context.workspaceId, session,
      });
      try {
        if (!draft) throw storeError("skill_not_found", "Skill not found.");
        await requireSkillDraftAccess({
          skillId: draft.skillId,
          draftId: objectId,
          context,
          access,
          session,
        });
      } catch (error) {
        if (!["skill_not_found", "skill_draft_not_found"].includes(error?.code)) throw error;
        throw storeError(
          "agent_object_forbidden",
          "Only the private Skill draft owner can create or resume this Agent session.",
        );
      }
      return;
    }
    if (objectKind === "workflow") {
      try {
        await requireWorkflowAccess({
          workflowId: objectId,
          context,
          access,
          session,
        });
      } catch (error) {
        if (error?.code !== "workflow_not_found") throw error;
        throw storeError(
          "agent_object_forbidden",
          "This private Loop is not available to the current user.",
        );
      }
      return;
    }
    throw storeError("agent_object_forbidden", "This object cannot be opened by a module Agent.");
  };
  const evaluateWorkflowAccess = async ({ workflow, context, access = "read", session } = {}) => {
    const operation = ({
      read: "read",
      edit: "update",
      execute: "execute",
      publish: "publish",
      review: "review",
      manage: "update",
    })[access] ?? "read";
    const ownsWorkflow = workflow?.ownerId === context.userId;
    const persistedGrants = workflow
      ? await listPersistedAccessGrants({
          objectKind: "workflow",
          objectId: workflow.workflowId,
          context,
          session,
        })
      : [];
    const grants = [
      ...(workflow?.accessGrants ?? []),
      ...persistedGrants.map(({ principalId, role }) => ({ principalId, role })),
    ];
    const grantedCapabilities = persistedGrants.flatMap((grant) => grant.capabilities ?? []);
    const compatibilityCapabilities = ownsWorkflow && !context.capabilitiesDeclared
      ? AUTHORIZATION_CAPABILITIES
      : [...new Set([...context.capabilities, ...grantedCapabilities])];
    return objectAccessPolicy.evaluate({
      principal: {
        principalId: context.userId,
        kind: context.principalKind,
        workspaceId: context.workspaceId,
        workspaceRole: context.role,
        capabilities: compatibilityCapabilities,
      },
      target: workflow ? {
        objectKind: "workflow",
        objectId: workflow.workflowId,
        workspaceId: workflow.workspaceId ?? context.workspaceId,
        ownerPrincipalId: workflow.ownerId,
        visibility: workflow.visibility ?? "private",
        grants,
      } : null,
      operation,
    });
  };
  const requireWorkflowAccess = async ({
    workflowId,
    context,
    access = "read",
    session,
    value: loadedValue,
  } = {}) => {
    const value = loadedValue ?? await loadWorkflow(workflowId, {
      workspaceId: context.workspaceId,
      session,
    });
    const workflow = value?.workflow ?? value;
    const decision = await evaluateWorkflowAccess({ workflow, context, access, session });
    if (!decision.allowed) {
      // Do not disclose whether a private Workflow exists to another principal.
      throw storeError("workflow_not_found", "Workflow not found.", { workflowId });
    }
    return value;
  };
  const canReadWorkflow = async (workflow, context, session) => (
    await evaluateWorkflowAccess({ workflow, context, access: "read", session })
  ).allowed;
  const filterReadableWorkflowReferences = async ({
    references,
    context,
    idFor = (reference) => reference?.workflowId,
    session,
  } = {}) => {
    const visible = [];
    for (const reference of references ?? []) {
      const workflowId = idFor(reference);
      if (!workflowId) continue;
      let value;
      try {
        value = await loadWorkflow(workflowId, { workspaceId: context.workspaceId, session });
      } catch (error) {
        if (error?.code === "workflow_not_found") continue;
        throw error;
      }
      if (await canReadWorkflow(value?.workflow ?? value, context, session)) {
        visible.push(reference);
      }
    }
    return visible;
  };
  const evaluateSkillAccess = async ({
    skill,
    context,
    access = "read",
    requestedSkillVersionId,
    workspaceReleaseVersionId,
    session,
  } = {}) => {
    const operation = ({
      read: "read",
      edit: "update",
      execute: "execute",
      publish: "publish",
      retire: "delete",
    })[access] ?? "read";
    const ownsSkill = skill?.ownerId === context.userId;
    const persistedGrants = skill
      ? await listPersistedAccessGrants({
          objectKind: "skill",
          objectId: skill.skillId,
          context,
          session,
        })
      : [];
    const grants = [
      ...(skill?.accessGrants ?? []),
      ...persistedGrants.map(({ principalId, role }) => ({ principalId, role })),
    ];
    const grantedCapabilities = persistedGrants.flatMap((grant) => grant.capabilities ?? []);
    const compatibilityCapabilities = ownsSkill && !context.capabilitiesDeclared
      ? AUTHORIZATION_CAPABILITIES
      : [...new Set([...context.capabilities, ...grantedCapabilities])];
    return objectAccessPolicy.evaluate({
      principal: {
        principalId: context.userId,
        kind: context.principalKind,
        workspaceId: context.workspaceId,
        workspaceRole: context.role,
        capabilities: compatibilityCapabilities,
      },
      target: skill ? {
        objectKind: "skill",
        objectId: skill.skillId,
        workspaceId: skill.workspaceId ?? context.workspaceId,
        ownerPrincipalId: skill.ownerId,
        visibility: skill.visibility ?? "private",
        lifecycle: skill.lifecycle,
        latestPublishedVersionId: skill.latestPublishedVersionId ?? null,
        requestedSkillVersionId: requestedSkillVersionId ?? null,
        workspaceReleaseVersionId: workspaceReleaseVersionId ?? null,
        grants,
      } : null,
      operation,
    });
  };
  const requireSkillAccess = async ({
    skillId,
    context,
    access = "read",
    requestedSkillVersionId,
    workspaceReleaseVersionId,
    session,
    value: loadedSkill,
  } = {}) => {
    await ready();
    const skill = loadedSkill ?? (skillReadModel?.getSkill
      ? await skillReadModel.getSkill({ skillId, workspaceId: context.workspaceId })
      : await requireRepository(store, "skillAssets").get(skillId, {
          workspaceId: context.workspaceId,
          ...(session ? { session } : {}),
        }));
    const decision = await evaluateSkillAccess({
      skill,
      context,
      access,
      requestedSkillVersionId,
      workspaceReleaseVersionId,
      session,
    });
    if (!decision.allowed) {
      throw storeError("skill_not_found", "Skill not found.", { skillId });
    }
    return { skill, decision };
  };
  const canReadSkill = async (skill, context) => (
    await evaluateSkillAccess({ skill, context, access: "read" })
  ).allowed;
  const requireSkillOwner = async ({ skillId, context, session } = {}) => {
    const { skill } = await requireSkillAccess({ skillId, context, access: "read", session });
    if (skill.ownerId !== context.userId) {
      // A Skill grant permits discovery/use according to its role. It does not
      // turn another principal's active personal Draft into a shared mutable Draft.
      throw storeError("skill_not_found", "Skill not found.", { skillId });
    }
    return skill;
  };
  const requireSkillReferenceAccess = async ({ skillRef, context, session } = {}) => {
    const skillId = skillRef?.skillId;
    const version = skillRef?.version;
    if (!skillId || !version) {
      throw storeError("skill_not_found", "Skill not found.");
    }
    await ready();
    const options = { workspaceId: context.workspaceId, ...(session ? { session } : {}) };
    const asset = skillReadModel?.getSkill
      ? await skillReadModel.getSkill({ skillId, workspaceId: context.workspaceId })
      : await requireRepository(store, "skillAssets").get(skillId, options);
    if (asset) {
      const published = skillReadModel?.getSkillVersionByRef
        ? await skillReadModel.getSkillVersionByRef({ workspaceId: context.workspaceId, skillId, version })
        : await requireRepository(store, "skillVersions").getBySkillRef(
        skillId,
        version,
        options,
      );
      if (!published) throw storeError("skill_not_found", "Skill not found.", { skillId });
      await requireSkillAccess({
        skillId,
        context,
        access: "execute",
        requestedSkillVersionId: published.skillVersionId,
        workspaceReleaseVersionId: skillReadModel?.getSkillReleaseAccess
          ? await skillReadModel.getSkillReleaseAccess({ workspaceId: context.workspaceId, skillId, version })
          : null,
        session,
        value: asset,
      });
      if (asset.ownerId === "system-catalog" && published.validation?.status !== "passed") {
        throw storeError("skill_not_found", "Skill not found.", { skillId });
      }
      return published;
    }
    throw storeError("skill_not_found", "Skill not found.", { skillId });
  };
  const requireWorkflowSkillReferences = async ({ graph, context, session } = {}) => {
    const refs = [...new Map(
      (graph?.nodes ?? [])
        .filter((node) => node?.kind === "Skill" && node.skillRef)
        .map((node) => [`${node.skillRef.skillId}:${node.skillRef.version}`, node.skillRef]),
    ).values()];
    for (const skillRef of refs) {
      await requireSkillReferenceAccess({ skillRef, context, session });
    }
  };
  const requireSkillVersionAccess = async ({ skillVersionId, context, session } = {}) => {
    await ready();
    const version = skillReadModel?.getSkillVersion
      ? await skillReadModel.getSkillVersion({ workspaceId: context.workspaceId, skillVersionId })
      : await requireRepository(store, "skillVersions").get(skillVersionId, {
      workspaceId: context.workspaceId,
      ...(session ? { session } : {}),
    });
    if (!version) throw storeError("skill_not_found", "Skill not found.");
    await requireSkillReferenceAccess({
      skillRef: { skillId: version.skillId, version: version.version },
      context,
      session,
    });
    return version;
  };
  const requireOwnedAgentProposal = async ({
    sessionId,
    proposalId,
    context,
    session,
    objectAccess = "read",
  } = {}) => {
    await ready();
    const proposal = agentProposalReadModel
      ? await agentProposalReadModel.getProposal({ proposalId, sessionId, workspaceId: context.workspaceId, userId: context.userId })
      : await requireRepository(store, "agentObjectProposals").get(proposalId, { workspaceId: context.workspaceId, session });
    if (
      !proposal
      || proposal.sessionId !== sessionId
      || proposal.userId !== context.userId
      || proposal.createdBy !== context.userId
    ) {
      throw storeError("agent_proposal_not_found", "Agent proposal not found.");
    }
    const agentSession = await agentTurnRunner?.getSession?.(sessionId, context);
    if (!agentSession || agentSession.scope?.branchId !== proposal.branchId) {
      throw storeError("agent_proposal_not_found", "Agent proposal not found.");
    }
    await requireAgentObjectAccess({
      objectKind: proposal.objectKind,
      objectId: proposal.objectId,
      context,
      session,
      access: objectAccess,
    });
    return proposal;
  };
  const persistAgentProposalConflicts = async ({
    proposal,
    conflicts,
    context,
    session,
  }) => {
    const createdAt = clock();
    for (const conflict of conflicts) {
      await requireRepository(store, "mergeConflicts").insert({
        schemaVersion: "workbench-v1",
        mergeConflictId: idFactory("merge-conflict"),
        workspaceId: context.workspaceId,
        proposalId: proposal.proposalId,
        objectKind: proposal.objectKind,
        objectId: proposal.objectId,
        ...conflict,
        status: "open",
        createdAt,
        resolvedAt: null,
      }, { session });
    }
    await requireRepository(store, "agentBranches").patch(
      proposal.branchId,
      { status: "conflicting", updatedAt: createdAt },
      { workspaceId: context.workspaceId, session },
    );
    return requireRepository(store, "agentObjectProposals").patch(
      proposal.proposalId,
      { status: "conflicting", decidedAt: null },
      { workspaceId: context.workspaceId, session },
    );
  };
  const projectAgentSession = async (session, { snapshotAt = null } = {}) => {
    if (
      !session
      || session.source?.kind !== "loop_run"
      || (!runner?.getRun && !runner?.getRunAt)
    ) return session;
    try {
      const value = snapshotAt && typeof runner.getRunAt === "function"
        ? await runner.getRunAt(session.source.runId, snapshotAt)
        : await runner.getRun(session.source.runId);
      return {
        ...session,
        taskStatus: projectRunTaskStatus(value?.run?.status),
      };
    } catch (error) {
      if (error?.code === "run_snapshot_changed") {
        const stale = storeError(
          "cursor_stale",
          "A Loop task changed while this Session page was being read. Restart pagination.",
          { recoveryAction: "restart_pagination" },
        );
        stale.retryable = true;
        throw stale;
      }
      throw storeError(
        "agent_task_source_unavailable",
        "The Loop task status is temporarily unavailable.",
        { runId: session.source.runId, causeCode: error?.code },
      );
    }
  };
  const projectWorkflowLatestRun = async (workflow) => {
    if (!workflow) return workflow;
    const projected = productSafeWorkflow(workflow);
    if (!runner?.listRuns) return projected;
    const runs = await runner.listRuns(workflow.workflowId, {
      limit: 1,
      sort: { updatedAt: -1, runId: 1 },
    });
    const latest = runs?.[0];
    if (!latest) {
      const { latestRun: _staleLatestRun, ...withoutLatestRun } = projected;
      return withoutLatestRun;
    }
    return {
      ...projected,
      latestRun: {
        runId: latest.runId,
        status: latest.status,
        updatedAt: latest.updatedAt,
      },
    };
  };
  const getWorkflowRevision = async (workflowId, revisionId, options = {}) => {
    await ready();
    const revision = workflowReadModel
      ? await workflowReadModel.getWorkflowRevision({
          workflowId,
          revisionId,
          workspaceId: options.workspaceId ?? workspaceId,
        })
      : await requireRepository(store, "workflowRevisions").get(workflowId, revisionId, options);
    if (!revision) throw storeError("workflow_revision_not_found", "Workflow revision not found.", { workflowId, revisionId });
    return revision;
  };
  const compileRevision = async ({ workflowId, revision, context, options = {} }) => {
    if (!agentRuntime || typeof agentRuntime.probeSkill !== "function") {
      throw storeError("agent_runtime_unavailable", "Skill readiness service is unavailable.");
    }
    await requireWorkflowSkillReferences({
      graph: revision.graph,
      context,
      session: options.session,
    });
    const refs = [...new Map(
      revision.graph.nodes.filter((node) => node.kind === "Skill")
        .map((node) => [`${node.skillRef.skillId}:${node.skillRef.version}`, node.skillRef]),
    ).values()];
    const resolved = await Promise.all(refs.map(async (ref) => {
      const pinned = await resolvePinnedSkill({
        repositories: store.repositories,
        skillRef: ref,
        workspaceId: context.workspaceId,
        options,
      });
      const definition = pinned.definition;
      const probe = definition
        ? await agentRuntime.probeSkill(definition.executionRef, { workspaceId: context.workspaceId })
        : { status: "blocked", ready: false, code: "skill_definition_not_found" };
      const readiness = readinessFromProbe(probe);
      return [`${ref.skillId}:${ref.version}`, {
        definition,
        adapterReadiness: readiness,
        piReadiness: readiness,
        toolActions: (pinned.skillVersion?.manifest?.tools ?? [])
          .map((tool) => tool?.action)
          .filter((action) => typeof action === "string"),
      }];
    }));
    const byRef = new Map(resolved);
    const resourceEntries = await Promise.all((revision.resourceRefs ?? []).map(async (ref) => [
      `${ref.resourceId}:${ref.version}`,
      await requireRepository(store, "resources").get(ref.resourceId, { workspaceId: context.workspaceId, ...options }),
    ]));
    const resources = new Map(resourceEntries);
    const routingPolicy = await modelCatalog?.getWorkspacePolicy?.(context.workspaceId, { userId: context.userId }) ?? null;
    const workspaceSelections = {
      agentControllerModelProfileId: routingPolicy?.defaultProfileIdsByCapability?.tool_calling
        ?? routingPolicy?.defaultProfileIdsByCapability?.chat,
      imageGenerationModelProfileId: routingPolicy?.defaultProfileIdsByCapability?.image_generation,
      workflowFallbackAllowed: routingPolicy?.workflowFallbackAllowed === true,
    };
    const modelResolutionByNode = new Map();
    if (modelCatalog) {
      await Promise.all(revision.graph.nodes.filter((node) => node.kind === "Skill").map(async (node) => {
        const skill = byRef.get(`${node.skillRef.skillId}:${node.skillRef.version}`)?.definition;
        const executionMode = skill?.executionRef?.executionMode;
        if (!skill || !["agent", "orchestrator", "model"].includes(executionMode)) return;
        const modelCapability = executionMode === "model"
          ? skill.executionRef.requiredModelCapability
          : "tool_calling";
        const requiredCapabilities = executionMode === "model"
          ? [modelCapability]
          : ["chat", "tool_calling"];
        const profileId = node.configuration?.modelProfileId
          ?? (modelCapability === "image_generation"
            ? revision.runSettings?.imageGenerationModelProfileId ?? workspaceSelections.imageGenerationModelProfileId
            : revision.runSettings?.agentControllerModelProfileId ?? workspaceSelections.agentControllerModelProfileId);
        if (!profileId) return;
        try {
          const resolvedModel = await modelCatalog.resolveCurrentProfile({
            profileId,
            workspaceId: context.workspaceId,
            userId: context.userId,
            capabilities: requiredCapabilities,
            requireReady: true,
          });
          modelResolutionByNode.set(node.nodeId, {
            profileId,
            revision: {
              revisionId: resolvedModel.revision.revisionId,
              capabilities: clone(resolvedModel.revision.capabilities),
              protocol: resolvedModel.revision.protocol,
              limits: clone(resolvedModel.revision.limits ?? {}),
            },
            fallbackRevisions: [],
          });
        } catch (error) {
          modelResolutionByNode.set(node.nodeId, {
            errorCode: compileModelRouteErrorCode(error?.code),
          });
        }
      }));
    }
    const compileResult = compileWorkflowV1(clone(revision), {
      compiledAt: clock(),
      modelSelections: workspaceSelections,
      modelResolver({ nodeId }) {
        const route = modelResolutionByNode.get(nodeId) ?? null;
        if (route?.errorCode) throw new TypeError(route.errorCode);
        return route;
      },
      resolver: {
        resolveSkill(ref) { return byRef.get(`${ref.skillId}:${ref.version}`) ?? null; },
        resolveResource(ref) {
          const resource = resources.get(`${ref.resourceId}:${ref.version}`);
          if (!resource || resource.version !== ref.version || resource.readiness?.status !== "ready") {
            return { readiness: { status: "blocked", reason: "Attached material is not ready to use." } };
          }
          return { readiness: { status: "ready" } };
        },
      },
    });
    await requireRepository(store, "compileResults").insert(clone(compileResult), options);
    if (compileResult.status === "ready") {
      await requireRepository(store, "executionPlans").insert(idFactory("plan"), clone(compileResult.executionPlan), options);
    }
    await requireRepository(store, "workflows").updateCompileSummary(workflowId, {
      revisionId: revision.revisionId,
      status: compileResult.status,
      compiledAt: compileResult.compiledAt,
    }, options);
    return compileResult;
  };

  const proposalInvocationId = (proposalId) => `invocation-${proposalId}`.slice(0, 128);
  const proposalAttemptId = (proposalId) => `attempt-${proposalId}-1`.slice(0, 128);
  const proposalExecutionIdentity = (proposalId, attemptNumber = 1) => ({
    invocationId: attemptNumber === 1
      ? proposalInvocationId(proposalId)
      : `${proposalInvocationId(proposalId).slice(0, 112)}-retry-${attemptNumber}`.slice(0, 128),
    attemptId: attemptNumber === 1
      ? proposalAttemptId(proposalId)
      : `${`attempt-${proposalId}`.slice(0, 116)}-${attemptNumber}`.slice(0, 128),
    attemptNumber,
  });
  const proposalProductCommandId = (proposalId) => `builder-command-${proposalId}`.slice(0, 128);
  const requireProposalExecutionBackend = async (message) => {
    const backendProbe = executionBroker.probeBackend
      ? await executionBroker.probeBackend({ mode: "bounded_agent", isolation: "container" })
      : {
          available: executionBroker.hasBackend?.({ mode: "bounded_agent", isolation: "container" }) === true,
          verified: false,
        };
    if (backendProbe.available !== true || backendProbe.verified !== true) {
      throw storeError("builder_proposal_unavailable", message);
    }
  };
  const proposalCommand = (proposalId) => ({
    schemaVersion: "workbench-v1",
    commandId: proposalProductCommandId(proposalId),
    kind: "builder_proposal",
    sessionId: `builder-${proposalId}`.slice(0, 128),
    turnId: `builder-${proposalId}`.slice(0, 128),
  });
  const proposalGenerationTarget = ({ proposalId, context, type, createdAt, request, workflowId, ifMatch }) => ({
    schemaVersion: "workbench-v1",
    kind: "builder_proposal_generation",
    proposalId,
    productCommandId: proposalProductCommandId(proposalId),
    workspaceId: context.workspaceId,
    ...(workflowId ? { workflowId } : {}),
    status: "generating",
    createdBy: context.userId,
    createdAt,
    decidedAt: null,
    generationState: {
      type,
      status: "accepted",
      requestHash: canonicalRequestHash({ request: clone(request), ifMatch: ifMatch ?? null }),
      ...proposalExecutionIdentity(proposalId),
      ...(ifMatch ? { ifMatch } : {}),
    },
  });
  const requireProposalGenerationTarget = (target, { context, type, request, workflowId, ifMatch }) => {
    const requestHash = canonicalRequestHash({ request: clone(request), ifMatch: ifMatch ?? null });
    if (
      !target
      || target.workspaceId !== context.workspaceId
      || target.createdBy !== context.userId
      || target.generationState?.type !== type
      || target.generationState?.requestHash !== requestHash
      || (workflowId && target.workflowId !== workflowId)
    ) {
      throw storeError("builder_proposal_not_found", "The suggested changes were not found.");
    }
    return target;
  };
  const isFinalProposal = (target, type) => (
    !target?.generationState
    && (type === "staged_loop_draft"
      ? target?.kind === "staged_loop_draft"
      : target?.kind === undefined)
  );
  const requireFinalProposal = (target, { context, type, workflowId }) => {
    if (
      !isFinalProposal(target, type)
      || target.workspaceId !== context.workspaceId
      || target.createdBy !== context.userId
      || (workflowId && target.workflowId !== workflowId)
    ) {
      throw storeError("builder_proposal_not_found", "The suggested changes were not found.");
    }
    return target;
  };
  const acceptProposalGeneration = async ({ proposalId, context, type, createdAt, request, workflowId, ifMatch }) => {
    if (store.persistenceDriver === "postgres" && type === "staged_loop_draft") {
      if (!builderProposalLifecycle?.beginStagedGeneration) {
        throw storeError("builder_proposal_generation_lifecycle_unavailable", "Loop proposal generation is not available in this PostgreSQL composition.");
      }
      return builderProposalLifecycle.beginStagedGeneration({ proposalId, context, request });
    }
    if (!productCommandIntake) {
      throw storeError("builder_proposal_unavailable", "Workflow suggestions are not available yet.");
    }
    const target = proposalGenerationTarget({
      proposalId,
      context,
      type,
      createdAt,
      request,
      workflowId,
      ifMatch,
    });
    return productCommandIntake.accept({
      principal: context,
      command: proposalCommand(proposalId),
      at: createdAt,
      persistTarget: async ({ session }) => {
        const existing = await requireRepository(store, "builderProposals").get(proposalId, {
          workspaceId: context.workspaceId,
          session,
        });
        if (existing) {
          throw storeError("builder_proposal_not_found", "The suggested changes were not found.");
        }
        return requireRepository(store, "builderProposals").insert(clone(target), { session });
      },
      loadTarget: async ({ session }) => requireProposalGenerationTarget(
        await requireRepository(store, "builderProposals").get(proposalId, {
          workspaceId: context.workspaceId,
          session,
        }),
        { context, type, request, workflowId, ifMatch },
      ),
    });
  };
  const startProposalGeneration = ({ proposalId, context, type, request, workflowId, ifMatch }) => (
    store.persistenceDriver === "postgres" && type === "staged_loop_draft"
      ? (async () => {
          if (!builderProposalLifecycle?.startGeneration) {
            throw storeError("builder_proposal_generation_lifecycle_unavailable", "Loop proposal generation is not available in this PostgreSQL composition.");
          }
          const started = await builderProposalLifecycle.startGeneration({ proposalId, context });
          return { command: started.command, executionIdentity: started.execution };
        })()
      :
    store.withTransaction(async (session) => {
      const target = requireProposalGenerationTarget(
        await requireRepository(store, "builderProposals").get(proposalId, {
          workspaceId: context.workspaceId,
          session,
        }),
        { context, type, request, workflowId, ifMatch },
      );
      const command = await productCommandIntake.recover({
        principal: context,
        commandId: proposalProductCommandId(proposalId),
        session,
      });
      if (!command) {
        throw storeError("builder_proposal_not_found", "The suggested changes were not found.");
      }
      const executionIdentity = ["failed", "blocked"].includes(command.status)
        ? proposalExecutionIdentity(proposalId, (target.generationState.attemptNumber ?? 1) + 1)
        : {
            invocationId: target.generationState.invocationId,
            attemptId: target.generationState.attemptId,
            attemptNumber: target.generationState.attemptNumber ?? 1,
          };
      const started = ["failed", "blocked"].includes(command.status)
        ? await productCommandIntake.resumeExternal({
            principal: context,
            commandId: command.commandId,
            invocationId: executionIdentity.invocationId,
            attemptId: executionIdentity.attemptId,
            at: clock(),
            session,
          })
        : await productCommandIntake.start({
            principal: context,
            commandId: command.commandId,
            invocationId: executionIdentity.invocationId,
            attemptId: executionIdentity.attemptId,
            at: clock(),
            session,
          });
      await requireRepository(store, "builderProposals").patch(proposalId, {
        generationState: {
          ...target.generationState,
          ...executionIdentity,
          status: "running",
          updatedAt: clock(),
        },
      }, { workspaceId: context.workspaceId, session });
      return { command: started, executionIdentity };
    })
  );
  const settleProposalCommandCompleted = async ({ proposalId, context, session, at, invocationId, attemptId }) => {
    let command = await productCommandIntake.recover({
      principal: context,
      commandId: proposalProductCommandId(proposalId),
      session,
    });
    if (!command) throw storeError("builder_proposal_not_found", "The suggested changes were not found.");
    if (command.status === "completed") return command;
    if (command.status === "accepted") {
      command = await productCommandIntake.start({
        principal: context,
        commandId: command.commandId,
        invocationId: invocationId ?? command.invocationId ?? proposalInvocationId(proposalId),
        attemptId: attemptId ?? command.attemptId ?? proposalAttemptId(proposalId),
        at,
        session,
      });
    } else if (["failed", "blocked"].includes(command.status)) {
      command = await productCommandIntake.resumeExternal({
        principal: context,
        commandId: command.commandId,
        invocationId: invocationId ?? command.invocationId ?? proposalInvocationId(proposalId),
        attemptId: attemptId ?? command.attemptId ?? proposalAttemptId(proposalId),
        at,
        session,
      });
    }
    return productCommandIntake.settle({
      principal: context,
      commandId: command.commandId,
      status: "completed",
      at,
      session,
    });
  };
  const reconcileFinalProposal = ({ proposalId, context, type, workflowId }) => (
    store.withTransaction(async (session) => {
      const proposal = requireFinalProposal(
        await requireRepository(store, "builderProposals").get(proposalId, {
          workspaceId: context.workspaceId,
          session,
        }),
        { context, type, workflowId },
      );
      await settleProposalCommandCompleted({
        proposalId,
        context,
        session,
        at: clock(),
      });
      return proposal;
    })
  );
  const settleProposalGenerationFailure = ({ proposalId, context, type, request, workflowId, ifMatch, status, cause }) => (
    store.persistenceDriver === "postgres" && type === "staged_loop_draft"
      ? builderProposalLifecycle?.failStagedGeneration?.({ proposalId, context, status })
      :
    store.withTransaction(async (session) => {
      const target = requireProposalGenerationTarget(
        await requireRepository(store, "builderProposals").get(proposalId, {
          workspaceId: context.workspaceId,
          session,
        }),
        { context, type, request, workflowId, ifMatch },
      );
      await requireRepository(store, "builderProposals").patch(proposalId, {
        generationState: {
          ...target.generationState,
          status,
          updatedAt: clock(),
          ...(typeof cause?.code === "string" ? { failureCode: cause.code } : {}),
        },
      }, { workspaceId: context.workspaceId, session });
      await productCommandIntake.settle({
        principal: context,
        commandId: proposalProductCommandId(proposalId),
        status,
        at: clock(),
        session,
      });
    })
  );
  const completedProposalExecution = async ({ proposalId, workspaceId, invocationId }) => {
    if (typeof executionBroker?.getInvocation !== "function") return null;
    const invocation = await executionBroker.getInvocation(invocationId ?? proposalInvocationId(proposalId));
    if (!invocation) return null;
    if (invocation.workspaceId !== workspaceId) {
      throw storeError("builder_proposal_not_found", "The suggested changes were not found.");
    }
    if (invocation.result?.status !== "completed") return null;
    return invocation;
  };
  const persistStagedProposal = ({ proposal, context, request }) => {
    if (store.persistenceDriver === "postgres") {
      if (!builderProposalLifecycle?.completeStagedGeneration) {
        throw storeError("builder_proposal_generation_lifecycle_unavailable", "Loop proposal generation is not available in this PostgreSQL composition.");
      }
      return builderProposalLifecycle.completeStagedGeneration({
        proposalId: proposal.proposalId,
        context,
        result: {
          invocationId: proposal.invocationId,
          attemptId: proposalAttemptId(proposal.proposalId),
          summary: proposal.summary,
          draft: proposal.draft,
          operations: proposal.operations,
          diagnostics: proposal.diagnostics,
          permissionImpact: proposal.permissionImpact,
        },
      }).then(({ proposal: completed }) => completed);
    }
    return store.withTransaction(async (session) => {
    const target = requireProposalGenerationTarget(
      await requireRepository(store, "builderProposals").get(proposal.proposalId, {
        workspaceId: context.workspaceId,
        session,
      }),
      { context, type: "staged_loop_draft", request },
    );
    const persisted = await requireRepository(store, "builderProposals").patchAndUnset(
      proposal.proposalId,
      clone(proposal),
      ["generationState"],
      { workspaceId: context.workspaceId, session },
    );
    await requireRepository(store, "auditEvents").append({
      schemaVersion: "workbench-v1",
      auditEventId: idFactory("audit"),
      workspaceId: context.workspaceId,
      actorId: context.userId,
      action: "staged_loop_proposal.generated",
      entityKind: "builder_proposal",
      entityId: proposal.proposalId,
      createdAt: proposal.createdAt,
    }, { session });
    await settleProposalCommandCompleted({
      proposalId: proposal.proposalId,
      context,
      session,
      at: clock(),
      invocationId: target.generationState.invocationId,
      attemptId: target.generationState.attemptId,
    });
    return persisted;
    });
  };
  const stagedProposalFromExecution = ({ proposalId, execution, request, context }) => {
    const baseRevision = execution?.request?.input?.revision;
    const candidate = execution?.result?.output;
    if (
      !baseRevision
      || baseRevision.authoredBy !== context.userId
      || execution?.request?.input?.proposalId !== proposalId
    ) {
      throw storeError("builder_proposal_invalid", "The staged Loop proposal could not be recovered.");
    }
    const proposedRevision = applyBuilderOperations(baseRevision, candidate?.operations ?? []);
    const createdAt = execution.createdAt ?? execution.result?.startedAt ?? baseRevision.createdAt;
    const proposal = {
      schemaVersion: "workbench-v1",
      kind: "staged_loop_draft",
      proposalId,
      productCommandId: execution.request.lineage?.productCommandId,
      invocationId: execution.request.invocationId,
      workspaceId: context.workspaceId,
      summary: candidate?.summary,
      draft: {
        name: request.data.name,
        description: proposedRevision.definition?.expectedResult || request.data.definition.goal,
        definition: clone(proposedRevision.definition ?? request.data.definition),
        graph: clone(proposedRevision.graph),
        inputForm: clone(proposedRevision.inputForm),
        outputDefinition: clone(proposedRevision.outputDefinition),
        resourceRefs: clone(proposedRevision.resourceRefs),
        runSettings: clone(proposedRevision.runSettings),
      },
      operations: clone(candidate?.operations ?? []),
      diagnostics: clone(candidate?.diagnostics ?? []),
      permissionImpact: clone(candidate?.permissionImpact ?? []),
      status: candidate?.diagnostics?.some((diagnostic) => diagnostic.severity === "error") ? "invalid" : "proposed",
      createdBy: context.userId,
      createdAt,
      expiresAt: proposalExpiry(createdAt),
      decidedAt: null,
    };
    if (!Check(StagedLoopProposalSchema, proposal)) {
      throw storeError("builder_proposal_invalid", "The staged Loop proposal could not be verified.");
    }
    return proposal;
  };
  const authorizedArtifactScopes = async ({ artifactId, context }) => {
    if (!artifactService?.getAuthorizationDescriptor) return [];
    const descriptor = await artifactService.getAuthorizationDescriptor({
      workspaceId: context.workspaceId,
      artifactId,
    });
    if (descriptor.ownerUserId === context.userId) return [];
    const explicitlySharedScopes = workItemLifecycle?.authorizedArtifactScopes
      ? await workItemLifecycle.authorizedArtifactScopes({
        workspaceId: context.workspaceId,
        userId: context.userId,
        artifactId,
      })
      : [];
    if (explicitlySharedScopes.length > 0) return explicitlySharedScopes;
    const scope = descriptor.objectScope;
    if (scope?.objectKind === "agent_session") {
      const session = await agentTurnRunner?.getSession?.(scope.objectId, context);
      if (!session) throw storeError("artifact_not_found", "The requested artifact was not found.");
      return [scope];
    }
    if (scope?.objectKind === "workflow_run") {
      try {
        const run = await runner?.getRun?.(scope.objectId);
        if (!run?.run?.workflowId) throw new Error("run_not_found");
        await requireWorkflowAccess({ workflowId: run.run.workflowId, context, access: "read" });
      } catch {
        throw storeError("artifact_not_found", "The requested artifact was not found.");
      }
      return [scope];
    }
    throw storeError("artifact_not_found", "The requested artifact was not found.");
  };

  return Object.freeze({
    async bootstrapSession({ testIdentity } = {}) {
      const nextUserId = testIdentity?.userId ?? userId;
      const nextWorkspaceId = testIdentity?.workspaceId ?? workspaceId;
      if (typeof store.ensurePrivateWorkspace === "function") {
        await store.ensurePrivateWorkspace({ userId: nextUserId, workspaceId: nextWorkspaceId });
      }
      return { userId: nextUserId, workspaceId: nextWorkspaceId };
    },
    async workspace({ auth } = {}) {
      const context = await resolveAuth(auth);
      const now = clock();
      await ready();
      const stored = workspaceReadModel
        ? await workspaceReadModel.getWorkspace({ workspaceId: context.workspaceId })
        : await requireRepository(store, "workspaces").get(context.workspaceId);
      return {
        workspace: {
          workspaceId: context.workspaceId,
          name: stored?.name ?? "Local workspace",
          capabilities: {
            builderProposal: Boolean(agentProposalService),
            resources: Boolean(textResourceService?.list),
            maxParallelism: 1,
          },
          createdAt: stored?.createdAt ?? now,
          updatedAt: stored?.updatedAt ?? now,
        },
      };
    },
    async getWorkspaceFeatureReadiness({ auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      const result = await evaluateWorkspaceFeatureReadiness({
        context,
        store,
        clock,
        skillUploadService,
        serverSkillImportService,
        skillRuntimeCatalog,
        skillValidationService,
        registeredToolCatalog,
        textResourceService,
        inputAttachmentService,
        connectionDriverRegistry,
        executionBroker,
        admissionController,
        modelCatalog,
        skillDraftLifecycle,
        loopDraftLifecycle,
        connectionService: readinessConnectionService,
      });
      return {
        ...result,
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async getActiveSession({ auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      const active = workspaceReadModel
        ? await workspaceReadModel.getActiveSession({ workspaceId: context.workspaceId, userId: context.userId })
        : null;
      const [workspace, membership] = active
        ? [active.workspace, active.membership]
        : await Promise.all([
          requireRepository(store, "workspaces").get(context.workspaceId),
          requireRepository(store, "memberships").get(context.workspaceId, context.userId),
        ]);
      if (!workspace || !membership) {
        throw storeError("workspace_access_forbidden", "You do not have access to this workspace.");
      }
      return {
        session: {
          schemaVersion: "workbench-v1",
          sessionId: auth?.sessionId ?? `session-${context.userId}`,
          userId: context.userId,
          activeWorkspaceId: context.workspaceId,
          expiresAt: auth?.expiresAt ?? clock(),
        },
        workspace,
        membership,
      };
    },
    async getObject({ objectId, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      const object = objectReadModel
        ? await objectReadModel.getObject({ workspaceId: context.workspaceId, objectId })
        : await requireRepository(store, "objects").get(objectId, {
          workspaceId: context.workspaceId,
        });
      if (!object) throw storeError("object_not_found", "The stored object was not found.");
      return object;
    },
    async listScopes({ auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      if (!automationLifecycle?.listScopes) {
        throw storeError("automation_lifecycle_unavailable", "Scope policy management is unavailable.");
      }
      return {
        ...resultPage(await automationLifecycle.listScopes({ context })),
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async getScope({ scopeId, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      if (!automationLifecycle?.getScope) {
        throw storeError("automation_lifecycle_unavailable", "Scope policy management is unavailable.");
      }
      const value = await automationLifecycle.getScope({ scopeId, context });
      return {
        ...value,
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async reviseScopePolicy({ scopeId, idempotencyKey, ifMatch, request, auth } = {}) {
      const context = await resolveAuth(auth, "admin");
      await ready();
      if (!automationLifecycle?.reviseScopePolicy) {
        throw storeError("automation_lifecycle_unavailable", "Scope policy management is unavailable.");
      }
      const value = await automationLifecycle.reviseScopePolicy({
        scopeId, idempotencyKey, ifMatch, request, context,
      });
      return {
        ...value,
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async listAutomations({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      if (!automationLifecycle?.listAutomations) {
        throw storeError("automation_lifecycle_unavailable", "Automation management is unavailable.");
      }
      return {
        ...resultPage(await automationLifecycle.listAutomations({ query, context })),
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async listAutomationCandidates({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth, "admin");
      await ready();
      if (!automationLifecycle?.listCandidates) {
        throw storeError("automation_lifecycle_unavailable", "Automation management is unavailable.");
      }
      return {
        ...resultPage(await automationLifecycle.listCandidates({ query, context })),
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async getAutomation({ automationId, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      if (!automationLifecycle?.getAutomation) {
        throw storeError("automation_lifecycle_unavailable", "Automation management is unavailable.");
      }
      const value = await automationLifecycle.getAutomation({ automationId, context });
      return {
        ...value,
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async createAutomation({ idempotencyKey, request, auth } = {}) {
      const context = await resolveAuth(auth, "admin");
      await ready();
      if (!automationLifecycle?.createAutomation) {
        throw storeError("automation_lifecycle_unavailable", "Automation management is unavailable.");
      }
      const value = await automationLifecycle.createAutomation({ idempotencyKey, request, context });
      return {
        ...value,
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async reviseAutomation({ automationId, idempotencyKey, ifMatch, request, auth } = {}) {
      const context = await resolveAuth(auth, "admin");
      await ready();
      if (!automationLifecycle?.reviseAutomation) {
        throw storeError("automation_lifecycle_unavailable", "Automation management is unavailable.");
      }
      const value = await automationLifecycle.reviseAutomation({
        automationId, idempotencyKey, ifMatch, request, context,
      });
      return {
        ...value,
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async activateAutomation({ automationId, idempotencyKey, ifMatch, auth } = {}) {
      const context = await resolveAuth(auth, "admin");
      await ready();
      if (!automationLifecycle?.activateAutomation) {
        throw storeError("automation_lifecycle_unavailable", "Automation management is unavailable.");
      }
      const value = await automationLifecycle.activateAutomation({
        automationId, idempotencyKey, ifMatch, context,
      });
      return {
        ...value,
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async pauseAutomation({ automationId, idempotencyKey, ifMatch, auth } = {}) {
      const context = await resolveAuth(auth, "admin");
      await ready();
      if (!automationLifecycle?.pauseAutomation) {
        throw storeError("automation_lifecycle_unavailable", "Automation management is unavailable.");
      }
      const value = await automationLifecycle.pauseAutomation({
        automationId, idempotencyKey, ifMatch, context,
      });
      return {
        ...value,
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async archiveAutomation({ automationId, idempotencyKey, ifMatch, auth } = {}) {
      const context = await resolveAuth(auth, "admin");
      await ready();
      if (!automationLifecycle?.archiveAutomation) {
        throw storeError("automation_lifecycle_unavailable", "Automation management is unavailable.");
      }
      const value = await automationLifecycle.archiveAutomation({
        automationId, idempotencyKey, ifMatch, context,
      });
      return {
        ...value,
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async listAutomationOccurrences({ automationId, query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      if (!automationLifecycle?.listOccurrences) {
        throw storeError("automation_lifecycle_unavailable", "Automation management is unavailable.");
      }
      return {
        ...resultPage(await automationLifecycle.listOccurrences({ automationId, query, context })),
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async listDevices({ auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      if (!deviceLifecycle?.listDevices) {
        throw storeError("device_lifecycle_unavailable", "Device management is unavailable.");
      }
      return {
        ...resultPage(await deviceLifecycle.listDevices({ context })),
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async getDevice({ deviceId, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      if (!deviceLifecycle?.getDevice) {
        throw storeError("device_lifecycle_unavailable", "Device management is unavailable.");
      }
      const value = await deviceLifecycle.getDevice({ deviceId, context });
      return {
        ...(value?.data === undefined ? { data: value } : value),
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async createMemberAgentRequest(input) {
      const context = await resolveAuth(input.auth, "member"); await ready();
      if (!memberAgentService) throw storeError("member_agent_unavailable");
      return {data:await memberAgentService.create({...input,context}), responseHeaders:{"Cache-Control":"private, no-store"}};
    },
    async listMemberAgentRequests(input) {
      const context = await resolveAuth(input.auth, "member"); await ready();
      if (!memberAgentService) throw storeError("member_agent_unavailable");
      return {data:await memberAgentService.list({...input,context}), responseHeaders:{"Cache-Control":"private, no-store"}};
    },
    async getMemberAgentRequest(input) {
      const context = await resolveAuth(input.auth, "member"); await ready();
      if (!memberAgentService) throw storeError("member_agent_unavailable");
      return {data:await memberAgentService.get({...input,context}), responseHeaders:{"Cache-Control":"private, no-store"}};
    },
    async acceptMemberAgentRequest(input) {
      const context = await resolveAuth(input.auth, "member"); await ready();
      if (!memberAgentService) throw storeError("member_agent_unavailable");
      return {data:await memberAgentService.accept({...input,context}), responseHeaders:{"Cache-Control":"private, no-store"}};
    },
    async checkMemberAgentExecution(input) {
      const context = await resolveAuth(input.auth, "member"); await ready();
      if (!memberAgentService) throw storeError("member_agent_unavailable");
      return {data:await memberAgentService.check({...input,context}), responseHeaders:{"Cache-Control":"private, no-store"}};
    },
    async deliverMemberAgentOutput(input) {
      const context = await resolveAuth(input.auth, "member"); await ready();
      if (!memberAgentService) throw storeError("member_agent_unavailable");
      return {data:await memberAgentService.deliver({...input,context}), responseHeaders:{"Cache-Control":"private, no-store"}};
    },
    async declineMemberAgentRequest(input) {
      const context = await resolveAuth(input.auth, "member"); await ready();
      if (!memberAgentService) throw storeError("member_agent_unavailable");
      return {data:await memberAgentService.decide({...input,context}, "decline"), responseHeaders:{"Cache-Control":"private, no-store"}};
    },
    async cancelMemberAgentRequest(input) {
      const context = await resolveAuth(input.auth, "member"); await ready();
      if (!memberAgentService) throw storeError("member_agent_unavailable");
      return {data:await memberAgentService.decide({...input,context}, "cancel"), responseHeaders:{"Cache-Control":"private, no-store"}};
    },
    async registerDevice({ idempotencyKey, request, auth } = {}) {
      const context = await resolveAuth(auth, "member");
      await ready();
      if (!deviceLifecycle?.registerDevice) {
        throw storeError("device_lifecycle_unavailable", "Device management is unavailable.");
      }
      if (context.clientKind !== "desktop" || !context.clientSessionId) {
        throw storeError("device_native_session_required", "A Desktop native session is required to register a device.");
      }
      const value = await runIdempotentMutation({
        scope: `register-device:${context.userId}:${context.clientSessionId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => deviceLifecycle.registerDevice({
        request: clone(request),
        context,
        transactionSession,
      }));
      return { ...value, responseHeaders: { "Cache-Control": "private, no-store" } };
    },
    async heartbeatDevice({ deviceId, idempotencyKey, request, auth } = {}) {
      const context = await resolveAuth(auth, "member");
      await ready();
      if (!deviceLifecycle?.heartbeatDevice) {
        throw storeError("device_lifecycle_unavailable", "Device management is unavailable.");
      }
      if (context.clientKind !== "desktop" || !context.clientSessionId) {
        throw storeError("device_native_session_required", "A Desktop native session is required to report device health.");
      }
      const value = await runIdempotentMutation({
        scope: `heartbeat-device:${context.userId}:${context.clientSessionId}:${deviceId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => deviceLifecycle.heartbeatDevice({
        deviceId,
        request: clone(request),
        context,
        transactionSession,
      }));
      return { ...value, responseHeaders: { "Cache-Control": "private, no-store" } };
    },
    async revokeDevice({ deviceId, idempotencyKey, request, auth } = {}) {
      const context = await resolveAuth(auth, "admin");
      await ready();
      if (!deviceLifecycle?.revokeDevice) {
        throw storeError("device_lifecycle_unavailable", "Device management is unavailable.");
      }
      const value = await runIdempotentMutation({
        scope: `revoke-device:${context.userId}:${deviceId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => deviceLifecycle.revokeDevice({
        deviceId,
        request: clone(request),
        context,
        transactionSession,
      }));
      // A Device revoke invalidates its native session in the same durable
      // mutation. Only after the enclosing idempotency transaction commits do
      // we close an outbound Worker socket; otherwise a failed transaction
      // could disconnect a still-authoritative Device.
      await deviceLifecycle.notifyCommittedDeviceRevocation?.({
        deviceId: value?.data?.deviceId ?? deviceId,
        workspaceId: context.workspaceId,
        ownerUserId: value?.data?.ownerUserId,
      });
      return { ...value, responseHeaders: { "Cache-Control": "private, no-store" } };
    },
    async listAgentDefinitions({ auth } = {}) {
      await resolveAuth(auth);
      return resultPage(listBuiltinAgentDefinitions());
    },
    async createModelProfile({ request, idempotencyKey, auth } = {}) {
      const context = await resolveAuth(auth, "admin");
      await ready();
      if (!modelConfiguration?.create) throw storeError("model_configuration_unavailable", "Model configuration requires a mounted Secret Store.");
      const value = await runIdempotentMutation({
        scope: `create-model-profile:${context.userId}`, key: idempotencyKey, request: clone(request),
        workspaceId: context.workspaceId, effectivePrincipalId: context.userId,
      }, (transactionSession) => modelConfiguration.create({ context, request: clone(request), transactionSession }));
      return { ...value, responseHeaders: { "Cache-Control": "private, no-store" } };
    },
    async listModelProfiles({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      if (!modelCatalog?.listProfiles) {
        throw storeError("model_catalog_unavailable", "The governed model catalog is unavailable.");
      }
      const capabilities = typeof query.capabilities === "string" ? query.capabilities.split(",") : [];
      const items = await modelCatalog.listProfiles({
        workspaceId: context.workspaceId,
        userId: context.userId,
        capabilities,
        includeDisabled: true,
      });
      const filtered = items.filter((profile) => (
        (!query.profileId || profile.profileId === query.profileId)
        && (!query.readiness || profile.readiness === query.readiness)
        && (!query.selectedRevisionId || profile.currentRevisionId === query.selectedRevisionId || profile.selectable)
      ));
      const cursor = decodeModelCatalogCursor(query.cursor);
      const remaining = cursor
        ? filtered.filter((profile) => (
          profile.displayName > cursor.displayName
          || (profile.displayName === cursor.displayName && profile.profileId > cursor.profileId)
        ))
        : filtered;
      const limit = Math.max(1, Math.min(Number(query.limit) || 100, 100));
      const pageItems = remaining.slice(0, limit);
      const hasMore = remaining.length > limit;
      return resultPage({
        data: pageItems,
        page: {
          nextCursor: hasMore ? encodeModelCatalogCursor(pageItems.at(-1)) : null,
          hasMore,
        },
      });
    },
    async listSkillRuntimes({ auth } = {}) {
      await resolveAuth(auth);
      return resultPage(Array.isArray(skillRuntimeCatalog)
        ? skillRuntimeCatalog.map(clone)
        : []);
    },
    async listRegisteredToolPackages({ auth } = {}) {
      await resolveAuth(auth);
      return resultPage(Array.isArray(registeredToolCatalog)
        ? registeredToolCatalog.map(clone)
        : []);
    },
    async scaffoldSkillDraftPackage({ request, auth } = {}) {
      await resolveAuth(auth, "member");
      return scaffoldGovernedSkillDraftPackage({
        data: request.data,
        runtimeCatalog: skillRuntimeCatalog,
      });
    },
    async createAgentSession({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!agentTurnRunner) throw storeError("agent_turn_runner_unavailable", "Agent session service is unavailable.");
      await requireAgentObjectAccess({
        objectKind: request.data.objectKind,
        objectId: request.data.objectId,
        context,
      });
      const modelProfileId = request.data.lastUsedModelProfileId ?? null;
      if (modelProfileId) {
        if (!modelCatalog?.resolveCurrentProfile) {
          throw storeError("model_catalog_unavailable", "The governed model catalog is unavailable.");
        }
        await modelCatalog.resolveCurrentProfile({
          profileId: modelProfileId,
          workspaceId: context.workspaceId,
          userId: context.userId,
          capabilities: [],
          requireReady: false,
        });
      }
      const session = await runIdempotentMutation({
        scope: `create-agent-session:${context.userId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => agentTurnRunner.createSession({
        ...request.data,
        ...(modelProfileId ? { lastUsedModelProfileId: modelProfileId } : {}),
        userId: context.userId,
        workspaceId: context.workspaceId,
        transactionSession,
      }));
      return projectAgentSession(session);
    },
    async listAgentSessions({ query = {}, auth }) {
      const context = await resolveAuth(auth);
      if (!agentTurnRunner?.listSessions) {
        throw storeError("agent_turn_runner_unavailable", "Agent session service is unavailable.");
      }
      const requestedLimit = Math.min(Math.max(Number(query.limit) || 100, 1), 200);
      const projected = [];
      let cursor = query.cursor ?? null;
      do {
        const sessions = await agentTurnRunner.listSessions({
          definitionId: query.definitionId,
          taskStatus: query.taskStatus,
          search: query.search,
          archived: query.archived ?? false,
          projectLoopTaskStatus: Boolean(query.taskStatus),
          cursor,
          limit: requestedLimit - projected.length,
        }, context);
        const candidates = await Promise.all((sessions ?? []).map((session) => projectAgentSession(
          session,
          { snapshotAt: sessions?.page?.snapshotAt ?? null },
        )));
        projected.push(...candidates.filter((session) => (
          !query.taskStatus || session.taskStatus === query.taskStatus
        )));
        cursor = sessions?.page?.nextCursor ?? null;
      } while (projected.length < requestedLimit && cursor);
      Object.defineProperty(projected, "page", {
        enumerable: false,
        value: { nextCursor: cursor, hasMore: Boolean(cursor) },
      });
      return resultPage(projected);
    },
    async updateAgentSession({ sessionId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!agentTurnRunner?.updateSession) {
        throw storeError("agent_turn_runner_unavailable", "Agent session service is unavailable.");
      }
      const session = await runIdempotentMutation({
        scope: `update-agent-session:${context.userId}:${sessionId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => agentTurnRunner.updateSession({
        sessionId,
        ...request.data,
        ...context,
        transactionSession,
      }));
      return projectAgentSession(session);
    },
    async selectAgentSessionModel({ sessionId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!agentTurnRunner?.selectModel) throw storeError("agent_turn_runner_unavailable", "Agent session service is unavailable.");
      if (!modelCatalog?.resolveCurrentProfile) {
        throw storeError("model_catalog_unavailable", "The governed model catalog is unavailable.");
      }
      await modelCatalog.resolveCurrentProfile({
        profileId: request.data.modelProfileId,
        workspaceId: context.workspaceId,
        userId: context.userId,
        capabilities: [],
        requireReady: false,
      });
      return runIdempotentMutation({
        scope: `select-agent-session-model:${sessionId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, () => agentTurnRunner.selectModel({
        sessionId,
        lastUsedModelProfileId: request.data.modelProfileId,
        ...context,
      }));
    },
    async getAgentSession({ sessionId, auth }) {
      const context = await resolveAuth(auth);
      const session = await agentTurnRunner?.getSession(sessionId, context);
      if (!session) throw storeError("agent_session_not_found", "Agent session not found.");
      return projectAgentSession(session);
    },
    async promoteAgentSessionToWorkItem({ sessionId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!workItemLifecycle?.promote) {
        throw storeError("work_item_promotion_unavailable", "Work Item promotion is temporarily unavailable.");
      }
      return runIdempotentMutation({
        scope: `promote-agent-session-to-work-item:${context.userId}:${sessionId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => workItemLifecycle.promote({
        sessionId,
        request: clone(request.data),
        context,
        transactionSession,
      }));
    },
    async listProjectFiles({ projectId, query = {}, auth }) {
      const context = await resolveAuth(auth);
      if (!workItemLifecycle?.listProjectFiles) throw storeError("project_files_unavailable");
      return { ...await workItemLifecycle.listProjectFiles({ projectId, query, context }), responseHeaders: { "Cache-Control": "no-store" } };
    },
    async readProjectFile({ projectId, revisionId, auth }) {
      const context = await resolveAuth(auth);
      if (!workItemLifecycle?.readProjectFile) throw storeError("project_files_unavailable");
      return { ...await workItemLifecycle.readProjectFile({ projectId, revisionId, context }), responseHeaders: { "Cache-Control": "no-store" } };
    },
    async commitProjectFile({ projectId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!workItemLifecycle?.commitProjectFile) throw storeError("project_files_unavailable");
      const value = await runIdempotentMutation({ scope: `project-file-commit:${projectId}`, key: idempotencyKey,
        request: clone(request), workspaceId: context.workspaceId, effectivePrincipalId: context.userId,
        authorize: transactionSession => workItemLifecycle.requireProjectFileWriteAccess({ projectId, context, transactionSession }),
      }, transactionSession => workItemLifecycle.commitProjectFile({ projectId, request: clone(request), context, transactionSession }));
      // Prior ordinary-file receipts predate the explicit tombstone flag.
      if (value.data?.revision && value.data.revision.deleted === undefined) value.data.revision.deleted = false;
      return { ...value, responseHeaders: { "Cache-Control": "no-store" } };
    },
    async listProjects({ query = {}, auth }) {
      const context = await resolveAuth(auth);
      if (!workItemLifecycle?.listProjects) {
        throw storeError("team_work_unavailable", "Project collaboration is temporarily unavailable.");
      }
      return {
        ...resultPage(await workItemLifecycle.listProjects({ context, query })),
        responseHeaders: { "Cache-Control": "no-store" },
      };
    },
    async createProject({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "admin");
      if (!workItemLifecycle?.createProject) {
        throw storeError("team_work_unavailable", "Project collaboration is temporarily unavailable.");
      }
      const value = await runIdempotentMutation({
        scope: `create-project:${context.userId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
        authorize: transactionSession => workItemLifecycle.requireProjectCreateAccess({ context, transactionSession }),
      }, (transactionSession) => workItemLifecycle.createProject({
        request: clone(request),
        context,
        transactionSession,
      }));
      return { ...value, responseHeaders: { "Cache-Control": "no-store" } };
    },
    async getProject({ projectId, auth }) {
      const context = await resolveAuth(auth);
      if (!workItemLifecycle?.getProject) {
        throw storeError("team_work_unavailable", "Project collaboration is temporarily unavailable.");
      }
      const value = await workItemLifecycle.getProject({ projectId, context });
      return { ...value, responseHeaders: { "Cache-Control": "no-store" } };
    },
    async reviseProjectMembers({ projectId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!workItemLifecycle?.reviseProjectMembers) {
        throw storeError("team_work_unavailable", "Project collaboration is temporarily unavailable.");
      }
      const value = await runIdempotentMutation({
        scope: `revise-project-members:${context.userId}:${projectId}`,
        key: idempotencyKey,
        request: { request: clone(request), ifMatch },
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
        authorize: transactionSession => workItemLifecycle.requireProjectManageAccess({ projectId, context, transactionSession }),
      }, (transactionSession) => workItemLifecycle.reviseProjectMembers({
        projectId,
        ifMatch,
        request: clone(request),
        context,
        transactionSession,
      }));
      return { ...value, responseHeaders: { "Cache-Control": "no-store" } };
    },
    async listWorkItems({ query = {}, auth }) {
      const context = await resolveAuth(auth);
      if (!workItemLifecycle?.listWorkItems) {
        throw storeError("team_work_unavailable", "Team Work is temporarily unavailable.");
      }
      return {
        ...resultPage(await workItemLifecycle.listWorkItems({ context, query })),
        responseHeaders: { "Cache-Control": "no-store" },
      };
    },
    async createTeamWorkItem({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!workItemLifecycle?.createTeamWorkItem) {
        throw storeError("team_work_unavailable", "Team Work is temporarily unavailable.");
      }
      const value = await runIdempotentMutation({
        scope: `create-team-work-item:${context.userId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => workItemLifecycle.createTeamWorkItem({
        request: clone(request),
        context,
        transactionSession,
      }));
      return { ...value, responseHeaders: { "Cache-Control": "no-store" } };
    },
    async createTeamWorkItemAgentEntry({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!workItemLifecycle?.createTeamWorkItemAgentEntry) {
        throw storeError("team_work_unavailable", "Team Work Agent entry is temporarily unavailable.");
      }
      if (!agentTurnRunner) {
        throw storeError("agent_turn_runner_unavailable", "Agent turn service is unavailable.");
      }
      if (!request?.data || typeof request.data !== "object" || Array.isArray(request.data)
        || typeof request.data.modelProfileId !== "string" || !request.data.modelProfileId
        || !request.data.initialTask || typeof request.data.initialTask !== "object"
        || Array.isArray(request.data.initialTask)) {
        throw storeError("team_work_agent_entry_invalid", "The Team Work Agent entry is invalid.");
      }
      const value = await runIdempotentMutation({
        scope: `create-team-work-item-agent-entry:${context.userId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => workItemLifecycle.createTeamWorkItemAgentEntry({
        request: clone(request),
        context,
        transactionSession,
      }));
      // Scheduling is intentionally outside the transaction: the accepted
      // command, Work root, continuation and Turn are durable before Broker
      // work is visible. Calling schedule again on an idempotent replay is
      // safe and also helps recover a queued accepted Turn.
      agentTurnRunner.schedule(value.data.continuation.agentSessionId);
      return { ...value, responseHeaders: { "Cache-Control": "no-store" } };
    },
    async submitWorkItemResult({workItemId,submissionId,idempotencyKey,ifMatch,request,auth}) {
      const context=await resolveAuth(auth,"member");
      if(!workItemLifecycle?.submitWorkItemResult)throw storeError("team_work_unavailable");
      const value=await runIdempotentMutation({scope:`submitWorkItemResult:${workItemId}`,key:idempotencyKey,request:{request:clone(request),ifMatch,submissionId:submissionId??null},workspaceId:context.workspaceId,effectivePrincipalId:context.userId,
        authorize:transactionSession=>workItemLifecycle.requireResultAccess({context,workItemId,review:false,transactionSession})},
        transactionSession=>workItemLifecycle.submitWorkItemResult({context,workItemId,submissionId,request:clone(request),ifMatch,transactionSession}));
      return {...value,responseHeaders:{"Cache-Control":"no-store"}};
    },
    async reviewWorkItemResult({workItemId,submissionId,idempotencyKey,ifMatch,request,auth}) {
      const context=await resolveAuth(auth,"member");
      if(!workItemLifecycle?.reviewWorkItemResult)throw storeError("team_work_unavailable");
      const value=await runIdempotentMutation({scope:`reviewWorkItemResult:${workItemId}`,key:idempotencyKey,request:{request:clone(request),ifMatch,submissionId:submissionId??null},workspaceId:context.workspaceId,effectivePrincipalId:context.userId,
        authorize:transactionSession=>workItemLifecycle.requireResultAccess({context,workItemId,review:true,transactionSession})},
        transactionSession=>workItemLifecycle.reviewWorkItemResult({context,workItemId,submissionId,request:clone(request),ifMatch,transactionSession}));
      return {...value,responseHeaders:{"Cache-Control":"no-store"}};
    },
    async updateTeamWorkItem({ workItemId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!workItemLifecycle?.updateTeamWorkItem) {
        throw storeError("team_work_unavailable", "Team Work is temporarily unavailable.");
      }
      const value = await runIdempotentMutation({
        scope: `update-team-work-item:${context.userId}:${workItemId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => workItemLifecycle.updateTeamWorkItem({
        workItemId,
        ifMatch,
        request: clone(request),
        context,
        transactionSession,
      }));
      return { ...value, responseHeaders: { "Cache-Control": "no-store" } };
    },
    async listWorkItemPromotionParticipants({ auth }) {
      const context = await resolveAuth(auth, "member");
      if (!workItemLifecycle?.listPromotionParticipants) {
        throw storeError("work_item_promotion_participants_unavailable", "Work Item participant selection is temporarily unavailable.");
      }
      return {
        ...resultPage(await workItemLifecycle.listPromotionParticipants({ context })),
        responseHeaders: { "Cache-Control": "no-store" },
      };
    },
    async getWorkItem({ workItemId, query = {}, auth }) {
      const context = await resolveAuth(auth);
      if (!workItemLifecycle?.getWorkItem) {
        throw storeError("work_item_promotion_unavailable", "Work Item reads are temporarily unavailable.");
      }
      const value = await workItemLifecycle.getWorkItem({ workItemId, context, targetWorkItemId: query.targetWorkItemId });
      if (!value) throw storeError("work_item_not_found", "Work Item not found.");
      const workItem = value?.data ?? value;
      return {
        data: workItem,
        ...(value?.etag ? { etag: value.etag } : {}),
        responseHeaders: { "Cache-Control": "no-store" },
      };
    },
    async getWorkItemThreadEntry({workItemId,entryId,query={},auth}) {
      const context=await resolveAuth(auth);
      if(!workItemLifecycle?.getThreadEntry)throw storeError("work_item_thread_entry_unavailable");
      const entry=await workItemLifecycle.getThreadEntry({workItemId,entryId,context,targetWorkItemId:query.targetWorkItemId});
      if(!entry)throw storeError("work_item_thread_entry_not_found");
      return {data:entry,responseHeaders:{"Cache-Control":"no-store"}};
    },
    async listWorkItemThreadEntries({ workItemId, query = {}, auth }) {
      const context = await resolveAuth(auth);
      if (!workItemLifecycle?.listThreadEntries) {
        throw storeError("work_item_promotion_unavailable", "Work Item threads are temporarily unavailable.");
      }
      const entries = await workItemLifecycle.listThreadEntries({
        workItemId,
        context,
        targetWorkItemId: query.targetWorkItemId,
        cursor: query.cursor ?? null,
        limit: query.limit ?? 100,
        order: query.order ?? "asc",
      });
      if (!entries) throw storeError("work_item_not_found", "Work Item not found.");
      return {
        ...resultPage(entries),
        responseHeaders: { "Cache-Control": "no-store" },
      };
    },
    async createWorkItemThreadComment({ workItemId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!workItemLifecycle?.createThreadComment) {
        throw storeError("work_item_thread_entry_unavailable", "Work Item thread comments are temporarily unavailable.");
      }
      // A previously accepted receipt is still private Work Item content. Revocation must
      // take effect before the idempotency cache can return that receipt to a former member.
      if (!await workItemLifecycle.getWorkItem({ workItemId, context })) {
        throw storeError("work_item_not_found", "Work Item not found.");
      }
      const entry = await runIdempotentMutation({
        scope: `create-work-item-thread-comment:${context.userId}:${workItemId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
        authorize: transactionSession => workItemLifecycle.requireThreadCommentAccess({workItemId,request:clone(request.data),context,transactionSession}),
      }, (transactionSession) => workItemLifecycle.createThreadComment({
        workItemId,
        request: clone(request.data),
        context,
        transactionSession,
      }));
      return {
        data: entry,
        responseHeaders: { "Cache-Control": "no-store" },
      };
    },
    async recordWorkItemDecision({ workItemId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!workItemLifecycle?.recordDecision) {
        throw storeError("work_item_decision_unavailable", "Work Item decisions are temporarily unavailable.");
      }
      const decision = await runIdempotentMutation({
        scope: `record-work-item-decision:${context.userId}:${workItemId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => workItemLifecycle.recordDecision({
        workItemId,
        request: clone(request.data),
        context,
        transactionSession,
      }));
      return {
        data: decision,
        responseHeaders: { "Cache-Control": "no-store" },
      };
    },
    async createWorkItemContinuation({ workItemId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!workItemLifecycle?.createContinuation) {
        throw storeError("work_item_continuation_unavailable", "Work Item continuation is temporarily unavailable.");
      }
      const continuation = await runIdempotentMutation({
        scope: `create-work-item-continuation:${context.userId}:${workItemId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => workItemLifecycle.createContinuation({
        workItemId,
        context,
        transactionSession,
      }));
      return {
        data: continuation,
        responseHeaders: { "Cache-Control": "no-store" },
      };
    },
    async createWorkItemContinuationAgentEntry({ workItemId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!workItemLifecycle?.createContinuationAgentEntry) {
        throw storeError("work_item_continuation_unavailable", "Work Item continuation entry is temporarily unavailable.");
      }
      if (!agentTurnRunner) {
        throw storeError("agent_turn_runner_unavailable", "Agent turn service is unavailable.");
      }
      if (!request?.data || typeof request.data !== "object" || Array.isArray(request.data)
        || typeof request.data.modelProfileId !== "string" || !request.data.modelProfileId
        || !request.data.initialTask || typeof request.data.initialTask !== "object"
        || Array.isArray(request.data.initialTask)) {
        throw storeError("work_item_continuation_agent_entry_invalid", "The Work Item continuation entry is invalid.");
      }
      const value = await runIdempotentMutation({
        scope: `create-work-item-continuation-agent-entry:${context.userId}:${workItemId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => workItemLifecycle.createContinuationAgentEntry({
        workItemId,
        context,
        modelProfileId: request.data.modelProfileId,
        input: clone(request.data.initialTask),
        transactionSession,
      }));
      const entry = value?.data ?? value;
      if (!entry?.continuation?.agentSessionId || !entry?.turn) {
        throw storeError("work_item_continuation_agent_entry_incomplete", "Work Item continuation entry is incomplete.");
      }
      // The committed Agent command is the recovery source. Scheduling after
      // commit is safe for both a fresh request and an idempotent replay.
      agentTurnRunner.schedule(entry.continuation.agentSessionId);
      return { data: entry, responseHeaders: { "Cache-Control": "no-store" } };
    },
    async revokeWorkItemAccessGrant({ workItemId, grantId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!workItemLifecycle?.revokeAccessGrant) {
        throw storeError("work_item_promotion_unavailable", "Work Item sharing is temporarily unavailable.");
      }
      return runIdempotentMutation({
        scope: `revoke-work-item-access-grant:${context.userId}:${workItemId}:${grantId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => workItemLifecycle.revokeAccessGrant({
        workItemId,
        grantId,
        context,
        transactionSession,
      }));
    },
    async getAgentSessionQueue({ sessionId, query = {}, auth }) {
      const context = await resolveAuth(auth);
      const session = await agentTurnRunner?.getSession(sessionId, context);
      if (!session) throw storeError("agent_session_not_found", "Agent session not found.");
      if (!admissionController?.readSessionQueue) {
        throw storeError("admission_unavailable", "Task queue status is temporarily unavailable.");
      }
      const queue = await admissionController.readSessionQueue({
        ...context,
        sessionId,
        cursor: query.cursor,
        limit: query.limit,
      });
      return {
        sessionId,
        runningTurnId: session.activeTurnId ?? null,
        ...queue,
      };
    },
    async createAgentTurn({ sessionId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!agentTurnRunner) throw storeError("agent_turn_runner_unavailable", "Agent turn service is unavailable.");
      const turn = await runIdempotentMutation({
        scope: `create-agent-turn:${sessionId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => agentTurnRunner.enqueueTurn({
        sessionId,
        ...request.data,
        ...context,
        transactionSession,
      }));
      agentTurnRunner.schedule(sessionId);
      return turn;
    },
    async decideAgentToolApproval({ approvalId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!agentToolApprovalLifecycle?.decide) {
        throw storeError("agent_tool_approval_unavailable", "Agent Tool approval is temporarily unavailable.");
      }
      const decision = await runIdempotentMutation({
        scope: `decide-agent-tool-approval:${approvalId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, () => agentToolApprovalLifecycle.decide({
        approvalId,
        decision: request.data.decision,
        userId: context.userId,
        workspaceId: context.workspaceId,
      }));
      if (decision?.resumeTurnId && typeof decision.sessionId === "string" && agentTurnRunner?.schedule) {
        agentTurnRunner.schedule(decision.sessionId);
      }
      const { sessionId: _internalSessionId, ...publicDecision } = decision;
      return publicDecision;
    },
    async listAgentTurns({ sessionId, query = {}, auth }) {
      const context = await resolveAuth(auth);
      const turns = await agentTurnRunner?.listTurns?.(sessionId, {
        ...(Number.isInteger(query.after) ? { after: query.after } : {}),
        cursor: query.cursor,
        limit: query.limit ?? 100,
      }, context);
      if (!turns) throw storeError("agent_session_not_found", "Agent session not found.");
      return resultPage(turns);
    },
    async getAgentTurn({ sessionId, turnId, auth }) {
      const context = await resolveAuth(auth);
      const turn = await agentTurnRunner?.getTurn(sessionId, turnId, context);
      if (!turn) throw storeError("agent_turn_not_found", "Agent turn not found.");
      return turn;
    },
    async cancelAgentTurn({ sessionId, turnId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!agentTurnRunner) throw storeError("agent_turn_runner_unavailable", "Agent turn service is unavailable.");
      const turn = await runIdempotentMutation({
        scope: `cancel-agent-turn:${turnId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, (transactionSession) => agentTurnRunner.cancelTurn({
        sessionId,
        turnId,
        reason: request.data.reason,
        ...context,
        transactionSession,
      }));
      if (turn?.cancellationCommandId) {
        await agentTurnRunner.afterCancellationCommitted({
          sessionId,
          turnId,
          reason: request.data.reason,
          turn,
        });
      }
      return turn;
    },
    async listAgentSessionEvents({ sessionId, query = {}, auth }) {
      const context = await resolveAuth(auth);
      const events = await agentTurnRunner?.listEvents(sessionId, {
        ...(Number.isInteger(query.after) ? { after: query.after } : {}),
        cursor: query.cursor,
        limit: query.limit ?? 500,
      }, context);
      if (!events) throw storeError("agent_session_not_found", "Agent session not found.");
      return resultPage(events);
    },
    async replaySessionDomainEvents({ query = {}, auth }) {
      const context = await resolveAuth(auth);
      if (!sessionDomainReadModel?.replay) {
        throw storeError("session_domain_events_unavailable", "Session replay is temporarily unavailable.");
      }
      return sessionDomainReadModel.replay({
        workspaceId: context.workspaceId,
        userId: context.userId,
        after: Number.isInteger(query.after) ? query.after : 0,
        limit: query.limit ?? 200,
      });
    },
    async getArtifactMetadata({ artifactId, auth }) {
      const context = await resolveAuth(auth);
      if (!artifactService?.getMetadata) throw storeError("artifact_read_failed", "Artifact storage is unavailable.");
      const authorizedObjectScopes = await authorizedArtifactScopes({ artifactId, context });
      return artifactService.getMetadata({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        artifactId,
        authorizedObjectScopes,
      });
    },
    async getArtifactContent({ artifactId, auth }) {
      const context = await resolveAuth(auth);
      if (!artifactService?.readContent) throw storeError("artifact_read_failed", "Artifact storage is unavailable.");
      const authorizedObjectScopes = await authorizedArtifactScopes({ artifactId, context });
      const content = await artifactService.readContent({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        artifactId,
        authorizedObjectScopes,
      });
      return { rawBody: content.bytes, responseHeaders: content.headers };
    },
    async listAgentHandoffs({ sessionId, auth }) {
      const context = await resolveAuth(auth);
      if (!agentTurnRunner) throw storeError("agent_turn_runner_unavailable", "Agent handoff service is unavailable.");
      return resultPage(await agentTurnRunner.listHandoffs({ sessionId, ...context }));
    },
    async confirmAgentHandoff({ sessionId, handoffId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!agentTurnRunner) throw storeError("agent_turn_runner_unavailable", "Agent handoff service is unavailable.");
      if (agentHandoffLifecycle?.confirm) {
        return agentHandoffLifecycle.confirm({
          sessionId,
          handoffId,
          idempotencyKey,
          request: clone(request),
          context,
        });
      }
      return store.runIdempotentMutation({
        scope: `confirm-agent-handoff:${handoffId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, () => agentTurnRunner.confirmHandoff({ sessionId, handoffId, ...context }));
    },
    async getAgentProposal({ sessionId, proposalId, auth }) {
      const context = await resolveAuth(auth);
      return requireOwnedAgentProposal({
        sessionId,
        proposalId,
        context,
      });
    },
    async applyAgentProposal({ sessionId, proposalId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      await requireOwnedAgentProposal({
        sessionId,
        proposalId,
        context,
        objectAccess: "edit",
      });
      if (agentProposalLifecycle?.apply) {
        return agentProposalLifecycle.apply({
          sessionId,
          proposalId,
          idempotencyKey,
          request: clone(request),
          context,
        });
      }
      return store.runIdempotentMutation({
        scope: `apply-agent-proposal:${context.userId}:${sessionId}:${proposalId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, async (session) => {
        const proposal = await requireOwnedAgentProposal({
          sessionId,
          proposalId,
          context,
          session,
          objectAccess: "edit",
        });
        if (proposal.status !== "proposed") {
          throw storeError(
            "agent_proposal_state_invalid",
            "This Agent proposal can no longer be applied.",
            { status: proposal.status },
          );
        }
        const branch = await requireRepository(store, "agentBranches").get(
          proposal.branchId,
          { workspaceId: context.workspaceId, session },
        );
        if (!branch || branch.baseVersionId !== proposal.baseVersionId) {
          throw storeError(
            "agent_proposal_base_unavailable",
            "The proposal branch base is unavailable.",
          );
        }
        let result;
        if (proposal.objectKind === "workflow") {
          const current = await store.getWorkflow(proposal.objectId, {
            workspaceId: context.workspaceId,
            session,
          });
          const currentRevision = await requireRepository(store, "workflowRevisions").get(
            proposal.objectId,
            current.workflow.currentRevisionId,
            { workspaceId: context.workspaceId, session },
          );
          const baseRevision = branch.baseSnapshot
            ?? await requireRepository(store, "workflowRevisions").get(
              proposal.objectId,
              proposal.baseVersionId,
              { workspaceId: context.workspaceId, session },
            );
          if (!baseRevision || !currentRevision) {
            throw storeError(
              "agent_proposal_base_unavailable",
              "The proposal cannot be rebased because its canonical base is unavailable.",
            );
          }
          const proposedRevision = applyWorkflowAgentOperations(
            baseRevision,
            proposal.operations,
          );
          const merge = mergeWorkflowProposal({
            base: baseRevision,
            current: currentRevision,
            proposed: proposedRevision,
          });
          if (merge.status === "conflicted") {
            return persistAgentProposalConflicts({
              proposal,
              conflicts: merge.conflicts,
              context,
              session,
            });
          }
          await requireWorkflowSkillReferences({
            graph: merge.merged.graph,
            context,
            session,
          });
          const saved = await store.saveWorkflowRevision({
            workflowId: proposal.objectId,
            idempotencyKey: canonicalRequestHash({
              proposalId,
              decision: "apply",
            }).slice(0, 64),
            ifMatch: current.etag,
            request: {
              schemaVersion: "workbench-api-v1",
              data: {
                baseRevisionId: currentRevision.revisionId,
                graph: merge.merged.graph,
                inputForm: merge.merged.inputForm,
                outputDefinition: merge.merged.outputDefinition,
                resourceRefs: merge.merged.resourceRefs,
                runSettings: merge.merged.runSettings,
                ...(merge.merged.definition
                  ? { definition: merge.merged.definition }
                  : {}),
                saveReason: `Applied confirmed Agent proposal ${proposalId}.`,
              },
            },
            workspaceId: context.workspaceId,
            authoredBy: context.userId,
            session,
            authorizeReferences: ({ graph, session: authorizationSession }) => (
              requireWorkflowSkillReferences({
                graph,
                context,
                session: authorizationSession,
              })
            ),
          });
          await compileRevision({
            workflowId: proposal.objectId,
            revision: saved.revision,
            context,
            options: { session },
          });
          result = saved.revision;
        } else if (proposal.objectKind === "skill_draft") {
          const currentDraft = await requireRepository(store, "skillDrafts").get(
            proposal.objectId,
            { workspaceId: context.workspaceId, session },
          );
          const baseDraft = branch.baseSnapshot
            ?? (
              currentDraft
              && `${currentDraft.skillDraftId}:${currentDraft.revision}` === proposal.baseVersionId
                ? currentDraft
                : null
            );
          if (!baseDraft || !currentDraft) {
            throw storeError(
              "agent_proposal_base_unavailable",
              "The proposal cannot be rebased because its Skill Draft base is unavailable.",
            );
          }
          const merge = mergeSkillDraftProposal({
            base: baseDraft,
            current: currentDraft,
            operations: proposal.operations,
          });
          if (merge.status === "conflicted") {
            return persistAgentProposalConflicts({
              proposal,
              conflicts: merge.conflicts,
              context,
              session,
            });
          }
          const updated = await store.updateSkillDraft({
            skillId: currentDraft.skillId,
            draftId: currentDraft.skillDraftId,
            idempotencyKey: canonicalRequestHash({
              proposalId,
              decision: "apply",
            }).slice(0, 64),
            ifMatch: formatSkillDraftEtag(currentDraft),
            request: {
              schemaVersion: "workbench-api-v1",
              data: merge.patch,
            },
            workspaceId: context.workspaceId,
            authoredBy: context.userId,
            session,
          });
          result = updated.draft;
        } else {
          throw storeError("agent_proposal_object_invalid", "This proposal object is unsupported.");
        }
        const decidedAt = clock();
        await requireRepository(store, "agentBranches").patch(
          proposal.branchId,
          { status: "merged", updatedAt: decidedAt },
          { workspaceId: context.workspaceId, session },
        );
        await requireRepository(store, "agentSessions").patch(
          sessionId,
          {
            status: "closed",
            taskStatus: "completed",
            activeTurnId: null,
            updatedAt: decidedAt,
          },
          { workspaceId: context.workspaceId, session },
        );
        const accepted = await requireRepository(store, "agentObjectProposals").patch(
          proposalId,
          { status: "accepted", decidedAt },
          { workspaceId: context.workspaceId, session },
        );
        await requireRepository(store, "auditEvents").append({
          schemaVersion: "workbench-v1",
          auditEventId: idFactory("audit"),
          workspaceId: context.workspaceId,
          actorId: context.userId,
          action: "agent_proposal.accepted",
          entityKind: proposal.objectKind,
          entityId: proposal.objectId,
          createdAt: decidedAt,
        }, { session });
        void result;
        return accepted;
      });
    },
    async rejectAgentProposal({ sessionId, proposalId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      await requireOwnedAgentProposal({
        sessionId,
        proposalId,
        context,
      });
      if (agentProposalLifecycle?.reject) {
        return agentProposalLifecycle.reject({
          sessionId,
          proposalId,
          idempotencyKey,
          request: clone(request),
          context,
        });
      }
      return store.runIdempotentMutation({
        scope: `reject-agent-proposal:${context.userId}:${sessionId}:${proposalId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, async (session) => {
        const proposal = await requireOwnedAgentProposal({
          sessionId,
          proposalId,
          context,
          session,
        });
        if (!["proposed", "conflicting"].includes(proposal.status)) {
          throw storeError(
            "agent_proposal_state_invalid",
            "This Agent proposal can no longer be rejected.",
            { status: proposal.status },
          );
        }
        const decidedAt = clock();
        await requireRepository(store, "agentBranches").patch(
          proposal.branchId,
          { status: "rejected", updatedAt: decidedAt },
          { workspaceId: context.workspaceId, session },
        );
        await requireRepository(store, "agentSessions").patch(
          sessionId,
          {
            status: "closed",
            taskStatus: "completed",
            activeTurnId: null,
            updatedAt: decidedAt,
          },
          { workspaceId: context.workspaceId, session },
        );
        await requireRepository(store, "mergeConflicts").collection?.updateMany?.(
          { proposalId, workspaceId: context.workspaceId, status: "open" },
          { $set: { status: "resolved", resolvedAt: decidedAt } },
          { session },
        );
        const rejected = await requireRepository(store, "agentObjectProposals").patch(
          proposalId,
          { status: "rejected", decidedAt },
          { workspaceId: context.workspaceId, session },
        );
        await requireRepository(store, "auditEvents").append({
          schemaVersion: "workbench-v1",
          auditEventId: idFactory("audit"),
          workspaceId: context.workspaceId,
          actorId: context.userId,
          action: "agent_proposal.rejected",
          entityKind: proposal.objectKind,
          entityId: proposal.objectId,
          createdAt: decidedAt,
        }, { session });
        return rejected;
      });
    },
    async listMemoryCandidates({ query = {}, auth }) {
      const context = await resolveAuth(auth);
      if (!memoryService) throw storeError("memory_service_unavailable", "Product Memory is unavailable.");
      return resultPage(await memoryService.listCandidates({
        context,
        status: query.status,
        scope: query.scope,
        limit: query.limit ?? 500,
      }));
    },
    async approveMemoryCandidate({ candidateId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth);
      if (!memoryService) throw storeError("memory_service_unavailable", "Product Memory is unavailable.");
      return runExternalMutation({
        scope: `approve-memory-candidate:${context.userId}:${candidateId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
        operationIdKind: "memory-decision",
        recover: async () => {
          let candidate;
          try {
            candidate = await memoryService.getCandidate({ candidateId, context });
          } catch (error) {
            if (error?.code === "memory_candidate_not_found") return null;
            throw error;
          }
          return candidate?.status === "promoted" ? candidate : null;
        },
      }, () => memoryService.approveCandidate({ candidateId, reason: request.data.reason, context }));
    },
    async rejectMemoryCandidate({ candidateId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth);
      if (!memoryService) throw storeError("memory_service_unavailable", "Product Memory is unavailable.");
      return runExternalMutation({
        scope: `reject-memory-candidate:${context.userId}:${candidateId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
        operationIdKind: "memory-decision",
        recover: async () => {
          let candidate;
          try {
            candidate = await memoryService.getCandidate({ candidateId, context });
          } catch (error) {
            if (error?.code === "memory_candidate_not_found") return null;
            throw error;
          }
          return candidate?.status === "rejected" ? candidate : null;
        },
      }, () => memoryService.rejectCandidate({ candidateId, reason: request.data.reason, context }));
    },
    async listMemories({ query = {}, auth }) {
      const context = await resolveAuth(auth);
      if (!memoryService) throw storeError("memory_service_unavailable", "Product Memory is unavailable.");
      if (Boolean(query.subjectKind) !== Boolean(query.subjectId)) {
        throw storeError("memory_query_invalid", "Memory subject kind and ID must be provided together.");
      }
      const results = await memoryService.query({
        query: {
          scopes: query.scope ? [query.scope] : ["personal", "object", "workspace"],
          ...(query.subjectKind ? { subject: { kind: query.subjectKind, subjectId: query.subjectId } } : {}),
          ...(query.text ? { text: query.text } : {}),
          tags: query.tags ? query.tags.split(",").map((item) => item.trim()).filter(Boolean) : [],
          limit: query.limit ?? 100,
        },
        context,
      });
      return resultPage(results.map(({ memory }) => memory));
    },
    async deleteMemory({ memoryId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth);
      if (!memoryService) throw storeError("memory_service_unavailable", "Product Memory is unavailable.");
      return runExternalMutation({
        scope: `delete-memory:${context.userId}:${memoryId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
        operationIdKind: "memory-deletion",
        recover: () => memoryService.recoverDeletion({ memoryId, context }),
      }, () => memoryService.deleteMemory({ memoryId, reason: request.data.reason, context }));
    },
    async listMemberships({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      return resultPage(workspaceReadModel
        ? await workspaceReadModel.listMemberships({ workspaceId: context.workspaceId, query })
        : await requireRepository(store, "memberships").listByWorkspace(
          context.workspaceId,
          query,
        ));
    },
    async listSkills({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      const skills = compatibilityCatalogReadModel?.listSkills
        ? await compatibilityCatalogReadModel.listSkills({ workspaceId: context.workspaceId, query })
        : await requireRepository(store, "skills").list({ ...query, workspaceId: context.workspaceId });
      return resultPage(skills.map(productSafeSkillDefinition));
    },
    async getSkill({ skillId, auth }) {
      const context = await resolveAuth(auth);
      await ready();
      const value = compatibilityCatalogReadModel?.getSkill
        ? await compatibilityCatalogReadModel.getSkill({ skillId, workspaceId: context.workspaceId })
        : await requireRepository(store, "skills").get(skillId, { workspaceId: context.workspaceId });
      if (!value) throw storeError("skill_not_found", "Skill not found.", { skillId });
      return productSafeSkillDefinition(value);
    },
    async scanServerSkills({ request, auth }) {
      const context = await resolveAuth(auth, "owner");
      if (!serverSkillImportService?.scan) {
        throw storeError("skill_import_root_unavailable", "Server Skill import is not configured.");
      }
      return serverSkillImportService.scan({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        rootPath: request.data.rootPath,
      });
    },
    async importServerSkills({ request, idempotencyKey, auth }) {
      const context = await resolveAuth(auth, "owner");
      if (!serverSkillImportService?.import) {
        throw storeError("skill_import_root_unavailable", "Server Skill import is not configured.");
      }
      return serverSkillImportService.import({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        rootPath: request.data.rootPath,
        directories: request.data.directories,
        attachBuiltInToolPolicy: request.data.attachBuiltInToolPolicy !== false,
        idempotencyKey,
      });
    },
    async createSkill({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      const createSkill = skillDraftLifecycle?.createSkill?.bind(skillDraftLifecycle) ?? store.createSkill?.bind(store);
      if (typeof createSkill !== "function") {
        throw storeError("skill_creation_unavailable", "Skill creation is not available.");
      }
      let trustedActivation = null;
      let sourcePackage = null;
      if (request.data.uploadId) {
        if (skillDraftLifecycle) {
          if (!skillUploadService?.resolvePromotedPackage) throw storeError("upload_service_unavailable", "Skill upload is not configured.");
          sourcePackage = await skillUploadService.resolvePromotedPackage({
            workspaceId: context.workspaceId, requestedBy: context.userId, uploadId: request.data.uploadId,
          });
        } else {
          const upload = await requireRepository(store, "uploads").get(request.data.uploadId, {
            workspaceId: context.workspaceId,
          });
          if (!upload || upload.requestedBy !== context.userId || upload.state !== "promoted") {
            throw storeError(
              "skill_upload_not_ready",
              "Promote your reviewed Skill package before creating this Skill.",
            );
          }
          trustedActivation = trustedSkillActivationRegistry?.resolve?.(upload?.inspection) ?? null;
          if (trustedActivation && (!agentRuntime || typeof agentRuntime.probeSkill !== "function")) {
            throw storeError("agent_runtime_unavailable", "Skill activation is not available.");
          }
          if (trustedActivation) {
            const readiness = await agentRuntime.probeSkill(trustedActivation.executionRef, {
              workspaceId: context.workspaceId,
            });
            if (readiness?.ready !== true && readiness?.status !== "ready") {
              throw storeError("skill_activation_unavailable", "The trusted Skill binding is not ready.");
            }
          }
        }
      }
      const value = await createSkill({
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
        trustedActivation,
        ...(sourcePackage ? { sourcePackage } : {}),
      });
      return {
        skill: productSafeSkillRecord(value.skill, context.userId, skillActionAvailability),
        draft: productSafeSkillDraft(value.draft),
      };
    },
    async listSkillAssets({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      if (skillReadModel) {
        const records = await skillReadModel.listSkillAssets({ workspaceId: context.workspaceId, query });
        const visible = await Promise.all(records.map(async ({ skill, draft, latestVersion }) => (
          await canReadSkill(skill, context)
            ? {
                skill: productSafeSkillRecord(skill, context.userId, skillActionAvailability),
                draft: productSafeSkillDraft(skill.ownerId === context.userId ? draft : null),
                latestVersion: productSafePublishedSkillVersion(latestVersion),
              }
            : null
        )));
        return resultPage(visible.filter(Boolean));
      }
      const [skills, drafts, versions] = await Promise.all([
        requireRepository(store, "skillAssets").list({ ...query, workspaceId: context.workspaceId }),
        requireRepository(store, "skillDrafts").list({ workspaceId: context.workspaceId }),
        requireRepository(store, "skillVersions").list({ workspaceId: context.workspaceId }),
      ]);
      const draftsById = new Map(drafts.map((draft) => [draft.skillDraftId, draft]));
      const versionsById = new Map(versions.map((version) => [version.skillVersionId, version]));
      const visibleSkills = await Promise.all(skills.map(async (skill) => (
        await canReadSkill(skill, context)
          ? {
              skill: productSafeSkillRecord(skill, context.userId, skillActionAvailability),
              // Drafts are personal branches. An object read grant exposes only the
              // product-safe Skill and immutable published version, never another
              // principal's active branch.
              draft: productSafeSkillDraft(
                skill.ownerId === context.userId && skill.currentDraftId
                  ? draftsById.get(skill.currentDraftId) ?? null
                  : null,
              ),
              latestVersion: skill.latestPublishedVersionId
                ? productSafePublishedSkillVersion(versionsById.get(skill.latestPublishedVersionId) ?? null)
                : null,
            }
          : null
      )));
      return resultPage(visibleSkills.filter(Boolean));
    },
    async getSkillDraft({ skillId, draftId, auth }) {
      const context = await resolveAuth(auth);
      if (!skillReadModel && typeof store.getSkillDraft !== "function") {
        throw storeError("skill_draft_unavailable", "Skill drafts are not available.");
      }
      const value = await requireSkillDraftAccess({ skillId, draftId, context, access: "read" });
      return { data: productSafeSkillDraft(value.draft), etag: formatSkillDraftEtag(value.draft) };
    },
    async updateSkillDraft({ skillId, draftId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      const updateSkillDraft = skillDraftLifecycle?.updateSkillDraft?.bind(skillDraftLifecycle) ?? store.updateSkillDraft?.bind(store);
      if (typeof updateSkillDraft !== "function") {
        throw storeError("skill_draft_unavailable", "Updating Skill details is not available.");
      }
      await requireSkillDraftAccess({ skillId, draftId, context, access: "edit" });
      const value = await updateSkillDraft({
        skillId,
        draftId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
      });
      return { data: productSafeSkillDraft(value.draft), etag: formatSkillDraftEtag(value.draft) };
    },
    async getSkillDraftPackage({ skillId, draftId, auth }) {
      const context = await resolveAuth(auth);
      if (!skillUploadService?.getDraftPackage) {
        throw storeError("skill_package_unavailable", "Skill package editing is not configured for this Workbench.");
      }
      await requireSkillDraftAccess({ skillId, draftId, context, access: "read" });
      const data = await skillUploadService.getDraftPackage({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        skillId,
        draftId,
      });
      return { data, etag: formatSkillDraftEtag({
        skillDraftId: data.skillDraftId,
        revision: data.revision,
      }) };
    },
    async replaceSkillDraftPackage({ skillId, draftId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      const replaceSkillDraftPackage = skillDraftLifecycle?.replaceSkillDraftPackage?.bind(skillDraftLifecycle)
        ?? store.replaceSkillDraftPackage?.bind(store);
      if (!skillUploadService?.resolvePromotedPackage || typeof replaceSkillDraftPackage !== "function") {
        throw storeError("skill_package_unavailable", "Skill package editing is not configured for this Workbench.");
      }
      await requireSkillDraftAccess({ skillId, draftId, context, access: "edit" });
      const replacement = await skillUploadService.resolvePromotedPackage({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        uploadId: request.data.uploadId,
      });
      const value = await replaceSkillDraftPackage({
        skillId,
        draftId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
        replacement,
      });
      return { data: productSafeSkillDraft(value.draft), etag: formatSkillDraftEtag(value.draft) };
    },
    async createSkillTest({ skillId, draftId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      await requireSkillDraftAccess({ skillId, draftId, context, access: "execute" });
      if (!skillValidationService?.prepareTestIntake
        || !skillValidationService?.acceptTestRun
        || typeof skillTestRunner?.schedule !== "function"
        || typeof resolveSkillValidationContext !== "function"
        || !productSkillCommandIntake) {
        throw storeError("skill_validation_unavailable", "Skill testing is not configured for this Workbench.");
      }
      const record = await runExternalMutation({
        scope: `test-skill-draft:${skillId}:${draftId}`,
        key: idempotencyKey,
        request: { ifMatch, request },
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
        operationIdKind: "skill-test-run",
        recover: async (testRunId) => {
          const record = await skillValidationService.getTestRun({ workspaceId: context.workspaceId, testRunId });
          if (record?.skillId !== skillId || record?.skillDraftId !== draftId) return null;
          return record;
        },
        replay: async (_storedResponse, testRunId) => {
          const current = await skillValidationService.getTestRun({
            workspaceId: context.workspaceId,
            testRunId,
          });
          return current?.skillId === skillId && current?.skillDraftId === draftId
            ? current
            : _storedResponse;
        },
      }, async (testRunId) => {
        const validationContext = await resolveSkillValidationContext({
          skillId,
          draftId,
          workspaceId: context.workspaceId,
          requestedBy: context.userId,
        });
        if (formatSkillDraftEtag(validationContext.draft) !== ifMatch) {
          throw storeError("skill_draft_conflict", "The Skill draft changed after it was read.", { skillId, draftId });
        }
        const testInput = {
          workspaceId: context.workspaceId,
          skillId,
          draftId,
          draftRevision: validationContext.draft.revision,
          contentHash: validationContext.contentHash,
          uploadId: validationContext.uploadId,
          objectId: validationContext.objectId,
          objectHash: validationContext.objectHash,
          packageHash: validationContext.packageHash,
          requestedBy: context.userId,
          inputSchema: validationContext.draft.inputSchema,
          outputSchema: validationContext.draft.outputSchema,
          permissionAcknowledged: true,
          testCases: [clone(request.data.testCase)],
          testRunIds: [testRunId],
        };
        const prepared = skillValidationService.prepareTestIntake(
          testInput,
          validationContext.inspection,
        );
        const authority = skillCommandAuthorizer
          ? await skillCommandAuthorizer.authorizeSkillTest({
              workspaceId: context.workspaceId,
              userId: context.userId,
              draftId,
              testRunId,
              input: { skillId, draftId, ifMatch, testCase: request.data.testCase },
            })
          : null;
        await productSkillCommandIntake.accept({
          principal: context,
          command: authority ? {
            commandId: testRunId,
            kind: "skill_test",
            sessionId: draftId,
            turnId: testRunId,
            ...authority,
          } : {
            schemaVersion: "workbench-v1",
            commandId: testRunId,
            kind: "skill_test",
            sessionId: draftId,
            turnId: testRunId,
          },
          at: clock(),
          persistTarget: ({ session, uow }) => skillValidationService.acceptTestRun(
            testInput,
            prepared,
            { session, uow },
          ),
          loadTarget: () => skillValidationService.getTestRun({ workspaceId: context.workspaceId, testRunId }),
        });
        return skillValidationService.getTestRun({
          workspaceId: context.workspaceId,
          testRunId,
        });
      });
      skillTestRunner.schedule(record.testRunId, { workspaceId: context.workspaceId });
      return productSafeSkillTestRun(record);
    },
    async getSkillTestRun({ skillId, testRunId, auth }) {
      const context = await resolveAuth(auth);
      if (!skillValidationService?.getTestRun) {
        throw storeError("skill_validation_unavailable", "Skill testing is not configured for this Workbench.");
      }
      const record = await skillValidationService.getTestRun({
        workspaceId: context.workspaceId,
        testRunId,
      });
      if (!record || record.skillId !== skillId) {
        throw storeError("skill_test_run_not_found", "Skill test run not found.", { skillId, testRunId });
      }
      await requireSkillDraftAccess({
        skillId,
        draftId: record.skillDraftId,
        context,
        access: "read",
      });
      return productSafeSkillTestRun(record);
    },
    async cancelSkillTest({ skillId, testRunId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!skillValidationService?.getTestRun
        || typeof skillTestRunner?.cancel !== "function"
        || !(store.persistenceDriver === "postgres" ? productSkillCommandIntake : productCommandIntake)) {
        throw storeError("skill_validation_unavailable", "Skill testing is not configured for this Workbench.");
      }
      const existing = await skillValidationService.getTestRun({
        workspaceId: context.workspaceId,
        testRunId,
      });
      if (!existing || existing.skillId !== skillId) {
        throw storeError("skill_test_run_not_found", "Skill test run not found.", { skillId, testRunId });
      }
      await requireSkillDraftAccess({
        skillId,
        draftId: existing.skillDraftId,
        context,
        access: "execute",
      });
      if (store.persistenceDriver === "postgres") {
        if (!productSkillCommandIntake?.recover || !productSkillCommandIntake?.requestCancellation
          || !skillCommandAuthorizer?.authorizeSkillTestCancellation) {
          throw storeError("skill_test_cancellation_unavailable", "Skill test cancellation is not configured for this PostgreSQL Workbench.");
        }
        const currentCommand = await productSkillCommandIntake.recover({ principal: context, commandId: testRunId });
        if (!currentCommand || currentCommand.kind !== "skill_test" || ["completed", "failed", "blocked", "cancelled"].includes(currentCommand.status)) {
          throw storeError("skill_test_cancel_conflict", "The completed Skill test cannot be cancelled.", { skillId, testRunId });
        }
        await runExternalMutation({
          scope: `cancel-skill-test:${skillId}:${testRunId}`,
          key: idempotencyKey,
          request,
          workspaceId: context.workspaceId,
          effectivePrincipalId: context.userId,
          operationIdKind: "skill-test-cancellation",
          recover: async () => {
            const command = await productSkillCommandIntake.recover({ principal: context, commandId: testRunId });
            return command?.kind === "skill_test" && command.status === "cancellation_requested" ? testRunId : null;
          },
          replay: async () => testRunId,
        }, async () => {
          const authority = await skillCommandAuthorizer.authorizeSkillTestCancellation({
            workspaceId: context.workspaceId,
            userId: context.userId,
            draftId: existing.skillDraftId,
            testRunId,
            reason: request?.data?.reason ?? null,
          });
          await productSkillCommandIntake.requestCancellation({
            principal: context,
            commandId: testRunId,
            authorizationDecisionId: authority.authorizationDecisionId,
            argumentDigest: authority.argumentDigest,
            at: clock(),
          });
          return testRunId;
        });
        void skillTestRunner.cancel(testRunId, { workspaceId: context.workspaceId });
        return testRunId;
      }
      const ownedCommand = await productCommandIntake.recover({
        principal: context,
        commandId: testRunId,
      });
      if (!ownedCommand || ownedCommand.kind !== "skill_test") {
        throw storeError("skill_test_run_not_found", "Skill test run not found.", { skillId, testRunId });
      }
      if (["completed", "failed", "blocked"].includes(ownedCommand.status)) {
        throw storeError("skill_test_cancel_conflict", "The completed Skill test cannot be cancelled.", {
          skillId,
          testRunId,
        });
      }
      await runExternalMutation({
        scope: `cancel-skill-test:${skillId}:${testRunId}`,
        key: idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
        operationIdKind: "skill-test-cancellation",
        recover: async (cancellationCommandId) => {
          const [cancellationCommand, targetCommand, current] = await Promise.all([
            productCommandIntake.recover({
              principal: context,
              commandId: cancellationCommandId,
            }),
            productCommandIntake.recover({
              principal: context,
              commandId: testRunId,
            }),
            skillValidationService.getTestRun({
              workspaceId: context.workspaceId,
              testRunId,
            }),
          ]);
          const cancellationCommitted = cancellationCommand?.kind === "cancel_skill_test"
            && cancellationCommand.sessionId === existing.skillDraftId
            && cancellationCommand.turnId === cancellationCommandId
            && cancellationCommand.targetCommandId === testRunId
            && cancellationCommand.status === "completed";
          const targetMatches = targetCommand?.kind === "skill_test"
            && targetCommand.sessionId === existing.skillDraftId
            && targetCommand.turnId === testRunId
            && (
              (targetCommand.status === "cancellation_requested"
                && ["queued", "running"].includes(current?.status))
              || (targetCommand.status === "cancelled" && current?.status === "cancelled")
            );
          const testRunMatches = current?.skillId === skillId
            && current.skillDraftId === existing.skillDraftId;
          return cancellationCommitted && targetMatches && testRunMatches ? testRunId : null;
        },
        replay: async () => testRunId,
      }, async (cancellationCommandId) => {
        const currentCommand = await productCommandIntake.recover({
          principal: context,
          commandId: testRunId,
        });
        if (["cancellation_requested", "cancelled"].includes(currentCommand?.status)) {
          return testRunId;
        }
        if (!currentCommand || currentCommand.kind !== "skill_test"
          || ["completed", "failed", "blocked"].includes(currentCommand.status)) {
          throw storeError("skill_test_cancel_conflict", "The completed Skill test cannot be cancelled.", {
            skillId,
            testRunId,
          });
        }
        await productCommandIntake.acceptCancellation({
          principal: context,
          command: {
            schemaVersion: "workbench-v1",
            commandId: cancellationCommandId,
            kind: "cancel_skill_test",
            sessionId: existing.skillDraftId,
            turnId: cancellationCommandId,
            targetCommandId: testRunId,
          },
          targetCommandId: testRunId,
          targetStatus: "cancellation_requested",
          at: clock(),
          persistTarget: ({ session }) => requireRepository(store, "skillTestRuns").get(testRunId, {
              workspaceId: context.workspaceId,
              session,
            }),
          loadTarget: ({ session }) => requireRepository(store, "skillTestRuns").get(testRunId, {
            workspaceId: context.workspaceId,
            session,
          }),
        });
        return testRunId;
      });
      void skillTestRunner.cancel(testRunId);
      return testRunId;
    },
    async createSkillValidation({ skillId, draftId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      await requireSkillDraftAccess({ skillId, draftId, context, access: "execute" });
      if (!skillValidationService?.createValidation
        || typeof resolveSkillValidationContext !== "function"
        || !productSkillCommandIntake) {
        throw storeError("skill_validation_unavailable", "Skill validation is not configured for this Workbench.");
      }
      const record = await runIdempotentMutation({
        scope: `validate-skill-draft:${skillId}:${draftId}`,
        key: idempotencyKey,
        request: { ifMatch, request },
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, async (session) => {
        const validationId = idFactory("skill-validation");
        const validationContext = await resolveSkillValidationContext({
          skillId,
          draftId,
          workspaceId: context.workspaceId,
          requestedBy: context.userId,
          session,
        });
        if (formatSkillDraftEtag(validationContext.draft) !== ifMatch) {
          throw storeError("skill_draft_conflict", "The Skill draft changed after it was read.", { skillId, draftId });
        }
        const authority = skillCommandAuthorizer
          ? await skillCommandAuthorizer.authorizeSkillValidation({
              workspaceId: context.workspaceId,
              userId: context.userId,
              draftId,
              validationId,
              input: { skillId, draftId, ifMatch, testRunIds: request.data.testRunIds },
              uow: session,
            })
          : null;
        const accepted = await productSkillCommandIntake.accept({
          principal: context,
          command: authority ? {
            commandId: validationId,
            kind: "skill_validation",
            sessionId: draftId,
            turnId: validationId,
            ...authority,
          } : {
            schemaVersion: "workbench-v1",
            commandId: validationId,
            kind: "skill_validation",
            sessionId: draftId,
            turnId: validationId,
          },
          at: clock(),
          session,
          uow: session,
          persistTarget: ({ session: transactionSession, uow: transactionUow }) => skillValidationService.createValidation({
            workspaceId: context.workspaceId,
            skillId,
            draftId,
            draftRevision: validationContext.draft.revision,
            contentHash: validationContext.contentHash,
            uploadId: validationContext.uploadId,
            objectId: validationContext.objectId,
            objectHash: validationContext.objectHash,
            packageHash: validationContext.packageHash,
            executionRef: validationContext.draft.executionRef,
            permissionAcknowledged: request.data.permissionAcknowledged,
            testRunIds: request.data.testRunIds,
            validationId,
          }, { uow: transactionUow ?? transactionSession }),
        });
        await productSkillCommandIntake.settle({
          principal: context,
          commandId: validationId,
          status: "completed",
          at: clock(),
          session,
          uow: session,
        });
        return accepted.target;
      });
      return productSafeSkillValidation(record);
    },
    async getSkillValidation({ skillId, validationId, auth }) {
      const context = await resolveAuth(auth);
      if (!skillValidationService?.getValidation) {
        throw storeError("skill_validation_unavailable", "Skill validation is not configured for this Workbench.");
      }
      const record = await skillValidationService.getValidation({
        workspaceId: context.workspaceId,
        validationId,
      });
      if (!record || record.skillId !== skillId) {
        throw storeError("skill_validation_not_found", "Skill validation not found.", { skillId, validationId });
      }
      await requireSkillDraftAccess({
        skillId,
        draftId: record.skillDraftId,
        context,
        access: "read",
      });
      return productSafeSkillValidation(record);
    },
    async createNextSkillDraft({ skillId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      const createNextSkillDraft = skillDraftLifecycle?.createNextSkillDraft?.bind(skillDraftLifecycle) ?? store.createNextSkillDraft?.bind(store);
      if (typeof createNextSkillDraft !== "function") {
        throw storeError("skill_draft_unavailable", "Creating the next Skill version is not available.");
      }
      await requireSkillOwner({ skillId, context });
      const value = await createNextSkillDraft({
        skillId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
      });
      return { data: productSafeSkillDraft(value.draft), etag: formatSkillDraftEtag(value.draft) };
    },
    async getSkillUsage({ skillId, auth }) {
      const context = await resolveAuth(auth);
      const getSkillUsageImpact = skillReadModel?.getSkillUsageImpact?.bind(skillReadModel) ?? store.getSkillUsageImpact?.bind(store);
      if (typeof getSkillUsageImpact !== "function") {
        throw storeError("skill_usage_unavailable", "Skill usage is not available.");
      }
      await requireSkillAccess({ skillId, context });
      const impact = await getSkillUsageImpact({
        skillId,
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
      });
      return {
        ...impact,
        affectedWorkflows: await filterReadableWorkflowReferences({
          references: impact.affectedWorkflows,
          context,
        }),
      };
    },
    async listSkillVersions({ skillId, query = {}, auth }) {
      const context = await resolveAuth(auth);
      await requireSkillAccess({ skillId, context });
      const listSkillVersions = skillReadModel?.listSkillVersions?.bind(skillReadModel) ?? store.listSkillVersions?.bind(store);
      if (typeof listSkillVersions !== "function") {
        throw storeError("skill_version_history_unavailable", "Skill version history is not available.");
      }
      const versions = await listSkillVersions({
        skillId,
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        limit: query.limit,
      });
      return resultPage(versions.map(productSafeSkillVersionSummary));
    },
    async getSkillVersionDiff({ skillId, fromVersionId, toVersionId, auth }) {
      const context = await resolveAuth(auth);
      await requireSkillAccess({ skillId, context });
      const getSkillVersionDiff = skillReadModel?.getSkillVersionDiff?.bind(skillReadModel) ?? store.getSkillVersionDiff?.bind(store);
      if (typeof getSkillVersionDiff !== "function") {
        throw storeError("skill_usage_unavailable", "Skill version comparison is not available.");
      }
      return getSkillVersionDiff({
        skillId,
        fromVersionId,
        toVersionId,
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
      });
    },
    async deprecateSkill({ skillId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      const deprecateSkill = skillDraftLifecycle?.deprecateSkill?.bind(skillDraftLifecycle) ?? store.deprecateSkill?.bind(store);
      if (typeof deprecateSkill !== "function") {
        throw storeError("skill_deprecation_unavailable", "Retiring this Skill is not available.");
      }
      await requireSkillAccess({ skillId, context, access: "retire" });
      return productSafeSkillRecord(await deprecateSkill({
        skillId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        deprecatedBy: context.userId,
      }), context.userId, skillActionAvailability);
    },
    async createUpload({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!skillUploadService?.createUpload) {
        throw storeError("upload_service_unavailable", "Skill upload is not configured for this Workbench.");
      }
      return skillUploadService.createUpload({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        idempotencyKey,
        ...request.data,
      });
    },
    async publishSkill({ skillId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      const publishSkill = skillDraftLifecycle?.publishSkill?.bind(skillDraftLifecycle) ?? store.publishSkill?.bind(store);
      if (typeof publishSkill !== "function") {
        throw storeError("skill_publish_unavailable", "Skill publication is not available.");
      }
      await requireSkillAccess({ skillId, context, access: "publish" });
      await requireSkillOwner({ skillId, context });
      const value = await publishSkill({
        skillId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        publishedBy: context.userId,
      });
      return {
        skill: productSafeSkillRecord(value.skill, context.userId, skillActionAvailability),
        version: productSafePublishedSkillVersion(value.version),
        release: productSafeSkillRelease(value.release),
      };
    },
    async uploadPackage({ uploadId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!skillUploadService?.inspectUpload) {
        throw storeError("upload_service_unavailable", "Skill upload is not configured for this Workbench.");
      }
      return skillUploadService.inspectUpload({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        uploadId,
        idempotencyKey,
        files: request.data.files.map(({ path, contentBase64 }) => ({
          path,
          content: decodeBase64(contentBase64),
        })),
      });
    },
    async uploadChunk({ uploadId, chunkIndex, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!skillUploadService?.uploadChunk) {
        throw storeError("upload_service_unavailable", "Resumable Skill upload is not configured for this Workbench.");
      }
      return skillUploadService.uploadChunk({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        uploadId,
        chunkIndex: Number(chunkIndex),
        idempotencyKey,
        content: decodeBase64(request.data.contentBase64),
      });
    },
    async completeUpload({ uploadId, idempotencyKey, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!skillUploadService?.completeUpload) {
        throw storeError("upload_service_unavailable", "Resumable Skill upload is not configured for this Workbench.");
      }
      return skillUploadService.completeUpload({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        uploadId,
        idempotencyKey,
      });
    },
    async importSkillRepository({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!skillUploadService?.importRepository) {
        throw storeError("repository_import_unavailable", "Repository import is not configured for this Workbench.");
      }
      return skillUploadService.importRepository({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        idempotencyKey,
        ...request.data,
      });
    },
    async getUpload({ uploadId, auth }) {
      const context = await resolveAuth(auth);
      if (!skillUploadService?.getUpload) {
        throw storeError("upload_service_unavailable", "Skill upload is not configured for this Workbench.");
      }
      return skillUploadService.getUpload({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        uploadId,
      });
    },
    async promoteUpload({ uploadId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!skillUploadService?.promoteUpload) {
        throw storeError("upload_service_unavailable", "Skill upload is not configured for this Workbench.");
      }
      return skillUploadService.promoteUpload({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        uploadId,
        idempotencyKey,
        permissionAcknowledged: request.data.permissionAcknowledged === true,
      });
    },
    async listResources({ auth }) {
      const context = await resolveAuth(auth);
      if (!textResourceService?.list) throw storeError("resource_service_unavailable", "Material storage is not configured for this Workbench.");
      return resultPage(await textResourceService.list({ workspaceId: context.workspaceId, requestedBy: context.userId }));
    },
    async createResource({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!textResourceService?.create) throw storeError("resource_service_unavailable", "Material storage is not configured for this Workbench.");
      return textResourceService.create({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        idempotencyKey,
        label: request.data.label,
        mediaType: request.data.mediaType,
        content: decodeBase64(request.data.contentBase64),
      });
    },
    async createResourceFromAttachment({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!textResourceService?.createFromAttachment || !inputAttachmentService?.resolveMaterialBindings) {
        throw storeError("resource_service_unavailable", "Attachment-backed workspace materials are not configured.");
      }
      const [resolved] = await inputAttachmentService.resolveMaterialBindings({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        bindings: [{
          materialKey: "workspace_resource_source",
          source: {
            kind: "attachment",
            attachment: request.data.attachment,
          },
        }],
      });
      return textResourceService.createFromAttachment({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        idempotencyKey,
        label: request.data.label,
        resolvedAttachment: resolved,
      });
    },
    async getResource({ resourceId, auth }) {
      const context = await resolveAuth(auth);
      if (!textResourceService?.get) throw storeError("resource_service_unavailable", "Material storage is not configured for this Workbench.");
      return textResourceService.get({ workspaceId: context.workspaceId, requestedBy: context.userId, resourceId });
    },
    async createAttachment({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!inputAttachmentService?.create) {
        throw storeError("attachment_service_unavailable", "Attachment storage is not configured for this Workbench.");
      }
      return inputAttachmentService.create({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        idempotencyKey,
        fileName: request.data.fileName,
        mediaType: request.data.mediaType,
        content: decodeBase64(request.data.contentBase64),
        ttlSeconds: request.data.ttlSeconds,
      });
    },
    async listAttachments({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      if (!inputAttachmentService?.list) {
        throw storeError("attachment_service_unavailable", "Attachment storage is not configured for this Workbench.");
      }
      return inputAttachmentService.list({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        cursor: query.cursor,
        limit: query.limit,
      });
    },
    async getAttachment({ attachmentId, auth }) {
      const context = await resolveAuth(auth);
      if (!inputAttachmentService?.get) {
        throw storeError("attachment_service_unavailable", "Attachment storage is not configured for this Workbench.");
      }
      return inputAttachmentService.get({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        attachmentId,
      });
    },
    async retryAttachment({ attachmentId, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!inputAttachmentService?.retry) {
        throw storeError("attachment_service_unavailable", "Attachment storage is not configured for this Workbench.");
      }
      return inputAttachmentService.retry({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        attachmentId,
      });
    },
    async deleteAttachment({ attachmentId, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!inputAttachmentService?.delete) {
        throw storeError("attachment_service_unavailable", "Attachment storage is not configured for this Workbench.");
      }
      return inputAttachmentService.delete({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        attachmentId,
      });
    },
    async listConnections({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth, "member");
      return resultPage(await connectionService.list({ workspaceId: context.workspaceId, query }));
    },
    async getConnection({ connectionId, auth }) {
      const context = await resolveAuth(auth, "member");
      return connectionService.get({ connectionId, workspaceId: context.workspaceId });
    },
    async createConnection({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "admin");
      return connectionService.create({
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        actorId: context.userId,
      });
    },
    async updateConnection({ connectionId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "admin");
      return connectionService.update({
        connectionId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        actorId: context.userId,
      });
    },
    async validateConnection({ connectionId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "admin");
      return connectionService.validate({
        connectionId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        actorId: context.userId,
      });
    },
    async bindConnectionCredential({ connectionId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "admin");
      return connectionService.bindCredential({
        connectionId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        actorId: context.userId,
      });
    },
    async createLoop({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      const createLoop = loopDraftLifecycle?.createLoop?.bind(loopDraftLifecycle) ?? store.createLoop?.bind(store);
      if (typeof createLoop !== "function") {
        throw storeError("loop_creation_unavailable", "Loop creation is not available.");
      }
      const result = await createLoop({
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
      });
      return { ...result, workflow: productSafeWorkflow(result.workflow) };
    },
    async createLoopFromRelease({ releaseId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!loopDraftLifecycle?.createLoopFromRelease) throw storeError("loop_creation_unavailable", "Loop creation is not available.");
      const result = await loopDraftLifecycle.createLoopFromRelease({ releaseId, idempotencyKey, request,
        workspaceId: context.workspaceId, authoredBy: context.userId });
      return { ...result, workflow: productSafeWorkflow(result.workflow) };
    },
    async generateStagedLoopProposal({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!executionBroker) {
        throw storeError("builder_proposal_unavailable", "Loop suggestions are not available yet.");
      }
      await ready();
      return productSafeStagedLoopProposal(await runExternalMutation({
        scope: `generate-staged-loop-proposal:${context.userId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
        operationIdKind: "proposal",
        leaseMilliseconds: 180_000,
        recover: async (proposalId) => {
          if (store.persistenceDriver === "postgres") {
            try {
              return await builderProposalReadModel?.getStaged?.({
                proposalId, workspaceId: context.workspaceId, userId: context.userId, now: clock(),
              }) ?? null;
            } catch {
              return null;
            }
          }
          const proposal = await requireRepository(store, "builderProposals").get(proposalId, {
            workspaceId: context.workspaceId,
          });
          if (!proposal) return null;
          if (isFinalProposal(proposal, "staged_loop_draft")) {
            return reconcileFinalProposal({
              proposalId,
              context,
              type: "staged_loop_draft",
            });
          }
          requireProposalGenerationTarget(proposal, {
            context,
            type: "staged_loop_draft",
            request,
          });
          const execution = await completedProposalExecution({
            proposalId,
            workspaceId: context.workspaceId,
            invocationId: proposal.generationState.invocationId,
          });
          if (!execution) return null;
          const recovered = await persistStagedProposal({
            proposal: stagedProposalFromExecution({ proposalId, execution, request, context }),
            context,
            request,
          });
          return recovered;
        },
      }, async (proposalId) => {
        const createdAt = clock();
        await requireProposalExecutionBackend("The isolated Loop proposal worker is unavailable.");
        await acceptProposalGeneration({
          proposalId,
          context,
          type: "staged_loop_draft",
          createdAt,
          request,
        });
        try {
        const generation = await startProposalGeneration({
          proposalId,
          context,
          type: "staged_loop_draft",
          request,
        });
        const route = request.data.modelProfileId
          ? await modelCatalog?.resolveCurrentProfile?.({
            profileId: request.data.modelProfileId,
            workspaceId: context.workspaceId,
            userId: context.userId,
            capabilities: ["chat", "tool_calling"],
            requireReady: true,
          })
          : await resolveWorkspaceDefaultModel({
            modelCatalog,
            workspaceId: context.workspaceId,
            userId: context.userId,
            capability: "tool_calling",
            requiredCapabilities: ["chat", "tool_calling"],
          });
        if (!route) throw storeError("model_route_unresolved", "No ready Loop design model is configured.");
        const skillRecords = skillReadModel?.listSkillAssets
          ? await skillReadModel.listSkillAssets({ workspaceId: context.workspaceId, query: { limit: 200 } })
          : [];
        const availableSkills = (await Promise.all(skillRecords.map(async ({ skill, latestVersion }) => (
          latestVersion && (await evaluateSkillAccess({ skill, context, access: "execute", requestedSkillVersionId: latestVersion.skillVersionId })).allowed
            ? { skillRef: { skillId: skill.skillId, version: latestVersion.version },
                name: latestVersion.name, description: latestVersion.description,
                inputSchema: clone(latestVersion.inputSchema), outputSchema: clone(latestVersion.outputSchema) }
            : null
        )))).filter(Boolean);
        const baseDraft = initialLoopDraft();
        const previewWorkflowId = `preview-${proposalId}`.slice(0, 128);
        const previewRevisionId = `preview-revision-${proposalId}`.slice(0, 128);
        const baseRevision = {
          schemaVersion: "workbench-v1",
          revisionId: previewRevisionId,
          workflowId: previewWorkflowId,
          revisionNumber: 1,
          baseRevisionId: null,
          ...clone(baseDraft),
          resourceRefs: [],
          definition: clone(request.data.definition),
          contentHash: canonicalRequestHash({ ...baseDraft, resourceRefs: [], definition: request.data.definition }),
          authoredBy: context.userId,
          saveReason: "Unsaved Loop proposal preview.",
          compile: { status: "blocked", diagnostics: [] },
          createdAt,
          updatedAt: createdAt,
        };
        const executionRequest = {
          schemaVersion: "workbench-execution-fabric-v1",
          invocationId: generation.executionIdentity.invocationId,
          attemptId: generation.executionIdentity.attemptId,
          workspaceId: context.workspaceId,
          actor: { userId: context.userId },
          lineage: {
            productCommandId: proposalProductCommandId(proposalId),
            sessionId: `builder-${proposalId}`.slice(0, 128),
            turnId: `builder-${proposalId}`.slice(0, 128),
          },
          controller: { kind: "agent_turn", controllerId: `builder-${proposalId}`.slice(0, 128), fence: 1 },
          mode: "bounded_agent",
          isolation: "container",
          goal: [
            "Generate a structured Loop proposal from the supplied document.",
            "Keep the Input and Output steps valid. Add only meaningful intermediate steps and connections.",
            "Return typed builder operations matching the supplied schema. Do not create or modify a stored Loop.",
            "Use only exact Skill references from availableSkills. Never invent skills, tools, resources or executable node kinds.",
            "If a required skill is missing, retain an editable outline and report a warning diagnostic explaining what the user needs to add. An Input-to-Output connection alone only echoes the input; it does not perform analysis.",
            "Write the summary, step titles, descriptions and diagnostics in the language of the supplied document.",
          ].join(" "),
          input: {
            proposalId,
            requestedBy: context.userId,
            revision: clone(baseRevision),
            document: request.data.sourceText,
            requestedName: request.data.name,
            requestedDefinition: clone(request.data.definition),
            availableSkills,
            // A new proposal is a single bounded run with no previous conversation.
            // Product supplies its explicit empty replay; the Worker never invents history.
            kernelSessionReplay: {
              schemaVersion: "agent-kernel-session-replay-v1",
              session: { sessionId: `builder-${proposalId}`.slice(0, 128), branchId: null },
              events: [],
              checkpoint: { cursor: 0 },
            },
          },
          limits: {
            timeoutMs: 90_000,
            maxSteps: 16,
            maxModelRequests: 8,
            maxChildren: 0,
            maxInputBytes: 1_000_000,
            maxOutputBytes: 1_000_000,
            maxImageCount: 0,
            maxCostUsdMicros: 0,
          },
          capabilities: {
            toolAllowlist: [],
            connectionIds: [],
            network: false,
            filesystem: "none",
            externalActions: false,
          },
          resultSchema: {
            type: "object",
            properties: {
              summary: clone(StagedLoopProposalSchema.properties.summary),
              operations: clone(StagedLoopProposalSchema.properties.operations),
              diagnostics: clone(StagedLoopProposalSchema.properties.diagnostics),
              permissionImpact: clone(StagedLoopProposalSchema.properties.permissionImpact),
            },
            required: ["summary", "operations", "diagnostics", "permissionImpact"],
            additionalProperties: false,
          },
          evidenceRequirements: [{
            requirementId: "staged-loop-proposal-json",
            kind: "output",
            required: true,
            description: "Return a typed proposal without creating a canonical Loop.",
          }],
          metadata: {
            agentKind: "builder_proposal",
            agentSessionId: `builder-${proposalId}`.slice(0, 128),
            requestedBy: context.userId,
            objectKind: "staged_loop",
            objectId: proposalId,
            modelProfileRevisionId: route.revision.revisionId,
            modelCapability: "tool_calling",
            fallbackModelProfileRevisionIds: [],
          },
        };
        const result = await executionBroker.execute(executionRequest);
        if (result.status !== "completed") {
          throw storeError("builder_proposal_unavailable", "Loop suggestions are currently blocked.", { status: result.status });
        }
        const execution = {
          request: executionRequest,
          result,
          createdAt: result.startedAt ?? createdAt,
        };
        const persisted = await persistStagedProposal({
          proposal: stagedProposalFromExecution({ proposalId, execution, request, context }),
          context,
          request,
        });
        return persisted;
        } catch (cause) {
          await settleProposalGenerationFailure({
            proposalId,
            context,
            type: "staged_loop_draft",
            request,
            status: cause?.code === "builder_proposal_unavailable" ? "blocked" : "failed",
            cause,
          });
          throw cause;
        }
      }));
    },
    async getStagedLoopProposal({ proposalId, auth }) {
      const context = await resolveAuth(auth);
      await ready();
      const proposal = builderProposalReadModel?.getStaged
        ? await builderProposalReadModel.getStaged({
          proposalId, workspaceId: context.workspaceId, userId: context.userId, now: clock(),
        })
        : await requireRepository(store, "builderProposals").get(proposalId, {
          workspaceId: context.workspaceId,
        });
      if (
        !proposal
        || proposal.kind !== "staged_loop_draft"
        || proposal.createdBy !== context.userId
      ) {
        throw storeError("builder_proposal_not_found", "The staged Loop proposal was not found.");
      }
      if (Date.parse(proposal.expiresAt) <= Date.parse(clock())) {
        throw storeError("builder_proposal_expired", "This staged Loop proposal has expired.");
      }
      return productSafeStagedLoopProposal(proposal);
    },
    async commitStagedLoopProposal({ proposalId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (builderProposalLifecycle?.commitStaged) {
        const result = await builderProposalLifecycle.commitStaged({
          proposalId, idempotencyKey, request: clone(request), context,
        });
        return {
          data: {
            workflow: productSafeWorkflow(result.workflow),
            revision: result.revision,
            proposal: productSafeStagedLoopProposal(result.proposal),
          },
          etag: result.etag,
        };
      }
      if (typeof store.commitStagedLoopProposal !== "function") {
        throw storeError("loop_creation_unavailable", "Saving a staged Loop proposal is not available.");
      }
      const result = await store.commitStagedLoopProposal({
        proposalId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
        authorizeReferences: ({ graph, session }) => requireWorkflowSkillReferences({
          graph,
          context,
          session,
        }),
      });
      return {
        data: {
          workflow: productSafeWorkflow(result.workflow),
          revision: result.revision,
          proposal: productSafeStagedLoopProposal(result.proposal),
        },
        etag: result.etag,
      };
    },
    async dismissStagedLoopProposal({ proposalId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      await ready();
      if (builderProposalLifecycle?.dismiss) {
        return productSafeStagedLoopProposal(await builderProposalLifecycle.dismiss({
          proposalId, staged: true, idempotencyKey, request: clone(request), context,
        }));
      }
      return store.runIdempotentMutation({
        scope: `dismiss-staged-loop-proposal:${proposalId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, async (session) => {
        const proposal = await requireRepository(store, "builderProposals").get(proposalId, {
          workspaceId: context.workspaceId,
          session,
        });
        if (!proposal || proposal.kind !== "staged_loop_draft") {
          throw storeError("builder_proposal_not_found", "The staged Loop proposal was not found.");
        }
        if (proposal.createdBy !== context.userId) {
          throw storeError("builder_proposal_not_found", "The staged Loop proposal was not found.");
        }
        if (proposal.status !== "proposed" && proposal.status !== "invalid") {
          throw storeError("builder_proposal_state_invalid", "This staged Loop proposal can no longer be dismissed.", {
            status: proposal.status,
          });
        }
        const decidedAt = clock();
        const dismissed = await requireRepository(store, "builderProposals").patch(
          proposalId,
          { status: "dismissed", decidedAt },
          { workspaceId: context.workspaceId, session },
        );
        await requireRepository(store, "auditEvents").append({
          schemaVersion: "workbench-v1",
          auditEventId: idFactory("audit"),
          workspaceId: context.workspaceId,
          actorId: context.userId,
          action: "staged_loop_proposal.dismissed",
          entityKind: "builder_proposal",
          entityId: proposalId,
          createdAt: decidedAt,
        }, { session });
        return dismissed;
      });
    },
    async saveLoopRevision({ workflowId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      await requireWorkflowAccess({ workflowId, context, access: "edit" });
      const saveWorkflowRevision = loopDraftLifecycle?.saveWorkflowRevision?.bind(loopDraftLifecycle) ?? store.saveWorkflowRevision?.bind(store);
      if (typeof saveWorkflowRevision !== "function") {
        throw storeError("workflow_revision_unavailable", "Saving this Workflow revision is not available.");
      }
      const value = await saveWorkflowRevision({
        workflowId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
        authorizeReferences: ({ graph, session }) => requireWorkflowSkillReferences({
          graph,
          context,
          session,
        }),
      });
      return { data: { workflow: productSafeWorkflow(value.workflow), revision: value.revision }, etag: value.etag };
    },
    async recordLocalLoopTrial({ workflowId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!loopDraftLifecycle?.recordLocalLoopTrial) throw storeError("local_loop_trial_unavailable", "Local trial evidence is not available.");
      return loopDraftLifecycle.recordLocalLoopTrial({ workflowId, idempotencyKey, ifMatch, request,
        workspaceId: context.workspaceId, reviewedBy: context.userId });
    },
    async publishNativeLoop({ workflowId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!loopDraftLifecycle?.publishNativeLoop || !nativeSkillPackageReader) throw storeError("native_loop_unavailable", "Native Loop publication is unavailable.");
      return loopDraftLifecycle.publishNativeLoop({ workflowId, idempotencyKey, ifMatch, request,
        workspaceId: context.workspaceId, userId: context.userId, readSkillPackage: input => nativeSkillPackageReader.read(input) });
    },
    async getNativeLoopPackage({ releaseId, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!loopDraftLifecycle?.getNativeLoopPackage || !nativeSkillPackageReader) throw storeError("native_loop_unavailable", "Native Loop download is unavailable.");
      return loopDraftLifecycle.getNativeLoopPackage({ releaseId, workspaceId: context.workspaceId, userId: context.userId,
        readSkillPackage: input => nativeSkillPackageReader.read(input) });
    },
    async publishLoop({ workflowId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      const publishLoop = loopDraftLifecycle?.publishLoop?.bind(loopDraftLifecycle) ?? store.publishLoop?.bind(store);
      if (typeof publishLoop !== "function") {
        throw storeError("loop_publish_unavailable", "Loop publication is not available.");
      }
      await requireWorkflowAccess({ workflowId, context, access: "publish" });
      return publishLoop({
        workflowId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        releasedBy: context.userId,
        authorizeReferences: ({ graph, session }) => requireWorkflowSkillReferences({
          graph,
          context,
          session,
        }),
      });
    },
    async listTeamLibrary({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      const listTeamLibrary = teamLibraryReadModel?.list?.bind(teamLibraryReadModel) ?? store.listTeamLibrary?.bind(store);
      if (typeof listTeamLibrary !== "function") {
        throw storeError("team_library_unavailable", "The Team library is not available.");
      }
      return resultPage(await listTeamLibrary({ workspaceId: context.workspaceId, query }));
    },
    async getNativeSkillPackage({ releaseId, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!nativeSkillPackageReader) throw storeError("native_skill_package_unavailable", "Native Skill download is not available.");
      return nativeSkillPackageReader.read({ workspaceId: context.workspaceId, userId: context.userId, releaseId });
    },
    async listSystemCatalog({ query = {}, auth } = {}) {
      await resolveAuth(auth);
      if (typeof teamLibraryReadModel?.listSystemCatalog !== "function") {
        throw storeError("system_catalog_unavailable", "The system catalog is not available.");
      }
      return resultPage(await teamLibraryReadModel.listSystemCatalog(query));
    },
    async installRelease({ releaseId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      const installRelease = teamLibraryLifecycle?.installRelease?.bind(teamLibraryLifecycle) ?? store.installRelease?.bind(store);
      if (typeof installRelease !== "function") {
        throw storeError("team_library_unavailable", "The Team library is not available.");
      }
      return installRelease({
        releaseId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        installedBy: context.userId,
      });
    },
    async installDefaultSystemCatalog({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "admin");
      if (typeof systemCatalogService?.installDefaultPack !== "function") {
        throw storeError("system_catalog_unavailable", "The system catalog is not available.");
      }
      return systemCatalogService.installDefaultPack({
        workspaceId: context.workspaceId,
        installedBy: context.userId,
        idempotencyKey,
        request,
      });
    },
    async getInstallation({ installationId, auth }) {
      const context = await resolveAuth(auth);
      const installation = teamLibraryReadModel?.getInstallation
        ? await teamLibraryReadModel.getInstallation({ workspaceId: context.workspaceId, installationId })
        : await requireRepository(store, "assetInstallations").get(installationId, {
          workspaceId: context.workspaceId,
        });
      if (!installation) throw storeError("installation_not_found", "Installed item not found.", { installationId });
      return installation;
    },
    async listInstallations({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      const installations = teamLibraryReadModel?.listInstallations
        ? await teamLibraryReadModel.listInstallations({ workspaceId: context.workspaceId, query })
        : await requireRepository(store, "assetInstallations").list({
          workspaceId: context.workspaceId,
          ...query,
        });
      return resultPage(installations);
    },
    async getInstallationUpdateImpact({ installationId, query, auth }) {
      const context = await resolveAuth(auth);
      const getInstallationUpdateImpact = teamLibraryLifecycle?.getInstallationUpdateImpact
        ?? store.getInstallationUpdateImpact?.bind(store);
      if (typeof getInstallationUpdateImpact !== "function") {
        throw storeError("team_library_unavailable", "Update impact is not available.");
      }
      const impact = await getInstallationUpdateImpact({
        installationId,
        releaseId: query.releaseId,
        workspaceId: context.workspaceId,
      });
      return {
        ...impact,
        affectedObjects: await filterReadableWorkflowReferences({
          references: impact.affectedObjects,
          context,
          idFor: (reference) => reference?.objectKind === "loop" ? reference.objectId : null,
        }),
      };
    },
    async createInstallationUpdateDraft({ installationId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      const createInstallationUpdateDraft = teamLibraryLifecycle?.createInstallationUpdateDraft
        ?? store.createInstallationUpdateDraft?.bind(store);
      if (typeof createInstallationUpdateDraft !== "function") {
        throw storeError("team_library_unavailable", "Update drafts are not available.");
      }
      return createInstallationUpdateDraft({
        installationId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        createdBy: context.userId,
      });
    },
    async getInstallationUpdateDraft({ updateDraftId, auth }) {
      const context = await resolveAuth(auth);
      const draft = teamLibraryReadModel?.getUpdateDraft
        ? await teamLibraryReadModel.getUpdateDraft({ workspaceId: context.workspaceId, updateDraftId, createdBy: context.userId })
        : await requireRepository(store, "installationUpdateDrafts").get(
          updateDraftId,
          { workspaceId: context.workspaceId },
        );
      if (!draft || (!teamLibraryReadModel?.getUpdateDraft && draft.createdBy !== context.userId)) {
        throw storeError("installation_update_draft_not_found", "Update draft not found.", { updateDraftId });
      }
      return draft;
    },
    async refreshInstallationUpdateDraft({ updateDraftId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      const refreshInstallationUpdateDraft = teamLibraryLifecycle?.refreshInstallationUpdateDraft
        ?? store.refreshInstallationUpdateDraft?.bind(store);
      if (typeof refreshInstallationUpdateDraft !== "function") {
        throw storeError("team_library_unavailable", "Update drafts are not available.");
      }
      return refreshInstallationUpdateDraft({
        updateDraftId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        refreshedBy: context.userId,
      });
    },
    async confirmInstallationUpdateDraft({ updateDraftId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      const confirmInstallationUpdateDraft = teamLibraryLifecycle?.confirmInstallationUpdateDraft
        ?? store.confirmInstallationUpdateDraft?.bind(store);
      if (typeof confirmInstallationUpdateDraft !== "function") {
        throw storeError("team_library_unavailable", "Update drafts are not available.");
      }
      return confirmInstallationUpdateDraft({
        updateDraftId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        confirmedBy: context.userId,
      });
    },
    async keepCurrentInstallationVersion({ updateDraftId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      const keepCurrentInstallationVersion = teamLibraryLifecycle?.keepCurrentInstallationVersion
        ?? store.keepCurrentInstallationVersion?.bind(store);
      if (typeof keepCurrentInstallationVersion !== "function") {
        throw storeError("team_library_unavailable", "Update drafts are not available.");
      }
      return keepCurrentInstallationVersion({
        updateDraftId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        decidedBy: context.userId,
      });
    },
    async listTemplates({ query = {}, auth } = {}) {
      await resolveAuth(auth);
      await ready();
      return resultPage(compatibilityCatalogReadModel?.listTemplates
        ? await compatibilityCatalogReadModel.listTemplates({ query })
        : await requireRepository(store, "templates").list(query));
    },
    async getTemplate({ templateId, auth }) {
      await resolveAuth(auth);
      await ready();
      const value = compatibilityCatalogReadModel?.getTemplate
        ? await compatibilityCatalogReadModel.getTemplate({ templateId })
        : await requireRepository(store, "templates").get(templateId);
      if (!value) throw storeError("template_not_found", "Template not found.", { templateId });
      return value;
    },
    async listWorkflows({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      const workflows = workflowReadModel
        ? await workflowReadModel.listWorkflows({ workspaceId: context.workspaceId, query })
        : await requireRepository(store, "workflows").list({ workspaceId: context.workspaceId, ...query });
      const visibility = await Promise.all(
        workflows.map((workflow) => canReadWorkflow(workflow, context)),
      );
      const visibleWorkflows = workflows.filter((_workflow, index) => visibility[index]);
      return resultPage(await Promise.all(visibleWorkflows.map(projectWorkflowLatestRun)));
    },
    async listRecentWork({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      if (!runner?.listRecentRuns) {
        throw storeError("runner_unavailable", "Recent work is unavailable.");
      }
      const runs = await runner.listRecentRuns(context.workspaceId, {
        limit: Math.min(query.limit || 3, 10),
      });
      const items = (await Promise.all(runs.map(async (run) => {
        const value = await loadWorkflow(run.workflowId, { workspaceId: context.workspaceId });
        if (!await canReadWorkflow(value.workflow, context)) return null;
        return {
          runId: run.runId,
          workflowId: run.workflowId,
          title: value.workflow.name,
          status: run.status,
          updatedAt: run.updatedAt,
        };
      }))).filter(Boolean);
      return resultPage(items);
    },
    async getWorkflow({ workflowId, auth }) {
      const context = await resolveAuth(auth);
      const value = await requireWorkflowAccess({ workflowId, context, access: "read" });
      return { data: await projectWorkflowLatestRun(value.workflow), etag: value.etag };
    },
    async getWorkflowRevision({ workflowId, revisionId, auth }) {
      const context = await resolveAuth(auth);
      await requireWorkflowAccess({ workflowId, context, access: "read" });
      const revision = await getWorkflowRevision(workflowId, revisionId, { workspaceId: context.workspaceId });
      const workflow = await requireWorkflowAccess({ workflowId, context, access: "read" });
      return { data: revision, etag: workflow.etag };
    },
    async saveWorkflowRevision({ workflowId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      await requireWorkflowAccess({ workflowId, context, access: "edit" });
      const saveWorkflowRevision = loopDraftLifecycle?.saveWorkflowRevision?.bind(loopDraftLifecycle) ?? store.saveWorkflowRevision?.bind(store);
      if (typeof saveWorkflowRevision !== "function") {
        throw storeError("workflow_revision_unavailable", "Saving this Workflow revision is not available.");
      }
      const value = await saveWorkflowRevision({
        workflowId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
        authorizeReferences: ({ graph, session }) => requireWorkflowSkillReferences({
          graph,
          context,
          session,
        }),
      });
      return { data: { workflow: productSafeWorkflow(value.workflow), revision: value.revision }, etag: value.etag };
    },
    async compileWorkflow({ workflowId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      await requireWorkflowAccess({ workflowId, context, access: "edit" });
      if (workflowCompileLifecycle?.compileWorkflow) {
        const result = await workflowCompileLifecycle.compileWorkflow({
          workflowId,
          revisionId: request.data.workflowRevisionId,
          idempotencyKey,
          request,
          workspaceId: context.workspaceId,
          compiledBy: context.userId,
        });
        const { compileResultId, executionPlanId, ...publicResult } = result;
        return publicResult;
      }
      if (typeof store.runIdempotentMutation !== "function") {
        throw new TypeError("workbench_idempotency_store_required");
      }
      return store.runIdempotentMutation({
        scope: "compile-workflow:" + workflowId,
        key: idempotencyKey,
        request: { workflowId, body: request },
        workspaceId: context.workspaceId,
        effectivePrincipalId: context.userId,
      }, async (session) => {
      const options = { session, workspaceId: context.workspaceId };
      const revisionId = request.data.workflowRevisionId;
      const revision = await getWorkflowRevision(workflowId, revisionId, options);
      if (revision.workflowId !== workflowId) {
        throw storeError("workflow_revision_not_found", "Workflow revision not found.", { workflowId, revisionId });
      }
      await ready();
      return compileRevision({ workflowId, revision, context, options });
      });
    },
    async startRun({ workflowId, idempotencyKey, request, requestId, auth }) {
      const context = await resolveAuth(auth, "member");
      await requireWorkflowAccess({ workflowId, context, access: "execute" });
      const revision = await getWorkflowRevision(workflowId, request.data.workflowRevisionId, { workspaceId: context.workspaceId });
      await requireWorkflowSkillReferences({ graph: revision.graph, context });
      if (!runner?.startRun) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const authority = workflowCommandAuthorizer?.authorizeWorkflowRun
        ? await workflowCommandAuthorizer.authorizeWorkflowRun({
          workspaceId: context.workspaceId,
          userId: context.userId,
          workflowId,
          workflowRevisionId: request.data.workflowRevisionId,
          inputs: request.data.inputs,
          resourceRefs: request.data.resourceRefs,
          materialBindings: request.data.materialBindings,
        })
        : null;
      return runner.startRun({
        workflowId,
        ...request.data,
        workspaceId: context.workspaceId,
        idempotencyKey,
        requestId,
        requestedBy: context.userId,
        ...(authority ? { authorizationDecisionId: authority.authorizationDecisionId } : {}),
      });
    },
    async listWorkItemLoopRuns({ workItemId, auth }) {
      const context = await resolveAuth(auth);
      if (!workItemLifecycle?.listWorkflowRuns) throw storeError("team_work_unavailable", "Team work is unavailable.");
      return { ...resultPage(await workItemLifecycle.listWorkflowRuns({ context, workItemId })), responseHeaders: { "Cache-Control": "no-store" } };
    },
    async startWorkItemLoopRun({ workItemId, idempotencyKey, request, requestId, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!workItemLifecycle?.attachWorkflowRun || !runner?.startRunWithCompanion) throw storeError("team_work_unavailable", "Team workflow execution is unavailable.");
      if (request.data.shareFinalOutput !== true) throw storeError("work_item_run_forbidden", "Declare the shared result before execution.");
      await workItemLifecycle.requireWorkflowRunAccess({ context, workItemId });
      const { workflowId, shareFinalOutput, ...input } = request.data;
      await requireWorkflowAccess({ workflowId, context, access: "execute" });
      const revision = await getWorkflowRevision(workflowId, input.workflowRevisionId, { workspaceId: context.workspaceId });
      await requireWorkflowSkillReferences({ graph: revision.graph, context });
      const companionKind = `work-item:${workItemId}`;
      const authority = await workflowCommandAuthorizer.authorizeWorkflowRun({
        ...input, materialBindings: input.materialBindings ?? [], workspaceId: context.workspaceId,
        userId: context.userId, workflowId, companionKind,
      });
      const result = await runner.startRunWithCompanion({
        ...input, workflowId, requestedBy: context.userId, idempotencyKey, requestId,
        authorizationDecisionId: authority.authorizationDecisionId,
      }, { kind: companionKind, persist: ({ run, transactionSession }) => workItemLifecycle.attachWorkflowRun({
        context, workItemId, run, transactionSession,
      }) });
      return { data: result.companion, responseHeaders: { "Cache-Control": "no-store" } };
    },
    async startLoopAgentTask({ workflowId, idempotencyKey, request, requestId, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!runner?.startRunWithCompanion || !agentTurnRunner?.createSession) {
        throw storeError("agent_task_runner_unavailable", "Loop tasks are unavailable.");
      }
      const workflowValue = await loadWorkflow(workflowId, {
        workspaceId: context.workspaceId,
      });
      await requireWorkflowAccess({
        workflowId,
        context,
        access: "execute",
        value: workflowValue,
      });
      const revision = await getWorkflowRevision(workflowId, request.data.workflowRevisionId, { workspaceId: context.workspaceId });
      await requireWorkflowSkillReferences({ graph: revision.graph, context });
      const workflow = workflowValue?.workflow ?? workflowValue;
      const authority = store.persistenceDriver === "postgres"
        ? workflowCommandAuthorizer?.authorizeWorkflowRun
          ? await workflowCommandAuthorizer.authorizeWorkflowRun({
              workspaceId: context.workspaceId,
              userId: context.userId,
              workflowId,
              workflowRevisionId: request.data.workflowRevisionId,
              inputs: request.data.inputs,
              resourceRefs: request.data.resourceRefs,
              materialBindings: request.data.materialBindings,
              companionKind: "agent-session",
            })
          : null
        : null;
      if (store.persistenceDriver === "postgres" && !authority) {
        throw storeError(
          "workflow_run_authority_unavailable",
          "Workflow Run authority is not configured.",
          { workflowId },
        );
      }
      const result = await runner.startRunWithCompanion({
        workflowId,
        ...request.data,
        workspaceId: context.workspaceId,
        idempotencyKey,
        requestId,
        requestedBy: context.userId,
        ...(authority ? { authorizationDecisionId: authority.authorizationDecisionId } : {}),
      }, {
        kind: "agent-session",
        persist: ({ run, transactionSession }) => agentTurnRunner.createSession({
          definitionId: "main",
          title: workflow?.name || workflow?.title || "Loop run",
          source: {
            kind: "loop_run",
            workflowId,
            workflowRevisionId: run.workflowRevisionId,
            runId: run.runId,
          },
          userId: context.userId,
          workspaceId: context.workspaceId,
          transactionSession,
        }),
      });
      return {
        session: await projectAgentSession(result.companion),
        run: result.run,
      };
    },
    async listWorkflowRuns({ workflowId, query = {}, auth }) {
      const context = await resolveAuth(auth);
      await requireWorkflowAccess({ workflowId, context, access: "read" });
      if (!runner?.listRuns) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      return resultPage(await runner.listRuns(workflowId, query));
    },
    async getRun({ runId, auth }) {
      const context = await resolveAuth(auth);
      if (!runner?.getRun) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const value = await runner.getRun(runId);
      await requireWorkflowAccess({ workflowId: value.run.workflowId, context, access: "read" });
      return value;
    },
    async listRunInvocations({ runId, auth }) {
      const context = await resolveAuth(auth);
      if (!runner?.getRun || !executionBroker?.listInvocations) throw storeError("runner_unavailable", "Run execution details are unavailable.");
      const run = await runner.getRun(runId);
      await requireWorkflowAccess({ workflowId: run.run.workflowId, context, access: "read" });
      const invocations = await executionBroker.listInvocations({ workspaceId: context.workspaceId, controllerId: runId, limit: 500 });
      return resultPage(invocations.map(productSafeInvocation));
    },
    async listRunExecutionEvents({ runId, query = {}, auth }) {
      const context = await resolveAuth(auth);
      if (!runner?.getRun || !executionBroker?.listEvents) throw storeError("runner_unavailable", "Run execution events are unavailable.");
      const run = await runner.getRun(runId);
      await requireWorkflowAccess({ workflowId: run.run.workflowId, context, access: "read" });
      const invocations = await executionBroker.listInvocations({ workspaceId: context.workspaceId, controllerId: runId, limit: 500 });
      const events = await executionBroker.listEvents(
        invocations.map((invocation) => invocation.invocationId),
        query.after ?? 0,
        query.limit ?? 500,
      );
      // The Product timeline exposes lifecycle metadata only. Raw Worker
      // payloads may contain private tool arguments, paths or provider data.
      return resultPage(events.map((event) => ({
        schemaVersion: event.schemaVersion, eventId: event.eventId,
        invocationId: event.invocationId, attemptId: event.attemptId,
        sequence: event.sequence, type: event.type, status: event.status,
        occurredAt: event.occurredAt, payload: {},
      })));
    },
    async submitReviewDecision({ runId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!runner?.submitReviewDecision) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const run = await runner.getRun(runId);
      await requireWorkflowAccess({ workflowId: run.run.workflowId, context, access: "review" });
      const authority = request.data.decision === "reject"
        ? workflowCommandAuthorizer?.authorizeWorkflowRunCancellation
          ? await workflowCommandAuthorizer.authorizeWorkflowRunCancellation({
              workspaceId: context.workspaceId,
              userId: context.userId,
              runId,
              nodeId: request.data.nodeId,
              ...(request.data.expectedNodeRunId === undefined ? {} : { expectedNodeRunId: request.data.expectedNodeRunId }),
              decision: request.data.decision,
              comment: request.data.comment,
              requestedChanges: request.data.requestedChanges,
            })
          : null
        : workflowCommandAuthorizer?.authorizeWorkflowRunReview
          ? await workflowCommandAuthorizer.authorizeWorkflowRunReview({
            workspaceId: context.workspaceId,
            userId: context.userId,
            runId,
            nodeId: request.data.nodeId,
            ...(request.data.expectedNodeRunId === undefined ? {} : { expectedNodeRunId: request.data.expectedNodeRunId }),
            decision: request.data.decision,
            comment: request.data.comment,
            requestedChanges: request.data.requestedChanges,
          })
          : null;
      const result = await runner.submitReviewDecision({
        runId,
        ...request.data,
        idempotencyKey,
        decidedBy: context.userId,
        ...(authority ? { authorizationDecisionId: authority.authorizationDecisionId } : {}),
        ...(request.data.decision === "reject" ? { authorizationAction: "workflow_run_cancel" } : {}),
      });
      if (store.persistenceDriver !== "postgres") return result;
      const current = await runner.getRun(runId);
      const decision = current.run.reviewDecisions.find(item => item.decisionId === result.decision.decisionId);
      if (!decision) throw storeError("workflow_review_receipt_missing", "The review receipt is not available yet.");
      return { decision, run: current.run };
    },
    async cancelRun({ runId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!runner?.cancelRun) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const current = await runner.getRun(runId);
      await requireWorkflowAccess({ workflowId: current.run.workflowId, context, access: "manage" });
      const authority = store.persistenceDriver === "postgres"
        ? workflowCommandAuthorizer?.authorizeWorkflowRunCancellationRequest
          ? await workflowCommandAuthorizer.authorizeWorkflowRunCancellationRequest({
              workspaceId: context.workspaceId,
              userId: context.userId,
              runId,
              reason: request.data.reason,
            })
          : null
        : null;
      if (store.persistenceDriver === "postgres" && !authority) {
        throw storeError(
          "workflow_run_cancellation_unavailable",
          "Workflow Run cancellation authority is not configured.",
          { runId },
        );
      }
      const run = await runner.cancelRun({
        runId,
        idempotencyKey,
        requestedBy: context.userId,
        reason: request.data.reason,
        ...(authority ? {
          authorizationDecisionId: authority.authorizationDecisionId,
          authorizationScopeId: authority.scopeId,
          authorizationAction: "workflow_run_cancel",
        } : {}),
      });
      return { runId: run.runId };
    },
    async retryRun({ runId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!runner?.retryRun) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const current = await runner.getRun(runId);
      await requireWorkflowAccess({ workflowId: current.run.workflowId, context, access: "manage" });
      const revision = await getWorkflowRevision(
        current.run.workflowId,
        current.run.workflowRevisionId,
        { workspaceId: context.workspaceId },
      );
      await requireWorkflowSkillReferences({ graph: revision.graph, context });
      const authority = store.persistenceDriver === "postgres"
        ? workflowCommandAuthorizer?.authorizeWorkflowRunRetry
          ? await workflowCommandAuthorizer.authorizeWorkflowRunRetry({
              workspaceId: context.workspaceId,
              userId: context.userId,
              runId,
              reason: request.data.reason,
            })
          : null
        : null;
      if (store.persistenceDriver === "postgres" && !authority) {
        throw storeError(
          "workflow_run_retry_authority_unavailable",
          "Workflow Run retry authority is not configured.",
          { runId },
        );
      }
      const run = await runner.retryRun({
        runId,
        idempotencyKey,
        requestedBy: context.userId,
        reason: request.data.reason,
        ...(authority ? { authorizationDecisionId: authority.authorizationDecisionId } : {}),
      });
      return { runId: run.runId };
    },
    async getInbox({ query = {}, auth }) {
      const context = await resolveAuth(auth);
      if (inboxReadModel?.list) return inboxReadModel.list({ workspaceId: context.workspaceId, userId: context.userId, query });
      await ready();
      const workspaceId = context.workspaceId;
      const createdAt = (record) => (
        record?.createdAt
        ?? record?.updatedAt
        ?? STABLE_SYSTEM_INBOX_TIME
      );
      const [
        agentProposals,
        mergeConflicts,
        builderProposals,
        updateDrafts,
        connections,
        runs,
        modelProfiles,
      ] = await Promise.all([
        listInboxRecords(requireRepository(store, "agentObjectProposals"), {
          workspaceId,
          userId: context.userId,
          status: { $in: ["proposed", "conflicting"] },
        }),
        listInboxRecords(requireRepository(store, "mergeConflicts"), {
          workspaceId,
          status: "open",
        }),
        listInboxRecords(requireRepository(store, "builderProposals"), {
          workspaceId,
          createdBy: context.userId,
          status: { $in: ["proposed", "conflicted"] },
        }),
        listInboxRecords(requireRepository(store, "installationUpdateDrafts"), {
          workspaceId,
          createdBy: context.userId,
          status: { $in: ["pending_review", "ready", "conflicted"] },
        }),
        ["owner", "admin"].includes(context.role)
          ? listInboxRecords(requireRepository(store, "connections"), {
              workspaceId,
              $or: [
                { status: { $in: ["needs_setup", "checking"] } },
                { "validation.status": { $in: ["never_checked", "checking", "invalid"] } },
                { credentialState: { $in: ["unbound", "expired"] } },
              ],
            })
          : [],
        listInboxRuns(requireRepository(store, "runs"), workspaceId),
        modelCatalog?.listProfiles
          ? modelCatalog.listProfiles({ workspaceId, userId: context.userId, includeDisabled: true })
          : [],
      ]);
      const ownedProposalIds = new Set(agentProposals.map((proposal) => proposal.proposalId));
      const items = [];
      for (const proposal of agentProposals) {
        items.push(inboxItem({
          workspaceId,
          objectKind: "proposal",
          objectId: proposal.proposalId,
          reason: proposal.status === "conflicting" ? "proposal_conflict" : "review_required",
          severity: proposal.status === "conflicting" ? "critical" : "warning",
          title: proposal.status === "conflicting" ? "Agent proposal has conflicts" : "Agent proposal needs review",
          actionRoute: agentProposalActionRoute(proposal),
          createdAt: createdAt(proposal),
        }));
      }
      for (const conflict of mergeConflicts.filter((item) => ownedProposalIds.has(item.proposalId))) {
        items.push(inboxItem({
          workspaceId,
          objectKind: "merge_conflict",
          objectId: conflict.mergeConflictId,
          reason: "merge_conflict",
          severity: "critical",
          title: "A draft merge conflict needs attention",
          actionRoute: agentProposalActionRoute(
            agentProposals.find((proposal) => proposal.proposalId === conflict.proposalId),
          ),
          createdAt: createdAt(conflict),
        }));
      }
      for (const proposal of builderProposals) {
        const staged = proposal.kind === "staged_loop_draft";
        items.push(inboxItem({
          workspaceId,
          objectKind: "proposal",
          objectId: proposal.proposalId,
          reason: proposal.status === "conflicted" ? "proposal_conflict" : "review_required",
          severity: proposal.status === "conflicted" ? "critical" : "warning",
          title: proposal.status === "conflicted" ? "Loop proposal has conflicts" : "Loop proposal needs review",
          actionRoute: staged
            ? `/loops/new?proposal=${encodeURIComponent(proposal.proposalId)}`
            : `/loops/${encodeURIComponent(proposal.workflowId)}/edit?proposal=${encodeURIComponent(proposal.proposalId)}`,
          createdAt: createdAt(proposal),
        }));
      }
      for (const draft of updateDrafts) {
        items.push(inboxItem({
          workspaceId,
          objectKind: "installation_update",
          objectId: draft.updateDraftId,
          reason: "library_update_review",
          severity: draft.status === "conflicted" ? "critical" : "warning",
          title: draft.status === "conflicted"
            ? "A Team Library update needs rebasing"
            : "A Team Library update needs review",
          actionRoute: `/library?updateDraftId=${encodeURIComponent(draft.updateDraftId)}`,
          createdAt: createdAt(draft),
        }));
      }
      for (const connection of connections) {
        const invalid = connection.validation?.status === "invalid" || connection.credentialState === "expired";
        items.push(inboxItem({
          workspaceId,
          objectKind: "connection",
          objectId: connection.connectionId,
          reason: invalid ? "connection_invalid" : "connection_missing",
          severity: invalid ? "critical" : "warning",
          title: invalid ? "A connection is invalid" : "A connection needs setup",
          actionRoute: `/library?connectionId=${encodeURIComponent(connection.connectionId)}&requirementId=${encodeURIComponent(connection.capabilityKey)}`,
          createdAt: createdAt(connection),
        }));
      }
      const readableRuns = [];
      for (const run of runs) {
        try {
          await requireWorkflowAccess({ workflowId: run.workflowId, context, access: "read" });
          readableRuns.push(run);
        } catch (error) {
          if (error?.code !== "workflow_not_found") throw error;
        }
      }
      for (const run of readableRuns.filter((item) => ["waiting_review", "blocked", "failed"].includes(item.status))) {
        const waiting = run.status === "waiting_review";
        items.push(inboxItem({
          workspaceId,
          objectKind: waiting ? "review" : "run",
          objectId: run.runId,
          reason: waiting ? "review_required" : run.status === "blocked" ? "run_blocked" : "run_failed",
          severity: run.status === "failed" ? "critical" : "warning",
          title: waiting ? "A run needs review" : run.status === "blocked" ? "A run is blocked" : "A run failed",
          actionRoute: `/loops/${encodeURIComponent(run.workflowId)}/runs/${encodeURIComponent(run.runId)}`,
          createdAt: createdAt(run),
        }));
      }
      for (const profile of modelProfiles.filter((item) => item.enabled && !item.selectable)) {
        items.push(inboxItem({
          workspaceId,
          objectKind: "model",
          objectId: profile.profileId,
          reason: "model_unavailable",
          severity: "warning",
          title: unavailableModelTitle(profile.displayName),
          actionRoute: `/library?setup=models&profileId=${encodeURIComponent(profile.profileId)}`,
          createdAt: createdAt(profile),
        }));
      }
      for (const runtime of (Array.isArray(skillRuntimeCatalog) ? skillRuntimeCatalog : [])) {
        const runtimeReady = runtime.availability === "ready"
          || runtime.readiness?.status === "ready";
        if (runtimeReady) continue;
        const runtimeId = runtime.runtimeId ?? runtime.id ?? "skill-runtime";
        items.push(inboxItem({
          workspaceId,
          objectKind: "runtime",
          objectId: runtimeId,
          reason: "runtime_unavailable",
          severity: "warning",
          title: `${runtime.label ?? runtimeId} is unavailable`,
          actionRoute: `/skills/new?mode=define&setup=runtime&runtimeId=${encodeURIComponent(runtimeId)}`,
          createdAt: createdAt(runtime),
        }));
      }
      items.sort((left, right) => (
        right.createdAt.localeCompare(left.createdAt)
        || right.itemId.localeCompare(left.itemId)
      ));
      const cursor = decodeInboxCursor(query.cursor);
      const remaining = cursor
        ? items.filter((item) => (
          item.createdAt < cursor.createdAt
          || (item.createdAt === cursor.createdAt && item.itemId < cursor.itemId)
        ))
        : items;
      const limit = Math.max(1, Math.min(Number(query.limit) || 50, 100));
      const pageItems = remaining.slice(0, limit);
      const hasMore = remaining.length > limit;
      return {
        data: {
          items: pageItems,
          count: items.length,
          page: {
            nextCursor: hasMore ? encodeInboxCursor(pageItems.at(-1)) : null,
            hasMore,
          },
        },
        responseHeaders: { "Cache-Control": "private, no-store" },
      };
    },
    async getProductTrace({ productCommandId, auth }) {
      const context = await resolveAuth(auth);
      await ready();
      return buildProductTrace({
        store,
        productCommandId,
        userId: context.userId,
        workspaceId: context.workspaceId,
      });
    },
    async listEvents({ runId, after, auth }) {
      const context = await resolveAuth(auth);
      if (!runner?.listEvents) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const run = await runner.getRun(runId);
      await requireWorkflowAccess({ workflowId: run.run.workflowId, context, access: "read" });
      return runner.listEvents(runId, after);
    },
    async subscribe(runId, listener, auth) {
      const context = await resolveAuth(auth);
      if (!runner?.subscribe) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const run = await runner.getRun(runId);
      await requireWorkflowAccess({ workflowId: run.run.workflowId, context, access: "read" });
      return runner.subscribe(runId, listener);
    },
  });
}

function decodeBase64(value) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw storeError("request_invalid", "Package file content is not valid base64.");
  }
  return bytes;
}
