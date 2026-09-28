import {
  WORKBENCH_V1_SCOPE_ENDPOINTS,
} from "@turnsu/workbench-contracts/scope-http";

import {
  createBrowserSessionProductClient,
  type BrowserSessionTransportOptions,
  type ProductClient,
} from "./index.js";

type ScopeProductEndpoints = readonly [
  typeof WORKBENCH_V1_SCOPE_ENDPOINTS.listScopes,
  typeof WORKBENCH_V1_SCOPE_ENDPOINTS.getScope,
  typeof WORKBENCH_V1_SCOPE_ENDPOINTS.reviseScopePolicy,
];

const SCOPE_PRODUCT_ENDPOINTS: ScopeProductEndpoints = [
  WORKBENCH_V1_SCOPE_ENDPOINTS.listScopes,
  WORKBENCH_V1_SCOPE_ENDPOINTS.getScope,
  WORKBENCH_V1_SCOPE_ENDPOINTS.reviseScopePolicy,
];

export function createScopeProductClient(
  options: BrowserSessionTransportOptions = {},
): ProductClient<ScopeProductEndpoints> {
  return createBrowserSessionProductClient(SCOPE_PRODUCT_ENDPOINTS, options);
}
