import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentHost } from "../host.mjs";

// Only the provider boundary is controlled. Public host commands, SQLite, filesystem,
// request receipts and reopening all use their real implementation.
async function fixture(t, override) {
  const root = await mkdtemp(join(tmpdir(), "turnsu-local-test-"));
  const directory = join(root, "state"), projectPath = join(root, "project"); await mkdir(projectPath);
  let hooks, sends = 0, responses = [], requests = [];
  const connectionFactory = (options) => {
    hooks = options;
    return { ready: Promise.resolve(), closed: false,
      request: async (method, params) => {
        requests.push({ method, params });
        if (override) { const result = await override(method, params); if (result !== undefined) return result; }
        if (method === "model/list") return { data: [{ model: "available-model", displayName: "Available model" }], nextCursor: null };
        if (method === "thread/start" || method === "thread/resume") return { thread: { id: "native-1", turns: [] } };
        if (method === "turn/start") { sends++; hooks.onEvent({ method: "turn/started", params: { threadId: "native-1", turn: { id: "turn-1" } } }); return { turn: { id: "turn-1" } }; }
        if (method === "turn/interrupt") { hooks.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "interrupted" } } }); return {}; }
        throw new Error("unexpected provider method");
      }, respond: (...args) => responses.push(args), reject: () => {}, close: async () => {},
    };
  };
  let host = new LocalAgentHost({ directory, connectionFactory });
  const project = await host.command("project.open", { path: projectPath });
  const session = await host.command("session.create", { projectId: project.id, agent: "codex" });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { project, session, projectPath, root, get host() { return host; }, get sends() { return sends; }, get requests() { return requests; }, get responses() { return responses; }, get hooks() { return hooks; }, async reopen() { await host.close(); host = new LocalAgentHost({ directory, connectionFactory }); } };
}

test('project synchronization access denial also persists across offline team conversations and host restart', async t => {
  const f = await fixture(t), host = f.host;
  host.db.prepare("INSERT INTO shared_projects(project_id,remote_id,identity,title,device,inode,paused) VALUES(?,?,?,'project',1,1,1)").run(f.project.id, 'remote', '{}');
  host.db.prepare("INSERT INTO shared_work_sessions(session_id,work_item_id,identity,context,actor_user_id,access_state) VALUES(?,?,'{}',?,'member','offline')").run(f.session.id, 'work', JSON.stringify({ fetchedAt: '2026-09-23T00:00:00.000Z' }));
  assert.equal(host.teamWork().state(f.session.id).canContinueOffline, true);
  host.shared.change(f.project.id, 'access', '项目权限已撤销');
  assert.equal(host.work.state(f.session.id).canContinueOffline, false);
  host.shared.change(f.project.id, 'offline', '随后发生网络错误');
  await f.reopen();
  assert.equal(f.host.work.state(f.session.id).canContinueOffline, false);
  assert.equal(f.sends, 0);
});

test("a local project and draft survive closing without any cloud or provider", async (t) => {
  const f = await fixture(t);
  await f.host.command("draft.save", { projectId: f.project.id, text: "请整理这个项目的反馈" });
  await f.reopen();
  assert.equal((await f.host.command("workspace.read", { projectId: f.project.id })).projects[0].path, f.project.path);
  assert.equal((await f.host.command("draft.read", { projectId: f.project.id })).text, "请整理这个项目的反馈");
  assert.equal(f.sends, 0);
});

test("renaming a conversation persists without changing its native session or draft", async (t) => {
  const f = await fixture(t);
  const before = (await f.host.command("session.read", { sessionId: f.session.id })).updated_at;
  await f.host.command("draft.save", { projectId: f.project.id, sessionId: f.session.id, text: "尚未发送的内容" });
  await assert.rejects(f.host.command("session.rename", { sessionId: f.session.id, title: "   " }), /内容为空/);
  await assert.rejects(f.host.command("session.rename", { sessionId: f.session.id, title: "a".repeat(81) }), /长度限制/);
  await f.host.command("session.rename", { sessionId: f.session.id, title: "  周报\n整理  " });
  await f.reopen();
  const renamed = await f.host.command("session.read", { sessionId: f.session.id });
  assert.equal(renamed.title, "周报 整理");
  assert.equal(renamed.updated_at, before);
  assert.equal((await f.host.command("workspace.read", { projectId: f.project.id })).sessions.find(s => s.id === f.session.id).title, "周报 整理");
  assert.equal((await f.host.command("draft.read", { projectId: f.project.id, sessionId: f.session.id })).text, "尚未发送的内容");
  assert.equal(f.sends, 0);
});

test("retrying a submitted prompt never starts a second native turn, including after restart", async (t) => {
  const f = await fixture(t);
  const args = { sessionId: f.session.id, inputId: "input-1", text: "生成结果" };
  await f.host.command("session.send", args); await f.host.command("session.send", args);
  assert.equal(f.sends, 1);
  await assert.rejects(f.host.command("session.send", { ...args, text: "另一项工作" }), /不同内容/);
  await f.reopen();
  const restored = await f.host.command("session.read", { sessionId: f.session.id });
  assert.equal(restored.status, "interrupted"); assert.equal(restored.messages[0].text, "生成结果");
  await f.host.command("session.send", args); assert.equal(f.sends, 1);
  await assert.rejects(f.host.command("session.send", { ...args, inputId: "input-2" }), /先恢复会话/);
});

