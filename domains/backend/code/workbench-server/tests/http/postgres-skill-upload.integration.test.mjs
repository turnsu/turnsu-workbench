import { verifyMemberAgentRequests } from "./verify-member-agent-requests.mjs";
import { PostgresMemberAgentService } from "../../src/member-agents/postgres-member-agent-service.mjs";
import { PostgresDeviceLifecycle } from "../../src/devices/postgres-device-lifecycle.mjs";
import { ExecutionBroker } from "../../src/execution/execution-broker.mjs";
import { AdmissionController, AdmittedExecutionDispatcher } from "../../src/execution/admission-controller.mjs";
import { PostgresExecutionPersistence } from "../../src/execution/postgres-execution-persistence.mjs";
import { PostgresCapacityPersistence } from "../../src/execution/capacity-persistence.mjs";
import { createPostgresProductCommandResolver } from "../../src/coordination/postgres-product-command-resolver.mjs";
import { verifyCaptureUpload, verifyCaptureRelease } from "../../../../../agent/code/local-agent-host/test/verify-capture-upload.mjs";
import { verifyLoopCapture } from "../../../../../agent/code/local-agent-host/test/verify-loop-capture.mjs";
import { verifyLocalLoopTrial } from "../../../../../agent/code/local-agent-host/test/verify-local-loop-trial.mjs";
import { verifyTeamSkill } from "../../../../../agent/code/local-agent-host/test/verify-team-skill.mjs";
import { verifyLocalLoopTrials } from "./verify-local-loop-trials.mjs";
import { verifyNativeLoopReleases } from "./verify-native-loop-releases.mjs";
import { PostgresTeamWorkLifecycle } from "../../src/work-items/postgres-team-work-lifecycle.mjs";
import { PostgresWorkItemPromotionLifecycle } from "../../src/work-items/postgres-work-item-promotion-lifecycle.mjs";
import { LocalAgentHost } from "../../../../../agent/code/local-agent-host/host.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Pool } from "pg";
import { AuthService } from "../../src/auth/auth-service.mjs";
import { HmacIdentityTokenSigner } from "../../src/auth/hmac-identity-token-signer.mjs";
import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";
import { PostgresWorkbenchSessionStore } from "../../src/security/postgres-workbench-session-store.mjs";
import { FilesystemObjectStore } from "../../src/storage/index.mjs";
import { PostgresSkillUploadService } from "../../src/skills/postgres-skill-upload-service.mjs";
import { PostgresSkillValidationPersistence } from "../../src/skills/postgres-skill-validation-persistence.mjs";
import { PostgresSkillValidationPort } from "../../src/skills/postgres-skill-validation-port.mjs";
import { createSkillValidationCoordinator } from "../../src/skills/skill-validation-composition.mjs";
import { PostgresSkillCommandIntake } from "../../src/skills/postgres-skill-command-intake.mjs";
import { createSkillTestRunner } from "../../src/skills/skill-test-runner.mjs";
import { PostgresAgentCommandAuthorizer } from "../../src/coordination/postgres-agent-command-authorizer.mjs";
import { createPostgresIdempotentMutationPort } from "../../src/coordination/index.mjs";
import { formatSkillPackage, SKILL_PACKAGE_MEDIA_TYPE } from "../../src/skills/skill-package-format.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";
import { PostgresModelConfiguration } from "../../src/models/postgres-model-configuration.mjs";
import { PostgresModelCatalog } from "../../src/models/postgres-model-catalog.mjs";
import { MountedCloudSecretStore } from "../../src/security/mounted-cloud-secret-store.mjs";
import { createPostgresWorkflowExecutionResolver } from "../../src/runner/postgres-workflow-execution-resolver.mjs";
import { Check, SkillVersionSchema, WorkspaceAssetReleaseSchema } from "@looloomi/workbench-contracts";
import { PostgresNativeSkillPackageReader } from "../../src/skills/postgres-native-skill-package-reader.mjs";
import { runNativeInstalledSkill } from "../../../../../agent/code/agent-runtime/test/native-model-harness.mjs";
import { installNativeSkill } from "../../../../../agent/code/agent-runtime/integrations/native/install-skill.mjs";
import { loginNativeProduct } from "../../../../../agent/code/agent-runtime/integrations/native/login.mjs";
import { openNativeProductSession } from "../../../../../agent/code/agent-runtime/integrations/native/session.mjs";
import { ProductStoreError } from "../../src/store/errors.mjs";
import { POSTGRES_MIGRATIONS } from "../../src/store/postgres/migrations/index.mjs";

