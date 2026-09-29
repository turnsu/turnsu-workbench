import type { Static } from "typebox";

import { stringEnum } from "./schema.js";

export const WORKSPACE_ROLES = [
  "owner",
  "admin",
  "member",
  "viewer",
] as const;

export const WorkspaceRoleSchema = stringEnum(WORKSPACE_ROLES);

export type WorkspaceRole = Static<typeof WorkspaceRoleSchema>;
