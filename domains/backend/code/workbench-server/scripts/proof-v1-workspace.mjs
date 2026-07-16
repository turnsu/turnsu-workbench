import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { MongoClient } from "mongodb";
import { portableLoopPackageExample } from "../../workbench-contracts/examples/canonical-examples.mjs";
import { inspectPiBuilderProviderReadiness } from "../../../../agent/code/agent-runtime/core/proposals/pi-builder-provider-readiness.mjs";

import {
  formatPortableLoopPackage,
  hashPortableLoopPackage,
  parsePortableLoopPackage,
  PORTABLE_LOOP_PACKAGE_MEDIA_TYPE,
} from "../src/loops/portable-loop-package.mjs";

const API_VERSION = "workbench-api-v1";
const DATABASE_NAME = process.env.WORKBENCH_MONGODB_DB
  ?? process.env.MONGODB_DB
  ?? "looloomi_workbench_v1_proof_test";
const MONGODB_URI = process.env.WORKBENCH_MONGODB_URI
  ?? process.env.MONGODB_URI
  ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";
const DOCKER_IMAGE = String(process.env.WORKBENCH_DOCKER_IMAGE ?? "").trim();
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../../../..");
const SERVER_ENTRY = join(PACKAGE_DIRECTORY, "src/server.mjs");
const SKILL_FILE = join(
  REPOSITORY_ROOT,
  "domains/agent/code/agent-runtime/skills/meeting-action-extractor.md",
);
const USER_A = "proof-user-a";
const USER_B = "proof-user-b";
const WORKSPACE = "proof-workspace-main";
const DENIAL_WORKSPACE = "proof-workspace-isolated";
const INPUT_TEXT = "Owner will send the revised brief on Friday.";
const REQUEST_TIMEOUT_MS = 20_000;
const PROPOSAL_REQUEST_TIMEOUT_MS = 45_000;
const RUN_TIMEOUT_MS = 120_000;
const SERVER_TIMEOUT_MS = 30_000;

class ProofBlockedError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProofBlockedError";
    this.code = code;
    this.details = details;
  }
}

class ApiError extends Error {
  constructor({ method, path, status, payload }) {
    super(`api_error:${method}:${path}:${status}:${payload?.code ?? "unknown"}`);
    this.name = "ApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.payload = payload;
  }
}

class WorkbenchApi {
  constructor(origin, { userId, workspaceId }) {
    this.origin = origin;
    this.userId = userId;
    this.workspaceId = workspaceId;
    this.cookie = null;
    this.csrf = null;
  }

  async bootstrap() {
    const result = await this.request("/api/workbench/v1/workspace", {
      headers: {
        "X-Workbench-Test-User": this.userId,
        "X-Workbench-Test-Workspace": this.workspaceId,
      },
    });
    const setCookie = result.response.headers.getSetCookie?.()[0]
      ?? result.response.headers.get("set-cookie");
    assert.ok(setCookie, "workspace bootstrap must issue a cookie");
    this.cookie = setCookie.split(";", 1)[0];
    this.csrf = result.data.session.csrfToken;
    assert.ok(this.csrf?.length >= 32, "workspace bootstrap must issue CSRF proof");
    return result.data;
  }

  get(path, expectedStatus = 200) {
    return this.request(path, { expectedStatus });
  }

  mutate(path, {
    body,
    key,
    method = "POST",
    expectedStatus = 200,
    ifMatch,
    timeoutMs = REQUEST_TIMEOUT_MS,
  }) {
    assert.ok(this.cookie && this.csrf, "session must be bootstrapped");
    assert.ok(key, "mutation requires an idempotency key");
    return this.request(path, {
      method,
      body,
      expectedStatus,
      timeoutMs,
      headers: {
        Cookie: this.cookie,
        Origin: this.origin,
        "Sec-Fetch-Site": "same-origin",
        "X-Workbench-CSRF": this.csrf,
        "Idempotency-Key": key,
        ...(ifMatch ? { "If-Match": ifMatch } : {}),
      },
    });
  }

