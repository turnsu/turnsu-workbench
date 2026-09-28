import { MembersView } from "../../components/auth/MembersView.jsx";
import { FeatureFrame } from "../shared/FeatureFrame.jsx";
import { useShellWorkspace } from "../shell/useShellWorkspace.js";

export default function MembersRoute({ authUser, onLogout }) {
  const workspace = useShellWorkspace({
    preferenceScope: authUser?.userId || authUser?.username || "anonymous",
  });
  return (
    <FeatureFrame feature="members" workspace={workspace} authUser={authUser} onLogout={onLogout}>
      {(current) => <MembersView workspace={current} />}
    </FeatureFrame>
  );
}
