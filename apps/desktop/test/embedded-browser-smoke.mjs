// Real Electron WebContentsView + Host SQLite + HTTP upload/download. No model fixture is used here.
import { app, BrowserWindow } from "electron";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { LocalAgentHost } from "../../../packages/agent-host/host.mjs";
import { Browser } from "../../../packages/agent-host/browser.mjs";
import { BrowserRuntime } from "../electron/browser-runtime.mjs";
const deadline = setTimeout(() => {
  console.error("Electron browser test exceeded 60 seconds");
  app.exit(1);
}, 60000);
const root = await mkdtemp(join(tmpdir(), "turnsu-embedded-real-"));
app.setPath("userData", join(root, "electron"));
let host, runtime, window, server;
let uploaded = null;
app.on("window-all-closed", () => {});
const until = async (fn) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("Expected observable outcome did not arrive");
};
app.whenReady().then(async () => {
  try {
    const projectPath = join(root, "项目 with space");
    await mkdir(projectPath);
    await writeFile(join(projectPath, "材料.csv"), "项目,金额\n通用,174.50");
    await mkdir(join(root, "downloads"));
    server = createServer(async (req, res) => {
      if (req.url === "/upload") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        uploaded = Buffer.concat(chunks);
        res.end("received");
        return;
      }
      if (req.url === "/result") {
        res.setHeader("Content-Disposition", "attachment; filename=result.txt");
        res.end("verified result 174.50");
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        '<!doctype html><h1>通用文件任务</h1><label>任务说明<input id="note"></label><input id="file" type="file"><button id="send">上传</button><p id="receipt"></p><a id="result" href="/result">下载结果</a><script>document.querySelector("#send").onclick=async()=>{const f=document.querySelector("#file").files[0];if(!f)return;const response=await fetch("/upload",{method:"POST",body:f});document.querySelector("#receipt").textContent=await response.text();};</script>',
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = "http://127.0.0.1:" + server.address().port;
    host = new LocalAgentHost({ directory: join(root, "state") });
    const p = await host.command("project.open", { path: projectPath }),
      s = await host.command("session.create", {
        projectId: p.id,
        agent: "codex",
      });
    window = new BrowserWindow({
      width: 1100,
      height: 780,
      show: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    runtime = new BrowserRuntime({
      window,
      host: {
        request: (m, a) =>
          m === "desktop.resources.reserve"
            ? host.reserveDesktop(a.kind, a.id)
            : m === "desktop.resources.release"
              ? host.releaseDesktop(a.kind, a.id)
              : host.command(m, a),
      },
      directory: join(root, "downloads"),
    });
    host.browser = new Browser(host, (_m, args) => runtime.call(args));
    await runtime.open({ sessionId: s.id, projectId: p.id, url });
    console.log("page loaded");
    runtime.mount(s.id, { x: 20, y: 20, width: 1060, height: 740 });
    await assert.rejects(
      host.browser.call(s.id, { operation: "read" }),
      /授权/,
    );
    const state = await host.command("ui.attach", {
      sessionId: s.id,
      paths: ["材料.csv"],
    });
    runtime.grant(s.id, state.assets);
    let page = await host.browser.call(s.id, { operation: "read" });
    console.log("page read");
    runtime.pages
      .get(s.id)
      .view.webContents.on("console-message", (_e, ...a) =>
        console.log("page-console", a),
      );
    assert.ok(page.text.includes("通用文件任务"));
    await host.browser.call(s.id, {
      operation: "type",
      selector: "#note",
      text: "核对中文输入",
      revision: page.revision,
    });
    console.log("input performed");
    assert.equal(
      await runtime.pages
        .get(s.id)
        .view.webContents.executeJavaScript(
          'document.querySelector("#note").value',
        ),
      "核对中文输入",
    );
    await host.browser.call(s.id, {
      operation: "upload",
      selector: "#file",
      path: "材料.csv",
      revision: page.revision,
    });
    console.log(
      "selected",
      await runtime.pages
        .get(s.id)
        .view.webContents.executeJavaScript(
          'JSON.stringify(Array.from(document.querySelector("#file").files).map(f=>({name:f.name,size:f.size})))',
        ),
    );
    await host.browser.call(s.id, {
      operation: "click",
      selector: "#send",
      revision: page.revision,
    });
    try {
      await until(() => uploaded);
    } catch (e) {
      console.log(await host.browser.call(s.id, { operation: "read" }));
      throw e;
    }
    assert.equal(
      createHash("sha256").update(uploaded).digest("hex"),
      state.assets[0].sha256,
    );
    await until(async () =>
      (await host.browser.call(s.id, { operation: "read" })).text.includes(
        "received",
      ),
    );
    page = await host.browser.call(s.id, { operation: "read" });
    await host.browser.call(s.id, {
      operation: "click",
      selector: "#result",
      revision: page.revision,
    });
    await until(() => runtime.state(s.id).downloads.length);
    const download = runtime.state(s.id).downloads[0];
    assert.equal(download.status, "completed");
    assert.equal(download.result.failed.length, 0);
    const output = download.result.imported[0].path;
    assert.equal(
      await readFile(join(projectPath, output), "utf8"),
      "verified result 174.50",
    );
    const receipt = await host.ui.call(s.id, {
      operation: "publish",
      paths: [output],
      summary: "上传与下载已核对",
    });
    assert.equal(
      receipt.files[0].bytes,
      Buffer.byteLength("verified result 174.50"),
    );
    runtime.revoke(s.id);
    await assert.rejects(
      host.browser.call(s.id, {
        operation: "click",
        selector: "#send",
        revision: page.revision,
      }),
      /授权|接管/,
    );
    if (process.env.TURNSU_QA_ARTIFACTS) {
      await mkdir(process.env.TURNSU_QA_ARTIFACTS, { recursive: true });
      await writeFile(
        join(process.env.TURNSU_QA_ARTIFACTS, "browser.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    await runtime.close(s.id);
    assert.equal(runtime.pages.size, 0);
    assert.equal(runtime.bound, null);
    console.log(
      JSON.stringify({
        status: "passed",
        electron: process.versions.electron,
        platform: process.platform,
        evidence: [
          "real WebContentsView",
          "scoped upload hash",
          "download imported and verified",
          "revoked actions denied",
          "page destroyed",
        ],
        nativeAgent: false,
      }),
    );
  } catch (e) {
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    await runtime?.shutdown();
    await host?.close();
    window?.destroy();
    if (server) await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
