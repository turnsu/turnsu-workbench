const topLevelPages = new Set(["work", "loops", "skills", "library", "agent", "members", "automations"]);
const skillDetails = new Map([
  ["edit", "skill-editor"],
  ["instructions", "skill-instructions"],
  ["files", "skill-files"],
  ["tests", "skill-tests"],
  ["versions", "skill-versions"],
]);

function decodeSegments(pathname) {
  const raw = String(pathname || "/").split("/").filter(Boolean);
  try {
    return { segments: raw.map((value) => decodeURIComponent(value)), invalidEncoding: false };
  } catch {
    return { segments: raw, invalidEncoding: true };
  }
}

function notFound(pathname, contextualRoot = "/") {
  return {
    page: "not-found",
    code: "route_not_found",
    path: String(pathname || "/"),
    contextualRoot,
  };
}

export function parseWorkbenchPath(pathname = "/") {
  const { segments, invalidEncoding } = decodeSegments(pathname);
  if (invalidEncoding) return notFound(pathname);
  if (!segments.length) return { page: "agent" };
  if (segments[0] === "invite") {
    if (segments.length === 1) return { page: "invite" };
    return segments.length === 2 && segments[1] === "complete"
      ? { page: "invite-complete" }
      : notFound(pathname, "/invite");
  }
  if (segments[0] === "native") {
    return segments.length === 2 && segments[1] === "authorize"
      ? { page: "native-authorize" }
      : notFound(pathname, "/native");
  }
  if (segments[0] === "agent") return segments.length === 1 ? { page: "agent" } : notFound(pathname);
  if (segments[0] === "work") return segments.length === 1 ? { page: "work" } : notFound(pathname, "/work");
  if (segments[0] === "workflows") return segments.length === 1 ? { page: "loops" } : notFound(pathname, "/loops");
  if (segments[0] === "templates") return segments.length === 1 ? { page: "builder" } : notFound(pathname, "/builder");
  if (segments[0] === "members") return segments.length === 1 ? { page: "members" } : notFound(pathname, "/members");
  if (segments[0] === "automations") return segments.length === 1 ? { page: "automations" } : notFound(pathname, "/automations");
  if (segments[0] === "skills") {
    if (segments.length === 1) return { page: "skills" };
    if (segments[1] === "new") {
      return segments.length === 2 ? { page: "create-skill" } : notFound(pathname, "/skills");
    }
    const skillId = segments[1];
    if (segments.length === 2) return { page: "skill-overview", skillId };
    const page = skillDetails.get(segments[2]);
    return page && segments.length === 3
      ? { page, skillId }
      : notFound(pathname, "/skills");
  }
  if (segments[0] === "library") {
    if (segments.length === 1) return { page: "library" };
    if (segments.length === 3 && segments[1] === "skills") {
      return { page: "library-skill-detail", skillId: segments[2] };
    }
    if (segments.length === 3 && segments[1] === "loops") {
      return { page: "library-loop-detail", loopId: segments[2] };
    }
    return notFound(pathname, "/library");
  }
  if (segments[0] === "builder") {
    return segments.length === 1 ? { page: "builder" } : notFound(pathname, "/builder");
  }
  if (segments[0] !== "loops") return notFound(pathname);
  if (segments.length === 1) return { page: "loops" };
  if (segments[1] === "new") {
    return segments.length === 2 ? { page: "create-loop" } : notFound(pathname, "/loops");
  }
  const loopId = segments[1];
  if (segments.length === 2) return { page: "loop-overview", loopId };
  if (segments.length === 3 && segments[2] === "edit") return { page: "builder", loopId };
  if (segments.length === 3 && segments[2] === "run") return { page: "run-preflight", loopId };
  if (segments.length === 3 && segments[2] === "publish") return { page: "loop-publish", loopId };
  if (segments.length === 4 && segments[2] === "runs") {
    return { page: "runs", loopId, runId: segments[3] };
  }
  return notFound(pathname, "/loops");
}

function required(value, code) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(code);
  return encodeURIComponent(value);
}

export function workbenchPathFor(route = {}) {
  const page = route.page;
  if (page === "skills") return "/skills";
  if (page === "create-skill") return "/skills/new";
  if (page === "agent") return "/";
  if (page === "work") return "/work";
  if (page === "invite") return "/invite";
  if (page === "invite-complete") return "/invite/complete";
  if (page === "native-authorize") return "/native/authorize";
  if (page === "loops") return "/loops";
  if (page === "members") return "/members";
  if (page === "automations") return "/automations";
  if (page === "skill-overview") return `/skills/${required(route.skillId, "skill_route_id_required")}`;
  if (page === "skill-editor") return `/skills/${required(route.skillId, "skill_route_id_required")}/edit`;
  if (page === "skill-instructions") return `/skills/${required(route.skillId, "skill_route_id_required")}/instructions`;
  if (page === "skill-files") return `/skills/${required(route.skillId, "skill_route_id_required")}/files`;
  if (page === "skill-tests") return `/skills/${required(route.skillId, "skill_route_id_required")}/tests`;
  if (page === "skill-versions") return `/skills/${required(route.skillId, "skill_route_id_required")}/versions`;
  if (page === "library") return "/library";
  if (page === "library-skill-detail") return `/library/skills/${required(route.skillId, "library_skill_route_id_required")}`;
  if (page === "library-loop-detail") return `/library/loops/${required(route.loopId, "library_loop_route_id_required")}`;
  if (page === "create-loop") return "/loops/new";
  if (page === "builder") return route.loopId ? `/loops/${required(route.loopId, "loop_route_id_required")}/edit` : "/builder";
  if (page === "run-preflight") return `/loops/${required(route.loopId, "loop_route_id_required")}/run`;
  if (page === "loop-publish") return `/loops/${required(route.loopId, "loop_route_id_required")}/publish`;
  if (page === "runs") {
    return `/loops/${required(route.loopId, "loop_route_id_required")}/runs/${required(route.runId, "run_route_id_required")}`;
  }
  if (page === "loop-overview") return `/loops/${required(route.loopId, "loop_route_id_required")}`;
  if (page === "not-found" && typeof route.path === "string") return route.path;
  if (topLevelPages.has(page)) return page === "agent" ? "/" : `/${page}`;
  throw new TypeError("workbench_route_invalid");
}

export function normalizeWorkbenchRoute(route = {}) {
  return parseWorkbenchPath(workbenchPathFor(route));
}
