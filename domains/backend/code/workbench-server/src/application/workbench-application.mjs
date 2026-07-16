import {
  Check,
  LifecycleBuilderProposalSchema,
} from "@looloomi/workbench-contracts";

import { listBuiltinAgentDefinitions } from "../agents/index.mjs";
import {
  compileWorkflowV1,
} from "../compiler/index.mjs";
import { createWorkspaceConnectionService } from "../connections/workspace-connection-service.mjs";
import {
  formatPortableLoopPackage,
  hashPortableLoopPackage,
  portableLoopPackageFilename,
  projectPortableLoopPackage,
} from "../loops/portable-loop-package.mjs";
import { applyBuilderOperations } from "../proposals/index.mjs";
import { mergeWorkflowProposal } from "../proposals/three-way-proposal-merge.mjs";
import { ProductStoreError, canonicalRequestHash, formatSkillDraftEtag } from "../store/index.mjs";
import {
  resolvePinnedSkill,
  resolvePinnedSkillDefinition,
} from "../skills/published-skill-definition.mjs";

const PAGE = Object.freeze({ nextCursor: null, hasMore: false });
const clone = (value) => structuredClone(value);

const storeError = (code, message, details = {}) => new ProductStoreError(code, message, details);

function resultPage(value) {
  if (Array.isArray(value)) return { data: value, page: PAGE };
  return { data: value.data ?? value.items ?? [], page: value.page ?? PAGE };
}

