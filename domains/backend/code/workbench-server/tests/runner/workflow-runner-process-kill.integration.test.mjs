import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ProductMongoStore } from "../../src/store/index.mjs";

const ENABLED = process.env.WORKBENCH_MONGO_INTEGRATION === "1";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";
const DATABASE_NAME = `looloomi_runner_kill_${process.pid}_${randomUUID().slice(0, 8)}_test`;
const testDir = dirname(fileURLToPath(import.meta.url));
const workerPath = join(testDir, "fixtures", "workflow-runner-process-kill-worker.mjs");
const LEASE_DURATION_MS = 1_000;
const scenarios = [
  {
    boundary: "post-claim",
    expectedRecoveredRunIds: 1,
    expectedStatus: "completed",
    expectedEffects: 1,
    waitForLeaseExpiry: true,
  },
  {
    boundary: "post-attempt-invocation-persistence",
    expectedRecoveredRunIds: 1,
    expectedStatus: "failed",
    expectedEffects: 0,
    waitForLeaseExpiry: true,
  },
  {
    boundary: "waiting-review-handoff",
    expectedRecoveredRunIds: 0,
    expectedStatus: "completed",
    expectedEffects: 1,
    resumeReview: true,
  },
  {
    boundary: "terminal-commit-before-publish",
    expectedRecoveredRunIds: 0,
    expectedStatus: "completed",
    expectedEffects: 1,
  },
];

test("WorkflowRunner survives real parent/child SIGKILL at durable boundaries", {
  skip: !ENABLED,
  timeout: 120_000,
}, async (t) => {
  assert.ok(DATABASE_NAME.endsWith("_test"));
  const store = new ProductMongoStore({
    uri: MONGODB_URI,
    dbName: DATABASE_NAME,
    serverSelectionTimeoutMS: 5_000,
  });
  const children = new Set();
  let connected = false;
  t.after(async () => {
    await Promise.allSettled([...children].map((child) => child.stop()));
    if (connected) await store.dropTestDatabase();
    await store.close();
  });

  await store.connect();
  connected = true;
  await store.dropTestDatabase();
  await store.connect();
  const health = await store.health();
  assert.equal(health.ok, true);
  assert.equal(health.replicaSet, "rs0");
  assert.equal(health.writablePrimary, true);

  for (const scenario of scenarios) {
    await t.test(scenario.boundary, { timeout: 25_000 }, async () => {
      const killed = await WorkerHarness.spawn({
        scenario: scenario.boundary,
        faultBoundary: scenario.boundary,
        workerId: `${scenario.boundary}-killed`,
      });
      children.add(killed);
      let restarted;
      try {
        const run = await killed.command("start");
        const interruptedRecovery = killed.command("recover", {}, 20_000);
        const interruptedFailure = assert.rejects(interruptedRecovery, /worker_exited.*SIGKILL/);
        const observed = await Promise.race([
          killed.waitForFault(scenario.boundary, 10_000).then((fault) => ({ fault })),
          interruptedRecovery.then(
            (recovery) => ({ recovery }),
            () => new Promise(() => {}),
          ),
        ]);
        if (!observed.fault) {
          throw new Error(`worker_recovery_completed_before_fault:${scenario.boundary}:${JSON.stringify(observed.recovery)}`);
        }
        const { fault } = observed;
        assert.equal(fault.context.runId, run.runId);
        assert.match(killed.stdout, new RegExp(`FAULT_BOUNDARY ${escapeRegExp(scenario.boundary)} ${escapeRegExp(run.runId)}`));
        assertBoundaryState(
          await durableSnapshot(store, run.runId, scenario.boundary),
          scenario.boundary,
        );

        await killed.sigkill();
        await interruptedFailure;
        if (scenario.waitForLeaseExpiry) {
          await waitFor(async () => {
            const job = await store.repositories.runJobs.getByRun(run.runId);
            return job?.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= Date.now();
          }, { timeoutMs: 5_000, label: `${scenario.boundary}:lease_expiry` });
        }

        restarted = await WorkerHarness.spawn({
          scenario: scenario.boundary,
          workerId: `${scenario.boundary}-restarted`,
        });
        children.add(restarted);
        const firstRecovery = await restarted.command("recover");
        assert.deepEqual(
          firstRecovery.recoveredRunIds,
          scenario.expectedRecoveredRunIds === 1 ? [run.runId] : [],
        );
        const afterFirstRecovery = await durableSnapshot(store, run.runId, scenario.boundary);

        const secondRecovery = await restarted.command("recover");
        assert.deepEqual(secondRecovery.recoveredRunIds, []);
        const afterSecondRecovery = await durableSnapshot(store, run.runId, scenario.boundary);
        assert.deepEqual(afterSecondRecovery.run, afterFirstRecovery.run, "Run changed on the second recovery pass");
        assert.deepEqual(afterSecondRecovery.readModel, afterFirstRecovery.readModel, "read model changed on the second recovery pass");
        assert.deepEqual(afterSecondRecovery.job, afterFirstRecovery.job, "RunJob changed on the second recovery pass");
        assert.deepEqual(afterSecondRecovery, afterFirstRecovery, "second recovery made a logical durable change");

        if (scenario.resumeReview) {
          assert.equal(afterSecondRecovery.run.status, "waiting_review");
          assert.equal(afterSecondRecovery.events.filter((event) => event.type === "review.requested").length, 1);
          await restarted.command("approve", { runId: run.runId });
          await waitFor(async () => (await store.repositories.runs.getInternal(run.runId))?.status === "completed", {
            timeoutMs: 10_000,
            label: `${scenario.boundary}:review_completion`,
          });
        }

        const final = await durableSnapshot(store, run.runId, scenario.boundary);
        assertDurableInvariants(final, scenario);
      } finally {
        if (restarted) {
          await restarted.stop();
          children.delete(restarted);
        }
        await killed.stop();
        children.delete(killed);
      }
    });
  }
});

