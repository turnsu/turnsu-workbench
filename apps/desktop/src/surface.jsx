import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./surface.css";
import { surfaceBridge } from "./surface-bridge.mjs";
const api = (method, args) => surfaceBridge.invoke(method, args);
const labels = {
  idle: "可以继续",
  starting: "准备执行",
  running: "执行中",
  waiting: "等待回应",
  stopping: "正在停止",
  failed: "需要处理",
  interrupted: "请回会话恢复",
};
function DataView({ node, value, onChange, disabled }) {
  const [page, setPage] = useState(0);
  const rows = Array.isArray(value) ? value : [],
    cols = node.columns || [],
    last = Math.max(0, Math.ceil(rows.length / 40) - 1);
  useEffect(() => setPage((p) => Math.min(p, last)), [last]);
  return (
    <section className="dataView">
      <h2>{node.label}</h2>
      {rows.length ? (
        <>
          <div className="tableScroll">
            <table>
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(page * 40, (page + 1) * 40).map((r, i) => (
                  <tr key={r.id || page * 40 + i}>
                    {cols.length ? (
                      cols.map((c) => (
                        <td key={c.key}>
                          {c.editable ? (
                            <input
                              aria-label={
                                (node.label || "数据") +
                                " 第 " +
                                (page * 40 + i + 1) +
                                " 行 " +
                                c.label
                              }
                              disabled={disabled}
                              value={r[c.key] ?? ""}
                              onChange={(e) =>
                                onChange(
                                  rows.map((item, j) =>
                                    j === page * 40 + i
                                      ? { ...item, [c.key]: e.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                          ) : (
                            String(r[c.key] ?? "")
                          )}
                        </td>
                      ))
                    ) : (
                      <td>
                        {typeof r === "object" ? JSON.stringify(r) : String(r)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav>
            <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
              上一页
            </button>
            <span>
              {page + 1} / {last + 1} · {rows.length} 项
            </span>
            <button
              disabled={page >= last}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </button>
          </nav>
        </>
      ) : (
        <p className="muted">暂无数据</p>
      )}
    </section>
  );
}
function App() {
  const [state, setState] = useState(null),
    [draft, setDraft] = useState({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef({}),
    pendingRevision = useRef(null),
    alive = useRef(true),
    request = useRef(null),
    autosave = useRef(null),
    stateRef = useRef(null),
    saveCallback = useRef(null),
    saveQueue = useRef(Promise.resolve());
  stateRef.current = state;
  const read = async () => {
    const s = await api("read");
    if (alive.current && !Object.keys(pending.current).length) {
      setState(s);
      setDraft({ ...s.document.data, ...pending.current });
    }
  };
  useEffect(() => {
    alive.current = true;
    read().catch((e) => setError(e.message));
    let timer;
    const flushOff = surfaceBridge.flush(() => saveCallback.current());
    const off = surfaceBridge.listen(() => {
      clearTimeout(timer);
      timer = setTimeout(() => read().catch((e) => setError(e.message)), 120);
    });
    return () => {
      alive.current = false;
      clearTimeout(timer);
      clearTimeout(autosave.current);
      off();
      flushOff();
    };
  }, []);
  async function save() {
    const action = saveQueue.current.catch(() => {}).then(persist);
    saveQueue.current = action;
    return action;
  }
  async function persist() {
    clearTimeout(autosave.current);
    if (!Object.keys(pending.current).length) return stateRef.current;
    const values = { ...pending.current };
    const s = await api("save", {
      revision: pendingRevision.current ?? stateRef.current.revision,
      values,
    });
    for (const [k, v] of Object.entries(values))
      if (pending.current[k] === v) delete pending.current[k];
    pendingRevision.current = Object.keys(pending.current).length
      ? s.revision
      : null;
    stateRef.current = s;
    setState(s);
    setDraft({ ...s.document.data, ...pending.current });
    return s;
  }
  saveCallback.current = save;
  async function act(operation) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const s = await save();
      if (operation === "import") {
        const next = await api("import");
        setState(next);
        if (next.importFailures?.length)
          setError(
            "部分文件导入失败：" +
              next.importFailures.map((f) => f.error || f.path).join("；"),
          );
      } else if (operation === "deliver") {
        const event = s.events.find((e) => e.state === "pending");
        if (!event) throw new Error("没有待回传的交互，不会重复执行任务。");
        await api("deliver", { requestId: event.id });
        await read();
      } else {
        request.current ||= crypto.randomUUID();
        await api("submit", {
          revision: s.revision,
          requestId: request.current,
        });
        request.current = null;
        await read();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function run(fn) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await read();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function render(n) {
    const value = draft[n.binding];
    const change = (v) => {
      pendingRevision.current ??= state.revision;
      pending.current[n.binding] = v;
      setDraft((d) => ({ ...d, [n.binding]: v }));
      clearTimeout(autosave.current);
      autosave.current = setTimeout(
        () => saveCallback.current().catch((e) => setError(e.message)),
        450,
      );
    };
    if (n.type === "Layout")
      return (
        <section
          key={n.id}
          className={"layout " + (n.variant === "grid" ? "grid" : "stack")}
        >
          {n.label && <h2>{n.label}</h2>}
          {n.children?.map(render)}
        </section>
      );
    if (n.type === "Text")
      return (
        <div key={n.id} className="text">
          {n.label && <h2>{n.label}</h2>}
          <p>{n.text || String(value ?? "")}</p>
        </div>
      );
    if (n.type === "DataView")
      return (
        <DataView
          key={n.id}
          node={n}
          value={value}
          disabled={busy}
          onChange={change}
        />
      );
    if (n.type === "Assets")
      return (
        <section key={n.id}>
          <div className="sectionTitle">
            <h2>{n.label || "选定材料"}</h2>
            <button disabled={busy} onClick={() => act("import")}>
              ＋ 选择文件
            </button>
          </div>
          <ul className="materialNames">
            {state.assets.map((file) => (
              <li key={file.path}>{file.path.split("/").at(-1)}</li>
            ))}
          </ul>
          {!state.assets.length && (
            <p className="muted">添加本次工作需要的文件，原件会保留。</p>
          )}
        </section>
      );
    if (n.type === "Status")
      return (
        <p key={n.id} className="status" role="status">
          {labels[state.status] || state.status}
          {state.error ? " · " + state.error : ""}
        </p>
      );
    if (n.type === "Action")
      return (
        <button
          key={n.id}
          className="primary"
          disabled={
            busy ||
            (n.action === "submit" &&
              !state.dirty &&
              state.events.some(
                (e) =>
                  e.created_at >= state.presentation?.presented_at &&
                  [
                    "sent",
                    "consumed",
                    "dispatching",
                    "pending",
                    "uncertain",
                  ].includes(e.state),
              ))
          }
          onClick={() => act(n.action)}
        >
          {busy ? "正在提交…" : n.label || "提交"}
        </button>
      );
    if (n.type === "Field") {
      const shared = { disabled: busy, "aria-label": n.label || n.binding };
      return (
        <label key={n.id} className="field">
          {n.label || n.binding}
          {n.variant === "boolean" ? (
            <input
              {...shared}
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => change(e.target.checked)}
            />
          ) : n.variant === "select" ? (
            <select
              {...shared}
              value={value || ""}
              onChange={(e) => change(e.target.value)}
            >
              <option value="">请选择</option>
              {n.options?.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : n.variant === "multiline" ? (
            <textarea
              {...shared}
              rows={4}
              value={value || ""}
              onChange={(e) => change(e.target.value)}
            />
          ) : (
            <input
              {...shared}
              value={value ?? ""}
              inputMode={
                ["decimal", "integer"].includes(n.variant)
                  ? "decimal"
                  : undefined
              }
              onChange={(e) => change(e.target.value)}
            />
          )}
        </label>
      );
    }
    return null;
  }
  if (!state)
    return (
      <main>
        <p role="status">{error || "正在读取当前任务…"}</p>
      </main>
    );
  return (
    <main>
      {error && (
        <div className="error" role="alert">
          {error}
          <button
            onClick={() =>
              run(async () => {
                const latest = await api("read");
                pendingRevision.current = latest.revision;
                stateRef.current = latest;
                setState(latest);
                setDraft({ ...latest.document.data, ...pending.current });
                setError(
                  Object.keys(pending.current).length
                    ? "输入已保留，请核对更新后的内容再提交。"
                    : "",
                );
              })
            }
          >
            保留输入并刷新
          </button>
        </div>
      )}
      {render(state.document.tree)}
      <footer aria-live="polite">
        <span>
          {Object.keys(pending.current).length
            ? "正在保存…"
            : state.dirty
              ? "修改已保存"
              : state.events[0] &&
                  ["sent", "consumed"].includes(state.events[0].state)
                ? "已提交，助手会继续处理"
                : ""}
        </span>
        {state.events[0]?.state === "pending" && (
          <button
            disabled={busy}
            onClick={() =>
              run(() => api("deliver", { requestId: state.events[0].id }))
            }
          >
            继续处理
          </button>
        )}
        {state.events[0]?.state === "uncertain" && (
          <span>尚未确认是否已接收，请在对话中核对，避免重复执行。</span>
        )}
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")).render(<App />);
