import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  Check,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS,
} from "@looloomi/workbench-contracts";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
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

function proposal({ status = "proposed", decidedAt = null } = {}) {
  return {
    schemaVersion: "workbench-v1",
    proposalId: PROPOSAL_ID,
    workspaceId: "workspace-local",
    workflowId: WORKFLOW_ID,
    baseRevisionId: REVISION_ID,
    summary: "Require a reviewed owner for every action.",
    operations: [],
    diagnostics: [],
    permissionImpact: [],
    status,
    createdBy: "user-local",
    createdAt: NOW,
    decidedAt,
  };
}

function setup(application, handlerOptions = {}) {
  const sessionStore = new WorkbenchSessionStore({
    clock: () => new Date(NOW),
    tokenFactory: () => "builder-http-session-token",
    csrfTokenFactory: () => "builder-http-csrf-token-abcdefghijklmnopqrstuvwxyz",
  });
  const session = sessionStore.issue();
  const handler = createWorkbenchHttpHandler({
    application,
    sessionStore,
    origin: ORIGIN,
    requestIdFactory: () => "request-builder-http-1",
    ...handlerOptions,
  });
  return { handler, session };
}

function mutationHeaders(session, {
  idempotencyKey = "builder-http-idempotency-1",
  ifMatch = `"${REVISION_ID}"`,
} = {}) {
  return {
    Cookie: `workbench_session=${session.token}`,
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "X-Workbench-CSRF": session.csrfToken,
    "Content-Type": "application/json",
    ...(idempotencyKey === null ? {} : { "Idempotency-Key": idempotencyKey }),
    ...(ifMatch === null ? {} : { "If-Match": ifMatch }),
  };
}

const generateRequest = () => ({
  schemaVersion: "workbench-api-v1",
  data: { instruction: "Require an owner for every action." },
});

const applyRequest = () => ({
  schemaVersion: "workbench-api-v1",
  data: { baseRevisionId: REVISION_ID },
});

test("Builder Proposal generate/apply routes are active and return contract-valid mock responses", async () => {
  const calls = [];
  const application = {
    async generateLoopProposal(input) {
      calls.push({ operation: "generate", input: structuredClone(input) });
      return proposal();
    },
    async applyLoopProposal(input) {
      calls.push({ operation: "apply", input: structuredClone(input) });
      return proposal({ status: "applied", decidedAt: NOW });
    },
    async dismissLoopProposal(input) {
      calls.push({ operation: "dismiss", input: structuredClone(input) });
      return proposal({ status: "dismissed", decidedAt: NOW });
    },
  };
  const { handler, session } = setup(application);

  const generated = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals`,
    headers: mutationHeaders(session, { idempotencyKey: "builder-generate-idem-1" }),
    body: generateRequest(),
  });
  const generatedBody = JSON.parse(generated.body);
  assert.equal(generated.status, 201, generated.body);
  assert.equal(
    Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.generateLoopProposal.responseBodySchema, generatedBody),
    true,
  );
  assert.equal(generatedBody.data.status, "proposed");

  const applied = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals/${PROPOSAL_ID}/apply`,
    headers: mutationHeaders(session, { idempotencyKey: "builder-apply-idem-1" }),
    body: applyRequest(),
  });
  const appliedBody = JSON.parse(applied.body);
  assert.equal(applied.status, 200, applied.body);
  assert.equal(
    Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.applyLoopProposal.responseBodySchema, appliedBody),
    true,
  );
  assert.equal(appliedBody.data.status, "applied");
  const dismissed = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals/${PROPOSAL_ID}/dismiss`,
    headers: mutationHeaders(session, { idempotencyKey: "builder-dismiss-idem-1" }),
    body: applyRequest(),
  });
  const dismissedBody = JSON.parse(dismissed.body);
  assert.equal(dismissed.status, 200, dismissed.body);
  assert.equal(
    Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.dismissLoopProposal.responseBodySchema, dismissedBody),
    true,
  );
  assert.equal(dismissedBody.data.status, "dismissed");
  assert.deepEqual(calls.map(({ operation }) => operation), ["generate", "apply", "dismiss"]);
  assert.equal(calls[0].input.idempotencyKey, "builder-generate-idem-1");
  assert.equal(calls[0].input.ifMatch, `"${REVISION_ID}"`);
  assert.deepEqual(calls[0].input.request, generateRequest());
  assert.equal(calls[1].input.proposalId, PROPOSAL_ID);
  assert.equal(calls[1].input.idempotencyKey, "builder-apply-idem-1");
  assert.equal(calls[1].input.ifMatch, `"${REVISION_ID}"`);
  assert.deepEqual(calls[1].input.request, applyRequest());
  assert.equal(calls[2].input.idempotencyKey, "builder-dismiss-idem-1");
  assert.deepEqual(calls[2].input.request, applyRequest());
});

test("Builder Proposal routes require Idempotency-Key and If-Match and reject invalid request schemas", async () => {
  let dispatchCount = 0;
  const application = {
    async generateLoopProposal() { dispatchCount += 1; return proposal(); },
    async applyLoopProposal() { dispatchCount += 1; return proposal(); },
    async dismissLoopProposal() { dispatchCount += 1; return proposal(); },
  };
  const { handler, session } = setup(application);
  const cases = [
    {
      name: "generate missing If-Match",
      url: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals`,
      headers: mutationHeaders(session, { ifMatch: null }),
      body: generateRequest(),
      status: 428,
      code: "precondition_required",
    },
    {
      name: "generate missing Idempotency-Key",
      url: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals`,
      headers: mutationHeaders(session, { idempotencyKey: null }),
      body: generateRequest(),
      status: 400,
      code: "request_invalid",
    },
    {
      name: "generate invalid instruction schema",
      url: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals`,
      headers: mutationHeaders(session),
      body: { ...generateRequest(), data: { instruction: "", providerPayload: "private" } },
      status: 400,
      code: "request_invalid",
    },
    {
      name: "apply missing If-Match",
      url: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals/${PROPOSAL_ID}/apply`,
      headers: mutationHeaders(session, { ifMatch: null }),
      body: applyRequest(),
      status: 428,
      code: "precondition_required",
    },
    {
      name: "apply missing Idempotency-Key",
      url: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals/${PROPOSAL_ID}/apply`,
      headers: mutationHeaders(session, { idempotencyKey: null }),
      body: applyRequest(),
      status: 400,
      code: "request_invalid",
    },
    {
      name: "apply invalid base revision schema",
      url: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals/${PROPOSAL_ID}/apply`,
      headers: mutationHeaders(session),
      body: { ...applyRequest(), data: { baseRevisionId: "", providerPayload: "private" } },
      status: 400,
      code: "request_invalid",
    },
    {
      name: "dismiss missing If-Match",
      url: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals/${PROPOSAL_ID}/dismiss`,
      headers: mutationHeaders(session, { ifMatch: null }),
      body: applyRequest(),
      status: 428,
      code: "precondition_required",
    },
  ];

  for (const item of cases) {
    const response = await invoke(handler, {
      method: "POST",
      url: item.url,
      headers: item.headers,
      body: item.body,
    });
    assert.equal(response.status, item.status, item.name);
    assert.equal(JSON.parse(response.body).code, item.code, item.name);
  }
  assert.equal(dispatchCount, 0);
});

