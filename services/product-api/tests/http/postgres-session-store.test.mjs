import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDefaultAuthPersistence,
  createDefaultWorkbenchSessionStore,
  createWorkbenchComposition,
} from "../../src/server.mjs";
import { PostgresAuthPersistence } from "../../src/auth/index.mjs";
import {
  PostgresAgentCommandAuthorizer,
  PostgresAgentTurnCommandIntake,
  createPostgresIdempotentMutationPort,
  createPostgresProductCommandResolver,
} from "../../src/coordination/index.mjs";
import { canonicalRequestHash } from "../../src/store/serialization.mjs";
import { PostgresWorkbenchSessionStore } from "../../src/security/postgres-workbench-session-store.mjs";
import { PostgresModelCatalog } from "../../src/models/index.mjs";
import { createWorkflowRunner } from "../../src/runner/index.mjs";
import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

class ScriptedClient {
  constructor(steps) {
    this.steps = [...steps];
  }

  async query(queryConfig) {
    const step = this.steps.shift();
    assert.ok(step, `unexpected query: ${typeof queryConfig === "string" ? queryConfig : queryConfig.text}`);
    const text = typeof queryConfig === "string" ? queryConfig : queryConfig.text;
    const values = typeof queryConfig === "string" ? undefined : queryConfig.values;
    assert.match(text, step.match);
    if (step.assertValues) step.assertValues(values);
    if (typeof step.values === "function") step.values(values);
    else if (step.values) assert.deepEqual(values, step.values);
    return step.result ?? { rows: [], rowCount: 0 };
  }

  release() {}

  assertDrained() {
    assert.equal(this.steps.length, 0, "all PostgreSQL calls must be accounted for");
  }
}

class ScriptedPool {
  constructor(clients) { this.clients = [...clients]; }
  async connect() {
    const client = this.clients.shift();
    assert.ok(client, "unexpected pool connection");
    return client;
  }
  async end() {}
}

const health = () => ({ match: /^SELECT 1 AS ok$/, result: { rows: [{ ok: 1 }], rowCount: 1 } });
const begin = () => ({ match: /^BEGIN ISOLATION LEVEL SERIALIZABLE$/ });
const commit = () => ({ match: /^COMMIT$/ });
const assertValues = (assertion) => assertion;

test("server composition selects the PostgreSQL session authority when ProductPostgresStore is selected", async () => {
  const store = new ProductPostgresStore({ pool: new ScriptedPool([]) });
  const sessions = createDefaultWorkbenchSessionStore({ store, clock: () => new Date() });
  const auth = createDefaultAuthPersistence({
    store,
    clock: () => new Date(),
    idFactory: (kind) => `${kind}-test`,
  });
  assert.ok(sessions instanceof PostgresWorkbenchSessionStore);
  assert.ok(auth instanceof PostgresAuthPersistence);
  await store.close();
});

test("PostgreSQL composition consumes explicit Run control and persistence instead of constructing Mongo fallbacks", async () => {
  const store = new ProductPostgresStore({ pool: new ScriptedPool([]) });
  const composition = createWorkbenchComposition({ store });
  assert.equal(composition.runner?.constructor?.name, "WorkflowRunner");
  await store.close();
});

test("PostgreSQL composition consumes the PG model, memory, and Artifact owners when the Runner is supplied", async () => {
  const store = new ProductPostgresStore({ pool: new ScriptedPool([]) });
  const composition = createWorkbenchComposition({
    store,
    runner: Object.freeze({ kind: "injected-postgres-runner" }),
    automationScheduler: Object.freeze({ async pollDue() { return { inspected: 0 }; } }),
    objectStoreRoot: join(tmpdir(), "looloomi-postgres-artifact-composition-test"),
  });
  assert.ok(composition.modelCatalog instanceof PostgresModelCatalog);
  assert.equal(composition.memoryService?.persistence?.constructor?.name, "PostgresMemoryPersistence");
  assert.equal(composition.memoryService?.canonicalResolver?.constructor?.name, "PostgresCanonicalMemoryResolver");
  assert.equal(composition.artifactService?.constructor?.name, "ArtifactService");
  await store.close();
});

