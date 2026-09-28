import { Badge } from "../../design-system/index.jsx";

function statusTone(value = "") {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("ready") || text.includes("completed") || text.includes("fresh")) return "success";
  if (text.includes("running") || text.includes("review") || text.includes("draft") || text.includes("queued")) return "info";
  if (text.includes("need") || text.includes("stale") || text.includes("material")) return "warning";
  if (text.includes("failed") || text.includes("blocked")) return "danger";
  return "neutral";
}

export function StatusPill({ children, tone }) {
  const resolvedTone = tone || statusTone(children);
  return (
    <span className={`status status-${resolvedTone}`}>
      <Badge tone={resolvedTone}>{children}</Badge>
    </span>
  );
}
