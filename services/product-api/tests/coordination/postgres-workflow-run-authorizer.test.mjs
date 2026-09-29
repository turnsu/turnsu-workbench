import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAgentCommandAuthorizer } from "../../src/coordination/postgres-agent-command-authorizer.mjs";
import { canonicalRequestHash } from "../../src/store/serialization.mjs";

test("Workflow Run authorization digest is identical to the durable Runner request", async () => {
  const queries = [];
  const store = {
    bindAdapter(factory) {
      return factory({
        async execute(_uow, { text, values }) {
          queries.push({ text, values });
          if (/FROM public\.product_scopes scope/.test(text)) {
            return { rows: [{
              scope_id: "scope-alice", current_policy_revision_id: "policy-alice",
              permission_mode: "interactive", auto_approved_effect_classes: [],
              auto_approved_action_ids: [], grant_id: "grant-alice",
            }] };
          }
          if (/SELECT clock_timestamp\(\) AS now/.test(text)) {
            return { rows: [{ now: "2026-08-11T00:00:00.000Z" }] };
          }
          return { rows: [] };
        },
      });
    },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
  };
  const authorizer = new PostgresAgentCommandAuthorizer({
    store,
    idFactory: (kind) => `${kind}-test`,
  });
  const authority = await authorizer.authorizeWorkflowRun({
    workspaceId: "workspace-alpha", userId: "alice", workflowId: "workflow-alpha",
    workflowRevisionId: "revision-alpha", inputs: { topic: "authority" },
    resourceRefs: [], materialBindings: [],
  });
  const expectedRequest = {
    workflowId: "workflow-alpha", workflowRevisionId: "revision-alpha",
    inputs: { topic: "authority" }, resourceRefs: [], materialBindings: [],
    requestedBy: "alice", retryOf: null,
  };
  assert.equal(authority.argumentDigest, canonicalRequestHash(expectedRequest));
  const inserted = queries.filter(({ text }) => /INSERT INTO public\.authorization_decisions/.test(text));
  assert.equal(inserted.length, 2);
  assert.ok(inserted.every(({ values }) => values.includes(authority.argumentDigest)));
  assert.ok(inserted.every(({ values }) => values.includes("workflow_run")));
});

test("Workflow Run retry authorization binds the source's immutable request instead of a browser-supplied replay", async () => {
  const queries = [];
  const source = {
    workflow_id: "workflow-alpha",
    workflow_revision_id: "revision-alpha",
    scope_id: "scope-alice",
    inputs: { topic: "pinned source" },
    resource_refs: [{ resourceId: "resource-alpha", version: 1, contentHash: `sha256:${"a".repeat(64)}` }],
    payload: { skillMaterialBindings: [{ nodeId: "node-alpha", binding: { materialKey: "source" } }] },
    status: "failed",
  };
  const store = {
    bindAdapter(factory) {
      return factory({
        async execute(_uow, { text, values }) {
          queries.push({ text, values });
          if (/FROM public\.workflow_runs/.test(text)) return { rows: [structuredClone(source)] };
          if (/FROM public\.product_scopes scope/.test(text)) {
            return { rows: [{
              scope_id: "scope-alice", current_policy_revision_id: "policy-alice",
              permission_mode: "interactive", auto_approved_effect_classes: [],
              auto_approved_action_ids: [], grant_id: "grant-alice",
            }] };
          }
          if (/SELECT clock_timestamp\(\) AS now/.test(text)) {
            return { rows: [{ now: "2026-08-13T00:00:00.000Z" }] };
          }
          return { rows: [] };
        },
      });
    },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
  };
  const authorizer = new PostgresAgentCommandAuthorizer({
    store,
    idFactory: (kind) => `${kind}-retry-test`,
  });
  const authority = await authorizer.authorizeWorkflowRunRetry({
    workspaceId: "workspace-alpha",
    userId: "alice",
    runId: "run-source",
    reason: "Retry after a transient failure.",
  });
  const expectedRequest = {
    workflowId: source.workflow_id,
    workflowRevisionId: source.workflow_revision_id,
    inputs: source.inputs,
    resourceRefs: source.resource_refs,
    materialBindings: source.payload.skillMaterialBindings,
    requestedBy: "alice",
    retryOf: "run-source",
    retryCommand: {
      requestedBy: "alice",
      reason: "Retry after a transient failure.",
    },
  };
  assert.equal(authority.argumentDigest, canonicalRequestHash(expectedRequest));
  const scopeQuery = queries.find(({ text }) => /FROM public\.product_scopes scope/.test(text));
  assert.deepEqual(scopeQuery.values, ["workspace-alpha", "alice", "scope-alice"]);
  const inserted = queries.filter(({ text }) => /INSERT INTO public\.authorization_decisions/.test(text));
  assert.equal(inserted.length, 2);
  assert.ok(inserted.every(({ values }) => values.includes(authority.argumentDigest)));
});

