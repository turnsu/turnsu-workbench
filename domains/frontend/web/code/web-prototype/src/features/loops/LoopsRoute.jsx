import { CreateLoopView } from "../../components/loops/CreateLoopView.jsx";
import { LoopOverviewView } from "../../components/loops/LoopOverviewView.jsx";
import { LoopPublishView } from "../../components/loops/LoopPublishView.jsx";
import { LoopsBoardView } from "../../components/loops/LoopsBoardView.jsx";
import { RunPreflightView } from "../../components/runs/RunPreflightView.jsx";
import { CreateResourceDialog } from "../../components/resources/CreateResourceDialog.jsx";
import { FeatureFrame } from "../shared/FeatureFrame.jsx";
import { withFeatureQueryState } from "../shared/FeatureQueryState.jsx";
import { useLoopsWorkspace } from "./useLoopsWorkspace.js";
import "virtual:feature-styles/loops.css";

function LoopsSurface({ workspace }) {
  switch (workspace.activePage) {
    case "loop-overview":
      return <LoopOverviewView workspace={workspace} />;
    case "run-preflight":
      return <RunPreflightView workspace={workspace} />;
    case "loop-publish":
      return withFeatureQueryState(workspace, "workflow", workspace.t("object.loopWorkflow"), <LoopPublishView workspace={workspace} />, "loopops.publish.query-state", "loops");
    case "create-loop":
      return <CreateLoopView workspace={workspace} />;
    default:
      return withFeatureQueryState(workspace, "loops", workspace.t("page.loops.title"), <LoopsBoardView workspace={workspace} />, "loopops.loops.query-state");
  }
}

export default function LoopsRoute({ authUser, onLogout, navigationKey }) {
  const workspace = useLoopsWorkspace({
    preferenceScope: authUser?.userId || authUser?.username || "anonymous",
    navigationKey,
  });

  return (
    <FeatureFrame
      feature="loops"
      workspace={workspace}
      authUser={authUser}
      onLogout={onLogout}
      dialogs={(current) => (
        <CreateResourceDialog workspace={current} />
      )}
    >
      {(current) => <LoopsSurface workspace={current} />}
    </FeatureFrame>
  );
}
