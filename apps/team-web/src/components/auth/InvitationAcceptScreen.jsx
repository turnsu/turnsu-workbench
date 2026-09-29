import { TurnsuBrand } from "../shared/TurnsuBrand.jsx";
import { useEffect, useMemo, useState } from "react";

import { workbenchApi } from "../../api/client.js";
import { readInvitationTokenFromFragment, savePendingInvitationToken } from "./invitation-state.js";

const errorCopy = {
  invitation_invalid: "这个邀请链接无效或已被替换。",
  invitation_expired: "这个邀请链接已过期，请让工作区 Owner 重新发送。",
  invitation_revoked: "这个邀请已被撤销。",
  invitation_already_accepted: "这个邀请已经完成激活。",
  invitation_email_mismatch: "请选择与邀请邮箱一致的已验证 Google 或 GitHub 邮箱。",
  oauth_identity_binding_required: "这个身份已经绑定到现有账户。请先登录该账户，再明确绑定后继续。",
  oauth_provider_unavailable: "此登录方式尚未配置，请选择另一个方式或联系 Owner。",
  identity_signing_unavailable: "邀请服务尚未完成配置，请联系 Owner。",
};

function errorMessage(error) {
  return errorCopy[error?.code] || error?.message || "暂时无法处理邀请，请稍后重试。";
}

function navigate(path) {
  globalThis.history?.pushState?.({}, "", path);
  globalThis.dispatchEvent?.(new Event("workbench:navigate"));
}

export function InvitationAcceptScreen({ authenticated = false } = {}) {
  const token = useMemo(readInvitationTokenFromFragment, []);
  const [invitation, setInvitation] = useState(null);
  const [pendingProvider, setPendingProvider] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(token));

  const inspect = async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const result = await workbenchApi.inspectInvitation(token);
      setInvitation(result.data);
    } catch (cause) {
      setInvitation(null);
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { inspect(); }, [token]);

  const begin = async (provider) => {
    setPendingProvider(provider);
    setError("");
    try {
      const result = await workbenchApi.startOAuth(provider, {
        token,
        bindExistingAccount: authenticated,
      });
      globalThis.location?.assign?.(result.data.authorizationUrl);
    } catch (cause) {
      setError(errorMessage(cause));
      setPendingProvider("");
    }
  };

  return (
    <main className="authPage invitationPage">
      <section className="authCard invitationCard" aria-labelledby="invite-title">
        <div className="authBrand"><TurnsuBrand /></div>
        <div className="authHeading">
          <p>Workspace invitation</p>
          <h1 id="invite-title">加入团队工作台</h1>
          <span>
            {authenticated
              ? "你已登录。选择一个身份提供方，即可明确把它绑定到当前账户并接受邀请。"
              : "使用收到邀请的已验证 Google 或 GitHub 邮箱继续。我们不会根据公开用户名推断身份。"}
          </span>
        </div>
        {!token ? (
          <p className="authError" role="alert">邀请链接缺少安全 token。请从原始邮件重新打开。</p>
        ) : null}
        {loading ? <p className="authNotice">正在验证邀请…</p> : null}
        {!loading && invitation ? (
          <div className="invitationActions">
            <p className="invitationExpiry">此邀请将在 {new Date(invitation.expiresAt).toLocaleString()} 失效。</p>
            {invitation.providers.map((provider) => (
              <button
                key={provider}
                type="button"
                className="authSubmit invitationProvider"
                disabled={Boolean(pendingProvider)}
                onClick={() => begin(provider)}
              >
                {pendingProvider === provider
                  ? "正在跳转…"
                  : `使用 ${provider === "google" ? "Google" : "GitHub"} 继续`}
              </button>
            ))}
          </div>
        ) : null}
        {!authenticated && token ? (
          <button
            type="button"
            className="authModeSwitch"
            onClick={() => {
              savePendingInvitationToken(token);
              navigate("/login");
            }}
          >
            已有账户？先登录并明确绑定身份
          </button>
        ) : null}
        {error ? <p className="authError" role="alert">{error}</p> : null}
        {!loading && !invitation && token ? (
          <button type="button" className="authModeSwitch" onClick={inspect}>重新验证邀请</button>
        ) : null}
      </section>
    </main>
  );
}

export function InvitationCompleteScreen({ authenticated = false } = {}) {
  return (
    <main className="authPage invitationPage">
      <section className="authCard invitationCard" aria-labelledby="invite-complete-title">
        <div className="authBrand"><TurnsuBrand /></div>
        <div className="authHeading">
          <p>Invitation activation</p>
          <h1 id="invite-complete-title">{authenticated ? "已加入工作台" : "正在确认登录"}</h1>
          <span>
            {authenticated
              ? "你的个人 scope 已准备好。接下来可以创建私有任务，其他成员不会看到其中的内容。"
              : "正在读取新的浏览器会话。如果页面没有自动更新，请刷新一次。"}
          </span>
        </div>
        {authenticated ? (
          <button type="button" className="authSubmit" onClick={() => navigate("/")}>进入工作台</button>
        ) : (
          <button type="button" className="authModeSwitch" onClick={() => globalThis.location?.reload?.()}>重新确认</button>
        )}
      </section>
    </main>
  );
}
