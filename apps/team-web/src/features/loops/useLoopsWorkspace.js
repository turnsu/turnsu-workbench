import { useWorkbenchWorkspace } from "../../state/useWorkbenchWorkspace.js";

export function useLoopsWorkspace(options = {}) {
  return useWorkbenchWorkspace({ ...options, feature: "loops" });
}
