import { TurnsuBrand } from "../shared/TurnsuBrand.jsx";
import { useEffect, useMemo, useState } from "react";

import { workbenchApi } from "../../api/client.js";
import {
  savePendingNativeAuthorizationId,
} from "./invitation-state.js";

function readAuthorizationId(location = globalThis.location) {
  try {
    return new URLSearchParams(String(location?.search ?? "")).get("authorizationId") ?? "";
  } catch {
    return "";
  }
}

function messageFor(error) {
  const messages = {
    native_authorization_unavailable: "这个设备授权已失效、已使用，或不属于当前工作区。请回到桌面或移动应用重新开始。",
    native_authorization_expired: "这个设备授权已过期。请回到桌面或移动应用重新开始。",
    workspace_access_forbidden: "当前账户不能在这个工作区批准设备。请切换到正确的账户后重试。",
    csrf_invalid: "浏览器会话已更新。请刷新页面后再次批准。",
  };
  return messages[error?.code] || error?.message || "暂时无法批准这个设备，请稍后重试。";
}

function navigate(path) {
  globalThis.history?.replaceState?.({}, "", path);
  globalThis.dispatchEvent?.(new Event("workbench:navigate"));
}

export function NativeAuthorizationScreen({ authenticated = false } = {}) {
  const authorizationId = useMemo(readAuthorizationId, []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (authenticated) return;
    if (authorizationId) savePendingNativeAuthorizationId(authorizationId);
  }, [authenticated, authorizationId]);

  const approve = async () => {
    setPending(true);
    setError("");
    try {
      const result = await workbenchApi.approveNativeAuthorization(authorizationId);
      globalThis.location?.assign?.(result.data.redirectUrl);
    } catch (cause) {
      setError(messageFor(cause));
      setPending(false);
    }
  };

  if (!authorizationId) {
    return (
      <main className="authPage nativeAuthorizationPage">
        <section className="authCard invitationCard" aria-labelledby="native-authorize-title">
          <div className="authBrand"><TurnsuBrand /></div>
          <div className="authHeading">
            <p>Device authorization</p>
            <h1 id="native-authorize-title">无法找到设备授权</h1>
            <span>请回到发起登录的桌面或移动应用，再次开始安全登录。</span>
          </div>
        </section>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="authPage nativeAuthorizationPage">
        <section className="authCard invitationCard" aria-labelledby="native-authorize-title">
          <div className="authBrand"><TurnsuBrand /></div>
          <div className="authHeading">
            <p>Device authorization</p>
            <h1 id="native-authorize-title">登录后批准设备</h1>
            <span>请先登录工作台。登录完成后会返回此页；设备不能读取你的浏览器会话。</span>
          </div>
          <button type="button" className="authSubmit" onClick={() => navigate("/login")}>前往登录</button>
        </section>
      </main>
    );
  }

  return (
    <main className="authPage nativeAuthorizationPage">
      <section className="authCard invitationCard" aria-labelledby="native-authorize-title">
        <div className="authBrand"><TurnsuBrand /></div>
        <div className="authHeading">
          <p>Device authorization</p>
          <h1 id="native-authorize-title">批准此设备登录</h1>
          <span>批准后，此客户端可以你的身份访问获准的工作并提交操作。客户端会保存访问及续期凭证，你可以在客户端撤销连接。请只批准自己刚发起的连接。</span>
        </div>
        <button type="button" className="authSubmit" disabled={pending} onClick={approve}>
          {pending ? "正在安全批准…" : "批准设备"}
        </button>
        {error ? <p className="authError" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}
