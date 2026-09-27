import { constants } from "node:fs";
import { open, readFile, rename, unlink, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Check, NativeTokenSetSchema, WORKBENCH_V1_WORKSPACE_ENDPOINTS } from "@looloomi/workbench-contracts";
import { createNativeTokenProductClient } from "@looloomi/product-client";
import { createNativeAuthorizationProductClient, createNativeAuthProductClient } from "@looloomi/product-client/auth";
import { assertProductOrigin, createNativeProductTools } from "./product-tools.mjs";

export async function readNativeProfile(path) {
  if (!isAbsolute(path || "")) throw new Error("native_session_absolute_path_required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("native_session_private_file_required");
    const value = JSON.parse(await file.readFile("utf8"));
    assertProductOrigin(value.baseUrl);
    if (!Check(NativeTokenSetSchema, value.tokens)) throw new Error("native_session_invalid");
    return value;
  } finally { await file.close(); }
}

export async function writeNativeProfile(path, value, { create = false } = {}) {
  if (!isAbsolute(path || "")) throw new Error("native_session_absolute_path_required");
  const target = create ? path : `${path}.${randomUUID()}.tmp`;
  const file = await open(target, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  if (!create) {
    try { await rename(target, path); } catch (error) { await unlink(target).catch(() => {}); throw error; }
  }
}

// One native client owns a refresh family. A separate client logs in separately;
// sharing one rotating credential between native processes would revoke it.
export async function lockNativeProfile(path, { recoverStaleLock = false } = {}) {
  if (!isAbsolute(path || "")) throw new Error("native_session_absolute_path_required");
  const lockPath = `${path}.lock`;
  const identity = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(lockPath, "wx", 0o600);
      try { await file.writeFile(identity); } finally { await file.close(); }
      return async () => { if (await readFile(lockPath, "utf8").catch(() => null) === identity) await unlink(lockPath); };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const before = await lstat(lockPath);
      if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077) || (process.getuid && before.uid !== process.getuid())) throw new Error("native_session_lock_invalid");
      const owner = await readFile(lockPath, "utf8").catch(() => "");
      const pid = Number(owner.split(":")[0]);
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("native_session_lock_invalid");
      try { process.kill(pid, 0); } catch (cause) {
        if (cause.code === "ESRCH") {
          if (!recoverStaleLock) throw new Error("native_session_stale_lock_check_owner_before_removal");
          if ((await lstat(lockPath)).ino !== before.ino || await readFile(lockPath, "utf8") !== owner) throw new Error("native_session_in_use_login_separately_for_each_client");
          await unlink(lockPath); continue;
        }
      }
      throw new Error("native_session_in_use_login_separately_for_each_client");
    }
  }
  throw new Error("native_session_in_use_login_separately_for_each_client");
}

export async function openNativeProductSession(path, { fetch, recoverStaleLock = false, desktopControl = false } = {}) {
  const release = await lockNativeProfile(path, { recoverStaleLock });
  try {
    let profile = await readNativeProfile(path);
    let rotation;
    const exchange = createNativeAuthorizationProductClient({ baseUrl: profile.baseUrl, fetch });
    async function ensureAccess() {
      if (rotation) return rotation;
      if (profile.refreshPending) throw new Error("native_session_refresh_uncertain_login_again");
      if (Date.parse(profile.tokens.accessTokenExpiresAt) > Date.now() + 30_000) return;
      if (!rotation) rotation = (async () => {
        if (Date.parse(profile.tokens.refreshTokenExpiresAt) <= Date.now()) throw new Error("native_session_expired_login_again");
        profile = { ...profile, refreshPending: true };
        // An interrupted refresh must never replay a consumed token.
        await writeNativeProfile(path, profile);
        const result = await exchange.call("refreshNativeToken", { body: { schemaVersion: "workbench-api-v1", data: { refreshToken: profile.tokens.refreshToken } }, signal: AbortSignal.timeout(15_000) });
        const updated = { baseUrl: profile.baseUrl, tokens: result.body.data };
        await writeNativeProfile(path, updated); profile = updated;
      })().finally(() => { rotation = null; });
      await rotation;
    }
    const product = createNativeProductTools({ baseUrl: profile.baseUrl, accessToken: () => profile.tokens.accessToken, fetch, beforeCall: ensureAccess });
    const desktop = desktopControl ? (await import('./desktop-control.mjs')).createDesktopProductControl({ baseUrl: profile.baseUrl, accessToken: () => profile.tokens.accessToken, fetch, beforeCall: ensureAccess }) : undefined;
    return { product, ...(desktop ? { desktop } : {}), release, async viewer() {
      await ensureAccess();
      const client = createNativeTokenProductClient([WORKBENCH_V1_WORKSPACE_ENDPOINTS.workspace], { baseUrl: profile.baseUrl, accessToken: () => profile.tokens.accessToken, fetch });
      const result = await client.call('workspace', { signal: AbortSignal.timeout(15_000) });
      return { userId: result.body.data.session.userId, workspaceId: result.body.data.session.workspaceId };
    }, async revoke() {
      await ensureAccess();
      const client = createNativeAuthProductClient({ baseUrl: profile.baseUrl, accessToken: () => profile.tokens.accessToken, fetch });
      await client.call("revokeNativeClientSession", { headers: { Authorization: `Bearer ${profile.tokens.accessToken}` }, body: { schemaVersion: "workbench-api-v1", data: {} }, signal: AbortSignal.timeout(15_000) });
      await unlink(path);
    } };
  } catch (error) { await release(); throw error; }
}
