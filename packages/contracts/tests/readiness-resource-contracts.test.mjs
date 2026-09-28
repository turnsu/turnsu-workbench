import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  CreateResourceFromAttachmentRequestSchema,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS,
  WORKBENCH_V1_READINESS_ENDPOINTS,
  WorkspaceFeatureReadinessSchema,
} from "../dist/index.js";

const readiness = {
  schemaVersion: "workbench-v1",
  workspaceId: "workspace-contract",
  workspaceRole: "member",
  evaluatedAt: "2026-07-30T00:00:00.000Z",
  actions: {
    promptSkill: {
      draftable: {
        status: "ready",
        reasonCode: "ready",
        message: "A private Draft can be created.",
        recoveryRoute: null,
        action: "none",
      },
      testable: {
        status: "needs_setup",
        reasonCode: "model_route_unresolved",
        message: "Configure a model before testing.",
        recoveryRoute: "/library?setup=models",
        action: "contact_admin",
      },
    },
    scriptSkill: {},
    registeredToolSkill: {},
    skillDirectoryImport: {},
    skillZipImport: {},
    publicGithubSkillImport: {},
    serverSkillImport: {},
    blankLoop: {},
    stagedLoopProposal: {
      draftable: {
        status: "checking",
        reasonCode: "agent_container_backend_checking",
        message: "The sandbox is being checked.",
        recoveryRoute: "/loops/new?mode=document",
        action: "retry",
      },
    },
    connectionSetup: {},
    workspaceResource: {},
  },
  support: {
    readyRuntimeIds: [],
    registeredToolPackageCount: 0,
    selectableBuilderModelCount: 0,
    readyAttachmentMediaTypes: ["image/png"],
    unavailableAttachmentMediaTypes: ["application/msword"],
  },
};

test("workspace readiness is strict, operation-specific, and private no-store", () => {
  assert.equal(Check(WorkspaceFeatureReadinessSchema, readiness), true);
  assert.equal(Check(WorkspaceFeatureReadinessSchema, {
    ...readiness,
    providerEndpoint: "https://provider.invalid",
  }), false);
  const endpoint = WORKBENCH_V1_READINESS_ENDPOINTS.getWorkspaceFeatureReadiness;
  assert.equal(endpoint.method, "GET");
  assert.equal(endpoint.path, "/api/workbench/v1/workspace/feature-readiness");
  assert.deepEqual(endpoint.responseHeaders, ["Cache-Control"]);
  assert.equal(Check(endpoint.responseHeadersSchema, {
    "Cache-Control": "private, no-store",
  }), true);
});

test("Attachment promotion accepts only an immutable Product ref and never host paths or bytes", () => {
  const request = {
    schemaVersion: "workbench-api-v1",
    data: {
      label: "Research source",
      attachment: {
        attachmentId: "attachment-contract",
        version: 1,
        contentHash: `sha256:${"a".repeat(64)}`,
        mediaType: "application/pdf",
      },
    },
  };
  assert.equal(Check(CreateResourceFromAttachmentRequestSchema, request), true);
  assert.equal(Check(CreateResourceFromAttachmentRequestSchema, {
    ...request,
    data: { ...request.data, hostPath: "/tmp/source.pdf" },
  }), false);
  assert.equal(
    WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createResourceFromAttachment.path,
    "/api/workbench/v1/resources/from-attachment",
  );
  assert.deepEqual(
    WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createResourceFromAttachment.requiredRequestHeaders,
    ["Idempotency-Key"],
  );
});
