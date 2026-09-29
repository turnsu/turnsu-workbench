import {
  WORKBENCH_V1_DEVICE_ENDPOINTS,
} from "@turnsu/workbench-contracts/devices-http";

import {
  createBrowserSessionProductClient,
  createNativeTokenProductClient,
  type BrowserSessionTransportOptions,
  type NativeTokenTransportOptions,
  type ProductClient,
} from "./index.js";

type DeviceProductEndpoints = readonly [
  typeof WORKBENCH_V1_DEVICE_ENDPOINTS.listDevices,
  typeof WORKBENCH_V1_DEVICE_ENDPOINTS.registerDevice,
  typeof WORKBENCH_V1_DEVICE_ENDPOINTS.getDevice,
  typeof WORKBENCH_V1_DEVICE_ENDPOINTS.heartbeatDevice,
  typeof WORKBENCH_V1_DEVICE_ENDPOINTS.revokeDevice,
];

const DEVICE_PRODUCT_ENDPOINTS: DeviceProductEndpoints = [
  WORKBENCH_V1_DEVICE_ENDPOINTS.listDevices,
  WORKBENCH_V1_DEVICE_ENDPOINTS.registerDevice,
  WORKBENCH_V1_DEVICE_ENDPOINTS.getDevice,
  WORKBENCH_V1_DEVICE_ENDPOINTS.heartbeatDevice,
  WORKBENCH_V1_DEVICE_ENDPOINTS.revokeDevice,
];

/** Browser users manage the Device inventory through the same Product API. */
export function createDeviceProductClient(
  options: BrowserSessionTransportOptions = {},
): ProductClient<DeviceProductEndpoints> {
  return createBrowserSessionProductClient(DEVICE_PRODUCT_ENDPOINTS, options);
}

/** Desktop shells register and heartbeat through their native bearer session. */
export function createNativeDeviceProductClient(
  options: NativeTokenTransportOptions,
): ProductClient<DeviceProductEndpoints> {
  return createNativeTokenProductClient(DEVICE_PRODUCT_ENDPOINTS, options);
}
