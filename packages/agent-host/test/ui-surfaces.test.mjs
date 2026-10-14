import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentHost } from "../host.mjs";
import { validateSurface } from "../ui-contract.mjs";
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
  assert.deepEqual(state.document.tree.children, []);
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
  state = await f.host.command("ui.save", {
    sessionId: f.s.id,
    revision: state.revision,
    values: { note: "保留原始金额" },
  });
  await f.reopen();
  const restored = await f.host.command("ui.read", { sessionId: f.s.id });
  assert.equal(restored.document.data.note, "保留原始金额");
  assert.equal(
    restored.presentation.presented_at,
    state.presentation.presented_at,
  );
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
