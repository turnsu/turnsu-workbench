import { Type, type Static } from "typebox";

import {
  UtcTimestampSchema,
  WorkspaceIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { WorkspaceRoleSchema } from "./workspace-role.js";
import { strictObject, stringEnum } from "./schema.js";

export const WorkspaceFeatureStateSchema = stringEnum([
  "ready",
  "needs_setup",
  "checking",
  "unavailable",
  "forbidden",
]);

export const WorkspaceFeatureRecoveryActionSchema = stringEnum([
  "none",
  "navigate",
  "retry",
  "contact_admin",
  "use_desktop",
]);

export const WorkspaceFeatureDecisionSchema = strictObject({
  status: WorkspaceFeatureStateSchema,
  reasonCode: Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[a-z][a-z0-9_]*$",
  }),
  message: Type.String({ minLength: 1, maxLength: 500 }),
  recoveryRoute: Type.Union([
    Type.String({ minLength: 1, maxLength: 500, pattern: "^/" }),
    Type.Null(),
  ]),
  action: WorkspaceFeatureRecoveryActionSchema,
});

export const WorkspaceCreationActionReadinessSchema = strictObject({
  draftable: Type.Optional(WorkspaceFeatureDecisionSchema),
  testable: Type.Optional(WorkspaceFeatureDecisionSchema),
  runnable: Type.Optional(WorkspaceFeatureDecisionSchema),
  importable: Type.Optional(WorkspaceFeatureDecisionSchema),
});

export const WorkspaceFeatureReadinessSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    workspaceId: WorkspaceIdSchema,
    workspaceRole: WorkspaceRoleSchema,
    evaluatedAt: UtcTimestampSchema,
    actions: strictObject({
      promptSkill: WorkspaceCreationActionReadinessSchema,
      scriptSkill: WorkspaceCreationActionReadinessSchema,
      registeredToolSkill: WorkspaceCreationActionReadinessSchema,
      skillDirectoryImport: WorkspaceCreationActionReadinessSchema,
      skillZipImport: WorkspaceCreationActionReadinessSchema,
      publicGithubSkillImport: WorkspaceCreationActionReadinessSchema,
      serverSkillImport: WorkspaceCreationActionReadinessSchema,
      blankLoop: WorkspaceCreationActionReadinessSchema,
      stagedLoopProposal: WorkspaceCreationActionReadinessSchema,
      connectionSetup: WorkspaceCreationActionReadinessSchema,
      workspaceResource: WorkspaceCreationActionReadinessSchema,
    }),
    support: strictObject({
      readyRuntimeIds: Type.Array(
        Type.String({ minLength: 1, maxLength: 128 }),
        { uniqueItems: true, maxItems: 32 },
      ),
      registeredToolPackageCount: Type.Integer({ minimum: 0, maximum: 10_000 }),
      selectableBuilderModelCount: Type.Integer({ minimum: 0, maximum: 10_000 }),
      readyAttachmentMediaTypes: Type.Array(
        Type.String({ minLength: 1, maxLength: 128 }),
        { uniqueItems: true, maxItems: 64 },
      ),
      unavailableAttachmentMediaTypes: Type.Array(
        Type.String({ minLength: 1, maxLength: 128 }),
        { uniqueItems: true, maxItems: 64 },
      ),
    }),
  },
  { $id: "WorkspaceFeatureReadiness" },
);

export type WorkspaceFeatureState = Static<typeof WorkspaceFeatureStateSchema>;
export type WorkspaceFeatureDecision = Static<typeof WorkspaceFeatureDecisionSchema>;
export type WorkspaceFeatureReadiness = Static<typeof WorkspaceFeatureReadinessSchema>;