test("production Builder runtime unavailability is a product-safe 503 without provider payload", async () => {
  const revision = { ...makeRevision(), workflowId: WORKFLOW_ID, revisionId: REVISION_ID };
  const store = {
    async connect() {},
    async getWorkflow() {
      return {
        workflow: { workflowId: WORKFLOW_ID, currentRevisionId: REVISION_ID },
        etag: `"${REVISION_ID}"`,
      };
    },
    async runIdempotentMutation(_input, mutation) { return mutation({ id: "transaction" }); },
    repositories: {
      workflowRevisions: {
        async get(workflowId, revisionId) {
          return workflowId === WORKFLOW_ID && revisionId === REVISION_ID
            ? structuredClone(revision)
            : null;
        },
      },
    },
  };
  const agentRuntime = {
    async generateBuilderProposal() {
      const error = new Error("Workflow suggestions are temporarily unavailable.");
      error.code = "builder_proposal_unavailable";
      error.details = {
        provider: "private-model-provider",
        providerPayload: { raw: "private completion" },
        token: "private-provider-token",
        safe: "suggestion_runtime_unavailable",
      };
      throw error;
    },
  };
  const application = createWorkbenchApplication({ store, agentRuntime });
  const { handler, session } = setup(application);
  const response = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals`,
    headers: mutationHeaders(session),
    body: generateRequest(),
  });
  const body = JSON.parse(response.body);

  assert.equal(response.status, 503, response.body);
  assert.equal(body.code, "builder_proposal_unavailable");
  assert.deepEqual(body.details, { safe: "suggestion_runtime_unavailable" });
  assert.equal(response.body.includes("private-model-provider"), false);
  assert.equal(response.body.includes("private completion"), false);
  assert.equal(response.body.includes("private-provider-token"), false);
});

test("unknown Builder failures emit only a safe internal diagnostic", async () => {
  const diagnostics = [];
  const privateFailure = new Error("private-provider-token must never be reported");
  privateFailure.name = "MongoServerError";
  privateFailure.code = 251;
  privateFailure.codeName = "NoSuchTransaction";
  privateFailure.errorLabels = ["TransientTransactionError"];
  privateFailure.stack = `${privateFailure.name}: ${privateFailure.message}\n    at safeTransactionFrame (product-store.mjs:1:1)`;
  const application = {
    async generateLoopProposal() { throw privateFailure; },
  };
  const { handler, session } = setup(application, {
    internalErrorReporter: (diagnostic) => diagnostics.push(diagnostic),
  });
  const response = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/loops/${WORKFLOW_ID}/proposals`,
    headers: mutationHeaders(session),
    body: generateRequest(),
  });

  assert.equal(response.status, 500);
  assert.equal(response.body.includes("private-provider-token"), false);
  assert.deepEqual(diagnostics, [{
    requestId: "request-builder-http-1",
    name: "MongoServerError",
    numericCode: 251,
    codeName: "NoSuchTransaction",
    labels: ["TransientTransactionError"],
    stackFrames: ["at safeTransactionFrame (product-store.mjs:1:1)"],
  }]);
  assert.equal(JSON.stringify(diagnostics).includes("private-provider-token"), false);
});
