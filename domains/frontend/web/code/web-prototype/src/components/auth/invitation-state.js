export const PENDING_INVITATION_TOKEN_KEY = "looloomi.pending-invitation-token.v1";
export const PENDING_NATIVE_AUTHORIZATION_KEY = "looloomi.pending-native-authorization.v1";

export function readInvitationTokenFromFragment(location = globalThis.location) {
  try {
    const value = new URLSearchParams(String(location?.hash ?? "").replace(/^#/u, "")).get("token");
    return typeof value === "string" && value.length > 0 ? value : "";
  } catch {
    return "";
  }
}

export function savePendingInvitationToken(token, storage = globalThis.sessionStorage) {
  if (typeof token !== "string" || token.length === 0) return;
  try { storage?.setItem(PENDING_INVITATION_TOKEN_KEY, token); } catch {}
}

export function takePendingInvitationToken(storage = globalThis.sessionStorage) {
  try {
    const token = storage?.getItem(PENDING_INVITATION_TOKEN_KEY) ?? "";
    storage?.removeItem(PENDING_INVITATION_TOKEN_KEY);
    return typeof token === "string" ? token : "";
  } catch {
    return "";
  }
}

export function invitationPath(token) {
  return `/invite#${new URLSearchParams({ token }).toString()}`;
}

export function savePendingNativeAuthorizationId(authorizationId, storage = globalThis.sessionStorage) {
  if (typeof authorizationId !== "string" || authorizationId.length === 0) return;
  try { storage?.setItem(PENDING_NATIVE_AUTHORIZATION_KEY, authorizationId); } catch {}
}

export function takePendingNativeAuthorizationId(storage = globalThis.sessionStorage) {
  try {
    const authorizationId = storage?.getItem(PENDING_NATIVE_AUTHORIZATION_KEY) ?? "";
    storage?.removeItem(PENDING_NATIVE_AUTHORIZATION_KEY);
    return typeof authorizationId === "string" ? authorizationId : "";
  } catch {
    return "";
  }
}

export function nativeAuthorizationPath(authorizationId) {
  return `/native/authorize?${new URLSearchParams({ authorizationId }).toString()}`;
}

export function restorePendingNativeAuthorization() {
  const authorizationId = takePendingNativeAuthorizationId();
  return authorizationId ? nativeAuthorizationPath(authorizationId) : "";
}
