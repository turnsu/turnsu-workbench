import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAgentProposalLifecycle } from "../../src/agents/postgres-agent-proposal-lifecycle.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { makeRevision } from "../compiler/fixtures.mjs";

const NOW = "2026-08-11T00:00:00.000Z";
const proposal = Object.freeze({
  proposal_id: "proposal-alpha", workspace_id: "workspace-alpha", user_id: "alice",
  session_id: "session-alpha", turn_id: "turn-alpha", branch_id: "branch-alpha",
  schema_version: "workbench-v1", definition_id: "loop_creator", object_kind: "workflow",
  object_id: "workflow-alpha", base_version_id: "revision-alpha", status: "proposed",
  created_by: "alice", created_at: NOW, decided_at: null,
  payload: { summary: "Add a review step", operations: [], evidenceRefs: [], validationResult: { status: "passed", diagnostics: [] } },
});

function authorityFixture() {
  return {
    async authorizeAgentProposalApply({ targetRevision }) {
      return {
        scopeId: "scope-alpha",
        authorizationDecisionId: "decision-alpha",
        argumentDigest: `sha256:${"a".repeat(64)}`,
        authorizedAt: NOW,
        targetRevision,
      };
    },
    async authorizeAgentProposalReject({ targetRevision }) {
      return {
        scopeId: "scope-alpha",
        authorizationDecisionId: "decision-alpha",
        argumentDigest: `sha256:${"a".repeat(64)}`,
        authorizedAt: NOW,
        targetRevision,
      };
    },
  };
}

function commandIntakeFixture() {
  return {
    async accept({ command, persistTarget }) {
      const target = await persistTarget({ command: { commandId: command.commandId } });
      return { command: { ...command, status: "completed" }, target, replayed: false };
    },
  };
}

function storeFixture({ activeTurnId = null } = {}) {
  const calls = [];
  const store = {
    persistenceDriver: "postgres",
    async connect() { return this; },
    async withTransaction(work) { calls.push("transaction"); return work({ kind: "postgres_unit_of_work" }); },
    bindAdapter(factory) {
      return factory({
        async execute(_uow, config) {
          const text = typeof config === "string" ? config : config.text;
          calls.push(text);
          if (text.includes("FROM public.workspace_memberships")) return { rows: [{ role: "member" }] };
          if (text.includes("INSERT INTO public.product_idempotency_receipts")) {
            return { rows: [{ request_hash: config.values[4], response: null }] };
          }
          if (text.includes("FROM public.agent_object_proposals")) return { rows: [structuredClone(proposal)] };
          if (text.includes("FROM public.agent_branches")) return { rows: [{ status: "active" }] };
          if (text.includes("FROM public.agent_sessions")) return { rows: [{ status: "active", active_turn_id: activeTurnId, event_sequence: "4" }] };
          if (text.includes("UPDATE public.agent_branches")) return { rows: [] };
          if (text.includes("UPDATE public.agent_sessions")) return { rows: [{ event_sequence: "5" }] };
          if (text.includes("UPDATE public.agent_object_proposals")) {
            return { rows: [{ ...proposal, status: "rejected", decided_at: NOW }] };
          }
          if (text.includes("INSERT INTO public.agent_session_events")
            || text.includes("INSERT INTO public.agent_session_decision_events")) return { rows: [] };
          if (text.includes("UPDATE public.product_idempotency_receipts")) return { rows: [] };
          throw new Error(`unexpected_query:${text}`);
        },
      });
    },
  };
  return { store, calls };
}

