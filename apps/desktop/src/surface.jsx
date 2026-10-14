import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./surface.css";
import { FileText, Plus, Check, ArrowRight } from "lucide-react";
import { surfaceBridge } from "./surface-bridge.mjs";
import {
  presentationEvents,
  confirmationState,
  surfaceStatus,
  numericColumns,
} from "./surface-state.mjs";
const api = (method, args) => surfaceBridge.invoke(method, args);
const hasStatus = (node) =>
  node?.type === "Status" || node?.children?.some(hasStatus);
function DataView({ node, value, onChange, disabled }) {
  const [page, setPage] = useState(0);
  const rows = Array.isArray(value) ? value : [],
    cols = node.columns || [],
    last = Math.max(0, Math.ceil(rows.length / 40) - 1);
  const numbers = numericColumns(rows, cols);
  useEffect(() => setPage((p) => Math.min(p, last)), [last]);
  return (
    <section className="dataView">
      {node.label && <h2>{node.label}</h2>}
      {rows.length ? (
        <>
          <div className="tableScroll">
            <table aria-label={node.label || "核对数据"}>
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      className={numbers.has(c.key) ? "numeric" : undefined}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(page * 40, (page + 1) * 40).map((r, i) => (
                  <tr key={r.id || page * 40 + i}>
                    {cols.length ? (
                      cols.map((c) => (
                        <td
                          key={c.key}
                          className={numbers.has(c.key) ? "numeric" : undefined}
                        >
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
        <section key={n.id} className="assets">
          <div className="sectionTitle">
            <h2>{n.label || "选定材料"}</h2>
            <button disabled={busy} onClick={() => act("import")}>
              <Plus size={15}/>添加文件
            </button>
          </div>
          <ul className="materialNames">
            {state.assets.map((file) => (
              <li key={file.path}><FileText size={18}/><span><strong>{file.path.split("/").at(-1)}</strong><small>项目材料{Number.isFinite(file.bytes) ? ` · ${file.bytes < 1024 ? "不到 1" : Math.ceil(file.bytes / 1024)} KB` : ""}</small></span></li>
            ))}
          </ul>
          {!state.assets.length && (
            <p className="muted">添加本次工作需要的文件，原件会保留。</p>
          )}
        </section>
      );
    if (n.type === "Status") {
      const status = surfaceStatus({ ...state, error: error || state.error }, busy);
      return (
        <section key={n.id} className="statusBlock">
          {n.label && <h2>{n.label}</h2>}
          {n.text && <p className="statusDescription">{n.text}</p>}
          <p className="status" role="status" data-tone={status.tone}>
            {status.label}
            {state.error ? " · " + state.error : ""}
          </p>
        </section>
      );
    }
    if (n.type === "Action") {
      const confirmation = n.action === "submit" ? confirmationState(state) : null;
      const submitted = Boolean(confirmation);
      const label = !submitted
        ? n.label || "提交"
        : confirmation === "uncertain"
          ? "接收状态待核对"
          : confirmation === "confirmed"
            ? "已确认"
            : confirmation === "pending"
              ? "已确认，等待接收"
            : "正在交给助手";
      return (
        <button
          key={n.id}
          className="primary"
          data-confirmation={confirmation || undefined}
          disabled={busy || submitted}
          onClick={() => act(n.action)}
        >
          {confirmation === "confirmed" && <Check size={15}/>}
          {busy ? "正在提交…" : label}
          {!submitted && !busy && <ArrowRight size={15}/>}
        </button>
      );
    }
    if (n.type === "Field") {
      const shared = { disabled: busy, "aria-label": n.label || n.binding };
      return (
        <label
          key={n.id}
          className={"field" + (n.variant === "boolean" ? " boolean" : "")}
        >
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
  const currentEvent = presentationEvents(state)[0];
  const feedback = Object.keys(pending.current).length
    ? "正在保存…"
    : hasStatus(state.document.tree)
      ? ""
      : state.dirty
      ? "修改已保存"
      : ["sent", "consumed"].includes(currentEvent?.state)
        ? "确认内容已交给助手"
        : "";
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
      {(feedback || ["pending", "uncertain"].includes(currentEvent?.state)) && (
        <footer aria-live="polite">
          {feedback && <span>{feedback}</span>}
          {currentEvent?.state === "pending" && (
            <button
              disabled={busy}
              onClick={() =>
                run(() => api("deliver", { requestId: currentEvent.id }))
              }
            >
              继续处理
            </button>
          )}
          {currentEvent?.state === "uncertain" && (
            <span>尚未确认是否已接收，请在对话中核对，避免重复执行。</span>
          )}
        </footer>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")).render(<App />);
