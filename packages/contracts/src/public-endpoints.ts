import { WORKBENCH_V1_MEMBER_AGENT_ENDPOINTS } from "./member-agent-http.js";
import { WORKBENCH_V1_AGENT_ENDPOINTS } from "./agent-http.js";
import { WORKBENCH_V1_ARTIFACT_ENDPOINTS } from "./artifact-http.js";
import { WORKBENCH_V1_ATTACHMENT_ENDPOINTS } from "./attachment-http.js";
import { WORKBENCH_V1_AUTH_ENDPOINTS } from "./auth-http.js";
import { WORKBENCH_V1_AUTOMATION_ENDPOINTS } from "./automation-http.js";
import { WORKBENCH_V1_DEVICE_ENDPOINTS } from "./devices-http.js";
import {
  WORKBENCH_V1_ENDPOINTS,
  type WorkbenchEndpointMetadata,
} from "./http.js";
import { WORKBENCH_V1_INBOX_ENDPOINTS } from "./inbox-http.js";
import { WORKBENCH_V1_LIFECYCLE_ENDPOINTS } from "./lifecycle-http.js";
import { WORKBENCH_V1_MEMORY_ENDPOINTS } from "./memory-http.js";
import { WORKBENCH_V1_MODEL_ENDPOINTS } from "./model-http.js";
import { WORKBENCH_V1_READINESS_ENDPOINTS } from "./readiness-http.js";
import { WORKBENCH_V1_SKILL_IMPORT_ENDPOINTS } from "./skill-import-http.js";
import { WORKBENCH_V1_SCOPE_ENDPOINTS } from "./scope-http.js";
import { WORKBENCH_V1_SESSION_LEDGER_ENDPOINTS } from "./session-ledger-http.js";
import { WORKBENCH_V1_TRACE_ENDPOINTS } from "./trace-http.js";
import { WORKBENCH_V1_WORK_ITEM_ENDPOINTS } from "./work-items-http.js";

type EndpointOf<Endpoints> = Endpoints[keyof Endpoints];

export type PublicEndpoint =
  | EndpointOf<typeof WORKBENCH_V1_MEMBER_AGENT_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_AUTH_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_AUTOMATION_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_DEVICE_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_LIFECYCLE_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_AGENT_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_MEMORY_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_MODEL_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_ARTIFACT_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_ATTACHMENT_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_INBOX_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_TRACE_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_READINESS_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_SKILL_IMPORT_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_SCOPE_ENDPOINTS>
  | EndpointOf<typeof WORKBENCH_V1_SESSION_LEDGER_ENDPOINTS>;

export type PublicEndpointOperationId = PublicEndpoint["operationId"];

/**
 * The complete public Product API surface. Endpoint objects remain owned by their
 * domain contract modules; this registry only provides one authoritative index.
 */
export const PUBLIC_ENDPOINTS: readonly PublicEndpoint[] = Object.freeze([
  ...Object.values(WORKBENCH_V1_MEMBER_AGENT_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_AUTH_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_AUTOMATION_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_DEVICE_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_LIFECYCLE_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_AGENT_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_MEMORY_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_MODEL_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_ARTIFACT_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_ATTACHMENT_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_INBOX_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_TRACE_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_WORK_ITEM_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_READINESS_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_SKILL_IMPORT_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_SCOPE_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_SESSION_LEDGER_ENDPOINTS),
] as const satisfies readonly WorkbenchEndpointMetadata[]);