test("WorkflowRunner rejects any store without an explicitly composed Run persistence", async () => {
  const store = new ProductPostgresStore({ pool: new ScriptedPool([]) });
  assert.throws(() => createWorkflowRunner({
    store,
    commandIntake: {
      accept: async () => {}, start: async () => {}, requestCancellation: async () => {},
      settle: async () => {}, recover: async () => {},
    },
    runControl: {
      claimRunJob: async () => null, acquireLease: async () => null,
      releaseLease: async () => null, abandonRunJob: async () => null,
      assertActiveFence: async () => null,
    },
    resolveExecution: async () => null,
    agentRuntime: { buildAuthoritativeFinal: async () => ({}) },
    idFactory: (kind) => `${kind}-test`,
  }), (error) => error?.message === "workflow_run_persistence_required");
  await store.close();
});

test("PostgresAuthPersistence reads the canonical account record through ProductPostgresStore", async () => {
  const healthClient = new ScriptedClient([health()]);
  const transactionClient = new ScriptedClient([
    begin(),
    {
      match: /FROM public\.product_users[\s\S]*WHERE user_id = \$1/,
      values: ["user-alpha"],
      result: {
        rows: [{
          user_id: "user-alpha",
          display_name: "Alpha",
          username: "alpha",
          username_normalized: "alpha",
          password_hash: "bcrypt-hash",
          account_role: "admin",
          disabled: false,
          bootstrap_admin_claim: true,
          created_at: "2026-08-10T00:00:00.000Z",
          updated_at: "2026-08-10T00:00:00.000Z",
        }],
        rowCount: 1,
      },
    },
    commit(),
  ]);
  const store = new ProductPostgresStore({ pool: new ScriptedPool([healthClient, transactionClient]) });
  const auth = createDefaultAuthPersistence({ store, clock: () => new Date() });

  assert.deepEqual(await auth.getAuthAccount("user-alpha"), {
    userId: "user-alpha",
    displayName: "Alpha",
    username: "alpha",
    usernameNormalized: "alpha",
    passwordHash: "bcrypt-hash",
    role: "admin",
    disabled: false,
    bootstrapAdminClaim: true,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  });
  healthClient.assertDrained();
  transactionClient.assertDrained();
  await store.close();
});

