import assert from "node:assert/strict";
import test from "node:test";

import {
  LARK_TOOL_POLICIES,
  LarkToolAdapter,
  createLarkProfileResolver,
  getLarkToolOutputSchema,
} from "../../src/tools/index.mjs";

function adapter({ execute, profile = "workbench-user-a" } = {}) {
  return new LarkToolAdapter({
    binaryPath: process.execPath,
    profileResolver: async () => profile,
    execFile: execute ?? (async () => ({ stdout: '{"ok":true}', stderr: "" })),
    clock: () => "2026-07-24T00:00:00.000Z",
  });
}

test("Lark Tool Adapter rejects undeclared actions and arguments before spawning", async () => {
  let calls = 0;
  const subject = adapter({ execute: async () => { calls += 1; } });
  await assert.rejects(
    () => subject.execute({
      action: "lark.im.send_message",
      skillName: "lark-calendar",
      userId: "user-a",
      arguments: { chatId: "oc_a", text: "hello" },
      confirmed: true,
      effectId: "effect-12345678",
    }),
    { code: "lark_tool_not_allowed" },
  );
  await assert.rejects(
    () => subject.execute({
      action: "lark.calendar.agenda",
      skillName: "lark-calendar",
      userId: "user-a",
      arguments: { shell: "touch /tmp/owned" },
    }),
    { code: "lark_tool_argument_forbidden" },
  );
  assert.equal(calls, 0);
});

test("write actions stop at confirmation and receive a stable idempotency key after approval", async () => {
  const calls = [];
  const subject = adapter({
    execute: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: '{"message_id":"om_1"}', stderr: "" };
    },
  });
  const request = {
    action: "lark.im.send_message",
    skillName: "lark-im",
    userId: "user-a",
    arguments: { chatId: "oc_team", text: "Daily digest" },
    effectId: "effect-run-1-node-4",
  };
  assert.equal((await subject.execute(request)).status, "confirmation_required");
  assert.equal(calls.length, 0);

  const result = await subject.execute({ ...request, confirmed: true });
  assert.equal(result.status, "succeeded");
  assert.equal(result.receipt.effect, "write");
  assert.deepEqual(result.output, { message_id: "om_1" });
  assert.deepEqual(result.externalRef, {
    provider: "lark",
    resourceType: "message",
    id: "om_1",
    containerId: "oc_team",
  });
  assert.deepEqual(result.receipt.externalRef, result.externalRef);
  assert.deepEqual(subject.effectCapabilities(request.action), {
    idempotency: "provider_key",
    reconcile: "none",
    cancel: "transport_only",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, process.execPath);
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].args.includes("--idempotency-key"), true);
  assert.equal(calls[0].args.at(-1), request.effectId);
  assert.equal("WORKBENCH_POSTGRES_URL" in calls[0].options.env, false);
});

test("write action capabilities are declared per action and never imply unavailable reconciliation", async () => {
  const subject = adapter({
    execute: async (_file, args) => ({
      stdout: args.includes("calendar") ? '{"event_id":"event_1"}' : '{"task_id":"task_1"}',
      stderr: "",
    }),
  });
  assert.deepEqual(subject.effectCapabilities("lark.calendar.create"), {
    idempotency: "none",
    reconcile: "none",
    cancel: "transport_only",
  });
  const calendar = await subject.execute({
    action: "lark.calendar.create",
    skillName: "lark-calendar",
    userId: "user-a",
    confirmed: true,
    effectId: "effect-calendar-1",
    arguments: {
      summary: "Standup",
      start: "2026-08-01T09:00:00Z",
      end: "2026-08-01T09:30:00Z",
      calendarId: "cal_team",
    },
  });
  assert.equal(calendar.externalRef.resourceType, "calendar_event");
  assert.equal(calendar.externalRef.id, "event_1");
  assert.equal(calendar.externalRef.containerId, "cal_team");
});

test("a write whose output omits its product identifier fails closed", async () => {
  const subject = adapter({ execute: async () => ({ stdout: '{"ok":true}', stderr: "" }) });
  await assert.rejects(() => subject.execute({
    action: "lark.task.create",
    skillName: "lark-task",
    userId: "user-a",
    confirmed: true,
    effectId: "effect-task-no-ref",
    arguments: { summary: "Missing reference" },
  }), { code: "lark_tool_output_invalid" });
});

test("an injected query Driver rejects credential-bearing reconciliation evidence", async () => {
  const subject = new LarkToolAdapter({
    binaryPath: process.execPath,
    profileResolver: async () => "workbench-user-a",
    execFile: async () => ({ stdout: '{"task_id":"task_1"}', stderr: "" }),
    effectReconciler: async ({ effectId }) => ({
      outcome: "succeeded",
      output: { task_id: "task_reconciled", access_token: "drop-me" },
      externalRef: { provider: "lark", resourceType: "task", id: "task_reconciled" },
      receipt: { receiptId: `lark-effect:${effectId}` },
    }),
    effectCanceller: async () => ({ outcome: "not_applied" }),
  });
  assert.equal(subject.effectCapabilities("lark.task.create").reconcile, "query");
  assert.equal(subject.effectCapabilities("lark.task.create").cancel, "cooperative");
  await assert.rejects(() => subject.reconcileEffect({
      action: "lark.task.create",
      effectId: "effect-task-reconcile",
      profile: "workbench-user-a",
    }),
    { code: "lark_tool_output_forbidden" },
  );
  assert.deepEqual(await subject.cancelEffect({
    action: "lark.task.create",
    effectId: "effect-task-reconcile",
    profile: "workbench-user-a",
    reason: "Stop if not applied",
  }), { outcome: "not_applied" });
});

