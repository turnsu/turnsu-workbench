import assert from "node:assert/strict";
import test from "node:test";

import { IsSchema } from "typebox";

import {
  PUBLIC_ENDPOINTS,
  WORKBENCH_V1_MEMBER_AGENT_ENDPOINTS,
  WORKBENCH_API_PREFIX,
  WORKBENCH_V1_AGENT_ENDPOINTS,
  WORKBENCH_V1_ARTIFACT_ENDPOINTS,
  WORKBENCH_V1_ATTACHMENT_ENDPOINTS,
  WORKBENCH_V1_AUTH_ENDPOINTS,
  WORKBENCH_V1_AUTOMATION_ENDPOINTS,
  WORKBENCH_V1_DEVICE_ENDPOINTS,
  WORKBENCH_V1_ENDPOINTS,
  WORKBENCH_V1_INBOX_ENDPOINTS,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS,
  WORKBENCH_V1_MEMORY_ENDPOINTS,
  WORKBENCH_V1_MODEL_ENDPOINTS,
  WORKBENCH_V1_READINESS_ENDPOINTS,
  WORKBENCH_V1_SKILL_IMPORT_ENDPOINTS,
  WORKBENCH_V1_SCOPE_ENDPOINTS,
  WORKBENCH_V1_SESSION_LEDGER_ENDPOINTS,
  WORKBENCH_V1_TRACE_ENDPOINTS,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS,
  WORKBENCH_V1_WORKSPACE_ENDPOINTS,
} from "../dist/index.js";

const endpointGroups = [
  WORKBENCH_V1_MEMBER_AGENT_ENDPOINTS,
  WORKBENCH_V1_AUTH_ENDPOINTS,
  WORKBENCH_V1_AUTOMATION_ENDPOINTS,
  WORKBENCH_V1_DEVICE_ENDPOINTS,
  WORKBENCH_V1_ENDPOINTS,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS,
  WORKBENCH_V1_AGENT_ENDPOINTS,
  WORKBENCH_V1_MEMORY_ENDPOINTS,
  WORKBENCH_V1_MODEL_ENDPOINTS,
  WORKBENCH_V1_ARTIFACT_ENDPOINTS,
  WORKBENCH_V1_ATTACHMENT_ENDPOINTS,
  WORKBENCH_V1_INBOX_ENDPOINTS,
  WORKBENCH_V1_TRACE_ENDPOINTS,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS,
  WORKBENCH_V1_READINESS_ENDPOINTS,
  WORKBENCH_V1_SKILL_IMPORT_ENDPOINTS,
  WORKBENCH_V1_SCOPE_ENDPOINTS,
  WORKBENCH_V1_SESSION_LEDGER_ENDPOINTS,
];

const declaredEndpoints = endpointGroups.flatMap((group) => Object.values(group));

test("PUBLIC_ENDPOINTS is the exact public domain endpoint inventory", () => {
  assert.equal(
    WORKBENCH_V1_ENDPOINTS.workspace,
    WORKBENCH_V1_WORKSPACE_ENDPOINTS.workspace,
    "the full HTTP catalog must reuse the leaf workspace endpoint object",
  );
  assert.equal(PUBLIC_ENDPOINTS.length, declaredEndpoints.length);
  assert.equal(Object.isFrozen(PUBLIC_ENDPOINTS), true);

  const registered = new Set(PUBLIC_ENDPOINTS);
  assert.equal(registered.size, PUBLIC_ENDPOINTS.length);
  for (const endpoint of declaredEndpoints) {
    assert.equal(
      registered.has(endpoint),
      true,
      `missing endpoint object ${endpoint.operationId}`,
    );
  }
});

test("PUBLIC_ENDPOINTS has unique operation and route identities", () => {
  const operationIds = new Set();
  const routes = new Set();

  for (const endpoint of PUBLIC_ENDPOINTS) {
    assert.equal(
      operationIds.has(endpoint.operationId),
      false,
      `duplicate operationId ${endpoint.operationId}`,
    );
    operationIds.add(endpoint.operationId);

    const route = `${endpoint.method} ${endpoint.path}`;
    assert.equal(routes.has(route), false, `duplicate route ${route}`);
    routes.add(route);
  }
});

test("PUBLIC_ENDPOINTS keeps method, path parameters and schema references complete", () => {
  const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  const schemaFields = [
    "pathParamsSchema",
    "querySchema",
    "requestHeadersSchema",
    "responseBodySchema",
    "responseHeadersSchema",
  ];

  for (const endpoint of PUBLIC_ENDPOINTS) {
    assert.equal(methods.has(endpoint.method), true, endpoint.operationId);
    assert.equal(
      endpoint.path.startsWith(`${WORKBENCH_API_PREFIX}/`) ||
        endpoint.path === WORKBENCH_API_PREFIX,
      true,
      endpoint.operationId,
    );
    assert.match(endpoint.operationId, /^[A-Za-z][A-Za-z0-9]*$/);

    for (const field of schemaFields) {
      assert.equal(
        IsSchema(endpoint[field]),
        true,
        `${endpoint.operationId}.${field} is not a TypeBox schema`,
      );
    }
    if (endpoint.requestBodySchema !== undefined) {
      assert.equal(
        IsSchema(endpoint.requestBodySchema),
        true,
        `${endpoint.operationId}.requestBodySchema is not a TypeBox schema`,
      );
    }
    assert.equal(
      endpoint.requestBodySchema !== undefined,
      endpoint.mutation,
      `${endpoint.operationId} request body does not match mutation metadata`,
    );

    const placeholders = [
      ...endpoint.path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g),
    ].map((match) => match[1]);
    const pathParams = Object.keys(endpoint.pathParamsSchema.properties ?? {});
    assert.deepEqual(
      pathParams.sort(),
      placeholders.sort(),
      `${endpoint.operationId} path parameter schema does not match its path`,
    );

    const requestHeaderNames = [
      ...endpoint.requiredRequestHeaders,
      ...endpoint.optionalRequestHeaders,
    ].sort();
    assert.deepEqual(
      Object.keys(endpoint.requestHeadersSchema.properties ?? {}).sort(),
      requestHeaderNames,
      `${endpoint.operationId} request header schema is incomplete`,
    );
    assert.deepEqual(
      Object.keys(endpoint.responseHeadersSchema.properties ?? {}).sort(),
      [...endpoint.responseHeaders].sort(),
      `${endpoint.operationId} response header schema is incomplete`,
    );
  }
});