test("PostgresAuthPersistence establishes only the workspace container before any user principal exists", async () => {
  const healthClient = new ScriptedClient([health()]);
  const transactionClient = new ScriptedClient([
    begin(),
    { match: /INSERT INTO public\.product_workspaces/, values: ["workspace-alpha", "Alpha workspace", "2026-08-10T00:00:00.000Z"] },
    { match: /FROM public\.product_workspaces WHERE workspace_id = \$1/, values: ["workspace-alpha"], result: { rows: [{ workspace_id: "workspace-alpha", schema_version: "workbench-v1", name: "Alpha workspace", created_by: "system-bootstrap", created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z" }] } },
    commit(),
  ]);
  const store = new ProductPostgresStore({ pool: new ScriptedPool([healthClient, transactionClient]) });
  const persistence = new PostgresAuthPersistence({ store, clock: () => "2026-08-10T00:00:00.000Z" });
  assert.deepEqual(await persistence.ensureWorkspace({ workspaceId: "workspace-alpha", workspaceName: "Alpha workspace" }), {
    schemaVersion: "workbench-v1", workspaceId: "workspace-alpha", name: "Alpha workspace",
    createdBy: "system-bootstrap", createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
  });
  healthClient.assertDrained();
  transactionClient.assertDrained();
  await store.close();
});

test("PostgreSQL registration creates the initial workspace personal authority scope", async () => {
  const healthClient = new ScriptedClient([health()]);
  const transactionClient = new ScriptedClient([
    begin(),
    { match: /INSERT INTO public\.auth_idempotency_receipts/, result: { rows: [{ request_hash: canonicalRequestHash({ username: "alpha" }), response: null }] } },
    { match: /SELECT user_id FROM public\.product_users WHERE username_normalized/, values: ["alpha"], result: { rows: [] } },
    { match: /INSERT INTO public\.product_users/, values: assertValues((values) => assert.equal(values[0], "user-test")) },
    { match: /INSERT INTO public\.product_workspaces/, values: assertValues((values) => assert.equal(values[0], "workspace-alpha")) },
    { match: /UPDATE public\.product_workspaces[\s\S]*created_by IN/, values: ["workspace-alpha", "Alpha workspace", "user-test", "2026-08-10T00:00:00.000Z"], result: { rows: [{ workspace_id: "workspace-alpha" }] } },
    { match: /INSERT INTO public\.workspace_memberships/, values: assertValues((values) => assert.equal(values[2], "user-test")) },
    { match: /INSERT INTO public\.workspace_principals/, values: assertValues((values) => assert.equal(values[1], "user-test")) },
    { match: /SELECT workspace_id FROM public\.product_workspaces WHERE workspace_id = \$1 FOR UPDATE/, values: ["workspace-alpha"] },
    { match: /scope_kind = 'personal'[\s\S]*owner_user_id = \$2/, values: ["workspace-alpha", "user-test"], result: { rows: [] } },
    { match: /creation_mode = 'workspace_initial_seed'/, values: ["workspace-alpha"], result: { rows: [] } },
    { match: /^SELECT clock_timestamp\(\) AS now$/, result: { rows: [{ now: "2026-08-10T00:00:00.000Z" }] } },
    { match: /^SET CONSTRAINTS ALL DEFERRED$/ },
    { match: /INSERT INTO public\.product_scopes/, values: assertValues((values) => {
      assert.equal(values[0], "workspace-alpha"); assert.equal(values[1], "scope-personal-test");
      assert.equal(values[2], "user-test"); assert.equal(values[4], "workspace_initial_seed");
    }) },
    { match: /INSERT INTO public\.scope_policy_revisions/, values: assertValues((values) => {
      assert.equal(values[2], "scope-policy-test"); assert.match(values[3], /^sha256:[a-f0-9]{64}$/);
      assert.deepEqual(JSON.parse(values[6]), { bootstrap: "workspace_initial_seed" });
    }) },
    { match: /INSERT INTO public\.scope_principal_grants/, values: assertValues((values) => {
      assert.equal(values[2], "scope-grant-test");
      assert.deepEqual(JSON.parse(values[5]), { bootstrap: "workspace_initial_seed" });
    }) },
    { match: /UPDATE public\.auth_idempotency_receipts/ },
    commit(),
  ]);
  const store = new ProductPostgresStore({ pool: new ScriptedPool([healthClient, transactionClient]) });
  const persistence = new PostgresAuthPersistence({
    store,
    clock: () => "2026-08-10T00:00:00.000Z",
    idFactory: (kind) => `${kind}-test`,
  });
  const result = await persistence.registerAuthAccount({
    username: "alpha", usernameNormalized: "alpha", passwordHash: "bcrypt-hash", role: "member",
    workspaceId: "workspace-alpha", workspaceName: "Alpha workspace", idempotencyKey: "register-alpha",
    requestFingerprint: { username: "alpha" },
  });
  assert.equal(result.user.userId, "user-test");
  healthClient.assertDrained();
  transactionClient.assertDrained();
  await store.close();
});

test("PostgreSQL password registration cannot mint a later member scope without invitation lineage", async () => {
  const healthClient = new ScriptedClient([health()]);
  const transactionClient = new ScriptedClient([
    begin(),
    { match: /INSERT INTO public\.auth_idempotency_receipts/, result: { rows: [{ request_hash: canonicalRequestHash({ username: "bravo" }), response: null }] } },
    { match: /SELECT user_id FROM public\.product_users WHERE username_normalized/, values: ["bravo"], result: { rows: [] } },
    { match: /INSERT INTO public\.product_users/, values: assertValues((values) => assert.equal(values[0], "user-test")) },
    { match: /INSERT INTO public\.product_workspaces/, values: assertValues((values) => assert.equal(values[0], "workspace-alpha")) },
    { match: /UPDATE public\.product_workspaces[\s\S]*created_by IN/, values: ["workspace-alpha", "Alpha workspace", "user-test", "2026-08-10T00:00:00.000Z"], result: { rows: [{ workspace_id: "workspace-alpha" }] } },
    { match: /INSERT INTO public\.workspace_memberships/, values: assertValues((values) => assert.equal(values[2], "user-test")) },
    { match: /INSERT INTO public\.workspace_principals/, values: assertValues((values) => assert.equal(values[1], "user-test")) },
    { match: /SELECT workspace_id FROM public\.product_workspaces WHERE workspace_id = \$1 FOR UPDATE/, values: ["workspace-alpha"] },
    { match: /scope_kind = 'personal'[\s\S]*owner_user_id = \$2/, values: ["workspace-alpha", "user-test"], result: { rows: [] } },
    { match: /creation_mode = 'workspace_initial_seed'/, values: ["workspace-alpha"], result: { rows: [{ scope_id: "scope-owner" }] } },
    { match: /^ROLLBACK$/ },
  ]);
  const store = new ProductPostgresStore({ pool: new ScriptedPool([healthClient, transactionClient]) });
  const persistence = new PostgresAuthPersistence({
    store,
    clock: () => "2026-08-10T00:00:00.000Z",
    idFactory: (kind) => `${kind}-test`,
  });
  await assert.rejects(
    persistence.registerAuthAccount({
      username: "bravo", usernameNormalized: "bravo", passwordHash: "bcrypt-hash", role: "member",
      workspaceId: "workspace-alpha", workspaceName: "Alpha workspace", idempotencyKey: "register-bravo",
      requestFingerprint: { username: "bravo" },
    }),
    { code: "membership_activation_lineage_required" },
  );
  healthClient.assertDrained();
  transactionClient.assertDrained();
  await store.close();
});

test("PostgreSQL command resolver returns only the admission-safe command projection", async () => {
  const transactionClient = new ScriptedClient([
    begin(),
    {
      match: /FROM public\.product_commands/,
      values: ["command-alpha", "workspace-alpha", "user-alpha"],
      result: { rows: [{
        command_id: "command-alpha", workspace_id: "workspace-alpha", quota_user_id: "user-alpha",
        kind: "agent_turn", session_id: "session-alpha", turn_id: "turn-alpha",
        target_kind: null, target_id: null, target_revision: null, status: "running",
        created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:01.000Z", finished_at: null,
      }], rowCount: 1 },
    },
    commit(),
  ]);
  const store = new ProductPostgresStore({ pool: new ScriptedPool([transactionClient]) });
  const resolve = createPostgresProductCommandResolver({ store });
  assert.deepEqual(await resolve({ commandId: "command-alpha", workspaceId: "workspace-alpha", userId: "user-alpha" }), {
    schemaVersion: "workbench-v1", commandId: "command-alpha", workspaceId: "workspace-alpha",
    userId: "user-alpha", kind: "agent_turn", sessionId: "session-alpha", turnId: "turn-alpha",
    targetKind: null, targetId: null, targetRevision: null,
    status: "running", createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:01.000Z", finishedAt: null,
  });
  transactionClient.assertDrained();
  await store.close();
});

test("PostgreSQL idempotent mutation binds a response to the authenticated workspace principal", async () => {
  const request = { title: "new task" };
  const transactionClient = new ScriptedClient([
    begin(),
    {
      match: /INSERT INTO public\.product_idempotency_receipts/,
      values: ["workspace-alpha", "user-alpha", "create-agent-session:user-alpha", "idem-alpha", canonicalRequestHash(request), "2026-08-10T00:00:00.000Z"],
      result: { rows: [{ request_hash: canonicalRequestHash(request), response: null }], rowCount: 1 },
    },
    {
      match: /UPDATE public\.product_idempotency_receipts/,
      values: ["workspace-alpha", "user-alpha", "create-agent-session:user-alpha", "idem-alpha", JSON.stringify({ sessionId: "session-alpha" }), "2026-08-10T00:00:00.000Z"],
    },
    commit(),
  ]);
  const store = new ProductPostgresStore({ pool: new ScriptedPool([transactionClient]) });
  const port = createPostgresIdempotentMutationPort({
    store,
    clock: () => "2026-08-10T00:00:00.000Z",
  });
  let unitOfWork;
  assert.deepEqual(await port.run({
    scope: "create-agent-session:user-alpha",
    key: "idem-alpha",
    request,
    workspaceId: "workspace-alpha",
    effectivePrincipalId: "user-alpha",
  }, async (uow) => {
    unitOfWork = uow;
    return { sessionId: "session-alpha" };
  }), { sessionId: "session-alpha" });
  assert.equal(unitOfWork.kind, "postgres_unit_of_work");
  transactionClient.assertDrained();
  await store.close();
});

test("PostgreSQL Agent authority is minted by the product and consumed by Agent Command Intake", async () => {
  const authorityClient = new ScriptedClient([
    begin(),
    {
      match: /FROM public\.product_scopes scope[\s\S]*scope\.scope_kind = 'personal'/,
      values: ["workspace-alpha", "user-alpha"],
      result: { rows: [{
        scope_id: "scope-personal-alpha", current_policy_revision_id: "policy-alpha",
        permission_mode: "interactive", auto_approved_effect_classes: [], auto_approved_action_ids: [], grant_id: "grant-alpha",
      }] },
    },
    { match: /^SELECT clock_timestamp\(\) AS now$/, result: { rows: [{ now: "2026-08-10T00:00:00.000Z" }] } },
    {
      match: /INSERT INTO public\.authorization_decisions[\s\S]*'approval_required'/,
      assertValues: (values) => {
        assert.equal(values[0], "workspace-alpha");
        assert.equal(values[1], "authorization-approval-test");
        assert.equal(values[6], "agent_turn");
        assert.match(values[8], /^sha256:[a-f0-9]{64}$/);
      },
    },
    {
      match: /INSERT INTO public\.authorization_decisions[\s\S]*'authorized'/,
      assertValues: (values) => {
        assert.equal(values[1], "authorization-decision-test");
        assert.equal(values[12], "authorization-approval-test");
      },
    },
    commit(),
  ]);
  const commandClient = new ScriptedClient([
    begin(),
    { match: /FROM public\.product_commands[\s\S]*FOR UPDATE/, values: ["workspace-alpha", "command-alpha", "user-alpha"], result: { rows: [] } },
    {
      match: /FROM public\.authorization_decisions[\s\S]*action_id = \$5/,
      assertValues: (values) => {
        assert.equal(values[1], "authorization-decision-test");
        assert.equal(values[4], "agent_turn");
      },
      result: { rows: [{ authorization_decision_id: "authorization-decision-test", policy_revision_id: "policy-alpha" }] },
    },
    {
      match: /INSERT INTO public\.product_commands[\s\S]*'agent_turn'/,
      assertValues: (values) => {
        assert.equal(values[0], "command-alpha");
        assert.equal(values[2], "scope-personal-alpha");
        assert.equal(values[4], "authorization-decision-test");
      },
      result: { rows: [{
        command_id: "command-alpha", workspace_id: "workspace-alpha", scope_id: "scope-personal-alpha",
        quota_user_id: "user-alpha", kind: "agent_turn", session_id: "session-alpha", turn_id: "turn-alpha",
        status: "accepted", created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z", finished_at: null,
      }] },
    },
    commit(),
  ]);
  const store = new ProductPostgresStore({ pool: new ScriptedPool([authorityClient, commandClient]) });
  let sequence = 0;
  const authorizer = new PostgresAgentCommandAuthorizer({
    store,
    idFactory: (kind) => `${kind}-test`,
  });
  const authority = await authorizer.authorizeAgentTurn({
    workspaceId: "workspace-alpha", userId: "user-alpha", sessionId: "session-alpha", turnId: "turn-alpha",
    input: { message: "do not persist raw input in the decision" },
  });
  assert.deepEqual(authority.scopeId, "scope-personal-alpha");
  const intake = new PostgresAgentTurnCommandIntake({ store });
  const accepted = await intake.accept({
    principal: { workspaceId: "workspace-alpha", userId: "user-alpha" },
    command: {
      commandId: "command-alpha", kind: "agent_turn", sessionId: "session-alpha", turnId: "turn-alpha",
      ...authority,
    },
    at: authority.authorizedAt,
    persistTarget: async () => ({ turnId: "turn-alpha", status: "queued", sequence: ++sequence }),
  });
  assert.equal(accepted.command.commandId, "command-alpha");
  assert.equal(accepted.target.status, "queued");
  authorityClient.assertDrained();
  commandClient.assertDrained();
  await store.close();
});

test("PostgreSQL Model Catalog resolves a governed revision without a Mongo repository", async () => {
  const client = new ScriptedClient([
    begin(),
    {
      match: /FROM public\.model_profile_revisions revision[\s\S]*profile\.workspace_id = \$2/,
      values: ["revision-alpha", "workspace-alpha", null, null],
      result: { rows: [{
        profile_id: "profile-alpha", workspace_id: "workspace-alpha", scope_id: "scope-personal-alpha",
        schema_version: "workbench-model-catalog-v1", profile_scope: "workspace", display_name: "GPT Alpha",
        enabled: true, current_revision_id: "revision-alpha", current_revision_number: 1,
        revision_id: "revision-alpha", revision_number: 1, provider: "openai", protocol: "openai_compatible_chat",
        provider_model_ref: "gpt-alpha", capabilities: ["chat", "tool_calling"], parameter_support: {}, limits: {},
        data_policy: {}, cost_policy: {}, parameter_schema_version: "v1", policy_version: "1",
        config_hash: `sha256:${"a".repeat(64)}`, deployment_key: "deployment-alpha", secret_binding_id: "secret-binding-alpha",
        created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z", payload: {},
      }] },
    },
    commit(),
  ]);
  const store = new ProductPostgresStore({ pool: new ScriptedPool([client]) });
  const catalog = new PostgresModelCatalog({ store, readinessResolver: async () => ({ state: "ready" }) });
  const resolved = await catalog.resolveRevision({
    revisionId: "revision-alpha", workspaceId: "workspace-alpha", capabilities: ["chat"], requireReady: true,
  });
  assert.equal(resolved.profile.profileId, "profile-alpha");
  assert.equal(resolved.revision.secretBindingId, "secret-binding-alpha");
  assert.equal(resolved.revision.credentialRef, undefined);
  client.assertDrained();
  await store.close();
});


test("PostgresWorkbenchSessionStore persists only a token hash after verifying active membership", async () => {
  const healthClient = new ScriptedClient([health()]);
  const transactionClient = new ScriptedClient([
    begin(),
    {
      match: /FROM public\.workspace_memberships membership/,
      values: ["workspace-alpha", "user-alpha"],
      result: { rows: [{ exists: 1 }], rowCount: 1 },
    },
    {
      match: /INSERT INTO public\.workbench_browser_sessions/,
      values: [
        "session-alpha", "user-alpha", "workspace-alpha",
        "sha256:012632faba814fab31a2b8c82150024265be09ce4818297ac80be408025b184c",
        "c".repeat(32), "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:01.000Z",
      ],
    },
    commit(),
  ]);
  const pool = new ScriptedPool([healthClient, transactionClient]);
  const store = new ProductPostgresStore({ pool });
  const sessions = new PostgresWorkbenchSessionStore({
    store,
    clock: () => "2026-08-10T00:00:00.000Z",
    ttlMilliseconds: 1_000,
    tokenFactory: () => "browser-token",
    csrfTokenFactory: () => "c".repeat(32),
    idFactory: () => "session-alpha",
  });

  const issued = await sessions.issue({ userId: "user-alpha", activeWorkspaceId: "workspace-alpha" });

  assert.equal(issued.token, "browser-token");
  assert.equal(issued.expiresAt, "2026-08-10T00:00:01.000Z");
  healthClient.assertDrained();
  transactionClient.assertDrained();
  await store.close();
});

test("PostgresWorkbenchSessionStore revokes an expired or de-authorized durable session", async () => {
  const healthClient = new ScriptedClient([health()]);
  const transactionClient = new ScriptedClient([
    begin(),
    {
      match: /FROM public\.workbench_browser_sessions session/,
      values: ["sha256:012632faba814fab31a2b8c82150024265be09ce4818297ac80be408025b184c"],
      result: {
        rows: [{
          session_id: "session-alpha",
          user_id: "user-alpha",
          active_workspace_id: "workspace-alpha",
          csrf_token: "c".repeat(32),
          expires_at: "2026-08-10T00:00:01.000Z",
          user_disabled: false,
          membership_status: "active",
        }],
        rowCount: 1,
      },
    },
    {
      match: /UPDATE public\.workbench_browser_sessions/,
      values: ["session-alpha", "2026-08-10T00:00:01.000Z"],
    },
    commit(),
  ]);
  const pool = new ScriptedPool([healthClient, transactionClient]);
  const store = new ProductPostgresStore({ pool });
  const sessions = new PostgresWorkbenchSessionStore({
    store,
    clock: () => "2026-08-10T00:00:01.000Z",
    tokenFactory: () => "browser-token",
  });

  assert.equal(await sessions.get("browser-token"), null);
  healthClient.assertDrained();
  transactionClient.assertDrained();
  await store.close();
});