test("PostgreSQL proposal rejection atomically closes only the caller's personal branch and emits a Session event", async () => {
  const { store, calls } = storeFixture();
  const lifecycle = new PostgresAgentProposalLifecycle({
    store, clock: () => NOW, idFactory: (kind) => `${kind}-test`,
    commandAuthorizer: authorityFixture(), commandIntake: commandIntakeFixture(),
  });
  const result = await lifecycle.reject({
    sessionId: "session-alpha", proposalId: "proposal-alpha", idempotencyKey: "reject-alpha",
    request: { schemaVersion: "workbench-api-v1", data: {} },
    context: { workspaceId: "workspace-alpha", userId: "alice", role: "member" },
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.decidedAt, NOW);
  assert.equal(result.summary, "Add a review step");
  assert.ok(calls.some((text) => typeof text === "string" && text.includes("agent.proposal.rejected")));
  assert.ok(calls.some((text) => typeof text === "string" && text.includes("UPDATE public.agent_branches")));
  assert.ok(calls.some((text) => typeof text === "string" && text.includes("UPDATE public.agent_object_proposals")));
});

test("PostgreSQL proposal rejection refuses to close a Session with an active Turn", async () => {
  const { store, calls } = storeFixture({ activeTurnId: "turn-still-running" });
  const lifecycle = new PostgresAgentProposalLifecycle({
    store, clock: () => NOW, idFactory: (kind) => kind,
    commandAuthorizer: authorityFixture(), commandIntake: commandIntakeFixture(),
  });
  await assert.rejects(
    lifecycle.reject({
      sessionId: "session-alpha", proposalId: "proposal-alpha", idempotencyKey: "reject-alpha",
      request: { schemaVersion: "workbench-api-v1", data: {} },
      context: { workspaceId: "workspace-alpha", userId: "alice", role: "member" },
    }),
    { code: "agent_proposal_state_invalid" },
  );
  assert.equal(calls.some((text) => typeof text === "string" && text.includes("UPDATE public.agent_branches")), false);
});

test("PostgreSQL Skill proposal apply commits its canonical Draft revision with the private branch decision", async () => {
  const baseDraft = {
    schemaVersion: "workbench-v1", skillDraftId: "draft-alpha", skillId: "skill-alpha",
    workspaceId: "workspace-alpha", baseVersionId: null, revision: 3, name: "Research",
    description: "Base description", category: "research",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: {}, required: [] },
    risk: { level: "low", externalAction: false, summary: "Read only." },
    dependencies: [], connectionRequirements: [], files: [], updatedBy: "alice",
    createdAt: NOW, updatedAt: NOW,
  };
  const skillProposal = {
    ...proposal, definition_id: "skill_creator", object_kind: "skill_draft", object_id: "draft-alpha",
    base_version_id: "draft-alpha:3", payload: {
      summary: "Use the analysis category.",
      operations: [{ op: "replace", path: "/category", value: "analysis" }],
      evidenceRefs: [], validationResult: { status: "passed", diagnostics: [] },
    },
  };
  const branch = {
    branch_id: "branch-alpha", workspace_id: "workspace-alpha", user_id: "alice",
    object_kind: "skill_draft", object_id: "draft-alpha", base_version_id: "draft-alpha:3",
    status: "active", payload: { baseSnapshot: baseDraft },
  };
  const draftRow = {
    workspace_id: "workspace-alpha", skill_draft_id: "draft-alpha", skill_id: "skill-alpha",
    schema_version: "workbench-v1", base_version_id: null, draft_revision: 3,
    content_hash: "sha256:0123456789abcdef", updated_by: "alice", created_at: NOW, updated_at: NOW,
    package_object_id: null, package_object_kind: null, package_object_hash: null, package_hash: null,
    definition: baseDraft, owner_user_id: "alice", current_draft_id: "draft-alpha",
    asset_lifecycle: "draft", asset_payload: { name: "Research" },
  };
  const calls = [];
  let savedDefinition = null;
  const store = {
    async withTransaction(work) { return work({ kind: "postgres_unit_of_work" }); },
    bindAdapter(factory) {
      return factory({
        async execute(_uow, config) {
          const text = config.text;
          calls.push(text);
          if (text.includes("FROM public.workspace_memberships")) return { rows: [{ role: "member" }] };
          if (text.includes("INSERT INTO public.product_idempotency_receipts")) return { rows: [{ request_hash: config.values[4], response: null }] };
          if (text.includes("FROM public.agent_object_proposals")) return { rows: [structuredClone(skillProposal)] };
          if (text.includes("FROM public.agent_branches")) return { rows: [structuredClone(branch)] };
          if (text.includes("FROM public.agent_sessions")) return { rows: [{ status: "active", active_turn_id: null, event_sequence: "5" }] };
          if (text.includes("FROM public.skill_drafts draft")) return { rows: [structuredClone(draftRow)] };
          if (text.includes("INSERT INTO public.skill_draft_revision_snapshots")) return { rows: [] };
          if (text.includes("UPDATE public.skill_drafts")) {
            savedDefinition = JSON.parse(config.values[7]);
            return { rows: [{ skill_draft_id: "draft-alpha" }] };
          }
          if (text.includes("UPDATE public.skill_assets") || text.includes("UPDATE public.agent_branches")) return { rows: [] };
          if (text.includes("UPDATE public.agent_sessions")) return { rows: [{ event_sequence: "6" }] };
          if (text.includes("UPDATE public.agent_object_proposals")) return { rows: [{ ...skillProposal, status: "accepted", decided_at: NOW }] };
          if (text.includes("INSERT INTO public.agent_session_events")
            || text.includes("INSERT INTO public.agent_session_decision_events")
            || text.includes("UPDATE public.product_idempotency_receipts") || text.includes("SET CONSTRAINTS")) return { rows: [] };
          throw new Error(`unexpected_query:${text}`);
        },
      });
    },
  };
  const lifecycle = new PostgresAgentProposalLifecycle({
    store, clock: () => NOW, idFactory: (kind) => `${kind}-test`,
    commandAuthorizer: authorityFixture(), commandIntake: commandIntakeFixture(),
  });
  const result = await lifecycle.apply({
    sessionId: "session-alpha", proposalId: "proposal-alpha", idempotencyKey: "apply-alpha",
    request: { schemaVersion: "workbench-api-v1", data: {} },
    context: { workspaceId: "workspace-alpha", userId: "alice", role: "member" },
  });
  assert.equal(result.status, "accepted");
  assert.equal(savedDefinition.category, "analysis");
  assert.equal(savedDefinition.revision, 4);
  assert.ok(calls.some((text) => text.includes("skill_draft_revision_snapshots")));
  assert.ok(calls.some((text) => text.includes("agent.proposal.accepted")));
});

