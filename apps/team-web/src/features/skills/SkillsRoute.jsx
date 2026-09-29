import { CreateSkillDialog } from "../../components/skills/CreateSkillDialog.jsx";
import { SkillLifecycleView } from "../../components/skills/SkillLifecycleView.jsx";
import { SkillsView } from "../../components/skills/SkillsView.jsx";
import { FeatureFrame } from "../shared/FeatureFrame.jsx";
import { withFeatureQueryState } from "../shared/FeatureQueryState.jsx";
import { useSkillsWorkspace } from "./useSkillsWorkspace.js";
import "virtual:feature-styles/skills.css";

export default function SkillsRoute({ authUser, onLogout, navigationKey }) {
  const workspace = useSkillsWorkspace({
    preferenceScope: authUser?.userId || authUser?.username || "anonymous",
    navigationKey,
  });

  return (
    <FeatureFrame
      feature="skills"
      workspace={workspace}
      authUser={authUser}
      onLogout={onLogout}
    >
      {(current) => current.activePage === "create-skill"
        ? <CreateSkillDialog
            key="new-skill"
            workspace={current}
            embedded
            navigationKey={navigationKey}
          />
        : current.activePage === "skills"
          ? withFeatureQueryState(
            current,
            "skills",
            current.t("page.skills.title"),
            <SkillsView workspace={current} />,
            "loopops.skills.query-state",
          )
          : <SkillLifecycleView workspace={current} />}
    </FeatureFrame>
  );
}
