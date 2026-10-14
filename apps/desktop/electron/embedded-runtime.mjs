import { dialog } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { BrowserRuntime } from "./browser-runtime.mjs";

// The conversation owns one sandboxed App. Expanding it never creates another
// renderer or task. External websites remain isolated WebContentsViews.
export class EmbeddedRuntime {
  constructor({ window, host, directory, notify }) {
    Object.assign(this, { window, host, notify });
    this.inline = null;
    this.binding = null;
    this.browser = new BrowserRuntime({
      window,
      host,
      directory: join(directory, "browser-downloads"),
      notify,
    });
    this.ready = mkdir(join(directory, "browser-downloads"), {
      recursive: true,
      mode: 0o700,
    });
  }
  bounds(value) {
    const [w, h] = this.window.getContentSize();
    if (
      !value ||
      !["x", "y", "width", "height"].every((k) => Number.isFinite(value[k]))
    )
      throw new Error("浏览器区域尺寸无效。");
    const x = Math.max(0, Math.round(value.x)),
      y = Math.max(0, Math.round(value.y));
    return {
      x,
      y,
      width: Math.max(0, Math.min(w - x, Math.round(value.width))),
      height: Math.max(0, Math.min(h - y, Math.round(value.height))),
    };
  }
  async surfaceCall({ token, method, args = {} }) {
    const target = this.inline;
    if (!target || token !== target.token)
      throw new Error("这段内容已关闭，请重新打开。");
    if (JSON.stringify(args).length > 140_000)
      throw new Error("内容过长，请分次处理。");
    const sessionId = target.id,
      projectId = target.project_id;
    switch (method) {
      case "resource":
        return this.host.request("ui.resource", { sessionId });
      case "context":
        return this.host.request("ui.context", { sessionId, value: args });
      case "read":
        return this.host.request("ui.read", { sessionId });
      case "save":
        return this.host.request("ui.save", { ...args, sessionId });
      case "submit":
        await this.host.request("ui.commit", { ...args, sessionId });
        return this.host.request("ui.deliver", {
          sessionId,
          requestId: args.requestId,
        });
      case "deliver":
        return this.host.request("ui.deliver", {
          sessionId,
          requestId: args.requestId,
        });
      case "import": {
        const selected = await dialog.showOpenDialog(this.window, {
          title: "添加这项工作需要的材料",
          properties: ["openFile", "multiSelections"],
        });
        if (selected.canceled)
          return this.host.request("ui.read", { sessionId });
        if (this.inline !== target)
          throw new Error("当前工作已切换，未添加文件。");
        const result = await this.host.request("files.import", {
          projectId,
          paths: selected.filePaths,
        });
        const state = await this.host.request("ui.attach", {
          sessionId,
          paths: result.imported.map((f) => f.path),
        });
        return { ...state, importFailures: result.failed };
      }
      default:
        throw new Error("不支持这项交互操作。");
    }
  }
  async open(args) {
    await this.ready;
    const s = await this.host.request("session.read", {
      sessionId: args.sessionId,
    });
    this.binding = s;
    this.rect = this.bounds(args.bounds);
    this.browser.mount(s.id, this.rect);
    return this.browser.state(s.id);
  }
  resize(args) {
    if (this.binding?.id === args.sessionId) {
      this.rect = this.bounds(args.bounds);
      this.browser.bound?.view.setBounds(this.rect);
    }
  }
  async hide() {
    this.browser.unmount();
    this.binding = null;
  }
  event(payload) {
    if (
      payload.type === "changed" &&
      this.browser.pages?.has(payload.sessionId)
    )
      this.host
        .request("session.read", { sessionId: payload.sessionId })
        .then((s) => {
          if (["stopping", "interrupted", "failed"].includes(s.status))
            this.browser.revoke(s.id);
        })
        .catch(() => {});
  }
  async invoke(operation, args = {}) {
    if (operation === "surface_open") {
      if (this.inline) throw new Error("请先保存并关闭上一段交互内容。");
      const s = await this.host.request("session.read", {
        sessionId: args.sessionId,
      });
      await this.host.request("desktop.resources.reserve", {
        kind: "surface",
        id: s.id,
      });
      this.inline = { id: s.id, project_id: s.project_id, token: randomUUID() };
      return { token: this.inline.token };
    }
    if (operation === "surface_call") return this.surfaceCall(args);
    if (operation === "surface_close") {
      if (this.inline?.token === args.token) {
        const id = this.inline.id;
        this.inline = null;
        await this.host.request("desktop.resources.release", {
          kind: "surface",
          id,
        });
      }
      return;
    }
    if (operation === "embedded_suspend") {
      this.suspend(args.suspended === true);
      return;
    }
    if (operation === "embedded_open") return this.open(args);
    if (operation === "embedded_resize") return this.resize(args);
    if (operation === "embedded_hide") return this.hide();
    const s = await this.host.request("session.read", {
      sessionId: args.sessionId,
    });
    if (operation === "browser_open")
      return this.browser.open({
        sessionId: s.id,
        projectId: s.project_id,
        url: args.url,
      });
    if (operation === "browser_read")
      return (
        this.browser.state(s.id) ||
        this.host.request("desktop.browser.read", { sessionId: s.id })
      );
    if (operation === "browser_revoke") {
      this.browser.revoke(s.id);
      return this.browser.state(s.id);
    }
    if (operation === "browser_close") {
      const answer = await dialog.showMessageBox(this.window, {
        type: "question",
        message: "关闭这个网页？",
        detail: "网页里未提交的内容可能丢失。对话和已保存的成果会保留。",
        buttons: ["保留页面", "关闭网页"],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response === 1) await this.browser.close(s.id);
      return this.browser.state(s.id);
    }
    if (operation === "browser_grant") {
      const state = await this.host.request("ui.read", { sessionId: s.id }),
        page = this.browser.state(s.id);
      if (!page) throw new Error("请先打开要处理的网站。");
      const answer = await dialog.showMessageBox(this.window, {
        type: "question",
        message: "让助手在这个网站帮你完成工作？",
        detail:
          "网站：" +
          new URL(page.url).origin +
          "\n助手可以读取、填写和点击此网页，有效期 15 分钟。\n可上传的材料：" +
          (state.assets.map((f) => f.path.split("/").at(-1)).join("、") ||
            "无") +
          "\n\n这里使用本机浏览器和其中的登录状态。你可以随时接管；这项授权不涉及其他应用或助手自带的工具。",
        buttons: ["暂不允许", "允许本次操作"],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response === 1) {
        if (this.browser.state(s.id)?.url !== page.url)
          throw new Error("网页已变化，请核对后重试。");
        return this.browser.grant(s.id, state.assets);
      }
      return this.browser.state(s.id);
    }
    throw new Error("不支持这个操作。");
  }
  suspend(value) {
    this.browser.bound?.view.setVisible(!value);
  }
  async close() {
    await this.hide();
    if (this.inline)
      await this.invoke("surface_close", { token: this.inline.token });
    await this.browser.shutdown();
  }
}