  async request(path, {
    method = "GET",
    body,
    expectedStatus = 200,
    headers = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = {}) {
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const source = await response.text();
    let payload;
    try {
      payload = JSON.parse(source);
    } catch {
      throw new Error(`non_json_response:${method}:${path}:${response.status}`);
    }
    if (response.status !== expectedStatus) {
      throw new ApiError({ method, path, status: response.status, payload });
    }
    assert.equal(payload.schemaVersion, API_VERSION, `${path} schemaVersion`);
    assert.equal(typeof payload.requestId, "string", `${path} requestId`);
    return { data: payload.data, payload, response };
  }

  async raw(path, { expectedStatus = 200, headers = {} } = {}) {
    assert.ok(this.cookie, "session must be bootstrapped");
    const response = await fetch(`${this.origin}${path}`, {
      headers: { Cookie: this.cookie, ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expectedStatus, bytes.toString("utf8"));
    return { response, bytes };
  }
}

const envelope = (data) => ({ schemaVersion: API_VERSION, data });
const proofKey = (name) => `proof-v1-${name}-${PROOF_NONCE}`;
const PROOF_NONCE = randomUUID();
const PROOF_CHECKPOINT = {};

async function main() {
  assertSupportedNode();
  assert.match(DATABASE_NAME, /_test$/, "proof database must end in _test");

  const root = await mkdtemp(join(tmpdir(), "looloomi-v1-workspace-proof-"));
  assertTemporaryRoot(root);
  const runtimeRoot = join(root, "runtime");
  const objectRoot = join(root, "objects");
  const executionRoot = join(root, "executions");

  let server;
  try {
    await assertExternalPrerequisites({
      piAgentDir: join(runtimeRoot, "agent", "pi-agent-home"),
    });
    await resetTestDatabase();
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const serverEnv = {
      ...process.env,
      WORKBENCH_PORT: String(port),
      WORKBENCH_TEST_MODE: "1",
      WECHAT_AGENT_TEST_MODE: "1",
      WORKBENCH_TEST_BUSINESS_SKILL: "1",
      WORKBENCH_PROOF_DIAGNOSTICS: "1",
      WECHAT_AGENT_RUNTIME_ROOT: runtimeRoot,
      WORKBENCH_OBJECT_STORE_ROOT: objectRoot,
      WORKBENCH_EXECUTION_ROOT: executionRoot,
      WORKBENCH_MONGODB_URI: MONGODB_URI,
      MONGODB_URI,
      WORKBENCH_MONGODB_DB: DATABASE_NAME,
      MONGODB_DB: DATABASE_NAME,
      WORKBENCH_DOCKER_IMAGE: DOCKER_IMAGE,
    };
    server = await startServer({ port, env: serverEnv });
    let owner = new WorkbenchApi(origin, { userId: USER_A, workspaceId: WORKSPACE });
    let member = new WorkbenchApi(origin, { userId: USER_B, workspaceId: WORKSPACE });
    let isolated = new WorkbenchApi(origin, { userId: USER_B, workspaceId: DENIAL_WORKSPACE });
    const ownerWorkspace = await owner.bootstrap();

    await owner.mutate("/api/workbench/v1/workspace/memberships", {
      expectedStatus: 201,
      key: proofKey("invite-member"),
      body: envelope({ userId: USER_B, displayName: "Proof member B", role: "member" }),
    });
    await member.bootstrap();
    await isolated.bootstrap();

    const packageV1 = await createPromotedPackage(owner, {
      label: "v1",
      scriptSuffix: "# package-v1\n",
    });
    const secretScan = await proveSecretScan(owner);
    const skillV1 = await createValidateAndPublishSkill(owner, {
      packageUploadId: packageV1.uploadId,
      version: "1.0.0",
      suffix: "v1",
    });
    const packageContentHashV1 = await readInternalSkillPackageHash(skillV1.version.skillVersionId);
    const installedSkill = await member.mutate(
      `/api/workbench/v1/team-library/${skillV1.release.releaseId}/install`,
      {
        expectedStatus: 201,
        key: proofKey("install-skill-v1"),
        body: envelope({ connectionIds: [] }),
      },
    );
    assert.equal(installedSkill.data.pinnedVersionId, skillV1.version.skillVersionId);
    Object.assign(PROOF_CHECKPOINT, {
      skillUploadV1Id: packageV1.uploadId,
      skillId: skillV1.skill.skillId,
      skillDraftV1Id: skillV1.draft.skillDraftId,
      skillVersionV1Id: skillV1.version.skillVersionId,
      skillReleaseV1Id: skillV1.release.releaseId,
      skillInstallationV1Id: installedSkill.data.installationId,
      packageContentHashV1,
    });

    const portability = await provePortableLoopLifecycle({ owner, member, isolated });
    Object.assign(PROOF_CHECKPOINT, portability);

    const loop = await createLoopWithConfirmedProposal(owner);
    const graph = meetingActionGraph({
      skillId: skillV1.version.skillId,
      version: skillV1.version.version,
    });
    const currentAfterProposal = await owner.get(
      `/api/workbench/v1/workflows/${loop.workflow.workflowId}`,
    );
    const revisionV1 = await owner.mutate(
      `/api/workbench/v1/loops/${loop.workflow.workflowId}/revisions`,
      {
        expectedStatus: 201,
        key: proofKey("save-loop-v1"),
        ifMatch: requiredEtag(currentAfterProposal.response),
        body: envelope({
          ...graph,
          baseRevisionId: currentAfterProposal.data.currentRevisionId,
          definition: LOOP_DEFINITION,
          saveReason: "Add the published uploaded Skill and review step.",
        }),
      },
    );
    const compileV1 = await owner.mutate(
      `/api/workbench/v1/workflows/${loop.workflow.workflowId}/compile`,
      {
        key: proofKey("compile-v1"),
        body: envelope({ workflowRevisionId: revisionV1.data.revision.revisionId }),
      },
    );
    assert.equal(compileV1.data.status, "ready");
    assert.deepEqual(
      compileV1.data.executionPlan.steps.map(({ nodeId }) => nodeId),
      ["node-input", "node-skill", "node-review", "node-output"],
      "saved edges must determine execution order",
    );

    const initial = await runWithRevision(owner, {
      workflowId: loop.workflow.workflowId,
      revisionId: revisionV1.data.revision.revisionId,
      suffix: "initial",
      revise: true,
    });
    assert.equal(initial.detail.readModel.finalAnswer.content.includes("Reviewer feedback"), true);
    const internalInitial = await readInternalRun(initial.runId);
    const skillAttempts = internalInitial.nodeRuns.filter(({ nodeId }) => nodeId === "node-skill");
    assert.deepEqual(skillAttempts.map(({ attempt }) => attempt), [1, 2]);
    assert.equal(skillAttempts[0].input.transcript, INPUT_TEXT);
    assert.match(skillAttempts[1].input.transcript, /Reviewer feedback:/);
    assert.equal(skillAttempts[0].input.transcript, INPUT_TEXT, "attempt one must remain immutable");

    const workflowBeforePublish = await owner.get(
      `/api/workbench/v1/workflows/${loop.workflow.workflowId}`,
    );
    const publishedLoop = await owner.mutate(
      `/api/workbench/v1/loops/${loop.workflow.workflowId}/publish`,
      {
        key: proofKey("publish-loop-v1"),
        ifMatch: requiredEtag(workflowBeforePublish.response),
        body: envelope({
          version: "1.0.0",
          releaseNotes: "Fresh V1 aggregate proof release.",
          startingPoint: true,
        }),
      },
    );
    const startingPoint = await member.mutate(
      `/api/workbench/v1/team-library/${publishedLoop.data.release.releaseId}/starting-point`,
      {
        expectedStatus: 201,
        key: proofKey("loop-starting-point"),
        body: envelope({ name: "Member B meeting actions" }),
      },
    );
    assert.notEqual(startingPoint.data.workflow.workflowId, loop.workflow.workflowId);

    const packageV2 = await createPromotedPackage(owner, {
      label: "v2",
      scriptSuffix: "# package-v2\n",
    });
    const skillV2 = await createAndPublishNextSkillVersion(owner, {
      skillV1,
      packageUploadId: packageV2.uploadId,
    });
    const versionDiff = await owner.get(
      `/api/workbench/v1/skills/${skillV1.skill.skillId}/versions/${skillV1.version.skillVersionId}/diff/${skillV2.version.skillVersionId}`,
    );
    assert.equal(versionDiff.data.fromVersion, "1.0.0");
    assert.equal(versionDiff.data.toVersion, "2.0.0");
    assert.ok(versionDiff.data.entries.some(({ changed }) => changed));
    const usageImpact = await owner.get(
      `/api/workbench/v1/skills/${skillV1.skill.skillId}/usage`,
    );
    assert.ok(usageImpact.data.affectedWorkflows.some(({ workflowId }) => (
      workflowId === loop.workflow.workflowId
    )));
    const adoptedSkill = await member.mutate(
      `/api/workbench/v1/installations/${installedSkill.data.installationId}/adopt-release`,
      {
        key: proofKey("adopt-skill-v2"),
        body: envelope({ releaseId: skillV2.release.releaseId }),
      },
    );
    assert.equal(adoptedSkill.data.pinnedVersionId, skillV2.version.skillVersionId);
    const workflowForUpdate = await owner.get(
      `/api/workbench/v1/workflows/${loop.workflow.workflowId}`,
    );
    const loopUpdate = await owner.mutate(
      `/api/workbench/v1/loops/${loop.workflow.workflowId}/skill-updates`,
      {
        expectedStatus: 201,
        key: proofKey("loop-skill-update-v2"),
        ifMatch: requiredEtag(workflowForUpdate.response),
        body: envelope({
          skillId: skillV1.skill.skillId,
          fromVersion: "1.0.0",
          toVersion: "2.0.0",
        }),
      },
    );
    assert.equal(
      loopUpdate.data.revision.graph.nodes.find(({ nodeId }) => nodeId === "node-skill").skillRef.version,
      "2.0.0",
    );
    const compileV2 = await owner.mutate(
      `/api/workbench/v1/workflows/${loop.workflow.workflowId}/compile`,
      {
        key: proofKey("compile-v2"),
        body: envelope({ workflowRevisionId: loopUpdate.data.revision.revisionId }),
      },
    );
    assert.equal(compileV2.data.status, "ready");

    await stopServer(server);
    server = await startServer({ port, env: serverEnv });
    owner = new WorkbenchApi(origin, { userId: USER_A, workspaceId: WORKSPACE });
    member = new WorkbenchApi(origin, { userId: USER_B, workspaceId: WORKSPACE });
    isolated = new WorkbenchApi(origin, { userId: USER_B, workspaceId: DENIAL_WORKSPACE });
    await owner.bootstrap();
    await member.bootstrap();
    await isolated.bootstrap();
    const restartReadback = await proveRestartReadback({
      owner,
      member,
      skillV1,
      skillV2,
      workflowId: loop.workflow.workflowId,
      revisionV1Id: revisionV1.data.revision.revisionId,
      updateRevisionId: loopUpdate.data.revision.revisionId,
      initialRunId: initial.runId,
      loopReleaseId: publishedLoop.data.release.releaseId,
      memberWorkflowId: startingPoint.data.workflow.workflowId,
      skillInstallationId: installedSkill.data.installationId,
      installedSkillVersionV2Id: skillV2.version.skillVersionId,
      portableLoopWorkflowId: portability.portableLoopWorkflowId,
      portableLoopRevisionId: portability.portableLoopRevisionId,
    });

    const rerun = await runWithRevision(owner, {
      workflowId: loop.workflow.workflowId,
      revisionId: loopUpdate.data.revision.revisionId,
      suffix: "rerun-v2",
      revise: false,
    });
    const comparison = await owner.get(
      `/api/workbench/v1/runs/${rerun.runId}/comparison/${initial.runId}`,
    );
    assert.equal(comparison.data.left.runId, rerun.runId);
    assert.equal(comparison.data.right.runId, initial.runId);
    assert.equal(comparison.data.skillVersionsChanged, true);

    const tenantDenial = await proveTenantDenial(isolated, {
      skillId: skillV1.skill.skillId,
      workflowId: loop.workflow.workflowId,
      runId: initial.runId,
      releaseId: publishedLoop.data.release.releaseId,
    });
    const internalHashes = await readInternalHashes({
      skillVersionV1Id: skillV1.version.skillVersionId,
      skillVersionV2Id: skillV2.version.skillVersionId,
      skillReleaseV1Id: skillV1.release.releaseId,
      skillReleaseV2Id: skillV2.release.releaseId,
      skillInstallationId: installedSkill.data.installationId,
    });
    assert.notEqual(internalHashes.packageV1, internalHashes.packageV2);
    assert.equal(internalHashes.releaseContentV1, internalHashes.contentV1);
    assert.equal(internalHashes.releaseContentV2, internalHashes.contentV2);
    assert.equal(publishedLoop.data.loopVersion.contentHash, publishedLoop.data.release.contentHash);

    return {
      status: "pass",
      schemaVersion: "proof-v1-workspace-v1",
      userAId: USER_A,
      userBId: USER_B,
      workspaceId: ownerWorkspace.workspace.workspaceId,
      denialWorkspaceId: DENIAL_WORKSPACE,
      skillId: skillV1.skill.skillId,
      skillDraftV1Id: skillV1.draft.skillDraftId,
      skillVersionV1Id: skillV1.version.skillVersionId,
      skillReleaseV1Id: skillV1.release.releaseId,
      ...portability,
      skillDraftV2Id: skillV2.draft.skillDraftId,
      skillVersionV2Id: skillV2.version.skillVersionId,
      skillReleaseV2Id: skillV2.release.releaseId,
      workflowId: loop.workflow.workflowId,
      revisionV1Id: revisionV1.data.revision.revisionId,
      loopVersionId: publishedLoop.data.loopVersion.loopVersionId,
      loopReleaseId: publishedLoop.data.release.releaseId,
      memberStartingPointWorkflowId: startingPoint.data.workflow.workflowId,
      proposalId: loop.proposal.proposalId,
      compilePlan: compileV1.data.executionPlan,
      compilePlanHash: compileV1.data.executionPlan.contentHash,
      orderedNodeIds: compileV1.data.executionPlan.steps.map(({ nodeId }) => nodeId),
      initialRunId: initial.runId,
      initialReviseDecisionId: initial.reviseDecisionId,
      initialApproveDecisionId: initial.approveDecisionId,
      attempt1Id: skillAttempts[0].nodeRunId,
      attempt2Id: skillAttempts[1].nodeRunId,
      initialFinalSequence: initial.finalSequence,
      loopUpdateRevisionId: loopUpdate.data.revision.revisionId,
      rerunId: rerun.runId,
      rerunApproveDecisionId: rerun.approveDecisionId,
      rerunFinalSequence: rerun.finalSequence,
      compareLeftRunId: rerun.runId,
      compareRightRunId: initial.runId,
      packageContentHashV1: internalHashes.packageV1,
      packageContentHashV2: internalHashes.packageV2,
      skillReleaseContentHashV1: internalHashes.releaseContentV1,
      skillReleaseContentHashV2: internalHashes.releaseContentV2,
      workflowRevisionContentHash: revisionV1.data.revision.contentHash,
      loopReleaseContentHash: publishedLoop.data.release.contentHash,
      tenantDenialResult: tenantDenial,
      secretScanResult: secretScan,
      skillVersionDiffResult: "pass",
      skillUsageImpactResult: "pass",
      explicitSkillAdoptionResult: "pass",
      restartReadback,
      portableLoopRestartReadback: "pass",
      comparisonModel: "stateless_pair",
      updateDraftModel: "skillDraftV2Id_plus_loopUpdateRevisionId",
    };
  } catch (error) {
    if (error instanceof ApiError && error.payload?.code === "internal_error") {
      const internalDiagnostics = proofInternalDiagnostics(server);
      if (internalDiagnostics.length > 0) error.details = { internalDiagnostics };
    }
    throw error;
  } finally {
    await stopServer(server).catch(() => {});
    await removeTemporaryRoot(root).catch(() => {});
  }
}

const LOOP_DEFINITION = {
  goal: "Turn meeting notes into actions.",
  context: "Internal meetings.",
  constraints: ["Do not send messages."],
  doneWhen: ["Each action has an owner."],
  verify: ["A reviewer approves the result."],
  expectedResult: "A reviewed action list.",
  stopRules: ["Stop when source notes are missing."],
};

async function provePortableLoopLifecycle({ owner, member, isolated }) {
  const portableLoop = minimalPortableLoop();
  const bytes = formatPortableLoopPackage(portableLoop);
  const upload = await owner.mutate("/api/workbench/v1/uploads", {
    expectedStatus: 201,
    key: proofKey("portable-loop-upload"),
    body: envelope({
      filename: "portable-proof.loop.json",
      sizeBytes: bytes.byteLength,
      mediaType: PORTABLE_LOOP_PACKAGE_MEDIA_TYPE,
      assetKind: "loop",
      ingestMethod: "resumable",
    }),
  });
  await owner.mutate(`/api/workbench/v1/uploads/${upload.data.uploadId}/chunks/0`, {
    method: "PUT",
    key: proofKey("portable-loop-chunk"),
    body: envelope({ contentBase64: bytes.toString("base64") }),
  });
  await owner.mutate(`/api/workbench/v1/uploads/${upload.data.uploadId}/complete`, {
    key: proofKey("portable-loop-complete"),
    body: envelope({}),
  });
  const imported = await owner.mutate("/api/workbench/v1/loop-imports", {
    expectedStatus: 202,
    key: proofKey("portable-loop-import"),
    body: envelope({ uploadId: upload.data.uploadId }),
  });
  assert.equal(imported.data.status, "ready");
  const committed = await owner.mutate(`/api/workbench/v1/loop-imports/${imported.data.importId}/commit`, {
    expectedStatus: 201,
    key: proofKey("portable-loop-commit"),
    ifMatch: requiredEtag(imported.response),
    body: envelope({ skillMappings: [], materialMappings: [], connectionMappings: [] }),
  });
  assert.equal(committed.data.workflow.status, "blocked");
  const exportPath = `/api/workbench/v1/loops/${committed.data.workflow.workflowId}/export?revisionId=${committed.data.revision.revisionId}`;
  const exported = await owner.raw(exportPath, {
    headers: { Accept: PORTABLE_LOOP_PACKAGE_MEDIA_TYPE },
  });
  const exportedPackage = parsePortableLoopPackage(exported.bytes);
  assert.deepEqual(exportedPackage, portableLoop);
  const exportEtag = requiredEtag(exported.response);
  assert.equal(exportEtag, `"${hashPortableLoopPackage(exportedPackage)}"`);
  await owner.raw(exportPath, { expectedStatus: 304, headers: { "If-None-Match": exportEtag } });
  await member.raw(exportPath, { expectedStatus: 403 });
  await isolated.raw(exportPath, { expectedStatus: 404 });
  return {
    portableLoopImportId: imported.data.importId,
    portableLoopWorkflowId: committed.data.workflow.workflowId,
    portableLoopRevisionId: committed.data.revision.revisionId,
    portableLoopContentHash: hashPortableLoopPackage(exportedPackage),
    portableLoopTenantDenial: "pass",
    portableLoopRestartReadback: "pending_aggregate_restart",
  };
}

function minimalPortableLoop() {
  const input = structuredClone(portableLoopPackageExample.graph.nodes.find((node) => node.kind === "Input"));
  const output = structuredClone(portableLoopPackageExample.graph.nodes.find((node) => node.kind === "Output"));
  output.inputPorts = [{ portId: "content", name: "Content", schema: { type: "string", minLength: 1 }, required: true }];
  output.inputBindings = [{ targetPort: "content", source: { kind: "nodeOutput", nodeId: input.nodeId, portId: "topic" } }];
  return {
    ...structuredClone(portableLoopPackageExample),
    name: "Portable aggregate proof",
    graph: {
      nodes: [input, output],
      edges: [{
        edgeId: "edge-input-output",
        sourceNodeId: input.nodeId,
        sourcePort: "topic",
        targetNodeId: output.nodeId,
        targetPort: "content",
      }],
    },
    requirements: { skills: [], connections: [], materials: [] },
    embeddedMaterials: [],
  };
}

async function createLoopWithConfirmedProposal(api) {
  const created = await api.mutate("/api/workbench/v1/loops", {
    expectedStatus: 201,
    key: proofKey("create-loop"),
    body: envelope({
      name: "V1 proof meeting actions",
      description: "Turn notes into reviewed actions.",
      definition: LOOP_DEFINITION,
    }),
  });
  const workflowId = created.data.workflow.workflowId;
  const current = await api.get(`/api/workbench/v1/workflows/${workflowId}`);
  let proposed;
  try {
    proposed = await api.mutate(`/api/workbench/v1/loops/${workflowId}/proposals`, {
      expectedStatus: 201,
      key: proofKey("proposal"),
      timeoutMs: PROPOSAL_REQUEST_TIMEOUT_MS,
      ifMatch: requiredEtag(current.response),
      body: envelope({
        instruction: "Keep this workflow goal, and clarify its context as a reviewed internal meeting workflow. Propose one small definition-only change.",
      }),
    });
  } catch (error) {
    if (error instanceof ApiError && ["builder_proposal_unavailable", "builder_proposal_invalid"].includes(error.payload?.code)) {
      throw new ProofBlockedError("builder_provider_unavailable", "A live PI provider did not produce a valid Builder proposal.", {
        stage: "builder_proposal",
        freshDatabase: "pass",
        productApiChildProcess: "pass",
        twoUserWorkspaceBootstrap: "pass",
        uploadedSkillDockerValidationV1: "pass",
        secretScan: "pass",
        ...PROOF_CHECKPOINT,
        apiCode: error.payload?.code,
        requestId: error.payload?.requestId,
      });
    }
    throw error;
  }
  assert.equal(proposed.data.status, "proposed");
  const applied = await api.mutate(
    `/api/workbench/v1/loops/${workflowId}/proposals/${proposed.data.proposalId}/apply`,
    {
      key: proofKey("apply-proposal"),
      ifMatch: requiredEtag(current.response),
      body: envelope({ baseRevisionId: proposed.data.baseRevisionId }),
    },
  );
  assert.equal(applied.data.status, "applied");
  return { ...created.data, proposal: applied.data };
}

async function createPromotedPackage(api, { label, scriptSuffix }) {
  const skillMarkdown = await readFile(SKILL_FILE, "utf8");
  const script = [
    "import json, sys",
    "value = json.load(sys.stdin)",
    "print(json.dumps({'summary': value['transcript']}))",
    scriptSuffix.trimEnd(),
    "",
  ].join("\n");
  const files = [
    { path: "SKILL.md", contentBase64: Buffer.from(skillMarkdown).toString("base64") },
    { path: "scripts/main.py", contentBase64: Buffer.from(script).toString("base64") },
    {
      path: "skill.runtime.json",
      contentBase64: Buffer.from(`${JSON.stringify({
        runtime: "python3.12",
        entrypoint: "scripts/main.py",
        protocol: { stdin: "json", stdout: "json" },
        permissions: {
          network: false,
          connections: [],
          externalActions: false,
          filesystem: "scratch-only",
        },
      })}\n`).toString("base64"),
    },
  ];
  const created = await api.mutate("/api/workbench/v1/uploads", {
    expectedStatus: 201,
    key: proofKey(`upload-${label}`),
    body: envelope({
      filename: `meeting-action-${label}.zip`,
      sizeBytes: files.reduce((total, file) => total + Buffer.from(file.contentBase64, "base64").length, 0),
      mediaType: "application/zip",
      ingestMethod: "files",
    }),
  });
  const inspected = await api.mutate(`/api/workbench/v1/uploads/${created.data.uploadId}/package`, {
    key: proofKey(`inspect-${label}`),
    body: envelope({ files }),
  });
  assert.equal(inspected.data.state, "needs_decision");
  const promoted = await api.mutate(`/api/workbench/v1/uploads/${created.data.uploadId}/promote`, {
    key: proofKey(`promote-${label}`),
    body: envelope({ permissionAcknowledged: true }),
  });
  assert.equal(promoted.data.state, "promoted");
  return promoted.data;
}

async function proveSecretScan(api) {
  const syntheticSecret = "API_KEY=abcdefghijklmnopqrstuvwxyz012345";
  const markdown = `${await readFile(SKILL_FILE, "utf8")}\n${syntheticSecret}\n`;
  const created = await api.mutate("/api/workbench/v1/uploads", {
    expectedStatus: 201,
    key: proofKey("secret-upload"),
    body: envelope({
      filename: "blocked-secret-package.zip",
      sizeBytes: Buffer.byteLength(markdown),
      mediaType: "application/zip",
      ingestMethod: "files",
    }),
  });
  const inspected = await api.mutate(`/api/workbench/v1/uploads/${created.data.uploadId}/package`, {
    key: proofKey("secret-inspect"),
    body: envelope({
      files: [{ path: "SKILL.md", contentBase64: Buffer.from(markdown).toString("base64") }],
    }),
  });
  assert.equal(inspected.data.state, "failed");
  assert.ok(inspected.data.findings.some(({ code }) => code === "secret_detected"));
  return "pass";
}

async function createValidateAndPublishSkill(api, { packageUploadId, version, suffix }) {
  const created = await api.mutate("/api/workbench/v1/skills", {
    expectedStatus: 201,
    key: proofKey(`create-skill-${suffix}`),
    body: envelope({
      name: "Meeting action extractor",
      description: "Turn reviewed meeting notes into a concise action summary.",
      category: "meetings",
      uploadId: packageUploadId,
    }),
  });
  const skillId = created.data.skill.skillId;
  const draftId = created.data.draft.skillDraftId;
  const loaded = await api.get(`/api/workbench/v1/skills/${skillId}/drafts/${draftId}`);
  const etag = requiredEtag(loaded.response);
  await validateDraft(api, { skillId, draftId, etag, suffix });
  const published = await api.mutate(`/api/workbench/v1/skills/${skillId}/publish`, {
    key: proofKey(`publish-skill-${suffix}`),
    ifMatch: etag,
    body: envelope({ version, releaseNotes: `Fresh aggregate proof ${version}.` }),
  });
  assert.equal(published.data.version.version, version);
  assert.equal(Object.hasOwn(published.data.version, "packageHash"), false);
  return {
    ...created.data,
    etag,
    version: published.data.version,
    release: published.data.release,
  };
}

async function createAndPublishNextSkillVersion(api, { skillV1, packageUploadId }) {
  const created = await api.mutate(`/api/workbench/v1/skills/${skillV1.skill.skillId}/drafts`, {
    expectedStatus: 201,
    key: proofKey("create-skill-draft-v2"),
    ifMatch: skillV1.etag,
    body: envelope({ baseVersionId: skillV1.version.skillVersionId }),
  }).catch(async (error) => {
    if (!(error instanceof ApiError) || error.status !== 412) throw error;
    const current = await api.get(
      `/api/workbench/v1/skills/${skillV1.skill.skillId}/drafts/${skillV1.draft.skillDraftId}`,
    );
    return api.mutate(`/api/workbench/v1/skills/${skillV1.skill.skillId}/drafts`, {
      expectedStatus: 201,
      key: proofKey("create-skill-draft-v2-retry"),
      ifMatch: requiredEtag(current.response),
      body: envelope({ baseVersionId: skillV1.version.skillVersionId }),
    });
  });
  let etag = requiredEtag(created.response);
  const draftId = created.data.skillDraftId;
  const replaced = await api.mutate(
    `/api/workbench/v1/skills/${skillV1.skill.skillId}/drafts/${draftId}/package`,
    {
      method: "PUT",
      key: proofKey("replace-package-v2"),
      ifMatch: etag,
      body: envelope({ uploadId: packageUploadId }),
    },
  );
  etag = requiredEtag(replaced.response);
  const edited = await api.mutate(
    `/api/workbench/v1/skills/${skillV1.skill.skillId}/drafts/${draftId}`,
    {
      method: "PATCH",
      key: proofKey("edit-skill-v2"),
      ifMatch: etag,
      body: envelope({ description: "Turn meeting notes into clearer actions with owners and dates." }),
    },
  );
  etag = requiredEtag(edited.response);
  await validateDraft(api, { skillId: skillV1.skill.skillId, draftId, etag, suffix: "v2" });
  const published = await api.mutate(`/api/workbench/v1/skills/${skillV1.skill.skillId}/publish`, {
    key: proofKey("publish-skill-v2"),
    ifMatch: etag,
    body: envelope({ version: "2.0.0", releaseNotes: "Clarify owners and dates." }),
  });
  return { draft: created.data, version: published.data.version, release: published.data.release };
}

async function validateDraft(api, { skillId, draftId, etag, suffix }) {
  let tested;
  try {
    tested = await api.mutate(`/api/workbench/v1/skills/${skillId}/drafts/${draftId}/tests`, {
      expectedStatus: 202,
      key: proofKey(`skill-test-${suffix}`),
      ifMatch: etag,
      body: envelope({
        testCase: {
          name: `Aggregate proof ${suffix}`,
          purpose: "Execute the exact promoted uploaded package in the isolated runtime.",
          input: { transcript: INPUT_TEXT },
          expectedOutput: { summary: INPUT_TEXT },
          timeoutSeconds: 20,
        },
      }),
    });
  } catch (error) {
    if (error instanceof ApiError && ["skill_test_unavailable", "uploaded_skill_runtime_unavailable"].includes(error.payload?.code)) {
      throw new ProofBlockedError("docker_execution_unavailable", "The uploaded Skill could not execute in Docker.", {
        apiCode: error.payload?.code,
        requestId: error.payload?.requestId,
      });
    }
    throw error;
  }
  assert.equal(tested.data.status, "passed");
  const validation = await api.mutate(
    `/api/workbench/v1/skills/${skillId}/drafts/${draftId}/validations`,
    {
      expectedStatus: 202,
      key: proofKey(`skill-validation-${suffix}`),
      ifMatch: etag,
      body: envelope({ testRunIds: [tested.data.testRunId], permissionAcknowledged: true }),
    },
  );
  assert.equal(validation.data.status, "passed");
}

async function runWithRevision(api, { workflowId, revisionId, suffix, revise }) {
  const started = await api.mutate(`/api/workbench/v1/workflows/${workflowId}/runs`, {
    expectedStatus: 202,
    key: proofKey(`run-${suffix}`),
    body: envelope({ workflowRevisionId: revisionId, inputs: { transcript: INPUT_TEXT }, resourceRefs: [] }),
  });
  const runId = started.data.runId;
  const firstReview = await waitForRun(api, runId, (detail) => (
    detail.run.status === "waiting_review" && detail.readModel.reviewPacket
  ));
  let reviseDecisionId = null;
  if (revise) {
    const revised = await api.mutate(`/api/workbench/v1/runs/${runId}/review-decisions`, {
      key: proofKey(`review-revise-${suffix}`),
      body: envelope({
        nodeId: firstReview.readModel.reviewPacket.nodeId,
        decision: "revise",
        comment: "Make the action summary explicit.",
        requestedChanges: ["Name the owner and due date."],
      }),
    });
    reviseDecisionId = revised.data.decision.decisionId;
    await waitForRun(api, runId, (detail) => (
      detail.run.status === "waiting_review"
      && detail.run.nodeRuns.filter(({ nodeId }) => nodeId === "node-skill").length === 2
    ));
  }
  const waiting = await waitForRun(api, runId, (detail) => (
    detail.run.status === "waiting_review" && detail.readModel.reviewPacket
  ));
  const approved = await api.mutate(`/api/workbench/v1/runs/${runId}/review-decisions`, {
    key: proofKey(`review-approve-${suffix}`),
    body: envelope({
      nodeId: waiting.readModel.reviewPacket.nodeId,
      decision: "approve",
      requestedChanges: [],
    }),
  });
  const detail = await waitForRun(api, runId, (value) => value.run.status === "completed");
  assert.equal(detail.run.authoritativeReadModel.available, true);
  const events = await readTerminalEvents(api, runId);
  assertMonotonicEvents(events, runId);
  const terminal = events.at(-1);
  assert.equal(terminal.type, "run.completed");
  return {
    runId,
    reviseDecisionId,
    approveDecisionId: approved.data.decision.decisionId,
    finalSequence: terminal.sequence,
    detail,
  };
}

async function waitForRun(api, runId, predicate) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    last = (await api.get(`/api/workbench/v1/runs/${runId}`)).data;
    if (["failed", "cancelled"].includes(last.run.status)) {
      throw new Error(`run_terminated:${runId}:${JSON.stringify(last.readModel.failure)}`);
    }
    if (predicate(last)) return last;
    await delay(100);
  }
  throw new Error(`run_wait_timeout:${runId}:${JSON.stringify(last?.run?.status)}`);
}

async function readTerminalEvents(api, runId) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("sse_terminal_timeout")),
    RUN_TIMEOUT_MS,
  );
  let reader;
  let reachedTerminal = false;
  const events = [];
  try {
  const response = await fetch(`${api.origin}/api/workbench/v1/runs/${runId}/events?after=0`, {
    headers: { Cookie: api.cookie, Accept: "text/event-stream" },
      signal: controller.signal,
  });
  assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const event = parseSse(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (!event) continue;
        events.push(event);
        if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) {
          reachedTerminal = true;
          controller.abort();
          return events;
        }
      }
      if (done) break;
    }
  } catch (error) {
    if (!reachedTerminal) throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
  throw new Error(`sse_terminal_not_reached:${runId}`);
}