test("PostgreSQL Skill proposal conflict records only hashed conflict evidence and leaves the canonical Draft untouched", async () => {
  const baseDraft = {
    schemaVersion: "workbench-v1", skillDraftId: "draft-alpha", skillId: "skill-alpha",
    workspaceId: "workspace-alpha", baseVersionId: null, revision: 3, name: "Research",
    description: "Base description", category: "research",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: {}, required: [] },
    risk: { level: "low", externalAction: false, summary: "Read only." },
    dependencies: [], connectionRequirements: [], files: [], updatedBy: "alice",
    createdAt: NOW, updatedAt: NOW,
  };
  const conflictProposal = {
    ...proposal, definition_id: "skill_creator", object_kind: "skill_draft", object_id: "draft-alpha",
    base_version_id: "draft-alpha:3", payload: {
      summary: "Change the description.",
      operations: [{ op: "replace", path: "/description", value: "Agent description" }],
      evidenceRefs: [], validationResult: { status: "passed", diagnostics: [] },
    },
  };
  const currentDefinition = { ...baseDraft, revision: 4, description: "Collaborator description", updatedAt: NOW };
  const branch = {
    branch_id: "branch-alpha", workspace_id: "workspace-alpha", user_id: "alice",
    object_kind: "skill_draft", object_id: "draft-alpha", base_version_id: "draft-alpha:3",
    status: "active", payload: { baseSnapshot: baseDraft },
  };
  const calls = [];
  let persistedProposalPayload = null;
  const store = {
    async withTransaction(work) { return work({ kind: "postgres_unit_of_work" }); },
    bindAdapter(factory) {
      return factory({
        async execute(_uow, config) {
          const text = config.text;
          calls.push(text);
          if (text.includes("FROM public.workspace_memberships")) return { rows: [{ role: "member" }] };
          if (text.includes("INSERT INTO public.product_idempotency_receipts")) return { rows: [{ request_hash: config.values[4], response: null }] };
          if (text.includes("FROM public.agent_object_proposals")) return { rows: [structuredClone(conflictProposal)] };
          if (text.includes("FROM public.agent_branches")) return { rows: [structuredClone(branch)] };
          if (text.includes("FROM public.agent_sessions")) return { rows: [{ status: "active", active_turn_id: null, event_sequence: "5" }] };
          if (text.includes("FROM public.skill_drafts draft")) return { rows: [{
            workspace_id: "workspace-alpha", skill_draft_id: "draft-alpha", skill_id: "skill-alpha",
            schema_version: "workbench-v1", base_version_id: null, draft_revision: 4,
            content_hash: "sha256:0123456789abcdef", updated_by: "alice", created_at: NOW, updated_at: NOW,
            definition: currentDefinition, owner_user_id: "alice", current_draft_id: "draft-alpha", asset_lifecycle: "draft",
          }] };
          if (text.includes("UPDATE public.agent_branches")) return { rows: [] };
          if (text.includes("UPDATE public.agent_sessions")) return { rows: [{ event_sequence: "6" }] };
          if (text.includes("UPDATE public.agent_object_proposals")) {
            persistedProposalPayload = JSON.parse(config.values[3]);
            return { rows: [{ ...conflictProposal, status: "conflicting", payload: persistedProposalPayload }] };
          }
          if (text.includes("INSERT INTO public.agent_session_events")
            || text.includes("INSERT INTO public.agent_session_decision_events")
            || text.includes("UPDATE public.product_idempotency_receipts")) return { rows: [] };
          throw new Error(`unexpected_query:${text}`);
        },
      });
    },
  };
  const lifecycle = new PostgresAgentProposalLifecycle({
    store, clock: () => NOW, idFactory: (kind) => `${kind}-test`,
    commandAuthorizer: authorityFixture(), commandIntake: commandIntakeFixture(),
  });
  const result = await lifecycle.apply({
    sessionId: "session-alpha", proposalId: "proposal-alpha", idempotencyKey: "conflict-alpha",
    request: { schemaVersion: "workbench-api-v1", data: {} },
    context: { workspaceId: "workspace-alpha", userId: "alice", role: "member" },
  });
  assert.equal(result.status, "conflicting");
  assert.equal(persistedProposalPayload.conflicts.length, 1);
  assert.equal(persistedProposalPayload.conflicts[0].path, "/description");
  assert.equal(JSON.stringify(persistedProposalPayload.conflicts).includes("Collaborator description"), false);
  assert.equal(calls.some((text) => text.includes("skill_draft_revision_snapshots")), false);
});

