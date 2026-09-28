import { useEffect, useState } from "react";

import { workbenchApi } from "../../api/client.js";

function updateError(error) {
  if (error?.code === "last_admin_required") return "至少需要保留一位可用管理员。";
  if (error?.code === "member_admin_required") return "只有管理员可以修改成员。";
  return error?.message || "成员修改失败。";
}

function invitationError(error) {
  const messages = {
    member_admin_required: "只有工作区 Owner 可以管理邀请。",
    invitation_already_pending: "这个邮箱已有待处理邀请。",
    invitation_delivery_unavailable: "邮件投递尚未完成配置，邀请没有被创建。",
  };
  return messages[error?.code] || error?.message || "邀请操作失败。";
}

function deviceError(error) {
  const messages = {
    device_revoke_forbidden: "只有 Owner 或 Admin 可以撤销设备。",
    device_not_found: "该设备已不在当前工作区。请刷新后重试。",
    device_revoked: "该设备已经撤销。",
  };
  return messages[error?.code] || error?.message || "设备操作失败。";
}

function deviceHealthLabel(device) {
  const labels = {
    ready: "可用",
    offline: "离线",
    incompatible: "需要更新",
    revoked: "已撤销",
  };
  return labels[device.health] || "状态未知";
}

function devicePlatformLabel(device) {
  const platform = device.platform === "macos" ? "macOS" : "Windows";
  return `${platform} · ${device.architecture}`;
}

