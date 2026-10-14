// Production React renderer + sandboxed MCP App + real SQLite. Presentation is
// supplied by a controlled Agent fixture; this is not real-model acceptance.
import { app, BrowserWindow, ipcMain, protocol, net } from "electron";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Browser } from "../../../packages/agent-host/browser.mjs";
import { LocalAgentHost } from "../../../packages/agent-host/host.mjs";
import { EmbeddedRuntime } from "../electron/embedded-runtime.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = process.env.TURNSU_UI_TEST_ROOT || await mkdtemp(join(tmpdir(), "turnsu-conversation-"));
app.setPath("userData", join(directory, "electron"));
protocol.registerSchemesAsPrivileged(
  ["turnsu", "turnsu-ui"].map((scheme) => ({
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  })),
);
let stage = "startup";
const deadline = setTimeout(() => {
  console.error("Conversation UI exceeded 75 seconds at " + stage);
  app.exit(1);
}, 75000);
app.on("window-all-closed", () => {});
let host, embedded, window, server;
const until = async (fn, label) => {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error(label);
};
app.whenReady().then(async () => {
  try {
    server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>工作参考资料</title><h1>内部示例资料已打开</h1>");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const website = "http://127.0.0.1:" + server.address().port + "/";
    const path = join(directory, "客户工作资料");
    await mkdir(path);
    host = new LocalAgentHost({
      directory: join(directory, "state"),
      notify: (payload) =>
        window &&
        !window.isDestroyed() &&
        window.webContents.send("desktop:host-event", payload),
    });
    const p = await host.command("project.open", { path }),
      s = await host.command("session.create", {
        projectId: p.id,
        agent: "codex",
      });
    host.message(s.id, "request", "user", "核对这份表格，确认后生成说明。");
    host.message(s.id, "reply", "assistant", "请核对金额，并补充报告的用途。");
    host.db
      .prepare("UPDATE sessions SET title=? WHERE id=?")
      .run("整理本周销售资料", s.id);
    assert.equal(
      host.ui.read(s.id).presentation,
      null,
      "new conversations have no default form",
    );
    await host.ui.call(s.id, {
      operation: "present",
      revision: 1,
      document: {
        title: "核对汇总与报告用途",
        data: {
          rows: [{ id: "a", item: "合计", amount: "174.50 元" }],
          note: "",
        },
        tree: {
          id: "review",
          type: "Layout",
          children: [
            {
              id: "total",
              type: "DataView",
              binding: "rows",
              columns: [
                { key: "item", label: "项目" },
                { key: "amount", label: "金额" },
              ],
            },
            { id: "state", type: "Status" },
            { id: "note", type: "Field", label: "报告用途", binding: "note" },
            {
              id: "confirm",
              type: "Action",
              label: "确认并生成报告",
              action: "submit",
            },
          ],
        },
      },
    });
    const adapter = {
      request: (m, a = {}) =>
        m === "desktop.resources.reserve"
          ? host.reserveDesktop(a.kind, a.id)
          : m === "desktop.resources.release"
            ? host.releaseDesktop(a.kind, a.id)
            : m === "desktop.browser.remember"
              ? host.browser.remember(a.sessionId, a.url)
              : m === "desktop.browser.read"
                ? host.browser.read(a.sessionId)
                : host.command(m, a),
    };
    protocol.handle("turnsu", async (request) => {
      const url = new URL(request.url),
        file = resolve(root, "dist", "." + decodeURIComponent(url.pathname));
      if (url.hostname !== "app" || !file.startsWith(join(root, "dist") + sep))
        return new Response("", { status: 404 });
      const r = await net.fetch(pathToFileURL(file).href);
      return new Response(r.body, {
        headers: {
          ...Object.fromEntries(r.headers),
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src turnsu-ui:",
        },
      });
    });
    protocol.handle("turnsu-ui", async (request) => {
      assert.equal(request.url, "turnsu-ui://app/intelligence.html");
      return new Response((await host.ui.resource()).contents[0].text, {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'",
        },
      });
    });
    window = new BrowserWindow({
      width: 1180,
      height: 820,
      show: true,
      webPreferences: {
        preload: join(root, "electron/preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    embedded = new EmbeddedRuntime({
      window,
      host: adapter,
      directory,
      notify: (payload) =>
        window.webContents.send("desktop:host-event", payload),
    });
    host.browser = new Browser(host, (_method, args) => embedded.browser.call(args));
    ipcMain.handle("desktop:invoke", async (event, operation, args = {}) => {
      try {
        assert.equal(event.senderFrame, window.webContents.mainFrame);
        let value;
        if (operation === "local_command")
          value = await host.command(args.method, args.args);
        else if (
          operation === "agent_connection_list" ||
          operation === "connection_list"
        )
          value = { connections: [] };
        else if (/^(surface_|embedded_|browser_)/.test(operation))
          value = await embedded.invoke(operation, args);
        else throw Error("Unexpected test operation: " + operation);
        return { ok: true, value };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    stage = "load production renderer";
    await window.loadURL("turnsu://app/index.html");
    await until(
      () => js('Boolean(document.querySelector(".projectButton"))'),
      "project not visible",
    );
    await js('document.querySelector(".projectButton").click()');
    await until(
      () => js('Boolean(document.querySelector(".sessionRow .sessionButton"))'),
      "session not visible",
    );
    await js('document.querySelector(".sessionRow .sessionButton").click()');
    const frame = () =>
      window.webContents.mainFrame.framesInSubtree.find(
        (f) => f.url === "turnsu-ui://app/intelligence.html",
      );
    await until(
      async () =>
        frame() &&
        (await frame().executeJavaScript(
          'Boolean(document.querySelector("input"))',
        )),
      "inline App not rendered",
    );
    stage = "edit inline review";
    const originalFrame = frame().frameTreeNodeId;
    assert.equal(
      await frame().executeJavaScript('document.querySelector("[role=status]").innerText'),
      "等待你确认",
      "a new review should explain that it needs the employee\'s confirmation",
    );
    assert.equal(await js('document.querySelectorAll("iframe").length'), 1);
    assert.deepEqual(
      await frame().executeJavaScript('(()=>{const cell=document.querySelector("tbody td:last-child");return [cell.innerText,getComputedStyle(cell).textAlign]})()'),
      ["174.50 元", "right"],
      "amount alignment must preserve the original value and precision",
    );
    assert.equal(
      await frame().executeJavaScript("typeof window.turnsuDesktop"),
      "undefined",
      "sandbox must not expose desktop IPC",
    );
    await frame().executeJavaScript(
      'const input=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"周一团队会议");input.dispatchEvent(new Event("input",{bubbles:true}));',
    );
    await until(
      () => host.ui.read(s.id).document.data.note === "周一团队会议",
      "edited draft did not persist",
    );
    stage = "expand and collapse review";
    for (let i = 0; i < 4; i++) {
      await js('document.querySelector("[aria-label=展开内容]").click()');
      await until(
        () =>
          js(
            'Boolean(document.querySelector(".conversationSurface.expanded"))',
          ),
        "expand failed",
      );
      assert.equal(
        frame().frameTreeNodeId,
        originalFrame,
        "expansion must reuse the frame",
      );
      await js('document.querySelector("[aria-label=收起到对话]").click()');
      await until(
        () => js('!document.querySelector(".conversationSurface.expanded")'),
        "collapse failed",
      );
    }
    await js('document.querySelector("[aria-label=收起导航]").click()');
    await until(() => js('document.querySelector(".sidebar").hidden'), "navigation did not collapse");
    assert.equal(frame().frameTreeNodeId, originalFrame, "changing workspace width must preserve the App");
    await js('document.querySelector("[aria-label=展开导航]").click()');
    await until(() => js('!document.querySelector(".sidebar").hidden'), "navigation did not reopen");
    assert.equal(host.resourceUsage().surfaces, 1);
    await until(
      () => frame().executeJavaScript('!document.querySelector(".primary").disabled'),
      "review did not finish saving before confirmation",
    );
    stage = "deliver confirmation";
    const waiting = host.ui.call(s.id, { operation: "wait" });
    await frame().executeJavaScript(
      'document.querySelector(".primary").click()',
    );
    await until(() => host.ui.read(s.id).events.some(event => event.state === "consumed"),
      "confirmation did not reach the waiting Agent tool");
    const event = await waiting;
    assert.equal(event.values.note, "周一团队会议");
    assert.equal(event.assets.length, 0);
    await until(
      async () =>
        await frame().executeJavaScript(
          'document.querySelector(".primary").disabled',
        ),
      "submitted action should not repeat",
    );
    assert.equal(host.ui.read(s.id).events.length, 1);
    await until(
      () => frame().executeJavaScript('document.querySelector("[role=status]").innerText === "确认内容已交给助手"'),
      "after confirmation the status must acknowledge delivery instead of inviting another action",
    );
    assert.equal(
      await frame().executeJavaScript('document.querySelector(".primary").innerText'),
      "已确认",
      "the submitted button acknowledges confirmation without claiming the task is completed",
    );
    assert.equal(
      await frame().executeJavaScript('document.querySelector("footer")?.innerText || ""'),
      "",
      "a delivery receipt should not be repeated below the status",
    );
    host.message(s.id, "complete", "assistant", "汇总已完成，可打开[工作参考资料](" + website + ")。");
    host.notify({type: "changed", sessionId:s.id});
    await until(() => js('Boolean(document.querySelector(".textLink"))'), "new reply not visible");
    assert.equal(frame().frameTreeNodeId, originalFrame, "new replies must not remount the App");
    assert.equal(await js('Boolean(document.querySelector(".conversationSurface").nextElementSibling?.textContent.includes("汇总已完成"))'), true, "App must stay beside its original reply");
    stage = "open conversation website";
    await js('document.querySelector(".textLink").click()');
    await until(() => embedded.browser.bound?.view.webContents.getURL() === website, "conversation link did not open embedded website");
    assert.match(await embedded.browser.bound.view.webContents.executeJavaScript("document.body.innerText"), /内部示例资料已打开/);
    assert.equal(embedded.browser.state(s.id).grant, null, "opening a link must not authorize automation");
    await js('document.querySelector("[aria-label=收起网页]").click()');
    await until(() => !embedded.browser.bound, "website did not hide");
    assert.equal(frame().frameTreeNodeId, originalFrame, "browsing must preserve the App draft");
    stage = "publish and preview result file";
    await writeFile(
      join(path, "汇总说明.txt"),
      "合计 174.50 元；用途：周一团队会议。",
    );
    await host.ui.call(s.id, {
      operation: "publish",
      paths: ["汇总说明.txt"],
      summary: "汇总说明已生成，可继续修改。",
    });
    await until(
      () => js('Boolean(document.querySelector(".resultFiles button"))'),
      "result file not returned to conversation",
    );
    await js('document.querySelector(".resultFiles button").click()');
    await until(
      () =>
        js(
          'document.querySelector(".filePreview")?.innerText.includes("174.50")',
        ),
      "real file preview not shown",
    );
    await js('document.querySelector("[aria-label=关闭文件面板]").click()');
    await until(
      () => js('!document.querySelector(".filePanel")'),
      "file preview did not close",
    );
    await js('document.querySelector(".transcript").scrollTop=0');
    await js(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    if (process.env.TURNSU_QA_ARTIFACTS) {
      await mkdir(process.env.TURNSU_QA_ARTIFACTS, { recursive: true });
      await writeFile(
        join(process.env.TURNSU_QA_ARTIFACTS, `conversation-inline-${process.platform}.png`),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    stage = "release and reopen draft";
    await js('document.querySelector(".newTask").click()');
    await until(
      () => host.resourceUsage().surfaces === 0,
      "App resources were not released on navigation",
    );
    assert.equal(await js('document.querySelectorAll("iframe").length'), 0);
    await js('document.querySelector(".sessionRow .sessionButton").click()');
    await until(
      async () =>
        frame() &&
        frame().frameTreeNodeId !== originalFrame &&
        (await frame().executeJavaScript(
          'document.querySelector("input")?.value==="周一团队会议"',
        )),
      "reopened App lost human input",
    );
    stage = "expand narrow viewport";
    window.setSize(900, 700);
    await js('document.querySelector("[aria-label=展开内容]").click()');
    await until(
      () =>
        js('Boolean(document.querySelector(".conversationSurface.expanded"))'),
      "small viewport expansion failed",
    );
    assert.equal(
      await js(
        'document.querySelector(".conversationSurface").getBoundingClientRect().right<=innerWidth',
      ),
      true,
    );
    await until(
      async () =>
        frame() &&
        (await frame().executeJavaScript(
          'document.querySelector("input")?.value==="周一团队会议"',
        )),
      "expanded content not ready",
    );
    await js(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    if (process.env.TURNSU_QA_ARTIFACTS) {
      await mkdir(process.env.TURNSU_QA_ARTIFACTS, { recursive: true });
      await writeFile(
        join(
          process.env.TURNSU_QA_ARTIFACTS,
          `conversation-expanded-${process.platform}.png`,
        ),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    stage = "replace review with readonly result";
    await host.ui.call(s.id, {
      operation: "present",
      revision: host.ui.read(s.id).revision,
      document: {
        title: "汇总结果",
        tree: { id: "result", type: "Layout", children: [
          { id: "summary", type: "Text", text: "合计 174.50 元，说明文件可在对话中打开。" },
          { id: "state", type: "Status", label: "处理结果", text: "待处理金额总计：174.50 元" },
        ] },
      },
    });
    await until(
      () => frame()?.executeJavaScript('document.querySelector("[role=status]")?.innerText === "内容已展示"'),
      "a read-only presentation must not ask for confirmation or reuse an earlier receipt",
    );
    assert.equal(await frame().executeJavaScript('document.querySelector(".primary")'), null);
    assert.equal(
      await frame().executeJavaScript('document.querySelector(".statusDescription").innerText'),
      "待处理金额总计：174.50 元",
      "Agent-authored status details must remain visible separately from runtime state",
    );
    stage = "show published result and partial failure";
    const resultFrame = frame().frameTreeNodeId;
    await host.ui.call(s.id, { operation: "publish", paths: ["汇总说明.txt"], summary: "汇总结果可查看。" });
    await until(
      () => frame().executeJavaScript('document.querySelector("[role=status]")?.innerText === "成果可查看"'),
      "actual results should be distinguishable from a pending review",
    );
    host.updateSession(s.id, "failed", "另一份材料处理失败，已生成的说明仍保留。");
    await until(
      () => frame().executeJavaScript('document.querySelector("[role=status]")?.dataset.tone === "error"'),
      "partial failure must not retain a success indication",
    );
    assert.equal(await js('Boolean(document.querySelector(".resultFiles button"))'), true);
    stage = "uncertain confirmation after edits";
    host.updateSession(s.id, "idle");
    await host.ui.call(s.id, {
      operation: "present", revision: host.ui.read(s.id).revision,
      document: {
        title: "继续核对", data: { note: "周一团队会议" },
        tree: { id: "review", type: "Layout", children: [
          { id: "state", type: "Status" },
          { id: "note", type: "Field", label: "报告用途", binding: "note" },
          { id: "confirm", type: "Action", label: "确认修改", action: "submit" },
        ] },
      },
    });
    await host.ui.commit({ sessionId: s.id, revision: host.ui.read(s.id).revision, requestId: "lost-reply" });
    // Simulate a lost delivery reply, not another successful business execution.
    host.db.prepare("UPDATE ui_events SET state='uncertain' WHERE id=?").run("lost-reply");
    host.ui.changed(s.id);
    await until(
      () => frame()?.executeJavaScript('document.querySelector("[role=status]")?.innerText === "请在对话中核对接收状态"'),
      "an uncertain delivery must explain the need to check the conversation",
    );
    assert.equal(frame().frameTreeNodeId, resultFrame, "updates at the same reply must preserve the App context");
    await frame().executeJavaScript(
      'const input=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"补充用途");input.dispatchEvent(new Event("input",{bubbles:true}));',
    );
    await until(() => host.ui.read(s.id).dirty, "edited input was not saved");
    assert.equal(await frame().executeJavaScript('document.querySelector(".primary").disabled'), true);
    const receiptCount = host.ui.read(s.id).events.length;
    await frame().executeJavaScript('document.querySelector(".primary").click()');
    assert.equal(host.ui.read(s.id).events.length, receiptCount, "editing must not enable a duplicate uncertain submission");
    console.log(
      JSON.stringify({
        status: "passed",
        platform: process.platform,
        electron: process.versions.electron,
        nativeAgent: false,
        evidence: [
          "production conversation and sandboxed MCP App",
          "edited data returned to waiting tool",
          "same iframe across expand/collapse",
          "duplicate action disabled",
          "confirmation status and button acknowledge delivery",
          "read-only result and partial failure are not pending confirmations",
          "uncertain delivery remains blocked after edits",
          "App anchored to original reply",
          "conversation links open native browser without authorization",
          "real result preview",
          "draft reopened",
          "App resources released",
          "900px viewport",
        ],
      }),
    );
  } catch (e) {
    console.error(e.stack);
    for (const child of window?.webContents.mainFrame.framesInSubtree || []) {
      if (child.url === "turnsu-ui://app/intelligence.html")
        console.error("App frame:", await child.executeJavaScript("document.body.innerText"));
    }
    if (window && !window.isDestroyed())
      console.error(
        await window.webContents.executeJavaScript("document.body.innerText"),
      );
    process.exitCode = 1;
  } finally {
    try {
      await embedded?.close();
      await host?.close();
      window?.destroy();
      if(server) await new Promise(resolve => server.close(resolve));
      if (!process.env.TURNSU_UI_TEST_ROOT)
        await rm(directory, { recursive: true, force: true });
    } catch (error) {
      console.error("UI test cleanup failed:", error.message);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      app.exit(process.exitCode || 0);
    }
  }
});
