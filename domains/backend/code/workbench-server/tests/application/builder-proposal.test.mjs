import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  SkillSchema,
  SkillVersionSchema,
  StagedLoopProposalSchema,
} from "@looloomi/workbench-contracts";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { CommandIntakeService } from "../../src/coordination/command-intake-service.mjs";
import { applyBuilderOperations } from "../../src/proposals/apply-builder-operations.mjs";
import { makeRevision, makeSkillDefinition } from "../compiler/fixtures.mjs";

const NOW = "2026-07-13T08:00:00.000Z";
const BUILDER_MODEL_PROFILE_ID = "model-profile-builder";
const BUILDER_MODEL_REVISION_ID = "model-revision-builder-1";

function createBuilderApplication({
  store,
  generate,
  requests = [],
  clock = () => NOW,
  idFactory,
  backendProbe = { available: true, verified: true },
  executionStatuses = [],
  skillReadModel = null,
} = {}) {
  const invocations = new Map();
  const modelCatalog = {
    async getWorkspacePolicy() {
      return { defaultProfileIdsByCapability: { tool_calling: BUILDER_MODEL_PROFILE_ID } };
    },
    async resolveCurrentProfile({ profileId, userId, capabilities }) {
      assert.ok(userId, "builder model lookup must have a user scope");
      assert.deepEqual(capabilities, ["chat", "tool_calling"]);
      assert.equal(profileId, BUILDER_MODEL_PROFILE_ID);
      return {
        profile: { profileId: BUILDER_MODEL_PROFILE_ID },
        revision: { revisionId: BUILDER_MODEL_REVISION_ID },
        readiness: { state: "ready" },
      };
    },
    async resolveRevision({ revisionId }) {
      assert.equal(revisionId, BUILDER_MODEL_REVISION_ID);
      return {
        profile: { profileId: BUILDER_MODEL_PROFILE_ID },
        revision: { revisionId: BUILDER_MODEL_REVISION_ID },
        readiness: { state: "ready" },
      };
    },
  };
  return createWorkbenchApplication({
    store,
    commandIntake: new CommandIntakeService({ store, now: clock }),
    modelCatalog,
    skillReadModel,
    executionBroker: {
      hasBackend({ mode, isolation }) {
        return mode === "bounded_agent" && isolation === "container";
      },
      async probeBackend({ mode, isolation }) {
        assert.equal(mode, "bounded_agent");
        assert.equal(isolation, "container");
        return structuredClone(typeof backendProbe === "function" ? await backendProbe() : backendProbe);
      },
      async execute(request) {
        assert.equal(request.metadata.modelCapability, "tool_calling");
        requests.push(structuredClone(request));
        if (invocations.has(request.invocationId)) throw new Error("execution_invocation_exists");
        const status = executionStatuses.shift() ?? "completed";
        const output = status === "completed"
          ? await generate({
              instruction: request.input.instruction,
              revision: structuredClone(request.input.revision),
            })
          : undefined;
        const result = {
          status,
          ...(output === undefined ? {} : { output }),
          requestedModelRevisionId: BUILDER_MODEL_REVISION_ID,
          actualModelRevisionId: BUILDER_MODEL_REVISION_ID,
          artifactRefs: [],
          startedAt: NOW,
          finishedAt: NOW,
        };
        invocations.set(request.invocationId, {
          invocationId: request.invocationId,
          workspaceId: request.workspaceId,
          request: structuredClone(request),
          status: result.status,
          result: structuredClone(result),
          createdAt: NOW,
          startedAt: NOW,
          finishedAt: NOW,
        });
        return result;
      },
      async getInvocation(invocationId) {
        return structuredClone(invocations.get(invocationId) ?? null);
      },
    },
    clock,
    idFactory: idFactory ?? ((kind) => `${kind}-builder-test`),
  });
}

