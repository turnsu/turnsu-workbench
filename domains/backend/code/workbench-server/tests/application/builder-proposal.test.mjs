import assert from "node:assert/strict";
import test from "node:test";

import { Check, LifecycleBuilderProposalSchema } from "@looloomi/workbench-contracts";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { applyBuilderOperations } from "../../src/proposals/apply-builder-operations.mjs";
import { makeRevision } from "../compiler/fixtures.mjs";

const NOW = "2026-07-13T08:00:00.000Z";

function proposalStore(baseRevision, { beforeMutation = null } = {}) {
  const proposals = new Map();
  const idempotency = new Map();
  const audits = [];
  const saved = [];
  const workflow = {
    schemaVersion: "workbench-v1",
    workflowId: baseRevision.workflowId,
    workspaceId: "workspace-local",
    name: "Reviewed Loop",
    description: "Review meeting actions.",
    status: "draft",
    archived: false,
    ownerId: "user-local",
    visibility: "private",
    lifecycle: "draft",
    currentRevisionId: baseRevision.revisionId,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    proposals,
    audits,
    saved,
    advanceWorkflowRevision(revisionId) { workflow.currentRevisionId = revisionId; },
    async connect() {},
    async getWorkflow() { return { workflow: structuredClone(workflow), etag: `"${workflow.currentRevisionId}"` }; },
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
      await beforeMutation?.(this);
      const response = await mutation({ id: "transaction" });
      idempotency.set(recordId, { requestJson, response: structuredClone(response) });
      return response;
    },
    async withTransaction(callback) { return callback({ id: "transaction" }); },
    async saveWorkflowRevision(args) {
      saved.push(structuredClone(args));
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
      return { workflow: structuredClone(workflow), revision, etag: `"${workflow.currentRevisionId}"` };
    },
    repositories: {
      workflowRevisions: {
        async get(workflowId, revisionId) {
          return workflowId === baseRevision.workflowId && revisionId === baseRevision.revisionId
            ? structuredClone(baseRevision)
            : null;
        },
      },
      builderProposals: {
        async insert(proposal) { proposals.set(proposal.proposalId, structuredClone(proposal)); return structuredClone(proposal); },
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
      },
      auditEvents: {
        async append(event) { audits.push(structuredClone(event)); return event; },
      },
    },
  };
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
    { op: "updateWorkflowSettings", runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 180 } },
  ]);
  assert.deepEqual(base, original);
  assert.equal(next.definition.goal, "Produce reviewed action items.");
  assert.equal(next.runSettings.defaultTimeoutSeconds, 180);
});

test("proposal generation binds a typed model result to the current revision and persists it once", async () => {
  const revision = makeRevision();
  const store = proposalStore(revision);
  const calls = [];
  const application = createWorkbenchApplication({
    store,
    agentRuntime: {
      async generateBuilderProposal(input) {
        calls.push(structuredClone(input));
        return {
          summary: "Tighten the completion rule.",
          operations: [{
            op: "updateDefinition",
            definition: {
              goal: "Produce reviewed action items.",
              context: "Use the meeting notes.",
              constraints: [],
              doneWhen: ["Every action has an owner."],
              verify: ["Check every item against the notes."],
              expectedResult: "A reviewed action list.",
              stopRules: [],
            },
          }],
          diagnostics: [],
          permissionImpact: [],
          providerPayload: "must-not-persist",
        };
      },
    },
    clock: () => NOW,
    idFactory: (kind) => `${kind}-proposal-1`,
  });
  const request = { data: { instruction: "Require an owner for every action." } };
  const first = await application.generateLoopProposal({
    workflowId: revision.workflowId,
    idempotencyKey: "proposal-idem-1",
    ifMatch: `"${revision.revisionId}"`,
    request,
  });
  const replay = await application.generateLoopProposal({
    workflowId: revision.workflowId,
    idempotencyKey: "proposal-idem-1",
    ifMatch: `"${revision.revisionId}"`,
    request,
  });

  assert.equal(Check(LifecycleBuilderProposalSchema, first), true);
  assert.deepEqual(replay, first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].instruction, request.data.instruction);
  assert.equal(calls[0].revision.revisionId, revision.revisionId);
  assert.equal(JSON.stringify(store.proposals.get(first.proposalId)).includes("providerPayload"), false);
  assert.equal(store.audits[0].action, "builder_proposal.generated");
});

