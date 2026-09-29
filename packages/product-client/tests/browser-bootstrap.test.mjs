import assert from "node:assert/strict";
import test from "node:test";

import { ProductClientProtocolError } from "../dist/index.js";
import { createAuthProductClient } from "../dist/auth.js";
import { createReadinessProductClient } from "../dist/readiness.js";

const user = {
  userId: "user-owner",
  username: "owner.local",
  role: "admin",
  disabled: false,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};

const authResult = {
  schemaVersion: "workbench-api-v1",
  data: { user, workspaceId: "workspace-local" },
  requestId: "request-auth-1",
};

const readinessResult = {
  schemaVersion: "workbench-api-v1",
  data: {
    schemaVersion: "workbench-v1",
    workspaceId: "workspace-local",
    workspaceRole: "admin",
    evaluatedAt: "2026-08-04T00:00:00.000Z",
    actions: {
      promptSkill: {},
      scriptSkill: {},
      registeredToolSkill: {},
      skillDirectoryImport: {},
      skillZipImport: {},
      publicGithubSkillImport: {},
      serverSkillImport: {},
      blankLoop: {},
      stagedLoopProposal: {},
      connectionSetup: {},
      workspaceResource: {},
    },
    support: {
      readyRuntimeIds: [],
      registeredToolPackageCount: 0,
      selectableBuilderModelCount: 0,
      readyAttachmentMediaTypes: [],
      unavailableAttachmentMediaTypes: [],
    },
  },
  requestId: "request-readiness-1",
};

function jsonResponse(body, { status = 200, cacheControl = "no-store" } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    },
  });
}

test("browser auth calls preserve endpoint-specific headers, bodies, and CSRF", async () => {
  const requests = [];
  const client = createAuthProductClient({
    csrfToken: (operationId) => (
      ["register", "login"].includes(operationId) ? undefined : "csrf-session-token"
    ),
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/auth/status")) {
        return jsonResponse({
          schemaVersion: "workbench-api-v1",
          data: {
            registrationOpen: false,
            bootstrapRequired: false,
            bootstrapAvailable: false,
            authenticated: true,
            user,
            workspaceId: "workspace-local",
          },
          requestId: "request-auth-status-1",
        });
      }
      if (url.endsWith("/auth/register")) return jsonResponse(authResult, { status: 201 });
      if (url.endsWith("/auth/login")) return jsonResponse(authResult);
      return jsonResponse({
        schemaVersion: "workbench-api-v1",
        data: { revoked: true },
        requestId: "request-logout-1",
      });
    },
  });

  await client.call("authStatus", {});
  await client.call("register", {
    headers: { "Idempotency-Key": "register-owner-1" },
    body: {
      schemaVersion: "workbench-api-v1",
      data: { username: "owner.local", password: "correct horse" },
    },
  });
  await client.call("login", {
    body: {
      schemaVersion: "workbench-api-v1",
      data: { username: "owner.local", password: "correct horse" },
    },
  });
  await client.call("logout", {
    body: { schemaVersion: "workbench-api-v1", data: {} },
  });

  assert.deepEqual(requests.map(({ url }) => url), [
    "/api/workbench/v1/auth/status",
    "/api/workbench/v1/auth/register",
    "/api/workbench/v1/auth/login",
    "/api/workbench/v1/auth/logout",
  ]);
  assert.equal(requests[1].init.headers.get("Idempotency-Key"), "register-owner-1");
  assert.equal(requests[1].init.headers.get("X-Workbench-CSRF"), null);
  assert.equal(requests[2].init.headers.get("Idempotency-Key"), null);
  assert.equal(requests[2].init.headers.get("X-Workbench-CSRF"), null);
  assert.equal(requests[3].init.headers.get("X-Workbench-CSRF"), "csrf-session-token");
  assert.deepEqual(JSON.parse(requests[3].init.body), {
    schemaVersion: "workbench-api-v1",
    data: {},
  });
});

test("auth and readiness fail closed on malformed body or no-store headers", async () => {
  const inconsistentStatus = createAuthProductClient({
    fetch: async () => jsonResponse({
      schemaVersion: "workbench-api-v1",
      data: {
        registrationOpen: false,
        bootstrapRequired: false,
        bootstrapAvailable: false,
        authenticated: true,
      },
      requestId: "request-inconsistent-auth-status",
    }),
  });
  await assert.rejects(
    inconsistentStatus.call("authStatus", {}),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "response_body",
  );

  const auth = createAuthProductClient({
    fetch: async () => jsonResponse(authResult, { cacheControl: "public, max-age=60" }),
  });
  await assert.rejects(
    auth.call("login", {
      body: {
        schemaVersion: "workbench-api-v1",
        data: { username: "owner.local", password: "correct horse" },
      },
    }),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "response_headers",
  );

  const missingHeaderAuth = createAuthProductClient({
    fetch: async () => new Response(JSON.stringify(authResult), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await assert.rejects(
    missingHeaderAuth.call("login", {
      body: {
        schemaVersion: "workbench-api-v1",
        data: { username: "owner.local", password: "correct horse" },
      },
    }),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "response_headers",
  );

  const readiness = createReadinessProductClient({
    fetch: async () => jsonResponse(readinessResult, { cacheControl: "private, no-store" }),
  });
  const result = await readiness.call("getWorkspaceFeatureReadiness", {});
  assert.equal(result.body.data.workspaceId, "workspace-local");
  assert.deepEqual(result.headers, { "Cache-Control": "private, no-store" });

  const malformedReadiness = createReadinessProductClient({
    fetch: async () => jsonResponse({ ...readinessResult, data: { workspaceId: "workspace-local" } }, {
      cacheControl: "private, no-store",
    }),
  });
  await assert.rejects(
    malformedReadiness.call("getWorkspaceFeatureReadiness", {}),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "response_body",
  );
});

test("register requires idempotency before transport", async () => {
  let fetchCount = 0;
  const client = createAuthProductClient({
    fetch: async () => {
      fetchCount += 1;
      return jsonResponse(authResult, { status: 201 });
    },
  });

  await assert.rejects(
    client.call("register", /** @type {never} */ ({
      body: {
        schemaVersion: "workbench-api-v1",
        data: { username: "owner.local", password: "correct horse" },
      },
    })),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "request_headers",
  );
  assert.equal(fetchCount, 0);
});

test("readiness forwards cancellation to the browser transport", async () => {
  const controller = new AbortController();
  let capturedSignal;
  const client = createReadinessProductClient({
    fetch: async (_url, init) => {
      capturedSignal = init.signal;
      return jsonResponse(readinessResult, { cacheControl: "private, no-store" });
    },
  });

  await client.call("getWorkspaceFeatureReadiness", {}, { signal: controller.signal });
  assert.equal(capturedSignal, controller.signal);
});
