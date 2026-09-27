import { useWorkbenchWorkspace } from "../../state/useWorkbenchWorkspace.js";

export function useTeamLibraryWorkspace(options = {}) {
  return useWorkbenchWorkspace({ ...options, feature: "library" });
}
