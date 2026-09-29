import assert from "node:assert/strict";
import test from "node:test";

import {
  createExecutionGrant,
  createMinimalAgentKernel,
} from "../../agent-kernel/src/index.mjs";
import {
  MemorySessionPort,
  createScriptedAgentLoop,
} from "../../agent-testkit/src/index.mjs";
import {
  FIRST_PARTY_SERVICE_TOKENS,
  MEETING_ACTION_EXECUTION_REF,
  createFirstPartyBusinessPluginRuntime,
  createFirstPartyBusinessPlugins,
} from "../src/index.mjs";

test("first-party plugins install as T2 services in a real Kernel run and leave no service behind", async () => {
  const services = {};
  const loop = createScriptedAgentLoop({
    async onRun({ context, input }) {
      const composer = context.use(FIRST_PARTY_SERVICE_TOKENS.contextComposer);
      const planner = context.use(FIRST_PARTY_SERVICE_TOKENS.planner);
      const workflow = context.use(FIRST_PARTY_SERVICE_TOKENS.workflow);
      const meeting = context.use(FIRST_PARTY_SERVICE_TOKENS.meetingActions);
      const render = context.use(FIRST_PARTY_SERVICE_TOKENS.renderIntents);
      const toolPolicy = context.use(FIRST_PARTY_SERVICE_TOKENS.toolPolicy);
      Object.assign(services, { composer, planner, workflow, meeting, render, toolPolicy });
      const contextPack = await composer.compose({ replay: [], input });
      const plan = await planner.plan({ input, allowedToolIds: [] });
      const workflowPreparation = await workflow.prepare({ plan, maxChildren: 0 });
      const meetingOutput = await meeting.extract({ transcript: "Mia will send the draft. The roadmap is discussed." });
      const intent = render.record({ kind: "agent.summary", payload: { plan, meetingOutput } });
      return (async function* () {
        yield {
          type: "message",
          modelVisible: true,
          payload: {
            role: "assistant",
            text: JSON.stringify({
              contextPack: contextPack.schemaVersion,
              workflow: workflowPreparation.status,
              render: intent.schemaVersion,
            }),
          },
        };
      })();
    },
  });
  const sessionPort = new MemorySessionPort();
  const kernel = createMinimalAgentKernel({
    loop,
    sessionPort,
    profile: {
      id: "first-party-test",
      revision: "1",
      mode: "production_locked",
      plugins: createFirstPartyBusinessPlugins({
        clock: () => "2026-08-14T00:00:00.000Z",
        idFactory: (kind) => `${kind}-test-a`,
      }),
    },
  });
  const session = { sessionId: "first-party-session", branchId: null };
  const events = [];
  for await (const event of kernel.run({
    runId: "first-party-run",
    session,
    executionGrant: createExecutionGrant({
      grantId: "first-party-grant",
      expiresAt: "2035-01-01T00:00:00.000Z",
      allowedToolIds: [],
      allowedEffectClasses: [],
      maxToolCalls: 0,
    }),
    input: { message: "Create a bounded draft." },
  })) events.push(event);

  assert.deepEqual(events.map((event) => event.type), ["message", "run.completed"]);
  assert.equal(sessionPort.read(session).length, 1, "only model-visible content enters Memory SessionPort");
  assert.equal(services.meeting !== undefined, true);
  assert.deepEqual(await services.meeting.extract({ transcript: "TODO: Sam should confirm." }), {
    actionItems: [{ text: "TODO: Sam should confirm." }],
    summary: "1 follow-up action found.",
  });
  assert.equal((await services.render.list()).length, 1);
  assert.deepEqual(services.toolPolicy.check({ toolId: "workflow.uploaded_skill.execute", effectClass: "external_write" }), {
    known: true,
    allowed: false,
    toolId: "workflow.uploaded_skill.execute",
    allowedEffects: ["execute"],
    code: "business_tool_effect_denied",
  });
  await kernel.dispose();
  assert.deepEqual(loop.runs.length, 1);
});

test("business runtime routes Meeting and Uploaded Skill through injected Product ports, not Pi", async () => {
  const calls = [];
  const runtime = createFirstPartyBusinessPluginRuntime({
    uploadedSkillExecutionPort: {
      async probeExecution({ workspaceId }) {
        return workspaceId === "workspace-a" ? { ready: true } : { ready: false };
      },
      async executePublished(request) {
        calls.push(request);
        return { summary: request.input.transcript };
      },
    },
  });
  try {
    assert.deepEqual(await runtime.probe({ executionRef: MEETING_ACTION_EXECUTION_REF }), {
      status: "ready", ready: true, code: "first_party_meeting_ready",
    });
    assert.deepEqual(await runtime.invoke({
      executionRef: MEETING_ACTION_EXECUTION_REF,
      input: { transcript: "Alex will send the report." },
    }), {
      actionItems: [{ text: "Alex will send the report." }],
      summary: "1 follow-up action found.",
    });
    const uploaded = {
      capabilityId: `uploaded-${"a".repeat(48)}`,
      taskIntent: "execute",
      adapterVersion: "1",
      executionMode: "deterministic",
    };
    assert.equal((await runtime.probe({ executionRef: uploaded, workspaceId: "workspace-a" })).ready, true);
    assert.deepEqual(await runtime.invoke({
      workspaceId: "workspace-a",
      executionRef: uploaded,
      input: { transcript: "Approved artifact" },
    }), { summary: "Approved artifact" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].workspaceId, "workspace-a");
  } finally {
    await runtime.dispose();
  }
});