test("an auto scope can issue an explicit review authority only for its own pending Automation Run", async () => {
  const queries = [];
  const store = {
    bindAdapter(factory) {
      return factory({
        async execute(_uow, { text, values }) {
          queries.push({ text, values });
          if (/FROM public\.product_scopes scope/.test(text)) {
            return { rows: [{
              scope_id: "scope-alice", current_policy_revision_id: "policy-auto",
              permission_mode: "auto", auto_approved_effect_classes: ["execute"],
              auto_approved_action_ids: [], grant_id: "grant-alice",
            }] };
          }
          if (/FROM public\.workflow_runs run/.test(text)) return { rows: [{}] };
          if (/SELECT clock_timestamp\(\) AS now/.test(text)) {
            return { rows: [{ now: "2026-08-13T00:00:00.000Z" }] };
          }
          return { rows: [] };
        },
      });
    },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
  };
  const authorizer = new PostgresAgentCommandAuthorizer({
    store,
    idFactory: (kind) => `${kind}-automation-review-test`,
  });

  const authority = await authorizer.authorizeWorkflowRunReview({
    workspaceId: "workspace-alpha",
    userId: "alice",
    runId: "automation-run-alpha",
    nodeId: "review-alpha",
    decision: "approve",
    requestedChanges: [],
  });

  assert.equal(authority.scopeId, "scope-alice");
  const provenance = queries.find(({ text }) => /JOIN public\.automation_occurrences occurrence/.test(text));
  assert.deepEqual(provenance.values, [
    "workspace-alpha", "automation-run-alpha", "scope-alice", "alice", "review-alpha",
  ]);
  assert.match(provenance.text, /occurrence\.status = 'accepted'/);
  assert.match(provenance.text, /review\.status = 'pending'/);
  assert.match(provenance.text, /automation\.owner_user_id = \$4/);
  assert.equal(queries.filter(({ text }) => /INSERT INTO public\.authorization_decisions/.test(text)).length, 2);
});

test("an auto scope cannot turn an ordinary Run review into unattended authority", async () => {
  const store = {
    bindAdapter(factory) {
      return factory({
        async execute(_uow, { text }) {
          if (/FROM public\.product_scopes scope/.test(text)) {
            return { rows: [{
              scope_id: "scope-alice", current_policy_revision_id: "policy-auto",
              permission_mode: "auto", auto_approved_effect_classes: ["execute"],
              auto_approved_action_ids: [], grant_id: "grant-alice",
            }] };
          }
          if (/FROM public\.workflow_runs run/.test(text)) return { rows: [] };
          return { rows: [] };
        },
      });
    },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
  };
  const authorizer = new PostgresAgentCommandAuthorizer({ store });

  await assert.rejects(
    authorizer.authorizeWorkflowRunReview({
      workspaceId: "workspace-alpha",
      userId: "alice",
      runId: "ordinary-run-alpha",
      nodeId: "review-alpha",
      decision: "approve",
      requestedChanges: [],
    }),
    (error) => error?.code === "agent_command_explicit_approval_required",
  );
});

test("an auto scope cannot issue a cancellation authority unless the pending Run is its own Automation occurrence", async () => {
  const store = {
    bindAdapter(factory) {
      return factory({
        async execute(_uow, { text }) {
          if (/FROM public\.product_scopes scope/.test(text)) {
            return { rows: [{
              scope_id: "scope-alice", current_policy_revision_id: "policy-auto",
              permission_mode: "auto", auto_approved_effect_classes: ["execute"],
              auto_approved_action_ids: [], grant_id: "grant-alice",
            }] };
          }
          if (/FROM public\.workflow_runs run/.test(text)) return { rows: [] };
          return { rows: [] };
        },
      });
    },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
  };
  const authorizer = new PostgresAgentCommandAuthorizer({ store });

  await assert.rejects(
    authorizer.authorizeWorkflowRunCancellation({
      workspaceId: "workspace-alpha",
      userId: "alice",
      runId: "ordinary-run-alpha",
      nodeId: "review-alpha",
      decision: "reject",
      requestedChanges: [],
    }),
    (error) => error?.code === "agent_command_explicit_approval_required",
  );
});

test("an auto scope can record an explicit Device registration without becoming unattended Device authority", async () => {
  const queries = [];
  const store = {
    bindAdapter(factory) {
      return factory({
        async execute(_uow, { text, values }) {
          queries.push({ text, values });
          if (/FROM public\.product_scopes scope/.test(text)) {
            return { rows: [{
              scope_id: "scope-alice", current_policy_revision_id: "policy-auto",
              permission_mode: "auto", auto_approved_effect_classes: ["execute"],
              auto_approved_action_ids: [], grant_id: "grant-alice",
            }] };
          }
          if (/SELECT clock_timestamp\(\) AS now/.test(text)) {
            return { rows: [{ now: "2026-08-13T00:00:00.000Z" }] };
          }
          return { rows: [] };
        },
      });
    },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
  };
  const authorizer = new PostgresAgentCommandAuthorizer({ store });
  const authority = await authorizer.authorizeDeviceRegistration({
    workspaceId: "workspace-alpha",
    userId: "alice",
    deviceId: "device-alice",
    clientSessionId: "native-session-alice",
    publicIdentity: `sha256:${"a".repeat(64)}`,
    displayName: "Alice Mac",
    platform: "macos",
    architecture: "arm64",
    appVersion: "0.3.0",
    workerProtocolVersion: "workbench-device-worker-v1",
    capabilityInventory: ["file_read"],
  });

  assert.equal(authority.scopeId, "scope-alice");
  const inserted = queries.filter(({ text }) => /INSERT INTO public\.authorization_decisions/.test(text));
  assert.equal(inserted.length, 2);
  assert.ok(inserted.every(({ values }) => values.includes("device_register")));
  assert.ok(inserted.every(({ values }) => values.includes("administrative")));
});
