import assert from "node:assert/strict";
import test from "node:test";

import {
  formatConnectionEtag,
  productSafeConnection,
  validateRequiredConnectionBindings,
} from "../../src/connections/workspace-connection-service.mjs";

const now = "2026-07-14T00:00:00.000Z";
const connection = {
  schemaVersion: "workbench-v1",
  connectionId: "connection-calendar",
  workspaceId: "workspace-consumer",
  capabilityKey: "calendar-read",
  label: "Team calendar",
  configuration: {
    accountLabel: "Operations calendar",
    permissionSummary: "Read selected calendars.",
    credentialHandle: "must-not-leak-from-configuration",
  },
  status: "connected",
  validation: { status: "valid", checkedAt: now, message: "Connection setup is ready." },
  revision: 3,
  internalSecretHandle: "must-not-leak",
  createdAt: now,
  updatedAt: now,
};

test("Connection read model and ETag never expose internal credential handles", () => {
  const value = productSafeConnection(connection);
  assert.equal(value.internalSecretHandle, undefined);
  assert.equal(JSON.stringify(value).includes("must-not-leak"), false);
  assert.deepEqual(value.configuration, {
    accountLabel: "Operations calendar",
    permissionSummary: "Read selected calendars.",
  });
  assert.equal(formatConnectionEtag(connection), '"cnv1:connection-calendar:3"');
});

test("required connection bindings are explicit, workspace-scoped, and ready", async () => {
  const repositories = {
    connections: {
      async get(connectionId, { workspaceId }) {
        if (connectionId !== connection.connectionId || workspaceId !== connection.workspaceId) return null;
        return structuredClone(connection);
      },
    },
  };
  const requirements = [{
    requirementId: "calendar-read",
    label: "Calendar access",
    required: true,
    permissionSummary: "Read selected calendars.",
  }];

  const resolved = await validateRequiredConnectionBindings({
    requirements,
    connectionBindings: [{ requirementId: "calendar-read", connectionId: connection.connectionId }],
    repositories,
    workspaceId: "workspace-consumer",
  });
  assert.deepEqual(resolved, [{ requirementId: "calendar-read", connectionId: connection.connectionId }]);

  await assert.rejects(
    validateRequiredConnectionBindings({ requirements, connectionBindings: [], repositories, workspaceId: "workspace-consumer" }),
    (error) => error.code === "connection_rebind_required",
  );
  await assert.rejects(
    validateRequiredConnectionBindings({
      requirements,
      connectionBindings: [{ requirementId: "calendar-read", connectionId: connection.connectionId }],
      repositories,
      workspaceId: "workspace-publisher",
    }),
    (error) => error.code === "connection_rebind_required",
  );
  await assert.rejects(
    validateRequiredConnectionBindings({
      requirements,
      connectionBindings: [
        { requirementId: "calendar-read", connectionId: connection.connectionId },
        { requirementId: "calendar-read", connectionId: connection.connectionId },
      ],
      repositories,
      workspaceId: "workspace-consumer",
    }),
    (error) => error.code === "connection_binding_invalid",
  );
});
