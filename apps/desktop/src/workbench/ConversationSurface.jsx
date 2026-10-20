import { ToolbarButton } from "./WorkbenchControls.jsx";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AppBridge,
  PostMessageTransport,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { Maximize2, Minimize2 } from "lucide-react";
import { invoke, listen } from "../platform/desktop-bridge.mjs";
import { registeredSurfaceFile } from "../intelligence-ui/surface-state.mjs";

let current = null;
let disposal = Promise.resolve();
export async function flushConversationSurface() {
  await current?.flush();
}
const methods = new Set(["read", "save", "submit", "deliver", "import", "open_file", "media"]);

export function ConversationSurface({ sessionId, title, container, anchor, expanded, onExpand, onOpenFile, theme = "light", textSize = "standard" }) {
  const [mount] = useState(() => {
    const element = document.createElement("div");
    element.className = "surfaceMount";
    return element;
  });
  // React owns the portal contents; Chromium moves the connected mount without
  // unloading its sandboxed iframe. DOM, keyboard and visual order stay aligned.
  useLayoutEffect(() => {
    const parent = container.current;
    if (!parent) return;
    const message = [...parent.children].find(node => node.dataset.messageId === anchor);
    const next = message ? message.nextSibling : null;
    if (next === mount || (mount.parentNode === parent && mount.nextSibling === next)) return;
    if (mount.isConnected) parent.moveBefore(mount, next);
    else parent.insertBefore(mount, next);
  });
  useLayoutEffect(() => () => mount.remove(), [mount]);
  const toggle = useRef(null);
  const connectedBridge = useRef(null);
  const hostContext = useRef(null);
  hostContext.current = { ...hostContext.current, theme, platform: "desktop", displayMode: expanded ? "fullscreen" : "inline", availableDisplayModes: ["inline", "fullscreen"] };
  const frame = useRef(null),
    actions = useRef({ onExpand, onOpenFile });
  actions.current = { onExpand, onOpenFile };
  const [height, setHeight] = useState(260),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const variables = Object.fromEntries(Object.entries({
      '--color-background-primary': '--work-surface', '--color-background-secondary': '--work-paper',
      '--color-background-tertiary': '--work-soft', '--color-background-ghost': '--work-hover',
      '--color-background-inverse': '--primary', '--color-background-info': '--work-selected',
      '--color-background-danger': '--work-danger-soft', '--color-background-success': '--work-success-soft',
      '--color-background-warning': '--work-warning-soft', '--color-background-disabled': '--work-disabled',
      '--color-text-primary': '--work-ink', '--color-text-secondary': '--work-muted',
      '--color-text-tertiary': '--work-muted',
      '--color-text-inverse': '--primary-foreground', '--color-text-info': '--work-accent',
      '--color-text-danger': '--work-danger', '--color-text-success': '--work-green',
      '--color-text-warning': '--work-warning', '--color-text-disabled': '--work-disabled-ink',
      '--color-border-primary': '--work-line-strong', '--color-border-secondary': '--work-line',
      '--color-border-tertiary': '--work-line-subtle', '--color-border-danger': '--work-danger-line',
      '--color-border-warning': '--work-warning-line',
      '--color-ring-primary': '--ring', '--font-sans': '--work-font', '--font-mono': '--font-mono',
      '--font-text-xs-size': '--type-control', '--font-text-sm-size': '--type-data',
      '--font-text-md-size': '--type-body', '--font-text-lg-size': '--type-reading',
      '--font-heading-xs-size': '--type-body', '--font-heading-sm-size': '--type-section', '--font-heading-md-size': '--type-title',
    }).map(([key, token]) => [key, style.getPropertyValue(token).trim()]));
    Object.assign(variables, { '--font-text-xs-line-height': '1.5', '--font-text-sm-line-height': '1.5', '--font-text-md-line-height': '1.5', '--font-text-lg-line-height': '1.5', '--border-radius-sm': '7px', '--border-radius-md': '12px' });
    hostContext.current = { ...hostContext.current, styles: { variables } };
    connectedBridge.current?.setHostContext(hostContext.current);
  }, [theme, textSize, expanded]);
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
        { serverTools: {}, updateModelContext: { text: {} }, openLinks: {} },
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
          if (input.method === "open_file") {
            const state = await call("read");
            const file = registeredSurfaceFile(state, input.args?.path);
            if (disposed || !file || !actions.current.onOpenFile)
              throw new Error("文件未关联当前工作，无法打开。请让助手核对成果。");
            await actions.current.onOpenFile(file);
            return { content: [], structuredContent: { value: { opened: true } } };
          }
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
      bridge.onopenlink = async ({ url }) => {
        if (disposed || !/^https?:\/\//i.test(url)) throw new Error('链接无效。');
        await invoke('browser_open', { sessionId, url });
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
  return createPortal(
    <section
      className={`conversationSurface ${expanded ? "expanded" : ""}`}
      aria-label={title}
    >
      <div className="surfaceHeading">
        <span className="surfaceTitle"><small>工作内容</small><strong>{title}</strong></span>
        <ToolbarButton
          ref={toggle}
          aria-label={expanded ? "收起到对话" : "展开内容"}
          title={expanded ? "收起到对话" : "展开内容"}
          onClick={() => onExpand(!expanded)}
        >
          {expanded ? <><Minimize2 size={16} /><span>返回对话</span></> : <><Maximize2 size={14} /><span>展开</span></>}
        </ToolbarButton>
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
    </section>,
    mount,
  );
}
