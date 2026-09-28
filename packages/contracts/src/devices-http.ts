import { Type } from "typebox";

import { DeviceIdSchema } from "./common.js";
import {
  DeviceArchitectureSchema,
  DeviceCapabilitySchema,
  DevicePlatformSchema,
  DeviceSchema,
} from "./devices.js";
import {
  EmptyHeadersSchema,
  EmptyObjectSchema,
  IdempotencyHeadersSchema,
  ListResponseEnvelopeSchema,
  MutationRequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  type WorkbenchEndpointMetadata,
  WORKBENCH_API_PREFIX,
} from "./endpoint-core.js";
import { strictObject } from "./schema.js";

const privateReadMetadata = {
  mutation: false,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: EmptyHeadersSchema,
  responseHeadersSchema: strictObject({
    "Cache-Control": Type.Literal("private, no-store"),
  }),
  requiredRequestHeaders: [],
  optionalRequestHeaders: [],
  responseHeaders: ["Cache-Control"],
} as const;

const privateMutationMetadata = {
  mutation: true,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: IdempotencyHeadersSchema,
  responseHeadersSchema: strictObject({
    "Cache-Control": Type.Literal("private, no-store"),
  }),
  requiredRequestHeaders: ["Idempotency-Key"],
  optionalRequestHeaders: [],
  responseHeaders: ["Cache-Control"],
} as const;

const DevicePathParamsSchema = strictObject({ deviceId: DeviceIdSchema });

const DeviceRegistrationDataSchema = strictObject({
  displayName: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
  platform: DevicePlatformSchema,
  architecture: DeviceArchitectureSchema,
  appVersion: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
  workerProtocolVersion: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
  capabilityInventory: Type.Array(DeviceCapabilitySchema, { maxItems: 16, uniqueItems: true }),
});

const DeviceHeartbeatDataSchema = strictObject({
  appVersion: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
  workerProtocolVersion: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
  capabilityInventory: Type.Array(DeviceCapabilitySchema, { maxItems: 16, uniqueItems: true }),
});

const DeviceRevocationDataSchema = strictObject({
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, pattern: "\\S" })),
});

export const RegisterDeviceRequestSchema = MutationRequestEnvelopeSchema(
  DeviceRegistrationDataSchema,
  "RegisterDeviceRequest",
);
export const DeviceHeartbeatRequestSchema = MutationRequestEnvelopeSchema(
  DeviceHeartbeatDataSchema,
  "DeviceHeartbeatRequest",
);
export const RevokeDeviceRequestSchema = MutationRequestEnvelopeSchema(
  DeviceRevocationDataSchema,
  "RevokeDeviceRequest",
);
export const DeviceResponseSchema = ResponseEnvelopeSchema(DeviceSchema, "DeviceResponse");
export const DeviceListResponseSchema = ListResponseEnvelopeSchema(DeviceSchema, "DeviceListResponse");

export const WORKBENCH_V1_DEVICE_ENDPOINTS = {
  listDevices: {
    ...privateReadMetadata,
    operationId: "listDevices",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/devices`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: DeviceListResponseSchema,
  },
  registerDevice: {
    ...privateMutationMetadata,
    operationId: "registerDevice",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/devices`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: RegisterDeviceRequestSchema,
    responseBodySchema: DeviceResponseSchema,
  },
  getDevice: {
    ...privateReadMetadata,
    operationId: "getDevice",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/devices/{deviceId}`,
    pathParamsSchema: DevicePathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: DeviceResponseSchema,
  },
  heartbeatDevice: {
    ...privateMutationMetadata,
    operationId: "heartbeatDevice",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/devices/{deviceId}/heartbeat`,
    pathParamsSchema: DevicePathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: DeviceHeartbeatRequestSchema,
    responseBodySchema: DeviceResponseSchema,
  },
  revokeDevice: {
    ...privateMutationMetadata,
    operationId: "revokeDevice",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/devices/{deviceId}/revoke`,
    pathParamsSchema: DevicePathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: RevokeDeviceRequestSchema,
    responseBodySchema: DeviceResponseSchema,
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