function productSafeInvocation(invocation) {
  return {
    invocationId: invocation.invocationId,
    attemptId: invocation.attemptId,
    mode: invocation.mode,
    isolation: invocation.isolation,
    status: invocation.status,
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
    status: skill.status,
    inputSchema: clone(skill.inputSchema),
    outputSchema: clone(skill.outputSchema),
    risk: clone(skill.risk),
    dependencies: clone(skill.dependencies ?? []),
    setupChecks: clone(skill.setupChecks ?? []),
    usageCount: skill.usageCount ?? 0,
    readiness: clone(skill.readiness),
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

function productSafeSkillRecord(skill, userId) {
  const allowedActions = [];
  if (skill.ownerId === userId && skill.lifecycle === "draft") {
    allowedActions.push("edit", "publish");
  } else if (skill.ownerId === userId && skill.lifecycle === "ready" && skill.latestPublishedVersionId) {
    allowedActions.push("create_version", "retire");
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

function productSafeRunComparisonEntry({ run, readModel, internalRun }) {
  const skillVersions = [...new Set(
    (internalRun?.executionSnapshot?.skillVersions ?? [])
      .map((version) => version?.version)
      .filter((version) => typeof version === "string"),
  )].sort();
  return {
    runId: run.runId,
    workflowRevisionId: run.workflowRevisionId,
    status: run.status,
    skillVersions,
    reviewed: Boolean(readModel?.reviewDecisions?.length || run.reviewDecisions?.length),
    finalAnswer: readModel?.finalAnswer ?? null,
    finishedAt: run.finishedAt,
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
    return {
      revision: clone(revision),
      compileResult: clone(compileResult),
      skills: pinnedSkills,
      skillVersions,
      resources,
      connectionIds: [...new Set(connectionBindings.map((binding) => binding.connectionId))].sort(),
      workspaceId: workflow?.workspaceId ?? null,
    };
  };
}

export function createWorkbenchApplication({
  store,
  agentRuntime,
  executionBroker = null,
  agentTurnRunner = null,
  runner,
  skillUploadService = null,
  skillValidationService = null,
  textResourceService = null,
  trustedSkillActivationRegistry = null,
  clock = () => new Date().toISOString(),
  idFactory = (kind) => `${kind}-${crypto.randomUUID()}`,
  workspaceId = "workspace-local",
  userId = "user-local",
} = {}) {
  if (!store || typeof store.connect !== "function") throw new TypeError("workbench_store_required");

  const ready = () => store.connect();
  const connectionService = createWorkspaceConnectionService({ store, clock, idFactory });
  const runExternalMutation = (options, mutation) => {
    if (typeof store.runIdempotentExternalMutation !== "function") {
      throw new TypeError("workbench_external_idempotency_required");
    }
    return store.runIdempotentExternalMutation(options, (operationId) => mutation(operationId));
  };
  const resolveAuth = async (auth, minimumRole = "viewer") => {
    const context = {
      userId: auth?.userId ?? userId,
      workspaceId: auth?.activeWorkspaceId ?? auth?.workspaceId ?? workspaceId,
    };
    if (auth && typeof store.authorizeWorkspace === "function") {
      await store.authorizeWorkspace({
        userId: context.userId,
        workspaceId: context.workspaceId,
        minimumRole,
      });
    }
    return context;
  };
  const getWorkflowRevision = async (workflowId, revisionId, options = {}) => {
    await ready();
    const revision = await requireRepository(store, "workflowRevisions").get(workflowId, revisionId, options);
    if (!revision) throw storeError("workflow_revision_not_found", "Workflow revision not found.", { workflowId, revisionId });
    return revision;
  };
  const compileRevision = async ({ workflowId, revision, context, options = {} }) => {
    if (!agentRuntime || typeof agentRuntime.probeSkill !== "function") {
      throw storeError("agent_runtime_unavailable", "Skill readiness service is unavailable.");
    }
    const refs = [...new Map(
      revision.graph.nodes.filter((node) => node.kind === "Skill")
        .map((node) => [`${node.skillRef.skillId}:${node.skillRef.version}`, node.skillRef]),
    ).values()];
    const resolved = await Promise.all(refs.map(async (ref) => {
      const definition = await resolvePinnedSkillDefinition({
        repositories: store.repositories,
        skillRef: ref,
        workspaceId: context.workspaceId,
        options,
      });
      const probe = definition
        ? await agentRuntime.probeSkill(definition.executionRef, { workspaceId: context.workspaceId })
        : { status: "blocked", ready: false, code: "skill_definition_not_found" };
      const readiness = readinessFromProbe(probe);
      return [`${ref.skillId}:${ref.version}`, { definition, adapterReadiness: readiness, piReadiness: readiness }];
    }));
    const byRef = new Map(resolved);
    const resourceEntries = await Promise.all((revision.resourceRefs ?? []).map(async (ref) => [
      `${ref.resourceId}:${ref.version}`,
      await requireRepository(store, "resources").get(ref.resourceId, { workspaceId: context.workspaceId, ...options }),
    ]));
    const resources = new Map(resourceEntries);
    const compileResult = compileWorkflowV1(clone(revision), {
      compiledAt: clock(),
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
      const stored = await requireRepository(store, "workspaces").get(context.workspaceId);
      return {
        workspace: {
          workspaceId: context.workspaceId,
          name: stored?.name ?? "Local workspace",
          capabilities: { builderProposal: false, resources: false, maxParallelism: 1 },
          createdAt: now,
          updatedAt: now,
        },
      };
    },
    async getActiveSession({ auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      const [workspace, membership] = await Promise.all([
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
    async listAgentDefinitions({ auth } = {}) {
      await resolveAuth(auth);
      return resultPage(listBuiltinAgentDefinitions());
    },
    async createAgentSession({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!agentTurnRunner) throw storeError("agent_turn_runner_unavailable", "Agent session service is unavailable.");
      return store.runIdempotentMutation({
        scope: `create-agent-session:${context.userId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
      }, () => agentTurnRunner.createSession({
        ...request.data,
        userId: context.userId,
        workspaceId: context.workspaceId,
      }));
    },
    async getAgentSession({ sessionId, auth }) {
      const context = await resolveAuth(auth);
      const session = await agentTurnRunner?.getSession(sessionId, context);
      if (!session) throw storeError("agent_session_not_found", "Agent session not found.");
      return session;
    },
    async createAgentTurn({ sessionId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!agentTurnRunner) throw storeError("agent_turn_runner_unavailable", "Agent turn service is unavailable.");
      return store.runIdempotentMutation({
        scope: `create-agent-turn:${sessionId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
      }, () => agentTurnRunner.enqueueTurn({
        sessionId,
        message: request.data.message,
        ...context,
      }));
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
      return store.runIdempotentMutation({
        scope: `cancel-agent-turn:${turnId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
      }, () => agentTurnRunner.cancelTurn({ sessionId, turnId, reason: request.data.reason, ...context }));
    },
    async listAgentSessionEvents({ sessionId, query = {}, auth }) {
      const context = await resolveAuth(auth);
      const events = await agentTurnRunner?.listEvents(sessionId, query.after ?? 0, query.limit ?? 500, context);
      if (!events) throw storeError("agent_session_not_found", "Agent session not found.");
      return resultPage(events);
    },
    async listAgentHandoffs({ sessionId, auth }) {
      const context = await resolveAuth(auth);
      if (!agentTurnRunner) throw storeError("agent_turn_runner_unavailable", "Agent handoff service is unavailable.");
      return resultPage(await agentTurnRunner.listHandoffs({ sessionId, ...context }));
    },
    async confirmAgentHandoff({ sessionId, handoffId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!agentTurnRunner) throw storeError("agent_turn_runner_unavailable", "Agent handoff service is unavailable.");
      return store.runIdempotentMutation({
        scope: `confirm-agent-handoff:${handoffId}`,
        key: idempotencyKey,
        request: clone(request),
        workspaceId: context.workspaceId,
      }, () => agentTurnRunner.confirmHandoff({ sessionId, handoffId, ...context }));
    },
    async listMemberships({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      return resultPage(await requireRepository(store, "memberships").listByWorkspace(
        context.workspaceId,
        query,
      ));
    },
    async addMembership({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "owner");
      if (typeof store.addWorkspaceMembership !== "function") {
        throw storeError("membership_management_unavailable", "Workspace member management is not available.");
      }
      return store.addWorkspaceMembership({
        workspaceId: context.workspaceId,
        addedBy: context.userId,
        idempotencyKey,
        ...request.data,
      });
    },
    async listSkills({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      const skills = await requireRepository(store, "skills").list({ ...query, workspaceId: context.workspaceId });
      return resultPage(skills.map(productSafeSkillDefinition));
    },
    async getSkill({ skillId, auth }) {
      const context = await resolveAuth(auth);
      await ready();
      const value = await requireRepository(store, "skills").get(skillId, { workspaceId: context.workspaceId });
      if (!value) throw storeError("skill_not_found", "Skill not found.", { skillId });
      return productSafeSkillDefinition(value);
    },
    async createSkill({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof store.createSkill !== "function") {
        throw storeError("skill_creation_unavailable", "Skill creation is not available.");
      }
      let trustedActivation = null;
      if (request.data.uploadId) {
        const upload = await requireRepository(store, "uploads").get(request.data.uploadId, {
          workspaceId: context.workspaceId,
        });
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
      const value = await store.createSkill({
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
        trustedActivation,
      });
      return {
        skill: productSafeSkillRecord(value.skill, context.userId),
        draft: productSafeSkillDraft(value.draft),
      };
    },
    async listSkillAssets({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      const [skills, drafts, versions] = await Promise.all([
        requireRepository(store, "skillAssets").list({ ...query, workspaceId: context.workspaceId }),
        requireRepository(store, "skillDrafts").list({ workspaceId: context.workspaceId }),
        requireRepository(store, "skillVersions").list({ workspaceId: context.workspaceId }),
      ]);
      const draftsById = new Map(drafts.map((draft) => [draft.skillDraftId, draft]));
      const versionsById = new Map(versions.map((version) => [version.skillVersionId, version]));
      return resultPage(skills.map((skill) => ({
        skill: productSafeSkillRecord(skill, context.userId),
        draft: productSafeSkillDraft(
          skill.currentDraftId ? draftsById.get(skill.currentDraftId) ?? null : null,
        ),
        latestVersion: skill.latestPublishedVersionId
          ? productSafePublishedSkillVersion(versionsById.get(skill.latestPublishedVersionId) ?? null)
          : null,
      })));
    },
    async getSkillDraft({ skillId, draftId, auth }) {
      const context = await resolveAuth(auth);
      if (typeof store.getSkillDraft !== "function") {
        throw storeError("skill_draft_unavailable", "Skill drafts are not available.");
      }
      const value = await store.getSkillDraft({ skillId, draftId, workspaceId: context.workspaceId });
      return { data: productSafeSkillDraft(value.draft), etag: formatSkillDraftEtag(value.draft) };
    },
    async updateSkillDraft({ skillId, draftId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof store.updateSkillDraft !== "function") {
        throw storeError("skill_draft_unavailable", "Updating Skill details is not available.");
      }
      const value = await store.updateSkillDraft({
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
      if (!skillUploadService?.resolvePromotedPackage || typeof store.replaceSkillDraftPackage !== "function") {
        throw storeError("skill_package_unavailable", "Skill package editing is not configured for this Workbench.");
      }
      const replacement = await skillUploadService.resolvePromotedPackage({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        uploadId: request.data.uploadId,
      });
      const value = await store.replaceSkillDraftPackage({
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
      if (!skillValidationService?.runTests || typeof store.resolveSkillValidationContext !== "function") {
        throw storeError("skill_validation_unavailable", "Skill testing is not configured for this Workbench.");
      }
      const record = await runExternalMutation({
        scope: `test-skill-draft:${skillId}:${draftId}`,
        key: idempotencyKey,
        request: { ifMatch, request },
        workspaceId: context.workspaceId,
        operationIdKind: "skill-test-run",
        recover: async (testRunId) => {
          const record = await skillValidationService.getTestRun({ workspaceId: context.workspaceId, testRunId });
          return record?.skillId === skillId && record?.skillDraftId === draftId ? record : null;
        },
      }, async (testRunId, session) => {
        const validationContext = await store.resolveSkillValidationContext({
          skillId,
          draftId,
          workspaceId: context.workspaceId,
          session,
        });
        if (formatSkillDraftEtag(validationContext.draft) !== ifMatch) {
          throw storeError("skill_draft_conflict", "The Skill draft changed after it was read.", { skillId, draftId });
        }
        const [record] = await skillValidationService.runTests({
          workspaceId: context.workspaceId,
          skillId,
          draftId,
          draftRevision: validationContext.draft.revision,
          contentHash: validationContext.contentHash,
          uploadId: validationContext.uploadId,
          objectId: validationContext.objectId,
          objectHash: validationContext.objectHash,
          packageHash: validationContext.packageHash,
          permissionAcknowledged: true,
          testCases: [request.data.testCase],
          testRunIds: [testRunId],
        }, { session });
        return record;
      });
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
      return productSafeSkillTestRun(record);
    },
    async createSkillValidation({ skillId, draftId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!skillValidationService?.createValidation || typeof store.resolveSkillValidationContext !== "function") {
        throw storeError("skill_validation_unavailable", "Skill validation is not configured for this Workbench.");
      }
      const record = await runExternalMutation({
        scope: `validate-skill-draft:${skillId}:${draftId}`,
        key: idempotencyKey,
        request: { ifMatch, request },
        workspaceId: context.workspaceId,
        operationIdKind: "skill-validation",
        recover: async (validationId) => {
          const record = await skillValidationService.getValidation({ workspaceId: context.workspaceId, validationId });
          return record?.skillId === skillId && record?.skillDraftId === draftId ? record : null;
        },
      }, async (validationId, session) => {
        const validationContext = await store.resolveSkillValidationContext({
          skillId,
          draftId,
          workspaceId: context.workspaceId,
          session,
        });
        if (formatSkillDraftEtag(validationContext.draft) !== ifMatch) {
          throw storeError("skill_draft_conflict", "The Skill draft changed after it was read.", { skillId, draftId });
        }
        return skillValidationService.createValidation({
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
        }, { session });
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
      return productSafeSkillValidation(record);
    },
    async createNextSkillDraft({ skillId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof store.createNextSkillDraft !== "function") {
        throw storeError("skill_draft_unavailable", "Creating the next Skill version is not available.");
      }
      const value = await store.createNextSkillDraft({
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
      if (typeof store.getSkillUsageImpact !== "function") {
        throw storeError("skill_usage_unavailable", "Skill usage is not available.");
      }
      return store.getSkillUsageImpact({ skillId, workspaceId: context.workspaceId });
    },
    async listSkillVersions({ skillId, query = {}, auth }) {
      const context = await resolveAuth(auth);
      await ready();
      const skill = await requireRepository(store, "skillAssets").get(skillId, {
        workspaceId: context.workspaceId,
      });
      if (!skill) throw storeError("skill_not_found", "Skill not found.", { skillId });
      if (typeof store.listSkillVersions !== "function") {
        throw storeError("skill_version_history_unavailable", "Skill version history is not available.");
      }
      const versions = await store.listSkillVersions({
        skillId,
        workspaceId: context.workspaceId,
        limit: query.limit,
      });
      return resultPage(versions.map(productSafeSkillVersionSummary));
    },
    async getSkillVersionDiff({ skillId, fromVersionId, toVersionId, auth }) {
      const context = await resolveAuth(auth);
      await ready();
      const skill = await requireRepository(store, "skillAssets").get(skillId, {
        workspaceId: context.workspaceId,
      });
      if (!skill) throw storeError("skill_not_found", "Skill not found.", { skillId });
      if (typeof store.getSkillVersionDiff !== "function") {
        throw storeError("skill_usage_unavailable", "Skill version comparison is not available.");
      }
      return store.getSkillVersionDiff({
        skillId,
        fromVersionId,
        toVersionId,
        workspaceId: context.workspaceId,
      });
    },
    async deprecateSkill({ skillId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof store.deprecateSkill !== "function") {
        throw storeError("skill_deprecation_unavailable", "Retiring this Skill is not available.");
      }
      return productSafeSkillRecord(await store.deprecateSkill({
        skillId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        deprecatedBy: context.userId,
      }), context.userId);
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
      if (typeof store.publishSkill !== "function") {
        throw storeError("skill_publish_unavailable", "Skill publication is not available.");
      }
      const value = await store.publishSkill({
        skillId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        publishedBy: context.userId,
      });
      return {
        skill: productSafeSkillRecord(value.skill, context.userId),
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
    async getResource({ resourceId, auth }) {
      const context = await resolveAuth(auth);
      if (!textResourceService?.get) throw storeError("resource_service_unavailable", "Material storage is not configured for this Workbench.");
      return textResourceService.get({ workspaceId: context.workspaceId, requestedBy: context.userId, resourceId });
    },
    async listConnections({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      return resultPage(await connectionService.list({ workspaceId: context.workspaceId, query }));
    },
    async getConnection({ connectionId, auth }) {
      const context = await resolveAuth(auth);
      return connectionService.get({ connectionId, workspaceId: context.workspaceId });
    },
    async createConnection({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      return connectionService.create({
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        actorId: context.userId,
      });
    },
    async updateConnection({ connectionId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
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
      const context = await resolveAuth(auth, "member");
      return connectionService.validate({
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
      if (typeof store.createLoop !== "function") {
        throw storeError("loop_creation_unavailable", "Loop creation is not available.");
      }
      return store.createLoop({
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
      });
    },
    async createLoopImport({ idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!skillUploadService?.resolvePortableLoopUpload || typeof store.createLoopImport !== "function") {
        throw storeError("loop_import_unavailable", "Loop import is not configured for this Workbench.");
      }
      const resolved = await skillUploadService.resolvePortableLoopUpload({
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        uploadId: request.data.uploadId,
      });
      return store.createLoopImport({
        uploadId: resolved.uploadId,
        portableLoop: resolved.portableLoop,
        sourceContentHash: resolved.contentHash,
        idempotencyKey,
        workspaceId: context.workspaceId,
        importedBy: context.userId,
      });
    },
    async getLoopImport({ importId, auth }) {
      const context = await resolveAuth(auth);
      if (typeof store.getLoopImport !== "function") {
        throw storeError("loop_import_unavailable", "Loop import is not configured for this Workbench.");
      }
      return store.getLoopImport({ importId, workspaceId: context.workspaceId });
    },
    async commitLoopImport({ importId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof store.commitLoopImport !== "function") {
        throw storeError("loop_import_unavailable", "Loop import is not configured for this Workbench.");
      }
      const value = await store.commitLoopImport({
        importId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        importedBy: context.userId,
        resolveEmbeddedMaterial: async ({ requirement, embeddedMaterial, session }) => {
          if (!textResourceService?.createInSession) {
            throw storeError("loop_import_material_unavailable", "Embedded material cannot be added in this Workbench.");
          }
          return textResourceService.createInSession({
            workspaceId: context.workspaceId,
            requestedBy: context.userId,
            session,
            label: requirement.label,
            mediaType: embeddedMaterial.mediaType,
            content: Buffer.from(embeddedMaterial.content, "utf8"),
          });
        },
      });
      return { data: { workflow: value.workflow, revision: value.revision }, etag: value.etag };
    },
    async exportLoop({ workflowId, query, ifNoneMatch, auth }) {
      const context = await resolveAuth(auth);
      const stored = await store.getWorkflow(workflowId, { workspaceId: context.workspaceId });
      const workflow = stored.workflow;
      if (workflow.visibility === "private" && workflow.ownerId !== context.userId) {
        throw storeError("loop_export_forbidden", "Only the owner can export this private Loop.");
      }
      const revision = await getWorkflowRevision(workflowId, query.revisionId, { workspaceId: context.workspaceId });
      const portableLoop = await projectPortableLoopPackage({
        workflow,
        revision,
        resolveSkillVersion: ({ skillId, version }) => requireRepository(store, "skillVersions").getBySkillRef(
          skillId,
          version,
          { workspaceId: context.workspaceId },
        ),
        resolveMaterial: async ({ resourceId, version }) => {
          const material = await requireRepository(store, "resources").get(resourceId, { workspaceId: context.workspaceId });
          if (!material || material.version !== version) return null;
          if (!textResourceService?.readText) return material;
          return {
            ...material,
            content: await textResourceService.readText({
              workspaceId: context.workspaceId,
              resourceId,
              version,
            }),
          };
        },
        embedMaterials: Boolean(textResourceService?.readText),
      });
      const etag = `"${hashPortableLoopPackage(portableLoop)}"`;
      const responseHeaders = {
        "Content-Disposition": `attachment; filename="${portableLoopPackageFilename(workflow.name)}"`,
      };
      if (ifNoneMatch === "*" || ifNoneMatch === etag) {
        return { notModified: true, etag, responseHeaders };
      }
      await requireRepository(store, "auditEvents").append({
        schemaVersion: "workbench-v1",
        auditEventId: idFactory("audit"),
        workspaceId: context.workspaceId,
        actorId: context.userId,
        action: "loop.exported",
        entityKind: "workflow_revision",
        entityId: revision.revisionId,
        createdAt: clock(),
      });
      return {
        data: portableLoop,
        rawBody: formatPortableLoopPackage(portableLoop),
        etag,
        responseHeaders,
      };
    },
    async duplicateLoop({ workflowId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof store.duplicateLoop !== "function") {
        throw storeError("loop_duplicate_unavailable", "Copying this Workflow is not available.");
      }
      return store.duplicateLoop({
        workflowId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
      });
    },
    async saveLoopRevision({ workflowId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      await store.getWorkflow(workflowId, { workspaceId: context.workspaceId });
      const value = await store.saveWorkflowRevision({
        workflowId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
      });
      return { data: { workflow: value.workflow, revision: value.revision }, etag: value.etag };
    },
    async createLoopSkillUpdate({ workflowId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof store.createLoopSkillUpdate !== "function") {
        throw storeError("loop_skill_update_unavailable", "Creating a workflow Skill update is not available.");
      }
      const value = await store.createLoopSkillUpdate({
        workflowId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
      });
      return { data: { workflow: value.workflow, revision: value.revision }, etag: value.etag };
    },
    async getLoopSkillUpdatePreview({ workflowId, skillVersionId, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof store.getLoopSkillUpdatePreview !== "function") {
        throw storeError("loop_skill_update_unavailable", "Reviewing this workflow Skill update is not available.");
      }
      const value = await store.getLoopSkillUpdatePreview({
        workflowId,
        skillVersionId,
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
      });
      return { data: value.preview, etag: value.etag };
    },
    async generateLoopProposal({ workflowId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof agentRuntime?.generateBuilderProposal !== "function") {
        throw storeError("builder_proposal_unavailable", "Workflow suggestions are not available yet.");
      }
      await ready();
      return store.runIdempotentMutation({
        scope: `generate-builder-proposal:${workflowId}`,
        key: idempotencyKey,
        request: { ifMatch, request: clone(request) },
        workspaceId: context.workspaceId,
      }, async (session) => {
        const options = { session };
        const current = await store.getWorkflow(workflowId, {
          workspaceId: context.workspaceId,
          session,
        });
        if (current.etag !== ifMatch) {
          throw storeError("workflow_revision_conflict", "The workflow changed after it was read.", {
            workflowId,
            currentRevisionId: current.workflow.currentRevisionId,
          });
        }
        const revision = await requireRepository(store, "workflowRevisions").get(
          workflowId,
          current.workflow.currentRevisionId,
          { workspaceId: context.workspaceId, ...options },
        );
        if (!revision) throw storeError("workflow_revision_not_found", "Workflow revision not found.");
        const candidate = await agentRuntime.generateBuilderProposal({
          instruction: request.data.instruction,
          workflowId,
          workspaceId: context.workspaceId,
          revision: clone(revision),
        });
        const proposal = {
          schemaVersion: "workbench-v1",
          proposalId: idFactory("proposal"),
          workspaceId: context.workspaceId,
          workflowId,
          baseRevisionId: revision.revisionId,
          summary: candidate?.summary,
          operations: clone(candidate?.operations ?? []),
          diagnostics: clone(candidate?.diagnostics ?? []),
          permissionImpact: clone(candidate?.permissionImpact ?? []),
          status: candidate?.diagnostics?.some((diagnostic) => diagnostic.severity === "error") ? "invalid" : "proposed",
          createdBy: context.userId,
          createdAt: clock(),
          decidedAt: null,
        };
        if (!Check(LifecycleBuilderProposalSchema, proposal)) {
          throw storeError("builder_proposal_invalid", "The suggested changes could not be verified.");
        }
        applyBuilderOperations(revision, proposal.operations);
        await requireRepository(store, "builderProposals").insert(clone(proposal), options);
        await requireRepository(store, "auditEvents").append({
          schemaVersion: "workbench-v1",
          auditEventId: idFactory("audit"),
          workspaceId: context.workspaceId,
          actorId: context.userId,
          action: "builder_proposal.generated",
          entityKind: "builder_proposal",
          entityId: proposal.proposalId,
          createdAt: proposal.createdAt,
        }, options);
        return proposal;
      });
    },
    async applyLoopProposal({ workflowId, proposalId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      await ready();
      return store.runIdempotentMutation({
        scope: `apply-builder-proposal:${workflowId}:${proposalId}`,
        key: idempotencyKey,
        request: { ifMatch, request: clone(request) },
        workspaceId: context.workspaceId,
      }, async (session) => {
        const options = { session };
        const proposal = await requireRepository(store, "builderProposals").get(proposalId, {
          workspaceId: context.workspaceId,
          ...options,
        });
        if (!proposal || proposal.workflowId !== workflowId) {
          throw storeError("builder_proposal_not_found", "The suggested changes were not found.");
        }
        const current = await store.getWorkflow(workflowId, { workspaceId: context.workspaceId, session });
        const expectedBase = request.data.baseRevisionId;
        if (current.etag !== ifMatch || proposal.baseRevisionId !== expectedBase) {
          throw storeError("workflow_revision_conflict", "The workflow changed after these changes were suggested.", {
            workflowId,
            proposalId,
            currentRevisionId: current.workflow.currentRevisionId,
            proposalBaseRevisionId: proposal.baseRevisionId,
          });
        }
        if (proposal.status !== "proposed") {
          throw storeError("builder_proposal_state_invalid", "These suggested changes can no longer be applied.", { status: proposal.status });
        }
        const revision = await requireRepository(store, "workflowRevisions").get(
          workflowId,
          proposal.baseRevisionId,
          { workspaceId: context.workspaceId, ...options },
        );
        if (!revision) throw storeError("workflow_revision_not_found", "Workflow revision not found.");
        const proposed = applyBuilderOperations(revision, proposal.operations);
        const currentRevision = current.workflow.currentRevisionId === revision.revisionId
          ? revision
          : await requireRepository(store, "workflowRevisions").get(
            workflowId,
            current.workflow.currentRevisionId,
            { workspaceId: context.workspaceId, ...options },
          );
        if (!currentRevision) throw storeError("workflow_revision_not_found", "Workflow revision not found.");
        const merge = mergeWorkflowProposal({ base: revision, current: currentRevision, proposed });
        if (merge.status === "conflicted") {
          const createdAt = clock();
          for (const conflict of merge.conflicts) {
            await requireRepository(store, "mergeConflicts").insert({
              schemaVersion: "workbench-v1",
              mergeConflictId: idFactory("merge-conflict"),
              workspaceId: context.workspaceId,
              proposalId,
              objectKind: "workflow",
              objectId: workflowId,
              ...conflict,
              status: "open",
              createdAt,
              resolvedAt: null,
            }, options);
          }
          const conflicted = await requireRepository(store, "builderProposals").patch(
            proposalId,
            { status: "conflicted", decidedAt: createdAt },
            { workspaceId: context.workspaceId, ...options },
          );
          await requireRepository(store, "auditEvents").append({
            schemaVersion: "workbench-v1",
            auditEventId: idFactory("audit"),
            workspaceId: context.workspaceId,
            actorId: context.userId,
            action: "builder_proposal.conflicted",
            entityKind: "builder_proposal",
            entityId: proposalId,
            createdAt,
          }, options);
          return conflicted;
        }
        const revisionIdempotencyKey = canonicalRequestHash({ proposalId, idempotencyKey }).slice(0, 64);
        const savedRevision = await store.saveWorkflowRevision({
          workflowId,
          idempotencyKey: revisionIdempotencyKey,
          ifMatch,
          request: {
            schemaVersion: "workbench-api-v1",
            data: {
              baseRevisionId: currentRevision.revisionId,
              graph: merge.merged.graph,
              inputForm: merge.merged.inputForm,
              outputDefinition: merge.merged.outputDefinition,
              resourceRefs: merge.merged.resourceRefs,
              runSettings: merge.merged.runSettings,
              ...(merge.merged.definition ? { definition: merge.merged.definition } : {}),
              saveReason: `Applied confirmed workflow changes ${proposalId}.`,
            },
          },
          workspaceId: context.workspaceId,
          authoredBy: context.userId,
          session,
        });
        if (store.repositories?.compileResults && store.repositories?.executionPlans && store.repositories?.workflows) {
          await compileRevision({
            workflowId,
            revision: savedRevision.revision,
            context,
            options,
          });
        }
        const decidedAt = clock();
        const applied = await requireRepository(store, "builderProposals").patch(
          proposalId,
          { status: "applied", decidedAt },
          { workspaceId: context.workspaceId, ...options },
        );
        await requireRepository(store, "auditEvents").append({
          schemaVersion: "workbench-v1",
          auditEventId: idFactory("audit"),
          workspaceId: context.workspaceId,
          actorId: context.userId,
          action: "builder_proposal.applied",
          entityKind: "builder_proposal",
          entityId: proposalId,
          createdAt: decidedAt,
        }, options);
        return applied;
      });
    },
    async dismissLoopProposal({ workflowId, proposalId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      await ready();
      return store.runIdempotentMutation({
        scope: `dismiss-builder-proposal:${workflowId}:${proposalId}`,
        key: idempotencyKey,
        request: { ifMatch, request: clone(request) },
        workspaceId: context.workspaceId,
      }, async (session) => {
        const options = { session };
        const proposal = await requireRepository(store, "builderProposals").get(proposalId, {
          workspaceId: context.workspaceId,
          ...options,
        });
        if (!proposal || proposal.workflowId !== workflowId) {
          throw storeError("builder_proposal_not_found", "The suggested changes were not found.");
        }
        const current = await store.getWorkflow(workflowId, { workspaceId: context.workspaceId, session });
        const expectedBase = request.data.baseRevisionId;
        if (
          current.etag !== ifMatch
          || current.workflow.currentRevisionId !== expectedBase
          || proposal.baseRevisionId !== expectedBase
        ) {
          throw storeError("workflow_revision_conflict", "The workflow changed after these changes were suggested.", {
            workflowId,
            proposalId,
            currentRevisionId: current.workflow.currentRevisionId,
            proposalBaseRevisionId: proposal.baseRevisionId,
          });
        }
        if (proposal.status !== "proposed" && proposal.status !== "invalid") {
          throw storeError("builder_proposal_state_invalid", "These suggested changes can no longer be dismissed.", { status: proposal.status });
        }
        const decidedAt = clock();
        const dismissed = await requireRepository(store, "builderProposals").patch(
          proposalId,
          { status: "dismissed", decidedAt },
          { workspaceId: context.workspaceId, ...options },
        );
        await requireRepository(store, "auditEvents").append({
          schemaVersion: "workbench-v1",
          auditEventId: idFactory("audit"),
          workspaceId: context.workspaceId,
          actorId: context.userId,
          action: "builder_proposal.dismissed",
          entityKind: "builder_proposal",
          entityId: proposalId,
          createdAt: decidedAt,
        }, options);
        return dismissed;
      });
    },
    async publishLoop({ workflowId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof store.publishLoop !== "function") {
        throw storeError("loop_publish_unavailable", "Loop publication is not available.");
      }
      return store.publishLoop({
        workflowId,
        idempotencyKey,
        ifMatch,
        request,
        workspaceId: context.workspaceId,
        releasedBy: context.userId,
      });
    },
    async listTeamLibrary({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      if (typeof store.listTeamLibrary !== "function") {
        throw storeError("team_library_unavailable", "The Team library is not available.");
      }
      return resultPage(await store.listTeamLibrary({ workspaceId: context.workspaceId, ...query }));
    },
    async installRelease({ releaseId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof store.installRelease !== "function") {
        throw storeError("team_library_unavailable", "The Team library is not available.");
      }
      return store.installRelease({
        releaseId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        installedBy: context.userId,
      });
    },
    async getInstallation({ installationId, auth }) {
      const context = await resolveAuth(auth);
      const installation = await requireRepository(store, "assetInstallations").get(installationId, {
        workspaceId: context.workspaceId,
      });
      if (!installation) throw storeError("installation_not_found", "Installed item not found.", { installationId });
      return installation;
    },
    async listInstallations({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      return resultPage(await requireRepository(store, "assetInstallations").list({
        workspaceId: context.workspaceId,
        ...query,
      }));
    },
    async adoptInstallationRelease({ installationId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof store.adoptInstallationRelease !== "function") {
        throw storeError("team_library_unavailable", "Updating an installed item is not available.");
      }
      return store.adoptInstallationRelease({
        installationId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        adoptedBy: context.userId,
      });
    },
    async useReleaseAsStartingPoint({ releaseId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof store.useReleaseAsStartingPoint !== "function") {
        throw storeError("team_library_unavailable", "The Team library is not available.");
      }
      return store.useReleaseAsStartingPoint({
        releaseId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
      });
    },
    async forkTeamLibraryLoop({ releaseId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (typeof store.forkTeamLibraryLoop !== "function") {
        throw storeError("team_library_unavailable", "Forking this Team library Loop is not available.");
      }
      return store.forkTeamLibraryLoop({
        releaseId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
      });
    },
    async listTemplates({ query = {}, auth } = {}) {
      await resolveAuth(auth);
      await ready();
      return resultPage(await requireRepository(store, "templates").list(query));
    },
    async getTemplate({ templateId, auth }) {
      await resolveAuth(auth);
      await ready();
      const value = await requireRepository(store, "templates").get(templateId);
      if (!value) throw storeError("template_not_found", "Template not found.", { templateId });
      return value;
    },
    async useTemplate({ templateId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      return store.useTemplate({ templateId, idempotencyKey, request, workspaceId: context.workspaceId, authoredBy: context.userId });
    },
    async listWorkflows({ query = {}, auth } = {}) {
      const context = await resolveAuth(auth);
      await ready();
      return resultPage(await requireRepository(store, "workflows").list({ workspaceId: context.workspaceId, ...query }));
    },
    async getWorkflow({ workflowId, auth }) {
      const context = await resolveAuth(auth);
      const value = await store.getWorkflow(workflowId, { workspaceId: context.workspaceId });
      return { data: value.workflow, etag: value.etag };
    },
    async getWorkflowRevision({ workflowId, revisionId, auth }) {
      const context = await resolveAuth(auth);
      if (auth) await store.getWorkflow(workflowId, { workspaceId: context.workspaceId });
      const revision = await getWorkflowRevision(workflowId, revisionId);
      const workflow = await store.getWorkflow(workflowId, { workspaceId: context.workspaceId });
      return { data: revision, etag: workflow.etag };
    },
    async saveWorkflowRevision({ workflowId, idempotencyKey, ifMatch, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (auth) await store.getWorkflow(workflowId, { workspaceId: context.workspaceId });
      const value = await store.saveWorkflowRevision({ workflowId, idempotencyKey, ifMatch, request, workspaceId: context.workspaceId, authoredBy: context.userId });
      return { data: { workflow: value.workflow, revision: value.revision }, etag: value.etag };
    },
    async compileWorkflow({ workflowId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (auth) await store.getWorkflow(workflowId, { workspaceId: context.workspaceId });
      if (typeof store.runIdempotentMutation !== "function") {
        throw new TypeError("workbench_idempotency_store_required");
      }
      return store.runIdempotentMutation({
        scope: "compile-workflow:" + workflowId,
        key: idempotencyKey,
        request: { workflowId, body: request },
        workspaceId: context.workspaceId,
      }, async (session) => {
      const options = { session };
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
      if (auth) await store.getWorkflow(workflowId, { workspaceId: context.workspaceId });
      if (!runner?.startRun) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      return runner.startRun({ workflowId, ...request.data, workspaceId: context.workspaceId, idempotencyKey, requestId });
    },
    async listWorkflowRuns({ workflowId, query = {}, auth }) {
      const context = await resolveAuth(auth);
      if (auth) await store.getWorkflow(workflowId, { workspaceId: context.workspaceId });
      if (!runner?.listRuns) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      return resultPage(await runner.listRuns(workflowId, query));
    },
    async getRun({ runId, auth }) {
      const context = await resolveAuth(auth);
      if (!runner?.getRun) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const value = await runner.getRun(runId);
      if (auth) await store.getWorkflow(value.run.workflowId, { workspaceId: context.workspaceId });
      return value;
    },
    async listRunInvocations({ runId, auth }) {
      const context = await resolveAuth(auth);
      if (!runner?.getRun || !executionBroker?.listInvocations) throw storeError("runner_unavailable", "Run execution details are unavailable.");
      const run = await runner.getRun(runId);
      await store.getWorkflow(run.run.workflowId, { workspaceId: context.workspaceId });
      const invocations = await executionBroker.listInvocations({ workspaceId: context.workspaceId, controllerId: runId, limit: 500 });
      return resultPage(invocations.map(productSafeInvocation));
    },
    async listRunExecutionEvents({ runId, query = {}, auth }) {
      const context = await resolveAuth(auth);
      if (!runner?.getRun || !executionBroker?.listEvents) throw storeError("runner_unavailable", "Run execution events are unavailable.");
      const run = await runner.getRun(runId);
      await store.getWorkflow(run.run.workflowId, { workspaceId: context.workspaceId });
      const invocations = await executionBroker.listInvocations({ workspaceId: context.workspaceId, controllerId: runId, limit: 500 });
      return resultPage(await executionBroker.listEvents(
        invocations.map((invocation) => invocation.invocationId),
        query.after ?? 0,
        query.limit ?? 500,
      ));
    },
    async getRunComparison({ runId, otherRunId, auth }) {
      const context = await resolveAuth(auth);
      if (!runner?.getRun) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const [left, right] = await Promise.all([runner.getRun(runId), runner.getRun(otherRunId)]);
      if (left.run.workflowId !== right.run.workflowId) {
        throw storeError("run_comparison_workflow_mismatch", "Choose two runs from the same workflow.");
      }
      await store.getWorkflow(left.run.workflowId, { workspaceId: context.workspaceId });
      const runs = requireRepository(store, "runs");
      const [leftInternal, rightInternal] = await Promise.all([
        runs.getInternal(runId),
        runs.getInternal(otherRunId),
      ]);
      if (!leftInternal || !rightInternal) {
        throw storeError("run_not_found", "Run not found.");
      }
      const leftEntry = productSafeRunComparisonEntry({ ...left, internalRun: leftInternal });
      const rightEntry = productSafeRunComparisonEntry({ ...right, internalRun: rightInternal });
      return {
        left: leftEntry,
        right: rightEntry,
        workflowRevisionChanged: leftEntry.workflowRevisionId !== rightEntry.workflowRevisionId,
        skillVersionsChanged: canonicalRequestHash(leftEntry.skillVersions) !== canonicalRequestHash(rightEntry.skillVersions),
        finalAnswerChanged: (leftEntry.finalAnswer?.content ?? null) !== (rightEntry.finalAnswer?.content ?? null),
      };
    },
    async createLoopDraftFromRun({ runId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!runner?.getRun) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      if (typeof store.duplicateLoop !== "function") {
        throw storeError("loop_duplicate_unavailable", "Creating a Workflow from this run is not available.");
      }
      const sourceRun = await runner.getRun(runId);
      await store.getWorkflow(sourceRun.run.workflowId, { workspaceId: context.workspaceId });
      return store.duplicateLoop({
        workflowId: sourceRun.run.workflowId,
        sourceRevisionId: sourceRun.run.workflowRevisionId,
        idempotencyKey,
        request,
        workspaceId: context.workspaceId,
        authoredBy: context.userId,
      });
    },
    async submitReviewDecision({ runId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!runner?.submitReviewDecision) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const run = await runner.getRun(runId);
      if (auth) await store.getWorkflow(run.run.workflowId, { workspaceId: context.workspaceId });
      return runner.submitReviewDecision({ runId, ...request.data, idempotencyKey, decidedBy: context.userId });
    },
    async cancelRun({ runId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!runner?.cancelRun) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const current = await runner.getRun(runId);
      if (auth) await store.getWorkflow(current.run.workflowId, { workspaceId: context.workspaceId });
      const run = await runner.cancelRun({
        runId,
        idempotencyKey,
        requestedBy: context.userId,
        reason: request.data.reason,
      });
      return run.runId;
    },
    async retryRun({ runId, idempotencyKey, request, auth }) {
      const context = await resolveAuth(auth, "member");
      if (!runner?.retryRun) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const current = await runner.getRun(runId);
      if (auth) await store.getWorkflow(current.run.workflowId, { workspaceId: context.workspaceId });
      const run = await runner.retryRun({
        runId,
        idempotencyKey,
        requestedBy: context.userId,
        reason: request.data.reason,
      });
      return run.runId;
    },
    async listEvents({ runId, after, auth }) {
      const context = await resolveAuth(auth);
      if (!runner?.listEvents) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const run = await runner.getRun(runId);
      if (auth) await store.getWorkflow(run.run.workflowId, { workspaceId: context.workspaceId });
      return runner.listEvents(runId, after);
    },
    async subscribe(runId, listener, auth) {
      const context = await resolveAuth(auth);
      if (!runner?.subscribe) throw storeError("runner_unavailable", "Workflow Runner is not available.");
      const run = await runner.getRun(runId);
      if (auth) await store.getWorkflow(run.run.workflowId, { workspaceId: context.workspaceId });
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
