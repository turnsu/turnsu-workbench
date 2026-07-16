import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { MongoClient } from "mongodb";

const API_SCHEMA_VERSION = "workbench-api-v1";
const DATABASE_NAME = "looloomi_workbench_test";
const DEFAULT_MONGODB_URI = "mongodb://127.0.0.1:27017/?replicaSet=rs0";
const MONGODB_URI = process.env.WORKBENCH_MONGODB_URI
  ?? process.env.MONGODB_URI
  ?? DEFAULT_MONGODB_URI;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const SERVER_ENTRY = join(PACKAGE_DIRECTORY, "src", "server.mjs");
const REQUEST_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 20_000;
const SERVER_TIMEOUT_MS = 30_000;
const PROOF_TEXT = "fresh P0 HTTP first-slice proof";

class WorkbenchApi {
  constructor(origin) {
    this.origin = origin;
    this.cookie = null;
    this.csrfToken = null;
  }

  async bootstrap() {
    const result = await this.request("/api/workbench/v1/workspace");
    const setCookie = result.response.headers.getSetCookie?.()[0]
      ?? result.response.headers.get("set-cookie");
    assert.ok(setCookie, "workspace bootstrap must issue a session cookie");
    this.cookie = setCookie.split(";", 1)[0];
    this.csrfToken = result.data.session.csrfToken;
    assert.match(this.cookie, /^workbench_session=/);
    assert.ok(this.csrfToken.length >= 32, "workspace bootstrap must issue CSRF proof");
    return result.data;
  }

  get(path, expectedStatus = 200) {
    return this.request(path, { expectedStatus });
  }

  mutate(path, { body, idempotencyKey, ifMatch, expectedStatus = 200 }) {
    assert.ok(this.cookie && this.csrfToken, "workspace session must be bootstrapped");
    assert.ok(idempotencyKey, "mutation idempotency key is required");
    return this.request(path, {
      method: "POST",
      expectedStatus,
      body,
      headers: {
        Cookie: this.cookie,
        Origin: this.origin,
        "Sec-Fetch-Site": "same-origin",
        "X-Workbench-CSRF": this.csrfToken,
        "Idempotency-Key": idempotencyKey,
        ...(ifMatch ? { "If-Match": ifMatch } : {}),
      },
    });
  }

