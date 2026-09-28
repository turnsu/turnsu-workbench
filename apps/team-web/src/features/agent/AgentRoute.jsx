import { MainAgentView } from "../../components/agents/MainAgentView.jsx";
import { FeatureFrame } from "../shared/FeatureFrame.jsx";
import { useShellWorkspace } from "../shell/useShellWorkspace.js";
import "../../styles/agent.css";

export default function AgentRoute({ authUser, onLogout, navigationKey }) {
  const workspace = useShellWorkspace({
    preferenceScope: authUser?.userId || authUser?.username || "anonymous",
    includeRecentWork: true,
  });

  return (
    <FeatureFrame feature="agent" workspace={workspace} authUser={authUser} onLogout={onLogout}>
      {(current) => <MainAgentView workspace={current} navigationKey={navigationKey} />}
    </FeatureFrame>
  );
}
