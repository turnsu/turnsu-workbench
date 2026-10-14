import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { LocalAgentHost } from "../host.mjs";

test("real MCP transport retains component schema, errors, structured results and session ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "turnsu-ui-mcp-"));
  await mkdir(join(root, "project"));
  const host = new LocalAgentHost({ directory: join(root, "state") });
  const p = await host.command("project.open", { path: join(root, "project") });
  const s = await host.command("session.create", {
    projectId: p.id,
    agent: "codex",
  });
  const connection = await host.toolBroker.connection(s.id);
  host.updateSession(s.id, "running");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../tool-mcp.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        TURNSU_TOOL_CONNECTION: JSON.stringify(connection),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stderr.resume();
  let sequence = 0;
  const pending = new Map();
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result);
    }
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("MCP timeout"));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  t.after(async () => {
    reader.close();
    child.stdin.end();
    await new Promise((r) => child.once("exit", r));
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.ok((await rpc("initialize")).capabilities.resources);
  const ui = (await rpc("tools/list")).tools.find(
    (tool) => tool.name === "turnsu_ui",
  );
  assert.equal(ui._meta.ui.resourceUri, "ui://turnsu/intelligence.html");
  assert.ok(ui.inputSchema.properties.document);
  let state = (
    await rpc("tools/call", {
      name: "turnsu_ui",
      arguments: { operation: "read" },
    })
  ).structuredContent;
  assert.equal(state.sessionId, s.id);
  const invalid = await rpc("tools/call", {
    name: "turnsu_ui",
    arguments: {
      operation: "present",
      revision: state.revision,
      document: { type: "Layout" },
    },
  });
  assert.equal(invalid.isError, true);
  assert.ok(invalid.content[0].text);
  const document = {
    title: "通用 UI",
    tree: {
      id: "root",
      type: "Layout",
      children: [
        { id: "amount", type: "Field", binding: "amount", label: "金额" },
      ],
    },
    data: { amount: "" },
  };
  const result = await rpc("tools/call", {
    name: "turnsu_ui",
    arguments: { operation: "present", revision: state.revision, document },
  });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.document.title, "通用 UI");
  assert.equal(
    (await rpc("resources/list")).resources[0].mimeType,
    "text/html;profile=mcp-app",
  );
  await assert.rejects(
    rpc("resources/read", { uri: "file:///etc/passwd" }),
    /未注册/,
  );
  state = host.ui.save({
    sessionId: s.id,
    revision: result.structuredContent.revision,
    values: { amount: "174.50" },
  });
  const wait = rpc("tools/call", {
    name: "turnsu_ui",
    arguments: { operation: "wait" },
  });
  await host.ui.commit({
    sessionId: s.id,
    revision: state.revision,
    requestId: "mcp-human-input",
  });
  assert.equal((await wait).structuredContent.values.amount, "174.50");
});

test("native MCP approval waits for an explicit decision and never persists permission by default", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "turnsu-mcp-approval-"));
  await mkdir(join(root, "project"));
  const responses = [],
    connection = {
      ready: Promise.resolve(),
      close: async () => {},
      respond: (id, result) => responses.push({ id, result }),
      reject: (id) => responses.push({ id, rejected: true }),
    };
  const host = new LocalAgentHost({
    directory: join(root, "state"),
    connectionFactory: () => connection,
  });
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  const p = await host.command("project.open", { path: join(root, "project") }),
    s = await host.command("session.create", {
      projectId: p.id,
      agent: "codex",
    });
  host.db
    .prepare("UPDATE sessions SET native_id=?,status=? WHERE id=?")
    .run("native-approval", "running", s.id);
  const params = {
    threadId: "native-approval",
    serverName: "turnsu",
    mode: "form",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
      tool_params: { operation: "create", output: "报告.xlsx" },
    },
    requestedSchema: { type: "object", properties: {} },
  };
  host.onRequest(
    { id: 1, method: "mcpServer/elicitation/request", params },
    connection,
  );
  assert.equal(responses.length, 0);
  assert.equal(host.session(s.id).status, "waiting");
  let item = (await host.command("session.read", { sessionId: s.id }))
    .interactions[0];
  assert.match(item.command, /报告.xlsx/);
  await host.command("interaction.respond", {
    sessionId: s.id,
    id: item.id,
    decision: "decline",
  });
  assert.deepEqual(responses[0], {
    id: 1,
    result: { action: "decline", content: null },
  });
  host.onRequest(
    { id: 2, method: "mcpServer/elicitation/request", params },
    connection,
  );
  item = (await host.command("session.read", { sessionId: s.id }))
    .interactions[0];
  await host.command("interaction.respond", {
    sessionId: s.id,
    id: item.id,
    decision: "accept",
  });
  assert.deepEqual(responses[1], {
    id: 2,
    result: { action: "accept", content: {} },
  });
  host.onRequest(
    {
      id: 3,
      method: "mcpServer/elicitation/request",
      params: { ...params, _meta: { ...params._meta, persist: undefined } },
    },
    connection,
  );
  item = (await host.command("session.read", { sessionId: s.id }))
    .interactions[0];
  await assert.rejects(
    host.command("interaction.respond", {
      sessionId: s.id,
      id: item.id,
      decision: "accept_session",
    }),
    /不支持/,
  );
  host.onEvent({
    method: "serverRequest/resolved",
    params: { threadId: "native-approval", requestId: 3 },
  });
  assert.equal(
    (await host.command("session.read", { sessionId: s.id })).interactions
      .length,
    0,
  );
});