test("staged proposal generation rejects an unverified backend before durable or Worker effects", async () => {
  const revision = makeRevision();
  const store = proposalStore(revision, { ownerId: "alice" });
  const requests = [];
  const application = createBuilderApplication({
    store,
    requests,
    backendProbe: {
      available: true,
      verified: false,
      reasonCode: "execution_backend_probe_unavailable",
    },
    generate: async () => {
      throw new Error("worker_must_not_run");
    },
  });

  await assert.rejects(
    application.generateStagedLoopProposal({
      idempotencyKey: "unverified-staged-proposal",
      request: {
        data: {
          name: "Unverified staged proposal",
          sourceText: "This input must remain outside the execution fabric.",
          definition: {
            goal: "Do not execute.",
            context: "",
            constraints: [],
            doneWhen: ["Never dispatched."],
            verify: [],
            expectedResult: "No result.",
            stopRules: [],
          },
        },
      },
      auth: { userId: "alice", activeWorkspaceId: "workspace-local" },
    }),
    { code: "builder_proposal_unavailable" },
  );
  assert.equal(store.proposals.size, 0);
  assert.equal(store.productCommands.size, 0);
  assert.equal(requests.length, 0);
});

function proposalStore(baseRevision, { beforeMutation = null, ownerId = "user-local" } = {}) {
  const proposals = new Map();
  const productCommands = new Map();
  const idempotency = new Map();
  const audits = [];
  const saved = [];
  const conflicts = [];
  const revisions = new Map([[baseRevision.revisionId, structuredClone(baseRevision)]]);
  const skillAssets = new Map();
  const skillVersions = new Map();
  for (const node of baseRevision.graph.nodes) {
    if (node.kind !== "Skill" || !node.skillRef) continue;
    const definition = makeSkillDefinition(node.skillRef);
    const skillVersionId = `skill-version-${node.skillRef.skillId}-${node.skillRef.version}`;
    const asset = {
      schemaVersion: "workbench-v1",
      skillId: node.skillRef.skillId,
      workspaceId: "workspace-local",
      ownerId,
      visibility: "private",
      lifecycle: "published",
      currentDraftId: null,
      latestPublishedVersionId: skillVersionId,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const publishedVersion = {
      schemaVersion: "workbench-v1",
      skillVersionId,
      skillId: node.skillRef.skillId,
      workspaceId: "workspace-local",
      version: node.skillRef.version,
      packageObjectId: `object-${node.skillRef.skillId}-${node.skillRef.version}`,
      packageHash: `sha256:${"a".repeat(64)}`,
      contentHash: `sha256:${"b".repeat(64)}`,
      manifest: {},
      name: definition.name,
      description: definition.description,
      category: definition.category,
      inputSchema: structuredClone(definition.inputSchema),
      outputSchema: structuredClone(definition.outputSchema),
      risk: structuredClone(definition.risk),
      dependencies: structuredClone(definition.dependencies),
      connectionRequirements: [],
      validation: {
        validationId: `validation-${node.skillRef.skillId}-${node.skillRef.version}`,
        status: "passed",
        diagnostics: [],
        testedAt: NOW,
      },
      executionRef: structuredClone(definition.executionRef),
      publishedBy: ownerId,
      publishedAt: NOW,
    };
    assert.equal(Check(SkillSchema, asset), true);
    assert.equal(Check(SkillVersionSchema, publishedVersion), true);
    skillAssets.set(asset.skillId, asset);
    skillVersions.set(`${publishedVersion.skillId}:${publishedVersion.version}`, publishedVersion);
  }
  let failProposalInsert = false;
  let failGenerationTargetInsert = false;
  let failCommandStatus = null;
  let beforeProposalFinalize = beforeMutation;
  let workflowReads = 0;
  const workflow = {
    schemaVersion: "workbench-v1",
    workflowId: baseRevision.workflowId,
    workspaceId: "workspace-local",
    name: "Reviewed Loop",
    description: "Review meeting actions.",
    status: "draft",
    archived: false,
    ownerId,
    visibility: "private",
    lifecycle: "draft",
    currentRevisionId: baseRevision.revisionId,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const restoreMap = (target, entries) => {
    target.clear();
    for (const [key, value] of entries) target.set(key, structuredClone(value));
  };
  const store = {
    proposals,
    productCommands,
    audits,
    saved,
    conflicts,
    failNextProposalInsert() { failProposalInsert = true; },
    failNextGenerationTargetInsert() { failGenerationTargetInsert = true; },
    failNextCommandCompletion() { failCommandStatus = "completed"; },
    failNextCommandSettlement(status) { failCommandStatus = status; },
    clearExternalIdempotency() {
      for (const key of idempotency.keys()) {
        if (key.startsWith("external:")) idempotency.delete(key);
      }
    },
    setCommandStatus(commandId, status) {
      const command = productCommands.get(commandId);
      if (!command) throw new Error("test_product_command_not_found");
      command.status = status;
      command.finishedAt = null;
    },
    advanceWorkflowRevision(revisionId) { workflow.currentRevisionId = revisionId; },
    setCurrentRevision(revision) {
      revisions.set(revision.revisionId, structuredClone(revision));
      workflow.currentRevisionId = revision.revisionId;
    },
    async connect() {},
    async getWorkflow() {
      workflowReads += 1;
      if (beforeProposalFinalize && workflowReads === 3) {
        const hook = beforeProposalFinalize;
        beforeProposalFinalize = null;
        await hook(store);
      }
      return { workflow: structuredClone(workflow), etag: `"${workflow.currentRevisionId}"` };
    },
    async runIdempotentMutation({ scope, key, request }, mutation) {
      const recordId = `${scope}:${key}`;
      const requestJson = JSON.stringify(request);
      const existing = idempotency.get(recordId);
      if (existing) {
        if (existing.requestJson !== requestJson) {
          const error = new Error("idempotency_key_reused");
          error.code = "idempotency_key_reused";
          throw error;
        }
        return structuredClone(existing.response);
      }
      const response = await mutation({ id: "transaction" });
      idempotency.set(recordId, { requestJson, response: structuredClone(response) });
      return response;
    },
    async runIdempotentExternalMutation({ scope, key, request, operationIdKind, recover }, mutation) {
      const recordId = `external:${scope}:${key}`;
      const requestJson = JSON.stringify(request);
      const existing = idempotency.get(recordId);
      if (existing) {
        if (existing.requestJson !== requestJson) {
          const error = new Error("idempotency_key_reused");
          error.code = "idempotency_key_reused";
          throw error;
        }
        return structuredClone(existing.response);
      }
      const operationId = `${operationIdKind}-external`;
      const recovered = await recover?.(operationId);
      const response = recovered ?? await mutation(operationId);
      idempotency.set(recordId, { requestJson, response: structuredClone(response) });
      return response;
    },
    async withTransaction(callback) {
      const proposalSnapshot = [...proposals.entries()];
      const commandSnapshot = [...productCommands.entries()];
      const auditSnapshot = structuredClone(audits);
      try {
        return await callback({ id: "transaction" });
      } catch (error) {
        restoreMap(proposals, proposalSnapshot);
        restoreMap(productCommands, commandSnapshot);
        audits.splice(0, audits.length, ...auditSnapshot);
        throw error;
      }
    },
    async saveWorkflowRevision(args) {
      const { authorizeReferences, ...serializableArgs } = args;
      await authorizeReferences?.({
        graph: args.request.data.graph,
        session: args.session,
      });
      saved.push(structuredClone(serializableArgs));
      workflow.currentRevisionId = "revision-applied-2";
      const revision = {
        ...structuredClone(baseRevision),
        ...structuredClone(args.request.data),
        revisionId: workflow.currentRevisionId,
        revisionNumber: baseRevision.revisionNumber + 1,
        baseRevisionId: baseRevision.revisionId,
        contentHash: "a".repeat(64),
        authoredBy: args.authoredBy,
        compile: { status: "not_compiled", diagnostics: [] },
        createdAt: NOW,
        updatedAt: NOW,
      };
      revisions.set(revision.revisionId, structuredClone(revision));
      return { workflow: structuredClone(workflow), revision, etag: `"${workflow.currentRevisionId}"` };
    },
    repositories: {
      skillAssets: {
        async get(skillId, { workspaceId } = {}) {
          const asset = skillAssets.get(skillId);
          return asset && (!workspaceId || asset.workspaceId === workspaceId)
            ? structuredClone(asset)
            : null;
        },
      },
      skillVersions: {
        async getBySkillRef(skillId, version, { workspaceId } = {}) {
          const publishedVersion = skillVersions.get(`${skillId}:${version}`);
          return publishedVersion && (!workspaceId || publishedVersion.workspaceId === workspaceId)
            ? structuredClone(publishedVersion)
            : null;
        },
      },
      skills: {
        async get(skillId, version) {
          if (!["skill-research", "skill-research-b"].includes(skillId)) return null;
          return {
            skillId,
            version,
            executionRef: { executionMode: "deterministic" },
          };
        },
      },
      productCommands: {
        async get({ commandId, workspaceId, userId }) {
          const value = productCommands.get(commandId);
          return value && value.workspaceId === workspaceId && value.userId === userId
            ? structuredClone(value)
            : null;
        },
        async insertAccepted(command) {
          if (productCommands.has(command.commandId)) {
            const error = new Error("duplicate_product_command");
            error.code = 11000;
            throw error;
          }
          const accepted = { ...structuredClone(command), status: "accepted", finishedAt: null };
          productCommands.set(command.commandId, accepted);
          return structuredClone(accepted);
        },
        async compareAndSet({ commandId, workspaceId, userId }, expectedStatuses, update) {
          const value = productCommands.get(commandId);
          if (
            !value
            || value.workspaceId !== workspaceId
            || value.userId !== userId
            || !expectedStatuses.includes(value.status)
          ) return null;
          if (update.status === failCommandStatus) {
            failCommandStatus = null;
            throw new Error("injected_command_settle_failure");
          }
          Object.assign(value, structuredClone(update));
          return structuredClone(value);
        },
      },
      workflowRevisions: {
        async get(workflowId, revisionId) {
          return workflowId === baseRevision.workflowId
            ? structuredClone(revisions.get(revisionId) ?? null)
            : null;
        },
      },
      mergeConflicts: {
        async insert(conflict) { conflicts.push(structuredClone(conflict)); return structuredClone(conflict); },
      },
      builderProposals: {
        async insert(proposal) {
          if (failGenerationTargetInsert) {
            failGenerationTargetInsert = false;
            throw new Error("injected_generation_target_failure");
          }
          proposals.set(proposal.proposalId, structuredClone(proposal));
          return structuredClone(proposal);
        },
        async get(proposalId, { workspaceId } = {}) {
          const value = proposals.get(proposalId);
          return value?.workspaceId === workspaceId ? structuredClone(value) : null;
        },
        async patch(proposalId, update, { workspaceId } = {}) {
          const value = proposals.get(proposalId);
          if (!value || value.workspaceId !== workspaceId) return null;
          const next = { ...value, ...structuredClone(update) };
          proposals.set(proposalId, next);
          return structuredClone(next);
        },
        async patchAndUnset(proposalId, update, unsetFields, { workspaceId } = {}) {
          const value = proposals.get(proposalId);
          if (!value || value.workspaceId !== workspaceId) return null;
          if (update.generationState === undefined) {
            if (failProposalInsert) {
              failProposalInsert = false;
              throw new Error("injected_proposal_persistence_failure");
            }
          }
          const next = { ...value, ...structuredClone(update) };
          for (const field of unsetFields ?? []) delete next[field];
          proposals.set(proposalId, next);
          return structuredClone(next);
        },
      },
      auditEvents: {
        async append(event) { audits.push(structuredClone(event)); return event; },
      },
    },
  };
  return store;
}

test("typed Builder operations produce a new revision draft without mutating the base", () => {
  const base = makeRevision();
  const original = structuredClone(base);
  const next = applyBuilderOperations(base, [
    {
      op: "updateDefinition",
      definition: {
        goal: "Produce reviewed action items.",
        context: "Use the meeting notes.",
        constraints: ["Do not invent owners."],
        doneWhen: ["Every action has an owner."],
        verify: ["Check every item against the notes."],
        expectedResult: "A reviewed action list.",
        stopRules: ["Pause when an owner is unclear."],
      },
    },
    {
      op: "updateWorkflowSettings",
      runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 180, workflowFallbackAllowed: false },
    },
  ]);
  assert.deepEqual(base, original);
  assert.equal(next.definition.goal, "Produce reviewed action items.");
  assert.equal(next.runSettings.defaultTimeoutSeconds, 180);
});

test("document-to-Loop generation persists only an expiring staged proposal until the user commits", async () => {
  const revision = makeRevision();
  const store = proposalStore(revision);
  const requests = [];
  let insidePersistenceTransaction = false;
  const transact = store.withTransaction.bind(store);
  store.withTransaction = async (...args) => {
    insidePersistenceTransaction = true;
    try {
      return await transact(...args);
    } finally {
      insidePersistenceTransaction = false;
    }
  };
  const application = createBuilderApplication({
    store,
    requests,
    generate: async ({ revision: preview }) => {
      assert.equal(insidePersistenceTransaction, false, "model execution must not run inside a persistence transaction");
      return {
        summary: "Create a reviewable Loop outline.",
        operations: [{
          op: "updateDefinition",
          definition: {
            ...preview.definition,
            goal: "Produce a reviewed implementation plan.",
          },
        }],
        diagnostics: [],
        permissionImpact: [],
      };
    },
    clock: () => NOW,
    skillReadModel: { async listSkillAssets() {
      return ["user-local", "another-user"].map((ownerId) => ({
        skill: { skillId: `skill-${ownerId}`, workspaceId: "workspace-local", ownerId, visibility: "private", lifecycle: "published", latestPublishedVersionId: `version-${ownerId}` },
        latestVersion: { skillVersionId: `version-${ownerId}`, version: "1.0.0", name: "Review text", description: "Review supplied text.", inputSchema: { type: "string" }, outputSchema: { type: "string" }, files: ["private-source-file"] },
      }));
    } },
    idFactory: (kind) => `${kind}-staged-loop`,
  });

  const staged = await application.generateStagedLoopProposal({
    idempotencyKey: "stage-loop-from-document",
    request: {
      data: {
        name: "Implementation plan",
        sourceText: "Read the PRD and produce an implementation plan.",
        definition: {
          goal: "Produce an implementation plan.",
          context: "Use the approved PRD.",
          constraints: ["Do not change product scope."],
          doneWhen: ["The plan is reviewable."],
          verify: ["Trace every item to the PRD."],
          expectedResult: "A reviewed plan.",
          stopRules: [],
        },
      },
    },
  });
  const replay = await application.generateStagedLoopProposal({
    idempotencyKey: "stage-loop-from-document",
    request: {
      data: {
        name: "Implementation plan",
        sourceText: "Read the PRD and produce an implementation plan.",
        definition: {
          goal: "Produce an implementation plan.",
          context: "Use the approved PRD.",
          constraints: ["Do not change product scope."],
          doneWhen: ["The plan is reviewable."],
          verify: ["Trace every item to the PRD."],
          expectedResult: "A reviewed plan.",
          stopRules: [],
        },
      },
    },
  });

  assert.equal(Check(StagedLoopProposalSchema, staged), true);
  assert.deepEqual(replay, staged);
  assert.equal(staged.kind, "staged_loop_draft");
  assert.equal(staged.draft.definition.goal, "Produce a reviewed implementation plan.");
  assert.equal(store.saved.length, 0);
  assert.equal(store.proposals.size, 1);
  assert.equal(store.audits.at(-1).action, "staged_loop_proposal.generated");
  assert.deepEqual(requests[0].input.availableSkills.map((skill) => skill.skillRef.skillId), ["skill-user-local"]);
  assert.equal(JSON.stringify(requests[0].input.availableSkills).includes("private-source-file"), false);
  assert.equal(requests[0].metadata.objectKind, "staged_loop");
  assert.deepEqual(requests[0].input.kernelSessionReplay, {
    schemaVersion: "agent-kernel-session-replay-v1",
    session: { sessionId: requests[0].lineage.sessionId, branchId: null }, events: [], checkpoint: { cursor: 0 },
  });
  assert.equal(requests[0].metadata.agentSessionId, requests[0].lineage.sessionId);
  assert.equal(Check(requests[0].resultSchema, { summary: "Invalid operation", operations: [{ op: "inventStep" }], diagnostics: [], permissionImpact: [] }), false);
  assert.equal(requests[0].invocationId, "invocation-proposal-external");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].isolation, "container");
  assert.equal(requests[0].capabilities.externalActions, false);
});

