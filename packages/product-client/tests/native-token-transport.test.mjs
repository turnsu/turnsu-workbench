import assert from "node:assert/strict";
import test from "node:test";

import { createNativeTokenProductClient, ProductClientProtocolError } from "../dist/index.js";
import {
  createNativeAuthorizationProductClient,
  createNativeAuthProductClient,
} from "../dist/auth.js";
import { WORKBENCH_V1_WORKSPACE_ENDPOINTS } from "@turnsu/workbench-contracts/workspace-http";

const accessToken = "A".repeat(43);

function response(data, { status = 200 } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

test("native transport uses an absolute Product origin, bearer token, and omits browser credentials", async () => {
  const client = createProduct();
  await client.call("workspace", {});
  const request = createProduct.lastRequest;
  assert.equal(request.url, "https://workspace.example.test/api/workbench/v1/workspace");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.headers.get("Authorization"), `Bearer ${accessToken}`);
  assert.equal(request.init.headers.get("X-Workbench-CSRF"), null);
});

test("native transport refuses a missing token before any request", async () => {
  let calls = 0;
  const client = createNativeTokenProductClient([
    WORKBENCH_V1_WORKSPACE_ENDPOINTS.workspace,
  ], {
    baseUrl: "https://workspace.example.test",
    accessToken: () => "",
    fetch: async () => {
      calls += 1;
      return response({});
    },
  });
  await assert.rejects(
    client.call("workspace", {}),
    (error) => error instanceof ProductClientProtocolError
      && error.code === "product_client_native_access_token_required",
  );
  assert.equal(calls, 0);
});

test("native auth client exposes session self-revocation through the shared contract", async () => {
  let request;
  const client = createNativeAuthProductClient({
    baseUrl: "https://workspace.example.test",
    accessToken: () => accessToken,
    fetch: async (url, init) => {
      request = { url, init };
      return response({
        schemaVersion: "workbench-api-v1",
        data: { revoked: true },
        requestId: "request-native-revoke",
      });
    },
  });
  const result = await client.call("revokeNativeClientSession", {
    headers: { Authorization: `Bearer ${accessToken}` },
    body: { schemaVersion: "workbench-api-v1", data: {} },
  });
  assert.equal(request.url, "https://workspace.example.test/api/workbench/v1/auth/native/revoke");
  assert.equal(request.init.headers.get("Authorization"), `Bearer ${accessToken}`);
  assert.deepEqual(result.body.data, { revoked: true });
});

test("native authorization client exchanges credentials without a cookie, bearer token, or CSRF header", async () => {
  let request;
  const client = createNativeAuthorizationProductClient({
    baseUrl: "https://workspace.example.test",
    fetch: async (url, init) => {
      request = { url, init };
      return response({
        schemaVersion: "workbench-api-v1",
        data: {
          authorizationId: "native_authorization_1234567890",
          expiresAt: "2026-08-12T01:00:00.000Z",
          authorizationUrl: "https://workspace.example.test/native/authorize?authorization_id=native_authorization_1234567890",
        },
        requestId: "request-native-start",
      }, { status: 201 });
    },
  });
  const result = await client.call("startNativeAuthorization", {
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        clientKind: "desktop",
        redirectUri: "http://127.0.0.1:43125/callback",
        codeChallenge: "A".repeat(43),
        devicePublicKey: "B".repeat(43),
      },
    },
  });
  assert.equal(request.url, "https://workspace.example.test/api/workbench/v1/auth/native/authorize");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.headers.get("Authorization"), null);
  assert.equal(request.init.headers.get("X-Workbench-CSRF"), null);
  assert.equal(request.init.headers.get("Content-Type"), "application/json");
  assert.equal(result.status, 201);
  assert.equal(result.body.data.authorizationId, "native_authorization_1234567890");
});

function createProduct() {
  const client = createNativeTokenProductClient([
    WORKBENCH_V1_WORKSPACE_ENDPOINTS.workspace,
  ], {
    baseUrl: "https://workspace.example.test",
    accessToken: () => accessToken,
    fetch: async (url, init) => {
      createProduct.lastRequest = { url, init };
      return response({
        schemaVersion: "workbench-api-v1",
        data: {
          workspace: {
            workspaceId: "workspace-native",
            name: "Native workspace",
            capabilities: { builderProposal: false, resources: false, maxParallelism: 1 },
            createdAt: "2026-08-12T00:00:00.000Z",
            updatedAt: "2026-08-12T00:00:00.000Z",
          },
          session: {
            csrfToken: "",
            expiresAt: "2026-08-12T01:00:00.000Z",
            userId: "user-native",
            workspaceId: "workspace-native",
          },
        },
        requestId: "request-native-workspace",
      });
    },
  });
  return client;
}
