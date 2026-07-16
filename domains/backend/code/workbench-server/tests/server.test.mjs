import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_WORKBENCH_PORT,
  createWorkbenchComposition,
  createWorkbenchServer,
} from "../src/server.mjs";
import { LoopbackRemoteWorkerTransport } from "../src/execution/index.mjs";

test("the Product server uses the frozen local port", () => {
  assert.equal(DEFAULT_WORKBENCH_PORT, 8798);
});

test("the aggregate proof keeps revise, restart, and compile-plan evidence executable", async () => {
  const proof = await readFile(new URL("../scripts/proof-v1-workspace.mjs", import.meta.url), "utf8");
  assert.match(proof, /revisionTarget:\s*\{\s*nodeId:\s*"node-skill",\s*portId:\s*"transcript"\s*\}/);
  assert.match(proof, /compilePlan:\s*compileV1\.data\.executionPlan/);
  assert.match(proof, /portableLoopRestartReadback:\s*"pass"/);
  assert.match(proof, /workflows\/\$\{portableLoopWorkflowId\}\/revisions\/\$\{portableLoopRevisionId\}/);
});

test("the aggregate proof lets the bounded Builder model request finish before its client timeout", async () => {
  const proof = await readFile(new URL("../scripts/proof-v1-workspace.mjs", import.meta.url), "utf8");
  assert.match(proof, /const PROPOSAL_REQUEST_TIMEOUT_MS = 45_000;/);
  assert.match(proof, /proofKey\("proposal"\)[\s\S]*timeoutMs:\s*PROPOSAL_REQUEST_TIMEOUT_MS/);
  assert.match(proof, /workbench_internal_error=/);
  assert.match(proof, /internalDiagnostics/);
  assert.match(proof, /baseRevisionId:\s*currentAfterProposal\.data\.currentRevisionId/);
  assert.doesNotMatch(proof, /currentAfterProposal\.data\.revision\.revisionId/);
  assert.match(proof, /server = await startServer\(\{ port, env: serverEnv \}\);[\s\S]*owner = new WorkbenchApi[\s\S]*await owner\.bootstrap\(\)/);
  assert.match(proof, /member = new WorkbenchApi[\s\S]*await member\.bootstrap\(\)/);
  assert.match(proof, /isolated = new WorkbenchApi[\s\S]*await isolated\.bootstrap\(\)/);
  assert.match(proof, /memberWorkflow\.data\.workflowId/);
  assert.match(proof, /portableWorkflow\.data\.workflowId/);
  assert.match(proof, /portableRevision\.data\.revisionId/);
  assert.doesNotMatch(proof, /memberWorkflow\.data\.workflow\.workflowId/);
  assert.doesNotMatch(proof, /portableWorkflow\.data\.workflow\.workflowId/);
  assert.doesNotMatch(proof, /portableRevision\.data\.revision\.revisionId/);
  assert.match(proof, /\["run_not_found", "workflow_not_found"\]/);
});

test("the Product server forwards the isolated uploaded-Skill execution root", async () => {
  const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(serverSource, /executionRoot:\s*env\.WORKBENCH_EXECUTION_ROOT/);
  assert.match(serverSource, /tempRoot:\s*executionRoot/);
});

test("composition injects one execution resolver into a real Runner", () => {
  const store = {
    async connect() {},
    repositories: {
      workflowRevisions: {},
      compileResults: {},
      skills: {},
      runJobs: {
        async insert() {},
        async list() { return []; },
        async listRecoverable() { return []; },
        async claimByRun() { return null; },
        async finishByRun() { return null; },
        async requeueByRun() { return null; },
        async abandonClaimByRun() { return null; },
        async cancelByRun() { return null; },
        async heartbeatByRun() { return null; },
        async nextCheckpointSequence() { return null; },
      },
      runLeases: { async acquire() {}, async heartbeat() {}, async release() {}, async cancelByRun() {} },
      runCheckpoints: { async insert() {} },
    },
    async runIdempotentMutation() {},
    async appendRunEvent() {},
  };
  const agentRuntime = {
    async probeSkill() {},
    async invokeSkillNode() {},
    async buildAuthoritativeFinal() {},
  };
  const composed = createWorkbenchComposition({
    store,
    agentRuntime,
    clock: () => "2026-07-10T00:00:00.000Z",
    idFactory: (kind) => `${kind}-test`,
  });
  assert.equal(composed.store, store);
  assert.equal(composed.agentRuntime, agentRuntime);
  assert.equal(typeof composed.runner.startRun, "function");
  assert.equal(typeof composed.application.compileWorkflow, "function");
  assert.equal(typeof composed.agentExecutor.execute, "function");
});

