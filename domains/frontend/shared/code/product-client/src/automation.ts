import {
  WORKBENCH_V1_AUTOMATION_ENDPOINTS,
} from "@looloomi/workbench-contracts/automation-http";

import {
  createBrowserSessionProductClient,
  type BrowserSessionTransportOptions,
  type ProductClient,
} from "./index.js";

type AutomationProductEndpoints = readonly [
  typeof WORKBENCH_V1_AUTOMATION_ENDPOINTS.listAutomations,
  typeof WORKBENCH_V1_AUTOMATION_ENDPOINTS.listAutomationCandidates,
  typeof WORKBENCH_V1_AUTOMATION_ENDPOINTS.createAutomation,
  typeof WORKBENCH_V1_AUTOMATION_ENDPOINTS.getAutomation,
  typeof WORKBENCH_V1_AUTOMATION_ENDPOINTS.reviseAutomation,
  typeof WORKBENCH_V1_AUTOMATION_ENDPOINTS.activateAutomation,
  typeof WORKBENCH_V1_AUTOMATION_ENDPOINTS.pauseAutomation,
  typeof WORKBENCH_V1_AUTOMATION_ENDPOINTS.archiveAutomation,
  typeof WORKBENCH_V1_AUTOMATION_ENDPOINTS.listAutomationOccurrences,
];

const AUTOMATION_PRODUCT_ENDPOINTS: AutomationProductEndpoints = [
  WORKBENCH_V1_AUTOMATION_ENDPOINTS.listAutomations,
  WORKBENCH_V1_AUTOMATION_ENDPOINTS.listAutomationCandidates,
  WORKBENCH_V1_AUTOMATION_ENDPOINTS.createAutomation,
  WORKBENCH_V1_AUTOMATION_ENDPOINTS.getAutomation,
  WORKBENCH_V1_AUTOMATION_ENDPOINTS.reviseAutomation,
  WORKBENCH_V1_AUTOMATION_ENDPOINTS.activateAutomation,
  WORKBENCH_V1_AUTOMATION_ENDPOINTS.pauseAutomation,
  WORKBENCH_V1_AUTOMATION_ENDPOINTS.archiveAutomation,
  WORKBENCH_V1_AUTOMATION_ENDPOINTS.listAutomationOccurrences,
];

export function createAutomationProductClient(
  options: BrowserSessionTransportOptions = {},
): ProductClient<AutomationProductEndpoints> {
  return createBrowserSessionProductClient(AUTOMATION_PRODUCT_ENDPOINTS, options);
}
