import { Button } from '../shared/ResearchControls.jsx';
import React, { useEffect, useRef, useState } from "react";
import "./surface.css";
import { FileText, ArrowUpRight } from "lucide-react";
import { surfaceBridge } from "./surface-bridge.mjs";
import { IntelligencePage, INVALID_INPUT_MESSAGE } from './IntelligencePage.jsx';
import {
  presentationEvents,
  confirmationState,
  surfaceStatus,
  canRebaseSurfaceEdits,
} from "./surface-state.mjs";
const api = (method, args) => surfaceBridge.invoke(method, args);
export default function App() {
  const [state, setState] = useState(null),
    [draft, setDraft] = useState({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef({}),
    pendingRevision = useRef(null),
    pendingBase = useRef(null),
    alive = useRef(true),
    request = useRef(null),
    autosave = useRef(null),
    stateRef = useRef(null),
    page = useRef(null),
    saveCallback = useRef(null),
    saveQueue = useRef(Promise.resolve()),
    operating = useRef(false);
  stateRef.current = state;
  const read = async () => {
    const s = await api("read");
    if (stateRef.current && s.revision < stateRef.current.revision) return;
    const editing = Object.keys(pending.current).length > 0;
    if (alive.current && (!editing || canRebaseSurfaceEdits(pendingBase.current, s, pending.current))) {
      if (editing) { pendingRevision.current = s.revision; pendingBase.current = s; }
      if (stateRef.current?.presentation?.revision !== s.presentation?.revision) setError('');
      stateRef.current = s;
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
    page.current?.validate();
    if (!Object.keys(pending.current).length) return stateRef.current;
    const values = { ...pending.current };
    const base = pendingBase.current || stateRef.current;
    let s;
    try {
      s = await api("save", { revision: pendingRevision.current ?? base.revision, values });
    } catch (e) {
      // A version rejection means this write did not happen. Never retry an
      // unknown transport failure, submission, or business operation here.
      if (!e.message.includes('界面已有更新')) throw e;
      const latest = await api('read');
      if (!canRebaseSurfaceEdits(base, latest, values)) throw e;
      s = await api('save', { revision: latest.revision, values });
    }
    for (const [k, v] of Object.entries(values))
      if (pending.current[k] === v) delete pending.current[k];
    pendingRevision.current = Object.keys(pending.current).length
      ? s.revision
      : null;
    pendingBase.current = Object.keys(pending.current).length ? s : null;
    stateRef.current = s;
    setState(s);
    setDraft({ ...s.document.data, ...pending.current });
    return s;
  }
  saveCallback.current = save;
  async function act(operation, action) {
    if (operating.current || stateRef.current?.readOnly) return;
    operating.current = true;
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
        const event = s.events.find((e) => e.state === "pending" || e.id === s.continuation?.requestId);
        if (!event) throw new Error("没有待回传的交互，不会重复执行任务。");
        await api("deliver", { requestId: event.id, continueConfirmed: event.id === s.continuation?.requestId });
        await read();
      } else {
        request.current ||= crypto.randomUUID();
        await api("submit", {
          revision: s.revision,
          requestId: request.current,
          ...(action ? { action } : {}),
        });
        request.current = null;
        await read();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      operating.current = false;
      setBusy(false);
    }
  }
  async function run(fn) {
    if (operating.current) return;
    operating.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      await read();
    } catch (e) {
      setError(e.message);
    } finally {
      operating.current = false;
      setBusy(false);
    }
  }
  function changeValues(values) {
    if (stateRef.current?.readOnly) return;
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(draft[key])));
    if (!Object.keys(changed).length) return;
    pendingRevision.current ??= stateRef.current.revision;
    pendingBase.current ??= stateRef.current;
    Object.assign(pending.current, changed);
    setDraft(previous => ({ ...previous, ...changed }));
    clearTimeout(autosave.current);
    autosave.current = setTimeout(() => saveCallback.current().catch(error => setError(error.message)), 450);
  }
  if (!state)
    return (
      <main>
        <p role="status">{error || "正在读取当前任务…"}</p>
      </main>
    );
  const currentEvent = presentationEvents(state)[0];
  const status = surfaceStatus({ ...state, error: error || state.error }, busy);
  const sources = (state.assets || []).map(file => file.path?.split("/").at(-1)).filter(Boolean);
  const canContinue = state.continuation?.requestId === currentEvent?.id && Boolean(currentEvent);
  const feedback = Object.keys(pending.current).length
    ? "正在保存…"
    : status.label
      ? status.label
      : state.dirty
      ? "修改已保存"
      : ["sent", "consumed"].includes(currentEvent?.state)
        ? "确认内容已交给助手"
        : "";
  return (
    <main data-host="workbench">
      {state.deliveryNotice && <p role="status">{state.deliveryNotice}</p>}
      {error && (
        <div className="error" role="alert">
          {error}
          <Button
            onClick={() =>
              run(async () => {
                const latest = await api("read");
                pendingRevision.current = latest.revision;
                pendingBase.current = latest;
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
          </Button>
        </div>
      )}
      <IntelligencePage ref={page} document={{ ...state.document, data: draft }}
        task={{ state, busy, disabled: busy || state.readOnly, confirmation: confirmationState({ ...state, dirty: state.dirty || Object.keys(pending.current).length > 0 }), act,
          openFile: path => run(() => api('open_file', { path })) }}
        onChange={changeValues} onConfirm={action => {
          if (confirmationState({ ...stateRef.current, dirty: stateRef.current.dirty || Object.keys(pending.current).length > 0 })) return;
          return act('submit', action);
        }} onError={setError} onEdit={() => setError(previous => previous === INVALID_INPUT_MESSAGE ? '' : previous)}/>
      {state.readOnly && state.assets?.length > 0 && <section className="assets" aria-label="已保存的材料">
        <ul className="materialNames">{state.assets.map(file => <li className="fileReference" key={file.path}><Button aria-label={'打开文件：' + file.path.split('/').at(-1)} disabled={busy || !state.fileAccess} onClick={() => run(() => api('open_file', { path: file.path }))}><FileText size={18}/><span><strong>{file.path.split('/').at(-1)}</strong><small>已保存的材料</small></span><ArrowUpRight size={16}/></Button></li>)}</ul>
      </section>}
      {(sources.length > 0 || feedback || canContinue || ["pending", "uncertain"].includes(currentEvent?.state)) && (
        <footer>
          {sources.length > 0 && <span className="surfaceSources" title={sources.join("、")}>材料 · {sources.slice(0, 3).join("、")}{sources.length > 3 ? ` 等 ${sources.length} 份` : ""}</span>}
          {feedback && <span className="status" role="status" data-tone={status.tone}>{feedback}{state.error ? " · " + state.error : ""}</span>}
          {(currentEvent?.state === "pending" || canContinue) && (
            <Button
              disabled={busy || state.readOnly}
              onClick={() =>
                run(() => api("deliver", { requestId: currentEvent.id, continueConfirmed: canContinue }))
              }
            >
              继续处理
            </Button>
          )}
          {currentEvent?.state === "uncertain" && (
            <span>尚未确认是否已接收，请在对话中核对，避免重复执行。</span>
          )}
        </footer>
      )}
    </main>
  );
}