function assertBoundaryState(snapshot, boundary) {
  const { run, readModel, job, leases, checkpoints, attempts, events, markers, effects } = snapshot;
  if (boundary === "post-claim") {
    assert.equal(run.status, "queued");
    assert.equal(readModel.status, "queued");
    assert.ok(["leased", "running"].includes(job.status));
    assert.equal(leases.filter((lease) => lease.status === "active").length, 1);
    assert.deepEqual(attempts, []);
    assert.deepEqual(checkpoints, []);
    assert.deepEqual(events.map((event) => event.type), ["run.queued"]);
    assert.deepEqual(effects, []);
  } else if (boundary === "post-attempt-invocation-persistence") {
    const skillAttempt = attempts.find((attempt) => attempt.nodeId === "node-skill");
    assert.equal(run.status, "running");
    assert.equal(readModel.status, "running");
    assert.equal(skillAttempt.status, "running");
    assert.equal(skillAttempt.invocationStatus, "started");
    assert.equal(typeof skillAttempt.invocationId, "string");
    assert.deepEqual(effects, []);
    assert.deepEqual(markers, []);
  } else if (boundary === "waiting-review-handoff") {
    assert.equal(run.status, "waiting_review");
    assert.equal(readModel.status, "waiting_review");
    assert.equal(job.status, "paused");
    assert.equal(leases.filter((lease) => lease.status === "active").length, 0);
    assert.equal(events.filter((event) => event.type === "review.requested").length, 1);
    assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.sequence), [1, 2, 3]);
    assert.equal(effects.length, 1);
  } else if (boundary === "terminal-commit-before-publish") {
    assert.equal(run.status, "completed");
    assert.equal(readModel.status, "completed");
    assert.equal(job.status, "completed");
    assert.equal(leases.filter((lease) => lease.status === "active").length, 0);
    assert.equal(markers.length, 1);
    assert.equal(events.filter((event) => event.type === "run.completed").length, 1);
    assert.equal(checkpoints.filter((checkpoint) => checkpoint.state?.terminal === true).length, 1);
    assert.equal(effects.length, 1);
  }
}