test("PostgreSQL private dependency-free Loop proposal commits a blocked next revision without Mongo fallback", async () => {
  const base = makeRevision();
  const input = base.graph.nodes.find((node) => node.kind === "Input");
  const output = base.graph.nodes.find((node) => node.kind === "Output");
  output.inputBindings = [{ targetPort: "content", source: { kind: "nodeOutput", nodeId: input.nodeId, portId: "topic" } }];
  base.graph = {
    nodes: [input, output],
    edges: [{ edgeId: "edge-input-output", sourceNodeId: input.nodeId, sourcePort: "topic", targetNodeId: output.nodeId, targetPort: "content" }],
  };
  base.workflowId = "workflow-alpha";
  base.revisionId = "revision-alpha";
  base.revisionNumber = 1;
  base.contentHash = "sha256:0123456789abcdef";
  base.authoredBy = "alice";
  const workflowProposal = {
    ...proposal, object_kind: "workflow", object_id: "workflow-alpha", base_version_id: "revision-alpha",
    payload: {
      summary: "Allow a longer default timeout.",
      operations: [{ op: "replace", path: "/runSettings/defaultTimeoutSeconds", value: 120 }],
      evidenceRefs: [], validationResult: { status: "passed", diagnostics: [] },
    },
  };
  const branch = {
    branch_id: "branch-alpha", workspace_id: "workspace-alpha", user_id: "alice",
    object_kind: "workflow", object_id: "workflow-alpha", base_version_id: "revision-alpha",
    status: "active", payload: { baseSnapshot: base },
  };
  const revisionRow = {
    workspace_id: "workspace-alpha", schema_version: "workbench-v1", revision_id: "revision-alpha",
    workflow_id: "workflow-alpha", revision_number: 1, base_revision_id: null,
    graph: base.graph, input_form: base.inputForm, output_definition: base.outputDefinition,
    resource_refs: [], run_settings: base.runSettings, definition: null, content_hash: base.contentHash,
    authored_by: "alice", save_reason: base.saveReason, created_at: NOW, updated_at: NOW,
  };
  const calls = [];
  let savedRevision = null;
  const store = {
    async withTransaction(work) { return work({ kind: "postgres_unit_of_work" }); },
    bindAdapter(factory) {
      return factory({
        async execute(_uow, config) {
          const text = config.text;
          calls.push(text);
          if (text.includes("FROM public.workspace_memberships")) return { rows: [{ role: "member" }] };
          if (text.includes("INSERT INTO public.product_idempotency_receipts")) return { rows: [{ request_hash: config.values[4], response: null }] };
          if (text.includes("FROM public.agent_object_proposals")) return { rows: [structuredClone(workflowProposal)] };
          if (text.includes("FROM public.agent_branches")) return { rows: [structuredClone(branch)] };
          if (text.includes("FROM public.agent_sessions")) return { rows: [{ status: "active", active_turn_id: null, event_sequence: "5" }] };
          if (text.includes("FROM public.workflows")) return { rows: [{
            workflow_id: "workflow-alpha", owner_user_id: "alice", visibility: "private",
            current_revision_id: "revision-alpha", current_revision_number: 1, write_version: 1,
          }] };
          if (text.includes("FROM public.workflow_revisions")) return { rows: [structuredClone(revisionRow)] };
          if (text.includes("INSERT INTO public.workflow_revisions")) {
            savedRevision = { revisionId: config.values[1], timeout: JSON.parse(config.values[10]).defaultTimeoutSeconds };
            return { rows: [] };
          }
          if (text.includes("UPDATE public.workflows")) return { rows: [{ workflow_id: "workflow-alpha" }] };
          if (text.includes("UPDATE public.agent_branches")) return { rows: [] };
          if (text.includes("UPDATE public.agent_sessions")) return { rows: [{ event_sequence: "6" }] };
          if (text.includes("UPDATE public.agent_object_proposals")) return { rows: [{ ...workflowProposal, status: "accepted", decided_at: NOW }] };
          if (text.includes("INSERT INTO public.agent_session_events")
            || text.includes("INSERT INTO public.agent_session_decision_events")
            || text.includes("UPDATE public.product_idempotency_receipts") || text.includes("SET CONSTRAINTS")) return { rows: [] };
          throw new Error(`unexpected_query:${text}`);
        },
      });
    },
  };
  const lifecycle = new PostgresAgentProposalLifecycle({
    store, clock: () => NOW, idFactory: (kind) => `${kind}-test`,
    commandAuthorizer: authorityFixture(), commandIntake: commandIntakeFixture(),
  });
  const result = await lifecycle.apply({
    sessionId: "session-alpha", proposalId: "proposal-alpha", idempotencyKey: "apply-workflow-alpha",
    request: { schemaVersion: "workbench-api-v1", data: {} },
    context: { workspaceId: "workspace-alpha", userId: "alice", role: "member" },
  });
  assert.equal(result.status, "accepted");
  assert.equal(savedRevision.timeout, 120);
  assert.match(savedRevision.revisionId, /^revision-test$/);
  assert.ok(calls.some((text) => text.includes("lifecycle = 'blocked'")));
});

