import { Type, type Static } from "typebox";

import {
  ContentHashSchema,
  DataSchemaSchema,
  EdgeIdSchema,
  JsonValueSchema,
  NodeIdSchema,
  SkillIdSchema,
  VersionSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";
import {
  CanvasPositionSchema,
  InputFormSchema,
  NodeConditionSchema,
  NodeDisplaySchema,
  NodeReviewPolicySchema,
  OutputDefinitionSchema,
  RetryPolicySchema,
  WorkflowDefinitionSchema,
  WorkflowPortSchema,
} from "./workflows.js";

export const PORTABLE_LOOP_PACKAGE_V1_SCHEMA_VERSION =
  "portable-loop-package-v1" as const;
export const PORTABLE_LOOP_PACKAGE_MEDIA_TYPE =
  "application/vnd.looloomi.loop-package+json" as const;

export const PortableLoopPackageV1SchemaVersionSchema = Type.Literal(
  PORTABLE_LOOP_PACKAGE_V1_SCHEMA_VERSION,
);

const localRef = (kind: "skill" | "connection" | "material") =>
  Type.String({
    minLength: 3,
    maxLength: 128,
    pattern: `^${kind}:[A-Za-z0-9][A-Za-z0-9._:-]*$`,
  });

export const PortableSkillRefSchema = localRef("skill");
export const PortableConnectionRefSchema = localRef("connection");
export const PortableMaterialRefSchema = localRef("material");

export const PortableSkillRequirementSchema = strictObject(
  {
    ref: PortableSkillRefSchema,
    skillId: SkillIdSchema,
    version: VersionSchema,
    contentHash: ContentHashSchema,
    connectionRefs: Type.Array(PortableConnectionRefSchema, {
      uniqueItems: true,
    }),
  },
  { $id: "PortableSkillRequirement" },
);

export const PortableConnectionCapabilityRequirementSchema = strictObject(
  {
    ref: PortableConnectionRefSchema,
    capabilityKey: Type.String({ minLength: 1, maxLength: 128 }),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    required: Type.Boolean(),
    permissionSummary: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { $id: "PortableConnectionCapabilityRequirement" },
);

export const PortableMaterialRequirementSchema = strictObject(
  {
    ref: PortableMaterialRefSchema,
    label: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ maxLength: 2000 }),
    required: Type.Boolean(),
    acceptedMediaTypes: Type.Array(
      Type.String({ minLength: 1, maxLength: 128 }),
      { minItems: 1, uniqueItems: true },
    ),
    contentHash: Type.Optional(ContentHashSchema),
  },
  { $id: "PortableMaterialRequirement" },
);

export const PortableEmbeddedMaterialMediaTypeSchema = stringEnum([
  "text/plain",
  "text/markdown",
  "application/json",
]);

export const PortableEmbeddedMaterialSchema = strictObject(
  {
    materialRef: PortableMaterialRefSchema,
    mediaType: PortableEmbeddedMaterialMediaTypeSchema,
    encoding: Type.Literal("utf-8"),
    content: Type.String({ maxLength: 262144 }),
    byteLength: Type.Integer({ minimum: 0, maximum: 1048576 }),
    contentHash: ContentHashSchema,
  },
  { $id: "PortableEmbeddedMaterial" },
);

export const PortableLoopRequirementsSchema = strictObject(
  {
    skills: Type.Array(PortableSkillRequirementSchema),
    connections: Type.Array(PortableConnectionCapabilityRequirementSchema),
    materials: Type.Array(PortableMaterialRequirementSchema),
  },
  { $id: "PortableLoopRequirements" },
);

export const PortableRunInputBindingSourceSchema = strictObject({
  kind: Type.Literal("runInput"),
  inputKey: Type.String({ minLength: 1, maxLength: 128 }),
});

export const PortableNodeOutputBindingSourceSchema = strictObject({
  kind: Type.Literal("nodeOutput"),
  nodeId: NodeIdSchema,
  portId: Type.String({ minLength: 1, maxLength: 128 }),
});

export const PortableLiteralBindingSourceSchema = strictObject({
  kind: Type.Literal("literal"),
  value: JsonValueSchema,
});

export const PortableMaterialBindingSourceSchema = strictObject({
  kind: Type.Literal("material"),
  materialRef: PortableMaterialRefSchema,
});

export const PortableInputBindingSourceSchema = Type.Union([
  PortableRunInputBindingSourceSchema,
  PortableNodeOutputBindingSourceSchema,
  PortableLiteralBindingSourceSchema,
  PortableMaterialBindingSourceSchema,
]);

export const PortableInputBindingSchema = strictObject({
  targetPort: Type.String({ minLength: 1, maxLength: 128 }),
  source: PortableInputBindingSourceSchema,
});

