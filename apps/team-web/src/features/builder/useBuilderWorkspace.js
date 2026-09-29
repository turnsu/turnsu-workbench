import { useWorkbenchWorkspace } from "../../state/useWorkbenchWorkspace.js";

export function useBuilderWorkspace(options = {}) {
  return useWorkbenchWorkspace({ ...options, feature: "builder" });
}
