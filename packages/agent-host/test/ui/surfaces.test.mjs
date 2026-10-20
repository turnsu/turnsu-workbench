import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentHost } from "../../host.mjs";
import { validateSurface } from "../../ui/contract.mjs";
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "turnsu-ui-")),
    projectPath = join(root, "项目 with spaces");
  await mkdir(projectPath);
  let turns = 0;
  const factory = () => ({
    ready: Promise.resolve(),
    request: async (method) => {
      if (method === "thread/start" || method === "thread/resume")
        return { thread: { id: "native-ui", turns: [] } };
      if (method === "turn/start") {
        turns++;
        return { turn: { id: "turn-ui" } };
      }
      throw Error(method);
    },
    close: async () => {},
  });
  let host = new LocalAgentHost({
    directory: join(root, "state"),
    connectionFactory: factory,
  });
  const project = await host.command("project.open", { path: projectPath });
  const s = await host.command("session.create", {
    projectId: project.id,
    agent: "codex",
  });
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    projectPath,
    project,
    s,
    get host() {
      return host;
    },
    get turns() {
      return turns;
    },
    reopen: async () => {
      await host.close();
      host = new LocalAgentHost({
        directory: join(root, "state"),
        connectionFactory: factory,
      });
    },
  };
}
test("generic composition preserves a human draft, rejects stale replacement and survives reopening", async (t) => {
  const f = await setup(t);
  let state = await f.host.command("ui.read", { sessionId: f.s.id });
  state = await f.host.ui.call(f.s.id, {
    operation: "present",
    revision: state.revision,
    document: {
      title: "通用核对",
      data: { note: "" },
      tree: {
        id: "root",
        type: "Layout",
        children: [
          { id: "note", type: "Field", label: "要求", binding: "note" },
          { id: "send", type: "Action", action: "submit" },
        ],
      },
    },
  });
  await f.host.command("ui.save", {
    sessionId: f.s.id,
    revision: state.revision,
    values: { note: "保留我的草稿" },
  });
  await assert.rejects(
    f.host.ui.call(f.s.id, {
      operation: "present",
      revision: state.revision,
      document: state.document,
    }),
    /更新/,
  );
  state = await f.host.command("ui.read", { sessionId: f.s.id });
  await assert.rejects(
    f.host.ui.call(f.s.id, {
      operation: "present",
      revision: state.revision,
      document: state.document,
    }),
    /未提交/,
  );
  await f.reopen();
  assert.equal(
    (await f.host.command("ui.read", { sessionId: f.s.id })).document.data.note,
    "保留我的草稿",
  );
});
test("selected files reach the same Agent once, changed inputs are rejected and results are verified", async (t) => {
  const f = await setup(t);
  await writeFile(join(f.projectPath, "材料.csv"), "项目,金额\n通用,174.50\n");
  let state = await f.host.command("ui.attach", {
    sessionId: f.s.id,
    paths: ["材料.csv"],
  });
  assert.equal(state.assets[0].sha256.length, 64);
  await writeFile(join(f.projectPath, "材料.csv"), "changed");
  await assert.rejects(
    f.host.command("ui.commit", {
      sessionId: f.s.id,
      revision: state.revision,
      requestId: "event-materials",
    }),
    /材料已修改/,
  );
  state = await f.host.command("ui.attach", {
    sessionId: f.s.id,
    paths: ["材料.csv"],
  });
  await f.host.command("ui.commit", {
    sessionId: f.s.id,
    revision: state.revision,
    requestId: "event-materials",
  });
  await f.host.command("ui.deliver", {
    sessionId: f.s.id,
    requestId: "event-materials",
  });
  await f.host.command("ui.deliver", {
    sessionId: f.s.id,
    requestId: "event-materials",
  });
  assert.equal(f.turns, 1);
  await assert.rejects(
    f.host.ui.call(f.s.id, { operation: "publish", paths: ["absent.pdf"] }),
  );
  await writeFile(join(f.projectPath, "成果.txt"), "真实文件成果");
  const receipt = await f.host.ui.call(f.s.id, {
    operation: "publish",
    paths: ["成果.txt"],
    summary: "整理完成",
  });
  assert.equal(receipt.files[0].bytes, 18);
  assert.equal(
    await readFile(join(f.projectPath, "材料.csv"), "utf8"),
    "changed",
  );
  await f.reopen();
  state = await f.host.command("ui.read", { sessionId: f.s.id });
  assert.equal(state.results[0].files[0].sha256, receipt.files[0].sha256);
  assert.equal(state.events[0].state, "sent");
});
test("waiting tool receives the actual human event without starting another task", async (t) => {
  const f = await setup(t);
  const state = await f.host.command("ui.read", { sessionId: f.s.id });
  const waiting = f.host.ui.call(f.s.id, { operation: "wait" });
  await f.host.command("ui.commit", {
    sessionId: f.s.id,
    revision: state.revision,
    requestId: "event-return",
  });
  const event = await waiting;
  assert.equal(event.eventId, "event-return");
  assert.equal(f.turns, 0);
  assert.equal(
    (await f.host.command("ui.read", { sessionId: f.s.id })).events[0].state,
    "consumed",
  );
  const other = await f.host.command("session.create", {
    projectId: f.project.id,
    agent: "codex",
  });
  await assert.rejects(
    f.host.command("ui.commit", {
      sessionId: other.id,
      revision: 1,
      requestId: "event-return",
    }),
    /其他会话/,
  );
});
test("an ended Agent can explicitly continue its saved confirmation once after reopening", async (t) => {
  const f = await setup(t);
  let state = await f.host.command("ui.read", { sessionId: f.s.id });
  state = await f.host.ui.call(f.s.id, {
    operation: "present", revision: state.revision,
    document: { title: "订单核对", data: { note: "已确认的用途" },
      tree: { id: "root", type: "Layout", children: [
        { id: "note", type: "Field", binding: "note" },
        { id: "submit", type: "Action", action: "submit" },
      ] } },
  });
  await f.host.command("ui.commit", { sessionId: f.s.id, revision: state.revision, requestId: "ended-confirmation" });
  await f.host.ui.call(f.s.id, { operation: "wait" });
  await f.reopen();
  state = await f.host.command("ui.read", { sessionId: f.s.id });
  assert.equal(state.continuation?.requestId, "ended-confirmation");
  assert.equal(f.turns, 0, "reading a saved receipt must never restart work automatically");
  await f.host.command("ui.deliver", { sessionId: f.s.id, requestId: "ended-confirmation" });
  assert.equal(f.turns, 0, "normal post-submit delivery must not act as an explicit continuation");
  await Promise.all([1, 2].map(() => f.host.command("ui.deliver", {
    sessionId: f.s.id, requestId: "ended-confirmation", continueConfirmed: true,
  })));
  assert.equal(f.turns, 1, "repeated clicks must start only one continuation");
  const sent = f.host.db.prepare("SELECT prompt FROM submissions WHERE id=?").get("ui-ended-confirmation");
  assert.match(sent.prompt, /先核对/);
  assert.match(sent.prompt, /不要重复/);
  assert.match(sent.prompt, /已确认的用途/);
  state = await f.host.command("ui.read", { sessionId: f.s.id });
  assert.equal(state.continuation, null);
  assert.equal(state.events.length, 1, "continuing must reuse the original confirmation");
});

