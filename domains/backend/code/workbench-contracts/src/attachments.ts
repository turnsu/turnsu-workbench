import { Type, type Static } from "typebox";

import {
  AttachmentIdSchema,
  ContentHashSchema,
  DerivedRepresentationIdSchema,
  ResourceRefSchema,
  UtcTimestampSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";

export const AttachmentMediaTypeSchema = stringEnum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const AttachmentScopeSchema = stringEnum([
  "personal",
  "object",
  "workspace",
]);

export const AttachmentProcessingStatusSchema = stringEnum([
  "processing",
  "ready",
  "blocked",
  "failed",
  "deleted",
  "expired",
]);

export const AttachmentErrorCodeSchema = stringEnum([
  "attachment_format_unsupported",
  "attachment_ocr_required",
  "attachment_too_large",
  "attachment_limit_exceeded",
  "attachment_integrity_failed",
  "attachment_mime_mismatch",
  "attachment_macro_forbidden",
  "attachment_path_traversal",
  "attachment_malicious_package",
  "attachment_processing_unavailable",
  "attachment_processing_failed",
  "attachment_expired",
  "attachment_deleted",
  "attachment_forbidden",
]);

export const AttachmentRefSchema = strictObject(
  {
    attachmentId: AttachmentIdSchema,
    version: Type.Integer({ minimum: 1 }),
    contentHash: ContentHashSchema,
    mediaType: AttachmentMediaTypeSchema,
  },
  { $id: "AttachmentRef" },
);

export const AttachmentProcessingStateSchema = strictObject({
  status: AttachmentProcessingStatusSchema,
  code: Type.Union([AttachmentErrorCodeSchema, Type.Null()]),
  message: Type.String({ maxLength: 1000 }),
  retryable: Type.Boolean(),
});

export const InputAttachmentSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    attachmentId: AttachmentIdSchema,
    version: Type.Integer({ minimum: 1 }),
    workspaceId: WorkspaceIdSchema,
    ownerUserId: UserIdSchema,
    scope: AttachmentScopeSchema,
    fileName: Type.String({ minLength: 1, maxLength: 255 }),
    mediaType: AttachmentMediaTypeSchema,
    sizeBytes: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
    contentHash: ContentHashSchema,
    source: Type.Literal("user_upload"),
    processing: AttachmentProcessingStateSchema,
    expiresAt: UtcTimestampSchema,
    deletedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "InputAttachment" },
);

export const AttachmentEvidenceLocatorSchema = strictObject({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  sheet: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  paragraph: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  rowStart: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  rowEnd: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  characterStart: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000 })),
  characterEnd: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000 })),
});

export const DerivedRepresentationSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    representationId: DerivedRepresentationIdSchema,
    attachment: AttachmentRefSchema,
    kind: stringEnum([
      "binary_reference",
      "utf8_text",
      "document_text",
      "spreadsheet_tables",
    ]),
    contentHash: ContentHashSchema,
    characterCount: Type.Integer({ minimum: 0, maximum: 2_000_000 }),
    evidence: Type.Array(AttachmentEvidenceLocatorSchema, { maxItems: 10_000 }),
    createdAt: UtcTimestampSchema,
  },
  { $id: "DerivedRepresentation" },
);

export const AttachmentProcessingResultSchema = strictObject(
  {
    attachment: InputAttachmentSchema,
    representations: Type.Array(DerivedRepresentationSchema, {
      maxItems: 512,
    }),
  },
  { $id: "AttachmentProcessingResult" },
);

export const AttachmentMaterialSourceSchema = Type.Union([
  strictObject({
    kind: Type.Literal("attachment"),
    attachment: AttachmentRefSchema,
  }),
  strictObject({
    kind: Type.Literal("workspace_resource"),
    resource: ResourceRefSchema,
  }),
]);

export const SkillMaterialBindingSchema = strictObject(
  {
    materialKey: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    }),
    source: AttachmentMaterialSourceSchema,
  },
  { $id: "SkillMaterialBinding" },
);

export type AttachmentMediaType = Static<typeof AttachmentMediaTypeSchema>;
export type AttachmentRef = Static<typeof AttachmentRefSchema>;
export type InputAttachment = Static<typeof InputAttachmentSchema>;
export type DerivedRepresentation = Static<typeof DerivedRepresentationSchema>;
export type AttachmentProcessingResult = Static<
  typeof AttachmentProcessingResultSchema
>;
export type SkillMaterialBinding = Static<typeof SkillMaterialBindingSchema>;
