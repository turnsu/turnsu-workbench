import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Check, WORKBENCH_V1_ARTIFACT_ENDPOINTS } from "@looloomi/workbench-contracts";

import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";
import { WorkbenchSessionStore } from "../../src/security/workbench-session-store.mjs";

const NOW = "2026-07-18T12:00:00.000Z";
const ORIGIN = "http://127.0.0.1";
const BYTES = Buffer.from([0, 1, 2, 3, 254, 255]);

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.status = null;
    this.headers = {};
    this.chunks = [];
  }
  writeHead(status, headers = {}) { this.status = status; this.headers = headers; }
  write(value) { this.chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value))); }
  end(value) {
    if (value !== undefined && value !== "") this.write(value);
    this.emit("finish");
  }
  get body() { return Buffer.concat(this.chunks); }
}

function request(url, sessionToken) {
  const req = new EventEmitter();
  req.method = "GET";
  req.url = url;
  req.headers = { host: "127.0.0.1", cookie: `workbench_session=${sessionToken}` };
  req[Symbol.asyncIterator] = async function* iterator() {};
  return req;
}

async function invoke(handler, url, sessionToken) {
  const response = new MockResponse();
  await handler(request(url, sessionToken), response);
  return response;
}

const metadata = {
  schemaVersion: "workbench-v1",
  artifactId: "artifact-image-a",
  workspaceId: "workspace-a",
  state: "ready",
  mediaType: "image/png",
  byteLength: BYTES.byteLength,
  contentHash: `sha256:${"a".repeat(64)}`,
  dimensions: { width: 1, height: 1 },
  source: {
    kind: "agent_turn",
    sessionId: "agent-session-a",
    turnId: "agent-turn-a",
    invocationId: "invocation-a",
    attemptId: "attempt-a",
  },
  requestedModelRevisionId: "model-revision-stability-a",
  actualModelRevisionId: "model-revision-stability-a",
  createdAt: NOW,
  expiresAt: null,
};

test("Artifact metadata stays JSON while content is returned as authorized raw bytes", async () => {
  const calls = [];
  const application = {
    async getArtifactMetadata(input) { calls.push(input); return metadata; },
    async getArtifactContent(input) {
      calls.push(input);
      return {
        rawBody: BYTES,
        responseHeaders: {
          "Content-Type": "image/png",
          "Content-Length": String(BYTES.byteLength),
          ETag: `"${metadata.contentHash}"`,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      };
    },
  };
  const sessionStore = new WorkbenchSessionStore({
    clock: () => new Date(NOW),
    tokenFactory: () => "artifact-http-session-token",
    csrfTokenFactory: () => "artifact-http-csrf-token-abcdefghijklmnopqrstuvwxyz",
  });
  const session = sessionStore.issue({ userId: "user-a", activeWorkspaceId: "workspace-a" });
  const handler = createWorkbenchHttpHandler({
    application,
    sessionStore,
    origin: ORIGIN,
    requestIdFactory: () => "request-artifact-http",
  });

  const metadataResponse = await invoke(
    handler,
    `/api/workbench/v1/artifacts/${metadata.artifactId}`,
    session.token,
  );
  assert.equal(metadataResponse.status, 200);
  const envelope = JSON.parse(metadataResponse.body.toString("utf8"));
  assert.equal(Check(WORKBENCH_V1_ARTIFACT_ENDPOINTS.getArtifactMetadata.responseBodySchema, envelope), true);
  assert.equal(JSON.stringify(envelope).includes("base64"), false);

  const contentResponse = await invoke(
    handler,
    `/api/workbench/v1/artifacts/${metadata.artifactId}/content`,
    session.token,
  );
  assert.equal(contentResponse.status, 200);
  assert.deepEqual(contentResponse.body, BYTES);
  assert.equal(Check(
    WORKBENCH_V1_ARTIFACT_ENDPOINTS.getArtifactContent.responseHeadersSchema,
    contentResponse.headers,
  ), true);
  assert.equal(calls[0].auth.activeWorkspaceId, "workspace-a");
  assert.equal(calls[1].auth.activeWorkspaceId, "workspace-a");
});

test("Artifact routes require an authenticated Product session", async () => {
  const handler = createWorkbenchHttpHandler({ application: {}, origin: ORIGIN });
  const response = await invoke(handler, "/api/workbench/v1/artifacts/artifact-image-a/content", "missing");
  assert.equal(response.status, 401);
  assert.equal(JSON.parse(response.body.toString("utf8")).code, "session_required");
});
