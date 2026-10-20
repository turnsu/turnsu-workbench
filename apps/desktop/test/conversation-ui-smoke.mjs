// Production React renderer + sandboxed MCP App + real SQLite. Presentation is
// supplied by a controlled Agent fixture; this is not real-model acceptance.
import { app, BrowserWindow, ipcMain, protocol, net, nativeTheme } from "electron";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Browser } from "../../../packages/agent-host/browser.mjs";
import { checkResearchComponents } from './research-ui-check.mjs';
import { nativeUiCsp } from "../../../packages/agent-host/ui/csp.mjs";
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
  console.error("Conversation UI exceeded 120 seconds at " + stage);
  app.exit(1);
}, 120000);
app.on("window-all-closed", () => {});
nativeTheme.themeSource = "light";
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
    const nativeStarts = [];
    host = new LocalAgentHost({
      directory: join(directory, "state"),
      connectionFactory: () => ({
        ready: Promise.resolve(),
        request: async (method, args) => {
          if (method === "thread/start" || method === "thread/resume")
            return { thread: { id: "controlled-conversation", turns: [] } };
          if (method === "turn/start") {
            nativeStarts.push(args);
            return { turn: { id: "controlled-continuation" } };
          }
          if (method === "model/list") return { data: [{ model: "qa-model", displayName: "验收模型", hidden: false }], nextCursor: null };
          throw Error("Unexpected controlled Agent call: " + method);
        },
        close: async () => {},
      }),
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
    host.message(s.id, "request", "user", "核对这份表格，确认后生成说明。\n只处理选定资料。\n核对每一笔金额。\n标明来源。\n保留原始文件。\n先展示汇总。\n让我填写报告用途。\n等我确认后再生成文件。\n不得对外发送。");
    host.message(s.id, "tool-read", "tool", "读取选定订单，保留原件", "command");
    host.message(s.id, "tool-check", "tool", "核对金额 100.00 + 74.50 = 174.50", "command");
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
          total: "174.50",
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
            { id: "state", type: "Status", label: "复算合计", binding: "total" },
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
                : m === 'desktop.browser.deliver'
                  ? host.browser.deliver(a.sessionId, a.paths)
                : host.command(m, a),
    };
    const fontRequests = { workbench: new Set(), app: new Set() };
    protocol.handle("turnsu", async (request) => {
      const url = new URL(request.url),
        file = resolve(root, "dist", "." + decodeURIComponent(url.pathname));
      if (/\.(?:woff2|ttf)$/.test(url.pathname)) fontRequests.workbench.add(request.url);
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
            nativeUiCsp,
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
    const nativeOpens = [];
    ipcMain.handle("desktop:invoke", async (event, operation, args = {}) => {
      try {
        assert.equal(event.senderFrame, window.webContents.mainFrame);
        let value;
        if (operation === "local_command")
          value = await host.command(args.method, args.args);
        else if (operation === 'open_project_file') {
          await host.command('files.resolve', args);
          nativeOpens.push({projectId:args.projectId,path:args.path}); value={opened:true};
        }
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
    if (process.env.TURNSU_QA_ARTIFACTS) await mkdir(process.env.TURNSU_QA_ARTIFACTS, { recursive: true });
    stage = "load production renderer";
    await window.loadURL("turnsu://app/index.html");
    await until(
      () => js('Boolean(document.querySelector(".projectSwitcher"))'),
      "project not visible",
    );
    await js('document.querySelector(".projectSwitcher").click()');
    await until(() => js('Boolean(document.querySelector(".researchMenuItem"))'), 'project choices did not open');
    await js('document.querySelector(".researchMenuItem").click()');
    await until(
      () => js('Boolean(document.querySelector(".sessionRow .sessionButton"))'),
      "session not visible",
    );
    await js('document.querySelector(".sessionRow .sessionButton").click()');
    const frame = () =>
      window.webContents.mainFrame.framesInSubtree.find(
        (f) => f.url === "turnsu-ui://app/intelligence.html",
      );
    const changeAppearance = async label => {
      await js('document.querySelector(".appearanceMenu").click()');
      assert.ok(await js('document.querySelector(".researchMenu").checkVisibility()'), 'appearance choices must be visible before selection');
      assert.ok(await js('(()=>{const r=document.querySelector(".researchMenu").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()'), 'appearance choices must stay inside the window after moving to the sidebar footer');
      await js(`Array.from(document.querySelectorAll('.researchMenuItem')).find(button=>button.textContent===${JSON.stringify(label)}).click()`);
      await until(() => js('!document.querySelector(".researchMenu")'), 'selecting appearance must close the menu');
      await until(() => js('document.activeElement===document.querySelector(".appearanceMenu")'), 'appearance returns keyboard focus to its trigger');
    };
    const capturePaintedPage = async () => {
      const painted = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))';
      await js(painted);
      return window.webContents.capturePage();
    };
    let capturedReadingSettings = false;
    const changeTextSize = async value => {
      await js('document.querySelector("button[aria-label=设置]").click()');
      await until(() => js('Boolean(document.querySelector("input[name=text-size]"))'), 'reading settings did not open');
      assert.equal(await js('getComputedStyle(document.querySelector(".settingsEntry strong")).fontWeight'), '500');
      await js(`{const input=document.querySelector('input[name="text-size"][value="${value}"]');input.focus();input.click();}`);
      await until(() => js(`document.documentElement.dataset.textSize === '${value}'`), 'text size did not change');
      assert.equal(await js('document.activeElement?.name'), 'text-size', 'resizing must keep the selected control focused');
      if (process.env.TURNSU_QA_ARTIFACTS && value === 'large' && !capturedReadingSettings) {
        await js('(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return true;})()');
        await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `reading-settings-${process.platform}.png`), (await capturePaintedPage()).toPNG());
        capturedReadingSettings = true;
      }
      await js('document.querySelector("[aria-label=关闭设置]").click()');
    };
    await until(
      async () =>
        frame() &&
        (await frame().executeJavaScript(
          'Boolean(document.querySelector("input"))',
        )),
      "inline App not rendered",
    );
    stage = "load packaged typography in both documents";
    const readingFontEvidence = '(' + (async () => {
      const checked = await Promise.all(['Inter', 'Source Serif 4', 'IBM Plex Mono', 'Noto Sans SC'].map(async family => {
        const faces = await document.fonts.load(`400 16px "${family}"`, family === 'Noto Sans SC' ? '金额确认' : 'Turnsu 174.50');
        return { family, loaded: faces.some(face => face.status === 'loaded') };
      }));
      await document.fonts.ready;
      const loaded = [...document.fonts].filter(font => font.status === 'loaded' && font.family.includes('Noto Sans SC')).length;
      return { loaded, checked, family: getComputedStyle(document.body).fontFamily, chinese: document.fonts.check('400 16px "Noto Sans SC"', '金额确认') };
    }).toString() + ')()';
    const appFonts = await frame().executeJavaScript(readingFontEvidence);
    const workbenchFonts = await js(readingFontEvidence);
    for (const fonts of [appFonts, workbenchFonts]) {
      assert.ok(fonts.loaded > 0 && fonts.chinese, "actual Chinese font data must load, not just a CSS fallback name: " + JSON.stringify(fonts));
      assert.match(fonts.family, /Noto Sans SC/);
      assert.match(fonts.family, /Inter/);
      assert.ok(fonts.checked.every(font => font.loaded), 'bundled font binaries must actually decode: ' + JSON.stringify(fonts.checked));
    }
    assert.match(await js('getComputedStyle(document.querySelector(".taskTitle")).fontFamily'), /Source Serif 4/);
    assert.match(await frame().executeJavaScript('getComputedStyle(document.querySelector("td.numeric")).fontFamily'), /Inter/);
    for (const [documentName, requests] of Object.entries(fontRequests)) {
      assert.ok(requests.size > 0 && requests.size < 205, "load only used font subsets, never preload the whole collection");
      if (documentName === 'workbench') for (const family of ['inter-', 'source-serif-4-', 'ibm-plex-mono-']) assert.ok([...requests].some(url => url.includes('/'+family)), 'each Research font family must decode through a packaged route: '+family);
      assert.ok([...requests].every(url => /^turnsu(?:-ui)?:\/\/app\/fonts\//.test(url)), "font requests must remain inside the desktop package");
    }
    const fontUrl = [...fontRequests.app].find(url => url.endsWith(".woff2"));
    const fontResponse = await bundledFontResponse(new Request(fontUrl), root);
    assert.equal(fontResponse.status, 200);
    assert.equal(fontResponse.headers.get("Content-Type"), "font/woff2");
    assert.equal(Buffer.from(await fontResponse.arrayBuffer()).subarray(0, 4).toString(), "wOF2");
    for (const url of ["turnsu-ui://other/fonts/noto-sans-sc-000-AAAAAAAA.woff2", "turnsu-ui://app/fonts/../../electron/main.mjs", "turnsu-ui://app/fonts/noto-sans-sc-000-AAAAAAAA.woff2?path=credentials", "turnsu-ui://app/fonts/red-hat-other-000-AAAAAAAA.woff2", "turnsu-ui://app/fonts/red-hat-text-001-AAAAAAAA.woff2"]) {
      assert.equal((await bundledFontResponse(new Request(url), root)).status, 404, "font access must not expose another host, arbitrary files or query-controlled paths");
    }
    assert.equal((await bundledFontResponse(new Request(fontUrl, { method: "POST" }), root)).status, 404, "font route is read-only");
    stage = "compose without crowding the conversation";
    const emptyComposerHeight = await js('document.querySelector(".composer").getBoundingClientRect().height');
    assert.ok(emptyComposerHeight < 160, 'the idle composer with a selected material must leave room for the actual task');
    assert.ok(emptyComposerHeight < 135, "an empty composer must leave room to read the conversation");
    const longDraft = "第一行：保留这份输入。\n".repeat(12);
    await js(`(()=>{const input=document.querySelector(".composer textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,${JSON.stringify(longDraft)});input.dispatchEvent(new Event("input",{bubbles:true}));})()`);
    await until(() => js('document.querySelector(".composer textarea").value.length > 100'), "draft input was lost");
    assert.ok(await js('document.querySelector(".composer").getBoundingClientRect().height') > emptyComposerHeight + 60, "composer must grow for multiline input");
    assert.ok(await js('document.querySelector(".composer textarea").getBoundingClientRect().height') <= 181, "long drafts must not consume the whole window");
    await js('document.querySelector(".agentOptionsTrigger").click()');
    await until(() => js('Boolean(document.querySelector(".connectionSource"))'), "assistant settings did not open");
    assert.equal(await js('document.querySelector(".composer textarea").value'), longDraft, "opening settings must preserve the draft");
    assert.equal(await js('Boolean(document.querySelector(".connectionSource .modelSetting"))'), true);
    await js('document.querySelector(".modelChoice").click()');
    await until(() => js('Boolean(document.querySelector(".researchSelect"))'), 'the model catalog must expose selectable models');
    await js('document.querySelector(".researchSelect").click()');
    await until(() => js('Boolean(document.querySelector(".researchSelectPopup [role=option]"))'), 'the model menu must open within the assistant popup');
    await js('[...document.querySelectorAll(".researchSelectPopup [role=option]")].find(item=>item.textContent.includes("验收模型")).focus()');
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'}); window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    await until(() => host.session(s.id).model === 'qa-model', 'a visible model selection must persist to the current session');
    await until(() => js('!document.querySelector(".researchSelectPopup")?.checkVisibility()'), 'choosing a model must close only its options');
    assert.equal(await js('document.querySelector(".composer textarea").value'), longDraft, 'model selection must retain the current request');
    await until(() => js('document.querySelector(".connectionSource").contains(document.activeElement)'), 'assistant options must receive keyboard focus');
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(() => js('!document.querySelector(".connectionSource")'), 'Escape closes settings');
    await until(() => js('document.activeElement === document.querySelector(".agentOptionsTrigger")'), 'focus returns to the menu trigger');
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
    assert.equal(await frame().executeJavaScript('document.querySelector(".statusDescription").textContent'), '174.50', 'a persisted Status binding must show the actual reviewed amount, independently of task progress');
    stage = "move the presentation anchor without replacing the editing App";
    await frame().executeJavaScript('window.researchInstanceMarker = "original-realm";document.querySelector("input").focus()');
    host.message(s.id, 'anchor-update', 'assistant', '继续核对用途，当前工作页保持打开。');
    const beforeAnchor = host.ui.read(s.id);
    await host.ui.call(s.id, { operation: 'present', revision: beforeAnchor.revision, document: beforeAnchor.document });
    await until(() => js('document.querySelector(".surfaceMount").previousElementSibling?.textContent.includes("继续核对用途，当前工作页保持打开")'), 'presentation did not follow its new message anchor');
    assert.equal(frame().frameTreeNodeId, originalFrame, 'a new anchor must reuse the existing browsing context');
    assert.equal(await frame().executeJavaScript('window.researchInstanceMarker'), 'original-realm', 'same DOM element is insufficient: the App realm must not reload');
    assert.equal(await frame().executeJavaScript('document.activeElement === document.querySelector("input")'), true, 'streaming anchor updates must not steal editing focus');
    await frame().executeJavaScript(
      'const input=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"周一团队会议");input.dispatchEvent(new Event("input",{bubbles:true}));',
    );
    stage = "disclose requirements and grouped activity without losing the App draft";
    assert.equal(await js('document.querySelector(".requestExpand").getAttribute("aria-expanded")'), 'false');
    await js('document.querySelector(".requestExpand").click()');
    assert.ok(await js('!document.querySelector(".requestExcerpt") && document.querySelector(".message.user").innerText.includes("不得对外发送")'), 'expansion must reveal the full original requirements');
    assert.equal(await js('document.querySelector(".toolActivityGroup").open'), false);
    stage = "show live work and settle activity without hiding the answer";
    host.updateSession(s.id, 'running');
    await until(() => js('document.querySelector(".toolActivityGroup").open'), 'live work must reveal its actual operations');
    assert.ok(await js('document.querySelector(".toolActivityList").innerText.includes("读取选定订单，保留原件") && document.querySelector(".toolActivityList").innerText.includes("核对金额 100.00 + 74.50 = 174.50")'), 'operations must be recognizable without opening a second generic disclosure');
    await js('{document.querySelector(".composer textarea").focus();const t=document.querySelector(".transcript");t.scrollTop=t.scrollHeight;t.dispatchEvent(new Event("scroll"));}');
    host.updateSession(s.id, 'idle');
    await until(() => js('!document.querySelector(".toolActivityGroup").open'), 'settled activity should fold while the answer stays visible');
    assert.ok(await js('Array.from(document.querySelectorAll(".message.assistant")).some(message=>message.checkVisibility() && message.innerText.includes("请核对金额"))'), 'folding tools must never hide an ordinary assistant reply');
    for (const status of ['failed', 'waiting']) {
      host.updateSession(s.id, status);
      await until(() => js(`document.querySelector('.toolActivityGroup').dataset.phase === '${status}' && document.querySelector('.toolActivityGroup').open`), 'failed work and requests for input must keep their records available');
    }
    await js('document.querySelector(".toolActivityGroup > summary").focus()');
    host.updateSession(s.id, 'idle');
    await until(() => js('document.querySelector(".toolActivityGroup").dataset.phase === "settled"'), 'activity should receive completion');
    assert.ok(await js('document.querySelector(".toolActivityGroup").open'), 'completion must not collapse content while the user has focus inside it');
    await js('{document.querySelector(".composer textarea").focus();const t=document.querySelector(".transcript");t.scrollTop=t.scrollHeight;t.dispatchEvent(new Event("scroll"));}');
    await until(() => js('!document.querySelector(".toolActivityGroup").open'), 'automatic folding may resume when the user leaves the records');
    await js('document.querySelector(".toolActivityGroup > summary").click()');
    assert.ok(await js('document.querySelector(".toolActivityList").checkVisibility() && document.querySelectorAll(".toolActivityList .message").length === 2 && document.querySelector(".toolActivityList").innerText.includes("174.50")'), 'one disclosure must reveal the original short operations directly');
    await js('document.querySelector(".composer textarea").focus()');
    host.updateSession(s.id, 'running');
    await until(() => js('document.querySelector(".toolActivityGroup").dataset.phase === "running"'), 'manual expansion should receive live updates');
    host.updateSession(s.id, 'idle');
    await until(() => js('document.querySelector(".toolActivityGroup").dataset.phase === "settled"'), 'manual expansion should receive completion');
    assert.ok(await js('document.querySelector(".toolActivityGroup").open'), 'an explicit expansion must survive streaming and completion');
    assert.equal(frame().frameTreeNodeId, originalFrame, 'opening transcript disclosures must retain the live App');
    assert.equal(await frame().executeJavaScript('document.querySelector("input").value'), '周一团队会议');
    await js('document.querySelector(".toolActivityGroup > summary").click();document.querySelector(".requestExpand").click()');
    stage = "dismiss reading menu with keyboard and outside click";
    await js('document.querySelector(".appearanceMenu").click()');
    await js('document.querySelector(".researchMenuItem").focus();document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await until(() => js('!document.querySelector(".researchMenu") && document.activeElement===document.querySelector(".appearanceMenu")'), 'Escape must close appearance choices and restore focus');
    await js('document.querySelector(".appearanceMenu").click()');
    await js('document.querySelector(".composer textarea").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
    await until(() => js('!document.querySelector(".researchMenu")'), 'outside click must dismiss appearance choices');
    stage = "change reading theme with an edited App";
    assert.equal(await frame().executeJavaScript('getComputedStyle(document.documentElement).getPropertyValue("--color-ring-primary").trim()'), '#2f5beb', 'light Host context must use the shared focus role');
    assert.deepEqual(await js('[".railPrimary [aria-current=page]",".taskTitle"].map(selector=>getComputedStyle(document.querySelector(selector)).fontWeight)'), ['500', '400']);
    await frame().executeJavaScript('window.qaThemeMessages=[];window.addEventListener("message", event=>{if(event.data?.method==="ui/notifications/host-context-changed")window.qaThemeMessages.push(event.data.params.theme);});');
    await changeAppearance('暗色');
    await until(async () => await js('document.documentElement.dataset.theme === "dark"') && await frame().executeJavaScript('matchMedia("(prefers-color-scheme: dark)").matches && getComputedStyle(document.documentElement).backgroundColor === "rgb(28, 28, 28)"'), "the sandboxed App must follow the workbench night theme");
    assert.equal(await frame().executeJavaScript('getComputedStyle(document.documentElement).getPropertyValue("--color-ring-primary").trim()'), '#8aa8ff', 'dark Host context must use the Research document focus role');
    assert.equal(frame().frameTreeNodeId, originalFrame, "theme changes must not recreate the App");
    assert.equal(await frame().executeJavaScript('document.querySelector("input").value'), "周一团队会议", "theme changes must preserve in-progress edits");
    await until(() => frame().executeJavaScript('window.qaThemeMessages.includes("dark")'), "MCP host context must describe the selected theme");
    assert.equal(await js('localStorage.getItem("turnsu.appearance")'), "dark");
    await changeAppearance('明亮');
    await until(() => frame().executeJavaScript('!matchMedia("(prefers-color-scheme: dark)").matches && getComputedStyle(document.documentElement).backgroundColor === "rgb(255, 255, 255)"'), "returning to paper must update the existing App");
    assert.equal(frame().frameTreeNodeId, originalFrame);
    stage = "follow actual system changes and resize the same App";
    await changeAppearance('跟随系统');
    await until(() => js('localStorage.getItem("turnsu.appearance") === "system"'), 'system preference was not stored');
    await frame().executeJavaScript('(()=>{const input=document.querySelector("input");input.focus({preventScroll:true});input.setSelectionRange(2,4);})()');
    nativeTheme.themeSource = 'dark';
    await until(async () => await js('document.documentElement.dataset.theme === "dark"') && await frame().executeJavaScript('getComputedStyle(document.documentElement).backgroundColor === "rgb(28, 28, 28)"'), 'actual system change did not reach the same App');
    assert.deepEqual(await frame().executeJavaScript('(()=>{const input=document.querySelector("input");return [document.activeElement===input,input.selectionStart,input.selectionEnd,input.value];})()'), [true, 2, 4, '周一团队会议'], 'system appearance changes must preserve input focus and selection');
    const standardRowHeight = await frame().executeJavaScript('document.querySelector("tbody tr").getBoundingClientRect().height');
    await changeTextSize('large');
    await until(() => frame().executeJavaScript('getComputedStyle(document.querySelector("input")).fontSize === "16px"'), 'standard MCP styles did not resize App inputs');
    assert.ok(await frame().executeJavaScript('document.querySelector("tbody tr").getBoundingClientRect().height') > standardRowHeight, 'large text must increase table row height');
    assert.equal(await js('getComputedStyle(document.querySelector(".message.assistant")).fontSize'), '16px');
    assert.equal(frame().frameTreeNodeId, originalFrame, 'text size changes must reuse the original App');
    assert.equal(await frame().executeJavaScript('document.querySelector("input").value'), '周一团队会议');
    await changeTextSize('standard');
    await changeAppearance('明亮');
    nativeTheme.themeSource = 'light';
    nativeTheme.themeSource = 'dark';
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await js('document.documentElement.dataset.theme'), 'light', 'an explicit preference must override the system');
    nativeTheme.themeSource = 'light';
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
      () => frame().executeJavaScript('!document.querySelector("[data-task-submit]").disabled'),
      "review did not finish saving before confirmation",
    );
    stage = "deliver confirmation";
    const waiting = host.ui.call(s.id, { operation: "wait" });
    await frame().executeJavaScript(
      'document.querySelector("[data-task-submit]").click()',
    );
    await until(() => host.ui.read(s.id).events.some(event => event.state === "consumed"),
      "confirmation did not reach the waiting Agent tool");
    const event = await waiting;
    assert.equal(event.values.note, "周一团队会议");
    assert.equal(event.assets.length, 0);
    await until(
      async () =>
        await frame().executeJavaScript(
          'document.querySelector("[data-task-submit]").disabled',
        ),
      "submitted action should not repeat",
    );
    assert.equal(host.ui.read(s.id).events.length, 1);
    await until(
      () => frame().executeJavaScript('document.querySelector("[role=status]").innerText === "本轮已结束，尚未返回文件成果；确认内容已保留"'),
      "an idle Agent without returned files must expose the missing result instead of a success indication",
    );
    assert.equal(
      await frame().executeJavaScript('document.querySelector("[data-task-submit]").innerText'),
      "已确认",
      "the submitted button acknowledges confirmation without claiming the task is completed",
    );
    assert.deepEqual(
      await frame().executeJavaScript('[...document.querySelectorAll("footer button")].map(button => button.innerText)'),
      ["继续处理"],
      "the original confirmation needs an explicit recovery action, not another submit button",
    );
    assert.equal(nativeStarts.length, 0, "a saved confirmation must not resume automatically");
    await frame().executeJavaScript('document.querySelector("footer button").click()');
    await until(() => nativeStarts.length === 1 && host.ui.read(s.id).events[0].state === "sent",
      "the visible continuation must reach the same Agent through the production bridge");
    assert.match(JSON.stringify(nativeStarts[0]), /周一团队会议/);
    assert.match(JSON.stringify(nativeStarts[0]), /先核对/);
    assert.equal(host.ui.read(s.id).events.length, 1);
    host.updateSession(s.id, "idle");
    host.message(s.id, "complete", "assistant", "汇总已完成，可打开[工作参考资料](" + website + ")。");
    host.notify({type: "changed", sessionId:s.id});
    await until(() => js('Boolean(document.querySelector(".textLink"))'), "new reply not visible");
    assert.equal(frame().frameTreeNodeId, originalFrame, "new replies must not remount the App");
    assert.equal(await js('Boolean(document.querySelector(".surfaceMount").previousElementSibling?.textContent.includes("继续核对用途，当前工作页保持打开"))'), true, "App must stay beside its original reply when continuation adds a new turn");
    stage = "open conversation website";
    await js('document.querySelector(".textLink").click()');
    await until(() => embedded.browser.bound?.view.webContents.getURL() === website, "conversation link did not open embedded website");
    assert.match(await embedded.browser.bound.view.webContents.executeJavaScript("document.body.innerText"), /内部示例资料已打开/);
    assert.equal(embedded.browser.state(s.id).grant, null, "opening a link must not authorize automation");
    const browserContent = embedded.browser.bound.view.webContents;
    await js('document.querySelector(".workMenu").click()');
    await until(() => !embedded.browser.bound.view.getVisible(), 'the native browser must yield to a Base UI menu');
    await js('document.querySelector(".researchMenuItem").focus()');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(() => embedded.browser.bound.view.getVisible(), 'closing the menu must restore the native browser');
    assert.equal(embedded.browser.bound.view.webContents, browserContent, 'opening a menu must not recreate or navigate the browser');

    await js('document.querySelector("[aria-label=收起网页]").click()');
    await until(() => !embedded.browser.bound, "website did not hide");
    assert.equal(frame().frameTreeNodeId, originalFrame, "browsing must preserve the App draft");
    stage = "publish and preview result file";
    await writeFile(
      join(path, "汇总说明.txt"),
      "合计 174.50 元；用途：周一团队会议。",
    );
    host.updateSession(s.id, "waiting");
    await until(
      () => frame().executeJavaScript('document.querySelector("footer [role=status]")?.innerText === "请在对话中回应"'),
      "the working page must show the original Agent's pending approval",
    );
    await host.ui.call(s.id, {
      operation: "publish",
      paths: ["汇总说明.txt"],
      summary: "汇总说明已生成，可继续修改。",
    });
    host.updateSession(s.id, "idle");
    await until(
      () => frame().executeJavaScript('document.querySelector("footer [role=status]")?.innerText === "确认内容已交给助手"'),
      "the working page must refresh after approval",
    );
    await until(
      () => js('Boolean(document.querySelector(".resultFiles button"))'),
      "the Host must show the actual published file in the conversation",
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
    stage = "open native Agent file citation";
    host.message(s.id, "file-citation", "assistant", ':codex-file-citation{path="' + join(p.path, "汇总说明.txt") + '" artifact_kind="document" purpose="output"}');
    host.notify({ type: "changed", sessionId: s.id });
    await until(() => js('[...document.querySelectorAll(".message.assistant .textLink")].some(button=>button.textContent.includes("汇总说明.txt"))'),
      "native file reference must render a named link, not raw protocol text");
    assert.equal(await js('document.querySelector(".transcript").textContent.includes(":codex-file-citation{")'), false);
    await js('[...document.querySelectorAll(".message.assistant .textLink")].find(button=>button.textContent.includes("汇总说明.txt")).click()');
    await until(() => js('document.querySelector(".filePreview")?.innerText.includes("174.50")'),
      "native Agent file link must open the registered project result");
    assert.equal(frame().frameTreeNodeId, originalFrame);
    await js('document.querySelector("[aria-label=关闭文件面板]").click()');
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
      await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `conversation-outputs-${process.platform}.png`), (await capturePaintedPage()).toPNG());
      await changeAppearance('暗色');
      await until(() => frame().executeJavaScript('getComputedStyle(document.documentElement).backgroundColor === "rgb(28, 28, 28)"'), "outputs and embedded content must use night colors together");
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.deepEqual(await js('[".newTask", ".outputsPanel", ".outputsPanel .resultFile"].map(selector=>getComputedStyle(document.querySelector(selector)).backgroundColor)'), ['rgb(28, 28, 28)', 'rgb(28, 28, 28)', 'rgba(0, 0, 0, 0)'], 'flat file rows must inherit the dark panel immediately without flashing pale backgrounds under dark-theme text');
      await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `conversation-night-${process.platform}.png`), (await capturePaintedPage()).toPNG());
      await changeAppearance('明亮');
      await until(() => frame().executeJavaScript('getComputedStyle(document.documentElement).backgroundColor === "rgb(255, 255, 255)"'), "outputs must return to paper colors");
    }
    await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await until(() => js('!document.querySelector(".outputsPanel")'), "Escape must close task outputs");
    assert.ok(await js('document.activeElement === document.querySelector(".outputsTrigger")'), "closing outputs must restore keyboard focus");
    await js('document.querySelector(".outputsTrigger").click()');
    await until(() => js('Boolean(document.querySelector(".surfaceShortcut"))'), "interactive content must be listed with task outputs");
    await js('document.querySelector(".surfaceShortcut").click()');
    await until(() => js('Boolean(document.querySelector(".conversationSurface.expanded")) && !document.querySelector(".outputsPanel")'), "the output shortcut must open the existing App");
    assert.equal(frame().frameTreeNodeId, originalFrame, "opening a review from outputs must reuse its iframe");
    assert.match(await js('document.querySelector(".conversationSurface.expanded .surfaceHeading button").textContent'), /返回对话/, "expanded content needs a clear return action");
    assert.equal(await frame().executeJavaScript('document.querySelector("input").value'), "周一团队会议", "output shortcut must preserve the human review draft");
    assert.equal(await js('document.querySelector(".composerArea").inert'), true, 'covered conversation controls must leave the keyboard and accessibility order');
    assert.equal(await js('document.querySelector(".surfaceMount").inert'), false, 'the expanded App must remain interactive');
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
    await until(async () => {
      const size = await frame().executeJavaScript('({ content: document.body.getBoundingClientRect().height, viewport: innerHeight })');
      return size.content > 680 || size.content <= size.viewport + 2;
    }, 'an ordinary inline App must fit its reported height without a second scrollbar');
    await js('document.querySelector(".conversationSurface").scrollIntoView({block:"center",behavior:"instant"})');
    await js(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    if (process.env.TURNSU_QA_ARTIFACTS) {
      await mkdir(process.env.TURNSU_QA_ARTIFACTS, { recursive: true });
      await writeFile(
        join(process.env.TURNSU_QA_ARTIFACTS, `conversation-inline-${process.platform}.png`),
        (await capturePaintedPage()).toPNG(),
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
    if (process.env.TURNSU_QA_ARTIFACTS) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `new-work-${process.platform}.png`), (await capturePaintedPage()).toPNG());
    stage = "restore appearance after renderer restart";
    await changeTextSize("large");
    await changeAppearance('暗色');
    await until(() => js('localStorage.getItem("turnsu.appearance") === "dark"'), "appearance was not saved");
    await window.loadURL("turnsu://app/index.html");
    await until(() => js('Boolean(document.querySelector(".taskWelcome")) && document.documentElement.dataset.theme === "dark"'), "reopening the workbench must restore the chosen reading theme");
    assert.equal(await js('document.querySelectorAll("iframe").length'), 0, "appearance restoration must not resurrect old Apps");
    assert.equal(await js('document.documentElement.dataset.textSize'), "large", "text size must survive reopening");
    await changeTextSize("standard");
    if (process.env.TURNSU_QA_ARTIFACTS) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `new-work-night-${process.platform}.png`), (await capturePaintedPage()).toPNG());
    await changeAppearance('明亮');
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
        (await capturePaintedPage()).toPNG(),
      );
    }
    stage = "replace review with readonly result";
    const reviewFrame = frame().frameTreeNodeId;
    await host.ui.call(s.id, {
      operation: "present",
      revision: host.ui.read(s.id).revision,
      document: {
        title: "汇总结果",
        data: { files: ["汇总说明.txt", "尚未生成.txt"] },
        tree: { id: "result", type: "Layout", children: [
          { id: "summary", type: "Text", text: "合计 174.50 元，说明文件可在对话中打开。" },
          { id: "state", type: "Status", label: "处理结果", text: "待处理金额总计：174.50 元" },
          { id: "files", type: "Assets", label: "成果文件", binding: "files" },
        ] },
      },
    });
    await until(
      async () => {
        // New content and its anchor update inside the existing App bridge.
        if (!await js('document.querySelector(".surfaceHeading strong")?.innerText === "汇总结果"')) return false;
        const content = frame();
        return content && content.frameTreeNodeId === reviewFrame &&
          content.executeJavaScript('document.querySelector(".statusDescription")?.innerText === "待处理金额总计：174.50 元" && !document.querySelector("[role=status]")');
      },
      "a read-only presentation must not ask for confirmation or reuse an earlier receipt",
    );
    assert.equal(await frame().executeJavaScript('document.querySelector("[data-task-submit]")'), null);
    assert.equal(await frame().executeJavaScript('getComputedStyle(document.querySelector(".statusDescription")).fontWeight'), '400');
    assert.equal(
      await frame().executeJavaScript('document.querySelector(".statusDescription").innerText'),
      "待处理金额总计：174.50 元",
      "Agent-authored status details must remain visible separately from runtime state",
    );
    stage = "open a bound file from the real result App";
    const readonlyFrame = frame().frameTreeNodeId;
    assert.equal(await frame().executeJavaScript('document.querySelector(".assets").innerText.includes("订单.csv")'), false,
      "result file binding must not be replaced with input materials");
    assert.equal(await frame().executeJavaScript('document.querySelector(".assets").innerText.includes("添加文件")'), false,
      "a bound file list is read-only");
    assert.equal(await frame().executeJavaScript('document.querySelector(\'button[aria-label="打开文件：尚未生成.txt"]\')?.disabled'), true,
      "an unregistered Agent-proposed file must not become an openable result");
    await frame().executeJavaScript('document.querySelector(\'button[aria-label="打开文件：汇总说明.txt"]\').click()');
    await until(() => js('document.querySelector(".filePreview")?.innerText.includes("174.50")'),
      "the sandboxed result App must open the actual published file through the workbench");
    assert.equal(await js('Boolean(document.querySelector(".conversationSurface.expanded"))'), false,
      "opening an App result returns to the conversation with its file panel");
    assert.equal(frame().frameTreeNodeId, readonlyFrame, "opening a bound result must preserve the App instance");
    await js('document.querySelector("[aria-label=关闭文件面板]").click()');
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
    assert.equal(await frame().executeJavaScript('document.querySelector("[data-task-submit]").disabled'), true);
    const receiptCount = host.ui.read(s.id).events.length;
    await frame().executeJavaScript('document.querySelector("[data-task-submit]").click()');
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
    await js('document.querySelector(".projectSwitcher").click()');
    await until(() => js('[...document.querySelectorAll(".researchMenuItem")].some(item=>item.textContent.includes("每周工作"))'), 'new project did not reach navigation');
    await clickText('.researchMenuItem', '管理项目');
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
    await js('document.querySelector(".projectSwitcher").click()');
    await clickText('.researchMenuItem', '客户工作资料');
    await until(() => js('document.querySelectorAll(".sessionRow").length === 0'), 'moved conversation still belongs to source navigation');
    await js('document.querySelector("[aria-label=查找所有项目]").click()');
    await until(() => js('document.querySelector(".sessionRow")?.textContent.includes("每周归档")'), 'all-project lookup cannot locate a moved conversation');
    await js('document.querySelector(".sessionRow .sessionButton").click()');
    await until(() => js('document.querySelector(".composer textarea")?.value === "迁移后继续核对，保留原文件夹和这段草稿。"'), 'global lookup lost the conversation');
    // Match a short usable area on every OS; native title bars differ.
    window.setContentSize(880, 640);
    await until(() => js('innerWidth === 880 && innerHeight === 640'), 'short content viewport did not resize');
    const currentRow = await js('(() => { const row=document.querySelector(".sessionRow.current").getBoundingClientRect(), nav=document.querySelector("nav[aria-label=项目与任务]").getBoundingClientRect(); return {row: [row.top, row.bottom], nav: [nav.top, nav.bottom]}; })()');
    assert.ok(currentRow.row[0] >= currentRow.nav[0] && currentRow.row[1] <= currentRow.nav[1], 'a short window must show the current conversation: ' + JSON.stringify(currentRow));
    stage = "resize restored App and capture short window";
    await changeTextSize('large');
    await until(() => frame()?.executeJavaScript('(() => { const input=document.querySelector("input"); return Boolean(input && getComputedStyle(input).fontSize === "16px"); })()'), 'large text did not reach the restored App');
    const largeBounds = await js('(() => { const row=document.querySelector(".sessionRow.current").getBoundingClientRect(), nav=document.querySelector("nav[aria-label=项目与任务]").getBoundingClientRect(); return {row:[row.top,row.bottom],nav:[nav.top,nav.bottom],width:document.body.scrollWidth,viewport:innerWidth}; })()');
    assert.ok(largeBounds.row[0] >= largeBounds.nav[0] && largeBounds.row[1] <= largeBounds.nav[1], 'large text must keep the current conversation visible: ' + JSON.stringify(largeBounds));
    assert.ok(largeBounds.width <= largeBounds.viewport, 'large text must not overflow the workbench');
    if (process.env.TURNSU_QA_ARTIFACTS) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `reading-large-${process.platform}.png`), (await capturePaintedPage()).toPNG());
    await changeTextSize('standard');
    if (process.env.TURNSU_QA_ARTIFACTS) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `session-management-${process.platform}.png`), (await capturePaintedPage()).toPNG());
    await changeAppearance('暗色');
    await openSessionMenu();
    await until(() => js('document.activeElement?.getAttribute("role") === "menuitem"'), 'session menu did not receive keyboard focus');
    await until(() => js('getComputedStyle(document.querySelector(".sessionActionsMenu")).opacity === "1"'), 'the visible session menu did not finish opening');
    if (process.env.TURNSU_QA_ARTIFACTS) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `session-menu-night-${process.platform}.png`), (await capturePaintedPage()).toPNG());
    await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await until(() => js('document.activeElement?.getAttribute("aria-label") === "会话选项：订单整理" && !document.querySelector("[role=menu]")'), 'closing the menu must return focus to its trigger');
    await openSessionMenu();
    await js('{const input=document.querySelector(".composer textarea");input.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));input.focus();}');
    await until(() => js('document.activeElement === document.querySelector(".composer textarea") && !document.querySelector("[role=menu]")'), 'clicking outside the menu must not steal focus back from the editor');
    stage = 'Research component layout and responsive editing';
    await checkResearchComponents({ js, frame, until, host, session:s, window, changeAppearance, capturePaintedPage });
    console.log(
      JSON.stringify({
        status: "passed",
        platform: process.platform,
        electron: process.versions.electron,
        nativeAgent: false,
        fonts: { workbenchSubsets: fontRequests.workbench.size, appSubsets: fontRequests.app.size },
        evidence: [
          "production conversation and sandboxed MCP App",
          "Shared component typography and CJK font binaries decoded through read-only packaged routes; tabular numerals and display roles checked",
          "edited data returned to waiting tool",
          "same iframe across expand/collapse",
          "system/light/dark and text size follow standard MCP context without losing edits",
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
    process.exitCode = 1;
    console.error(`Conversation UI failed at ${stage}:`, e?.stack || e);
    if (process.env.TURNSU_QA_ARTIFACTS && window && !window.isDestroyed()) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, `conversation-failure-${process.platform}.png`), (await window.webContents.capturePage()).toPNG()).catch(error => console.error("Could not save diagnostic screenshot:", error.message));
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
