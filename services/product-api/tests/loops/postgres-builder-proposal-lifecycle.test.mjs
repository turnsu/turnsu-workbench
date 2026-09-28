import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresBuilderProposalLifecycle,
  PostgresBuilderProposalReadModel,
} from "../../src/loops/postgres-builder-proposal-lifecycle.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { makeRevision } from "../compiler/fixtures.mjs";

const NOW = "2026-08-11T03:00:00.000Z";
function publicProposal(overrides = {}) {
  const revision = makeRevision();
  return { schemaVersion: "workbench-v1", proposalId: "proposal-alpha", kind: "staged_loop_draft",
    workspaceId: "workspace-alpha", createdBy: "alice", createdAt: NOW, expiresAt: FUTURE_EXPIRY,
    decidedAt: null, status: "proposed", summary: "Review a document.", operations: [], diagnostics: [], permissionImpact: [],
    draft: { name: "Review Loop", description: "Review a document.", definition: { goal: "Review a document.", context: "", constraints: [], doneWhen: [], verify: [], expectedResult: "A review.", stopRules: [] },
      graph: revision.graph, inputForm: revision.inputForm, outputDefinition: revision.outputDefinition, resourceRefs: [], runSettings: revision.runSettings }, ...overrides };
}
const FUTURE_EXPIRY = new Date(Date.now() + (60 * 60 * 1000)).toISOString();
const stagedRow = Object.freeze({
  workspace_id: "workspace-alpha", proposal_id: "proposal-alpha", scope_id: "scope-alpha",
  created_by_principal_id: "alice", created_by_principal_kind: "user", product_command_id: "command-alpha",
  schema_version: "workbench-v1", kind: "staged_loop_draft", workflow_id: null, base_revision_id: null,
  planned_invocation_id: "invocation-alpha", planned_attempt_id: "attempt-alpha",
  source_invocation_id: "invocation-alpha", source_attempt_id: "attempt-alpha",
  status: "proposed", generation_status: "completed", summary: "Create a review Loop.", prompt: null,
  staged_draft: { name: "Review Loop", description: "Review a document." }, operations: [], diagnostics: [], permission_impact: [],
  expires_at: "2026-08-12T03:00:00.000Z", created_at: NOW, decided_at: null, payload: {},
});

test("PostgreSQL Builder proposal read model returns only the creator's completed, unexpired staged proposal", async () => {
  const store = {
    async withTransaction(work) { return work({ kind: "postgres_unit_of_work" }); },
    async connect() {},
    bindAdapter(factory) {
      return factory({
        async execute(_uow, config) {
          assert.match(config.text, /FROM public\.builder_proposals/);
          assert.deepEqual(config.values, ["workspace-alpha", "proposal-alpha", "alice", "staged_loop_draft", null]);
          return { rows: [structuredClone(stagedRow)] };
        },
      });
    },
  };
  const model = new PostgresBuilderProposalReadModel({ store });
  const result = await model.getStaged({
    proposalId: "proposal-alpha", workspaceId: "workspace-alpha", userId: "alice", now: NOW,
  });
  assert.equal(result.kind, "staged_loop_draft");
  assert.equal(result.createdBy, "alice");
  assert.deepEqual(result.draft, stagedRow.staged_draft);
});

test("PostgreSQL Builder staged dismissal atomically writes its decision receipt without changing a Loop", async () => {
  const calls = [];
  const store = {
    async withTransaction(work) { return work({ kind: "postgres_unit_of_work" }); },
    bindAdapter(factory) {
      return factory({
        async execute(_uow, config) {
          const text = config.text;
          calls.push(text);
          if (text.includes("FROM public.workspace_memberships")) return { rows: [{ role: "member" }] };
          if (text.includes("INSERT INTO public.product_idempotency_receipts")) return { rows: [{ request_hash: config.values[4], response: null }] };
          if (text.includes("FROM public.builder_proposals")) return { rows: [structuredClone(stagedRow)] };
          if (text.includes("UPDATE public.builder_proposals")) return { rows: [{ ...stagedRow, status: "dismissed", decided_at: NOW }] };
          if (text.includes("UPDATE public.product_idempotency_receipts")) return { rows: [] };
          throw new Error(`unexpected_query:${text}`);
        },
      });
    },
  };
  const lifecycle = new PostgresBuilderProposalLifecycle({ store, clock: () => NOW });
  const result = await lifecycle.dismiss({
    proposalId: "proposal-alpha", staged: true, idempotencyKey: "dismiss-alpha",
    request: { schemaVersion: "workbench-api-v1", data: {} },
    context: { workspaceId: "workspace-alpha", userId: "alice" },
  });
  assert.equal(result.status, "dismissed");
  assert.ok(calls.some((text) => text.includes("UPDATE public.builder_proposals")));
  assert.equal(calls.some((text) => /UPDATE public\.workflows/.test(text)), false);
});