  async request(path, {
    method = "GET",
    expectedStatus = 200,
    body,
    headers = {},
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const source = await response.text();
    let payload;
    try {
      payload = JSON.parse(source);
    } catch {
      throw new Error(`non_json_response:${method}:${path}:${response.status}`);
    }
    if (response.status !== expectedStatus) {
      throw new Error(
        `unexpected_http_status:${method}:${path}:${response.status}:${JSON.stringify(payload)}`,
      );
    }
    assert.equal(payload.schemaVersion, API_SCHEMA_VERSION, `${path} schema version`);
    assert.equal(typeof payload.requestId, "string", `${path} request ID`);
    return { data: payload.data, payload, response };
  }
}

async function main() {
  assertSupportedNode();
  await resetTestDatabase();

  const runtimeRoot = await mkdtemp(join(tmpdir(), "looloomi-workbench-first-slice-"));
  assertTemporaryRuntime(runtimeRoot);
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const serverEnvironment = {
    ...process.env,
    WORKBENCH_PORT: String(port),
    WORKBENCH_TEST_MODE: "1",
    WECHAT_AGENT_TEST_MODE: "1",
    WECHAT_AGENT_RUNTIME_ROOT: runtimeRoot,
    WORKBENCH_MONGODB_URI: MONGODB_URI,
    MONGODB_URI,
    WORKBENCH_MONGODB_DB: DATABASE_NAME,
    MONGODB_DB: DATABASE_NAME,
    PI_OFFLINE: "1",
  };

  let runningServer;
  let failure;
  let result;
  try {
    runningServer = await startProductServer({ port, env: serverEnvironment });
    const api = new WorkbenchApi(origin);
    const workspace = await api.bootstrap();

    const skillList = await api.get("/api/workbench/v1/skills?status=ready");
    const listedSkill = skillList.data.find(({ skillId }) => skillId === "workflow-conformance");
    assert.ok(listedSkill, "real conformance Skill must be listed as ready");
    const skill = (await api.get(
      `/api/workbench/v1/skills/${encodeURIComponent(listedSkill.skillId)}`,
    )).data;
    assert.equal(skill.status, "ready");
    assert.equal(skill.readiness.status, "ready");
    assert.ok(
      skill.setupChecks.some(({ checkId, status }) => checkId === "runtime-probe" && status === "passed"),
      "Skill readiness must come from the PI/Core runtime probe",
    );

    const templateList = await api.get("/api/workbench/v1/templates");
    const listedTemplate = templateList.data.find(
      ({ templateId }) => templateId === "template-workflow-conformance",
    );
    assert.ok(listedTemplate, "conformance template must be listed");
    const template = (await api.get(
      `/api/workbench/v1/templates/${encodeURIComponent(listedTemplate.templateId)}`,
    )).data;
    assert.equal(template.availability.status, "available");

    const proofNonce = randomUUID();
    const key = (name) => `proof-${name}-${proofNonce}`;
    const created = await api.mutate(
      `/api/workbench/v1/templates/${encodeURIComponent(template.templateId)}/workflows`,
      {
        expectedStatus: 201,
        idempotencyKey: key("use-template"),
        body: envelope({
          templateVersion: template.templateVersion,
          name: "Wave 5 fresh first-slice proof",
        }),
      },
    );
    const workflow = created.data.workflow;
    const initialRevisionId = created.data.revision.revisionId;
    assert.equal(workflow.currentRevisionId, initialRevisionId);

    const revisionRead = await api.get(
      `/api/workbench/v1/workflows/${encodeURIComponent(workflow.workflowId)}`
      + `/revisions/${encodeURIComponent(initialRevisionId)}`,
    );
    const baseRevision = revisionRead.data;
    const baseEtag = revisionRead.response.headers.get("etag");
    assert.match(baseEtag ?? "", /^"[^"]+"$/, "revision read must return an ETag");
    const graphProof = addSecondConformanceSkill(baseRevision, skill);

    const saved = await api.mutate(
      `/api/workbench/v1/workflows/${encodeURIComponent(workflow.workflowId)}/revisions`,
      {
        expectedStatus: 201,
        idempotencyKey: key("save-revision"),
        ifMatch: baseEtag,
        body: envelope({
          baseRevisionId: baseRevision.revisionId,
          graph: graphProof.graph,
          inputForm: baseRevision.inputForm,
          outputDefinition: baseRevision.outputDefinition,
          resourceRefs: baseRevision.resourceRefs,
          runSettings: baseRevision.runSettings,
          saveReason: "Add a second conformance Skill for the fresh HTTP vertical proof.",
        }),
      },
    );
    const revision = saved.data.revision;
    assert.notEqual(revision.revisionId, baseRevision.revisionId);
    assert.equal(revision.baseRevisionId, baseRevision.revisionId);
    assert.equal(revision.revisionNumber, baseRevision.revisionNumber + 1);
    assert.equal(saved.data.workflow.currentRevisionId, revision.revisionId);
    assert.match(saved.response.headers.get("etag") ?? "", /^"[^"]+"$/);

    const compiled = await api.mutate(
      `/api/workbench/v1/workflows/${encodeURIComponent(workflow.workflowId)}/compile`,
      {
        idempotencyKey: key("compile"),
        body: envelope({ workflowRevisionId: revision.revisionId }),
      },
    );
    const compile = compiled.data;
    assert.equal(compile.status, "ready");
    assert.deepEqual(compile.orderedSteps, graphProof.edgeTopology);
    assert.deepEqual(
      compile.executionPlan.steps.map(({ nodeId }) => nodeId),
      graphProof.edgeTopology,
    );
    assert.notDeepEqual(
      revision.graph.nodes.map(({ nodeId }) => nodeId),
      graphProof.edgeTopology,
      "node array order must not be execution authority",
    );
    assert.deepEqual(
      stepFor(compile, graphProof.secondSkillNodeId).dependsOn,
      [graphProof.firstSkillNodeId],
    );
    assert.deepEqual(
      stepFor(compile, graphProof.reviewNodeId).dependsOn,
      [graphProof.secondSkillNodeId],
    );

    const firstRun = await api.mutate(
      `/api/workbench/v1/workflows/${encodeURIComponent(workflow.workflowId)}/runs`,
      {
        expectedStatus: 202,
        idempotencyKey: key("run"),
        body: envelope({
          workflowRevisionId: revision.revisionId,
          inputs: { text: PROOF_TEXT },
          resourceRefs: [],
        }),
      },
    );
    assert.equal(firstRun.data.workflowRevisionId, revision.revisionId);
    const firstOutcome = await approveAndCompleteRun({
      api,
      runId: firstRun.data.runId,
      reviewNodeId: graphProof.reviewNodeId,
      expectedTopology: graphProof.edgeTopology,
      expectedFinalAnswer: PROOF_TEXT,
      reviewKey: key("review"),
      proveRecovery: true,
    });
    const firstAgentFinal = await readInternalAgentFinal(firstRun.data.runId);
    assert.equal(firstAgentFinal.schemaVersion, "agent-final-read-model-v1");
    assert.equal(firstAgentFinal.runID, firstRun.data.runId);
    assert.equal(firstAgentFinal.finalText, PROOF_TEXT);

    await stopProductServer(runningServer);
    runningServer = undefined;
    runningServer = await startProductServer({ port, env: serverEnvironment });
    const restartedApi = new WorkbenchApi(origin);
    const restartedWorkspace = await restartedApi.bootstrap();
    assert.equal(restartedWorkspace.workspace.workspaceId, workspace.workspace.workspaceId);

    const restartedRun = (await restartedApi.get(
      `/api/workbench/v1/runs/${encodeURIComponent(firstRun.data.runId)}`,
    )).data;
    assertCompletedReadModel(restartedRun, {
      revisionId: revision.revisionId,
      expectedFinalAnswer: PROOF_TEXT,
      reviewId: firstOutcome.reviewId,
    });
    assert.deepEqual(await readInternalAgentFinal(firstRun.data.runId), firstAgentFinal);
    const restartedHistory = await restartedApi.get(
      `/api/workbench/v1/workflows/${encodeURIComponent(workflow.workflowId)}/runs`,
    );
    assert.ok(
      restartedHistory.data.some(({ runId }) => runId === firstRun.data.runId),
      "completed Run must survive Product server restart",
    );

    const rerun = await restartedApi.mutate(
      `/api/workbench/v1/workflows/${encodeURIComponent(workflow.workflowId)}/runs`,
      {
        expectedStatus: 202,
        idempotencyKey: key("rerun"),
        body: envelope({
          workflowRevisionId: revision.revisionId,
          inputs: { text: PROOF_TEXT },
          resourceRefs: [],
        }),
      },
    );
    assert.notEqual(rerun.data.runId, firstRun.data.runId);
    assert.equal(rerun.data.workflowRevisionId, revision.revisionId);
    const rerunOutcome = await approveAndCompleteRun({
      api: restartedApi,
      runId: rerun.data.runId,
      reviewNodeId: graphProof.reviewNodeId,
      expectedTopology: graphProof.edgeTopology,
      expectedFinalAnswer: PROOF_TEXT,
      reviewKey: key("rerun-review"),
      proveRecovery: false,
    });
    const finalHistory = await restartedApi.get(
      `/api/workbench/v1/workflows/${encodeURIComponent(workflow.workflowId)}/runs`,
    );
    assert.deepEqual(
      new Set(finalHistory.data.map(({ runId }) => runId)),
      new Set([firstRun.data.runId, rerun.data.runId]),
    );

    result = {
      schemaVersion: "workbench-first-slice-proof-v1",
      skillId: skill.skillId,
      templateId: template.templateId,
      workflowId: workflow.workflowId,
      revisionId: revision.revisionId,
      compileId: compile.executionPlan.contentHash,
      runId: firstRun.data.runId,
      reviewId: firstOutcome.reviewId,
      rerunId: rerun.data.runId,
      rerunReviewId: rerunOutcome.reviewId,
      runLastSequence: firstOutcome.lastSequence,
      lastSequence: rerunOutcome.lastSequence,
      finalAnswer: rerunOutcome.completed.readModel.finalAnswer.content,
      databaseReset: "pass",
      runtimeIsolation: "pass",
      edgeTopology: "pass",
      sseRecovery: "pass",
      authoritativeFinalReadModel: "pass",
      restartReadback: "pass",
      sameRevisionRerun: "pass",
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      await stopProductServer(runningServer);
    } catch (error) {
      failure ??= error;
    }
    try {
      await removeTemporaryRuntime(runtimeRoot);
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure) throw failure;
  return result;
}

function envelope(data) {
  return { schemaVersion: API_SCHEMA_VERSION, data };
}

function addSecondConformanceSkill(revision, skill) {
  const graph = structuredClone(revision.graph);
  const skillNodes = graph.nodes.filter(({ kind }) => kind === "Skill");
  const reviewNodes = graph.nodes.filter(({ kind }) => kind === "ReviewGate");
  const inputNodes = graph.nodes.filter(({ kind }) => kind === "Input");
  const outputNodes = graph.nodes.filter(({ kind }) => kind === "Output");
  assert.equal(skillNodes.length, 1, "template must begin with one conformance Skill");
  assert.equal(reviewNodes.length, 1, "template must contain one ReviewGate");
  assert.equal(inputNodes.length, 1, "template must contain one Input");
  assert.equal(outputNodes.length, 1, "template must contain one Output");

  const [firstSkill] = skillNodes;
  const [review] = reviewNodes;
  assert.equal(firstSkill.skillRef.skillId, skill.skillId);
  assert.equal(firstSkill.skillRef.version, skill.version);
  const replacedEdge = graph.edges.find(
    ({ sourceNodeId, targetNodeId }) => (
      sourceNodeId === firstSkill.nodeId && targetNodeId === review.nodeId
    ),
  );
  assert.ok(replacedEdge, "template Skill must feed ReviewGate through an edge");

  const secondSkill = structuredClone(firstSkill);
  secondSkill.nodeId = "node-skill-second";
  assert.ok(!graph.nodes.some(({ nodeId }) => nodeId === secondSkill.nodeId));
  secondSkill.title = "Echo text again";
  secondSkill.description = "Run the same pinned conformance Skill a second time.";
  secondSkill.position = {
    x: (firstSkill.position.x + review.position.x) / 2,
    y: firstSkill.position.y + 80,
  };
  const secondInputPort = secondSkill.inputPorts.find(({ portId }) => portId === "text");
  const secondOutputPort = secondSkill.outputPorts.find(
    ({ portId }) => portId === replacedEdge.sourcePort,
  );
  assert.ok(secondInputPort && secondOutputPort, "conformance Skill ports must be present");
  secondSkill.inputBindings = [{
    targetPort: secondInputPort.portId,
    source: {
      kind: "nodeOutput",
      nodeId: firstSkill.nodeId,
      portId: replacedEdge.sourcePort,
    },
  }];

  const reviewBinding = review.inputBindings.find(
    ({ targetPort }) => targetPort === replacedEdge.targetPort,
  );
  assert.ok(reviewBinding, "ReviewGate binding must match its incoming edge");
  reviewBinding.source = {
    kind: "nodeOutput",
    nodeId: secondSkill.nodeId,
    portId: secondOutputPort.portId,
  };
  graph.edges = graph.edges.filter(({ edgeId }) => edgeId !== replacedEdge.edgeId);
  graph.edges.push(
    {
      edgeId: "edge-skill-first-second",
      sourceNodeId: firstSkill.nodeId,
      sourcePort: replacedEdge.sourcePort,
      targetNodeId: secondSkill.nodeId,
      targetPort: secondInputPort.portId,
    },
    {
      edgeId: "edge-skill-second-review",
      sourceNodeId: secondSkill.nodeId,
      sourcePort: secondOutputPort.portId,
      targetNodeId: review.nodeId,
      targetPort: replacedEdge.targetPort,
    },
  );

  graph.nodes.push(secondSkill);
  graph.nodes.reverse();
  return {
    graph,
    firstSkillNodeId: firstSkill.nodeId,
    secondSkillNodeId: secondSkill.nodeId,
    reviewNodeId: review.nodeId,
    edgeTopology: [
      inputNodes[0].nodeId,
      firstSkill.nodeId,
      secondSkill.nodeId,
      review.nodeId,
      outputNodes[0].nodeId,
    ],
  };
}

function stepFor(compile, nodeId) {
  const step = compile.executionPlan.steps.find((candidate) => candidate.nodeId === nodeId);
  assert.ok(step, `execution plan step missing:${nodeId}`);
  return step;
}

async function approveAndCompleteRun({
  api,
  runId,
  reviewNodeId,
  expectedTopology,
  expectedFinalAnswer,
  reviewKey,
  proveRecovery,
}) {
  let events = [];
  if (proveRecovery) {
    const initial = await readSse(api, runId, {
      after: 0,
      until: (_event, received) => received.length === 1,
    });
    assert.equal(initial[0].sequence, 1);
    const recovered = await readSse(api, runId, {
      lastEventId: initial.at(-1).sequence,
      until: (event) => event.type === "review.requested",
    });
    assert.equal(recovered[0].sequence, initial.at(-1).sequence + 1);
    events = [...initial, ...recovered];
  } else {
    events = await readSse(api, runId, {
      after: 0,
      until: (event) => event.type === "review.requested",
    });
  }
  assert.equal(events.at(-1).type, "review.requested");
  assert.equal(events.at(-1).nodeId, reviewNodeId);

  const waiting = await waitForRun(api, runId, ({ run }) => (
    run.status === "waiting_review" && run.currentNodeId === reviewNodeId
  ));
  assert.equal(waiting.readModel.reviewPacket.nodeId, reviewNodeId);
  const decision = await api.mutate(
    `/api/workbench/v1/runs/${encodeURIComponent(runId)}/review-decisions`,
    {
      idempotencyKey: reviewKey,
      body: envelope({
        nodeId: reviewNodeId,
        decision: "approve",
        comment: "Approve the fresh P0 HTTP proof.",
        requestedChanges: [],
      }),
    },
  );
  assert.equal(decision.data.decision.decision, "approve");
  assert.equal(decision.data.decision.runId, runId);

  const tail = await readSse(api, runId, {
    after: events.at(-1).sequence,
    until: (event) => event.type === "run.completed",
  });
  assert.equal(tail[0].sequence, events.at(-1).sequence + 1);
  events.push(...tail);
  assertRunEvents(events, { runId, expectedTopology });

  const completed = await waitForRun(api, runId, ({ run, readModel }) => (
    run.status === "completed"
    && run.authoritativeReadModel.available === true
    && readModel.status === "completed"
    && Boolean(readModel.finalAnswer?.content)
  ));
  assertCompletedReadModel(completed, {
    revisionId: completed.run.workflowRevisionId,
    expectedFinalAnswer,
    reviewId: decision.data.decision.decisionId,
  });
  return {
    completed,
    reviewId: decision.data.decision.decisionId,
    lastSequence: events.at(-1).sequence,
  };
}

function assertRunEvents(events, { runId, expectedTopology }) {
  assert.deepEqual(
    events.map(({ sequence }) => sequence),
    Array.from({ length: events.length }, (_value, index) => index + 1),
  );
  assert.equal(new Set(events.map(({ eventId }) => eventId)).size, events.length);
  assert.ok(events.every((event) => event.runId === runId));
  assert.equal(events[0].type, "run.queued");
  assert.equal(events.at(-1).type, "run.completed");
  assert.deepEqual(
    events.filter(({ type }) => type === "node.started").map(({ nodeId }) => nodeId),
    expectedTopology,
  );
}

function assertCompletedReadModel(detail, { revisionId, expectedFinalAnswer, reviewId }) {
  assert.equal(detail.run.workflowRevisionId, revisionId);
  assert.equal(detail.run.status, "completed");
  assert.equal(detail.run.authoritativeReadModel.available, true);
  assert.equal(detail.run.authoritativeReadModel.version, 1);
  assert.equal(detail.readModel.status, "completed");
  assert.equal(detail.readModel.finalAnswer.content, expectedFinalAnswer);
  assert.equal(detail.readModel.failure, null);
  assert.ok(
    detail.readModel.reviewDecisions.some(({ decisionId }) => decisionId === reviewId),
    "authoritative read model must include the persisted review decision",
  );
}

async function waitForRun(api, runId, predicate) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let lastDetail;
  while (Date.now() < deadline) {
    lastDetail = (await api.get(
      `/api/workbench/v1/runs/${encodeURIComponent(runId)}`,
    )).data;
    if (predicate(lastDetail)) return lastDetail;
    if (["failed", "cancelled"].includes(lastDetail.run.status)) {
      throw new Error(`run_terminated:${runId}:${JSON.stringify(lastDetail.readModel.failure)}`);
    }
    await delay(25);
  }
  throw new Error(`run_wait_timeout:${runId}:${lastDetail?.run?.status ?? "unknown"}`);
}

async function readSse(api, runId, { after, lastEventId, until }) {
  assert.equal(typeof until, "function");
  assert.ok(after !== undefined || lastEventId !== undefined);
  const query = after === undefined ? "" : `?after=${after}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("sse_timeout")), RUN_TIMEOUT_MS);
  let reader;
  let matched = false;
  const events = [];
  try {
    const response = await fetch(
      `${api.origin}/api/workbench/v1/runs/${encodeURIComponent(runId)}/events${query}`,
      {
        headers: {
          Accept: "text/event-stream",
          ...(api.cookie ? { Cookie: api.cookie } : {}),
          ...(lastEventId === undefined
            ? {}
            : { "Last-Event-ID": String(lastEventId) }),
        },
        signal: controller.signal,
      },
    );
    if (response.status !== 200) {
      throw new Error(`sse_http_status:${response.status}:${await response.text()}`);
    }
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseFrame(frame);
        if (!event) continue;
        events.push(event);
        if (until(event, events)) {
          matched = true;
          controller.abort();
          return events;
        }
      }
      if (done) break;
    }
  } catch (error) {
    if (!matched) throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
  throw new Error(`sse_predicate_not_reached:${runId}`);
}

function parseSseFrame(frame) {
  if (!frame.trim()) return null;
  const fields = new Map();
  const data = [];
  for (const line of frame.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /, "");
    if (name === "data") data.push(value);
    else fields.set(name, value);
  }
  assert.ok(data.length > 0, "SSE event data is required");
  const event = JSON.parse(data.join("\n"));
  assert.equal(Number(fields.get("id")), event.sequence);
  assert.equal(fields.get("event"), event.type);
  return event;
}

async function resetTestDatabase() {
  assert.equal(DATABASE_NAME, "looloomi_workbench_test");
  const client = new MongoClient(MONGODB_URI, {
    appName: "looloomi-workbench-first-slice-proof",
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await client.connect();
    const hello = await client.db(DATABASE_NAME).admin().command({ hello: 1 });
    assert.equal(hello.setName, "rs0", "fresh proof requires the Product replica set");
    assert.equal(hello.isWritablePrimary, true, "fresh proof requires a writable primary");
    await client.db(DATABASE_NAME).dropDatabase();
  } finally {
    await client.close();
  }
}

async function readInternalAgentFinal(runId) {
  const client = new MongoClient(MONGODB_URI, {
    appName: "looloomi-workbench-first-slice-proof-readback",
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await client.connect();
    const run = await client.db(DATABASE_NAME).collection("runs").findOne(
      { runId },
      { projection: { _id: 0, agentFinalReadModel: 1 } },
    );
    assert.ok(run?.agentFinalReadModel, "Agent final read model must be persisted internally");
    return run.agentFinalReadModel;
  } finally {
    await client.close();
  }
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
  await new Promise((resolveClose, reject) => {
    socket.close((error) => error ? reject(error) : resolveClose());
  });
  return address.port;
}

async function startProductServer({ port, env }) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PACKAGE_DIRECTORY,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { child, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    state.stdout = boundedLog(state.stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    state.stderr = boundedLog(state.stderr, chunk);
  });
  const marker = `workbench_server_ready:http://127.0.0.1:${port}`;
  try {
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`product_server_start_timeout:${serverLogs(state)}`)),
        SERVER_TIMEOUT_MS,
      );
      const inspect = () => {
        if (state.stdout.includes(marker)) {
          clearTimeout(timeout);
          resolveReady();
        }
      };
      child.stdout.on("data", inspect);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(
          `product_server_exited_before_ready:${code}:${signal}:${serverLogs(state)}`,
        ));
      });
    });
    return state;
  } catch (error) {
    await stopProductServer(state).catch(() => {});
    throw error;
  }
}

