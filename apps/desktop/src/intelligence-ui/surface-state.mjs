// Rebase only when the form and its source data are unchanged.
// A different question, read-only state or remote edit requires human recovery.
export function canRebaseSurfaceEdits(previous, next, values) {
  if (!previous || !next || next.readOnly || next.revision < previous.revision || previous.sessionId !== next.sessionId || previous.taskId !== next.taskId) return false;
  if (previous.document.title !== next.document.title || JSON.stringify(previous.document.migration) !== JSON.stringify(next.document.migration)) return false;
  if (previous.document.format !== next.document.format || previous.document.program !== next.document.program || previous.document.streaming !== next.document.streaming) return false;
  if (JSON.stringify(previous.document.data) !== JSON.stringify(next.document.data)) return false;
  return Object.keys(values).every(key => JSON.stringify(previous.document.data[key]) === JSON.stringify(next.document.data[key]));
}

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

// File metadata and access come from Host receipts, never Agent-authored data.
export function registeredSurfaceFile(state, path) {
  if (typeof path !== "string") return null;
  const result = state.results?.flatMap((entry) => entry.files || []).find((file) => file.path === path);
  if (result) return { ...result, kind: "result" };
  const material = state.assets?.find((file) => file.path === path);
  return material ? { ...material, kind: "material" } : null;
}

export function surfaceAssets(state, value) {
  const bound = Array.isArray(value) && value.length > 0;
  return {
    bound,
    files: bound
      ? [...new Set(value.map((ref) => typeof ref === "string" ? ref : ref?.path)
        .filter((path) => typeof path === "string"))]
        .map((path) => registeredSurfaceFile(state, path) || { path, kind: "unregistered" })
      : (state.assets || []).map((file) => ({ ...file, kind: "material" })),
  };
}

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
  if (state.continuation)
    return { label: "本轮已结束，尚未返回文件成果；确认内容已保留", tone: "warning" };
  const canSubmit = /@ToAssistant\s*\(/.test(state.document?.program || '');
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
  // A read-only document needs no redundant delivery announcement.
  return { label: "", tone: "neutral" };
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