function parseSse(frame) {
  const lines = frame.split("\n");
  const data = [];
  let id;
  let type;
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /, "");
    if (name === "data") data.push(value);
    else if (name === "id") id = value;
    else if (name === "event") type = value;
  }
  if (data.length === 0) return null;
  const event = JSON.parse(data.join("\n"));
  assert.equal(Number(id), event.sequence);
  assert.equal(type, event.type);
  return event;
}

function assertMonotonicEvents(events, runId) {
  assert.ok(events.length > 0, "run events must be persisted");
  for (let index = 0; index < events.length; index += 1) {
    assert.equal(events[index].runId, runId);
    if (index > 0) assert.equal(events[index].sequence, events[index - 1].sequence + 1);
  }
}

async function proveRestartReadback({
  owner,
  member,
  skillV1,
  skillV2,
  workflowId,
  revisionV1Id,
  updateRevisionId,
  initialRunId,
  loopReleaseId,
  memberWorkflowId,
  skillInstallationId,
  installedSkillVersionV2Id,
  portableLoopWorkflowId,
  portableLoopRevisionId,
}) {
  const history = await owner.get(`/api/workbench/v1/skills/${skillV1.skill.skillId}/versions`);
  assert.deepEqual(history.data.map(({ version }) => version), ["2.0.0", "1.0.0"]);
  await owner.get(`/api/workbench/v1/workflows/${workflowId}/revisions/${revisionV1Id}`);
  await owner.get(`/api/workbench/v1/workflows/${workflowId}/revisions/${updateRevisionId}`);
  const run = await owner.get(`/api/workbench/v1/runs/${initialRunId}`);
  assert.equal(run.data.run.status, "completed");
  assert.equal(run.data.run.authoritativeReadModel.available, true);
  const library = await member.get("/api/workbench/v1/team-library");
  assert.ok(library.data.some(({ releaseId }) => releaseId === loopReleaseId));
  const memberWorkflow = await member.get(`/api/workbench/v1/workflows/${memberWorkflowId}`);
  assert.equal(memberWorkflow.data.workflowId, memberWorkflowId);
  const installation = await member.get(`/api/workbench/v1/installations/${skillInstallationId}`);
  assert.equal(installation.data.pinnedVersionId, installedSkillVersionV2Id);
  const portableWorkflow = await owner.get(`/api/workbench/v1/workflows/${portableLoopWorkflowId}`);
  assert.equal(portableWorkflow.data.workflowId, portableLoopWorkflowId);
  const portableRevision = await owner.get(
    `/api/workbench/v1/workflows/${portableLoopWorkflowId}/revisions/${portableLoopRevisionId}`,
  );
  assert.equal(portableRevision.data.revisionId, portableLoopRevisionId);
  assert.notEqual(skillV1.version.skillVersionId, skillV2.version.skillVersionId);
  return "pass";
}