async function stopProductServer(state) {
  const child = state?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  child.kill("SIGTERM");
  const timeout = Symbol("timeout");
  let outcome = await Promise.race([exited, delay(5_000, timeout)]);
  if (outcome === timeout) {
    child.kill("SIGKILL");
    outcome = await exited;
  }
  if (outcome.code !== 0 && !["SIGTERM", "SIGKILL"].includes(outcome.signal)) {
    throw new Error(
      `product_server_stop_failed:${outcome.code}:${outcome.signal}:${serverLogs(state)}`,
    );
  }
}

function boundedLog(current, chunk) {
  return `${current}${String(chunk)}`.slice(-100_000);
}

function serverLogs(state) {
  return JSON.stringify({ stdout: state.stdout, stderr: state.stderr });
}

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.ok(
    major > 22 || (major === 22 && minor >= 19),
    `Node >=22.19.0 required, received ${process.versions.node}`,
  );
}

function assertTemporaryRuntime(runtimeRoot) {
  const resolvedRoot = resolve(runtimeRoot);
  const resolvedTemporaryRoot = resolve(tmpdir());
  assert.ok(resolvedRoot.startsWith(`${resolvedTemporaryRoot}${sep}`));
  assert.match(basename(resolvedRoot), /^looloomi-workbench-first-slice-/);
}

async function removeTemporaryRuntime(runtimeRoot) {
  assertTemporaryRuntime(runtimeRoot);
  await rm(runtimeRoot, { recursive: true, force: true });
}

main()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
