import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  Check,
  WORKBENCH_V1_SKILL_IMPORT_ENDPOINTS,
} from "@looloomi/workbench-contracts";

import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";
import { WorkbenchSessionStore } from "../../src/security/workbench-session-store.mjs";

class Response extends EventEmitter {
  constructor() {
    super();
    this.status = 0;
    this.headers = {};
    this.body = "";
  }
  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
  }
  end(value = "") {
    this.body += value;
    this.emit("finish");
  }
}

function request({ method = "GET", url, headers = {}, body } = {}) {
  const value = new EventEmitter();
  value.method = method;
  value.url = url;
  value.headers = {
    host: "127.0.0.1",
    ...Object.fromEntries(Object.entries(headers).map(([key, item]) => [key.toLowerCase(), item])),
  };
  value[Symbol.asyncIterator] = async function* iterator() {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body));
  };
  return value;
}

async function invoke(handler, options) {
  const response = new Response();
  await handler(request(options), response);
  return response;
}

test("server Skill scan/import routes require a session, CSRF, and import idempotency", async () => {
  const calls = [];
  const sessionStore = new WorkbenchSessionStore({
    tokenFactory: () => "server-import-session",
    csrfTokenFactory: () => "csrf-server-import-1234567890",
  });
  await sessionStore.issue({ userId: "user-owner", activeWorkspaceId: "workspace-local" });
  const handler = createWorkbenchHttpHandler({
    application: {
      async scanServerSkills(input) {
        calls.push({ operation: "scan", input });
        return {
          candidates: [{
            relativeDirectory: "lark-calendar",
            name: "lark-calendar",
            description: "Calendar access.",
            status: "ready",
            alreadyExists: false,
            builtInToolPolicyAvailable: true,
            findings: [],
          }],
        };
      },
      async importServerSkills(input) {
        calls.push({ operation: "import", input });
        return {
          items: [{
            relativeDirectory: "lark-calendar",
            status: "imported",
            skillId: "skill-calendar",
            skillDraftId: "skill-draft-calendar",
          }],
        };
      },
    },
    sessionStore,
    origin: "http://127.0.0.1",
    requestIdFactory: () => "request-server-import",
  });
  const body = {
    schemaVersion: "workbench-api-v1",
    data: { rootPath: "/srv/skills" },
  };

  const denied = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/skills/scan",
    body,
  });
  assert.equal(denied.status, 401);

  const headers = {
    Cookie: "workbench_session=server-import-session",
    Origin: "http://127.0.0.1",
    "Sec-Fetch-Site": "same-origin",
    "X-Workbench-CSRF": "csrf-server-import-1234567890",
  };
  const scanned = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/skills/scan",
    headers,
    body,
  });
  assert.equal(scanned.status, 200);
  assert.equal(
    Check(WORKBENCH_V1_SKILL_IMPORT_ENDPOINTS.scanServerSkills.responseBodySchema, JSON.parse(scanned.body)),
    true,
  );

  const missingIdempotency = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/skills/import",
    headers,
    body: {
      schemaVersion: "workbench-api-v1",
      data: { rootPath: "/srv/skills", directories: ["lark-calendar"] },
    },
  });
  assert.equal(missingIdempotency.status, 400);

  const imported = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/skills/import",
    headers: { ...headers, "Idempotency-Key": "idem-server-import-http" },
    body: {
      schemaVersion: "workbench-api-v1",
      data: { rootPath: "/srv/skills", directories: ["lark-calendar"] },
    },
  });
  assert.equal(imported.status, 200);
  assert.equal(
    Check(WORKBENCH_V1_SKILL_IMPORT_ENDPOINTS.importServerSkills.responseBodySchema, JSON.parse(imported.body)),
    true,
  );
  assert.deepEqual(calls.map((entry) => entry.operation), ["scan", "import"]);
});