test("approval binds to the exact live request and stop preserves a recoverable conversation", async (t) => {
  const f = await fixture(t);
  await f.host.command("session.send", { sessionId: f.session.id, inputId: "input-1", text: "更新文档" });
  f.hooks.onRequest({ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "native-1", command: "example" } });
  const waiting = await f.host.command("session.read", { sessionId: f.session.id });
  assert.equal(waiting.status, "waiting"); assert.equal(waiting.interactions.length, 1); assert.equal(waiting.interactions[0].nativeId, undefined);
  const id = waiting.interactions[0].id;
  await assert.rejects(f.host.command("interaction.respond", { id, sessionId: "another", decision: "accept" }));
  await f.host.command("interaction.respond", { id, sessionId: f.session.id, decision: "decline" });
  assert.deepEqual(f.responses, [[77, { decision: "decline" }]]);
  await assert.rejects(f.host.command("interaction.respond", { id, sessionId: f.session.id, decision: "accept" }));
  await f.host.command("session.stop", { sessionId: f.session.id });
  assert.equal((await f.host.command("session.read", { sessionId: f.session.id })).status, "interrupted");
});

test("project file preview reads the real artifact and rejects paths escaping the project", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.projectPath, "result.md"), "# 完成的结果\n\n来源：本机资料。");
  await writeFile(join(f.root, "private.txt"), "outside");
  await symlink(join(f.root, "private.txt"), join(f.projectPath, "escape"));
  const listed = await f.host.command("files.list", { projectId: f.project.id });
  assert.ok(listed.entries.some((e) => e.name === "result.md")); assert.ok(!listed.entries.some((e) => e.name === "escape"));
  assert.match((await f.host.command("files.read", { projectId: f.project.id, path: "result.md" })).text, /来源：本机资料/);
  for (const path of ["../private.txt", "escape", join(f.root, "private.txt")]) await assert.rejects(f.host.command("files.read", { projectId: f.project.id, path }), /当前项目/);
});


test("choosing an available model survives reopening and reaches the next native turn", async (t) => {
  const f = await fixture(t);
  await f.host.command("models.list");
  await assert.rejects(f.host.command("session.model", { sessionId: f.session.id, model: "unavailable" }));
  await f.host.command("session.model", { sessionId: f.session.id, model: "available-model" });
  await f.reopen();
  assert.equal((await f.host.command("session.read", { sessionId: f.session.id })).model, "available-model");
  await f.host.command("session.send", { sessionId: f.session.id, inputId: "with-model", text: "Create result" });
  assert.equal(f.requests.find((r) => r.method === "turn/start").params.model, "available-model");
  await assert.rejects(f.host.command("session.model", { sessionId: f.session.id, model: null }), /等待当前任务/);
});


test("drafts remain with their own task instead of leaking into another conversation", async (t) => {
  const f = await fixture(t);
  const second = await f.host.command("session.create", { projectId: f.project.id, agent: "codex" });
  const args = { projectId: f.project.id, sessionId: f.session.id };
  await f.host.command("draft.save", { ...args, text: "Only for this task" });
  await f.reopen();
  assert.equal((await f.host.command("draft.read", args)).text, "Only for this task");
  assert.equal((await f.host.command("draft.read", { projectId: f.project.id, sessionId: second.id })).text, "");
  assert.equal((await f.host.command("draft.read", { projectId: f.project.id })).text, "");
});

test("a Codex disconnect leaves other Agents' pending interactions intact", async (t) => {
  const f = await fixture(t);
  await f.host.command("session.send", { sessionId: f.session.id, inputId: "codex-disconnect", text: "Start" });
  f.hooks.onRequest({ id: 91, method: "item/commandExecution/requestApproval", params: { threadId: "native-1", command: "example" } });
  const claude = await f.host.command("session.create", { projectId: f.project.id, agent: "claude" });
  f.host.onClaudeEvent(claude.id, { type: "permission", id: "claude-pending", tool: "Read", input: { file_path: "result.md" }, title: "Read result" });
  f.hooks.onExit();
  assert.equal((await f.host.command("session.read", { sessionId: f.session.id })).interactions.length, 0);
  const state = await f.host.command("session.read", { sessionId: claude.id });
  assert.equal(state.status, "waiting"); assert.equal(state.interactions[0].id, "claude-pending");
});


test("a rejected send keeps a failed receipt and a fresh user retry can run", async (t) => {
  let rejected = false;
  const f = await fixture(t, method => {
    if (method === 'turn/start' && !rejected) { rejected = true; throw Object.assign(new Error('model unavailable'), { rejected: true }); }
  });
  const args = { sessionId: f.session.id, inputId: 'rejected-input', text: 'Generate the result' };
  await f.host.command('draft.save', { projectId: f.project.id, sessionId: f.session.id, text: args.text });
  await assert.rejects(f.host.command('session.send', args), /model unavailable/);
  await f.reopen();
  const failed = await f.host.command('session.read', { sessionId: f.session.id });
  assert.equal(failed.lastSubmission.id, args.inputId); assert.equal(failed.lastSubmission.status, 'failed');
  await assert.rejects(f.host.command('session.send', args), /输入仍保留/);
  assert.equal((await f.host.command('draft.read', { projectId: f.project.id, sessionId: f.session.id })).text, args.text);
  await f.host.command('session.send', { ...args, inputId: 'explicit-fresh-retry' });
  assert.equal(f.sends, 1);
});

test("an uncertain provider receipt is not returned as a successful resend", async (t) => {
  let attempts = 0;
  const f = await fixture(t, method => {
    if (method === 'turn/start') { attempts++; throw new Error('connection lost after dispatch'); }
  });
  const args = { sessionId: f.session.id, inputId: 'uncertain-input', text: 'Generate the result' };
  await assert.rejects(f.host.command('session.send', args), /connection lost/);
  await assert.rejects(f.host.command('session.send', args), /尚未确认/);
  assert.equal(attempts, 1);
  assert.equal((await f.host.command('session.read', { sessionId: f.session.id })).lastSubmission.status, 'unknown');
});
