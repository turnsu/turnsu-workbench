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
import { bundledFontResponse } from "../electron/bundled-fonts.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = process.env.TURNSU_UI_TEST_ROOT || await mkdtemp(join(tmpdir(), "turnsu-conversation-"));
app.setPath("userData", join(directory, "electron"));
protocol.registerSchemesAsPrivileged(
  ["turnsu", "turnsu-ui"].map((scheme) => ({
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: scheme === 'turnsu-ui' },
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
    const fontRequests = { workbench: new Set(), app: new Set() };
    protocol.handle("turnsu", async (request) => {
      const url = new URL(request.url),
        file = resolve(root, "dist", "." + decodeURIComponent(url.pathname));
      if (url.pathname.endsWith(".woff2")) fontRequests.workbench.add(request.url);
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
      if (new URL(request.url).pathname.startsWith("/fonts/")) {
        fontRequests.app.add(request.url);
        return bundledFontResponse(request, root);
      }
      assert.equal(request.url, "turnsu-ui://app/intelligence.html");
      return new Response((await host.ui.resource()).contents[0].text, {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src 'self'; img-src data:; connect-src 'none'",
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
    const fontDiagnostics = new Set();
    window.webContents.on('console-message', event => {
      if (/font|Content Security Policy|CORS/i.test(event.message) && fontDiagnostics.size < 3) {
        fontDiagnostics.add(event.message);
        console.error('Renderer resource diagnostic:', event.message);
      }
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
    const js = (source) => window.webContents.executeJavaScript(source).catch(error => { throw new Error(`${stage}: ${source.slice(0,240)}`, { cause: error }); });
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
    stage = "load local Chinese reading fonts inside the sandbox";
    const readingFontEvidence = '(' + (async () => {
      await document.fonts.ready;
      const loaded = [...document.fonts].filter(font => font.status === 'loaded' && font.family.includes('Noto Sans SC')).length;
      return { loaded, family: getComputedStyle(document.body).fontFamily, chinese: document.fonts.check('400 16px "Noto Sans SC"', '金额确认') };
    }).toString() + ')()';
    const appFonts = await frame().executeJavaScript(readingFontEvidence);
    const workbenchFonts = await js(readingFontEvidence);
    for (const fonts of [appFonts, workbenchFonts]) {
      assert.ok(fonts.loaded > 0 && fonts.chinese, "actual Chinese font data must load, not just a CSS fallback name: " + JSON.stringify(fonts));
      assert.match(fonts.family, /Noto Sans SC/);
    }
    for (const requests of Object.values(fontRequests)) {
      assert.ok(requests.size > 0 && requests.size < 202, "load only used font subsets, never preload the whole collection");
      assert.ok([...requests].every(url => /^turnsu(?:-ui)?:\/\/app\/fonts\//.test(url)), "font requests must remain inside the desktop package");
    }
    const fontUrl = [...fontRequests.app][0];
    const fontResponse = await bundledFontResponse(new Request(fontUrl), root);
    assert.equal(fontResponse.status, 200);
    assert.equal(fontResponse.headers.get("Content-Type"), "font/woff2");
    assert.equal(Buffer.from(await fontResponse.arrayBuffer()).subarray(0, 4).toString(), "wOF2");
    for (const url of ["turnsu-ui://other/fonts/noto-sans-sc-000-AAAAAAAA.woff2", "turnsu-ui://app/fonts/../../electron/main.mjs", "turnsu-ui://app/fonts/noto-sans-sc-000-AAAAAAAA.woff2?path=credentials"]) {
      assert.equal((await bundledFontResponse(new Request(url), root)).status, 404, "font access must not expose another host, arbitrary files or query-controlled paths");
    }
    assert.equal((await bundledFontResponse(new Request(fontUrl, { method: "POST" }), root)).status, 404, "font route is read-only");
    stage = "compose without crowding the conversation";
    const emptyComposerHeight = await js('document.querySelector(".composer").getBoundingClientRect().height');
    assert.ok(emptyComposerHeight < 135, "an empty composer must leave room to read the conversation");
    const longDraft = "第一行：保留这份输入。\n".repeat(12);
    await js(`(()=>{const input=document.querySelector(".composer textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,${JSON.stringify(longDraft)});input.dispatchEvent(new Event("input",{bubbles:true}));})()`);
    await until(() => js('document.querySelector(".composer textarea").value.length > 100'), "draft input was lost");
    assert.ok(await js('document.querySelector(".composer").getBoundingClientRect().height') > emptyComposerHeight + 60, "composer must grow for multiline input");
    assert.ok(await js('document.querySelector(".composer textarea").getBoundingClientRect().height') <= 181, "long drafts must not consume the whole window");
    await js('document.querySelector(".agentOptions summary").click()');
    await until(() => js('document.querySelector(".agentOptions").open'), "assistant settings did not open");
    assert.equal(await js('document.querySelector(".composer textarea").value'), longDraft, "opening settings must preserve the draft");
    assert.equal(await js('Boolean(document.querySelector(".agentOptions .modelSetting"))'), true);
    await js('document.querySelector(".agentOptions summary").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));');
    assert.equal(await js('document.querySelector(".agentOptions").open'), false, "Escape closes settings");
    assert.equal(await js('document.activeElement === document.querySelector(".agentOptions summary")'), true, "focus returns to the menu trigger");
    await js('const input=document.querySelector(".composer textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"");input.dispatchEvent(new Event("input",{bubbles:true}));');
    await until(() => js('document.querySelector(".composer").getBoundingClientRect().height').then(height => height === emptyComposerHeight), "clearing a draft must release its extra space");
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
    stage = "change reading theme with an edited App";
    await frame().executeJavaScript('window.qaThemeMessages=[];window.addEventListener("message", event=>{if(event.data?.method==="ui/notifications/host-context-changed")window.qaThemeMessages.push(event.data.params.theme);});');
    await js('Array.from(document.querySelectorAll(".themeSwitch button")).find(button=>button.textContent.includes("夜读")).click()');
    await until(async () => await js('document.documentElement.dataset.theme === "dark"') && await frame().executeJavaScript('matchMedia("(prefers-color-scheme: dark)").matches && getComputedStyle(document.documentElement).backgroundColor === "rgb(44, 45, 41)"'), "the sandboxed App must follow the workbench night theme");
    assert.equal(frame().frameTreeNodeId, originalFrame, "theme changes must not recreate the App");
    assert.equal(await frame().executeJavaScript('document.querySelector("input").value'), "周一团队会议", "theme changes must preserve in-progress edits");
    await until(() => frame().executeJavaScript('window.qaThemeMessages.includes("dark")'), "MCP host context must describe the selected theme");
    assert.equal(await js('localStorage.getItem("turnsu.appearance")'), "dark");
    await js('Array.from(document.querySelectorAll(".themeSwitch button")).find(button=>button.textContent.includes("纸白")).click()');
    await until(() => frame().executeJavaScript('!matchMedia("(prefers-color-scheme: dark)").matches && getComputedStyle(document.documentElement).backgroundColor === "rgb(251, 249, 243)"'), "returning to paper must update the existing App");
    assert.equal(frame().frameTreeNodeId, originalFrame);
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
    stage = "find outputs without losing the conversation";
    const setDraft = async text => js(`(()=>{const input=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await setDraft("保留这段补充要求");
    await until(() => js('document.querySelector(".composer textarea").value === "保留这段补充要求"'), "follow-up draft missing");
    await js('document.querySelector(".outputsTrigger").click()');
    await until(() => js('document.querySelector(".outputsPanel")?.innerText.includes("汇总说明.txt")'), "published file must be discoverable from the task header");
    assert.equal(await js('document.querySelector(".outputsPanel time").dateTime'), new Date(host.ui.read(s.id).results[0].createdAt).toISOString(), "output time must come from the saved publication receipt");
    assert.equal(await js('document.querySelector(".composer textarea").value'), "保留这段补充要求", "opening outputs must preserve the conversation draft");
    assert.equal(frame().frameTreeNodeId, originalFrame, "outputs must not create or replace the interactive App");
    if (process.env.TURNSU_QA_ARTIFACTS) {
      await mkdir(process.env.TURNSU_QA_ARTIFACTS, { recursive: true });
      await js('Promise.all(document.querySelector(".outputsPanel").getAnimations().map(animation=>animation.finished))');
      await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `conversation-outputs-${process.platform}.png`), (await window.webContents.capturePage()).toPNG());
      await js('Array.from(document.querySelectorAll(".themeSwitch button")).find(button=>button.textContent.includes("夜读")).click()');
      await until(() => frame().executeJavaScript('getComputedStyle(document.documentElement).backgroundColor === "rgb(44, 45, 41)"'), "outputs and embedded content must use night colors together");
      await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `conversation-night-${process.platform}.png`), (await window.webContents.capturePage()).toPNG());
      await js('Array.from(document.querySelectorAll(".themeSwitch button")).find(button=>button.textContent.includes("纸白")).click()');
      await until(() => frame().executeJavaScript('getComputedStyle(document.documentElement).backgroundColor === "rgb(251, 249, 243)"'), "outputs must return to paper colors");
    }
    await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await until(() => js('!document.querySelector(".outputsPanel")'), "Escape must close task outputs");
    assert.equal(await js('document.activeElement.className'), "outputsTrigger", "closing outputs must restore keyboard focus");
    await js('document.querySelector(".outputsTrigger").click()');
    await until(() => js('Boolean(document.querySelector(".surfaceShortcut"))'), "interactive content must be listed with task outputs");
    await js('document.querySelector(".surfaceShortcut").click()');
    await until(() => js('Boolean(document.querySelector(".conversationSurface.expanded")) && !document.querySelector(".outputsPanel")'), "the output shortcut must open the existing App");
    assert.equal(frame().frameTreeNodeId, originalFrame, "opening a review from outputs must reuse its iframe");
    assert.match(await js('document.querySelector(".conversationSurface.expanded .surfaceHeading button").textContent'), /返回对话/, "expanded content needs a clear return action");
    assert.equal(await frame().executeJavaScript('document.querySelector("input").value'), "周一团队会议", "output shortcut must preserve the human review draft");
    await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await until(() => js('!document.querySelector(".conversationSurface.expanded")'), "Escape from expanded header must return to the conversation");
    assert.equal(await js('document.activeElement.getAttribute("aria-label")'), "展开内容", "focus must stay on the same review after returning");
    await js('document.querySelector(".outputsTrigger").click()');
    await until(() => js('Boolean(document.querySelector(".outputsPanel .resultFile"))'), "result shortcut missing");
    await js('document.querySelector(".outputsPanel .resultFile").click()');
    await until(() => js('document.querySelector(".filePreview")?.innerText.includes("174.50") && !document.querySelector(".outputsPanel")'), "result shortcut must open the actual project file");
    await js('document.querySelector("[aria-label=关闭文件面板]").click()');
    await setDraft("");
    stage = "open attached material from the composer";
    const sourceText = "客户,金额\n样本甲,100.00\n样本乙,74.50\n";
    await writeFile(join(path, "订单.csv"), sourceText);
    await host.command("ui.attach", { sessionId: s.id, paths: ["订单.csv"] });
    await until(() => js('Boolean(document.querySelector(".materialOpen"))'), "attached material not visible");
    await js('document.querySelector(".materialOpen").click()');
    await until(() => js('document.querySelector(".filePreview")?.innerText.includes("样本乙,74.50")'), "material should open the source file, not a placeholder");
    assert.equal(await readFile(join(path, "订单.csv"), "utf8"), sourceText, "preview must not change the material");
    assert.equal(frame().frameTreeNodeId, originalFrame, "material preview must preserve the review");
    await js('document.querySelector("[aria-label=关闭文件面板]").click()');
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
    await js('document.querySelector(".outputsTrigger").click()');
    await until(() => js('Boolean(document.querySelector(".outputsPanel"))'), "outputs did not open before navigation");
    await js('document.querySelector(".newTask").click()');
    await until(
      () => host.resourceUsage().surfaces === 0,
      "App resources were not released on navigation",
    );
    assert.equal(await js('document.querySelectorAll("iframe").length'), 0);
    assert.equal(await js('Boolean(document.querySelector(".outputsPanel"))'), false, "a new task must not show the previous task's outputs");
    await setDraft("请保留我原来写好的要求。");
    await js('Array.from(document.querySelectorAll(".taskSuggestions button")).find(button=>button.textContent.includes("分析表格")).click()');
    await until(() => js('document.querySelector(".composer textarea").value.includes("分析表格")'), "starter suggestion was not added");
    assert.ok(await js('document.querySelector(".composer textarea").value.startsWith("请保留我原来写好的要求。")'), "a starter must never replace an existing draft");
    await setDraft("");
    await until(() => js('document.querySelector(".composer textarea").value === "" && !document.querySelector(".composerMeta").textContent.includes("正在保存")'), "clearing the new-task draft must settle before leaving it");
    if (process.env.TURNSU_QA_ARTIFACTS) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `new-work-${process.platform}.png`), (await window.webContents.capturePage()).toPNG());
    stage = "restore appearance after renderer restart";
    await js('Array.from(document.querySelectorAll(".themeSwitch button")).find(button=>button.textContent.includes("夜读")).click()');
    await until(() => js('localStorage.getItem("turnsu.appearance") === "dark"'), "appearance was not saved");
    await window.loadURL("turnsu://app/index.html");
    await until(() => js('Boolean(document.querySelector(".taskWelcome")) && document.documentElement.dataset.theme === "dark"'), "reopening the workbench must restore the chosen reading theme");
    assert.equal(await js('document.querySelectorAll("iframe").length'), 0, "appearance restoration must not resurrect old Apps");
    if (process.env.TURNSU_QA_ARTIFACTS) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `new-work-night-${process.platform}.png`), (await window.webContents.capturePage()).toPNG());
    await js('Array.from(document.querySelectorAll(".themeSwitch button")).find(button=>button.textContent.includes("纸白")).click()');
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
    const reviewFrame = frame().frameTreeNodeId;
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
      async () => {
        // AppBridge can read new data before React moves the presentation to
        // its new reply. Wait for both the host and the replacement frame.
        if (!await js('document.querySelector(".surfaceHeading strong")?.innerText === "汇总结果"')) return false;
        const content = frame();
        return content && content.frameTreeNodeId !== reviewFrame &&
          content.executeJavaScript('document.querySelector(".statusDescription")?.innerText === "待处理金额总计：174.50 元" && !document.querySelector("[role=status]")');
      },
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
    stage = "manage projects and organize the existing conversation";
    const targetPath = join(directory, '每周工作'); await mkdir(targetPath);
    const target = await host.command('project.open', { path: targetPath });
    const clickText = (selector, text) => until(() => js(`(() => {
      const element=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el => el.textContent.trim() === ${JSON.stringify(text)});
      if (!element || element.disabled || !element.checkVisibility()) return false;
      element.click(); return true;
    })()`), `action did not become available: ${text}`);
    const openSessionMenu = async () => {
      // A persisted pin is not the end of the operation: the index must refresh
      // before React enables the trigger again. Never click a disabled control.
      await until(() => js(`(() => {
        const button=document.querySelector('[aria-label="会话选项：订单整理"]');
        if (!button || button.disabled) return false;
        button.click(); return true;
      })()`), 'session menu trigger did not become available');
      await until(() => js('Boolean(document.querySelector("[role=menu]"))'), 'session menu did not open');
    };
    await until(() => js('document.querySelectorAll(".projectButton").length === 2'), 'new project did not reach navigation');
    await js('document.querySelector(".projectSwitcher summary").click()');
    await clickText('.projectChoices button', '管理项目');
    await until(() => js('Boolean(document.querySelector("[aria-label=搜索项目]"))'), 'project management did not open');
    await js('document.querySelector("[aria-label=重命名项目：每周工作]").click()');
    await js('{const input=document.querySelector("[aria-label=项目名称]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"每周归档");input.dispatchEvent(new Event("input",{bubbles:true}));}');
    await clickText('.projectNameForm button', '保存名称');
    await until(() => host.project(target.id).name === '每周归档', 'project name was not saved');
    assert.equal(host.project(target.id).path, target.path, 'renaming must not change the directory');
    await until(() => js('Boolean(document.querySelector("[aria-label=置顶项目：每周归档]"))'), 'renamed project not rendered');
    await js('document.querySelector("[aria-label=置顶项目：每周归档]").click()');
    await until(() => js('document.querySelector("[aria-label=取消置顶项目：每周归档]")?.getAttribute("aria-pressed") === "true"'), 'project pin was not shown');
    await js('document.querySelector("[aria-label=关闭项目管理]").click()');
    await js('document.querySelector("[aria-label=重命名当前会话]").click()');
    await until(() => js('Boolean(document.querySelector("[aria-label=会话名称]"))'), 'session rename did not open');
    await js('{const input=document.querySelector("[aria-label=会话名称]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"订单整理");input.dispatchEvent(new Event("input",{bubbles:true}));}');
    await js('document.querySelector("[aria-label=保存会话名称]").click()');
    await until(() => js('document.querySelector(".taskTitle")?.textContent === "订单整理"'), 'session title was not saved');
    await setDraft('迁移后继续核对，保留原文件夹和这段草稿。');
    await openSessionMenu();
    await clickText('[role=menuitem]', '置顶会话');
    await until(() => host.session(s.id).pinned_at > 0, 'session pin was not saved');
    await openSessionMenu();
    await clickText('[role=menuitem]', '移到项目…');
    await until(() => js('document.querySelector(".moveExplanation")?.textContent.includes("客户工作资料")'), 'move must explain the original directory');
    await js('document.querySelector(".moveTargets input").click()');
    await clickText('.workspaceDialogFooter button', '移到所选项目');
    await until(() => js('document.querySelector(".breadcrumb")?.textContent === "每周归档" && document.querySelector(".composer textarea")?.value === "迁移后继续核对，保留原文件夹和这段草稿。"'), 'moving lost the task or its original draft');
    assert.equal(host.session(s.id).project_id, p.id);
    assert.equal(host.session(s.id).collection_project_id, target.id);
    await until(() => frame()?.executeJavaScript('document.querySelector("input")?.value === "补充用途"'), 'moving lost the Intelligence UI draft');
    assert.equal(await js('document.querySelectorAll(".error").length'), 0);

    stage = "archive, reopen and restore the moved conversation";
    await openSessionMenu();
    await clickText('[role=menuitem]', '归档会话');
    await until(() => host.session(s.id).archived_at > 0, 'archive was not persisted');
    await until(() => js('Boolean(document.querySelector(".managementNotice"))'), 'archive feedback missing');
    assert.equal(await js('document.querySelector(".error")?.textContent || ""'), '', 'archive must not flush a closed App or report a false save failure');
    await until(() => js('Boolean(document.querySelector(".taskWelcome")) && !document.querySelector(".archiveNotice")'), 'archiving the current conversation should open new work');
    assert.equal(host.ui.read(s.id).document.data.note, '补充用途');
    assert.equal(await js('document.querySelectorAll(".sessionRow").length'), 0);
    await clickText('.sessionFilters button', '已归档');
    await until(() => js('Boolean(document.querySelector(".sessionRow .sessionButton"))'), 'archived conversation cannot be found');
    await js('document.querySelector(".sessionRow .sessionButton").click()');
    await until(() => js('Boolean(document.querySelector(".archiveNotice"))'), 'archive must open in read-only mode');
    assert.equal(await js('document.querySelectorAll(".composer textarea, iframe").length'), 0, 'archives must not mount editable Apps');
    await js('document.querySelector(".resultFiles button").click()');
    await until(() => js('document.querySelector(".filePreview")?.textContent.includes("174.50")'), 'archiving hid the original result file');
    await window.loadURL('turnsu://app/index.html');
    await until(() => js('Boolean(document.querySelector(".archiveNotice")) && document.querySelector(".breadcrumb")?.textContent.includes("每周归档")'), 'reopening did not preserve archived organization');
    await clickText('.archiveNotice button', '恢复会话');
    await until(() => js('document.querySelector(".composer textarea")?.value === "迁移后继续核对，保留原文件夹和这段草稿。"'), 'restoring lost the saved follow-up draft');
    await until(() => frame()?.executeJavaScript('document.querySelector("input")?.value === "补充用途"'), 'restoring lost the edited App');
    assert.equal(host.session(s.id).archived_at, 0);
    assert.equal(host.session(s.id).project_id, p.id);
    assert.equal(host.session(s.id).pinned_at > 0, true);
    await js('document.querySelector(".projectSwitcher summary").click()');
    await clickText('.projectButton', '客户工作资料');
    await until(() => js('document.querySelectorAll(".sessionRow").length === 0'), 'moved conversation still belongs to source navigation');
    await clickText('.sessionSearchScope button', '查找所有项目');
    await until(() => js('document.querySelector(".sessionRow")?.textContent.includes("每周归档")'), 'all-project lookup cannot locate a moved conversation');
    await js('document.querySelector(".sessionRow .sessionButton").click()');
    await until(() => js('document.querySelector(".composer textarea")?.value === "迁移后继续核对，保留原文件夹和这段草稿。"'), 'global lookup lost the conversation');
    const currentRow = await js('(() => { const row=document.querySelector(".sessionRow.current").getBoundingClientRect(), nav=document.querySelector("nav[aria-label=项目与任务]").getBoundingClientRect(); return {row: [row.top, row.bottom], nav: [nav.top, nav.bottom]}; })()');
    assert.ok(currentRow.row[0] >= currentRow.nav[0] && currentRow.row[1] <= currentRow.nav[1], 'a short window must show the current conversation: ' + JSON.stringify(currentRow));
    if (process.env.TURNSU_QA_ARTIFACTS) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `session-management-${process.platform}.png`), (await window.webContents.capturePage()).toPNG());
    await clickText('.themeSwitch button', '夜读');
    await openSessionMenu();
    await until(() => js('document.activeElement?.getAttribute("role") === "menuitem"'), 'session menu did not receive keyboard focus');
    if (process.env.TURNSU_QA_ARTIFACTS) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `session-menu-night-${process.platform}.png`), (await window.webContents.capturePage()).toPNG());
    await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await until(() => js('document.activeElement?.getAttribute("aria-label") === "会话选项：订单整理" && !document.querySelector("[role=menu]")'), 'closing the menu must return focus to its trigger');
    await openSessionMenu();
    await js('{const input=document.querySelector(".composer textarea");input.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));input.focus();}');
    await until(() => js('document.activeElement === document.querySelector(".composer textarea") && !document.querySelector("[role=menu]")'), 'clicking outside the menu must not steal focus back from the editor');
    console.log(
      JSON.stringify({
        status: "passed",
        platform: process.platform,
        electron: process.versions.electron,
        nativeAgent: false,
        fonts: { workbenchSubsets: fontRequests.workbench.size, appSubsets: fontRequests.app.size },
        evidence: [
          "production conversation and sandboxed MCP App",
          "offline Chinese fonts loaded in both actual documents through a read-only packaged route",
          "edited data returned to waiting tool",
          "same iframe across expand/collapse",
          "paper/night theme follows MCP host context without losing edits",
          "reading appearance survives renderer restart without reopening Apps",
          "duplicate action disabled",
          "confirmation status and button acknowledge delivery",
          "read-only result and partial failure are not pending confirmations",
          "uncertain delivery remains blocked after edits",
          "App anchored to original reply",
          "conversation links open native browser without authorization",
          "real result and attached material preview",
          "bounded auto-growing composer and Escape-to-close assistant settings",
          "task output shortcuts preserve drafts and reuse the same App",
          "task output files open real project content",
          "new task releases previous outputs and suggestions preserve existing input",
          "draft reopened",
          "project display name and pin persist without moving directories",
          "session rename, pin, move and global lookup retain original files and both drafts",
          "archive releases interactive App and remains readable across restart; restore retains drafts",
          "App resources released",
          "900px viewport",
        ],
      }),
    );
  } catch (e) {
    console.error(e.stack);
    if (process.env.TURNSU_QA_ARTIFACTS && window && !window.isDestroyed()) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `conversation-failure-${process.platform}.png`), (await window.webContents.capturePage()).toPNG());
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
