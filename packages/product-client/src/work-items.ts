import { WORKBENCH_V1_WORK_ITEM_ENDPOINTS } from "@turnsu/workbench-contracts/work-items-http";

import {
  createBrowserSessionProductClient,
  type BrowserSessionTransportOptions,
  type ProductClient,
} from "./index.js";

type WorkItemProductEndpoints = readonly [
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.listProjects,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createProject,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.getProject,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.reviseProjectMembers,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.listWorkItems,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createTeamWorkItem,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createTeamWorkItemAgentEntry,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.updateTeamWorkItem,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.promoteAgentSessionToWorkItem,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.listWorkItemPromotionParticipants,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.getWorkItem,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.listWorkItemLoopRuns,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.startWorkItemLoopRun,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.listWorkItemThreadEntries,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createWorkItemThreadComment,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.recordWorkItemDecision,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createWorkItemContinuation,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createWorkItemContinuationAgentEntry,
  typeof WORKBENCH_V1_WORK_ITEM_ENDPOINTS.revokeWorkItemAccessGrant,
];

const WORK_ITEM_PRODUCT_ENDPOINTS: WorkItemProductEndpoints = [
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.listProjects,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createProject,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.getProject,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.reviseProjectMembers,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.listWorkItems,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createTeamWorkItem,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createTeamWorkItemAgentEntry,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.updateTeamWorkItem,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.promoteAgentSessionToWorkItem,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.listWorkItemPromotionParticipants,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.getWorkItem,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.listWorkItemLoopRuns,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.startWorkItemLoopRun,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.listWorkItemThreadEntries,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createWorkItemThreadComment,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.recordWorkItemDecision,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createWorkItemContinuation,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createWorkItemContinuationAgentEntry,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS.revokeWorkItemAccessGrant,
];

export function createWorkItemProductClient(
  options: BrowserSessionTransportOptions = {},
): ProductClient<WorkItemProductEndpoints> {
  return createBrowserSessionProductClient(WORK_ITEM_PRODUCT_ENDPOINTS, options);
}
