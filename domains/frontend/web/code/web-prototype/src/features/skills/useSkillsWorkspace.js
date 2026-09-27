import { useWorkbenchWorkspace } from "../../state/useWorkbenchWorkspace.js";

export function useSkillsWorkspace(options = {}) {
  return useWorkbenchWorkspace({ ...options, feature: "skills" });
}
