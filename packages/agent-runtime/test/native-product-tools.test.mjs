import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNativeProductTools, NATIVE_PRODUCT_TOOLS } from "../integrations/native/product-tools.mjs";
import { createProductMcpServer } from "../integrations/native/mcp-server.mjs";
import { createProductPiExtension } from "../integrations/native/pi-extension.mjs";
import { openNativeProductSession, writeNativeProfile, readNativeProfile } from "../integrations/native/session.mjs";

const token = "a".repeat(43);
const list = { schemaVersion: "workbench-api-v1", data: [], page: { hasMore: false, nextCursor: null }, requestId: "native-test-request" };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

test('native Skill trial requires and forwards the exact draft precondition', async () => {
  const requests = [];
  const product = createNativeProductTools({ baseUrl: 'http://127.0.0.1:8798', accessToken: () => token,
    fetch: async (url, options) => { requests.push({ url, options }); throw new Error('controlled transport boundary'); } });
  const input = { pathParams: { skillId: 'skill-one', draftId: 'draft-one' }, idempotencyKey: 'trial-one',
    data: { testCase: { name: 'Trial', purpose: 'Preserve evidence', input: { request: 'Source' }, timeoutSeconds: 60 } } };
  await assert.rejects(product.call('turnsu_test_skill', input), /native_product_tool_input_invalid/);
  assert.equal(requests.length, 0);
  await assert.rejects(product.call('turnsu_test_skill', { ...input, ifMatch: '"draft-one-1"' }), { code: 'product_client_transport_failed' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.get('If-Match'), '"draft-one-1"');
  assert.equal(requests[0].options.headers.get('Idempotency-Key'), 'trial-one');
  assert.deepEqual(JSON.parse(requests[0].options.body).data, input.data);
});

test("MCP negotiates the real protocol and calls the canonical Product contract with native authentication", async (t) => {
  const requests = [];
  const product = createNativeProductTools({ baseUrl: "http://127.0.0.1:8798", accessToken: () => token,
    fetch: async (url, options) => { requests.push({ url, options }); return response(list); } });
  const server = createProductMcpServer(product);
  const client = new Client({ name: "protocol-acceptance", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const inventory = await client.listTools();
  assert.equal(inventory.tools.length, NATIVE_PRODUCT_TOOLS.length);
  assert.equal(inventory.tools.find((tool) => tool.name === "turnsu_run_loop").annotations.readOnlyHint, false);
  const result = await client.callTool({ name: "turnsu_work_results", arguments: { pathParams: { workItemId: "work-item-team" } } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), list);
  assert.equal(requests[0].options.headers.get("Authorization"), `Bearer ${token}`);
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.redirect, "error");
  assert.match(requests[0].url, /work-items\/work-item-team\/loop-runs$/u);
  const rejected = await client.callTool({ name: "turnsu_run_loop", arguments: { pathParams: { workItemId: "work-item-team" }, data: { shareFinalOutput: false }, idempotencyKey: "invalid" } });
  assert.equal(rejected.isError, true);
  assert.equal(requests.length, 1, "invalid share declaration must not reach Product");
});

test("Pi uses the same bounded Product tools, preserves cancellation and never registers a shell or provider tool", async () => {
  const registered = [];
  const calls = [];
  createProductPiExtension({ tools: NATIVE_PRODUCT_TOOLS, call: async (...args) => { calls.push(args); return list; } })({ registerTool: (tool) => registered.push(tool) });
  assert.deepEqual(registered.map((tool) => tool.name), NATIVE_PRODUCT_TOOLS.map((tool) => tool.name));
  const controller = new AbortController();
  await registered[0].execute("call-id", {}, controller.signal);
  assert.equal(calls[0][2].signal, controller.signal);
});

test("native credential profile is private, single-owner and refresh uncertainty cannot replay a token", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "turnsu-native-session-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "session.json");
  const profile = { baseUrl: "http://127.0.0.1:8798", tokens: { accessToken: token, refreshToken: "b".repeat(43),
    accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(), refreshTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(), clientSessionId: "native-test", workspaceId: "workspace-test" } };
  await writeNativeProfile(path, profile, { create: true });
  let exchanges = 0;
  const session = await openNativeProductSession(path, { fetch: async () => { exchanges += 1; throw new Error("lost response"); } });
  await assert.rejects(openNativeProductSession(path), /native_session_in_use/u);
  await assert.rejects(session.product.call("turnsu_projects", {}), { code: "product_client_transport_failed" });
  await assert.rejects(session.product.call("turnsu_projects", {}), /refresh_uncertain/u);
  assert.equal(exchanges, 1);
  assert.equal(JSON.parse(await readFile(path, "utf8")).refreshPending, true);
  await session.release();
  await chmod(path, 0o644);
  await assert.rejects(readNativeProfile(path), /private_file_required/u);
  assert.throws(() => createNativeProductTools({ baseUrl: "http://remote.example", accessToken: () => token }), /origin_invalid/u);
});
