import assert from "node:assert/strict";
import test from "node:test";

import { WORKBENCH_V1_ENDPOINTS } from "@looloomi/workbench-contracts";

import {
  ProductApiError,
  ProductClientProtocolError,
  createBrowserSessionProductClient,
} from "../dist/index.js";
import { createWorkspaceProductClient } from "../dist/workspace.js";

const workspaceResponse = {
  schemaVersion: "workbench-api-v1",
  data: {
    workspace: {
      workspaceId: "workspace-local",
      name: "Local workspace",
      capabilities: {
        builderProposal: false,
        resources: false,
        maxParallelism: 1,
      },
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    },
    session: {
      csrfToken: "csrf-local-workbench-session-token-0001",
      expiresAt: "2026-08-05T08:00:00.000Z",
      userId: "user-local",
      workspaceId: "workspace-local",
    },
  },
  requestId: "request-workspace-1",
};

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...init.headers,
    },
  });
}

test("workspace call validates and returns the complete response", async () => {
  const client = createWorkspaceProductClient({
    fetch: async () => jsonResponse(workspaceResponse),
  });

  const result = await client.call("workspace", {});

  assert.equal(result.operationId, "workspace");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, workspaceResponse);
  assert.deepEqual(result.headers, { "Cache-Control": "no-store" });
});

test("workspace bootstrap fails closed without no-store", async () => {
  const client = createWorkspaceProductClient({
    fetch: async () => new Response(JSON.stringify(workspaceResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });

  await assert.rejects(
    client.call("workspace", {}),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "response_headers",
  );
});

test("malformed successful response fails closed", async () => {
  const client = createWorkspaceProductClient({
    fetch: async () =>
      jsonResponse({ ...workspaceResponse, unexpectedPublicField: true }),
  });

  await assert.rejects(
    client.call("workspace", {}),
    (error) => {
      assert.equal(error instanceof ProductClientProtocolError, true);
      assert.equal(error.code, "product_client_invalid_response_body");
      assert.equal(error.stage, "response_body");
      return true;
    },
  );
});

test("invalid path input is rejected before transport", async () => {
  let fetchCount = 0;
  const client = createBrowserSessionProductClient([WORKBENCH_V1_ENDPOINTS.getSkill], {
    fetch: async () => {
      fetchCount += 1;
      return jsonResponse(workspaceResponse);
    },
  });

  await assert.rejects(
    client.call("getSkill", /** @type {never} */ ({})),
    (error) => {
      assert.equal(error instanceof ProductClientProtocolError, true);
      assert.equal(error.stage, "request_path");
      return true;
    },
  );
  assert.equal(fetchCount, 0);
});

test("browser transport uses a relative URL and same-origin credentials", async () => {
  let captured;
  const client = createWorkspaceProductClient({
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse(workspaceResponse);
    },
  });

  await client.call("workspace", {});

  assert.equal(captured.url, "/api/workbench/v1/workspace");
  assert.equal(captured.init.credentials, "same-origin");
  assert.equal(captured.init.redirect, "error");
  assert.equal(captured.init.headers.get("Accept"), "application/json");
});

test("browser transport preserves a configured same-origin API base path", async () => {
  let capturedUrl;
  const client = createWorkspaceProductClient({
    basePath: "/test-api/workbench/v1",
    fetch: async (url) => {
      capturedUrl = url;
      return jsonResponse(workspaceResponse);
    },
  });

  await client.call("workspace", {});
  assert.equal(capturedUrl, "/test-api/workbench/v1/workspace");
  assert.throws(
    () => createWorkspaceProductClient({ basePath: "https://example.invalid" }),
    /product_client_base_path_invalid/,
  );
});

test("valid Product errors are surfaced without losing envelope fields", async () => {
  const envelope = {
    code: "workspace_forbidden",
    message: "The workspace is not available to this principal.",
    details: { recoveryAction: "switch_workspace" },
    retryable: false,
    requestId: "request-error-1",
  };
  const client = createWorkspaceProductClient({
    fetch: async () => jsonResponse(envelope, { status: 403 }),
  });

  await assert.rejects(
    client.call("workspace", {}),
    (error) => {
      assert.equal(error instanceof ProductApiError, true);
      assert.equal(error.code, envelope.code);
      assert.equal(error.message, envelope.message);
      assert.deepEqual(error.details, envelope.details);
      assert.equal(error.retryable, false);
      assert.equal(error.requestId, envelope.requestId);
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test("malformed Product errors fail closed as protocol errors", async () => {
  const client = createWorkspaceProductClient({
    fetch: async () =>
      jsonResponse(
        { code: "workspace_forbidden", message: "Forbidden" },
        { status: 403 },
      ),
  });

  await assert.rejects(
    client.call("workspace", {}),
    (error) => {
      assert.equal(error instanceof ProductClientProtocolError, true);
      assert.equal(error.code, "product_client_invalid_error_body");
      assert.equal(error.stage, "error_body");
      return true;
    },
  );
});

test("unknown operations fail before transport", async () => {
  let fetchCount = 0;
  const client = createWorkspaceProductClient({
    fetch: async () => {
      fetchCount += 1;
      return jsonResponse(workspaceResponse);
    },
  });

  await assert.rejects(
    client.call(/** @type {never} */ ("notAnOperation"), {}),
    (error) => {
      assert.equal(error instanceof ProductClientProtocolError, true);
      assert.equal(error.code, "product_client_unknown_or_non_json_operation");
      assert.equal(error.stage, "operation");
      return true;
    },
  );
  assert.equal(fetchCount, 0);
});
