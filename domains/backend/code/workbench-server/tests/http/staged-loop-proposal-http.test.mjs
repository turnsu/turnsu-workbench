import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  Check,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS,
} from "@looloomi/workbench-contracts";

import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";
import { WorkbenchSessionStore } from "../../src/security/workbench-session-store.mjs";
import { makeRevision } from "../compiler/fixtures.mjs";

const NOW = "2026-07-13T08:00:00.000Z";
const ORIGIN = "http://127.0.0.1";
const WORKFLOW_ID = "workflow-builder-http";
const REVISION_ID = "revision-builder-http-1";
const PROPOSAL_ID = "proposal-builder-http-1";

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.status = null;
    this.headers = {};
    this.body = "";
  }

  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
  }

  write(value) { this.body += value; }

  end(value = "") { this.body += value; this.emit("finish"); }
}

function makeRequest({ method = "GET", url, headers = {}, body } = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.url = url;
  request.headers = {
    host: "127.0.0.1",
    ...Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    ),
  };
  request[Symbol.asyncIterator] = async function* iterator() {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body));
  };
  return request;
}

async function invoke(handler, options) {
  const response = new MockResponse();
  await handler(makeRequest(options), response);
  return response;
}

function stagedProposal({ status = "proposed", decidedAt = null } = {}) {
  const revision = makeRevision();
  const definition = revision.definition ?? {
    goal: "Implement M5.",
    context: "Use the approved rebuild document.",
    constraints: [],
    doneWhen: ["QA is green."],
    verify: ["Run the M5 smoke suite."],
    expectedResult: "A reviewed implementation.",
    stopRules: [],
  };
  return {
    schemaVersion: "workbench-v1",
    kind: "staged_loop_draft",
    proposalId: PROPOSAL_ID,
    workspaceId: "workspace-local",
    summary: "Create a reviewable Loop outline.",
    draft: {
      name: "M5 implementation",
      description: "Implement the approved M5 design.",
      definition,
      graph: revision.graph,
      inputForm: revision.inputForm,
      outputDefinition: revision.outputDefinition,
      resourceRefs: revision.resourceRefs,
      runSettings: revision.runSettings,
    },
    operations: [],
    diagnostics: [],
    permissionImpact: [],
    status,
    createdBy: "user-local",
    createdAt: NOW,
    expiresAt: "2026-07-14T08:00:00.000Z",
    decidedAt,
  };
}

function setup(application) {
  const sessionStore = new WorkbenchSessionStore({
    clock: () => new Date(NOW),
    tokenFactory: () => "builder-http-session-token",
    csrfTokenFactory: () => "builder-http-csrf-token-abcdefghijklmnopqrstuvwxyz",
  });
  const session = sessionStore.issue();
  return {
    session,
    handler: createWorkbenchHttpHandler({
      application,
      sessionStore,
      origin: ORIGIN,
      requestIdFactory: () => "request-builder-http-1",
    }),
  };
}

