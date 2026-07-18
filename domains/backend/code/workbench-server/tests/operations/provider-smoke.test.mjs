import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { runProductProviderSmoke } from "../../../../operations/local/provider-smoke.mjs";

test("Stability smoke refuses to perform any candidate or server work without explicit billable confirmation", async () => {
  let started = false;
  await assert.rejects(runProductProviderSmoke({
    bundleRoot: "/private/tmp/provider-smoke-candidate-does-not-need-to-exist",
    sourceCommit: "a".repeat(40),
    kind: "stability",
    profileId: "stability-release-smoke",
    confirmBillable: false,
    env: { WORKBENCH_MONGODB_DB: "looloomi_provider_stability_smoke_test" },
    startServer: async () => {
      started = true;
      throw new Error("must_not_start");
    },
  }), { code: "stability_billable_confirmation_required" });
  assert.equal(started, false);
});

test("provider smoke rejects relative candidate paths before starting a server", async () => {
  let started = false;
  await assert.rejects(runProductProviderSmoke({
    bundleRoot: "relative-candidate",
    sourceCommit: "a".repeat(40),
    kind: "chat",
    profileId: "chat-release-smoke",
    env: { WORKBENCH_MONGODB_DB: "looloomi_provider_chat_smoke_test" },
    startServer: async () => {
      started = true;
      throw new Error("must_not_start");
    },
  }), { name: "TypeError", message: "provider_smoke_input_invalid" });
  assert.equal(started, false);
});

test("chat smoke consumes the Product API list envelope and records a pinned one-attempt proof", async (t) => {
  const bundleRoot = await mkdtemp("/private/tmp/provider-smoke-product-path-");
  t.after(() => rm(bundleRoot, { recursive: true, force: true }));
  await mkdir(`${bundleRoot}/app`);
  await writeFile(`${bundleRoot}/app/server.mjs`, "export const candidate = true;\n");
  const revisionId = "model-revision-chat-a";
  const turn = {
    turnId: "turn-chat-a",
    sessionId: "agent-session-chat-a",
    status: "completed",
    kind: "agent_message",
    requestedModelRevisionId: revisionId,
    actualModelRevisionId: revisionId,
    artifactRefs: [],
    result: {
      kind: "agent_message",
      response: "Acknowledged.",
      proposalId: null,
      handoffId: null,
      invocationIds: ["invocation-chat-a"],
      requestedModelRevisionId: revisionId,
      actualModelRevisionId: revisionId,
      artifactRefs: [],
    },
  };
  let closed = false;
  const startServer = async () => {
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/api/workbench/v1/workspace") {
        response.setHeader("set-cookie", "workbench_session=provider-smoke; Path=/; HttpOnly");
        response.end(JSON.stringify({ data: { session: { csrfToken: "c".repeat(32) } } }));
        return;
      }
      if (url.pathname === "/api/workbench/v1/model-profiles") {
        response.end(JSON.stringify({ data: [{
          profileId: "chat-release-smoke",
          currentRevisionId: revisionId,
          currentRevision: { providerDisplay: { key: "deepseek", label: "DeepSeek" } },
          selectable: true,
          readiness: "ready",
        }], page: { nextCursor: null, hasMore: false } }));
        return;
      }
      if (url.pathname === "/api/workbench/v1/agent-sessions" && request.method === "POST") {
        response.end(JSON.stringify({ data: { sessionId: turn.sessionId } }));
        return;
      }
      if (url.pathname === `/api/workbench/v1/agent-sessions/${turn.sessionId}/turns`
        && request.method === "POST") {
        response.end(JSON.stringify({ data: turn }));
        return;
      }
      if (url.pathname === `/api/workbench/v1/agent-sessions/${turn.sessionId}/turns/${turn.turnId}`) {
        response.end(JSON.stringify({ data: turn }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "not_found" } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      server,
      async close() {
        closed = true;
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      },
    };
  };

  const evidence = await runProductProviderSmoke({
    bundleRoot,
    sourceCommit: "b".repeat(40),
    kind: "chat",
    profileId: "chat-release-smoke",
    env: { WORKBENCH_MONGODB_DB: "looloomi_provider_chat_smoke_test" },
    startServer,
    clock: () => "2026-07-18T00:00:00.000Z",
  });
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.profileRevisionId, revisionId);
  assert.equal(evidence.attempts, 1);
  assert.equal(evidence.fallback, false);
  assert.equal(evidence.protocol, "openai_compatible_chat");
  assert.equal(closed, true);
});