test("a saved confirmation cannot restart an active, edited or already published task", async (t) => {
  const f = await setup(t);
  let state = await f.host.command("ui.read", { sessionId: f.s.id });
  state = await f.host.ui.call(f.s.id, { operation: "present", revision: state.revision,
    document: { title: "核对", data: { note: "确认值" }, tree: { id: "note", type: "Field", binding: "note" } },
  });
  await f.host.command("ui.commit", { sessionId: f.s.id, revision: state.revision, requestId: "guarded-confirmation" });
  await f.host.ui.call(f.s.id, { operation: "wait" });
  f.host.updateSession(f.s.id, "running");
  await f.host.command("ui.deliver", { sessionId: f.s.id, requestId: "guarded-confirmation", continueConfirmed: true });
  assert.equal(f.turns, 0);
  f.host.updateSession(f.s.id, "idle");
  state = await f.host.command("ui.save", { sessionId: f.s.id, revision: state.revision, values: { note: "尚未确认的新输入" } });
  assert.equal(state.continuation, null);
  await f.host.command("ui.deliver", { sessionId: f.s.id, requestId: "guarded-confirmation", continueConfirmed: true });
  assert.equal(f.turns, 0);
  await f.host.command("ui.commit", { sessionId: f.s.id, revision: state.revision, requestId: "published-confirmation" });
  await f.host.ui.call(f.s.id, { operation: "wait" });
  await writeFile(join(f.projectPath, "成果.txt"), "已保存的结果");
  await f.host.ui.call(f.s.id, { operation: "publish", paths: ["成果.txt"] });
  state = await f.host.command("ui.read", { sessionId: f.s.id });
  assert.equal(state.continuation, null);
  await f.host.command("ui.deliver", { sessionId: f.s.id, requestId: "published-confirmation", continueConfirmed: true });
  assert.equal(f.turns, 0);
});
test("composition rejects executable or unknown components rather than rendering a fallback", () => {
  assert.throws(() =>
    validateSurface({
      title: "bad",
      tree: { id: "x", type: "Script", text: "alert(1)" },
      data: {},
    }),
  );
  assert.throws(() =>
    validateSurface({
      title: "bad",
      tree: { id: "x", type: "Text", html: "<script>bad</script>" },
      data: {},
    }),
  );
  assert.throws(() =>
    validateSurface({
      title: "bad",
      tree: { id: "x", type: "Action", action: "shell" },
      data: {},
    }),
  );
});
test("generic table editing preserves row identity and read-only columns", async (t) => {
  const f = await setup(t);
  let state = await f.host.command("ui.read", { sessionId: f.s.id });
  state = await f.host.ui.call(f.s.id, {
    operation: "present",
    revision: state.revision,
    document: {
      title: "数据核对",
      data: { rows: [{ id: "row-a", source: "file:1", note: "" }] },
      tree: {
        id: "grid",
        type: "DataView",
        binding: "rows",
        columns: [
          { key: "source", label: "来源" },
          { key: "note", label: "备注", editable: true },
        ],
      },
    },
  });
  await assert.rejects(
    f.host.command("ui.save", {
      sessionId: f.s.id,
      revision: state.revision,
      values: { rows: [{ id: "row-b", source: "file:1", note: "changed" }] },
    }),
    /单元格/,
  );
  state = await f.host.command("ui.save", {
    sessionId: f.s.id,
    revision: state.revision,
    values: { rows: [{ id: "row-a", source: "file:1", note: "人工确认" }] },
  });
  assert.equal(state.document.data.rows[0].note, "人工确认");
  await f.reopen();
  assert.equal(
    (await f.host.command("ui.read", { sessionId: f.s.id })).document.data
      .rows[0].id,
    "row-a",
  );
});

