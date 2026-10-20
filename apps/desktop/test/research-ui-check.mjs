import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ipcMain } from 'electron';

// Controlled orders through the production App, SQLite and confirmation tool.
// This proves behavior; the real-Agent acceptance is recorded separately.
export async function checkResearchComponents({ js, frame, until, host, session, window, embedded, website, surfaceCalls, changeAppearance, capturePaintedPage }) {
  const previousSession = host.session(session.id), previousDraft = host.ui.read(session.id).document.data;
  session = await host.command('session.create', { projectId: previousSession.collection_project_id || previousSession.project_id, agent: 'codex' });
  await host.command('session.rename', { sessionId: session.id, title: '订单核对（验收数据）' });
  host.message(session.id, 'research-example', 'assistant', '以下为组件交互验收用的订单数据。确认前保留草稿，不生成报告。');
  const rows = [{ id: 'a', order: 'TEST-001', customer: '样本甲', amount: '100.00' }, { id: 'b', order: 'TEST-002', customer: '样本乙', amount: '74.50' }];
  const program = `root = Col([
    Title("订单资料核对"),
    ResearchSummary("两笔订单已对齐，确认份数后生成报告", "每份包含两笔原始订单。先核对金额和用途，确认后再交给当前助手。", "订单核对"),
    Grid([Metric("单份金额", "174.50 元", "100.00 + 74.50"), Metric("核对份数", $copies + " 份", "按当前输入计算"), Metric("本次预估", @Format(174.5 * $copies, "number", 2) + " 元", "单份金额 × 份数"), Metric("原始记录", "2 笔", "来自订单.csv")], 4, 130),
    ResearchSection("原始记录", [ReviewTable($rows, [{key:"order",label:"订单号"},{key:"customer",label:"客户"},{key:"amount",label:"金额（元）"}])]),
    ResearchSection("确认范围", [Grid([Input($copies, "份数", "number"), Input($purpose, "报告用途")], 2, 220)]),
    Comparison("本次将处理", ["核对所选订单与报告用途", "生成独立的新版报告"], "原件保留", ["订单.csv 保持原值", "已有报告保持不变"]),
    ResearchNote("金额是草稿计算结果；只有点击确认后，助手才会收到这次要求。", "确认前"),
    KeyValue([{label:"核算口径",value:"每份包含完整的两笔订单"}]),
    ActionBar([Button("确认并生成报告", @ToAssistant("按确认份数生成新版报告", {copies:$copies,total:174.5*$copies,purpose:$purpose}))], "生成报告并登记到本次成果"),
    Button("添加资料", @ImportFiles(), "outline"),
    Sources([{label:"订单.csv · 原始金额"},{label:"工作参考资料",url:${JSON.stringify(website)}}])
  ])\n$copies = 2\n$purpose = "内部核对"\n$rows = []`;
  await host.ui.call(session.id, { operation: 'present', revision: host.ui.read(session.id).revision, document: {
    format: 'openui', title: '订单资料核对', program, data: { $copies: 2, $purpose: '内部核对', $rows: rows },
  } });
  window.setContentSize(1180, 820);
  const selectSession = () => js(`(() => { const button=[...document.querySelectorAll('.sessionButton')].find(item=>item.textContent.includes('订单核对（验收数据）')); if(!button || button.disabled) return false; button.click(); return true; })()`);
  await until(selectSession, 'component conversation did not appear');
  await until(() => frame()?.executeJavaScript('document.querySelectorAll(".statusBlock").length === 4'), 'Research metrics did not render');
  await changeAppearance('明亮');
  assert.equal(await frame().executeJavaScript('document.querySelectorAll(".iui-title").length'), 0, 'the host already provides the document title');
  assert.equal(await frame().executeJavaScript('document.querySelector(".researchSummary h2").textContent'), '两笔订单已对齐，确认份数后生成报告');
  assert.equal(await frame().executeJavaScript('document.querySelectorAll(".metricContext").length'), 4, 'each number needs its comparison or basis');
  assert.equal(await frame().executeJavaScript('document.querySelector(".metricUnit").textContent'), ' 元');
  assert.equal(await frame().executeJavaScript('document.querySelectorAll(".dataView nav").length'), 0, 'two rows do not need disabled pagination');
  assert.equal(await frame().executeJavaScript('getComputedStyle(document.querySelector(".iui-grid:has(> .statusBlock)")).gridTemplateColumns.split(" ").length'), 4);
  assert.equal(await frame().executeJavaScript('getComputedStyle(document.querySelector(".researchActionBar button")).minHeight'), '30px');
  const input = value => frame().executeJavaScript(`{const input=document.querySelector('input[aria-label="份数"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await input('4');
  await until(() => host.ui.read(session.id).document.data.$copies === 4, 'quantity did not persist');
  assert.equal(await frame().executeJavaScript('document.querySelectorAll(".statusDescription")[2].innerText'), '698.00 元', 'calculation must update without another model turn');
  assert.equal(host.ui.read(session.id).events.length, 0, 'editing is not confirmation');
  assert.deepEqual(host.ui.read(session.id).document.data.$rows, rows);
  // Reopen through the real renderer; preserve the same Host source and draft.
  await window.loadURL("turnsu://app/index.html");
  await until(selectSession, 'saved conversation must be available after reopening the workbench');
  await until(() => frame()?.executeJavaScript('document.querySelector("input[aria-label=份数]")?.value === "4"').catch(() => false), 'draft did not restore after renderer reload');
  // A source link must reveal the native browser on the first click.
  assert.equal(embedded.browser.bound, null);
  await js('document.querySelector("[aria-label=展开内容]").click()');
  await frame().executeJavaScript('document.querySelector(".researchSources a").click()');
  await until(async () => await js('Boolean(document.querySelector(".embeddedPane")) && !document.querySelector(".conversationSurface.expanded")')
    && embedded.browser.bound?.view.getVisible()
    && embedded.browser.bound.view.webContents.getURL() === website, 'OpenUI source did not reveal the actual website');
  assert.match(await embedded.browser.bound.view.webContents.executeJavaScript('document.body.innerText'), /内部示例资料已打开/);
  assert.equal(embedded.browser.state(session.id).grant, null, 'following a source grants no automation');
  await js('document.querySelector("[aria-label=收起网页]").click()');
  await until(() => !embedded.browser.bound, 'source browser did not hide');
  await input('-');
  await frame().executeJavaScript('document.querySelector("[data-task-submit]").click()');
  assert.equal(host.ui.read(session.id).events.length, 0, 'invalid visible numeric input must block confirmation');
  const invalidFrame = frame().frameTreeNodeId;
  await js('document.querySelector(".railPrimary [aria-label=插件与技能]").click()');
  await until(() => js('document.querySelector(".error")?.innerText.includes("请先修正标出的输入")'), 'leaving an invalid input must explain why it is blocked');
  assert.equal(frame().frameTreeNodeId, invalidFrame);
  assert.equal(await frame().executeJavaScript('document.querySelector("input[aria-label=份数]").value'), '-', 'a failed flush must retain the visible input');
  const closeReply = new Promise(resolve => ipcMain.once('desktop:close-ready', (_event, reply) => resolve(reply)));
  window.webContents.send('desktop:prepare-close', 'invalid-number');
  assert.deepEqual(await closeReply, { id: 'invalid-number', saved: false }, 'window close must not claim invalid input was saved');
  for (const unfinished of ['-', '']) {
    await input(unfinished);
    const callsBeforeImport = surfaceCalls.length;
    await frame().executeJavaScript('[...document.querySelectorAll("button")].find(button=>button.textContent==="添加资料").click()');
    await until(() => frame().executeJavaScript('!document.querySelector("fieldset").disabled && document.querySelector(".error")?.textContent.includes("请先修正标出的输入")'), 'an invalid input must stop import before its busy fieldset can suppress validation');
    assert.equal(surfaceCalls.slice(callsBeforeImport).includes('import'), false);
    const invalidClose = new Promise(resolve => ipcMain.once('desktop:close-ready', (_event, reply) => resolve(reply)));
    window.webContents.send('desktop:prepare-close', 'after-invalid-import');
    assert.equal((await invalidClose).saved, false, 'failed import must not make unfinished input safe to discard');
    assert.equal(await frame().executeJavaScript('document.querySelector("input[aria-label=份数]").value'), unfinished);
  }
  await js('document.querySelector("[aria-label=关闭提示]").click()');
  await input('4');
  await until(() => frame().executeJavaScript('!document.querySelector(".error") && document.querySelector("input[aria-label=份数]").checkValidity()'), 'corrected input must clear its obsolete error');
  await frame().executeJavaScript('document.querySelector("input[aria-label=份数]").blur();scrollTo(0,0)');
  await js('document.querySelector(".conversationSurface").scrollIntoView({block:"start"})');
  if (process.env.TURNSU_QA_ARTIFACTS) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, 'research-components-wide.png'), (await capturePaintedPage()).toPNG());
  const frameId = frame().frameTreeNodeId;
  await js('document.querySelector(".conversationSurface iframe").style.width="375px";document.querySelector(".conversationSurface").scrollIntoView({block:"start"});');
  await until(() => frame().executeJavaScript('innerWidth === 375'), '375px width not applied');
  const narrow = await frame().executeJavaScript(`(()=>({columns:getComputedStyle(document.querySelector('.iui-grid:has(> .statusBlock)')).gridTemplateColumns.split(' ').length,comparison:getComputedStyle(document.querySelector('.researchComparison')).gridTemplateColumns.split(' ').length,width:document.documentElement.scrollWidth,viewport:innerWidth,metric:getComputedStyle(document.querySelector('.statusDescription')).fontSize}))()`);
  assert.equal(narrow.columns, 2); assert.equal(narrow.comparison, 1);
  assert.ok(narrow.width <= narrow.viewport, '375px content must not scroll horizontally'); assert.equal(narrow.metric, '24px');
  if (process.env.TURNSU_QA_ARTIFACTS) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, 'research-components-375-light.png'), (await capturePaintedPage()).toPNG());
  await changeAppearance('暗色');
  assert.equal(frame().frameTreeNodeId, frameId);
  assert.equal(await frame().executeJavaScript('document.querySelector("input[aria-label=份数]").value'), '4');
  if (process.env.TURNSU_QA_ARTIFACTS) await writeFile(join(process.env.TURNSU_QA_ARTIFACTS, 'research-components-375-dark.png'), (await capturePaintedPage()).toPNG());
  await js('document.querySelector(".conversationSurface iframe").style.width="";');
  await changeAppearance('明亮');
  const waiting = host.ui.call(session.id, { operation: 'wait' });
  await frame().executeJavaScript('{const button=document.querySelector("[data-task-submit]");button.click();button.click();}');
  const event = await waiting;
  assert.equal(event.values.$copies, 4); assert.equal(event.action.context.total, 698);
  assert.equal(host.ui.read(session.id).events.length, 1, 'double click must create only one human confirmation');
  assert.equal(host.ui.read(session.id).results.length, 0, 'confirmation does not manufacture output');
  const next = { format: 'openui', title: '订单资料核对', program, data: { orders: [{ id: 'new', amount: '100.00' }], $copies: 7, $purpose: '第二轮核对', $rows: rows } };
  await host.ui.call(session.id, { operation: 'present', revision: host.ui.read(session.id).revision, document: next });
  await until(() => frame().executeJavaScript('document.querySelector("input[aria-label=份数]")?.value === "7"'), 'same-template updates must replace the old value');
  // Cover the autosave window: an initialization event must not write 4 over 7.
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(host.ui.read(session.id).document.data.$copies, 7);
  assert.equal(host.ui.read(session.id).dirty, false, 'new source keys must not trigger a user edit');
  await host.ui.call(session.id, { operation: 'present', revision: host.ui.read(session.id).revision, document: { ...next, data: {} } });
  await until(() => frame().executeJavaScript('document.querySelector("input[aria-label=份数]")?.value === "2"'), 'removed bindings must return to their declared default');
  assert.equal(host.ui.read(session.id).dirty, false);
  const defaultWait = host.ui.call(session.id, { operation: 'wait' });
  await frame().executeJavaScript('document.querySelector("[data-task-submit]").click()');
  assert.equal((await defaultWait).values.$copies, 2, 'the next confirmation must contain the displayed default');
  await host.ui.call(session.id, { operation: 'present', revision: host.ui.read(session.id).revision, document: { ...next, data: { ...next.data, orders: [{ id: 'old' }], $copies: 4 }, streaming: true } });
  await until(() => frame().executeJavaScript('document.querySelector("fieldset")?.disabled'), 'streaming content must disable editing and confirmation');
  await host.ui.call(session.id, { operation: 'present', revision: host.ui.read(session.id).revision, document: next });
  await until(() => frame().executeJavaScript('document.querySelector("input[aria-label=份数]")?.value === "7" && !document.querySelector("fieldset").disabled'), 'a new presentation must use its new source data');
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(host.ui.read(session.id).document.data.$copies, 7, 'the final streamed values must not be replaced by a previous chunk');
  assert.equal(host.ui.read(session.id).dirty, false, 'renderer initialization must not create a user edit');
  await host.ui.call(session.id, { operation: 'present', revision: host.ui.read(session.id).revision, document: { ...next, streaming: true } });
  await until(() => frame().executeJavaScript('document.querySelector("fieldset").disabled'), 'second streaming page did not start');
  await host.ui.call(session.id, { operation: 'present', revision: host.ui.read(session.id).revision, document: { ...next, title: '流式中段核对', data: {}, streaming: true } });
  await until(() => frame().executeJavaScript('document.querySelector(".turnsuIntelligencePage")?.getAttribute("aria-label") === "流式中段核对"'), 'the removed binding chunk must reach the live renderer before completion');
  await host.ui.call(session.id, { operation: 'present', revision: host.ui.read(session.id).revision, document: { ...next, data: {} } });
  await until(() => frame().executeJavaScript('document.querySelector("input[aria-label=份数]")?.value === "2" && !document.querySelector("fieldset").disabled'), 'bindings removed mid-stream must not reappear at completion');
  assert.equal(host.ui.read(session.id).dirty, false);
  const streamedWait = host.ui.call(session.id, { operation: 'wait' });
  await frame().executeJavaScript('document.querySelector("[data-task-submit]").click()');
  const streamed = await streamedWait;
  assert.equal(streamed.values.$copies, 2);
  assert.equal(Object.hasOwn(streamed.values, 'orders'), false, 'confirmation must not merge deleted source keys from an older store snapshot');
  // Mixed plans must fail before their first step, never partially import or
  // send a context evaluated before @Set. A separate confirm remains usable.
  const actionsProgram = `root = Col([Input($copies, "份数", "number"),
    Button("修改并确认", Action([@Set($copies, 9), @ToAssistant("继续", {copies:$copies})])),
    Button("导入并确认", Action([@ImportFiles(), @ToAssistant("继续")])),
    Button("单独确认", @ToAssistant("按已核对份数继续", {copies:$copies}))])\n$copies = 2`;
  await host.ui.call(session.id, { operation: 'present', revision: host.ui.read(session.id).revision, document: { format: 'openui', title: '分别操作和确认', program: actionsProgram, data: { $copies: 7 } } });
  await until(() => frame().executeJavaScript('document.body.textContent.includes("修改并确认")'), 'action review did not load');
  const beforeBlocked = host.ui.read(session.id), callCount = surfaceCalls.length;
  for (const label of ['修改并确认', '导入并确认']) {
    await frame().executeJavaScript(`[...document.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(label)}).click()`);
    await until(() => frame().executeJavaScript('document.querySelector(".error")?.textContent.includes("拆成独立步骤")'), 'mixed plans must explain the correction');
  }
  assert.equal(await frame().executeJavaScript('document.querySelector("input[aria-label=份数]").value'), '7');
  assert.deepEqual(host.ui.read(session.id).document.data, beforeBlocked.document.data);
  assert.deepEqual(host.ui.read(session.id).events, beforeBlocked.events);
  assert.equal(surfaceCalls.slice(callCount).some(method => ['save', 'import', 'submit', 'deliver'].includes(method)), false, 'rejected plans must execute no partial Host step');
  const standaloneWait = host.ui.call(session.id, { operation: 'wait' });
  await frame().executeJavaScript('[...document.querySelectorAll("button")].find(button=>button.textContent==="单独确认").click()');
  const standalone = await standaloneWait;
  assert.equal(standalone.values.$copies, 7);
  assert.equal(standalone.action.context.copies, 7);
  assert.deepEqual(host.ui.read(previousSession.id).document.data, previousDraft, 'acceptance must preserve the previous conversation');
  window.setContentSize(1180, 820);
}
