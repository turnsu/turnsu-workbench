import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X, Globe, Square, ArrowRight } from "lucide-react";
import { invoke, listen } from "../../platform/desktop-bridge.mjs";
import "./embedded.css";
export function EmbeddedPane({ sessionId, onClose }) {
  const slot = useRef(null),
    [url, setURL] = useState(""),
    [state, setState] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const getBounds = () => {
    const r = slot.current.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  async function refresh() {
    const s = await invoke("browser_read", { sessionId });
    setState(s);
    if (s?.url) setURL(s.url);
  }
  async function act(fn) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useLayoutEffect(() => {
    let live = true;
    invoke("embedded_open", { sessionId, bounds: getBounds() }).catch(
      (e) => live && setError(e.message),
    );
    const observer = new ResizeObserver(() =>
      invoke("embedded_resize", { sessionId, bounds: getBounds() }).catch(
        () => {},
      ),
    );
    observer.observe(slot.current);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [sessionId]);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const sub = listen(({ payload }) => {
      if (payload.type === "browser-changed" && payload.sessionId === sessionId)
        refresh().catch((e) => setError(e.message));
    });
    return () => {
      sub.then((off) => off());
      invoke("embedded_hide").catch(() => {});
    };
  }, [sessionId]);
  return (
    <aside className="embeddedPane" aria-label="工作网页">
      <div className="embeddedHeader">
        <strong>
          <Globe size={16} />
          网页
        </strong>
        <button aria-label="收起网页" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <form
        className="browserAddress"
        onSubmit={(e) => {
          e.preventDefault();
          act(async () => {
            await invoke("browser_open", { sessionId, url });
            await invoke("embedded_open", { sessionId, bounds: getBounds() });
          });
        }}
      >
        <Globe size={15} />
        <input
          aria-label="网页地址"
          placeholder="输入网站地址"
          value={url}
          onChange={(e) => setURL(e.target.value)}
        />
        <button aria-label="打开网页" disabled={busy}>
          <ArrowRight size={16} />
        </button>
      </form>
      {state?.resident !== false && state && (
        <div className="browserControls">
          <span>{state.grant ? "助手正在获准范围内操作" : "你在浏览"}</span>
          {state.grant ? (
            <button
              onClick={() => act(() => invoke("browser_revoke", { sessionId }))}
            >
              <Square size={13} />
              我来操作
            </button>
          ) : (
            <button
              onClick={() => act(() => invoke("browser_grant", { sessionId }))}
            >
              让助手操作
            </button>
          )}
          <button
            aria-label="关闭网页并释放内存"
            onClick={() => act(() => invoke("browser_close", { sessionId }))}
          >
            关闭网页
          </button>
        </div>
      )}
      {(error || state?.error) && (
        <p role="alert" className="embeddedError">
          {error || state.error}
        </p>
      )}
      <div className="embeddedSlot" ref={slot}>
        {(!state || state.resident === false) && (
          <div className="browserWelcome">
            <Globe size={30} />
            <h3>在这里打开工作网站</h3>
            <p>
              浏览资料，或允许助手帮你填写与处理。
              <br />
              操作前会与你确认网站和文件范围。
            </p>
          </div>
        )}
      </div>
      {state?.downloads?.length > 0 && (
        <div className="browserDownloads">
          {state.downloads.map((d, i) => (
            <p key={i}>
              {d.name} ·{" "}
              {d.error ||
                (d.result?.failed?.length
                  ? "部分文件未保存"
                  : "已保存到工作文件夹")}
            </p>
          ))}
        </div>
      )}
    </aside>
  );
}
