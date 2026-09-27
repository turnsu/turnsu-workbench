import { WORKBENCH_V1_RUN_ENDPOINTS } from "@looloomi/workbench-contracts/runs-http";

import {
  createBrowserSessionProductClient,
  type BrowserSessionTransportOptions,
  type ProductClient,
} from "./index.js";

type RunProductEndpoints = readonly [
  typeof WORKBENCH_V1_RUN_ENDPOINTS.getRun,
  typeof WORKBENCH_V1_RUN_ENDPOINTS.submitReviewDecision,
  typeof WORKBENCH_V1_RUN_ENDPOINTS.cancelRun,
  typeof WORKBENCH_V1_RUN_ENDPOINTS.retryRun,
];

const RUN_PRODUCT_ENDPOINTS: RunProductEndpoints = [
  WORKBENCH_V1_RUN_ENDPOINTS.getRun,
  WORKBENCH_V1_RUN_ENDPOINTS.submitReviewDecision,
  WORKBENCH_V1_RUN_ENDPOINTS.cancelRun,
  WORKBENCH_V1_RUN_ENDPOINTS.retryRun,
];

export function createRunProductClient(
  options: BrowserSessionTransportOptions = {},
): ProductClient<RunProductEndpoints> {
  return createBrowserSessionProductClient(RUN_PRODUCT_ENDPOINTS, options);
}