test("Stability smoke verifies governed Artifact bytes and cross-workspace denial", async (t) => {
  const bundleRoot = await mkdtemp("/private/tmp/provider-smoke-stability-path-");
  t.after(() => rm(bundleRoot, { recursive: true, force: true }));
  await mkdir(`${bundleRoot}/app`);
  await writeFile(`${bundleRoot}/app/server.mjs`, "export const candidate = true;\n");
  const revisionId = "model-revision-image-a";
  const artifactId = "artifact-image-a";
  const bytes = Buffer.from("bounded-fake-png-bytes");
  const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const artifactRef = { artifactId, mediaType: "image/png" };
  const turn = {
    turnId: "turn-image-a",
    sessionId: "agent-session-image-a",
    status: "completed",
    kind: "model_task",
    requestedModelRevisionId: revisionId,
    actualModelRevisionId: revisionId,
    artifactRefs: [artifactRef],
    result: {
      kind: "model_task",
      result: { artifactRefs: [artifactRef] },
      invocationIds: ["invocation-image-a"],
      requestedModelRevisionId: revisionId,
      actualModelRevisionId: revisionId,
      artifactRefs: [artifactRef],
    },
  };
  const startServer = async () => {
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/api/workbench/v1/workspace") {
        const other = request.headers["x-workbench-test-workspace"] === "provider-smoke-other-workspace";
        response.setHeader("content-type", "application/json");
        response.setHeader("set-cookie", `workbench_session=${other ? "other" : "primary"}; Path=/; HttpOnly`);
        response.end(JSON.stringify({ data: { session: { csrfToken: "c".repeat(32) } } }));
        return;
      }
      if (url.pathname === "/api/workbench/v1/model-profiles") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{
          profileId: "stability-release-smoke",
          currentRevisionId: revisionId,
          currentRevision: {
            providerDisplay: { key: "stability", label: "Stability AI" },
            parameterSupport: {
              kind: "image_generation",
              aspectRatios: ["1:1", "16:9"],
              outputFormats: ["png", "jpeg"],
            },
            limits: {
              kind: "image_generation",
              maxImageCount: 1,
              maxOutputBytes: 25_000_000,
              maxCostUsdMicros: 30_000,
            },
          },
          selectable: true,
          readiness: "ready",
        }], page: { nextCursor: null, hasMore: false } }));
        return;
      }
      if (url.pathname === "/api/workbench/v1/agent-sessions" && request.method === "POST") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: { sessionId: turn.sessionId } }));
        return;
      }
      if (url.pathname === `/api/workbench/v1/agent-sessions/${turn.sessionId}/turns`
        && request.method === "POST") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: turn }));
        return;
      }
      if (url.pathname === `/api/workbench/v1/agent-sessions/${turn.sessionId}/turns/${turn.turnId}`) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: turn }));
        return;
      }
      if (url.pathname === `/api/workbench/v1/artifacts/${artifactId}`) {
        if (String(request.headers.cookie).includes("workbench_session=other")) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: {
          artifactId,
          byteLength: bytes.length,
          contentHash,
          mediaType: "image/png",
          dimensions: { width: 64, height: 64 },
          source: { kind: "agent_turn" },
        } }));
        return;
      }
      if (url.pathname === `/api/workbench/v1/artifacts/${artifactId}/content`) {
        response.setHeader("content-type", "image/png");
        response.end(bytes);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      server,
      close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
  };

  const evidence = await runProductProviderSmoke({
    bundleRoot,
    sourceCommit: "c".repeat(40),
    kind: "stability",
    profileId: "stability-release-smoke",
    confirmBillable: true,
    env: { WORKBENCH_MONGODB_DB: "looloomi_provider_stability_smoke_test" },
    startServer,
  });
  assert.equal(evidence.capability, "image_generation");
  assert.equal(evidence.protocol, "stability_image_v2");
  assert.equal(evidence.artifactId, artifactId);
  assert.equal(evidence.artifactDigest, contentHash);
  assert.equal(evidence.artifactMediaType, "image/png");
  assert.deepEqual(evidence.artifactDimensions, { width: 64, height: 64 });
  assert.deepEqual(evidence.billing, {
    pricingPolicy: "stability-core-credits-2026-07-18",
    creditsPerImage: 3,
    usdMicrosPerCredit: 10_000,
    estimatedUsdMicros: 30_000,
  });
  assert.equal(evidence.billableConfirmed, true);
  assert.deepEqual(evidence.assertions, {
    productPath: true,
    requestedActualMatch: true,
    rawProviderPayloadAbsent: true,
    secretLeakScanPassed: true,
    noPiSession: true,
    authorizedRetrieval: true,
    crossWorkspaceDenied: true,
    artifactHashVerified: true,
  });
});
