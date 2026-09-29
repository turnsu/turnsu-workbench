import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubSkillRepositorySource,
  parseGitHubRepository,
} from "../../src/skills/github-skill-repository-source.mjs";

const skill = "---\nname: imported-skill\ndescription: Imported safely.\n---\n";
const runtime = `${JSON.stringify({
  runtime: "python3.12",
  entrypoint: "scripts/main.py",
  protocol: { stdin: "json", stdout: "json" },
  permissions: {
    network: false,
    connections: [],
    externalActions: false,
    filesystem: "scratch-only",
  },
})}\n`;
const script = "print('ok')\n";

test("GitHub repository source reads only the bounded Skill contract through the fixed API host", async () => {
  const requests = [];
  const source = createGitHubSkillRepositorySource({
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      const path = String(url);
      const content = path.includes("scripts/main.py")
        ? script
        : path.includes("skill.runtime.json")
          ? runtime
          : skill;
      return new Response(JSON.stringify({ type: "file", encoding: "base64", size: Buffer.byteLength(content), content: Buffer.from(content).toString("base64") }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const imported = await source.readSkillFiles({
    repositoryUrl: "https://github.com/openai/example.git",
    ref: "release/v1",
    skillDirectory: "skills/reviewer",
  });
  assert.deepEqual(imported.files.map(({ path, content }) => [path, content.toString("utf8")]), [
    ["SKILL.md", skill],
    ["skill.runtime.json", runtime],
    ["scripts/main.py", script],
  ]);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ url }) => new URL(url).hostname === "api.github.com"));
  assert.ok(requests.every(({ options }) => options.redirect === "error"));
  assert.equal(imported.repository.repositoryUrl, "https://github.com/openai/example");
});

test("GitHub repository source allows an instructions-only Skill", async () => {
  const source = createGitHubSkillRepositorySource({
    fetchImpl: async (url) => !String(url).includes("SKILL.md")
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify({ type: "file", encoding: "base64", size: Buffer.byteLength(skill), content: Buffer.from(skill).toString("base64") }), { status: 200 }),
  });
  const imported = await source.readSkillFiles({ repositoryUrl: "https://github.com/openai/example" });
  assert.deepEqual(imported.files.map(({ path }) => path), ["SKILL.md"]);
});

test("GitHub repository source rejects incomplete Python runtime pairs", async () => {
  for (const missingPath of ["skill.runtime.json", "scripts/main.py"]) {
    const source = createGitHubSkillRepositorySource({
      fetchImpl: async (url) => {
        const path = String(url);
        if (path.includes(missingPath)) return new Response("not found", { status: 404 });
        const content = path.includes("SKILL.md")
          ? skill
          : path.includes("skill.runtime.json")
            ? runtime
            : script;
        return new Response(JSON.stringify({
          type: "file",
          encoding: "base64",
          size: Buffer.byteLength(content),
          content: Buffer.from(content).toString("base64"),
        }), { status: 200 });
      },
    });
    await assert.rejects(
      () => source.readSkillFiles({ repositoryUrl: "https://github.com/openai/example" }),
      (failure) => failure?.code === "repository_runtime_pair_incomplete",
    );
  }
});

test("GitHub repository source rejects arbitrary hosts, credentials, deep links, and traversal", async () => {
  for (const value of [
    "http://github.com/openai/example",
    "https://example.com/openai/example",
    "https://token@github.com/openai/example",
    "https://github.com/openai/example/tree/main",
    "https://github.com/openai/example?token=secret",
  ]) {
    assert.throws(() => parseGitHubRepository(value), (failure) => failure?.code === "repository_url_invalid");
  }
  const source = createGitHubSkillRepositorySource({ fetchImpl: async () => new Response("", { status: 500 }) });
  await assert.rejects(
    () => source.readSkillFiles({ repositoryUrl: "https://github.com/openai/example", skillDirectory: "../private" }),
    (failure) => failure?.code === "repository_directory_invalid",
  );
});

test("GitHub repository source turns missing SKILL.md and malformed content into product errors", async () => {
  const missing = createGitHubSkillRepositorySource({ fetchImpl: async () => new Response("", { status: 404 }) });
  await assert.rejects(
    () => missing.readSkillFiles({ repositoryUrl: "https://github.com/openai/example" }),
    (failure) => failure?.code === "repository_skill_not_found",
  );
  const malformed = createGitHubSkillRepositorySource({
    fetchImpl: async () => new Response(JSON.stringify({ type: "file", encoding: "base64", size: 2, content: "***" }), { status: 200 }),
  });
  await assert.rejects(
    () => malformed.readSkillFiles({ repositoryUrl: "https://github.com/openai/example" }),
    (failure) => failure?.code === "repository_response_invalid",
  );
});

test("GitHub repository source distinguishes rate limits, private repositories, redirects, and cancellation", async () => {
  const rateLimited = createGitHubSkillRepositorySource({
    fetchImpl: async () => new Response("", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
    }),
  });
  await assert.rejects(
    () => rateLimited.readSkillFiles({ repositoryUrl: "https://github.com/openai/example" }),
    (failure) => failure?.code === "repository_rate_limited" && failure.retryable === true,
  );

  const privateRepository = createGitHubSkillRepositorySource({
    fetchImpl: async () => new Response("", { status: 403 }),
  });
  await assert.rejects(
    () => privateRepository.readSkillFiles({ repositoryUrl: "https://github.com/openai/example" }),
    (failure) => failure?.code === "repository_private_or_forbidden" && failure.retryable === false,
  );

  const redirected = createGitHubSkillRepositorySource({
    fetchImpl: async () => {
      throw new TypeError("redirect mode is set to error");
    },
  });
  await assert.rejects(
    () => redirected.readSkillFiles({ repositoryUrl: "https://github.com/openai/example" }),
    (failure) => failure?.code === "repository_redirect_forbidden",
  );

  const controller = new AbortController();
  controller.abort();
  const cancelled = createGitHubSkillRepositorySource({
    fetchImpl: async () => {
      throw new DOMException("aborted", "AbortError");
    },
  });
  await assert.rejects(
    () => cancelled.readSkillFiles({
      repositoryUrl: "https://github.com/openai/example",
      signal: controller.signal,
    }),
    (failure) => failure?.code === "repository_import_cancelled",
  );
});
