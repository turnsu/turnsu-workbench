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

  function update(release, afterSuccess) {
    return rebinding.run({
      actionKey: `update:${release.releaseId}`,
      actionLabel: t("actions.reviewUpdate"),
      execute(connectionBindings) {
        return mutations.createInstallationUpdateDraft.mutateAsync({
          installationId: release.installation.installationId,
          releaseId: release.releaseId,
          connectionBindings,
          idempotencyKey: mutationKey("team-update-draft"),
        });
      },
      async onSuccess(result) {
        await afterSuccess?.(result);
      },
    });
  }

  async function applyUpdate(updateDraftId, afterSuccess) {
    try {
      const result = await mutations.confirmInstallationUpdateDraft.mutateAsync({
        updateDraftId,
        idempotencyKey: mutationKey("team-update-confirm"),
      });
      workspace.pushToast(t("toast.teamReleaseUpdated"));
      await afterSuccess?.(result);
      return result;
    } catch (error) {
      workspace.pushToast(error?.message || t("connections.actionFailed"));
      throw error;
    }
  }

  async function refreshUpdate(updateDraftId, afterSuccess) {
    try {
      const result = await mutations.refreshInstallationUpdateDraft.mutateAsync({
        updateDraftId,
        idempotencyKey: mutationKey("team-update-refresh"),
      });
      await afterSuccess?.(result);
      return result;
    } catch (error) {
      workspace.pushToast(error?.message || t("connections.actionFailed"));
      throw error;
    }
  }

  async function keepCurrent(updateDraftId, afterSuccess) {
    const result = await mutations.keepCurrentInstallationVersion.mutateAsync({
      updateDraftId,
      idempotencyKey: mutationKey("team-update-keep-current"),
    });
    await afterSuccess?.(result);
    return result;
  }

  return {
    ...rebinding,
    updateDecisionPending: mutations.confirmInstallationUpdateDraft.isPending
      || mutations.refreshInstallationUpdateDraft.isPending
      || mutations.keepCurrentInstallationVersion.isPending,
    install,
    update,
    refreshUpdate,
    applyUpdate,
    keepCurrent,
  };
}
