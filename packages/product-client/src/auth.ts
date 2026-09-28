import { WORKBENCH_V1_AUTH_ENDPOINTS } from "@turnsu/workbench-contracts/auth-http";

import {
  createBrowserSessionProductClient,
  type BrowserSessionTransportOptions,
  createNativeCredentialExchangeProductClient,
  type NativeCredentialExchangeTransportOptions,
  createNativeTokenProductClient,
  type NativeTokenTransportOptions,
  type ProductClient,
} from "./index.js";

type AuthProductEndpoints = readonly [
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.authStatus,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.register,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.login,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.logout,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.listOwnNativeClientSessions,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.revokeOwnNativeClientSession,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.listMembers,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.updateMember,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.listInvitations,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.createInvitation,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.revokeInvitation,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.resendInvitation,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.inspectInvitation,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.startOAuth,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.completeOAuth,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.startNativeAuthorization,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.completeNativeAuthorization,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.approveNativeAuthorization,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.refreshNativeToken,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.revokeNativeClientSession,
];

const AUTH_PRODUCT_ENDPOINTS: AuthProductEndpoints = [
  WORKBENCH_V1_AUTH_ENDPOINTS.authStatus,
  WORKBENCH_V1_AUTH_ENDPOINTS.register,
  WORKBENCH_V1_AUTH_ENDPOINTS.login,
  WORKBENCH_V1_AUTH_ENDPOINTS.logout,
  WORKBENCH_V1_AUTH_ENDPOINTS.listOwnNativeClientSessions,
  WORKBENCH_V1_AUTH_ENDPOINTS.revokeOwnNativeClientSession,
  WORKBENCH_V1_AUTH_ENDPOINTS.listMembers,
  WORKBENCH_V1_AUTH_ENDPOINTS.updateMember,
  WORKBENCH_V1_AUTH_ENDPOINTS.listInvitations,
  WORKBENCH_V1_AUTH_ENDPOINTS.createInvitation,
  WORKBENCH_V1_AUTH_ENDPOINTS.revokeInvitation,
  WORKBENCH_V1_AUTH_ENDPOINTS.resendInvitation,
  WORKBENCH_V1_AUTH_ENDPOINTS.inspectInvitation,
  WORKBENCH_V1_AUTH_ENDPOINTS.startOAuth,
  WORKBENCH_V1_AUTH_ENDPOINTS.completeOAuth,
  WORKBENCH_V1_AUTH_ENDPOINTS.startNativeAuthorization,
  WORKBENCH_V1_AUTH_ENDPOINTS.completeNativeAuthorization,
  WORKBENCH_V1_AUTH_ENDPOINTS.approveNativeAuthorization,
  WORKBENCH_V1_AUTH_ENDPOINTS.refreshNativeToken,
  WORKBENCH_V1_AUTH_ENDPOINTS.revokeNativeClientSession,
];

export function createAuthProductClient(
  options: BrowserSessionTransportOptions = {},
): ProductClient<AuthProductEndpoints> {
  return createBrowserSessionProductClient(AUTH_PRODUCT_ENDPOINTS, options);
}

/** Native flows use only the token endpoints; browser approval remains cookie/CSRF bound. */
export function createNativeAuthProductClient(
  options: NativeTokenTransportOptions,
): ProductClient<NativeAuthProductEndpoints> {
  return createNativeTokenProductClient(NATIVE_AUTH_PRODUCT_ENDPOINTS, options);
}

/** Native shells use this before an access token exists, or while rotating it. */
export function createNativeAuthorizationProductClient(
  options: NativeCredentialExchangeTransportOptions,
): ProductClient<NativeAuthorizationProductEndpoints> {
  return createNativeCredentialExchangeProductClient(
    NATIVE_AUTHORIZATION_PRODUCT_ENDPOINTS,
    options,
  );
}

type NativeAuthProductEndpoints = readonly [
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.revokeNativeClientSession,
];

const NATIVE_AUTH_PRODUCT_ENDPOINTS: NativeAuthProductEndpoints = [
  WORKBENCH_V1_AUTH_ENDPOINTS.revokeNativeClientSession,
];

type NativeAuthorizationProductEndpoints = readonly [
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.startNativeAuthorization,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.completeNativeAuthorization,
  typeof WORKBENCH_V1_AUTH_ENDPOINTS.refreshNativeToken,
];

const NATIVE_AUTHORIZATION_PRODUCT_ENDPOINTS: NativeAuthorizationProductEndpoints = [
  WORKBENCH_V1_AUTH_ENDPOINTS.startNativeAuthorization,
  WORKBENCH_V1_AUTH_ENDPOINTS.completeNativeAuthorization,
  WORKBENCH_V1_AUTH_ENDPOINTS.refreshNativeToken,
];
