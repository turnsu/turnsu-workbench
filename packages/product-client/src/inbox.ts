import { WORKBENCH_V1_INBOX_ENDPOINTS } from "@turnsu/workbench-contracts/inbox-http";

import {
  createBrowserSessionProductClient,
  type BrowserSessionTransportOptions,
  type ProductClient,
} from "./index.js";

type InboxProductEndpoints = readonly [
  typeof WORKBENCH_V1_INBOX_ENDPOINTS.getInbox,
];

const INBOX_PRODUCT_ENDPOINTS: InboxProductEndpoints = [
  WORKBENCH_V1_INBOX_ENDPOINTS.getInbox,
];

export function createInboxProductClient(
  options: BrowserSessionTransportOptions = {},
): ProductClient<InboxProductEndpoints> {
  return createBrowserSessionProductClient(INBOX_PRODUCT_ENDPOINTS, options);
}