export function MembersView({ workspace }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState("");
  const [error, setError] = useState("");
  const [invitations, setInvitations] = useState([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePending, setInvitePending] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [pendingInvitationId, setPendingInvitationId] = useState("");
  const [devices, setDevices] = useState([]);
  const [deviceErrorMessage, setDeviceErrorMessage] = useState("");
  const [pendingDeviceId, setPendingDeviceId] = useState("");
  const canManageInvitations = workspace.authUser?.role === "admin";
  const canManageDevices = ["owner", "admin"].includes(workspace.membershipRole);

  const load = async () => {
    setLoading(true);
    setError("");
    setInviteError("");
    setDeviceErrorMessage("");
    const [accessResult, deviceResult] = await Promise.allSettled([
      (async () => {
        const [memberResult, invitationResult] = await Promise.all([
        workbenchApi.listMembers(),
        canManageInvitations ? workbenchApi.listInvitations() : Promise.resolve({ data: [] }),
        ]);
        return { memberResult, invitationResult };
      })(),
      workbenchApi.listDevices(),
    ]);
    if (accessResult.status === "fulfilled") {
      setMembers(accessResult.value.memberResult.data || []);
      setInvitations(accessResult.value.invitationResult.data || []);
    } else {
      setError(updateError(accessResult.reason));
    }
    if (deviceResult.status === "fulfilled") setDevices(deviceResult.value.data || []);
    else setDeviceErrorMessage(deviceError(deviceResult.reason));
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const update = async (member, changes) => {
    setPendingId(member.userId);
    setError("");
    try {
      const result = await workbenchApi.updateMember(member.userId, changes);
      setMembers((current) => current.map((item) => (
        item.userId === member.userId ? result.data.user : item
      )));
    } catch (cause) {
      setError(updateError(cause));
    } finally {
      setPendingId("");
    }
  };

  const invite = async (event) => {
    event.preventDefault();
    setInvitePending(true);
    setInviteError("");
    try {
      const result = await workbenchApi.createInvitation({ email: inviteEmail.trim() });
      setInvitations((current) => [result.data.invitation, ...current]);
      setInviteEmail("");
    } catch (cause) {
      setInviteError(invitationError(cause));
    } finally {
      setInvitePending(false);
    }
  };

  const changeInvitation = async (invitation, operation) => {
    setPendingInvitationId(invitation.invitationId);
    setInviteError("");
    try {
      const result = operation === "revoke"
        ? await workbenchApi.revokeInvitation(invitation.invitationId)
        : await workbenchApi.resendInvitation(invitation.invitationId);
      setInvitations((current) => operation === "revoke"
        ? current.map((item) => item.invitationId === invitation.invitationId ? result.data.invitation : item)
        : [result.data.invitation, ...current.filter((item) => item.invitationId !== invitation.invitationId)]);
    } catch (cause) {
      setInviteError(invitationError(cause));
    } finally {
      setPendingInvitationId("");
    }
  };

  const revokeDevice = async (device) => {
    if (!canManageDevices || pendingDeviceId) return;
    const approved = globalThis.confirm?.(
      `撤销“${device.displayName}”后，该 Desktop 将立即失去访问权限。是否继续？`,
    );
    if (approved !== true) return;
    setPendingDeviceId(device.deviceId);
    setDeviceErrorMessage("");
    try {
      const result = await workbenchApi.revokeDevice(device.deviceId, {});
      setDevices((current) => current.map((item) => (
        item.deviceId === device.deviceId ? result.data : item
      )));
    } catch (cause) {
      setDeviceErrorMessage(deviceError(cause));
    } finally {
      setPendingDeviceId("");
    }
  };

  return (
    <div className="surface membersPage" data-testid="loopops.members.page">
      <header className="membersHeader">
        <div>
          <p>Workspace access</p>
          <h1>成员</h1>
          <span>管理员可以调整角色或停用账户；停用会立即撤销该成员的现有会话。</span>
        </div>
        <button type="button" onClick={load} disabled={loading}>刷新</button>
      </header>
      {error ? <p className="authError" role="alert">{error}</p> : null}
      {canManageInvitations ? (
        <section className="invitationManager" aria-labelledby="invitation-title">
          <div className="invitationManagerHeading">
            <div>
              <p>Team entry</p>
              <h2 id="invitation-title">邮件邀请</h2>
              <span>邀请会通过 SMTP 邮件发送；成员须使用同一已验证邮箱的 Google 或 GitHub 身份激活。</span>
            </div>
          </div>
          <form className="invitationForm" onSubmit={invite}>
            <label>
              <span className="srOnly">成员邮箱</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="member@example.com"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                required
              />
            </label>
            <button type="submit" disabled={invitePending}>{invitePending ? "正在创建…" : "发送邀请"}</button>
          </form>
          {inviteError ? <p className="authError" role="alert">{inviteError}</p> : null}
          <div className="invitationList" aria-live="polite">
            {!invitations.length ? <p className="membersEmpty">暂无邀请。</p> : null}
            {invitations.map((invitation) => {
              const pending = pendingInvitationId === invitation.invitationId;
              const active = invitation.status === "pending";
              return (
                <article key={invitation.invitationId} className="invitationRow">
                  <div>
                    <strong>{invitation.email}</strong>
                    <small>{invitation.status === "pending" ? `待激活 · ${invitation.deliveryStatus || "queued"}` : invitation.status}</small>
                  </div>
                  {active ? (
                    <div className="invitationRowActions">
                      <button type="button" disabled={pending} onClick={() => changeInvitation(invitation, "resend")}>重发</button>
                      <button type="button" className="memberDisable" disabled={pending} onClick={() => changeInvitation(invitation, "revoke")}>撤销</button>
                    </div>
                  ) : <small>{new Date(invitation.updatedAt).toLocaleDateString()}</small>}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
      <section className="deviceManager" aria-labelledby="device-title">
        <div className="deviceManagerHeading">
          <div>
            <p>Desktop access</p>
            <h2 id="device-title">已注册设备</h2>
            <span>
              {canManageDevices
                ? "可查看工作区设备并撤销丢失或不再受信任的 Desktop。注册与心跳仅由已授权的原生客户端完成。"
                : "仅显示你自己的 Desktop。设备注册与心跳仅由已授权的原生客户端完成。"}
            </span>
          </div>
        </div>
        {deviceErrorMessage ? <p className="authError" role="alert">{deviceErrorMessage}</p> : null}
        <div className="deviceList" aria-live="polite">
          {!loading && !deviceErrorMessage && !devices.length ? <p className="membersEmpty">尚无已注册设备。</p> : null}
          {devices.map((device) => {
            const pending = pendingDeviceId === device.deviceId;
            const revoked = device.registrationStatus === "revoked";
            return (
              <article key={device.deviceId} className="deviceRow">
                <div className="deviceIdentity">
                  <strong>{device.displayName}</strong>
                  <small>{devicePlatformLabel(device)} · {device.appVersion}</small>
                  <small>{deviceHealthLabel(device)} · 最近活动 {new Date(device.lastSeenAt).toLocaleString()}</small>
                </div>
                <div className="deviceRowActions">
                  <span className={`deviceHealth deviceHealth-${device.health}`}>{deviceHealthLabel(device)}</span>
                  {canManageDevices && !revoked ? (
                    <button
                      type="button"
                      className="memberDisable"
                      disabled={pending}
                      onClick={() => revokeDevice(device)}
                    >
                      {pending ? "撤销中…" : "撤销设备"}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </section>
      {loading ? <p className="membersEmpty">正在读取成员…</p> : null}
      {!loading && !members.length ? <p className="membersEmpty">暂无成员。</p> : null}
      <div className="membersList">
        {members.map((member) => {
          const pending = pendingId === member.userId;
          const self = member.userId === workspace.authUser?.userId;
          return (
            <article key={member.userId} className="memberRow">
              <div className="memberIdentity">
                <span>{member.username.slice(0, 1).toUpperCase()}</span>
                <div><strong>{member.username}{self ? "（你）" : ""}</strong><small>{member.disabled ? "已停用" : "可登录"}</small></div>
              </div>
              <label>
                <span className="srOnly">角色</span>
                <select
                  value={member.role}
                  disabled={pending}
                  onChange={(event) => update(member, { role: event.target.value })}
                >
                  <option value="admin">管理员</option>
                  <option value="member">成员</option>
                </select>
              </label>
              <button
                type="button"
                className={member.disabled ? "memberEnable" : "memberDisable"}
                disabled={pending}
                onClick={() => update(member, { disabled: !member.disabled })}
              >
                {pending ? "保存中…" : member.disabled ? "启用" : "停用"}
              </button>
            </article>
          );
        })}
      </div>
    </div>
  );
}
