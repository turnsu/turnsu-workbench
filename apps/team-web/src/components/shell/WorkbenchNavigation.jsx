import { createContext, useContext } from "react";

// View coordination only. Sessions, permissions and model access remain Product-owned.
export const WorkbenchNavigationContext = createContext(null);
export const useWorkbenchNavigation = () => useContext(WorkbenchNavigationContext);