function assertDurableInvariants(snapshot, scenario) {
  const { run, readModel, job, leases, checkpoints, attempts, events, markers, decisions, effects } = snapshot;
  assert.ok(run, "Run must persist");
  assert.ok(readModel, "Run read model must persist");
  assert.ok(job, "RunJob must persist");
  assert.equal(run.status, scenario.expectedStatus);
  assert.equal(readModel.status, scenario.expectedStatus);
  assert.equal(job.status, scenario.expectedStatus);
  assert.equal(job.leaseOwner, null);
  assert.equal(job.leaseExpiresAt, null);
  assert.equal(leases.filter((lease) => lease.status === "active").length, 0);
  assert.equal(leases.length, 1);
  assert.ok(["released", "cancelled"].includes(leases[0].status));

  assertContiguous(events.map((event) => event.sequence), "event sequences");
  assertContiguous(checkpoints.map((checkpoint) => checkpoint.sequence), "checkpoint sequences");
  assert.equal(run.eventSequence, events.length);
  assert.equal(job.checkpointSequence, checkpoints.length);

  const skillAttempts = attempts.filter((attempt) => attempt.nodeId === "node-skill");
  assert.equal(skillAttempts.length, 1);
  assert.deepEqual(skillAttempts.map((attempt) => attempt.attempt), [1]);
  assert.equal(effects.length, scenario.expectedEffects);
  const effectCounts = new Map();
  for (const effect of effects) {
    effectCounts.set(effect.invocationId, (effectCounts.get(effect.invocationId) ?? 0) + 1);
  }
  assert.deepEqual([...effectCounts.values()], Array(scenario.expectedEffects).fill(1));

  if (scenario.boundary === "post-attempt-invocation-persistence") {
    assert.equal(readModel.failure.code, "side_effect_outcome_unknown");
    assert.equal(skillAttempts[0].failure.code, "side_effect_outcome_unknown");
    assert.equal(skillAttempts[0].invocationStatus, "outcome_unknown");
    assert.equal(events.filter((event) => event.type === "run.failed").length, 1);
  }

  if (scenario.boundary === "waiting-review-handoff") {
    assert.equal(events.filter((event) => event.type === "review.requested").length, 1);
    assert.equal(events.filter((event) => event.type === "run.paused").length, 1);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, "approve");
    assert.equal(decisions[0].applicationStatus, "applied");
  }

  assert.equal(markers.length, 1);
  const terminalType = `run.${scenario.expectedStatus}`;
  const terminalEvents = events.filter((event) => event.type === terminalType);
  const terminalCheckpoints = checkpoints.filter((checkpoint) => checkpoint.state?.terminal === true);
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalCheckpoints.length, 1);
  assert.equal(markers[0].eventId, terminalEvents[0].eventId);
  assert.equal(markers[0].checkpointId, terminalCheckpoints[0].checkpointId);
  assert.equal(markers[0].status, scenario.expectedStatus);
}

async function durableSnapshot(store, runId, scenario) {
  const [run, readModel, job, leases, checkpoints, attempts, events, markers, decisions, effects] = await Promise.all([
    store.repositories.runs.getInternal(runId),
    store.repositories.runReadModels.get(runId),
    store.repositories.runJobs.getByRun(runId),
    store.repositories.runLeases.collection.find({ runId }).sort({ fence: 1 }).toArray(),
    store.repositories.runCheckpoints.collection.find({ runId }).sort({ sequence: 1 }).toArray(),
    store.repositories.runNodeAttempts.listInternalByRun(runId),
    store.repositories.runEvents.listAfter(runId, 0),
    store.repositories.runTerminalTransitions.collection.find({ runId }).toArray(),
    store.repositories.reviewDecisions.listInternalByRun(runId),
    store.db.collection("runner_fault_effects").find({ scenario }).sort({ createdAt: 1 }).toArray(),
  ]);
  return clean({ run, readModel, job, leases, checkpoints, attempts, events, markers, decisions, effects });
}