test("proposal apply requires the same base revision and saves one immutable revision transaction", async () => {
  const revision = makeRevision();
  const store = proposalStore(revision);
  const application = createWorkbenchApplication({
    store,
    agentRuntime: {
      async generateBuilderProposal() {
        return {
          summary: "Update the goal.",
          operations: [{
            op: "updateDefinition",
            definition: {
              goal: "Create a reviewed follow-up.", context: "", constraints: [], doneWhen: ["Reviewed"],
              verify: [], expectedResult: "Follow-up", stopRules: [],
            },
          }],
          diagnostics: [],
          permissionImpact: [],
        };
      },
    },
    clock: () => NOW,
    idFactory: (kind) => `${kind}-proposal-2`,
  });
  const proposal = await application.generateLoopProposal({
    workflowId: revision.workflowId,
    idempotencyKey: "proposal-idem-2",
    ifMatch: `"${revision.revisionId}"`,
    request: { data: { instruction: "Update the goal." } },
  });
  const applied = await application.applyLoopProposal({
    workflowId: revision.workflowId,
    proposalId: proposal.proposalId,
    idempotencyKey: "proposal-apply-idem-2",
    ifMatch: `"${revision.revisionId}"`,
    request: { data: { baseRevisionId: revision.revisionId } },
  });

  assert.equal(applied.status, "applied");
  assert.equal(applied.decidedAt, NOW);
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].request.data.definition.goal, "Create a reviewed follow-up.");
  assert.equal(store.audits.at(-1).action, "builder_proposal.applied");

  await assert.rejects(
    () => application.applyLoopProposal({
      workflowId: revision.workflowId,
      proposalId: proposal.proposalId,
      idempotencyKey: "proposal-apply-conflict",
      ifMatch: `"${revision.revisionId}"`,
      request: { data: { baseRevisionId: "revision-other" } },
    }),
    (error) => error?.code === "workflow_revision_conflict",
  );
});

test("proposal generation rechecks the current revision inside its mutation boundary", async () => {
  const revision = makeRevision();
  const store = proposalStore(revision, {
    beforeMutation(currentStore) {
      currentStore.advanceWorkflowRevision("revision-concurrent-2");
    },
  });
  const application = createWorkbenchApplication({
    store,
    agentRuntime: {
      async generateBuilderProposal() {
        throw new Error("model_must_not_run_for_stale_revision");
      },
    },
  });

  await assert.rejects(
    () => application.generateLoopProposal({
      workflowId: revision.workflowId,
      idempotencyKey: "proposal-race-idem",
      ifMatch: `"${revision.revisionId}"`,
      request: { data: { instruction: "Update the goal." } },
    }),
    (error) => error?.code === "workflow_revision_conflict",
  );
  assert.equal(store.proposals.size, 0);
});

test("invalid model operations are rejected without persisting proposal data", async () => {
  const revision = makeRevision();
  const store = proposalStore(revision);
  const application = createWorkbenchApplication({
    store,
    agentRuntime: {
      async generateBuilderProposal() {
        return {
          summary: "Remove a missing step.",
          operations: [{ op: "removeNode", nodeId: "node-missing" }],
          diagnostics: [],
          permissionImpact: [],
          providerPayload: { secret: "must-not-persist" },
        };
      },
    },
  });

  await assert.rejects(
    () => application.generateLoopProposal({
      workflowId: revision.workflowId,
      idempotencyKey: "proposal-invalid-idem",
      ifMatch: `"${revision.revisionId}"`,
      request: { data: { instruction: "Remove a missing step." } },
    }),
    (error) => error?.code === "builder_proposal_invalid",
  );
  assert.equal(store.proposals.size, 0);
  assert.equal(store.audits.length, 0);
});

test("proposal dismiss is revision-bound, idempotent, and audited without saving a revision", async () => {
  const revision = makeRevision();
  const store = proposalStore(revision);
  const application = createWorkbenchApplication({
    store,
    agentRuntime: {
      async generateBuilderProposal() {
        return {
          summary: "Update the run timeout.",
          operations: [{ op: "updateWorkflowSettings", runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 180 } }],
          diagnostics: [],
          permissionImpact: [],
        };
      },
    },
    clock: () => NOW,
    idFactory: (kind) => `${kind}-proposal-dismiss`,
  });
  const proposal = await application.generateLoopProposal({
    workflowId: revision.workflowId,
    idempotencyKey: "proposal-dismiss-generate",
    ifMatch: `"${revision.revisionId}"`,
    request: { data: { instruction: "Update the timeout." } },
  });
  const command = {
    workflowId: revision.workflowId,
    proposalId: proposal.proposalId,
    idempotencyKey: "proposal-dismiss-command",
    ifMatch: `"${revision.revisionId}"`,
    request: { data: { baseRevisionId: revision.revisionId } },
  };
  const dismissed = await application.dismissLoopProposal(command);
  const replay = await application.dismissLoopProposal(command);

  assert.equal(dismissed.status, "dismissed");
  assert.equal(dismissed.decidedAt, NOW);
  assert.deepEqual(replay, dismissed);
  assert.equal(store.saved.length, 0);
  assert.equal(store.audits.at(-1).action, "builder_proposal.dismissed");
});
