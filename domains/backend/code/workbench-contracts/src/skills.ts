import { Type, type Static } from "typebox";

import {
  DataSchemaSchema,
  DiagnosticSchema,
  SkillIdSchema,
  UtcTimestampSchema,
  VersionSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";

export const PinnedSkillRefSchema = strictObject(
  {
    skillId: SkillIdSchema,
    version: VersionSchema,
  },
  { $id: "PinnedSkillRef" },
);

export const LocalizedDisplayValueSchema = strictObject({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ minLength: 1, maxLength: 2000 }),
});

export const LocalizedDisplaySchema = strictObject({
  defaultLocale: Type.String({
    minLength: 2,
    maxLength: 35,
    pattern: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$",
  }),
  localized: Type.Record(Type.String(), LocalizedDisplayValueSchema, {
    additionalProperties: false,
  }),
});

export const SkillStatusSchema = stringEnum([
  "draft",
  "validating",
  "ready",
  "blocked",
  "retired",
]);

export const SkillRiskSchema = strictObject({
  level: stringEnum(["low", "medium", "high"]),
  externalAction: Type.Boolean(),
  summary: Type.String({ minLength: 1, maxLength: 1000 }),
});

export const SkillDependencySchema = strictObject({
  kind: stringEnum(["skill", "resource", "connection"]),
  id: Type.String({ minLength: 1, maxLength: 128 }),
  version: Type.Optional(VersionSchema),
  required: Type.Boolean(),
});

export const SetupCheckSchema = strictObject({
  checkId: Type.String({ minLength: 1, maxLength: 128 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  status: stringEnum(["pending", "passed", "failed"]),
  message: Type.String({ minLength: 1, maxLength: 1000 }),
});

export const SkillExecutionRefSchema = strictObject({
  capabilityId: Type.String({ minLength: 1, maxLength: 128 }),
  taskIntent: Type.String({ minLength: 1, maxLength: 128 }),
  adapterVersion: VersionSchema,
  executionMode: stringEnum(["agent", "deterministic"]),
});

export const SkillReadinessSchema = strictObject({
  status: stringEnum(["ready", "blocked", "unknown"]),
  diagnostics: Type.Array(DiagnosticSchema),
});

export const SkillDefinitionSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    skillId: SkillIdSchema,
    version: VersionSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    category: Type.String({ minLength: 1, maxLength: 100 }),
    display: LocalizedDisplaySchema,
    status: SkillStatusSchema,
    inputSchema: DataSchemaSchema,
    outputSchema: DataSchemaSchema,
    risk: SkillRiskSchema,
    dependencies: Type.Array(SkillDependencySchema),
    setupChecks: Type.Array(SetupCheckSchema),
    executionRef: SkillExecutionRefSchema,
    usageCount: Type.Integer({ minimum: 0 }),
    readiness: SkillReadinessSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "SkillDefinition" },
);

export const SkillCatalogItemSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    skillId: SkillIdSchema,
    version: VersionSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    category: Type.String({ minLength: 1, maxLength: 100 }),
    display: LocalizedDisplaySchema,
    status: SkillStatusSchema,
    inputSchema: DataSchemaSchema,
    outputSchema: DataSchemaSchema,
    risk: SkillRiskSchema,
    dependencies: Type.Array(SkillDependencySchema),
    setupChecks: Type.Array(SetupCheckSchema),
    usageCount: Type.Integer({ minimum: 0 }),
    readiness: SkillReadinessSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "SkillCatalogItem" },
);

export type PinnedSkillRef = Static<typeof PinnedSkillRefSchema>;
export type LocalizedDisplay = Static<typeof LocalizedDisplaySchema>;
export type SkillDefinition = Static<typeof SkillDefinitionSchema>;
export type SkillCatalogItem = Static<typeof SkillCatalogItemSchema>;
