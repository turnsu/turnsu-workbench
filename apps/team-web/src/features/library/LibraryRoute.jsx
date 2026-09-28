import { TeamLibraryLoopView } from "../../components/library/TeamLibraryLoopView.jsx";
import { TeamLibrarySkillView } from "../../components/library/TeamLibrarySkillView.jsx";
import { TeamLibraryView } from "../../components/library/TeamLibraryView.jsx";
import { FeatureFrame } from "../shared/FeatureFrame.jsx";
import { useTeamLibraryWorkspace } from "./useTeamLibraryWorkspace.js";
import "virtual:feature-styles/library.css";

export default function LibraryRoute({ authUser, onLogout, navigationKey }) {
  const workspace = useTeamLibraryWorkspace({
    preferenceScope: authUser?.userId || authUser?.username || "anonymous",
    navigationKey,
  });
  return (
    <FeatureFrame feature="library" workspace={workspace} authUser={authUser} onLogout={onLogout}>
      {(current) => current.activePage === "library-loop-detail"
        ? <TeamLibraryLoopView workspace={current} />
        : current.activePage === "library-skill-detail"
          ? <TeamLibrarySkillView workspace={current} />
          : <TeamLibraryView workspace={current} navigationKey={navigationKey} />}
    </FeatureFrame>
  );
}