test("Application routes PG proposal rejection through the injected lifecycle instead of legacy repositories", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    agentTurnRunner: { async getSession() { return { scope: { branchId: "branch-alpha" } }; } },
    workflowReadModel: { async getWorkflow() { return { workflow: { workflowId: "workflow-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private" }, etag: '"workflow:workflow-alpha:1"' }; } },
    agentProposalReadModel: { async getProposal() { return { proposalId: "proposal-alpha", sessionId: "session-alpha", userId: "alice", createdBy: "alice", branchId: "branch-alpha", objectKind: "workflow", objectId: "workflow-alpha" }; } },
    agentProposalLifecycle: { async reject(input) { calls.push(input); return { proposalId: input.proposalId, status: "rejected" }; } },
  });
  const result = await application.rejectAgentProposal({
    sessionId: "session-alpha", proposalId: "proposal-alpha", idempotencyKey: "reject-alpha",
    request: { schemaVersion: "workbench-api-v1", data: {} },
    auth: { userId: "alice", workspaceId: "workspace-alpha", role: "member" },
  });
  assert.deepEqual(result, { proposalId: "proposal-alpha", status: "rejected" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.userId, "alice");
});

test("Application routes PG proposal apply through the injected lifecycle instead of legacy repositories", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    agentTurnRunner: { async getSession() { return { scope: { branchId: "branch-alpha" } }; } },
    workflowReadModel: { async getWorkflow() { return { workflow: { workflowId: "workflow-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private" }, etag: '"workflow:workflow-alpha:1"' }; } },
    agentProposalReadModel: { async getProposal() { return { proposalId: "proposal-alpha", sessionId: "session-alpha", userId: "alice", createdBy: "alice", branchId: "branch-alpha", objectKind: "workflow", objectId: "workflow-alpha" }; } },
    agentProposalLifecycle: { async apply(input) { calls.push(input); return { proposalId: input.proposalId, status: "accepted" }; } },
  });
  const result = await application.applyAgentProposal({
    sessionId: "session-alpha", proposalId: "proposal-alpha", idempotencyKey: "apply-alpha",
    request: { schemaVersion: "workbench-api-v1", data: {} },
    auth: { userId: "alice", workspaceId: "workspace-alpha", role: "member" },
  });
  assert.deepEqual(result, { proposalId: "proposal-alpha", status: "accepted" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.userId, "alice");
});