test("PostgreSQL Builder apply atomically advances a dependency-free private Loop and its proposal", async () => {
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
    ...stagedRow, kind: "workflow_change", workflow_id: "workflow-alpha", base_revision_id: "revision-alpha",
    staged_draft: null, expires_at: null, summary: "Increase timeout.",
    operations: [{ op: "updateWorkflowSettings", runSettings: { ...base.runSettings, defaultTimeoutSeconds: 120 } }],
  };
  const revisionRow = {
    workspace_id: "workspace-alpha", schema_version: "workbench-v1", revision_id: "revision-alpha",
    workflow_id: "workflow-alpha", revision_number: 1, base_revision_id: null,
    graph: base.graph, input_form: base.inputForm, output_definition: base.outputDefinition,
    resource_refs: [], run_settings: base.runSettings, definition: null, content_hash: base.contentHash,
    authored_by: "alice", save_reason: base.saveReason, created_at: NOW, updated_at: NOW,
  };
  const calls = [];
  let savedTimeout = null;
  const store = {
    async withTransaction(work) { return work({ kind: "postgres_unit_of_work" }); },
    bindAdapter(factory) {
      return factory({
        async execute(_uow, config) {
          const text = config.text;
          calls.push(text);
          if (text.includes("FROM public.workspace_memberships")) return { rows: [{ role: "member" }] };
          if (text.includes("INSERT INTO public.product_idempotency_receipts")) return { rows: [{ request_hash: config.values[4], response: null }] };
          if (text.includes("FROM public.builder_proposals")) return { rows: [structuredClone(workflowProposal)] };
          if (text.includes("FROM public.workflows")) return { rows: [{
            workflow_id: "workflow-alpha", visibility: "private", current_revision_id: "revision-alpha",
            current_revision_number: 1, write_version: 1,
          }] };
          if (text.includes("FROM public.workflow_revisions")) return { rows: [structuredClone(revisionRow)] };
          if (text.includes("INSERT INTO public.workflow_revisions")) {
            savedTimeout = JSON.parse(config.values[10]).defaultTimeoutSeconds;
            return { rows: [] };
          }
          if (text.includes("UPDATE public.workflows")) return { rows: [{ workflow_id: "workflow-alpha" }] };
          if (text.includes("UPDATE public.builder_proposals")) return { rows: [{ ...workflowProposal, status: "applied", decided_at: NOW }] };
          if (text.includes("UPDATE public.product_idempotency_receipts") || text.includes("SET CONSTRAINTS")) return { rows: [] };
          throw new Error(`unexpected_query:${text}`);
        },
      });
    },
  };
  const lifecycle = new PostgresBuilderProposalLifecycle({ store, clock: () => NOW });
  const result = await lifecycle.apply({
    proposalId: "proposal-alpha", workflowId: "workflow-alpha", idempotencyKey: "apply-alpha",
    ifMatch: '"wfv1:workflow-alpha:1:revision-alpha"', request: { data: { baseRevisionId: "revision-alpha" } },
    context: { workspaceId: "workspace-alpha", userId: "alice" },
  });
  assert.equal(result.status, "applied");
  assert.equal(savedTimeout, 120);
  assert.ok(calls.some((text) => text.includes("lifecycle = 'blocked'")));
});

test("PostgreSQL staged proposal commit creates one private Loop revision and consumes the proposal", async () => {
  const base = makeRevision();
  const input = base.graph.nodes.find((node) => node.kind === "Input");
  const output = base.graph.nodes.find((node) => node.kind === "Output");
  output.inputBindings = [{ targetPort: "content", source: { kind: "nodeOutput", nodeId: input.nodeId, portId: "topic" } }];
  const draft = {
    name: "Staged review", description: "Review a document.",
    graph: { nodes: [input, output], edges: [{ edgeId: "edge-input-output", sourceNodeId: input.nodeId, sourcePort: "topic", targetNodeId: output.nodeId, targetPort: "content" }] },
    inputForm: base.inputForm, outputDefinition: base.outputDefinition, resourceRefs: [], runSettings: base.runSettings,
  };
  const proposal = { ...stagedRow, staged_draft: draft };
  const calls = [];
  const store = {
    async withTransaction(work) { return work({ kind: "postgres_unit_of_work" }); },
    bindAdapter(factory) {
      return factory({
        async execute(_uow, config) {
          const text = config.text;
          calls.push(text);
          if (text.includes("FROM public.workspace_memberships")) return { rows: [{ role: "member" }] };
          if (text.includes("INSERT INTO public.product_idempotency_receipts")) return { rows: [{ request_hash: config.values[4], response: null }] };
          if (text.includes("FROM public.builder_proposals")) return { rows: [structuredClone(proposal)] };
          if (text.includes("FROM public.product_scopes")) return { rows: [{ scope_id: "personal-alpha" }] };
          if (text.includes("INSERT INTO public.workflows") || text.includes("INSERT INTO public.workflow_revisions")) return { rows: [] };
          if (text.includes("UPDATE public.builder_proposals")) return { rows: [{ ...proposal, status: "applied", decided_at: NOW }] };
          if (text.includes("UPDATE public.product_idempotency_receipts") || text.includes("SET CONSTRAINTS")) return { rows: [] };
          throw new Error(`unexpected_query:${text}`);
        },
      });
    },
  };
  const lifecycle = new PostgresBuilderProposalLifecycle({ store, clock: () => NOW });
  const result = await lifecycle.commitStaged({
    proposalId: "proposal-alpha", idempotencyKey: "commit-alpha", request: { data: { draft: { ...draft, name: "Reviewed name" } } },
    context: { workspaceId: "workspace-alpha", userId: "alice" },
  });
  assert.equal(result.workflow.workflowId, "workflow-proposal-alpha");
  assert.equal(result.workflow.lifecycle, "draft");
  assert.equal(result.workflow.name, "Reviewed name");
  assert.equal(result.revision.revisionId, "revision-proposal-alpha");
  assert.equal(result.proposal.status, "applied");
  assert.ok(calls.some((text) => text.includes("INSERT INTO public.workflow_revisions")));
});