async function proveTenantDenial(api, { skillId, workflowId, runId, releaseId }) {
  const checks = [
    [`/api/workbench/v1/skills/${skillId}/versions`, ["skill_not_found"]],
    [`/api/workbench/v1/workflows/${workflowId}`, ["workflow_not_found"]],
    [`/api/workbench/v1/runs/${runId}`, ["run_not_found", "workflow_not_found"]],
  ];
  for (const [path, codes] of checks) {
    try {
      await api.get(path);
      assert.fail(`cross-tenant read unexpectedly succeeded:${path}`);
    } catch (error) {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 404);
      assert.ok(codes.includes(error.payload.code), `${path} returned an unexpected hiding code`);
    }
  }
  const library = await api.get("/api/workbench/v1/team-library");
  assert.equal(library.data.some((release) => release.releaseId === releaseId), false);
  return "pass";
}

async function readInternalRun(runId) {
  return withMongo(async (db) => {
    const run = await db.collection("runs").findOne({ runId }, { projection: { _id: 0 } });
    assert.ok(run, `internal run missing:${runId}`);
    const nodeRuns = await db.collection("run_node_attempts")
      .find({ runId })
      .sort({ createdAt: 1, attempt: 1 })
      .project({ _id: 0 })
      .toArray();
    return {
      ...run,
      nodeRuns: nodeRuns.map((entry) => ({ ...entry, input: entry.executionInput })),
    };
  });
}

