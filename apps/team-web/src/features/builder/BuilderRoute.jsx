import { CreateResourceDialog } from "../../components/resources/CreateResourceDialog.jsx";
import { TemplatesBuilderView } from "../../components/templates/TemplatesBuilderView.jsx";
import { WorkflowStudio } from "../../components/loops/WorkflowStudio.jsx";
import { FeatureFrame } from "../shared/FeatureFrame.jsx";
import { withFeatureQueryState } from "../shared/FeatureQueryState.jsx";
import { useBuilderWorkspace } from "./useBuilderWorkspace.js";
import "virtual:feature-styles/builder.css";

export default function BuilderRoute({ authUser, onLogout }) {
  const workspace = useBuilderWorkspace({
    preferenceScope: authUser?.userId || authUser?.username || "anonymous",
  });
  return (
    <FeatureFrame
      feature="builder"
      workspace={workspace}
      authUser={authUser}
      onLogout={onLogout}
      dialogs={(current) => <CreateResourceDialog workspace={current} />}
    >
      {(current) => current.route.loopId
        ? withFeatureQueryState(current, "workflow", current.t("object.loopWorkflow"), current.selectedLoop?.canonicalRevision ? <WorkflowStudio workspace={current} /> : <TemplatesBuilderView workspace={current} />, "loopops.builder.query-state", "loops")
        : withFeatureQueryState(current, "loops", current.t("page.builder.title"), <TemplatesBuilderView workspace={current} />, "loopops.builder.query-state", "loops")}
    </FeatureFrame>
  );
}