test("PostgreSQL Builder generation owns one explicit command and only publishes a completed Worker result", async () => {
  const base = makeRevision();
  const input = base.graph.nodes.find((node) => node.kind === "Input");
  const output = base.graph.nodes.find((node) => node.kind === "Output");
  output.inputBindings = [{ targetPort: "content", source: { kind: "nodeOutput", nodeId: input.nodeId, portId: "topic" } }];
  const draft = {
    name: "Generated review", description: "A generated review Loop.",
    graph: { nodes: [input, output], edges: [{ edgeId: "edge-input-output", sourceNodeId: input.nodeId, sourcePort: "topic", targetNodeId: output.nodeId, targetPort: "content" }] },
    inputForm: base.inputForm, outputDefinition: base.outputDefinition, resourceRefs: [], runSettings: base.runSettings,
  };
  const initial = {
    ...stagedRow, planned_invocation_id: "invocation-proposal-alpha", planned_attempt_id: "attempt-proposal-alpha-1",
    source_invocation_id: null, source_attempt_id: null, status: "generating", generation_status: "accepted",
    summary: "Generating Loop proposal.", staged_draft: {}, expires_at: "2026-08-12T03:00:00.000Z",
  };
  const running = { ...initial, generation_status: "running" };
  const completed = {
    ...running, source_invocation_id: "invocation-proposal-alpha", source_attempt_id: "attempt-proposal-alpha-1",
    status: "proposed", generation_status: "completed", summary: "Generated review Loop.", staged_draft: draft,
    operations: [], diagnostics: [], permission_impact: [],
  };
  let phase = "begin";
  const calls = [];
  const store = {
    async withTransaction(work) { return work({ kind: "postgres_unit_of_work" }); },
    bindAdapter(factory) {
      return factory({
        async execute(_uow, config) {
          const text = config.text; calls.push(text);
          if (text.includes("INSERT INTO public.builder_proposals")) return { rows: [structuredClone(initial)] };
          if (text.includes("FROM public.builder_proposals")) return { rows: [structuredClone(phase === "begin" ? initial : phase === "start" ? initial : running)] };
          if (text.includes("SET generation_status = 'running'")) { phase = "complete"; return { rows: [structuredClone(running)] }; }
          if (text.includes("SET source_invocation_id")) return { rows: [structuredClone(completed)] };
          throw new Error(`unexpected_query:${text}`);
        },
      });
    },
  };
  const commandCalls = [];
  const commandIntake = {
    async accept(input) {
      commandCalls.push(["accept", input.command]);
      const target = await input.persistTarget({ uow: { kind: "postgres_unit_of_work" } });
      return { command: { commandId: input.command.commandId, status: "accepted" }, target, replayed: false };
    },
    async start(input) { commandCalls.push(["start", input]); return { commandId: input.commandId, status: "running" }; },
    async settle(input) { commandCalls.push(["settle", input]); return { commandId: input.commandId, status: input.status }; },
  };
  const lifecycle = new PostgresBuilderProposalLifecycle({
    store,
    clock: () => NOW,
    commandIntake,
    commandAuthorizer: {
      async authorizeBuilderProposal() {
        return { scopeId: "scope-alpha", authorizationDecisionId: "decision-alpha", argumentDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
      },
    },
  });
  const context = { workspaceId: "workspace-alpha", userId: "alice" };
  const begun = await lifecycle.beginStagedGeneration({ proposalId: "proposal-alpha", context, request: { data: { sourceText: "Review this", name: draft.name, definition: { goal: "Review" } } } });
  assert.equal(begun.proposal.generationStatus, "accepted");
  const started = await lifecycle.startGeneration({ proposalId: "proposal-alpha", context });
  assert.equal(started.proposal.generationStatus, "running");
  const settled = await lifecycle.completeStagedGeneration({
    proposalId: "proposal-alpha", context,
    result: { invocationId: "invocation-proposal-alpha", attemptId: "attempt-proposal-alpha-1", summary: completed.summary, draft, operations: [], diagnostics: [], permissionImpact: [] },
  });
  assert.equal(settled.proposal.status, "proposed");
  assert.deepEqual(commandCalls.map(([kind]) => kind), ["accept", "start", "settle"]);
  assert.ok(calls.some((text) => text.includes("INSERT INTO public.builder_proposals")));
  assert.ok(calls.some((text) => text.includes("SET source_invocation_id")));
});

test("PostgreSQL application consumes Builder read/dismiss owners and reports a missing execution backend without legacy repositories", async () => {
  const calls = [];
  const proposal = publicProposal({ requestHash: "internal", generationStatus: "completed" });
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    builderProposalReadModel: { async getStaged(input) { calls.push({ kind: "read", input }); return proposal; } },
    builderProposalLifecycle: { async dismiss(input) { calls.push({ kind: "dismiss", input }); return publicProposal({ proposalId: input.proposalId, status: "dismissed" }); } },
  });
  const read = await application.getStagedLoopProposal({
    proposalId: "proposal-alpha", auth: { userId: "alice", workspaceId: "workspace-alpha" },
  });
  assert.equal(read.proposalId, "proposal-alpha");
  assert.equal(Object.hasOwn(read, "requestHash"), false);
  assert.equal(Object.hasOwn(read, "generationStatus"), false);
  const dismissed = await application.dismissStagedLoopProposal({
    proposalId: "proposal-alpha", idempotencyKey: "dismiss-alpha", request: { data: {} },
    auth: { userId: "alice", workspaceId: "workspace-alpha", role: "member" },
  });
  assert.equal(dismissed.status, "dismissed");
  await assert.rejects(
    application.generateStagedLoopProposal({
      idempotencyKey: "generate-alpha", request: { data: {} },
      auth: { userId: "alice", workspaceId: "workspace-alpha", role: "member" },
    }),
    { code: "builder_proposal_unavailable" },
  );
  assert.deepEqual(calls.map((call) => call.kind), ["read", "dismiss"]);
});

