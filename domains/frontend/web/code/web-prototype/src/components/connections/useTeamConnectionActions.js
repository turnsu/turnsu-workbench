import { useWorkbenchMutations } from "../../api/queries.js";
import { useConnectionRebindingAction } from "./useConnectionRebindingAction.js";

const mutationKey = (kind) => `${kind}-${globalThis.crypto?.randomUUID?.() || Date.now()}`;

export function useTeamConnectionActions(workspace) {
  const mutations = useWorkbenchMutations();
  const t = workspace.t;
  const rebinding = useConnectionRebindingAction({
    readOnly: workspace.readOnlyWorkspace,
    onError() {
      workspace.pushToast(t("connections.actionFailed"));
    },
  });

  function install(release, afterSuccess) {
    return rebinding.run({
      actionKey: `install:${release.releaseId}`,
      actionLabel: t("actions.install"),
      execute(connectionBindings) {
        return mutations.installTeamRelease.mutateAsync({
          releaseId: release.releaseId,
          idempotencyKey: mutationKey("team-install"),
          data: {
            connectionIds: connectionBindings.map((binding) => binding.connectionId),
            connectionBindings,
          },
        });
      },
      async onSuccess(result) {
        workspace.pushToast(t("toast.teamInstalled"));
        await afterSuccess?.(result);
      },
    });
  }

  function startingPoint(release, name, afterSuccess) {
    return rebinding.run({
      actionKey: `starting:${release.releaseId}`,
      actionLabel: t("actions.useStartingPoint"),
      execute(connectionBindings) {
        return mutations.useTeamReleaseAsStartingPoint.mutateAsync({
          releaseId: release.releaseId,
          idempotencyKey: mutationKey("team-starting-point"),
          data: { name, connectionBindings },
        });
      },
      async onSuccess(result) {
        const workflow = result.data.workflow;
        workspace.pushToast(t("toast.teamStartingPointCreated", { title: workflow.name }));
        workspace.editLoop(workflow.workflowId);
        await afterSuccess?.(result);
      },
    });
  }

  function fork(release, name, afterSuccess) {
    return rebinding.run({
      actionKey: `fork:${release.releaseId}`,
      actionLabel: t("actions.forkLoop"),
      execute(connectionBindings) {
        return mutations.forkTeamLoopRelease.mutateAsync({
          releaseId: release.releaseId,
          idempotencyKey: mutationKey("team-fork"),
          data: { name, connectionBindings },
        });
      },
      async onSuccess(result) {
        const workflow = result.data.workflow;
        workspace.pushToast(t("toast.teamForkCreated", { title: workflow.name }));
        workspace.editLoop(workflow.workflowId);
        await afterSuccess?.(result);
      },
    });
  }

  function update(release, afterSuccess) {
    return rebinding.run({
      actionKey: `update:${release.releaseId}`,
      actionLabel: t("actions.updateInstalledVersion"),
      execute(connectionBindings) {
        return mutations.adoptInstallationRelease.mutateAsync({
          installationId: release.installation.installationId,
          releaseId: release.releaseId,
          connectionBindings,
          idempotencyKey: mutationKey("team-update"),
        });
      },
      async onSuccess(result) {
        workspace.pushToast(t("toast.teamReleaseUpdated", { title: release.title }));
        await afterSuccess?.(result);
      },
    });
  }

  return {
    ...rebinding,
    install,
    startingPoint,
    fork,
    update,
  };
}