function mutationHeaders(session, idempotencyKey = "builder-http-idempotency-1") {
  return {
    Cookie: `workbench_session=${session.token}`,
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "X-Workbench-CSRF": session.csrfToken,
    "Content-Type": "application/json",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

test("staged Loop proposal routes remain contract-valid without a canonical workflow", async () => {
  const calls = [];
  const staged = stagedProposal();
  const revision = { ...makeRevision(), revisionId: REVISION_ID, workflowId: WORKFLOW_ID };
  const workflow = {
    schemaVersion: "workbench-v1",
    workflowId: WORKFLOW_ID,
    workspaceId: "workspace-local",
    name: staged.draft.name,
    description: staged.draft.description,
    status: "draft",
    archived: false,
    ownerId: "user-local",
    visibility: "private",
    lifecycle: "draft",
    currentRevisionId: REVISION_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const application = {
    async generateStagedLoopProposal(input) {
      calls.push({ operation: "generate", input });
      return staged;
    },
    async getStagedLoopProposal(input) {
      calls.push({ operation: "get", input });
      return staged;
    },
    async commitStagedLoopProposal(input) {
      calls.push({ operation: "commit", input });
      return {
        data: {
          workflow,
          revision,
          proposal: stagedProposal({ status: "applied", decidedAt: NOW }),
        },
        etag: '"wfv1:workflow-builder-http:1:revision-builder-http-1"',
      };
    },
    async dismissStagedLoopProposal(input) {
      calls.push({ operation: "dismiss", input });
      return stagedProposal({ status: "dismissed", decidedAt: NOW });
    },
  };
  const { handler, session } = setup(application);

  const generated = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/loop-draft-proposals",
    headers: mutationHeaders(session, "staged-generate-1"),
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        name: staged.draft.name,
        sourceText: "Implement M5 from the approved document.",
        definition: staged.draft.definition,
      },
    },
  });
  assert.equal(generated.status, 201, generated.body);
  assert.equal(
    Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.generateStagedLoopProposal.responseBodySchema, JSON.parse(generated.body)),
    true,
  );

  const recovered = await invoke(handler, {
    url: `/api/workbench/v1/loop-draft-proposals/${PROPOSAL_ID}`,
    headers: { Cookie: `workbench_session=${session.token}` },
  });
  assert.equal(recovered.status, 200, recovered.body);
  assert.equal(
    Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getStagedLoopProposal.responseBodySchema, JSON.parse(recovered.body)),
    true,
  );

  const committed = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/loop-draft-proposals/${PROPOSAL_ID}/commit`,
    headers: mutationHeaders(session, "staged-commit-1"),
    body: { schemaVersion: "workbench-api-v1", data: { draft: staged.draft } },
  });
  assert.equal(committed.status, 201, committed.body);
  assert.equal(
    Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.commitStagedLoopProposal.responseBodySchema, JSON.parse(committed.body)),
    true,
  );

  const dismissed = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/loop-draft-proposals/${PROPOSAL_ID}/dismiss`,
    headers: mutationHeaders(session, "staged-dismiss-1"),
    body: { schemaVersion: "workbench-api-v1", data: {} },
  });
  assert.equal(dismissed.status, 200, dismissed.body);
  assert.deepEqual(calls.map(({ operation }) => operation), ["generate", "get", "commit", "dismiss"]);
  assert.equal(calls[0].input.workflowId, undefined);
});

test("retired saved-Workflow proposal routes are absent and never dispatch", async () => {
  let dispatchCount = 0;
  const application = new Proxy({}, {
    get() {
      return () => { dispatchCount += 1; };
    },
  });
  const { handler, session } = setup(application);
  const routes = [
    { method: "POST", path: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals` },
    { method: "GET", path: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals/${PROPOSAL_ID}` },
    { method: "POST", path: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals/${PROPOSAL_ID}/apply` },
    { method: "POST", path: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals/${PROPOSAL_ID}/dismiss` },
  ];
  for (const route of routes) {
    const response = await invoke(handler, {
      method: route.method,
      url: route.path,
      headers: route.method === "GET"
        ? { Cookie: `workbench_session=${session.token}` }
        : mutationHeaders(session),
      body: route.method === "GET" ? undefined : { schemaVersion: "workbench-api-v1", data: {} },
    });
    assert.equal(response.status, 404, route.path);
    assert.equal(JSON.parse(response.body).code, "route_not_found");
  }
  assert.equal(dispatchCount, 0);
});

test("staged proposal mutations fail validation before application dispatch", async () => {
  let dispatchCount = 0;
  const { handler, session } = setup({
    async generateStagedLoopProposal() {
      dispatchCount += 1;
      return stagedProposal();
    },
  });
  const missingKey = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/loop-draft-proposals",
    headers: mutationHeaders(session, ""),
    body: {
      schemaVersion: "workbench-api-v1",
      data: { name: "Invalid", sourceText: "", definition: stagedProposal().draft.definition },
    },
  });
  assert.equal(missingKey.status, 400);
  assert.equal(JSON.parse(missingKey.body).code, "request_invalid");
  assert.equal(dispatchCount, 0);
});