async function readInternalSkillPackageHash(skillVersionId) {
  return withMongo(async (db) => {
    const version = await db.collection("skill_versions").findOne(
      { skillVersionId },
      { projection: { _id: 0, packageHash: 1 } },
    );
    assert.match(version?.packageHash ?? "", /^sha256:[a-f0-9]{64}$/);
    return version.packageHash;
  });
}

async function readInternalHashes({
  skillVersionV1Id,
  skillVersionV2Id,
  skillReleaseV1Id,
  skillReleaseV2Id,
}) {
  return withMongo(async (db) => {
    const versions = await db.collection("skill_versions").find({
      skillVersionId: { $in: [skillVersionV1Id, skillVersionV2Id] },
    }).project({ _id: 0, skillVersionId: 1, packageHash: 1, contentHash: 1 }).toArray();
    const v1 = versions.find(({ skillVersionId }) => skillVersionId === skillVersionV1Id);
    const v2 = versions.find(({ skillVersionId }) => skillVersionId === skillVersionV2Id);
    const releases = await db.collection("workspace_asset_releases").find({
      releaseId: { $in: [skillReleaseV1Id, skillReleaseV2Id] },
    }).project({ _id: 0, releaseId: 1, contentHash: 1 }).toArray();
    const releaseV1 = releases.find(({ releaseId }) => releaseId === skillReleaseV1Id);
    const releaseV2 = releases.find(({ releaseId }) => releaseId === skillReleaseV2Id);
    assert.ok(v1?.packageHash && v2?.packageHash);
    assert.ok(releaseV1?.contentHash && releaseV2?.contentHash);
    return {
      packageV1: v1.packageHash,
      packageV2: v2.packageHash,
      contentV1: v1.contentHash,
      contentV2: v2.contentHash,
      releaseContentV1: releaseV1.contentHash,
      releaseContentV2: releaseV2.contentHash,
    };
  });
}

