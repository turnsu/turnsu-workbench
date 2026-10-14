import React, { useEffect, useRef, useState } from "react";
import {
  AppBridge,
  PostMessageTransport,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { Maximize2, Minimize2, PanelsTopLeft } from "lucide-react";
import { invoke, listen } from "./desktop-bridge.mjs";

let current = null;
let disposal = Promise.resolve();
export async function flushConversationSurface() {
  await current?.flush();
}
const methods = new Set(["read", "save", "submit", "deliver", "import"]);

export function ConversationSurface({ sessionId, title, expanded, onExpand, theme = "light" }) {
  const toggle = useRef(null);
  const connectedBridge = useRef(null);
  const hostContext = useRef(null);
  hostContext.current = { theme, platform: "desktop", displayMode: expanded ? "fullscreen" : "inline", availableDisplayModes: ["inline", "fullscreen"] };
  const frame = useRef(null),
    actions = useRef({ onExpand });
  actions.current = { onExpand };
  const [height, setHeight] = useState(260),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    connectedBridge.current?.setHostContext(hostContext.current);
  }, [theme, expanded]);
  useEffect(() => {
    if (!expanded) return;
    toggle.current?.focus({ preventScroll: true });
    const close = event => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        actions.current.onExpand(false);
        toggle.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [expanded]);
  useEffect(() => {
    let disposed = false,
      bridge,
      token,
      off,
      initialized = false;
    const controller = {
      flush: async () => {
        if (initialized) await bridge.teardownResource({}, { timeout: 4500 });
      },
    };
    const opening = (async () => {
      await disposal;
      if (disposed) return;
      ({ token } = await invoke("surface_open", { sessionId }));
      if (disposed) return;
      const call = (method, args = {}) =>
        invoke("surface_call", { token, method, args });
      const resource = await call("resource");
      if (
        resource.contents?.[0]?.mimeType !== RESOURCE_MIME_TYPE ||
        resource.contents[0].uri !== "ui://turnsu/intelligence.html"
      )
        throw new Error("交互内容暂时无法打开。");
      bridge = new AppBridge(
        null,
        { name: "turnsu-workbench", version: "1.0.0" },
        { serverTools: {}, updateModelContext: { text: {} } },
        {
          hostContext: hostContext.current,
        },
      );
      bridge.oncalltool = async ({ name, arguments: input }) => {
        if (
          disposed ||
          name !== "turnsu_surface" ||
          !methods.has(input?.method)
        )
          return {
            content: [{ type: "text", text: "不支持这个操作。" }],
            isError: true,
          };
        try {
          return {
            content: [],
            structuredContent: { value: await call(input.method, input.args) },
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: e.message }],
            isError: true,
          };
        }
      };
      bridge.onupdatemodelcontext = async (params) => {
        await call("context", params);
        return {};
      };
      bridge.onsizechange = ({ height: value }) => {
        if (Number.isFinite(value))
          setHeight(Math.max(120, Math.min(680, value)));
      };
      bridge.onrequestdisplaymode = async ({ mode }) => {
        actions.current.onExpand(mode === "fullscreen");
        return { mode };
      };
      bridge.oninitialized = async () => {
        if (disposed) return;
        initialized = true;
        connectedBridge.current = bridge;
        bridge.setHostContext(hostContext.current);
        await bridge.sendToolInput({ arguments: { operation: "read" } });
        await bridge.sendToolResult({
          content: [],
          structuredContent: { value: await call("read") },
        });
        if (!disposed) setLoading(false);
      };
      await bridge.connect(
        new PostMessageTransport(
          frame.current.contentWindow,
          frame.current.contentWindow,
        ),
      );
      off = await listen(({ payload }) => {
        if (
          ["ui-changed", "changed"].includes(payload.type) &&
          payload.sessionId === sessionId
        )
          bridge
            .sendToolResult({
              content: [],
              structuredContent: { changed: true },
            })
            .catch(() => {});
      });
      if (!disposed) {
        current = controller;
        frame.current.src = "turnsu-ui://app/intelligence.html";
      }
    })();
    opening.catch((e) => {
      if (!disposed) setError(e.message);
    });
    return () => {
      disposed = true;
      if (connectedBridge.current === bridge) connectedBridge.current = null;
      off?.();
      if (current === controller) current = null;
      disposal = opening
        .catch(() => {})
        .then(async () => {
          bridge?.close();
          if (token) await invoke("surface_close", { token });
        })
        .catch(() => {});
    };
  }, [sessionId]);
  return (
    <section
      className={`conversationSurface ${expanded ? "expanded" : ""}`}
      aria-label={title}
    >
      <div className="surfaceHeading">
        <span>
          <PanelsTopLeft size={17} />
          <strong>{title}</strong>
        </span>
        <button
          ref={toggle}
          aria-label={expanded ? "收起到对话" : "展开内容"}
          title={expanded ? "收起到对话" : "展开内容"}
          onClick={() => onExpand(!expanded)}
        >
          {expanded ? <><Minimize2 size={16} /><span>返回对话</span></> : <Maximize2 size={16} />}
        </button>
      </div>
      {error && (
        <p role="alert" className="inlineError">
          {error}
        </p>
      )}
      {loading && !error && (
        <p className="surfaceLoading" role="status">
          正在打开内容…
        </p>
      )}
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-scripts"
        style={{ height: expanded ? "100%" : height }}
      />
    </section>
  );
}
