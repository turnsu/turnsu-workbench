import { TurnsuBrand } from "../shared/TurnsuBrand.jsx";
import { useState } from "react";

import { workbenchApi } from "../../api/client.js";
import {
  invitationPath,
  restorePendingNativeAuthorization,
  takePendingInvitationToken,
} from "./invitation-state.js";

function errorMessage(error) {
  const messages = {
    bootstrap_admin_required: "Bootstrap token 不正确。",
    bootstrap_admin_unavailable: "服务端尚未配置首次管理员 token。",
    registration_closed: "当前不允许创建新账户，请联系管理员。",
    password_registration_disabled: "新成员需要通过工作区邀请激活账户。",
    username_unavailable: "这个用户名已被使用。",
    invalid_credentials: "用户名或密码不正确。",
    account_disabled: "这个账户已被停用。",
  };
  return messages[error?.code] || error?.message || "操作没有完成，请稍后重试。";
}

export function AuthScreen({ status, onAuthenticated, onRefresh }) {
  const bootstrap = status.bootstrapRequired;
  const mode = bootstrap ? "register" : "login";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const result = mode === "login"
        ? await workbenchApi.login({ username, password })
        : await workbenchApi.register({
            username,
            password,
            ...(bootstrap ? { bootstrapToken } : {}),
          });
      const pendingInvitationToken = takePendingInvitationToken();
      const pendingNativeAuthorizationPath = restorePendingNativeAuthorization();
      globalThis.history?.replaceState?.(
        {},
        "",
        pendingNativeAuthorizationPath || (pendingInvitationToken ? invitationPath(pendingInvitationToken) : "/"),
      );
      globalThis.dispatchEvent?.(new Event("workbench:navigate"));
      onAuthenticated(result.data);
    } catch (cause) {
      setError(errorMessage(cause));
      await onRefresh();
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="authPage">
      <section className="authCard" aria-labelledby="auth-title">
        <div className="authBrand"><TurnsuBrand /></div>
        <div className="authHeading">
          <p>{bootstrap ? "首次启动" : "团队工作台"}</p>
          <h1 id="auth-title">{mode === "login" ? "登录" : bootstrap ? "创建管理员账户" : "创建账户"}</h1>
          <span>
            {bootstrap
              ? "使用启动配置中的一次性 token 建立首位管理员。"
              : "登录你的工作空间，继续任务、查看成果，与团队协作。"}
          </span>
        </div>
        <form onSubmit={submit} className="authForm">
          <label>
            <span>用户名</span>
            <input
              name="username"
              autoComplete="username"
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              autoFocus
            />
          </label>
          <label>
            <span>密码</span>
            <input
              name="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={8}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {bootstrap && mode === "register" ? (
            <label>
              <span>Bootstrap token</span>
              <input
                name="bootstrap-token"
                type="password"
                autoComplete="off"
                value={bootstrapToken}
                onChange={(event) => setBootstrapToken(event.target.value)}
                required
              />
            </label>
          ) : null}
          {error ? <p className="authError" role="alert">{error}</p> : null}
          <button
            type="submit"
            className="authSubmit"
            disabled={pending || (bootstrap && !status.bootstrapAvailable)}
          >
            {pending ? "正在处理…" : mode === "login" ? "登录" : "继续"}
          </button>
        </form>
        {!bootstrap ? <p className="authNotice">新成员请通过 Owner 发送的邮件邀请，用 Google 或 GitHub 激活账户。</p> : null}
        {bootstrap && !status.bootstrapAvailable ? (
          <p className="authNotice">请先在服务端配置 `WORKBENCH_BOOTSTRAP_ADMIN_TOKEN`，再刷新此页。</p>
        ) : null}
      </section>
    </main>
  );
}