async function withMongo(operation) {
  const client = new MongoClient(MONGODB_URI, {
    appName: "looloomi-v1-workspace-proof-readback",
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await client.connect();
    return await operation(client.db(DATABASE_NAME));
  } finally {
    await client.close();
  }
}

async function resetTestDatabase() {
  await withMongo(async (db) => {
    const hello = await db.admin().command({ hello: 1 });
    assert.equal(hello.setName, "rs0", "proof requires the Product replica set");
    assert.equal(hello.isWritablePrimary, true, "proof requires a writable primary");
    await db.dropDatabase();
  });
}

async function assertExternalPrerequisites({ piAgentDir }) {
  if (!DOCKER_IMAGE) {
    throw new ProofBlockedError("docker_image_missing", "WORKBENCH_DOCKER_IMAGE must name a local digest-pinned image.");
  }
  if (!/^[^\s]+@sha256:[a-f0-9]{64}$/i.test(DOCKER_IMAGE)) {
    throw new ProofBlockedError("docker_image_not_digest_pinned", "WORKBENCH_DOCKER_IMAGE must use an immutable sha256 digest.", {
      image: DOCKER_IMAGE,
    });
  }
  const inspected = await runCommand("docker", ["image", "inspect", DOCKER_IMAGE]);
  if (inspected.code !== 0) {
    throw new ProofBlockedError("docker_image_unavailable", "The digest-pinned Skill image is not available to the Docker daemon.", {
      image: DOCKER_IMAGE,
      stderr: inspected.stderr.slice(-1000),
    });
  }
  const builderProvider = await inspectPiBuilderProviderReadiness({ agentDir: piAgentDir });
  if (!builderProvider.ready) {
    throw new ProofBlockedError(
      builderProvider.code,
      "An approved live PI model provider must be configured before the aggregate proof can run.",
      {
        stage: "external_prerequisites",
        providerReadiness: builderProvider.code,
        availableModelCount: builderProvider.availableModelCount,
      },
    );
  }
}

function runCommand(command, args) {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, { cwd: PACKAGE_DIRECTORY, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-10_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-10_000); });
    child.once("error", (error) => resolveCommand({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.once("exit", (code) => resolveCommand({ code: code ?? -1, stdout, stderr }));
  });
}