test("a new conversation has no task form; only an Agent presentation adds interactive content", async (t) => {
  const f = await setup(t);
  let state = await f.host.command("ui.read", { sessionId: f.s.id });
  assert.equal(state.presentation, null);
  assert.equal(state.document.program, "root = Col([])");
  f.host.message(f.s.id, "review-request", "assistant", "请核对这些资料。");
  state = await f.host.ui.call(f.s.id, {
    operation: "present",
    revision: state.revision,
    document: {
      title: "核对资料",
      tree: {
        id: "question",
        type: "Field",
        binding: "note",
        label: "补充说明",
      },
      data: { note: "" },
    },
  });
  assert.equal(state.presentation.anchor, "review-request");
  const presentationRevision = state.presentation.revision;
  assert.equal(presentationRevision, state.revision);
  state = await f.host.command("ui.save", {
    sessionId: f.s.id,
    revision: state.revision,
    values: { note: "保留原始金额" },
  });
  await f.reopen();
  const restored = await f.host.command("ui.read", { sessionId: f.s.id });
  assert.equal(restored.document.data.note, "保留原始金额");
  assert.equal(restored.presentation.revision, presentationRevision, 'draft saves and reopening do not start a new presentation');
  assert.equal(
    restored.presentation.presented_at,
    state.presentation.presented_at,
  );
});
test('historical presentation metadata gains a stable identity without rewriting the page', async (t) => {
  const f = await setup(t);
  const document = { format: 'openui', title: '核对', program: 'root = Text("原始内容")', data: {} };
  const before = await f.host.ui.call(f.s.id, { operation: 'present', revision: 1, document });
  f.host.db.exec('ALTER TABLE ui_presentation DROP COLUMN revision');
  await f.reopen();
  const restored = f.host.ui.read(f.s.id);
  assert.equal(restored.presentation.revision, 0);
  assert.equal(restored.presentation.presented_at, before.presentation.presented_at);
  assert.equal(restored.revision, before.revision);
  assert.deepEqual(restored.document, before.document);
  const next = await f.host.ui.call(f.s.id, { operation: 'present', revision: restored.revision, document });
  assert.equal(next.presentation.revision, next.revision);
  assert.ok(next.presentation.revision > restored.presentation.revision);
});
test("composer attachments reach the selected Agent, preserve the original, and can be removed without deleting files", async (t) => {
  const f = await setup(t);
  await writeFile(join(f.projectPath, "订单.csv"), "名称,金额\n样本,174.50");
  await f.host.command("ui.attach", { sessionId: f.s.id, paths: ["订单.csv"] });
  const prompt = await f.host.ui.prepare(f.s.id, "请整理");
  assert.match(prompt, /订单.csv/);
  assert.match(prompt, /turnsu_ui present/);
  await writeFile(join(f.projectPath, "订单.csv"), "updated");
  await assert.rejects(f.host.ui.prepare(f.s.id, "请整理"), /已改变/);
  await f.host.command("ui.detach", { sessionId: f.s.id, path: "订单.csv" });
  assert.deepEqual(
    (await f.host.command("ui.read", { sessionId: f.s.id })).assets,
    [],
  );
  assert.equal(
    await readFile(join(f.projectPath, "订单.csv"), "utf8"),
    "updated",
  );
});


