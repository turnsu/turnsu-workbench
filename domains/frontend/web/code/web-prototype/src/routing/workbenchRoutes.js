const topLevelPages = new Set(["loops", "skills", "library"]);

function decode(value = "") {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export function parseWorkbenchPath(pathname = "/loops") {
  const segments = String(pathname || "/loops").split("/").filter(Boolean).map(decode);
  if (segments[0] === "skills") {
    if (!segments[1]) return { page: "skills" };
    const skillId = segments[1];
    if (segments[2] === "edit") return { page: "skill-editor", skillId };
    if (segments[2] === "instructions") return { page: "skill-instructions", skillId };
    if (segments[2] === "files") return { page: "skill-files", skillId };
    if (segments[2] === "tests") return { page: "skill-tests", skillId };
    if (segments[2] === "versions") return { page: "skill-versions", skillId };
    return { page: "skill-overview", skillId };
  }
  if (segments[0] === "library") {
    if (segments[1] === "skills" && segments[2]) return { page: "library-skill-detail", skillId: segments[2] };
    if (segments[1] === "loops" && segments[2]) return { page: "library-loop-detail", loopId: segments[2] };
    return { page: "library" };
  }
  if (segments[0] === "builder") return { page: "builder" };
  if (segments[0] !== "loops") return { page: "loops" };
  if (!segments[1]) return { page: "loops" };
  if (segments[1] === "new") return { page: "create-loop" };
  const loopId = segments[1];
  if (segments[2] === "edit") return { page: "builder", loopId };
  if (segments[2] === "run") return { page: "run-preflight", loopId };
  if (segments[2] === "publish") return { page: "loop-publish", loopId };
  if (segments[2] === "updates" && segments[3]) return { page: "loop-update", loopId, skillVersionId: segments[3] };
  if (segments[2] === "runs" && segments[3]) return { page: "runs", loopId, runId: segments[3] };
  return { page: "loop-overview", loopId };
}

export function workbenchPathFor(route = {}) {
  const page = topLevelPages.has(route.page) ? route.page : route.page || "loops";
  if (page === "skills") return "/skills";
  if (page === "skill-overview" && route.skillId) return `/skills/${encodeURIComponent(route.skillId)}`;
  if (page === "skill-editor" && route.skillId) return `/skills/${encodeURIComponent(route.skillId)}/edit`;
  if (page === "skill-instructions" && route.skillId) return `/skills/${encodeURIComponent(route.skillId)}/instructions`;
  if (page === "skill-files" && route.skillId) return `/skills/${encodeURIComponent(route.skillId)}/files`;
  if (page === "skill-tests" && route.skillId) return `/skills/${encodeURIComponent(route.skillId)}/tests`;
  if (page === "skill-versions" && route.skillId) return `/skills/${encodeURIComponent(route.skillId)}/versions`;
  if (page === "library") return "/library";
  if (page === "library-skill-detail" && route.skillId) return `/library/skills/${encodeURIComponent(route.skillId)}`;
  if (page === "library-loop-detail" && route.loopId) return `/library/loops/${encodeURIComponent(route.loopId)}`;
  if (page === "create-loop") return "/loops/new";
  if (page === "builder") return route.loopId ? `/loops/${encodeURIComponent(route.loopId)}/edit` : "/builder";
  if (page === "run-preflight" && route.loopId) return `/loops/${encodeURIComponent(route.loopId)}/run`;
  if (page === "loop-publish" && route.loopId) return `/loops/${encodeURIComponent(route.loopId)}/publish`;
  if (page === "loop-update" && route.loopId && route.skillVersionId) {
    return `/loops/${encodeURIComponent(route.loopId)}/updates/${encodeURIComponent(route.skillVersionId)}`;
  }
  if (page === "runs" && route.loopId && route.runId) {
    return `/loops/${encodeURIComponent(route.loopId)}/runs/${encodeURIComponent(route.runId)}`;
  }
  if (page === "loop-overview" && route.loopId) return `/loops/${encodeURIComponent(route.loopId)}`;
  return "/loops";
}

export function normalizeWorkbenchRoute(route = {}) {
  return parseWorkbenchPath(workbenchPathFor(route));
}