function meetingActionGraph(skillRef) {
  const text = { type: "string", minLength: 1, maxLength: 20000 };
  const common = (nodeId, title, description, position) => ({
    nodeId,
    title,
    description,
    position,
    reviewPolicy: { mode: "none" },
    retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
    timeoutSeconds: 60,
    display: { collapsed: false },
  });
  return {
    graph: {
      nodes: [
        { ...common("node-output", "Action summary", "Present the approved summary.", { x: 1080, y: 0 }), kind: "Output", inputPorts: [{ portId: "result", name: "Result", schema: text, required: true }], outputPorts: [{ portId: "result", name: "Result", schema: text, required: true }], inputBindings: [{ targetPort: "result", source: { kind: "nodeOutput", nodeId: "node-review", portId: "approved" } }], configuration: { format: "markdown" } },
        { ...common("node-review", "Review action summary", "Confirm before sharing.", { x: 720, y: 0 }), kind: "ReviewGate", inputPorts: [{ portId: "candidate", name: "Summary", schema: text, required: true }], outputPorts: [{ portId: "approved", name: "Approved summary", schema: text, required: true }], inputBindings: [{ targetPort: "candidate", source: { kind: "nodeOutput", nodeId: "node-skill", portId: "summary" } }], reviewPolicy: { mode: "required", instructions: "Approve, revise, or reject." }, configuration: { instructions: "Review the action summary.", allowRevision: true, revisionTarget: { nodeId: "node-skill", portId: "transcript" } } },
        { ...common("node-skill", "Extract action items", "Run the uploaded Skill.", { x: 360, y: 0 }), kind: "Skill", skillRef, inputPorts: [{ portId: "transcript", name: "Meeting notes", schema: text, required: true }], outputPorts: [{ portId: "summary", name: "Summary", schema: text, required: true }], inputBindings: [{ targetPort: "transcript", source: { kind: "nodeOutput", nodeId: "node-input", portId: "transcript" } }], configuration: {} },
        { ...common("node-input", "Meeting notes", "Notes to turn into actions.", { x: 0, y: 0 }), kind: "Input", inputPorts: [], outputPorts: [{ portId: "transcript", name: "Meeting notes", schema: text, required: true }], inputBindings: [], configuration: { fieldIds: ["transcript"] } },
      ],
      edges: [
        { edgeId: "edge-review-output", sourceNodeId: "node-review", sourcePort: "approved", targetNodeId: "node-output", targetPort: "result" },
        { edgeId: "edge-input-skill", sourceNodeId: "node-input", sourcePort: "transcript", targetNodeId: "node-skill", targetPort: "transcript" },
        { edgeId: "edge-skill-review", sourceNodeId: "node-skill", sourcePort: "summary", targetNodeId: "node-review", targetPort: "candidate" },
      ],
    },
    inputForm: { fields: [{ fieldId: "transcript", label: "Meeting notes", description: "Paste meeting notes.", schema: text, required: true }] },
    outputDefinition: { primary: { nodeId: "node-output", portId: "result" }, expectedOutputs: [{ nodeId: "node-output", portId: "result", label: "Action summary", mediaType: "text/markdown" }] },
    resourceRefs: [],
    runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 60 },
  };
}

