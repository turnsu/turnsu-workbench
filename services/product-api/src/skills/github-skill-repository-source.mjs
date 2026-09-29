import { ProductStoreError } from "../store/errors.mjs";
import { parseSkillRuntimeManifest } from "./skill-package-format.mjs";

const PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIRECTORY_LENGTH = 320;
const REQUEST_TIMEOUT_MS = 15_000;

export function createGitHubSkillRepositorySource(options) {
  return new GitHubSkillRepositorySource(options);
}

export class GitHubSkillRepositorySource {
  #fetch;

  constructor({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("repository_fetch_required");
    this.#fetch = fetchImpl;
  }

  async readSkillFiles({ repositoryUrl, ref = "main", skillDirectory = "", signal } = {}) {
    const repository = parseGitHubRepository(repositoryUrl);
    const revision = parseRef(ref);
    const directory = parseDirectory(skillDirectory);
    const files = [];
    files.push(await this.#readFile({ ...repository, revision, path: joinPath(directory, "SKILL.md"), signal }));
    const runtime = await this.#readFile({
      ...repository,
      revision,
      path: joinPath(directory, "skill.runtime.json"),
      signal,
      optional: true,
    });
    let executable = null;
    if (runtime) {
      let manifest;
      try {
        manifest = parseSkillRuntimeManifest(runtime.content);
      } catch {
        throw repositoryError(
          "repository_runtime_manifest_invalid",
          "The repository Skill runtime manifest is unsupported.",
        );
      }
      executable = await this.#readFile({
        ...repository,
        revision,
        path: joinPath(directory, manifest.entrypoint),
        packagePath: manifest.entrypoint,
        signal,
        optional: true,
      });
    } else {
      const orphanedEntrypoints = await Promise.all([
        "scripts/main.py",
        "scripts/main.ts",
      ].map((entrypoint) => this.#readFile({
        ...repository,
        revision,
        path: joinPath(directory, entrypoint),
        packagePath: entrypoint,
        signal,
        optional: true,
      })));
      if (orphanedEntrypoints.some(Boolean)) {
        throw repositoryError(
          "repository_runtime_pair_incomplete",
          "An executable Skill entrypoint must include skill.runtime.json.",
        );
      }
    }
    if (runtime && !executable) {
      throw repositoryError(
        "repository_runtime_pair_incomplete",
        "An executable Skill must include the entrypoint declared by skill.runtime.json.",
      );
    }
    if (runtime) files.push(runtime);
    if (executable) files.push(executable);
    return {
      filename: `${repository.owner}-${repository.repo}-${revision.replaceAll("/", "-")}.skill`,
      files,
      repository: {
        provider: "github",
        repositoryUrl: `https://github.com/${repository.owner}/${repository.repo}`,
        ref: revision,
        skillDirectory: directory,
      },
    };
  }

  async #readFile({ owner, repo, revision, path, packagePath = null, signal, optional = false }) {
    const url = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`);
    url.searchParams.set("ref", revision);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "looloomi-workbench",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: combined,
      });
    } catch (failure) {
      if (signal?.aborted) {
        throw repositoryError(
          "repository_import_cancelled",
          "The repository import was cancelled.",
        );
      }
      if (/redirect/i.test(String(failure?.message || failure?.cause?.message || ""))) {
        throw repositoryError(
          "repository_redirect_forbidden",
          "The repository request attempted an unsupported redirect.",
        );
      }
      throw repositoryError("repository_import_unavailable", "The repository could not be reached.", { retryable: true, cause: failure });
    }
    if (optional && response.status === 404) return null;
    if (response.status === 404) {
      throw repositoryError("repository_skill_not_found", "No SKILL.md file was found at that repository location.");
    }
    if (
      response.status === 429
      || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
    ) {
      throw repositoryError(
        "repository_rate_limited",
        "GitHub rate-limited this repository import.",
        { retryable: true },
      );
    }
    if ([401, 403, 451].includes(response.status)) {
      throw repositoryError(
        "repository_private_or_forbidden",
        "The repository is private or cannot be read by the public importer.",
      );
    }
    if (!response.ok) {
      throw repositoryError("repository_import_unavailable", "The repository could not be read.", { retryable: response.status >= 500 });
    }
    let record;
    try {
      record = await response.json();
    } catch {
      throw repositoryError("repository_response_invalid", "The repository returned an unreadable file response.");
    }
    if (!record || record.type !== "file" || record.encoding !== "base64" || typeof record.content !== "string") {
      throw repositoryError("repository_response_invalid", "The repository file response is unsupported.");
    }
    const content = decodeBase64(record.content.replaceAll("\n", ""));
    if (content.byteLength === 0 || content.byteLength > MAX_FILE_BYTES || record.size !== content.byteLength) {
      throw repositoryError("repository_file_size_invalid", "A repository Skill file is empty or too large.");
    }
    const resolvedPackagePath = packagePath || (path.endsWith("SKILL.md")
      ? "SKILL.md"
      : path.endsWith("skill.runtime.json")
        ? "skill.runtime.json"
        : null);
    if (!resolvedPackagePath) {
      throw repositoryError("repository_response_invalid", "The repository file response is unsupported.");
    }
    return { path: resolvedPackagePath, content };
  }
}

export function parseGitHubRepository(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw repositoryError("repository_url_invalid", "Enter a public GitHub repository URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw repositoryError("repository_url_invalid", "Enter a public GitHub repository URL.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) throw repositoryError("repository_url_invalid", "Enter the repository root URL, not a file or folder URL.");
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");
  if (!PART.test(owner) || !PART.test(repo)) throw repositoryError("repository_url_invalid", "Enter a valid public GitHub repository URL.");
  return { owner, repo };
}

function parseRef(value) {
  const ref = String(value ?? "").trim();
  if (!ref || ref.length > 200 || /[\u0000-\u001f\u007f]/.test(ref)) {
    throw repositoryError("repository_ref_invalid", "Enter a valid branch, tag, or commit.");
  }
  return ref;
}

function parseDirectory(value) {
  const directory = String(value ?? "").trim().replace(/^\.\//, "").replace(/\/$/, "");
  if (!directory) return "";
  if (directory.length > MAX_DIRECTORY_LENGTH || directory.startsWith("/") || directory.split("/").some((part) => !part || part === "." || part === "..")) {
    throw repositoryError("repository_directory_invalid", "Enter a folder inside the repository.");
  }
  return directory;
}

function joinPath(directory, filename) {
  return directory ? `${directory}/${filename}` : filename;
}

function decodeBase64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw repositoryError("repository_response_invalid", "The repository returned invalid file content.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw repositoryError("repository_response_invalid", "The repository returned invalid file content.");
  return bytes;
}

function repositoryError(code, message, options = {}) {
  const failure = new ProductStoreError(code, message);
  failure.retryable = options.retryable === true;
  if (options.cause) failure.cause = options.cause;
  return failure;
}
