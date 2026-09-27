import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  VERSION,
  createAgentSession,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import * as subagentApi from "@agwab/pi-subagent/api";
import * as workflowApi from "@agwab/pi-workflow";

test("Pi and AgwaB public compatibility surface is pinned", async (t) => {
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(VERSION, "0.85.1");
  assert.equal(lock.packages["node_modules/@earendil-works/pi-ai"].version, "0.85.1");
  assert.equal(lock.packages["node_modules/@earendil-works/pi-coding-agent"].version, "0.85.1");
  assert.equal(lock.packages["node_modules/@agwab/pi-subagent"].version, "0.4.8");
  assert.equal(lock.packages["node_modules/@agwab/pi-workflow"].version, "0.10.1");
  assert.equal(typeof DefaultResourceLoader, "function");
  assert.equal(typeof ModelRuntime.create, "function");
  assert.equal(typeof SessionManager.inMemory, "function");
  assert.equal(typeof createAgentSession, "function");
  assert.equal(typeof loadSkillsFromDir, "function");
  assert.equal(typeof subagentApi.runSubagent, "function");
  assert.equal(typeof subagentApi.interruptSubagent, "function");
  assert.equal(typeof subagentApi.reconcileSubagentRun, "function");
  assert.equal(typeof workflowApi.runWorkflowSpec, "function");
  assert.equal(typeof workflowApi.stopRun, "function");

  const root = await mkdtemp(join(tmpdir(), "looloomi-pi-compat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getSkills().skills, []);

  const sessionManager = SessionManager.inMemory(root);
  assert.equal(sessionManager.isPersisted(), false);
  assert.equal(typeof sessionManager.appendCustomEntry, "function");
  assert.equal(typeof sessionManager.buildSessionContext, "function");
});
