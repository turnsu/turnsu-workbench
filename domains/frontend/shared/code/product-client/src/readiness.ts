import { WORKBENCH_V1_READINESS_ENDPOINTS } from "@looloomi/workbench-contracts/readiness-http";

import {
  createBrowserSessionProductClient,
  type BrowserSessionTransportOptions,
  type ProductClient,
} from "./index.js";

type ReadinessProductEndpoints = readonly [
  typeof WORKBENCH_V1_READINESS_ENDPOINTS.getWorkspaceFeatureReadiness,
];

const READINESS_PRODUCT_ENDPOINTS: ReadinessProductEndpoints = [
  WORKBENCH_V1_READINESS_ENDPOINTS.getWorkspaceFeatureReadiness,
];

export function createReadinessProductClient(
  options: BrowserSessionTransportOptions = {},
): ProductClient<ReadinessProductEndpoints> {
  return createBrowserSessionProductClient(READINESS_PRODUCT_ENDPOINTS, options);
}
