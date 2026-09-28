import { useWorkbenchWorkspace } from "../../state/useWorkbenchWorkspace.js";

export function useRunWorkspace(options = {}) {
  return useWorkbenchWorkspace({ ...options, feature: "runs" });
}
