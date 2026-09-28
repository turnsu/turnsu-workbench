import { AlertTriangle, LoaderCircle, LockKeyhole, SearchX, WifiOff } from "lucide-react";

import { Button } from "./Button.jsx";

function errorKind(error, online) {
  if (!online || error?.code === "workbench_unreachable") return "offline";
  if (error?.status === 403 || /forbidden|access_denied|permission/.test(error?.code || "")) return "permission";
  if (error?.status === 404 || /not_found/.test(error?.code || "")) return "notFound";
  return "error";
}

const icons = {
  loading: LoaderCircle,
  offline: WifiOff,
  permission: LockKeyhole,
  notFound: SearchX,
  error: AlertTriangle,
};

export function ObjectQueryState({ workspace, state, objectLabel, onRetry, onBack, onRequestAccess, backLabel, testId }) {
  if (!state?.loading && !state?.error) return null;
  const kind = state.loading ? "loading" : errorKind(state.error, workspace.online);
  const Icon = icons[kind];
  const requestAccess = onRequestAccess || workspace.requestWorkspaceAccess;

  return (
    <div className="surface objectQueryState" role={kind === "error" ? "alert" : "status"} data-testid={testId}>
      <Icon size={20} className={kind === "loading" ? "spin" : ""} aria-hidden="true" />
      <h2>{workspace.t(`objectState.${kind}.title`, { object: objectLabel })}</h2>
      <p>{workspace.t(`objectState.${kind}.body`, { object: objectLabel })}</p>
      {state.error?.requestId ? (
        <details>
          <summary>{workspace.t("objectState.technicalDetails")}</summary>
          <code>{workspace.t("objectState.requestId", { requestId: state.error.requestId })}</code>
        </details>
      ) : null}
      <div className="buttonRow">
        {kind === "permission" && requestAccess ? (
          <Button variant="primary" onClick={requestAccess}>{workspace.t("permissions.copyRequest")}</Button>
        ) : null}
        {onBack ? <Button variant="secondary" onClick={onBack}>{backLabel}</Button> : null}
        {onRetry && kind !== "permission" && workspace.online ? (
          <Button variant="primary" onClick={onRetry}>{workspace.t("actions.retry")}</Button>
        ) : null}
      </div>
    </div>
  );
}
