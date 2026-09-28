import { RunDetailsView } from "../../components/runs/RunDetailsView.jsx";
import { FeatureFrame } from "../shared/FeatureFrame.jsx";
import { useRunWorkspace } from "./useRunWorkspace.js";
import "virtual:feature-styles/runs.css";

export default function RunsRoute({ authUser, onLogout }) {
  const workspace = useRunWorkspace({
    preferenceScope: authUser?.userId || authUser?.username || "anonymous",
  });
  return (
    <FeatureFrame feature="runs" workspace={workspace} authUser={authUser} onLogout={onLogout}>
      {(current) => <RunDetailsView workspace={current} />}
    </FeatureFrame>
  );
}
