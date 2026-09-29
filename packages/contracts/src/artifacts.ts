import { Type, type Static } from "typebox";

import {
  AgentSessionIdSchema,
  AgentTurnIdSchema,
  ArtifactIdSchema,
  ContentHashSchema,
  ExecutionAttemptIdSchema,
  InvocationIdSchema,
  ModelProfileRevisionIdSchema,
  NodeIdSchema,
  RunIdSchema,
  UtcTimestampSchema,
  WorkspaceIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";

export const ArtifactMediaTypeSchema = stringEnum([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export const ArtifactRefSchema = strictObject(
  {
    artifactId: ArtifactIdSchema,
    mediaType: ArtifactMediaTypeSchema,
  },
  { $id: "ArtifactRef" },
);

export const ArtifactDimensionsSchema = strictObject({
  width: Type.Integer({ minimum: 1, maximum: 32_768 }),
  height: Type.Integer({ minimum: 1, maximum: 32_768 }),
});

export const AgentTurnArtifactSourceSchema = strictObject({
  kind: Type.Literal("agent_turn"),
  sessionId: AgentSessionIdSchema,
  turnId: AgentTurnIdSchema,
  invocationId: InvocationIdSchema,
  attemptId: ExecutionAttemptIdSchema,
});

export const WorkflowRunArtifactSourceSchema = strictObject({
  kind: Type.Literal("workflow_run"),
  runId: RunIdSchema,
  nodeId: NodeIdSchema,
  invocationId: InvocationIdSchema,
  attemptId: ExecutionAttemptIdSchema,
});

export const ArtifactSourceSchema = Type.Union([
  AgentTurnArtifactSourceSchema,
  WorkflowRunArtifactSourceSchema,
]);

export const ArtifactMetadataSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    artifactId: ArtifactIdSchema,
    workspaceId: WorkspaceIdSchema,
    state: Type.Literal("ready"),
    mediaType: ArtifactMediaTypeSchema,
    byteLength: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
    contentHash: ContentHashSchema,
    dimensions: ArtifactDimensionsSchema,
    source: ArtifactSourceSchema,
    requestedModelRevisionId: ModelProfileRevisionIdSchema,
    actualModelRevisionId: ModelProfileRevisionIdSchema,
    createdAt: UtcTimestampSchema,
    expiresAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  },
  { $id: "ArtifactMetadata" },
);

export type ArtifactMediaType = Static<typeof ArtifactMediaTypeSchema>;
export type ArtifactRef = Static<typeof ArtifactRefSchema>;
export type ArtifactMetadata = Static<typeof ArtifactMetadataSchema>;