test("staged proposal recovers a completed durable Worker result after proposal persistence fails", async () => {
  const revision = makeRevision();
  const store = proposalStore(revision);
  const requests = [];
  let backendAvailable = true;
  let probeCalls = 0;
  store.failNextProposalInsert();
  const application = createBuilderApplication({
    store,
    requests,
    backendProbe: async () => {
      probeCalls += 1;
      return { available: backendAvailable, verified: true };
    },
    generate: async ({ revision: preview }) => ({
      summary: "Recover the durable result.",
      operations: [{
        op: "updateDefinition",
        definition: { ...preview.definition, goal: "Recovered staged goal." },
      }],
      diagnostics: [],
      permissionImpact: [],
    }),
  });
  const command = {
    idempotencyKey: "stage-recover-durable-result",
    request: {
      data: {
        name: "Recovered staged Loop",
        sourceText: "Generate once, then recover persistence.",
        definition: {
          goal: "Original goal.",
          context: "",
          constraints: [],
          doneWhen: ["Recovered."],
          verify: [],
          expectedResult: "A recovered proposal.",
          stopRules: [],
        },
      },
    },
    auth: { userId: "alice", activeWorkspaceId: "workspace-local" },
  };

  await assert.rejects(
    () => application.generateStagedLoopProposal(command),
    /injected_proposal_persistence_failure/,
  );
  backendAvailable = false;
  const recovered = await application.generateStagedLoopProposal(command);

  assert.equal(recovered.draft.definition.goal, "Recovered staged goal.");
  assert.equal(recovered.createdBy, "alice");
  assert.equal(requests.length, 1, "the durable invocation result must prevent a second Worker execution");
  assert.equal(store.proposals.size, 1);
  assert.equal(probeCalls, 1, "completed durable invocation recovery must bypass current backend readiness");
});

