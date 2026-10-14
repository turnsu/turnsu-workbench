export function presentationEvents(state) {
  const since = state.presentation?.presented_at;
  if (!Number.isFinite(since)) return [];
  return (state.events || []).filter((event) => event.created_at >= since);
}

// A receipt confirms delivery, never completion of the underlying business task.
// Edits may start a new review only after the previous delivery is resolved.
export function confirmationState(state) {
  const events = presentationEvents(state);
  for (const value of ["uncertain", "dispatching", "pending"])
    if (events.some((event) => event.state === value)) return value;
  return !state.dirty && ["sent", "consumed"].includes(events[0]?.state)
    ? "confirmed"
    : null;
}

const hasSubmitAction = (node) =>
  (node?.type === "Action" && node.action === "submit") ||
  node?.children?.some(hasSubmitAction);

export function surfaceStatus(state, busy = false) {
  const confirmation = confirmationState(state);
  if (confirmation === "uncertain")
    return { label: "请在对话中核对接收状态", tone: "warning" };
  if (state.error || state.status === "failed")
    return { label: "需要处理", tone: "error" };
  if (state.status === "interrupted")
    return { label: "请回对话恢复", tone: "warning" };
  if (busy) return { label: "正在处理…", tone: "working" };
  if (confirmation === "pending")
    return { label: "已确认，等待助手接收", tone: "working" };
  if (confirmation === "dispatching")
    return { label: "正在交给助手", tone: "working" };
  if (state.status === "waiting")
    return { label: "请在对话中回应", tone: "waiting" };
  const activity = {
    starting: "准备执行",
    running: "助手正在处理",
    stopping: "正在停止",
  };
  if (activity[state.status])
    return { label: activity[state.status], tone: "working" };
  const canSubmit = hasSubmitAction(state.document?.tree);
  if (state.dirty)
    return canSubmit
      ? { label: "修改已保存，等待你确认", tone: "waiting" }
      : { label: "修改已保存", tone: "neutral" };
  if (confirmation === "confirmed")
    return { label: "确认内容已交给助手", tone: "success" };
  if (canSubmit) return { label: "等待你确认", tone: "waiting" };
  if (state.results?.some((result) =>
    result.createdAt >= state.presentation?.presented_at && result.files?.length))
    return { label: "成果可查看", tone: "success" };
  return { label: "内容已展示", tone: "neutral" };
}

// Alignment changes presentation only; values and precision stay with the Host.
export function numericColumns(rows, columns) {
  return new Set(
    columns
      .filter(({ key }) => {
        const values = rows
          .map((row) => row?.[key])
          .filter((v) => v != null && v !== "");
        return (
          values.length > 0 &&
          values.every((value) => {
            if (typeof value === "number") return Number.isFinite(value);
            return (
              typeof value === "string" &&
              /^[¥￥$€£]?[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*(?:元|%))?$/.test(
                value.trim(),
              ) &&
              !/^0\d/.test(value.trim())
            );
          })
        );
      })
      .map(({ key }) => key),
  );
}
