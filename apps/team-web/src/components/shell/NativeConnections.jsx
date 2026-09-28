import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Laptop, Smartphone, RefreshCw } from "lucide-react";
import { Button } from "../../design-system/index.jsx";
import { workbenchApi } from "../../api/client.js";
import { NativeAgentSetup } from "./NativeAgentSetup.jsx";
import "./native-connections.css";

export function NativeConnections({ workspace, principal, enabled }) {
  const zh = workspace.locale.startsWith("zh");
  const words = (cn, en) => zh ? cn : en;
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const connections = useQuery({
    queryKey: ["workbench", "own-native-connections", principal],
    queryFn: ({ signal }) => workbenchApi.listOwnNativeClientSessions({ signal }),
    enabled: enabled && Boolean(principal?.userId && principal?.workspaceId),
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
  async function refresh() {
    const result = await connections.refetch();
    if (!result.error) { setSelected(""); setError(""); }
  }
  async function disconnect(connection) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await workbenchApi.revokeOwnNativeClientSession(connection.clientSessionId);
      if (!result.data.revoked) throw new Error("connection_unavailable");
      setSelected(""); setNotice(words("已断开这个连接。", "Connection disconnected."));
      await connections.refetch();
    } catch {
      setError(words("尚未确认断开结果。请刷新查看，或重试；重复断开不会影响其他连接。", "Could not confirm disconnection. Refresh or retry; retrying will not affect other connections."));
    } finally { setBusy(false); }
  }
  const values = connections.data?.data || [];
  return <div className="nativeConnections">
    <header><h3>{words("我的 Agent", "My Agents")}</h3><button type="button" aria-label={words("刷新 Agent 授权", "Refresh Agent authorizations")} disabled={busy || connections.isFetching} onClick={refresh}><RefreshCw size={15} /></button></header>
    <p>{words("你授权访问当前团队空间的 Agent。运行状态请在对应的 Agent 中查看。", "Agents you authorized to access this workspace. Check each Agent for its running status.")}</p>
    {notice ? <p role="status">{notice}</p> : null}
    {error || connections.error ? <p role="alert">{error || words("暂时无法读取授权，请刷新重试。", "Could not load authorizations. Please refresh.")}</p> : null}
    {connections.isPending ? <p role="status">{words("正在读取…", "Loading…")}</p> : !connections.error && !values.length ? <div className="settingsEmpty"><strong>{words("还没有已授权的 Agent", "No Agents authorized yet")}</strong></div> : null}
    {!connections.error ? <ul className="nativeConnectionList">{values.map((connection) => {
      const Icon = connection.clientKind === "mobile" ? Smartphone : Laptop;
      const name = connection.clientKind === "mobile" ? words("移动端连接", "Mobile connection") : words("桌面连接", "Desktop connection");
      return <li key={connection.clientSessionId}>
        <div className="nativeConnectionRow"><Icon size={18} aria-hidden="true" /><div><strong>{name}</strong><small>{words("授权于 ", "Authorized ")}{new Date(connection.createdAt).toLocaleString(workspace.locale)}</small></div><Button variant="plain" size="sm" disabled={busy} onClick={() => { setSelected(connection.clientSessionId); setError(""); setNotice(""); }}>{words("断开", "Disconnect")}</Button></div>
        {selected === connection.clientSessionId ? <div className="nativeConnectionConfirm"><p>{words("断开后，这个客户端将无法继续访问 Turnsu。已下载的文件和本地 Agent 任务会保留；以后可以重新登录连接。", "This client will lose access to Turnsu. Downloaded files and local Agent tasks remain. You can sign in again later.")}</p><div><Button variant="plain" size="sm" disabled={busy} onClick={() => setSelected("")}>{words("取消", "Cancel")}</Button><Button variant="primary" size="sm" disabled={busy} onClick={() => disconnect(connection)}>{busy ? words("正在断开…", "Disconnecting…") : words("确认断开", "Disconnect this client")}</Button></div></div> : null}
      </li>;
    })}</ul> : null}
    <NativeAgentSetup locale={workspace.locale} />
  </div>;
}
