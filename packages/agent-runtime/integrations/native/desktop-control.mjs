import { WORKBENCH_V1_DEVICE_ENDPOINTS, WORKBENCH_V1_MEMBER_AGENT_ENDPOINTS, WORKBENCH_V1_WORK_ITEM_ENDPOINTS } from '@turnsu/workbench-contracts';
import { createNativeTokenProductClient } from '@turnsu/product-client';
import { assertProductOrigin } from './product-tools.mjs';

// These are desktop control actions, intentionally absent from NATIVE_PRODUCT_TOOLS.
// The provider accepts through the desktop; a method or model cannot grant itself device execution.
const endpoints = Object.freeze({ registerDevice: WORKBENCH_V1_DEVICE_ENDPOINTS.registerDevice, ...WORKBENCH_V1_MEMBER_AGENT_ENDPOINTS,
  createProject: WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createProject,
  reviseProjectMembers: WORKBENCH_V1_WORK_ITEM_ENDPOINTS.reviseProjectMembers,
  submitWorkItemResult: WORKBENCH_V1_WORK_ITEM_ENDPOINTS.submitWorkItemResult,
  reviewWorkItemResult: WORKBENCH_V1_WORK_ITEM_ENDPOINTS.reviewWorkItemResult,
});
export function createDesktopProductControl({ baseUrl, accessToken, fetch, beforeCall = async () => {} }) {
  const client = createNativeTokenProductClient(Object.values(endpoints), { baseUrl: assertProductOrigin(baseUrl), accessToken, fetch });
  return Object.freeze({ async call(operationId, input = {}, { signal } = {}) {
    const endpoint = endpoints[operationId];
    if (!endpoint || !Object.hasOwn(endpoints, operationId)) throw new Error('desktop_control_operation_invalid');
    await beforeCall();
    const response = await client.call(operationId, {
      ...(input.pathParams ? { pathParams: input.pathParams } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(endpoint.mutation ? { headers: { 'Idempotency-Key': input.idempotencyKey, ...(input.ifMatch ? { 'If-Match': input.ifMatch } : {}) }, body: { schemaVersion: 'workbench-api-v1', data: input.data } } : {}),
      ...(signal ? { signal } : {}),
    });
    return { ...response.body, ...(response.headers?.ETag ? { etag: response.headers.ETag } : {}) };
  } });
}