test("composition allows a Mongo-style store to bind Runner repositories during server readiness", () => {
  const store = {
    async connect() {},
    repositories: null,
    async runIdempotentMutation() {},
    async appendRunEvent() {},
  };
  const agentRuntime = {
    async probeSkill() {},
    async invokeSkillNode() {},
    async buildAuthoritativeFinal() {},
  };

  const composed = createWorkbenchComposition({
    store,
    agentRuntime,
    clock: () => "2026-07-11T00:00:00.000Z",
    idFactory: (kind) => `${kind}-lazy-store`,
  });

  assert.equal(typeof composed.runner.startRun, "function");
});

test("composition registers one shared Agent sandbox for bounded and orchestrator container modes", () => {
  const registrations = [];
  const executionBroker = {
    registerBackend(registration) { registrations.push(registration); return () => {}; },
  };
  const store = { async connect() {} };
  const agentRuntime = { async probeSkill() {} };
  const agentSandbox = { async run() {}, async scavenge() {} };
  const composed = createWorkbenchComposition({
    store,
    agentRuntime,
    executionBroker,
    agentSandbox,
    agentTurnRunner: {},
    memoryService: {},
    runner: {},
  });
  assert.equal(composed.agentSandbox, agentSandbox);
  assert.deepEqual(registrations.map(({ mode, isolation }) => ({ mode, isolation })), [
    { mode: "bounded_agent", isolation: "container" },
    { mode: "agent_orchestrator", isolation: "container" },
  ]);
  assert.ok(registrations.every(({ backend }) => typeof backend.execute === "function"));
});

test("composition registers an injected Remote transport internally for every compiled execution mode", () => {
  const registrations = [];
  const executionBroker = {
    registerBackend(registration) { registrations.push(registration); return () => {}; },
  };
  const remoteTransport = new LoopbackRemoteWorkerTransport();
  const composed = createWorkbenchComposition({
    store: { async connect() {} },
    agentRuntime: { async probeSkill() {} },
    executionBroker,
    remoteTransport,
    agentTurnRunner: {},
    memoryService: {},
    runner: {},
  });
  assert.equal(composed.remoteTransport, remoteTransport);
  assert.deepEqual(registrations.map(({ mode, isolation }) => ({ mode, isolation })), [
    { mode: "deterministic_skill", isolation: "remote" },
    { mode: "bounded_agent", isolation: "remote" },
    { mode: "agent_orchestrator", isolation: "remote" },
  ]);
  assert.equal(new Set(registrations.map(({ backend }) => backend)).size, 1);
});

test("server readiness recovers durable RunJobs before serving requests", async (t) => {
  let recoverCalls = 0;
  const composed = createWorkbenchServer({
    application: {},
    runner: { async recover() { recoverCalls += 1; return { recoveredRunIds: [] }; } },
    bootstrapCatalog: false,
    distDirectory: null,
    httpHandler: async (_req, res) => { res.writeHead(204); res.end(); },
  });
  t.after(() => composed.server.close());
  await composed.ready;
  assert.equal(recoverCalls, 1);
});

test("server readiness scavenges owned Skill containers before recovering durable RunJobs", async (t) => {
  const order = [];
  const composed = createWorkbenchServer({
    application: {},
    runner: { async recover() { order.push("runner"); return { recoveredRunIds: [] }; } },
    startupRecovery: async () => { order.push("docker"); },
    bootstrapCatalog: false,
    distDirectory: null,
    httpHandler: async (_req, res) => { res.writeHead(204); res.end(); },
  });
  t.after(() => composed.server.close());
  await composed.ready;
  assert.deepEqual(order, ["docker", "runner"]);
});

test("server readiness scavenges the Agent sandbox before Runner recovery", async (t) => {
  const order = [];
  const composed = createWorkbenchServer({
    application: {},
    agentSandbox: { async scavenge() { order.push("agent-sandbox"); } },
    runner: { async recover() { order.push("runner"); return { recoveredRunIds: [] }; } },
    bootstrapCatalog: false,
    distDirectory: null,
    httpHandler: async (_req, res) => { res.writeHead(204); res.end(); },
  });
  t.after(() => composed.server.close());
  await composed.ready;
  assert.deepEqual(order, ["agent-sandbox", "runner"]);
});

test("an injected application can host API tests without constructing runtime dependencies", async (t) => {
  const application = {};
  const composed = createWorkbenchServer({
    application,
    bootstrapCatalog: false,
    distDirectory: null,
    httpHandler: async (_req, res) => {
      res.writeHead(204);
      res.end();
    },
  });
  t.after(() => composed.server.close());
  assert.equal(composed.application, application);
  await composed.ready;
});