function requiredEtag(response) {
  const etag = response.headers.get("etag");
  assert.match(etag ?? "", /^\"[^\"]+\"$/, "expected a strong entity tag");
  return etag;
}

async function reservePort() {
  const socket = net.createServer();
  socket.unref();
  await new Promise((resolveListen, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolveListen);
  });
  const address = socket.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolveClose, reject) => socket.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function startServer({ port, env }) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PACKAGE_DIRECTORY,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { child, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { state.stdout = `${state.stdout}${chunk}`.slice(-100_000); });
  child.stderr.on("data", (chunk) => { state.stderr = `${state.stderr}${chunk}`.slice(-100_000); });
  const marker = `workbench_server_ready:http://127.0.0.1:${port}`;
  try {
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error(`server_start_timeout:${serverLogs(state)}`)), SERVER_TIMEOUT_MS);
      const inspect = () => {
        if (state.stdout.includes(marker)) {
          clearTimeout(timeout);
          resolveReady();
        }
      };
      child.stdout.on("data", inspect);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`server_exited:${code}:${signal}:${serverLogs(state)}`));
      });
    });
    return state;
  } catch (error) {
    await stopServer(state).catch(() => {});
    throw error;
  }
}

async function stopServer(state) {
  const child = state?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
  child.kill("SIGTERM");
  const timeout = Symbol("timeout");
  let outcome = await Promise.race([exited, delay(5_000, timeout)]);
  if (outcome === timeout) {
    child.kill("SIGKILL");
    outcome = await exited;
  }
  if (outcome.code !== 0 && !["SIGTERM", "SIGKILL"].includes(outcome.signal)) {
    throw new Error(`server_stop_failed:${JSON.stringify(outcome)}:${serverLogs(state)}`);
  }
}

function serverLogs(state) {
  return JSON.stringify({ stdout: state.stdout, stderr: state.stderr });
}

function proofInternalDiagnostics(state) {
  const prefix = "workbench_internal_error=";
  return String(state?.stderr || "").split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => {
      try { return JSON.parse(line.slice(prefix.length)); } catch { return null; }
    })
    .filter(Boolean)
    .slice(-4);
}

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 19), `Node >=22.19.0 required; received ${process.versions.node}`);
}

function assertTemporaryRoot(root) {
  const resolved = resolve(root);
  assert.ok(resolved.startsWith(`${resolve(tmpdir())}${sep}`));
  assert.match(basename(resolved), /^looloomi-v1-workspace-proof-/);
}

async function removeTemporaryRoot(root) {
  assertTemporaryRoot(root);
  await rm(root, { recursive: true, force: true });
}

main()
  .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error) => {
    const blocked = error instanceof ProofBlockedError;
    const report = {
      status: blocked ? "blocked" : "failed",
      schemaVersion: "proof-v1-workspace-v1",
      code: error?.code ?? "proof_failed",
      message: error?.message ?? String(error),
      ...(error?.details ? { details: error.details } : {}),
      externalBlocker: blocked,
    };
    process.stderr.write(`${JSON.stringify(report)}\n`);
    if (!blocked && error?.stack) process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
