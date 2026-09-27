import { AutomationsView } from "../../components/automations/AutomationsView.jsx";
import { FeatureFrame } from "../shared/FeatureFrame.jsx";
import { useAutomationsWorkspace } from "./useAutomationsWorkspace.js";
import "virtual:feature-styles/automations.css";

export default function AutomationsRoute({ authUser, onLogout, navigationKey = "" }) {
  const workspace = useAutomationsWorkspace({
    preferenceScope: authUser?.userId || authUser?.username || "anonymous",
    navigationKey,
  });
  return (
    <FeatureFrame feature="automations" workspace={workspace} authUser={authUser} onLogout={onLogout}>
      {(current) => <AutomationsView workspace={current} />}
    </FeatureFrame>
  );
}