const ORIGIN = "https://skill-upload.example.test";
test("Product HTTP resumes a private Skill package across service restart and safely replays completion", {
  skip: process.env.WORKBENCH_POSTGRES_INTEGRATION !== "1", timeout: process.env.TURNSU_LOOP_DESKTOP_UI_STATE ? 1_250_000 : process.env.TURNSU_NATIVE_SKILL_ACCEPTANCE === "codex" ? 240_000 : 60_000,
}, async (t) => {
  const connectionString = process.env.WORKBENCH_POSTGRES_URL;
  assert.match(new URL(connectionString).pathname, /_test$/);
  const pool = new Pool({ connectionString, max: 8 });
  const store = new ProductPostgresStore({ pool });
  const root = await mkdtemp(join(tmpdir(), "turnsu-skill-upload-"));
  t.after(async () => { await store.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  // Exercise the native release migration against an existing real publication,
  // not only empty tables. No business data or historical release is replaced.
  await store.runMigrations({ migrations: POSTGRES_MIGRATIONS.filter(migration => Number(migration.version.slice(0, 3)) < 41) });
  const invitations = [];
  const authService = new AuthService({ store, persistence: store.createAuthPersistence(),
    nativeClientSessions: store.createNativeClientSessionStore(),
    bootstrapAdminToken: "upload-bootstrap", workspaceId: "upload-workspace", workspaceName: "Upload test", bcryptCost: 10,
    invitationTokenSigner: new HmacIdentityTokenSigner({ secret: "0123456789abcdef0123456789abcdef" }), invitationBaseUrl: ORIGIN,
    invitationMailer: { async sendWorkspaceInvitation(message) { invitations.push(message); return { receiptId: "test-delivery" }; } },
    oauthProviders: { google: {
      async authorizationUrl({ state }) { return `https://identity.example.test/authorize?state=${encodeURIComponent(state)}`; },
      async complete() { return { provider: "google", providerSubject: "upload-member", verifiedEmail: "member@example.test" }; },
    } },
  });
  const sessionStore = new PostgresWorkbenchSessionStore({ store });
  const secretRoot = join(root, "test-secrets");
  await mkdir(join(secretRoot, "upload-workspace"), { recursive: true, mode: 0o700 });
  await writeFile(join(secretRoot, "upload-workspace", "workflow-model.v1.secret"), "synthetic-provider-credential", { mode: 0o600 });
  const modelConfiguration = new PostgresModelConfiguration({ store,
    authorizer: new PostgresAgentCommandAuthorizer({ store }),
    secretStore: new MountedCloudSecretStore({ rootDirectory: secretRoot }),
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }] }), { status: 200 }),
  });
  const modelCatalog = new PostgresModelCatalog({ store, readinessResolver: async () => ({ state: "ready" }) });
  const idFactory = (kind) => `${kind}-${randomUUID()}`;
  let objectStore;
  let service;
  let validation;
  let persistence;
  let handler;
  let borrowing;
  const scheduled = [];
  const workflowDispatches = [];
  const restart = async () => {
    objectStore = await new FilesystemObjectStore({ rootDir: root }).initialize();
    service = new PostgresSkillUploadService({ store, objectStore, idFactory: (kind) => `${kind}-${randomUUID()}` });
    persistence = new PostgresSkillValidationPersistence({ store });
    validation = createSkillValidationCoordinator({ store, objectStore,
      ports: new PostgresSkillValidationPort({ store, objectStore, persistence }) });
    const authorizer = new PostgresAgentCommandAuthorizer({ store });
    const admission = new AdmissionController({persistence:new PostgresCapacityPersistence({store}),resolveProductCommand:createPostgresProductCommandResolver({store}),idFactory});
    const broker = new ExecutionBroker({persistence:new PostgresExecutionPersistence({store}),capacityAuthorizer:admission,idFactory});
    const dispatcher = new AdmittedExecutionDispatcher({broker,admissionController:admission});
    const packages = new PostgresNativeSkillPackageReader({store,objectStore});
    borrowing = new PostgresMemberAgentService({store,authorizer,dispatcher,readSkillPackage:args=>packages.read(args),readLoopPackage:args=>store.createLoopDraftLifecycle({idFactory}).getNativeLoopPackage({...args,readSkillPackage:input=>packages.read(input)})});
    dispatcher.registerBackend({mode:'bounded_agent',isolation:'remote',backend:borrowing.backend});
    handler = createWorkbenchHttpHandler({ application: createWorkbenchApplication({ store, skillUploadService: service,
      memberAgentService:borrowing,deviceLifecycle:new PostgresDeviceLifecycle({store,commandAuthorizer:authorizer}),
      workspaceReadModel: store.createWorkspaceReadModel(), workspaceAuthorizer: store.createAuthPersistence(),
      workItemLifecycle: new PostgresTeamWorkLifecycle({ store, objectStore, promotionLifecycle: new PostgresWorkItemPromotionLifecycle({ store,
        commandAuthorizer: new PostgresAgentCommandAuthorizer({ store }), agentTurnRunner: { createSession() { throw new Error('No built-in Agent execution in desktop acceptance'); } } }) }),
      skillDraftLifecycle: store.createSkillDraftLifecycle({ idFactory: (kind) => `${kind}-${randomUUID()}` }), skillReadModel: store.createSkillReadModel(),
      loopDraftLifecycle: store.createLoopDraftLifecycle({ idFactory }), workflowReadModel: store.createWorkflowReadModel(),
      workflowCompileLifecycle: store.createWorkflowCompileLifecycle({ idFactory, modelCatalog, probeSkill: async () => ({ ready: true }) }),
      modelConfiguration, modelCatalog,
      teamLibraryReadModel: store.createTeamLibraryReadModel(),
      teamLibraryLifecycle: store.createTeamLibraryLifecycle({ idFactory }),
      nativeSkillPackageReader: new PostgresNativeSkillPackageReader({ store, objectStore }),
      workflowCommandAuthorizer: new PostgresAgentCommandAuthorizer({ store }),
      agentTurnRunner: { async createSession() { assert.fail("unavailable runner cannot create a session"); } },
      runner: { async startRunWithCompanion(input) {
        workflowDispatches.push(input);
        throw new ProductStoreError("runner_unavailable", "Execution intentionally unavailable in this persistence test.");
      } },
      externalMutationPort: store.createExternalMutationPort(),
      idempotentMutationPort: createPostgresIdempotentMutationPort({ store }),
      skillValidationService: validation, skillValidationContextResolver: validation.resolveValidationContext.bind(validation),
      skillCommandIntake: new PostgresSkillCommandIntake({ store }), skillCommandAuthorizer: new PostgresAgentCommandAuthorizer({ store }),
      skillTestRunner: { schedule: (testRunId) => scheduled.push(testRunId) },
    }),
      authService, sessionStore, origin: ORIGIN, internalErrorReporter: (error) => t.diagnostic(JSON.stringify(error)) });
  };
  await restart();
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  authService.publicOrigin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = async (path, { method = "GET", data, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/workbench/v1${path}`, {
      method, headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...headers },
      ...(data ? { body: JSON.stringify({ schemaVersion: "workbench-api-v1", data }) } : {}),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const owner = await request("/auth/register", { method: "POST", headers: { "Idempotency-Key": "register-owner" },
    data: { username: "upload-owner", password: "Upload-Test-2026!", bootstrapToken: "upload-bootstrap" } });
  assert.equal(owner.status, 201);
  const authHeaders = async (response) => {
    const token = /^workbench_session=([^;]+)/.exec(response.headers.get("set-cookie"))[1];
    return { Cookie: `workbench_session=${token}`, "X-Workbench-CSRF": (await sessionStore.get(token)).csrfToken };
  };
  const headers = await authHeaders(owner);
  const files = [{ path: "SKILL.md", content: "---\nname: upload-feedback\ndescription: Summarize feedback with evidence.\ndisable-model-invocation: false\ninputs:\n  - name: feedback\n    type: string\n    required: true\noutputs:\n  - name: result\n    type: markdown\n---\nRead feedback and preserve its evidence. Follow references/format.md for the output format.\n" },
    { path: "references/format.md", content: "输出标题：团队反馈。每条建议必须引用原话，最后单独写出频次：未知。不要将未知信息当作事实。\n" },
    { path: "references/notes.md", content: "Synthetic feedback for upload recovery.\n".repeat(15000) }];
  const bytes = formatSkillPackage(files);
  const declaration = { filename: "feedback.skill", sizeBytes: bytes.length, mediaType: SKILL_PACKAGE_MEDIA_TYPE, ingestMethod: "resumable" };
  const create = () => request("/uploads", { method: "POST", headers: { ...headers, "Idempotency-Key": "create-feedback" }, data: declaration });
  const created = await create();
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual((await create()).body.data, created.body.data);
  const uploadId = created.body.data.uploadId;
  const path = `/uploads/${uploadId}`;
  const size = created.body.data.transfer.chunkSizeBytes;
  assert.equal(size, 512 * 1024);
  assert.equal(created.body.data.transfer.totalChunks, 2);
  const chunk = (index, value = bytes.subarray(index * size, (index + 1) * size), key = `chunk-${index}`) => request(`${path}/chunks/${index}`, {
    method: "PUT", headers: { ...headers, "Idempotency-Key": key }, data: { contentBase64: value.toString("base64") },
  });
  const complete = () => request(`${path}/complete`, { method: "POST", headers: { ...headers, "Idempotency-Key": "complete-feedback" }, data: {} });
  assert.equal((await complete()).status, 409, "incomplete uploads cannot become packages");
  const first = await chunk(0);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.data.transfer.receivedChunks, [0]);
  await restart();
  const restored = await request(path, { headers });
  assert.deepEqual(restored.body.data.transfer, first.body.data.transfer);
  assert.deepEqual((await chunk(0)).body.data, first.body.data);
  const changed = Buffer.from(bytes.subarray(0, size)); changed[0] ^= 1;
  assert.equal((await chunk(0, changed)).status, 409, "receipt binds exact bytes, not just length");
  assert.equal((await chunk(0, changed, "different-bytes")).status, 409, "an index is immutable across receipt keys");
  const concurrent = await Promise.all([chunk(1), chunk(1)]);
  for (const result of concurrent) assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(concurrent[0].body.data.transfer.complete, true);
  const inspected = await complete();
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  assert.equal(inspected.body.data.state, "ready_draft");
  assert.deepEqual(inspected.body.data.transfer.receivedChunks, [0, 1]);
  await restart();
  assert.deepEqual((await complete()).body.data, inspected.body.data, "completion retries survive cleaned staging bytes");
  const createSkillData = { name: "试用反馈整理", description: "保留反馈依据", category: "data", uploadId };
  const createSkill = () => request("/skills", { method: "POST", headers: { ...headers, "Idempotency-Key": "create-feedback-skill" }, data: createSkillData });
  assert.equal((await createSkill()).status, 409, "unpromoted uploads cannot be bound to a draft");
  const promoted = await request(`${path}/promote`, { method: "POST", headers: { ...headers, "Idempotency-Key": "promote-feedback" }, data: {} });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  const row = (await pool.query("SELECT * FROM upload_sessions WHERE upload_id = $1", [uploadId])).rows[0];
  assert.equal(row.state, "promoted");
  assert.equal((await objectStore.read({ workspaceId: row.workspace_id, objectId: row.object_id })).bytes.equals(bytes), true);
  const skill = await createSkill();
  assert.equal(skill.status, 201, JSON.stringify(skill.body));
  assert.equal(skill.body.data.skill.visibility, "private");
  assert.equal(skill.body.data.skill.lifecycle, "draft");
  assert.equal(skill.body.data.draft.name, createSkillData.name);
  assert.equal(skill.body.data.draft.inputSchema.properties.feedback.type, "string");
  assert.deepEqual(skill.body.data.draft.inputSchema.required, ["feedback"]);
  assert.equal(skill.body.data.draft.outputSchema.properties.result.type, "string");
  assert.equal(skill.body.data.draft.executionRef, undefined);
  assert.deepEqual((await createSkill()).body.data, skill.body.data);
  const skillId = skill.body.data.skill.skillId;
  const draftPath = `/skills/${skillId}/drafts/${skill.body.data.draft.skillDraftId}`;
  const draft = (await pool.query("SELECT * FROM skill_drafts WHERE skill_id = $1", [skillId])).rows[0];
  const snapshot = (await pool.query("SELECT * FROM skill_draft_revision_snapshots WHERE skill_id = $1", [skillId])).rows[0];
  assert.equal(draft.package_object_id, row.object_id);
  assert.equal(draft.package_object_hash, row.object_content_hash);
  assert.equal(draft.package_hash, row.package_hash);
  assert.equal(snapshot.content_hash, draft.content_hash);
  assert.equal(snapshot.package_object_id, draft.package_object_id);
  await restart();
  const reopened = await request(draftPath, { headers });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.data.name, createSkillData.name);
  const renamed = await request(draftPath, { method: "PATCH", headers: { ...headers, "Idempotency-Key": "rename-feedback", "If-Match": reopened.headers.get("etag") },
    data: { name: "试用反馈整理（已核对）" } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const renamedSnapshot = (await pool.query("SELECT * FROM skill_draft_revision_snapshots WHERE skill_id = $1 AND draft_revision = 2", [skillId])).rows[0];
  assert.equal(renamedSnapshot.package_object_id, row.object_id, "renaming must preserve the exact executable package in the revision snapshot");
  assert.equal(renamedSnapshot.package_hash, row.package_hash);
  // Real authority, command and target share one transaction. Scheduling is
  // captured here; actual model execution is covered by the live UI check.
  const queued = await request(`${draftPath}/tests`, { method: "POST", headers: { ...headers, "Idempotency-Key": "test-feedback", "If-Match": renamed.headers.get("etag") },
    data: { testCase: { name: "Feedback sample", purpose: "Preserve input evidence", input: { feedback: "Synthetic feedback" }, timeoutSeconds: 30 } } });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal(queued.body.data.status, "queued");
  assert.deepEqual(scheduled, [queued.body.data.testRunId]);
  const command = (await pool.query("SELECT command.*, run.status AS test_status FROM product_commands command JOIN skill_test_runs run ON run.product_command_id = command.command_id WHERE command.command_id = $1", [queued.body.data.testRunId])).rows[0];
  assert.equal(command.status, "accepted");
  assert.equal(command.test_status, "queued");
  assert.equal(command.session_id, draft.skill_draft_id);
  assert.equal(command.turn_id, queued.body.data.testRunId);
  const runner = createSkillTestRunner({ store, skillTestPersistence: persistence,
    resolveSkillValidationContext: validation.resolveValidationContext.bind(validation),
    commandIntake: new PostgresSkillCommandIntake({ store }), skillValidationService: validation,
    materialResolver: async () => { const error = new Error("controlled_material_failure"); error.code = "skill_material_unavailable"; throw error; },
    executionDispatcher: { async execute() { assert.fail("unavailable material must prevent execution"); }, async cancel() {}, async getInvocation() { return null; } },
  });
  t.after(() => runner.stop());
  await runner.schedule(queued.body.data.testRunId, { workspaceId: row.workspace_id });
  const handled = await persistence.getTestRun({ workspaceId: row.workspace_id, testRunId: queued.body.data.testRunId });
  assert.equal(handled.record.status, "blocked", JSON.stringify(handled.record));
  assert.equal(handled.record.diagnostics[0].code, "skill_material_unavailable");
  assert.equal((await pool.query("SELECT status FROM product_commands WHERE command_id = $1", [queued.body.data.testRunId])).rows[0].status, "blocked");
  // Provider output is controlled here to test the real persistence/HTTP
  // publication chain independently of provider availability.
  const passedTarget = await request(`${draftPath}/tests`, { method: "POST", headers: { ...headers, "Idempotency-Key": "test-feedback-passed", "If-Match": renamed.headers.get("etag") },
    data: { testCase: { name: "Passing feedback sample", purpose: "Verify publication binding", input: { feedback: "Synthetic feedback" }, timeoutSeconds: 30 } } });
  assert.equal(passedTarget.status, 202, JSON.stringify(passedTarget.body));
  const successRunner = createSkillTestRunner({ store, skillTestPersistence: persistence,
    resolveSkillValidationContext: validation.resolveValidationContext.bind(validation),
    commandIntake: new PostgresSkillCommandIntake({ store }), skillValidationService: validation,
    materialResolver: async () => [],
    modelService: { async resolveTurnSelection() { return { modelProfileRevisionId: "controlled-model-revision" }; } },
    executionDispatcher: { async execute() { return { status: "completed", output: { result: "Synthetic result" } }; }, async cancel() {}, async getInvocation() { return null; } },
  });
  t.after(() => successRunner.stop());
  await successRunner.schedule(passedTarget.body.data.testRunId, { workspaceId: row.workspace_id });
  const passed = await request(`/skills/${skillId}/tests/${passedTarget.body.data.testRunId}`, { headers });
  assert.equal(passed.status, 200, JSON.stringify(passed.body));
  assert.equal(passed.body.data.status, "passed");
  const validated = await request(`${draftPath}/validations`, { method: "POST", headers: { ...headers, "Idempotency-Key": "validate-feedback", "If-Match": renamed.headers.get("etag") },
    data: { testRunIds: [passedTarget.body.data.testRunId], permissionAcknowledged: true } });
  assert.equal(validated.status, 202, JSON.stringify(validated.body));
  assert.equal(validated.body.data.status, "passed");
  const binding = (await pool.query("SELECT * FROM skill_execution_bindings WHERE validation_id = $1", [validated.body.data.validationId])).rows[0];
  assert.equal(binding.object_id, row.object_id);
  assert.equal(binding.package_hash, row.package_hash);
  assert.equal(binding.draft_revision, 2);
  const publish = () => request(`/skills/${skillId}/publish`, { method: "POST", headers: { ...headers, "Idempotency-Key": "publish-feedback", "If-Match": renamed.headers.get("etag") }, data: { version: "1.0.0", releaseNotes: "Synthetic publication regression" } });
  const published = await publish();
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.data.skill.lifecycle, "published");
  assert.deepEqual((await publish()).body.data, published.body.data);
  const releaseProjectionSql = "SELECT source_workspace_id,release_id,asset_kind,asset_id,version_id,version,content_hash FROM workspace_asset_releases ORDER BY source_workspace_id,release_id";
  const releasesBeforeNativeMigration = (await pool.query(releaseProjectionSql)).rows;
  assert.ok(releasesBeforeNativeMigration.length > 0);
  await store.runMigrations();
  assert.deepEqual((await pool.query(releaseProjectionSql)).rows, releasesBeforeNativeMigration, "native publication migration preserves existing version IDs and immutable contents");
  assert.deepEqual((await publish()).body.data, published.body.data, "existing publication receipts survive the catalog migration");
  const persistedVersion = (await pool.query("SELECT * FROM skill_versions WHERE skill_id = $1", [skillId])).rows[0];
  assert.equal(persistedVersion.execution_binding_id, binding.execution_binding_id);
  assert.equal(persistedVersion.source_draft_revision, 2);
  const versions = await request(`/skills/${skillId}/versions`, { headers });
  assert.equal(versions.status, 200, JSON.stringify(versions.body));
  assert.equal(versions.body.data[0].skillVersionId, persistedVersion.skill_version_id);
  const usage = await request(`/skills/${skillId}/usage`, { headers });
  assert.equal(usage.status, 200, JSON.stringify(usage.body));
  assert.deepEqual(usage.body.data.affectedWorkflows, []);
  // The published upload must compile through Product HTTP without adding an
  // executionRef to the immutable draft definition. Model/runtime probes alone
  // are controlled; the catalog, references, pins and readback use PostgreSQL.
  const loop = await request("/loops", { method: "POST", headers: { ...headers, "Idempotency-Key": "create-feedback-loop" }, data: {
    name: "Feedback workflow", description: "Use the published feedback Skill", definition: {
      goal: "Summarize feedback", context: "", constraints: [], doneWhen: [], verify: [], expectedResult: "Feedback summary", stopRules: [],
    },
  } });
  assert.equal(loop.status, 201, JSON.stringify(loop.body));
  const workflowId = loop.body.data.workflow.workflowId;
  const initial = loop.body.data.revision;
  const graph = structuredClone(initial.graph);
  const output = graph.nodes.find((node) => node.kind === "Output");
  const skillNode = { ...structuredClone(output), nodeId: "node-feedback", kind: "Skill", title: "Summarize feedback",
    skillRef: { skillId, version: "1.0.0" }, configuration: {},
    inputPorts: [{ portId: "feedback", name: "Feedback", schema: { type: "string" }, required: true }],
    inputBindings: [{ targetPort: "feedback", source: { kind: "nodeOutput", nodeId: "node-input", portId: "goal" } }],
    outputPorts: [{ portId: "result", name: "Result", schema: { type: "string" }, required: true }],
  };
  output.inputPorts[0].schema = { type: "string" };
  output.outputPorts[0].schema = { type: "string" };
  output.inputBindings[0].source = { kind: "nodeOutput", nodeId: skillNode.nodeId, portId: "result" };
  graph.nodes.splice(1, 0, skillNode);
  graph.edges = [
    { edgeId: "edge-input-skill", sourceNodeId: "node-input", sourcePort: "goal", targetNodeId: skillNode.nodeId, targetPort: "feedback" },
    { edgeId: "edge-skill-output", sourceNodeId: skillNode.nodeId, sourcePort: "result", targetNodeId: output.nodeId, targetPort: "result" },
  ];
  const saveData = { baseRevisionId: initial.revisionId, graph, inputForm: initial.inputForm,
    outputDefinition: initial.outputDefinition, runSettings: initial.runSettings, resourceRefs: [],
    definition: initial.definition, saveReason: "Use the published Skill" };
  const workflow = await request(`/workflows/${workflowId}`, { headers });
  const saved = await request(`/loops/${workflowId}/revisions`, { method: "POST",
    headers: { ...headers, "Idempotency-Key": "save-feedback-loop", "If-Match": workflow.headers.get("etag") }, data: saveData });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const revisionId = saved.body.data.revision.revisionId;
  const compileWorkflow = (key) => request(`/workflows/${workflowId}/compile`, { method: "POST",
    headers: { ...headers, "Idempotency-Key": key }, data: { workflowRevisionId: revisionId } });
  const missingModel = await compileWorkflow("compile-without-model");
  assert.equal(missingModel.status, 200, JSON.stringify(missingModel.body));
  assert.equal(missingModel.body.data.status, "blocked", "a valid draft can be saved before a model is configured");
  const configured = await request("/model-profiles", { method: "POST", headers: { ...headers, "Idempotency-Key": "configure-workflow-model" },
    data: { displayName: "Workflow model", provider: "deepseek", providerModelId: "deepseek-chat", secretRef: "workflow-model:1", makeDefault: true } });
  assert.equal(configured.status, 201, JSON.stringify(configured.body));
  const compiled = await compileWorkflow("compile-with-model");
  assert.equal(compiled.status, 200, JSON.stringify(compiled.body));
  assert.equal(compiled.body.data.status, "ready", JSON.stringify(compiled.body.data));
  const persistedPlan = (await pool.query("SELECT plan.* FROM execution_plans plan JOIN workflows workflow ON workflow.workspace_id = plan.workspace_id AND workflow.latest_compile_result_id = plan.compile_result_id WHERE workflow.workflow_id = $1", [workflowId])).rows[0];
  const modelPins = (await pool.query("SELECT * FROM execution_plan_model_pins WHERE plan_id = $1", [persistedPlan.plan_id])).rows;
  assert.equal(modelPins.length, 1);
  assert.equal(modelPins[0].node_id, skillNode.nodeId);
  await restart();
  const execution = await createPostgresWorkflowExecutionResolver({ store })({ workflowId, revisionId });
  assert.equal(execution.skillVersions.length, 1);
  assert.equal(Check(SkillVersionSchema, execution.skillVersions[0]), true, JSON.stringify(execution.skillVersions[0]));
  assert.equal(execution.skillVersions[0].skillVersionId, persistedVersion.skill_version_id);
  assert.equal(execution.skillVersions[0].contentHash, persistedVersion.content_hash);
  assert.equal(modelPins[0].model_profile_revision_id, execution.compileResult.executionPlan.steps.find((step) => step.nodeId === skillNode.nodeId).modelProfileRevisionId);
  assert.deepEqual((await pool.query("SELECT definition FROM skill_versions WHERE skill_version_id = $1", [persistedVersion.skill_version_id])).rows[0].definition, persistedVersion.definition);
  const readModel = store.createSkillReadModel();
  assert.deepEqual(await readModel.getSkillVersionByRef({ workspaceId: row.workspace_id, skillId, version: "1.0.0" }), execution.skillVersions[0]);
  assert.deepEqual(await readModel.getSkillVersion({ workspaceId: row.workspace_id, skillVersionId: persistedVersion.skill_version_id }), execution.skillVersions[0]);
  const taskStart = await request(`/loops/${workflowId}/agent-tasks`, { method: "POST",
    headers: { ...headers, "Idempotency-Key": "start-published-skill-workflow" },
    data: { workflowRevisionId: revisionId, inputs: { goal: "Synthetic feedback" }, resourceRefs: [], materialBindings: [] } });
  assert.equal(taskStart.status, 503, JSON.stringify(taskStart.body));
  assert.equal(workflowDispatches.length, 1, "HTTP authorizes the exact published Skill via PostgreSQL before reaching the Runner");
  assert.equal(workflowDispatches[0].workflowRevisionId, revisionId);
  assert.ok(workflowDispatches[0].authorizationDecisionId);
  const afterCompile = await request(`/workflows/${workflowId}`, { headers });
  const resaved = await request(`/loops/${workflowId}/revisions`, { method: "POST", headers: {
    ...headers, "Idempotency-Key": "edit-compiled-workflow", "If-Match": afterCompile.headers.get("etag"),
  }, data: { ...saveData, baseRevisionId: revisionId, definition: { ...saveData.definition, context: "Another week" } } });
  assert.equal(resaved.status, 201, JSON.stringify(resaved.body));
  assert.equal(resaved.body.data.workflow.status, "draft");
  assert.equal((await pool.query("SELECT latest_compile_result_id FROM workflows WHERE workflow_id = $1", [workflowId])).rows[0].latest_compile_result_id, null);
  assert.equal((await pool.query("SELECT pins_finalized FROM execution_plans WHERE plan_id = $1", [persistedPlan.plan_id])).rows[0].pins_finalized, true, "editing preserves the previous immutable plan");
  assert.equal((await request(path)).status, 401);

  // Only delivery/OAuth assertion are controlled; membership, sessions and upload ownership are real.
  const invite = await request("/workspace/invitations", { method: "POST", headers: { ...headers, "Idempotency-Key": "invite-member" }, data: { email: "member@example.test" } });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  await authService.deliverInvitationOutbox({ limit: 1 });
  const token = new URLSearchParams(new URL(invitations[0].invitationUrl).hash.slice(1)).get("token");
  const oauth = await request("/auth/oauth/google/start", { method: "POST", data: { token } });
  const state = new URL(oauth.body.data.authorizationUrl).searchParams.get("state");
  const login = await request(`/auth/oauth/google/callback?state=${encodeURIComponent(state)}&code=verified-provider-code`);
  const memberHeaders = await authHeaders(login);
  assert.equal((await request(path, { headers: memberHeaders })).status, 404);
  assert.equal((await request(`${path}/complete`, { method: "POST", headers: { ...memberHeaders, "Idempotency-Key": "complete-feedback" }, data: {} })).status, 404);
  assert.equal((await request("/skills", { method: "POST", headers: { ...memberHeaders, "Idempotency-Key": "steal-upload" }, data: createSkillData })).status, 404);
  assert.equal((await request(draftPath, { headers: memberHeaders })).status, 404);
  // Reusing a released version must not require exposing the author's private asset/draft.
  assert.equal((await pool.query("SELECT visibility FROM skill_assets WHERE skill_id = $1", [skillId])).rows[0].visibility, "private");
  const memberLoop = await request("/loops", { method: "POST", headers: { ...memberHeaders, "Idempotency-Key": "member-release-loop" },
    data: { name: "Member uses published feedback", description: "Exact released method", definition: initial.definition } });
  assert.equal(memberLoop.status, 201, JSON.stringify(memberLoop.body));
  const memberWorkflowId = memberLoop.body.data.workflow.workflowId;
  const memberWorkflow = await request(`/workflows/${memberWorkflowId}`, { headers: memberHeaders });
  const memberSaved = await request(`/loops/${memberWorkflowId}/revisions`, { method: "POST", headers: {
    ...memberHeaders, "Idempotency-Key": "member-release-save", "If-Match": memberWorkflow.headers.get("etag"),
  }, data: { ...saveData, baseRevisionId: memberLoop.body.data.revision.revisionId } });
  assert.equal(memberSaved.status, 201, JSON.stringify(memberSaved.body));
  assert.equal((await request(draftPath, { headers: memberHeaders })).status, 404, "version reuse never reveals the private draft");
  // Another member downloads the immutable publication via native PKCE/Bearer HTTP,
  // while the author's private draft stays inaccessible. No model output is mocked here.
  const release = (await pool.query("SELECT release_id FROM workspace_asset_releases WHERE skill_version_id = $1", [persistedVersion.skill_version_id])).rows[0];
  assert.ok(release);
  const packagePath = `/team-library/${release.release_id}/native-skill-package`;
  assert.equal((await request(packagePath)).status, 401);
  assert.equal((await request('/team-library/not-a-release/native-skill-package', { headers: memberHeaders })).status, 404);
  await assert.rejects(pool.query("UPDATE skill_assets SET lifecycle = 'draft' WHERE skill_id = $1", [skillId]),
    (error) => error.constraint === "skill_assets_lifecycle_transition", "existing published draft cannot be reopened in place");
  const authorDraft = await request(draftPath, { headers });
  const nextDraft = await request(`/skills/${skillId}/drafts`, { method: "POST", headers: { ...headers,
    "Idempotency-Key": "private-next-version", "If-Match": authorDraft.headers.get("etag") },
    data: { baseVersionId: persistedVersion.skill_version_id } });
  assert.equal(nextDraft.status, 201, JSON.stringify(nextDraft.body));
  const privateRename = await request(`/skills/${skillId}/drafts/${nextDraft.body.data.skillDraftId}`, { method: "PATCH", headers: { ...headers,
    "Idempotency-Key": "private-next-version-name", "If-Match": nextDraft.headers.get("etag") },
    data: { name: "PRIVATE UNPUBLISHED NEXT VERSION", description: "PRIVATE UNPUBLISHED DESCRIPTION",
      inputSchema: { type: "object", properties: { privateSource: { type: "string" } }, required: ["privateSource"], additionalProperties: false },
      outputSchema: { type: "object", properties: { privateResult: { type: "string" } }, required: ["privateResult"], additionalProperties: false } } });
  assert.equal(privateRename.status, 200, JSON.stringify(privateRename.body));
  assert.equal((await request(`/skills/${skillId}/drafts/${nextDraft.body.data.skillDraftId}`, { headers: memberHeaders })).status, 404);
  const memberLibrary = await request("/team-library", { headers: memberHeaders });
  assert.equal(memberLibrary.status, 200, JSON.stringify(memberLibrary.body));
  const sharedSkill = memberLibrary.body.data.find((entry) => entry.releaseId === release.release_id);
  assert.equal(sharedSkill.skillSummary.name, persistedVersion.definition.name);
  assert.equal(sharedSkill.skillSummary.description, persistedVersion.definition.description);
  assert.deepEqual(sharedSkill.skillSummary.inputs, ["feedback"]);
  assert.deepEqual(sharedSkill.skillSummary.inputSchema, persistedVersion.definition.inputSchema);
  assert.deepEqual(sharedSkill.skillSummary.outputSchema, persistedVersion.definition.outputSchema);
  assert.equal(Check(WorkspaceAssetReleaseSchema, sharedSkill), true, JSON.stringify(sharedSkill));
  assert.ok(!JSON.stringify(memberLibrary.body.data).includes("PRIVATE UNPUBLISHED"));
  assert.ok(!JSON.stringify(memberLibrary.body.data).includes("privateSource"));
  assert.ok(!JSON.stringify(memberLibrary.body.data).includes("privateResult"));
  assert.equal((await request('/team-library')).status, 401);

  // Use the same author in a separate real tenant. The active workspace must
  // fence catalog/package reads even when the caller owns the source Skill.
  const foreignWorkspaceId = "unrelated-library-workspace";
  await seedForeignWorkspaceOwner({ pool, workspaceId: foreignWorkspaceId, ownerUserId: owner.body.data.user.userId });
  const foreignSession = await sessionStore.issue({ userId: owner.body.data.user.userId, activeWorkspaceId: foreignWorkspaceId });
  const foreignHeaders = { Cookie: `workbench_session=${foreignSession.token}`, "X-Workbench-CSRF": foreignSession.csrfToken };
  const foreignLibrary = await request('/team-library', { headers: foreignHeaders });
  assert.equal(foreignLibrary.status, 200, JSON.stringify(foreignLibrary.body));
  assert.deepEqual(foreignLibrary.body.data, [], "an authenticated different workspace does not see these releases");
  assert.equal((await request(packagePath, { headers: foreignHeaders })).status, 404);
  assert.equal((await request(`/skills/${skillId}/drafts/${nextDraft.body.data.skillDraftId}`, { headers: foreignHeaders })).status, 404);
  const localTrials = await verifyLocalLoopTrials({ request, pool, restart, headers, memberHeaders, foreignHeaders, ownerUserId: owner.body.data.user.userId });
  const nativeLoopRelease = await verifyNativeLoopReleases({ request, pool, restart, headers, memberHeaders, foreignHeaders, saveData });
  const downloaded = await request(packagePath, { headers: memberHeaders });
  assert.equal(downloaded.status, 200, JSON.stringify(downloaded.body));
  assert.equal(downloaded.body.data.versionId, persistedVersion.skill_version_id);
  assert.deepEqual(Buffer.from(downloaded.body.data.packageContentBase64, "base64"), bytes);
  const nativeProfile = join(root, "member-native-session.json");
  await loginNativeProduct({ baseUrl: authService.publicOrigin, sessionPath: nativeProfile, timeoutMs: 15_000,
    async onAuthorization(url) {
      const approved = await authService.approveNativeAuthorization({ authorizationId: new URL(url).searchParams.get("authorizationId"),
        auth: { userId: login.body.data.user.userId, activeWorkspaceId: row.workspace_id } });
      assert.equal((await fetch(approved.redirectUrl)).status, 200);
    } });
  const codexDirectory = join(root, "native-codex"); await mkdir(codexDirectory);
  const cliPath = fileURLToPath(new URL("../../../../../agent/code/agent-runtime/integrations/native/cli.mjs", import.meta.url));
  const installedByCli = await promisify(execFile)(process.execPath, [cliPath, "install-skill", "--session", nativeProfile,
    "--agent", "codex", "--project", codexDirectory, "--release", release.release_id], { timeout: 30_000 });
  assert.equal(JSON.parse(installedByCli.stdout).status, "installed");
  if (process.env.TURNSU_NATIVE_SKILL_ACCEPTANCE === "codex") {
    const nativeResult = await runNativeInstalledSkill({ directory: codexDirectory, skillName: downloaded.body.data.skillName });
    assert.equal(nativeResult.code, 0, JSON.stringify(nativeResult));
    const output = await readFile(nativeResult.outputPath, "utf8");
    for (const fragment of ["团队反馈", "我用 Codex，希望复用同事的技能", "我用 Claude Code，希望直接查看团队结果", "未知"]) assert.ok(output.includes(fragment), output);
    const trace = JSON.parse(await readFile(nativeResult.tracePath, "utf8"));
    const commands = trace.stdout.split("\n").filter(Boolean).flatMap((line) => {
      try { const event = JSON.parse(line); return event.type === "item.completed" && event.item?.type === "command_execution" && event.item.exit_code === 0 ? [event.item.command] : []; } catch { return []; }
    });
    assert.ok(commands.some((command) => command.includes("SKILL.md")), "native model must actually read the installed instructions");
    assert.ok(commands.some((command) => command.includes("references/format.md")), "native model must actually read the package reference");
    // Preserve only synthetic output and trace, outside the test directory removed on cleanup.
    const evidence = await mkdtemp(join(tmpdir(), "turnsu-native-skill-evidence-"));
    await writeFile(join(evidence, "result.md"), output, { mode: 0o600 });
    await writeFile(join(evidence, "trace.json"), JSON.stringify(trace), { mode: 0o600 });
    t.diagnostic(JSON.stringify({ nativeSkill: "codex", releaseId: release.release_id, packageObjectHash: downloaded.body.data.packageObjectHash, evidence }));
  }
  const native = await openNativeProductSession(nativeProfile);
  try {
    for (const agent of ["codex", "claude", "pi"]) {
      const directory = join(root, `native-${agent}`); await mkdir(directory, { recursive: true });
      const input = { product: native.product, agent, projectDirectory: directory, releaseId: release.release_id };
      const receipt = await installNativeSkill(input);
      assert.equal(receipt.status, agent === "codex" ? "already_installed" : "installed");
      for (const file of files) assert.equal(await readFile(join(receipt.directory, file.path), "utf8"), file.content);
      assert.equal((await installNativeSkill(input)).status, "already_installed");
      assert.equal(receipt.nativeExecution, "not_verified");
    }
    // The desktop consumes this same immutable publication through its actual cloud/profile path.
    const desktopState = join(root, 'desktop-state'), desktopProject = join(root, 'desktop-project');
    await mkdir(desktopState, { mode: 0o700 }); await mkdir(desktopProject);
    await loginNativeProduct({ baseUrl: authService.publicOrigin, sessionPath: join(desktopState, 'cloud-session.json'), timeoutMs: 15_000,
      async onAuthorization(url) {
        const approved = await authService.approveNativeAuthorization({ authorizationId: new URL(url).searchParams.get('authorizationId'), auth: { userId: login.body.data.user.userId, activeWorkspaceId: row.workspace_id } });
        assert.equal((await fetch(approved.redirectUrl)).status, 200);
      } });
    const nativeRequests = []; let nativeHooks;
    const desktop = new LocalAgentHost({ directory: desktopState, connectionFactory: options => { nativeHooks = options; return { ready: Promise.resolve(), closed: false, close: async () => {},
      request: async (method, params) => {
        nativeRequests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'desktop-native-' + nativeRequests.filter(r => r.method === 'thread/start').length, turns: [] } };
        if (method === 'turn/start') return { turn: { id: 'desktop-turn' } };
        throw new Error(method);
      } }; } });
    try {
      const project = await desktop.command('project.open', { path: desktopProject });
      const catalog = await desktop.command('methods.list');
      assert.ok(catalog.items.some(item => item.releaseId === release.release_id && item.skillSummary.name === persistedVersion.definition.name));
      const choice = { projectId: project.id, agent: 'codex', releaseId: release.release_id, requestId: 'desktop-use-exact-skill' };
      const task = await desktop.command('methods.use', choice);
      assert.equal(nativeRequests.length, 0, 'adding a skill does not spend model quota');
      assert.equal(task.method.packageObjectHash, downloaded.body.data.packageObjectHash);
      for (const file of files) assert.equal(await readFile(join(task.method.directory, file.path), 'utf8'), file.content);
      assert.equal((await desktop.command('methods.use', choice)).id, task.id, 'retry opens the same task');
      await desktop.command('session.send', { sessionId: task.id, inputId: 'desktop-method-input', text: '整理团队本周反馈' });
      assert.ok(nativeRequests.find(item => item.method === 'turn/start').params.input[0].text.includes(join(task.method.directory, 'SKILL.md')));
      nativeHooks.onEvent({ method: 'turn/completed', params: { threadId: 'desktop-native-1', turn: { id: 'desktop-turn', status: 'completed' } } });
      await verifyTeamSkill({ host: desktop, root, request, ownerHeaders: headers, memberUserId: login.body.data.user.userId, releaseId: release.release_id, requests: nativeRequests });
      const capture = await verifyCaptureUpload({ host: desktop, root, request, otherHeaders: headers, pool, objectStore });
      await verifyCaptureRelease({ host: desktop, capture, runner: successRunner, workspaceId: row.workspace_id, pool, request, otherHeaders: headers });
      const borrowRelease=(await pool.query('SELECT release_id,version_id,content_hash FROM workspace_asset_releases WHERE skill_id=$1',[capture.skillId])).rows[0];
      await verifyMemberAgentRequests({request,pool,root,authService,sessionStore,nativeProfile,headers,memberHeaders,foreignHeaders,restart,getBorrowing:()=>borrowing,providerUserId:login.body.data.user.userId,
        requesterUserId:owner.body.data.user.userId,workspaceId:row.workspace_id,method:{releaseId:borrowRelease.release_id,versionId:borrowRelease.version_id,contentHash:borrowRelease.content_hash},
        oversizedMethod:{releaseId:release.release_id,versionId:downloaded.body.data.versionId,contentHash:downloaded.body.data.contentHash}});
      const loopCapture = await verifyLoopCapture({ host: desktop, root, pool, request, otherHeaders: headers, nativeRequests,
        document: { name: 'Captured feedback Loop', description: 'Preserve sources while classifying feedback', definition: saveData.definition,
          graph: saveData.graph, inputForm: saveData.inputForm, outputDefinition: saveData.outputDefinition, resourceRefs: [], runSettings: saveData.runSettings } });
      await verifyLocalLoopTrial({ host: desktop, sourceSessionId: loopCapture.sessionId, pool, nativeRequests, request, otherHeaders: headers,
        root, authService, consumerUserId: owner.body.data.user.userId, workspaceId: row.workspace_id });
      if (!process.env.TURNSU_LOOP_DESKTOP_UI_STATE) {
        await desktop.cloud.session.revoke();
        await assert.rejects(desktop.command('methods.use', { ...choice, requestId: 'revoked-attempt' }), /访问权限/);
      }
    } finally { await desktop.close(); }
    // Optional native UI acceptance against this same isolated Product server and saved SQLite state.
    // No UI-specific responses or model calls: the packaged desktop uses its normal host.
    const uiState = process.env.TURNSU_LOOP_DESKTOP_UI_STATE;
    if (uiState) {
      assert.match(uiState, /^\/private\/tmp\/turnsu-loop-ui-[a-z0-9-]+$/);
      await mkdir(uiState, { mode: 0o700 });
      await writeFile(join(uiState, 'ready.json'), JSON.stringify({ desktopState, origin: authService.publicOrigin, projectPath: join(root, 'loop-capture-project') }), { mode: 0o600 });
      const deadline = Date.now() + 20 * 60_000;
      while (Date.now() < deadline && !await stat(join(uiState, 'finished')).then(() => true, () => false)) await new Promise(resolve => setTimeout(resolve, 500));
      const reopened = new LocalAgentHost({ directory: desktopState });
      try {
        await reopened.command('methods.list');
        await reopened.cloud.session.revoke();
        await assert.rejects(reopened.command('methods.list'), /访问权限/);
      } finally { await reopened.close(); }
    }
    assert.equal((await request(draftPath, { headers: memberHeaders })).status, 404);
    await native.revoke();
    await assert.rejects(native.product.call("turnsu_skill_package", { pathParams: { releaseId: release.release_id } }),
      (error) => error.status === 401 || error.code === "native_access_token_invalid");
  } finally { await native.release(); }
  await pool.query("UPDATE workspace_memberships SET status = 'suspended', suspended_at = clock_timestamp(), revision = revision + 1, updated_at = clock_timestamp() WHERE workspace_id = $1 AND user_id = $2", [row.workspace_id, row.requested_by]);
  assert.equal((await request(packagePath, { headers })).status, 401, "suspended membership cannot download an exact release");
  assert.equal((await request('/team-library', { headers })).status, 401, "suspended membership cannot read published contracts from the catalog");
  assert.equal((await localTrials.replay()).status, 401, "revoked membership cannot replay a private local trial receipt");
  assert.equal((await nativeLoopRelease.publish()).status, 401, "revoked owner cannot replay native publication");
  assert.equal((await request(nativeLoopRelease.packagePath, { headers })).status, 401, "revoked member cannot download native recipes");
  await assert.rejects(service.completeUpload({ workspaceId: row.workspace_id, requestedBy: row.requested_by, uploadId, idempotencyKey: "complete-feedback" }), { code: "skill_creation_forbidden" }, "revoked access cannot replay private receipts");
});

async function seedForeignWorkspaceOwner({ pool, workspaceId, ownerUserId }) {
  const membershipId = `membership-${workspaceId}-${ownerUserId}`;
  const scopeId = `${workspaceId}-${ownerUserId}-personal`;
  const policyRevisionId = `${workspaceId}-${ownerUserId}-policy-1`;
  const grantId = `${workspaceId}-${ownerUserId}-operation`;
  const aggregatePayload = JSON.stringify({ bootstrap: "workspace_initial_seed" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const createdAt = (await client.query(
      "SELECT clock_timestamp() - interval '1 second' AS now",
    )).rows[0].now;
    await client.query(`
      INSERT INTO public.product_workspaces (
        workspace_id, schema_version, name, created_by, created_at, updated_at, payload
      ) VALUES ($1, 'workbench-v1', 'Foreign HTTP isolation workspace', $2,
        $3::timestamptz, $3::timestamptz, '{}'::jsonb)
    `, [workspaceId, ownerUserId, createdAt]);
    await client.query(`
      INSERT INTO public.workspace_memberships (
        membership_id, workspace_id, user_id, schema_version, role, status, revision,
        created_at, updated_at, payload
      ) VALUES ($1, $2, $3, 'workbench-v1', 'owner', 'active', 1,
        $4::timestamptz, $4::timestamptz, $5::jsonb)
    `, [membershipId, workspaceId, ownerUserId, createdAt, aggregatePayload]);
    await client.query(`
      INSERT INTO public.workspace_principals (
        workspace_id, principal_id, principal_kind, user_id, membership_id,
        status, revision, created_at, updated_at, revoked_at, payload
      ) VALUES ($1, $2, 'user', $2, $3, 'active', 1,
        $4::timestamptz, $4::timestamptz, NULL, $5::jsonb)
    `, [workspaceId, ownerUserId, membershipId, createdAt, aggregatePayload]);
    await client.query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind, owner_user_id, owner_principal_id,
        current_policy_revision_id, created_by_principal_id, created_by_principal_kind,
        creation_mode, created_at, updated_at, payload
      ) VALUES ($1, $2, 'workbench-v1', 'personal', $3, $3, $4, $3, 'user',
        'workspace_initial_seed', $5::timestamptz, $5::timestamptz, $6::jsonb)
    `, [workspaceId, scopeId, ownerUserId, policyRevisionId, createdAt, aggregatePayload]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier, permission_mode,
        auto_approved_effect_classes, auto_approved_action_ids, policy_content_hash,
        created_by_principal_id, created_by_principal_kind, created_at, payload
      ) VALUES ($1, $2, $3, 1, 'workspace_readable', 'interactive',
        ARRAY[]::text[], ARRAY[]::text[], $4, $5, 'user', $6::timestamptz, $7::jsonb)
    `, [
      workspaceId,
      scopeId,
      policyRevisionId,
      `sha256:${"e".repeat(64)}`,
      ownerUserId,
      createdAt,
      aggregatePayload,
    ]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind,
        capabilities, can_approve, granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, created_at, updated_at, payload
      ) VALUES ($1, $2, $3, $4, 'user', 'operation', ARRAY['object.execute']::text[], true,
        $4, 'user', 'scope_creation', $5::timestamptz, $5::timestamptz, $6::jsonb)
    `, [workspaceId, scopeId, grantId, ownerUserId, createdAt, aggregatePayload]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