test("staged Loop proposals are recoverable only by their creator and cannot be dismissed by another collaborator", async () => {
  const revision = makeRevision();
  const store = proposalStore(revision);
  const application = createBuilderApplication({
    store,
    generate: async () => ({
      summary: "Create a private staged proposal.",
      operations: [],
      diagnostics: [],
      permissionImpact: [],
    }),
    clock: () => NOW,
  });
  const staged = await application.generateStagedLoopProposal({
    idempotencyKey: "stage-private-loop",
    request: {
      data: {
        name: "Private staged Loop",
        sourceText: "Only the creator may recover or dismiss this proposal.",
        definition: {
          goal: "Keep a staged proposal private to its creator.",
          context: "Use the supplied private document.",
          constraints: [],
          doneWhen: ["The proposal is reviewable."],
          verify: ["Confirm collaborator isolation."],
          expectedResult: "A private staged Loop proposal.",
          stopRules: [],
        },
      },
    },
    auth: { userId: "alice", activeWorkspaceId: "workspace-local" },
  });

  assert.equal((await application.getStagedLoopProposal({
    proposalId: staged.proposalId,
    auth: { userId: "alice", activeWorkspaceId: "workspace-local" },
  })).proposalId, staged.proposalId);
  await assert.rejects(
    application.getStagedLoopProposal({
      proposalId: staged.proposalId,
      auth: { userId: "bob", activeWorkspaceId: "workspace-local" },
    }),
    { code: "builder_proposal_not_found" },
  );
  await assert.rejects(
    application.dismissStagedLoopProposal({
      proposalId: staged.proposalId,
      idempotencyKey: "dismiss-private-loop-as-bob",
      request: { data: {} },
      auth: { userId: "bob", activeWorkspaceId: "workspace-local" },
    }),
    { code: "builder_proposal_not_found" },
  );
  assert.equal(store.proposals.get(staged.proposalId).status, "proposed");
});