test("stored legacy pages migrate once without changing drafts, revisions or confirmation receipts", async (t) => {
  const f = await setup(t);
  await f.host.command("ui.read", { sessionId: f.s.id });
  const document = { title: "迁移核对", data: { note: "用户尚未提交的草稿", rows: [{ id: "a", amount: "174.50", note: "待核对" }] }, tree: { id: "root", type: "Layout", children: [
    { id: "note", type: "Field", binding: "note", label: "用途" },
    { id: "rows", type: "DataView", binding: "rows", columns: [{ key: "amount", label: "金额" }, { key: "note", label: "备注", editable: true }] },
    { id: "send", type: "Action", action: "submit", label: "确认" },
  ] } };
  f.host.db.prepare("UPDATE ui_surfaces SET document=?,revision=7,dirty=1 WHERE session_id=?").run(JSON.stringify(document), f.s.id);
  const receipt = JSON.stringify({ values: { note: "此前确认的内容" }, revision: 3 });
  f.host.db.prepare("INSERT INTO ui_events(id,session_id,payload,state,created_at) VALUES(?,?,?,'consumed',1)").run("old-receipt", f.s.id, receipt);
  const state = f.host.ui.read(f.s.id);
  assert.equal(state.document.format, "openui");
  assert.equal(state.document.tree, undefined);
  assert.match(state.document.program, /ReviewTable/);
  assert.equal(state.revision, 7);
  assert.equal(state.dirty, true);
  assert.deepEqual(state.document.data, document.data);
  assert.throws(() => f.host.ui.save({ sessionId: f.s.id, revision: 7, values: { rows: [{ id: "a", amount: "1.00", note: "待核对" }] } }), /可编辑/);
  f.host.ui.save({ sessionId: f.s.id, revision: 7, values: { note: "迁移后继续编辑" } });
  await f.reopen();
  const restored = f.host.ui.read(f.s.id);
  assert.equal(restored.document.data.note, "迁移后继续编辑");
  assert.equal(restored.revision, 8);
  assert.equal(f.host.db.prepare("SELECT payload FROM ui_events WHERE id='old-receipt'").get().payload, receipt);
  assert.equal(JSON.parse(f.host.db.prepare("SELECT document FROM ui_surfaces WHERE session_id=?").get(f.s.id).document).tree, undefined);
});


