import { WORKBENCH_V1_WORKSPACE_ENDPOINTS } from "@turnsu/workbench-contracts/workspace-http";

import {
  createBrowserSessionProductClient,
  type BrowserSessionTransportOptions,
  type ProductClient,
} from "./index.js";

type WorkspaceProductEndpoints = readonly [
  typeof WORKBENCH_V1_WORKSPACE_ENDPOINTS.workspace,
];

const WORKSPACE_PRODUCT_ENDPOINTS: WorkspaceProductEndpoints = [
  WORKBENCH_V1_WORKSPACE_ENDPOINTS.workspace,
];

export function createWorkspaceProductClient(
  options: BrowserSessionTransportOptions = {},
): ProductClient<WorkspaceProductEndpoints> {
  return createBrowserSessionProductClient(WORKSPACE_PRODUCT_ENDPOINTS, options);
}