function assertContiguous(sequences, label) {
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1), label);
}

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "_id") result[key] = clean(entry);
  }
  return result;
}

async function waitFor(predicate, { timeoutMs, label }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`wait_for_timeout:${label}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class WorkerHarness {
  constructor(child) {
    this.child = child;
    this.stdout = "";
    this.stderr = "";
    this.requestSequence = 0;
    this.pending = new Map();
    this.faults = new Map();
    this.faultWaiters = new Set();
    this.exited = null;
    this.ready = deferred();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.stdout += chunk;
      this.#resolveFaultWaiters();
    });
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    child.on("message", (message) => {
      if (message?.type === "ready") this.ready.resolve(message);
      if (message?.type === "fault") {
        this.faults.set(message.boundary, message);
        this.#resolveFaultWaiters();
      }
      if (message?.type === "response") {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(workerError(message.error));
      }
    });
    child.once("error", (error) => {
      this.ready.reject(error);
    });
    child.once("exit", (code, signal) => {
      this.exited = { code, signal };
      const error = new Error(`worker_exited:${code ?? "null"}:${signal ?? "none"}\n${this.stderr}`);
      this.ready.reject(error);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      for (const waiter of this.faultWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.faultWaiters.clear();
    });
  }

  static async spawn({ scenario, workerId, faultBoundary = "" }) {
    const child = fork(workerPath, [], {
      cwd: testDir,
      env: {
        ...process.env,
        MONGODB_URI,
        MONGODB_DB: DATABASE_NAME,
        WORKBENCH_FAULT_SCENARIO: scenario,
        WORKBENCH_FAULT_WORKER_ID: workerId,
        WORKBENCH_FAULT_BOUNDARY: faultBoundary,
        WORKBENCH_FAULT_LEASE_MS: String(LEASE_DURATION_MS),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const harness = new WorkerHarness(child);
    await withTimeout(harness.ready.promise, 10_000, `worker_ready:${workerId}`);
    return harness;
  }

  command(command, data = {}, timeoutMs = 10_000) {
    if (this.exited) return Promise.reject(new Error(`worker_exited:${this.exited.code}:${this.exited.signal}`));
    const requestId = `request-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`worker_command_timeout:${command}\n${this.stderr}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.send({ requestId, command, ...data }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  waitForFault(boundary, timeoutMs) {
    const fault = this.faults.get(boundary);
    const marker = fault?.marker;
    if (fault && marker && this.stdout.includes(marker)) return Promise.resolve(fault);
    return new Promise((resolve, reject) => {
      const waiter = {
        boundary,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.faultWaiters.delete(waiter);
          reject(new Error(`fault_marker_timeout:${boundary}\nstdout=${this.stdout}\nstderr=${this.stderr}`));
        }, timeoutMs),
      };
      this.faultWaiters.add(waiter);
    });
  }

  async sigkill() {
    if (this.exited) return this.exited;
    assert.equal(this.child.kill("SIGKILL"), true);
    await waitFor(() => Boolean(this.exited), { timeoutMs: 5_000, label: "child_sigkill_exit" });
    assert.equal(this.exited.signal, "SIGKILL");
    return this.exited;
  }

  async stop() {
    if (this.exited) return;
    try {
      await this.command("close", {}, 2_000);
      await waitFor(() => Boolean(this.exited), { timeoutMs: 2_000, label: "child_clean_exit" });
    } catch {
      if (!this.exited) await this.sigkill();
    }
  }

  #resolveFaultWaiters() {
    for (const waiter of this.faultWaiters) {
      const fault = this.faults.get(waiter.boundary);
      if (!fault?.marker || !this.stdout.includes(fault.marker)) continue;
      clearTimeout(waiter.timer);
      this.faultWaiters.delete(waiter);
      waiter.resolve(fault);
    }
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function workerError(value) {
  const error = new Error(`${value?.code ?? value?.name ?? "worker_error"}:${value?.message ?? "unknown"}`);
  error.code = value?.code;
  error.stack = value?.stack ?? error.stack;
  return error;
}
