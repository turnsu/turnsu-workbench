const DEFAULT_URI = "mongodb://127.0.0.1:27017";
const DEFAULT_DB = "looloomi_agent";
const TEST_TITLE_PATTERN = /^(async-)?smoke-check$/i;

function nowISO() {
  return new Date().toISOString();
}

function withoutMongoId(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const { _id, ...rest } = doc;
  return rest;
}

function isTestSession(session) {
  return Boolean(session?.isTest) || TEST_TITLE_PATTERN.test(String(session?.title || "").trim());
}

function isTestTask(task) {
  return Boolean(task?.isTest) || TEST_TITLE_PATTERN.test(String(task?.prompt || "").trim());
}

export class AgentMongoStore {
  constructor(options = {}) {
    this.uri = options.uri || process.env.MONGODB_URI || DEFAULT_URI;
    this.dbName = options.dbName || process.env.MONGODB_DB || DEFAULT_DB;
    this.testMode = options.testMode ?? process.env.WECHAT_AGENT_TEST_MODE === "1";
    this.client = null;
    this.db = null;
    this.readyPromise = null;
  }

  async connect() {
    if (this.db) return this.db;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.#connect();
    return this.readyPromise;
  }

  async #connect() {
    let MongoClient;
    try {
      ({ MongoClient } = await import("mongodb"));
    } catch (error) {
      throw new Error(`mongodb_driver_missing:${error?.message || error}`);
    }
    this.client = new MongoClient(this.uri, {
      appName: "looloomi-agent-runtime",
      serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || "2500"),
    });
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    await this.#ensureIndexes();
    return this.db;
  }

  async close() {
    if (this.client) await this.client.close();
    this.client = null;
    this.db = null;
    this.readyPromise = null;
  }

  async #collection(name) {
    const db = await this.connect();
    return db.collection(name);
  }

  async #ensureIndexes() {
    const db = this.db;
    await Promise.all([
      db.collection("sessions").createIndex({ sessionID: 1 }, { unique: true }),
      db.collection("sessions").createIndex({ updatedAt: -1 }),
      db.collection("sessions").createIndex({ isTest: 1, updatedAt: -1 }),
      db.collection("tasks").createIndex({ taskID: 1 }, { unique: true }),
      db.collection("tasks").createIndex({ sessionID: 1, updatedAt: -1 }),
      db.collection("tasks").createIndex({ runID: 1 }),
      db.collection("runs").createIndex({ runID: 1 }, { unique: true }),
      db.collection("runs").createIndex({ sessionID: 1, updatedAt: -1 }),
      db.collection("run_events").createIndex({ runID: 1, timestamp: 1 }),
      db.collection("tool_calls").createIndex({ runID: 1, createdAt: 1 }),
      db.collection("final_outputs").createIndex({ runID: 1 }, { unique: true }),
      db.collection("attachments").createIndex({ attachmentID: 1 }, { unique: true, sparse: true }),
    ]);
  }

  decorateSession(session) {
    return {
      ...session,
      isTest: this.testMode || isTestSession(session),
      updatedAt: session.updatedAt || nowISO(),
    };
  }

  decorateTask(task) {
    return {
      ...task,
      isTest: this.testMode || isTestTask(task),
      updatedAt: task.updatedAt || nowISO(),
    };
  }

  async saveSession(session) {
    const payload = this.decorateSession(session);
    const collection = await this.#collection("sessions");
    await collection.replaceOne({ sessionID: payload.sessionID }, payload, { upsert: true });
    return withoutMongoId(payload);
  }

  async createSession(session) {
    return this.saveSession(session);
  }

  async getSession(sessionID) {
    const collection = await this.#collection("sessions");
    return withoutMongoId(await collection.findOne({ sessionID }));
  }

  async renameSession(sessionID, title) {
    const trimmed = String(title || "").trim();
    if (!trimmed) return null;
    const collection = await this.#collection("sessions");
    await collection.updateOne({ sessionID }, { $set: { title: trimmed, updatedAt: nowISO() } });
    return withoutMongoId(await collection.findOne({ sessionID }));
  }

  async listSessions(options = {}) {
    const collection = await this.#collection("sessions");
    const includeTest = Boolean(options.includeTest);
    const query = includeTest ? {} : { isTest: { $ne: true }, title: { $not: TEST_TITLE_PATTERN } };
    const docs = await collection.find(query).sort({ updatedAt: -1 }).limit(options.limit || 200).toArray();
    return docs.map(withoutMongoId);
  }

  async deleteSession(sessionID) {
    const tasks = await this.listTasks({ sessionID, includeTest: true, limit: 1000 });
    const runIDs = tasks.map((task) => task.runID).filter(Boolean);
    const collections = await Promise.all([
      this.#collection("sessions"),
      this.#collection("tasks"),
      this.#collection("runs"),
      this.#collection("run_events"),
      this.#collection("tool_calls"),
      this.#collection("final_outputs"),
    ]);
    const [sessions, tasksCollection, runs, events, toolCalls, finalOutputs] = collections;
    await Promise.all([
      sessions.deleteOne({ sessionID }),
      tasksCollection.deleteMany({ sessionID }),
      runIDs.length ? runs.deleteMany({ runID: { $in: runIDs } }) : Promise.resolve(),
      runIDs.length ? events.deleteMany({ runID: { $in: runIDs } }) : Promise.resolve(),
      runIDs.length ? toolCalls.deleteMany({ runID: { $in: runIDs } }) : Promise.resolve(),
      runIDs.length ? finalOutputs.deleteMany({ runID: { $in: runIDs } }) : Promise.resolve(),
    ]);
    return { sessionID, deletedRunIDs: runIDs };
  }

  async saveTask(task) {
    const payload = this.decorateTask(task);
    const collection = await this.#collection("tasks");
    await collection.replaceOne({ taskID: payload.taskID }, payload, { upsert: true });
    if (payload.runID) {
      await this.saveRun({
        runID: payload.runID,
        taskID: payload.taskID,
        sessionID: payload.sessionID,
        status: payload.status,
        prompt: payload.prompt,
        artifactPath: payload.artifactPath,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        isTest: payload.isTest,
      });
    }
    return withoutMongoId(payload);
  }

  async listTasks(options = {}) {
    const collection = await this.#collection("tasks");
    const query = {};
    if (options.sessionID) query.sessionID = options.sessionID;
    if (!options.includeTest) {
      query.isTest = { $ne: true };
      query.prompt = { $not: TEST_TITLE_PATTERN };
    }
    const docs = await collection.find(query).sort({ updatedAt: -1 }).limit(options.limit || 300).toArray();
    return docs.map(withoutMongoId);
  }

  async deleteTask(taskID) {
    const tasks = await this.#collection("tasks");
    const task = await tasks.findOne({ taskID });
    await tasks.deleteOne({ taskID });
    if (task?.runID) await this.deleteRun(task.runID);
    return { taskID, runID: task?.runID || null };
  }

  async saveRun(run) {
    const payload = {
      ...run,
      isTest: this.testMode || Boolean(run?.isTest),
      updatedAt: run.updatedAt || nowISO(),
    };
    const { createdAt, ...updatePayload } = payload;
    const collection = await this.#collection("runs");
    await collection.updateOne(
      { runID: payload.runID },
      { $set: updatePayload, $setOnInsert: { createdAt: createdAt || nowISO() } },
      { upsert: true }
    );
    return withoutMongoId(payload);
  }

  async deleteRun(runID) {
    const collections = await Promise.all([
      this.#collection("runs"),
      this.#collection("tasks"),
      this.#collection("run_events"),
      this.#collection("tool_calls"),
      this.#collection("final_outputs"),
    ]);
    const [runs, tasks, events, toolCalls, finalOutputs] = collections;
    await Promise.all([
      runs.deleteOne({ runID }),
      tasks.deleteMany({ runID }),
      events.deleteMany({ runID }),
      toolCalls.deleteMany({ runID }),
      finalOutputs.deleteOne({ runID }),
    ]);
    return { runID };
  }

  async appendEvent(event) {
    const collection = await this.#collection("run_events");
    await collection.insertOne({ ...event, isTest: this.testMode });
    if (event.runID) {
      await this.saveRun({
        runID: event.runID,
        taskID: event.taskID,
        sessionID: event.sessionID,
        status: event.status,
        currentStage: event.stage,
        updatedAt: event.timestamp || nowISO(),
        isTest: this.testMode,
      });
    }
    return event;
  }

  async listEvents(runID, options = {}) {
    const collection = await this.#collection("run_events");
    const docs = await collection.find({ runID }).sort({ timestamp: 1 }).limit(options.limit || 2000).toArray();
    return docs.map(withoutMongoId);
  }

  async saveToolCalls(runID, calls) {
    const collection = await this.#collection("tool_calls");
    await collection.deleteMany({ runID });
    if (Array.isArray(calls) && calls.length) {
      await collection.insertMany(calls.map((call) => ({ ...call, runID, isTest: this.testMode })));
    }
  }

  async saveFinalOutput(runID, text, metadata = {}) {
    const collection = await this.#collection("final_outputs");
    const payload = {
      runID,
      text,
      ...metadata,
      isTest: this.testMode || Boolean(metadata.isTest),
      updatedAt: nowISO(),
    };
    await collection.replaceOne({ runID }, payload, { upsert: true });
    return withoutMongoId(payload);
  }

  async readFinalOutput(runID) {
    const collection = await this.#collection("final_outputs");
    return withoutMongoId(await collection.findOne({ runID }));
  }

  async resetAll() {
    const names = ["sessions", "tasks", "runs", "run_events", "tool_calls", "final_outputs", "attachments"];
    const collections = await Promise.all(names.map((name) => this.#collection(name)));
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
    return { resetAt: nowISO(), collections: names };
  }

  async dropDatabase() {
    const db = await this.connect();
    await db.dropDatabase();
    this.db = null;
    this.readyPromise = null;
  }
}