test("large historical option lists stay editable after representation migration", () => {
  for (const text of ["a".repeat(230), '"'.repeat(150)]) {
    const options = Array.from({ length: 90 }, (_, i) => String(i) + text);
    const tree = { id: "root", type: "Layout", children: Array.from({ length: 4 }, (_, i) => ({ id: "f" + i, type: "Field", binding: "f" + i, variant: "select", options })) };
    const source = { title: "历史选项", tree, data: { f0: options[0] } };
    assert.ok(JSON.stringify(source).length < 120_000);
    const migrated = validateSurface(source);
    assert.ok(JSON.stringify(migrated).length > 120_000);
    migrated.data.f0 = options[1];
    assert.equal(validateSurface(migrated, { stored: true }).data.f0, options[1]);
    assert.throws(() => validateSurface(migrated), /120|Unrecognized/);
  }
});

test('OpenUI keeps reactive values across restart and fixes one human action before native continuation', async t => {
  const f = await setup(t);
  const program = 'root = Col([Input($copies,"份数","number"),Text(@Format(174.5*$copies,"number",2)),Button("确认",@ToAssistant("生成报告",{copies:$copies}))])\n$copies = 2';
  await f.host.ui.call(f.s.id, { operation: 'present', revision: 1, document: { format: 'openui', title: '订单核对', program, data: { $copies: 2, amount: '174.50' } } });
  assert.deepEqual(await f.host.ui.media({ sessionId: f.s.id, kind: 'task-data', name: 'amount' }), { value: '174.50' });
  await assert.rejects(() => f.host.ui.media({ sessionId: f.s.id, kind: 'task-data', name: 'Imported/订单.csv' }), /页面缺少/);
  let state = f.host.ui.read(f.s.id);
  f.host.ui.save({ sessionId: f.s.id, revision: state.revision, values: { $copies: 4 } });
  await f.reopen();
  state = f.host.ui.read(f.s.id);
  assert.equal(state.document.data.$copies, 4);
  assert.equal(state.document.data.amount, '174.50');
  assert.equal(state.events.length, 0);
  const action = { type: 'to-assistant', message: '生成报告', context: { copies: 4, total: 698 } };
  await f.host.ui.commit({ sessionId: f.s.id, revision: state.revision, requestId: 'native-openui-confirm', action });
  await f.host.ui.commit({ sessionId: f.s.id, revision: state.revision, requestId: 'native-openui-confirm', action });
  assert.equal(f.host.ui.read(f.s.id).events.length, 1);
  const confirmation = await f.host.ui.call(f.s.id, { operation: 'wait' });
  assert.equal(confirmation.values.$copies, 4);
  assert.deepEqual(confirmation.action, action);
  assert.equal(f.turns, 0, 'the waiting original Agent receives the event without creating another task');
  state = f.host.ui.read(f.s.id);
  await f.host.ui.call(f.s.id, { operation: 'present', revision: state.revision, document: { format: 'openui', title: '生成中', program, data: { $copies: 7 }, streaming: true } });
  await assert.rejects(() => f.host.ui.commit({ sessionId: f.s.id, revision: f.host.ui.read(f.s.id).revision, requestId: 'streaming-confirm', action }), /仍在生成/);
});