test("argument values remain one argv item and cannot become shell syntax", async () => {
  const calls = [];
  const subject = adapter({
    execute: async (_file, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify([{
          event_id: "event_1",
          summary: "plain output",
          start_time: { datetime: "2026-08-01T09:00:00Z" },
          end_time: { datetime: "2026-08-01T09:30:00Z" },
        }]),
        stderr: "",
      };
    },
  });
  const injected = "today; touch /tmp/owned && echo pwned";
  const result = await subject.execute({
    action: "lark.calendar.agenda",
    skillName: "lark-calendar",
    userId: "user-a",
    arguments: { start: injected },
  });
  assert.equal(result.output[0].summary, "plain output");
  assert.equal(calls[0][calls[0].indexOf("--start") + 1], injected);
  assert.equal(calls[0].filter((value) => value === injected).length, 1);
});

test("member identities map to separate deterministic Lark CLI profiles", async () => {
  const resolve = createLarkProfileResolver();
  const a = await resolve({ userId: "user-a" });
  const b = await resolve({ userId: "user-b" });
  assert.match(a, /^workbench-[a-f0-9]{20}$/);
  assert.notEqual(a, b);
});

test("untrusted Lark output fails closed on credentials nested below unprojected fields", async () => {
  const subject = adapter({
    execute: async () => ({
      stdout: JSON.stringify({
        ok: true,
        identity: "user",
        data: [{
          event_id: "event_1",
          summary: "Safe title",
          start_time: { datetime: "2026-08-01T09:00:00Z" },
          end_time: { datetime: "2026-08-01T09:30:00Z" },
          debug: [{ provider: { refreshToken: "refresh-secret" } }],
        }],
        meta: { count: 1 },
      }),
      stderr: "",
    }),
  });
  await assert.rejects(() => subject.execute({
      action: "lark.calendar.agenda",
      skillName: "lark-calendar",
      userId: "user-a",
      arguments: {},
    }),
    { code: "lark_tool_output_forbidden" },
  );
});

test("official CLI envelopes are projected to the action product schema", async () => {
  const subject = adapter({
    execute: async () => ({
      stdout: JSON.stringify({
        ok: true,
        identity: "user",
        data: {
          message_id: "om_1",
          chat_id: "oc_team",
          create_time: "2026-08-01T09:00:00Z",
          upstream_debug_id: "debug-provider-only",
        },
        meta: { count: 1, request_id: "provider-request" },
      }),
      stderr: "",
    }),
  });
  const result = await subject.execute({
    action: "lark.im.send_message",
    skillName: "lark-im",
    userId: "user-a",
    arguments: { chatId: "oc_team", text: "hello" },
    confirmed: true,
    effectId: "effect-message-envelope",
  });

  assert.deepEqual(result.output, {
    message_id: "om_1",
    chat_id: "oc_team",
    create_time: "2026-08-01T09:00:00Z",
  });
  assert.equal(JSON.stringify(result).includes("provider-request"), false);
  assert.equal(JSON.stringify(result).includes("debug-provider-only"), false);
});

test("every registered Lark action has a product output schema", () => {
  for (const policy of LARK_TOOL_POLICIES) {
    assert.ok(getLarkToolOutputSchema(policy.action), policy.action);
  }
});

test("non-JSON CLI output fails closed instead of becoming model text", async () => {
  const subject = adapter({ execute: async () => ({ stdout: "plain provider output", stderr: "" }) });
  await assert.rejects(() => subject.execute({
    action: "lark.calendar.agenda",
    skillName: "lark-calendar",
    userId: "user-a",
    arguments: {},
  }), { code: "lark_tool_output_invalid" });
});

test("nested host paths, secret-like text, deep structures, and overlong fields fail closed", async (t) => {
  const agenda = (event) => JSON.stringify([{
    event_id: "event_1",
    start_time: { datetime: "2026-08-01T09:00:00Z" },
    end_time: { datetime: "2026-08-01T09:30:00Z" },
    ...event,
  }]);
  const request = {
    action: "lark.calendar.agenda",
    skillName: "lark-calendar",
    userId: "user-a",
    arguments: {},
  };
  const cases = [
    {
      name: "host path in array",
      stdout: agenda({ debug: [{ note: "generated at /Users/alice/private/report.json" }] }),
      code: "lark_tool_output_forbidden",
    },
    {
      name: "credential text under an allowed field",
      stdout: agenda({ description: "authorization: provider-secret-value" }),
      code: "lark_tool_output_forbidden",
    },
    {
      name: "overlong product text",
      stdout: agenda({ summary: "x".repeat(1_001) }),
      code: "lark_tool_output_limit_exceeded",
    },
    {
      name: "excessive nesting in unprojected provider data",
      stdout: agenda({ debug: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: "too deep" } } } } } } } } } } }),
      code: "lark_tool_output_limit_exceeded",
    },
    {
      name: "too many array items",
      stdout: JSON.stringify(Array.from({ length: 501 }, (_, index) => ({
        event_id: `event_${index}`,
        start_time: { datetime: "2026-08-01T09:00:00Z" },
        end_time: { datetime: "2026-08-01T09:30:00Z" },
      }))),
      code: "lark_tool_output_limit_exceeded",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const subject = adapter({ execute: async () => ({ stdout: entry.stdout, stderr: "" }) });
      await assert.rejects(() => subject.execute(request), { code: entry.code });
    });
  }
});
