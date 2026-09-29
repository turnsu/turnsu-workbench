import { Type, type Static } from "typebox";

import {
  DeviceIdSchema,
  UserIdSchema,
  UtcTimestampSchema,
  WorkbenchSchemaVersionSchema,
  WorkspaceIdSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";

/**
 * Product Device is a registered native shell identity, not a generic Worker
 * endpoint. The native public key stays in the shell/session store; callers
 * only receive its stable fingerprint.
 */
export const DevicePlatformSchema = stringEnum(["macos", "windows"] as const);
export const DeviceArchitectureSchema = stringEnum(["arm64", "x64"] as const);
export const DeviceRegistrationStatusSchema = stringEnum(["active", "revoked"] as const);
export const DeviceHealthSchema = stringEnum([
  "ready",
  "offline",
  "incompatible",
  "revoked",
] as const);
export const DeviceCapabilitySchema = stringEnum([
  "file_read",
  "file_write",
  "notification",
  "voice_input",
  "sandbox_oci",
  "local_deterministic_skill",
] as const);
export const DevicePublicIdentitySchema = Type.String({
  minLength: 71,
  maxLength: 71,
  pattern: "^sha256:[a-f0-9]{64}$",
});

export const DeviceSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    deviceId: DeviceIdSchema,
    workspaceId: WorkspaceIdSchema,
    ownerUserId: UserIdSchema,
    displayName: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
    platform: DevicePlatformSchema,
    architecture: DeviceArchitectureSchema,
    appVersion: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
    workerProtocolVersion: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
    publicIdentity: DevicePublicIdentitySchema,
    capabilityInventory: Type.Array(DeviceCapabilitySchema, {
      maxItems: 16,
      uniqueItems: true,
    }),
    registrationStatus: DeviceRegistrationStatusSchema,
    health: DeviceHealthSchema,
    lastSeenAt: UtcTimestampSchema,
    updateRequired: Type.Boolean(),
    revision: Type.Integer({ minimum: 1 }),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    revokedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  },
  { $id: "Device" },
);

export type DevicePlatform = Static<typeof DevicePlatformSchema>;
export type DeviceArchitecture = Static<typeof DeviceArchitectureSchema>;
export type DeviceRegistrationStatus = Static<typeof DeviceRegistrationStatusSchema>;
export type DeviceHealth = Static<typeof DeviceHealthSchema>;
export type DeviceCapability = Static<typeof DeviceCapabilitySchema>;
export type Device = Static<typeof DeviceSchema>;