test("PostgreSQL application generates a staged Loop through the injected PG lifecycle and bounded Worker", async () => {
  const calls = [];
  const requests = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    externalMutationPort: { async run(_options, mutation) { return mutation("proposal-alpha"); } },
    modelCatalog: {
      async resolveCurrentProfile() {
        return { revision: { revisionId: "model-revision-alpha" } };
      },
    },
    executionBroker: {
      async probeBackend() { return { available: true, verified: true }; },
      async execute(request) {
        requests.push(request);
        return {
          status: "completed", startedAt: NOW,
          output: { summary: "A review Loop.", operations: [], diagnostics: [], permissionImpact: [] },
        };
      },
    },
    builderProposalReadModel: { async getStaged() { return null; } },
    builderProposalLifecycle: {
      async beginStagedGeneration(input) { calls.push(["begin", input]); return { proposal: { proposalId: input.proposalId } }; },
      async startGeneration(input) {
        calls.push(["start", input]);
        return { command: { status: "running" }, execution: { invocationId: "invocation-proposal-alpha", attemptId: "attempt-proposal-alpha-1" } };
      },
      async completeStagedGeneration(input) {
        calls.push(["complete", input]);
        return { proposal: publicProposal({ proposalId: input.proposalId, draft: input.result.draft }) };
      },
      async failStagedGeneration(input) { calls.push(["fail", input]); },
    },
  });
  const result = await application.generateStagedLoopProposal({
    idempotencyKey: "proposal-alpha",
    request: { data: {
      name: "Implementation plan", sourceText: "Review the PRD.", modelProfileId: "model-alpha",
      definition: { goal: "Produce a plan.", context: "Approved PRD.", constraints: ["Keep scope."], doneWhen: ["Reviewable."], verify: ["Trace."], expectedResult: "A plan.", stopRules: [] },
    } },
    auth: { userId: "alice", workspaceId: "workspace-alpha", role: "member" },
  });
  assert.equal(result.proposalId, "proposal-alpha");
  assert.deepEqual(calls.map(([kind]) => kind), ["begin", "start", "complete"]);
  assert.equal(calls[2][1].result.invocationId, "invocation-proposal-alpha");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].mode, "bounded_agent");
  assert.equal(requests[0].lineage.productCommandId, "builder-command-proposal-alpha");
});
