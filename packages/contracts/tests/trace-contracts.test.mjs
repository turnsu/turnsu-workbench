import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  ProductTraceSchema,
  WORKBENCH_V1_TRACE_ENDPOINTS,
} from "../dist/index.js";

test("Product Trace exposes only stable lineage identifiers and product-safe status", () => {
  const trace = {
    schemaVersion: "workbench-v1",
    productCommandId: "product-command-1",
    workspaceId: "workspace-1",
    nodes: [{
      nodeId: "product_command:product-command-1",
      kind: "product_command",
      entityId: "product-command-1",
      parentNodeId: null,
      status: "completed",
      occurredAt: "2026-08-01T00:00:00.000Z",
    }],
  };
  assert.equal(Check(ProductTraceSchema, trace), true);
  assert.equal(Check(ProductTraceSchema, {
    ...trace,
    nodes: [{ ...trace.nodes[0], providerPayload: { apiKey: "secret" } }],
  }), false);
  assert.equal(WORKBENCH_V1_TRACE_ENDPOINTS.getProductTrace.method, "GET");
  assert.equal(
    WORKBENCH_V1_TRACE_ENDPOINTS.getProductTrace.path,
    "/api/workbench/v1/traces/{productCommandId}",
  );
});
