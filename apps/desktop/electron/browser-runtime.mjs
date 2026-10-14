import { WebContentsView, session } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, lstat, rm } from "node:fs/promises";
import { join, basename } from "node:path";
async function bounded(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("网页操作超时，授权已撤销；请核对页面结果后再继续。"),
            ),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function browserURL(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("请输入 HTTPS 地址；本机测试服务可使用 HTTP。");
  return url;
}
export class BrowserRuntime {
  constructor({ window, host, directory, notify = () => {} }) {
    Object.assign(this, { window, host, directory, notify });
    this.pages = new Map();
    this.bound = null;
    this.timer = setInterval(() => {
      for (const p of this.pages.values())
        if (p.grant && Date.now() > p.grant.expiresAt) this.revoke(p.sessionId);
    }, 5000);
    this.timer.unref();
  }
  state(sessionId) {
    const p = this.pages.get(sessionId);
    return p
      ? {
          url: p.view.webContents.getURL(),
          title: p.view.webContents.getTitle(),
          revision: p.revision,
          error: p.error,
          loading: p.view.webContents.isLoading(),
          grant: p.grant
            ? {
                origin: p.grant.origin,
                expiresAt: p.grant.expiresAt,
                files: p.grant.files,
              }
            : null,
          downloads: p.downloads,
          livePages: this.pages.size,
        }
      : null;
  }
  changed(p) {
    this.notify({ type: "browser-changed", sessionId: p.sessionId });
  }
  async open({ sessionId, projectId, url }) {
    browserURL(url);
    let p = this.pages.get(sessionId);
    if (p?.busy || p?.inflight.size)
      throw new Error("页面正在操作或下载，请先核对当前结果。");
    if (!p) {
      await this.host.request("desktop.resources.reserve", {
        kind: "browser",
        id: sessionId,
      });
      const partition = session.fromPartition(
        "persist:turnsu-project-" + projectId,
      );
      partition.setPermissionRequestHandler((_w, _p, reply) => reply(false));
      partition.setPermissionCheckHandler(() => false);
      const view = new WebContentsView({
        webPreferences: {
          session: partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          spellcheck: false,
        },
      });
      p = {
        view,
        sessionId,
        projectId,
        revision: 0,
        downloads: [],
        inflight: new Set(),
        grant: null,
        busy: false,
      };
      this.pages.set(sessionId, p);
      const wc = view.webContents;
      wc.setWindowOpenHandler(({ url: next }) => {
        p.error =
          "页面请求打开新窗口，请在地址栏明确打开目标地址：" +
          next.slice(0, 500);
        this.changed(p);
        return { action: "deny" };
      });
      for (const name of ["will-navigate", "will-redirect"])
        wc.on(name, (event, next) => {
          try {
            const target = browserURL(next);
            if (p.grant && target.origin !== p.grant.origin)
              throw new Error("目标超出本次授权，请接管后重新授权。");
          } catch (e) {
            event.preventDefault();
            p.error = e.message;
            this.revoke(sessionId);
          }
        });
      wc.on("did-start-navigation", (_e, _url, _inPlace, main) => {
        if (main) {
          p.revision++;
          p.error = null;
          this.changed(p);
        }
      });
      wc.on("did-finish-load", () => {
        this.changed(p);
        try {
          const saved = browserURL(wc.getURL());
          this.host
            .request("desktop.browser.remember", {
              sessionId: p.sessionId,
              url: saved.origin + saved.pathname,
            })
            .catch(() => {});
        } catch {}
      });
      wc.on("did-fail-load", (_e, code, description) => {
        if (code !== -3) {
          p.error = description;
          this.changed(p);
        }
      });
      wc.on("render-process-gone", () => {
        p.error = "页面进程已退出，请重新打开；原任务仍保留。";
        this.revoke(sessionId);
      });
      const handler = (event, item, source) => {
        if (source === wc)
          this.download(p, event, item).catch((e) => {
            p.error = e.message;
            this.changed(p);
          });
      };
      partition.on("will-download", handler);
      p.detach = () => partition.removeListener("will-download", handler);
    }
    if (p.grant) this.revoke(sessionId);
    await bounded(p.view.webContents.loadURL(url));
    return this.state(sessionId);
  }
  mount(sessionId, bounds) {
    this.unmount();
    const p = this.pages.get(sessionId);
    if (!p) return;
    this.window.contentView.addChildView(p.view);
    p.view.setBounds(bounds);
    this.bound = p;
    p.view.setVisible(true);
  }
  unmount() {
    if (this.bound) {
      this.window.contentView.removeChildView(this.bound.view);
      this.bound.view.setVisible(false);
      this.bound = null;
    }
  }
  grant(sessionId, files) {
    const p = this.pages.get(sessionId);
    if (!p || p.busy) throw new Error("请先打开并等待当前网页。");
    p.grant = {
      id: randomUUID(),
      origin: browserURL(p.view.webContents.getURL()).origin,
      expiresAt: Date.now() + 15 * 60_000,
      files,
    };
    p.error = null;
    this.changed(p);
    return this.state(sessionId);
  }
  revoke(sessionId) {
    const p = this.pages.get(sessionId);
    if (!p) return;
    p.grant = null;
    if (p.view.webContents.debugger.isAttached())
      p.view.webContents.debugger.detach();
    p.revision++;
    this.changed(p);
  }
  revokeAll() {
    for (const id of this.pages.keys()) this.revoke(id);
  }
  async call({ sessionId, projectId, request: r, file }) {
    const p = this.pages.get(sessionId),
      g = p?.grant;
    const check = () => {
      if (
        !p ||
        p.projectId !== projectId ||
        !g ||
        p.grant !== g ||
        g.expiresAt <= Date.now() ||
        browserURL(p.view.webContents.getURL()).origin !== g.origin
      )
        throw new Error("当前网页未授权或已被接管。");
    };
    check();
    if (p.busy) throw new Error("上一次浏览器操作尚未结束。");
    p.busy = true;
    const wc = p.view.webContents;
    try {
      if (r.operation === "navigate") {
        const next = browserURL(r.url);
        if (next.origin !== g.origin) throw new Error("页面超出授权来源。");
        await bounded(wc.loadURL(next.href));
        check();
        return this.state(sessionId);
      }
      if (r.operation === "read") {
        const result = await bounded(
          wc.executeJavaScript(
            `(()=>({title:document.title,text:(document.body?.innerText||'').slice(0,16000),elements:Array.from(document.querySelectorAll('a,button,input,select,textarea')).slice(0,100).map((e,i)=>({selector:(()=>{const parts=[];let n=e;while(n&&n!==document.documentElement){if(n.id){parts.unshift('#'+CSS.escape(n.id));break;}parts.unshift(n.tagName.toLowerCase()+':nth-of-type('+(Array.from(n.parentElement.children).filter(c=>c.tagName===n.tagName).indexOf(n)+1)+')');n=n.parentElement;}return parts.join(' > ');})(),tag:e.tagName,type:e.type||'',label:(e.getAttribute('aria-label')||e.innerText||e.placeholder||'').slice(0,120)}))}))()`,
          ),
        );
        check();
        p.observed = result.elements;
        return { ...result, revision: p.revision, url: wc.getURL() };
      }
      if (!Number.isInteger(r.revision) || r.revision !== p.revision)
        throw new Error("网页已变化，请重新读取目标。");
      if (typeof r.selector !== "string" || r.selector.length > 1000)
        throw new Error("请选择刚读取的元素。");
      const observed = p.observed?.find((e) => e.selector === r.selector);
      if (!observed)
        throw new Error("目标未在当前页面读取中出现，请重新读取。");
      const target = await bounded(
        wc.executeJavaScript(
          "(()=>{const es=document.querySelectorAll(" +
            JSON.stringify(r.selector) +
            ');if(es.length!==1)throw new Error("目标不是唯一元素");const e=es[0];e.scrollIntoView({block:"center"});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2,type:e.type||"",tag:e.tagName,disabled:e.disabled,label:(e.getAttribute("aria-label")||e.innerText||e.placeholder||"").slice(0,120),visible:b.width>0&&b.height>0&&getComputedStyle(e).visibility!=="hidden"&&e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))};})()',
        ),
      );
      check();
      if (
        target.tag !== observed.tag ||
        target.type !== observed.type ||
        target.label !== observed.label
      )
        throw new Error("目标内容已变化，请重新读取后操作。");
      if (!target.visible || target.disabled)
        throw new Error("目标不可见或不可用。");
      if (r.operation === "upload") {
        const allowed =
          file &&
          g.files.find((f) => f.path === file.path && f.sha256 === file.sha256);
        if (!allowed || target.type !== "file")
          throw new Error("文件不在授权范围或目标不是上传控件。");
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        const { root } = await bounded(
          wc.debugger.sendCommand("DOM.getDocument", { depth: 0 }),
        );
        check();
        const { nodeId } = await bounded(
          wc.debugger.sendCommand("DOM.querySelector", {
            nodeId: root.nodeId,
            selector: r.selector,
          }),
        );
        check();
        await bounded(
          wc.debugger.sendCommand("DOM.setFileInputFiles", {
            nodeId,
            files: [file.absolute],
          }),
        );
        check();
        const selected = await bounded(
          wc.executeJavaScript(
            "Array.from(document.querySelector(" +
              JSON.stringify(r.selector) +
              ").files).map(f=>({name:f.name,size:f.size}))",
          ),
        );
        check();
        if (
          selected.length !== 1 ||
          selected[0].name !== basename(file.path) ||
          selected[0].size !== file.bytes
        )
          throw new Error(
            "浏览器未实际选中文件，请检查文件可读性与系统 UTF-8 编码。",
          );
        return {
          selected: file.path,
          sha256: file.sha256,
          note: "已填入上传控件；服务端接收仍需核对网页回执。",
        };
      }
      if (!["click", "type"].includes(r.operation))
        throw new Error("未知浏览器操作。");
      if (
        r.operation === "type" &&
        (!["INPUT", "TEXTAREA"].includes(target.tag) ||
          ["password", "file", "hidden"].includes(target.type))
      )
        throw new Error("此输入需用户手动完成。");
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        check();
        await bounded(
          wc.debugger.sendCommand("Input.dispatchMouseEvent", {
            type,
            x: target.x,
            y: target.y,
            button: type === "mouseMoved" ? "none" : "left",
            clickCount: type === "mouseMoved" ? 0 : 1,
          }),
        );
      }
      if (r.operation === "type") {
        if (typeof r.text !== "string" || r.text.length > 16000)
          throw new Error("输入内容无效。");
        const focused = await bounded(
          wc.executeJavaScript(
            "document.activeElement?.matches(" +
              JSON.stringify(r.selector) +
              ")",
          ),
        );
        check();
        if (!focused) throw new Error("输入焦点未交接，请接管网页后重试。");
        await bounded(
          wc.debugger.sendCommand("Input.insertText", { text: r.text }),
        );
      }
      check();
      return {
        performed: r.operation,
        revision: p.revision,
        note: "请读取页面核对结果；操作返回不等于业务成功。",
      };
    } catch (e) {
      this.revoke(sessionId);
      throw e;
    } finally {
      p.busy = false;
    }
  }
  async download(p, event, item) {
    if (p.inflight.size >= 2 || item.getTotalBytes() > 32 * 1024 * 1024) {
      event.preventDefault();
      p.error = "下载超过并行或文件大小上限。";
      this.changed(p);
      return;
    }
    try {
      browserURL(item.getURL());
    } catch {
      event.preventDefault();
      p.error = "此下载来源不可用。";
      this.changed(p);
      return;
    }
    if (p.grant && new URL(item.getURL()).origin !== p.grant.origin) {
      event.preventDefault();
      p.error = "下载来源超出授权。";
      this.changed(p);
      return;
    }
    // Chromium starts no transfer until this synchronous handler assigns its destination.
    const name =
      basename(item.getFilename())
        .replace(/[^\p{L}\p{N}._ -]/gu, "_")
        .slice(0, 120) || "download";
    const target = join(this.directory, randomUUID() + "-" + name);
    item.setSavePath(target);
    p.inflight.add(item);
    item.on("updated", () => {
      if (item.getReceivedBytes() > 32 * 1024 * 1024) item.cancel();
    });
    item.once("done", async (_event, status) => {
      p.inflight.delete(item);
      let receipt = { name, status };
      try {
        if (status === "completed") {
          const result = await this.host.request("files.import", {
            projectId: p.projectId,
            paths: [target],
          });
          receipt = { ...receipt, result };
        } else receipt.error = "下载未完成，未导入项目。";
      } catch (e) {
        receipt.error = e.message;
        receipt.status = "failed";
      } finally {
        await rm(target, { force: true }).catch(() => {});
        p.downloads = [receipt, ...p.downloads].slice(0, 10);
        this.changed(p);
      }
    });
  }
  async close(sessionId, { force = false } = {}) {
    const p = this.pages.get(sessionId);
    if (!p) return;
    if (!force && (p.busy || p.inflight.size))
      throw new Error("页面正在执行或下载，请先停止并核对结果。");
    this.revoke(sessionId);
    if (this.bound === p) this.unmount();
    for (const d of p.inflight) d.cancel();
    p.detach();
    p.view.webContents.close({ waitForBeforeUnload: false });
    this.pages.delete(sessionId);
    await this.host.request("desktop.resources.release", {
      kind: "browser",
      id: sessionId,
    });
  }
  async shutdown() {
    clearInterval(this.timer);
    for (const id of this.pages.keys()) await this.close(id, { force: true });
  }
}
