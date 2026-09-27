import { WorkView } from "../../components/work/WorkView.jsx";
import { FeatureFrame } from "../shared/FeatureFrame.jsx";
import { useWorkWorkspace } from "./useWorkWorkspace.js";
import "virtual:feature-styles/work.css";

export default function WorkRoute({ authUser, onLogout, navigationKey }) {
  const workspace = useWorkWorkspace({
    preferenceScope: authUser?.userId || authUser?.username || "anonymous",
    navigationKey,
  });

  return (
    <FeatureFrame feature="work" workspace={workspace} authUser={authUser} onLogout={onLogout}>
      {(current) => <WorkView workspace={current} />}
    </FeatureFrame>
  );
}