test("a stable external proposal operation cannot be recovered by another principal", async () => {
  const revision = makeRevision();
  const store = proposalStore(revision);
  const requests = [];
  const application = createBuilderApplication({
    store,
    requests,
    generate: async () => ({
      summary: "Private staged proposal.",
      operations: [],
      diagnostics: [],
      permissionImpact: [],
    }),
  });
  const request = {
    data: {
      name: "Private staged Loop",
      sourceText: "This proposal belongs to its creator.",
      definition: {
        goal: "Keep proposal recovery principal-scoped.",
        context: "",
        constraints: [],
        doneWhen: ["Only the creator can recover it."],
        verify: [],
        expectedResult: "One private proposal.",
        stopRules: [],
      },
    },
  };
  const aliceProposal = await application.generateStagedLoopProposal({
    idempotencyKey: "principal-scoped-staged-operation",
    request,
    auth: { userId: "alice", activeWorkspaceId: "workspace-local" },
  });

  await assert.rejects(
    () => application.generateStagedLoopProposal({
      idempotencyKey: "principal-scoped-staged-operation",
      request,
      auth: { userId: "bob", activeWorkspaceId: "workspace-local" },
    }),
    { code: "builder_proposal_not_found" },
  );
  assert.equal(store.proposals.get(aliceProposal.proposalId).createdBy, "alice");
  assert.equal(store.productCommands.get(aliceProposal.productCommandId).userId, "alice");
  assert.equal(requests.length, 1);
  assert.equal(store.audits.length, 1);
});
