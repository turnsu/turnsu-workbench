import { WORKBENCH_V1_MODEL_ENDPOINTS } from "@turnsu/workbench-contracts/model-http";

import {
  createBrowserSessionProductClient,
  type BrowserSessionTransportOptions,
  type ProductClient,
} from "./index.js";

type ModelProductEndpoints = readonly [
  typeof WORKBENCH_V1_MODEL_ENDPOINTS.createModelProfile,
  typeof WORKBENCH_V1_MODEL_ENDPOINTS.listModelProfiles,
  typeof WORKBENCH_V1_MODEL_ENDPOINTS.selectAgentSessionModel,
];

const MODEL_PRODUCT_ENDPOINTS: ModelProductEndpoints = [
  WORKBENCH_V1_MODEL_ENDPOINTS.createModelProfile,
  WORKBENCH_V1_MODEL_ENDPOINTS.listModelProfiles,
  WORKBENCH_V1_MODEL_ENDPOINTS.selectAgentSessionModel,
];

export function createModelProductClient(
  options: BrowserSessionTransportOptions = {},
): ProductClient<ModelProductEndpoints> {
  return createBrowserSessionProductClient(MODEL_PRODUCT_ENDPOINTS, options);
}
