import {
  AUTHORIZATION_CAPABILITIES,
  AUTHORIZATION_OPERATIONS,
  OBJECT_ACCESS_ROLES,
} from "@turnsu/workbench-contracts";

export const OPAQUE_OBJECT_ACCESS_ERROR_CODE = "object_not_found_or_forbidden";

const CANONICAL_WORKSPACE_ROLES = new Set(["owner", "admin", "member", "viewer"]);
const OPERATIONS = new Set(AUTHORIZATION_OPERATIONS);
const CAPABILITIES = new Set(AUTHORIZATION_CAPABILITIES);
const OBJECT_ROLES = new Set(OBJECT_ACCESS_ROLES);

const ROLE_OPERATIONS = Object.freeze({
  owner: new Set(AUTHORIZATION_OPERATIONS),
  maintainer: new Set([
    "discover",
    "read",
    "read_content",
    "read_events",
    "create",
    "update",
    "review",
    "execute",
    "publish",
    "share",
  ]),
  editor: new Set([
    "discover",
    "read",
    "read_content",
    "read_events",
    "create",
    "update",
    "execute",
  ]),
  reviewer: new Set([
    "discover",
    "read",
    "read_content",
    "read_events",
    "review",
  ]),
  viewer: new Set(["discover", "read", "read_content", "read_events"]),
});

const REQUIRED_CAPABILITY = Object.freeze({
  execute: "object.execute",
  publish: "object.publish",
  delete: "object.delete",
  share: "object.share",
  manage_access: "object.manage_access",
});

const VIEWER_DENIED_OPERATIONS = new Set([
  "create",
  "update",
  "execute",
  "publish",
  "delete",
  "share",
  "manage_access",
]);

const denied = () => ({
  allowed: false,
  code: OPAQUE_OBJECT_ACCESS_ERROR_CODE,
});

const isSystemCatalogSkill = (target) => (
  target.objectKind === "skill" && target.ownerPrincipalId === "system-catalog"
);

const workspaceSystemSkillAccess = ({ target, operation, workspaceRole }) => (
  target.visibility === "workspace"
  && target.lifecycle === "published"
  && typeof target.latestPublishedVersionId === "string"
  && target.latestPublishedVersionId.length > 0
  && (
    ["discover", "read"].includes(operation)
    || (
      operation === "execute"
      && ["owner", "admin", "member"].includes(workspaceRole)
      && target.requestedSkillVersionId === target.latestPublishedVersionId
    )
  )
);

export const normalizeWorkspaceRole = (role) => {
  if (role === "maintainer") return "member";
  return CANONICAL_WORKSPACE_ROLES.has(role) ? role : null;
};

const grantedRoles = (principal, target) => {
  const roles = new Set();
  if (target.ownerPrincipalId === principal.principalId) roles.add("owner");
  for (const grant of target.grants ?? []) {
    if (grant?.principalId === principal.principalId && OBJECT_ROLES.has(grant.role)) {
      roles.add(grant.role);
    }
  }
  if (target.visibility === "workspace") roles.add("viewer");
  return roles;
};

const strongestRoleFor = (roles, operation) => {
  for (const role of OBJECT_ACCESS_ROLES) {
    if (roles.has(role) && ROLE_OPERATIONS[role].has(operation)) return role;
  }
  return null;
};

export class ObjectAccessDeniedError extends Error {
  constructor() {
    super("The object was not found or is not available to this principal.");
    this.name = "ObjectAccessDeniedError";
    this.code = OPAQUE_OBJECT_ACCESS_ERROR_CODE;
    this.statusCode = 404;
  }
}

/**
 * Pure, fail-closed object policy. Repositories provide the target and grants; this
 * class performs no reads and does not infer access from a known ID or membership.
 */
export class ObjectAccessPolicy {
  evaluate({ principal, target, operation } = {}) {
    if (!principal || !target || !OPERATIONS.has(operation)) return denied();
    const workspaceRole = normalizeWorkspaceRole(principal.workspaceRole);
    if (!workspaceRole || principal.workspaceId !== target.workspaceId) return denied();
    if (workspaceRole === "viewer" && VIEWER_DENIED_OPERATIONS.has(operation)) return denied();

    // An immutable workspace release grants use of that exact method only.
    // It does not expose the author's private asset, draft or later versions.
    if (target.objectKind === "skill" && target.lifecycle !== "deprecated"
      && typeof target.requestedSkillVersionId === "string"
      && target.requestedSkillVersionId === target.workspaceReleaseVersionId
      && (["read"].includes(operation)
        || (operation === "execute" && ["owner", "admin", "member"].includes(workspaceRole)))) {
      return { allowed: true, code: "authorized", objectRole: "viewer" };
    }

    // System catalog Skills are immutable workspace infrastructure. Their
    // owner identity and governed published pin are the authority: viewers may
    // discover/read, while members may also execute only the exact current pin.
    if (isSystemCatalogSkill(target)) {
      return workspaceSystemSkillAccess({ target, operation, workspaceRole })
        ? { allowed: true, code: "authorized", objectRole: "viewer" }
        : denied();
    }

    const role = strongestRoleFor(grantedRoles(principal, target), operation);
    if (!role) return denied();

    const requiredCapability = REQUIRED_CAPABILITY[operation];
    if (requiredCapability) {
      const capabilities = new Set(
        Array.isArray(principal.capabilities)
          ? principal.capabilities.filter((capability) => CAPABILITIES.has(capability))
          : [],
      );
      if (!capabilities.has(requiredCapability)) return denied();
    }

    return { allowed: true, code: "authorized", objectRole: role };
  }

  require(input) {
    const decision = this.evaluate(input);
    if (!decision.allowed) throw new ObjectAccessDeniedError();
    return decision;
  }
}