const PortableNodeBaseProperties = {
  nodeId: NodeIdSchema,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 2000 }),
  position: CanvasPositionSchema,
  inputPorts: Type.Array(WorkflowPortSchema),
  outputPorts: Type.Array(WorkflowPortSchema),
  inputBindings: Type.Array(PortableInputBindingSchema),
  reviewPolicy: NodeReviewPolicySchema,
  retryPolicy: RetryPolicySchema,
  timeoutSeconds: Type.Integer({ minimum: 1, maximum: 86400 }),
  condition: Type.Optional(NodeConditionSchema),
  display: NodeDisplaySchema,
};

export const PortableInputNodeSchema = strictObject({
  ...PortableNodeBaseProperties,
  kind: Type.Literal("Input"),
  configuration: strictObject({
    fieldIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      uniqueItems: true,
    }),
  }),
});

export const PortableSkillNodeSchema = strictObject({
  ...PortableNodeBaseProperties,
  kind: Type.Literal("Skill"),
  skillRef: PortableSkillRefSchema,
  configuration: strictObject({}),
});

export const PortableMaterialNodeSchema = strictObject({
  ...PortableNodeBaseProperties,
  kind: Type.Literal("Material"),
  configuration: strictObject({
    materialRefs: Type.Array(PortableMaterialRefSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
  }),
});

export const PortableTransformNodeSchema = strictObject({
  ...PortableNodeBaseProperties,
  kind: Type.Literal("Transform"),
  configuration: strictObject({
    mode: stringEnum(["mapping", "boundedAgent"]),
    expression: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  }),
});

export const PortableReviewGateNodeSchema = strictObject({
  ...PortableNodeBaseProperties,
  kind: Type.Literal("ReviewGate"),
  configuration: strictObject({
    instructions: Type.String({ minLength: 1, maxLength: 2000 }),
    allowRevision: Type.Boolean(),
    revisionTarget: Type.Optional(
      strictObject({
        nodeId: NodeIdSchema,
        portId: Type.String({ minLength: 1, maxLength: 128 }),
      }),
    ),
  }),
});

export const PortableOutputNodeSchema = strictObject({
  ...PortableNodeBaseProperties,
  kind: Type.Literal("Output"),
  configuration: strictObject({
    format: stringEnum(["markdown", "text", "json"]),
  }),
});

export const PortableWorkflowNodeSchema = Type.Union(
  [
    PortableInputNodeSchema,
    PortableSkillNodeSchema,
    PortableMaterialNodeSchema,
    PortableTransformNodeSchema,
    PortableReviewGateNodeSchema,
    PortableOutputNodeSchema,
  ],
  { $id: "PortableWorkflowNode" },
);

export const PortableWorkflowEdgeSchema = strictObject(
  {
    edgeId: EdgeIdSchema,
    sourceNodeId: NodeIdSchema,
    sourcePort: Type.String({ minLength: 1, maxLength: 128 }),
    targetNodeId: NodeIdSchema,
    targetPort: Type.String({ minLength: 1, maxLength: 128 }),
    mappingExpression: Type.Optional(
      Type.String({ minLength: 1, maxLength: 4000 }),
    ),
  },
  { $id: "PortableWorkflowEdge" },
);

export const PortableWorkflowGraphSchema = strictObject(
  {
    nodes: Type.Array(PortableWorkflowNodeSchema),
    edges: Type.Array(PortableWorkflowEdgeSchema),
  },
  { $id: "PortableWorkflowGraph" },
);

export const PortableExecutionSettingsSchema = strictObject({
  maxParallelism: Type.Literal(1),
  defaultTimeoutSeconds: Type.Integer({ minimum: 1, maximum: 86400 }),
  workflowFallbackAllowed: Type.Boolean(),
});

export const PortableLoopPackageV1Schema = strictObject(
  {
    schemaVersion: PortableLoopPackageV1SchemaVersionSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ maxLength: 2000 }),
    definition: WorkflowDefinitionSchema,
    graph: PortableWorkflowGraphSchema,
    inputForm: InputFormSchema,
    outputDefinition: OutputDefinitionSchema,
    requirements: PortableLoopRequirementsSchema,
    embeddedMaterials: Type.Array(PortableEmbeddedMaterialSchema, {
      maxItems: 32,
    }),
    executionSettings: PortableExecutionSettingsSchema,
  },
  { $id: "PortableLoopPackageV1" },
);

export type PortableSkillRequirement = Static<
  typeof PortableSkillRequirementSchema
>;
export type PortableConnectionCapabilityRequirement = Static<
  typeof PortableConnectionCapabilityRequirementSchema
>;
export type PortableMaterialRequirement = Static<
  typeof PortableMaterialRequirementSchema
>;
export type PortableEmbeddedMaterial = Static<
  typeof PortableEmbeddedMaterialSchema
>;
export type PortableLoopPackageV1 = Static<typeof PortableLoopPackageV1Schema>;
