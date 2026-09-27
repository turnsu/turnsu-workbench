import {
  useActiveSessionQuery,
  useInboxQuery,
  useRecentWorkQuery,
  useWorkspaceBootstrap,
} from "../../api/queries.js";
import { translateCore } from "../../i18n/core.js";
import { useWorkspaceUi } from "../../state/ui/useWorkspaceUi.js";

export function useShellWorkspace({
  preferenceScope = "anonymous",
  includeRecentWork = false,
} = {}) {
  const ui = useWorkspaceUi({ preferenceScope });
  const bootstrap = useWorkspaceBootstrap();
  const activeSession = useActiveSessionQuery(bootstrap.isSuccess);
  const recentWork = useRecentWorkQuery(
    { limit: 3 },
    bootstrap.isSuccess && includeRecentWork,
  );
  const workspace = bootstrap.data?.data?.workspace || null;
  const session = activeSession.data?.data?.session || null;
  const membership = activeSession.data?.data?.membership || null;
  const membershipRole = membership?.role || "";
  const principal = {
    workspaceId: workspace?.workspaceId || "",
    userId: session?.userId || "",
  };
  const inbox = useInboxQuery(
    principal,
    { limit: 50 },
    Boolean(principal.workspaceId && principal.userId),
  );
  const t = (key, replacements) => translateCore(ui.locale, key, replacements);

  async function requestWorkspaceAccess() {
    const request = t("permissions.requestText", {
      workspace: workspace?.name || t("permissions.defaultWorkspace"),
      user: session?.userId || "",
    });
    try {
      if (typeof globalThis.navigator?.clipboard?.writeText !== "function") {
        throw new Error("clipboard_unavailable");
      }
      await globalThis.navigator.clipboard.writeText(request);
      ui.pushToast(t("permissions.requestCopied"));
    } catch {
      ui.pushToast(t("permissions.requestCopyFailed"));
    }
  }

  return {
    ...ui,
    t,
    serverState: {
      workspace,
      fetching: bootstrap.isFetching || activeSession.isFetching || recentWork.isFetching,
    },
    session,
    membership,
    membershipRole,
    readOnlyWorkspace: membershipRole === "viewer",
    canWriteWorkspace: Boolean(membershipRole && membershipRole !== "viewer"),
    requestWorkspaceAccess,
    loading: bootstrap.isLoading || activeSession.isLoading,
    error: bootstrap.error || activeSession.error || null,
    recentWorkError: includeRecentWork ? recentWork.error || null : null,
    retryRecentWork() {
      return recentWork.refetch();
    },
    retry() {
      return Promise.all([
        bootstrap.refetch(),
        activeSession.refetch(),
        ...(includeRecentWork ? [recentWork.refetch()] : []),
      ]);
    },
    runs: (includeRecentWork ? recentWork.data?.data || [] : []).map((item) => ({
      id: item.runId,
      loopId: item.workflowId,
      title: item.title,
      status: item.status,
      updatedAt: item.updatedAt,
    })),
    inboxLoaded: inbox.isSuccess,
    inboxCount: inbox.data?.data?.count ?? 0,
    inboxHasMore: Boolean(inbox.hasNextPage),
    inboxLoadingMore: inbox.isFetchingNextPage,
    loadMoreInbox() {
      return inbox.fetchNextPage();
    },
    inboxIssues: (inbox.data?.data?.items || []).map((item) => ({
      id: item.itemId,
      title: item.title,
      detail: item.reason.replaceAll("_", " "),
      severity: item.severity,
      action: () => ui.navigateToPath(item.actionRoute),
    })),
  };
}
