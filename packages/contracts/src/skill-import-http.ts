import { Type } from "typebox";

import {
  EmptyHeadersSchema,
  EmptyObjectSchema,
  IdempotencyHeadersSchema,
  MutationRequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  type WorkbenchEndpointMetadata,
  WORKBENCH_API_PREFIX,
} from "./http.js";
import { SkillDraftIdSchema, SkillIdSchema } from "./common.js";
import { ScanFindingSchema } from "./lifecycle.js";
import { strictObject, stringEnum } from "./schema.js";

const ServerPathSchema = Type.String({ minLength: 1, maxLength: 2048 });
const RelativeSkillDirectorySchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
});

export const ScanServerSkillsRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({ rootPath: ServerPathSchema }),
  "ScanServerSkillsRequest",
);

export const ImportServerSkillsRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({
    rootPath: ServerPathSchema,
    directories: Type.Array(RelativeSkillDirectorySchema, {
      minItems: 1,
      maxItems: 25,
      uniqueItems: true,
    }),
    attachBuiltInToolPolicy: Type.Optional(Type.Boolean()),
  }),
  "ImportServerSkillsRequest",
);

export const ServerSkillCandidateSchema = strictObject({
  relativeDirectory: RelativeSkillDirectorySchema,
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.String({ minLength: 1, maxLength: 1024 }),
  status: stringEnum(["ready", "invalid"]),
  alreadyExists: Type.Boolean(),
  builtInToolPolicyAvailable: Type.Boolean(),
  findings: Type.Array(ScanFindingSchema, { maxItems: 100 }),
});

export const ServerSkillImportItemSchema = strictObject({
  relativeDirectory: RelativeSkillDirectorySchema,
  status: stringEnum(["imported", "skipped", "failed"]),
  skillId: Type.Optional(SkillIdSchema),
  skillDraftId: Type.Optional(SkillDraftIdSchema),
  code: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

const browserMutationMetadata = {
  mutation: true,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: EmptyHeadersSchema,
  responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: [],
  optionalRequestHeaders: [],
  responseHeaders: [],
} as const;

const idempotentMutationMetadata = {
  ...browserMutationMetadata,
  requestHeadersSchema: IdempotencyHeadersSchema,
  requiredRequestHeaders: ["Idempotency-Key"],
} as const;

export const WORKBENCH_V1_SKILL_IMPORT_ENDPOINTS = {
  scanServerSkills: {
    ...browserMutationMetadata,
    operationId: "scanServerSkills",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/skills/scan`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ScanServerSkillsRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      strictObject({ candidates: Type.Array(ServerSkillCandidateSchema, { maxItems: 100 }) }),
      "ScanServerSkillsResponse",
    ),
  },
  importServerSkills: {
    ...idempotentMutationMetadata,
    operationId: "importServerSkills",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/skills/import`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ImportServerSkillsRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      strictObject({ items: Type.Array(ServerSkillImportItemSchema, { maxItems: 25 }) }),
      "ImportServerSkillsResponse",
    ),
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
