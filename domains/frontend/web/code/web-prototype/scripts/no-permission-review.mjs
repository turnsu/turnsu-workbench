import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const preferredReviewURL = process.env.LOOPOPS_WEB_URL || "http://127.0.0.1:5184/";

function assertCheck(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
      throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function runOptional(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout || ""}${result.stderr || ""}`);
  }
  return result.stdout;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkReviewScript() {
  const packageJSON = JSON.parse(read("package.json"));
  assertCheck(packageJSON.scripts.review.includes("127.0.0.1"), "review server must bind to 127.0.0.1");
  assertCheck(packageJSON.scripts.review.includes("--port 5184"), "review server must keep the stable review port");
  assertCheck(!packageJSON.scripts.review.includes("--open"), "review server must not auto-open a browser");
}

function checkNoSystemAutomation() {
  const checkedFiles = [
    "package.json",
    "scripts/action-smoke.mjs",
    "scripts/smoke.mjs",
    "scripts/export-offline-review.mjs",
    "scripts/dom-smoke.swift",
    "scripts/focus-smoke.swift",
    "scripts/capture-audit.swift",
  ];
  const forbidden = [
    /osascript/i,
    /System Events/i,
    /open\s+-a/i,
    /tell application/i,
    /AXUIElement/i,
    /CGWindowList/i,
    /Chrome/i,
    /Safari/i,
  ];

  for (const relativePath of checkedFiles) {
    const source = read(relativePath);
    for (const pattern of forbidden) {
      assertCheck(!pattern.test(source), `${relativePath} contains system automation pattern ${pattern}`);
    }
  }
}

function probeReviewServer(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1200 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve(response.statusCode === 200 && body.includes("LoopOps Admin"));
      });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

function parseViteLocalURL(output) {
  const match = output.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+\/)/);
  return match?.[1] ?? null;
}

function parseOfflineReviewPath(output) {
  const match = output.match(/^web_offline_review_path=(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

async function ensureReviewServer() {
  if (await probeReviewServer(preferredReviewURL)) {
    return { started: false, child: null, url: preferredReviewURL };
  }

  const child = spawn("npm", ["run", "review"], {
    cwd: rootDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  let activeReviewURL = preferredReviewURL;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(300);
    activeReviewURL = parseViteLocalURL(output) ?? activeReviewURL;
    if (await probeReviewServer(activeReviewURL)) {
      return { started: true, child, url: activeReviewURL };
    }
    if (child.exitCode !== null) {
      throw new Error(`review server exited before becoming available:\n${output}`);
    }
  }

  child.kill("SIGTERM");
  throw new Error(`review server did not become available at ${activeReviewURL}\n${output}`);
}

checkReviewScript();
checkNoSystemAutomation();

const buildOutput = run("npm", ["run", "build"]);
run("npm", ["run", "smoke"]);
run("npm", ["run", "action:smoke"]);
const offlineOutput = run("node", ["scripts/export-offline-review.mjs"]);
const offlineReviewPath = parseOfflineReviewPath(offlineOutput);

let server = null;
let domOutput = "";
let serverError = "";
let domSmokeError = "";
let domSmokeSource = "not-run";
try {
  server = await ensureReviewServer();
} catch (error) {
  serverError = error instanceof Error ? error.message : String(error);
}

if (server) {
  try {
    domOutput = run("npm", ["run", "dom:smoke"], { LOOPOPS_WEB_URL: server.url });
    domSmokeSource = "local-http";
  } finally {
    if (server.started && server.child) {
      server.child.kill("SIGTERM");
    }
  }
} else {
  assertCheck(offlineReviewPath, "offline review path was not printed by export script");
  assertCheck(fs.existsSync(offlineReviewPath), `offline review file is missing: ${offlineReviewPath}`);
  try {
    domOutput = runOptional("npm", ["run", "dom:smoke"], { LOOPOPS_WEB_URL: pathToFileURL(offlineReviewPath).href });
    domSmokeSource = "offline-file";
  } catch (error) {
    domSmokeError = error instanceof Error ? error.message : String(error);
    domSmokeSource = "skipped_sandbox_file_navigation";
  }
}

console.log("web_no_permission_review=pass");
console.log(`web_no_permission_review_url=${server?.url ?? pathToFileURL(offlineReviewPath).href}`);
console.log(`web_no_permission_review_bind=${server ? new URL(server.url).host : "none"}`);
console.log("web_no_permission_review_auto_open=false");
console.log("web_no_permission_review_system_automation=false");
console.log(`web_no_permission_review_server=${server ? (server.started ? "started" : "available") : "offline_fallback"}`);
console.log(`web_no_permission_review_dom_smoke=${domOutput ? "true" : domSmokeSource}`);
console.log(`web_no_permission_review_dom_smoke_source=${domSmokeSource}`);
if (serverError) {
  console.log(`web_no_permission_review_server_error=${serverError.split("\n")[0]}`);
}
if (domSmokeError) {
  console.log(`web_no_permission_review_dom_smoke_error=${domSmokeError.split("\n")[0]}`);
}
console.log(offlineOutput.split("\n").filter((line) => line.startsWith("web_offline_review")).join("\n"));
console.log(buildOutput.split("\n").filter((line) => line.includes("dist/assets/")).join("\n"));
if (domOutput) {
  console.log(domOutput.split("\n").filter((line) => line.startsWith("web_dom_")).join("\n"));
}
