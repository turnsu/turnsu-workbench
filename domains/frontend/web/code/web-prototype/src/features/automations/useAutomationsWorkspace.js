import { useEffect, useMemo, useState } from "react";

import {
  useAutomationCandidatesQuery,
  useAutomationMutations,
  useAutomationOccurrencesQuery,
  useAutomationsQuery,
  useConnectionsQuery,
  useScopeQuery,
  useScopesQuery,
} from "../../api/queries.js";
import { translateCore } from "../../i18n/core.js";
import { useShellWorkspace } from "../shell/useShellWorkspace.js";

export function useAutomationsWorkspace({ preferenceScope = "anonymous", navigationKey = "" } = {}) {
  const shell = useShellWorkspace({ preferenceScope });
  // The shell intentionally groups server-derived state under `serverState`.
  // Reading a non-existent top-level `workspace` made this entire route appear
  // anonymous and therefore disabled every Product API query.
  const workspace = shell.serverState?.workspace || null;
  const principal = shell.session?.userId && workspace?.workspaceId
    ? { userId: shell.session.userId, workspaceId: workspace.workspaceId }
    : { userId: "", workspaceId: "" };
  const enabled = Boolean(principal.userId && principal.workspaceId);
  const canManageAutomations = ["owner", "admin"].includes(shell.membershipRole);
  const scopes = useScopesQuery(principal, enabled);
  const listedScopes = scopes.data?.data || [];
  // An Owner/Admin may read other members' scopes for discovery, but an
  // unattended Automation can only be created or changed through the current
  // actor's own personal scope. Never fall back to another user's scope.
  const ownPersonalScope = listedScopes.find((scope) => (
    scope.kind === "personal" && scope.ownerUserId === principal.userId
  )) || null;
  const personalScopeId = ownPersonalScope?.scopeId
    || "";
  const scope = useScopeQuery(principal, personalScopeId, enabled && canManageAutomations);
  const automations = useAutomationsQuery(principal, {}, enabled);
  const candidates = useAutomationCandidatesQuery(principal, {}, enabled && canManageAutomations);
  const connections = useConnectionsQuery(enabled && canManageAutomations);
  const [selectedAutomationId, setSelectedAutomationId] = useState("");
  const [requestedAutomationId, setRequestedAutomationId] = useState("");
  const [requestedOccurrenceId, setRequestedOccurrenceId] = useState("");
  useEffect(() => {
    const query = new URLSearchParams(globalThis.location?.search || "");
    const automationId = query.get("automationId") || "";
    const occurrenceId = query.get("occurrenceId") || "";
    setRequestedAutomationId(automationId);
    if (automationId) setSelectedAutomationId(automationId);
    setRequestedOccurrenceId(occurrenceId);
  }, [navigationKey]);
  useEffect(() => {
    const available = automations.data?.data || [];
    if (!available.length) return;
    if (requestedAutomationId && available.some((item) => item.automationId === requestedAutomationId)) {
      if (selectedAutomationId !== requestedAutomationId) setSelectedAutomationId(requestedAutomationId);
      return;
    }
    if (selectedAutomationId && !available.some((item) => item.automationId === selectedAutomationId)) {
      setSelectedAutomationId("");
    }
  }, [selectedAutomationId, requestedAutomationId, automations.data?.data]);
  const occurrences = useAutomationOccurrencesQuery(
    principal,
    selectedAutomationId,
    { limit: 20 },
    enabled && Boolean(selectedAutomationId),
  );
  const mutations = useAutomationMutations(principal);
  const selectedOccurrence = (occurrences.data?.data || []).find(
    (occurrence) => occurrence.occurrenceId === requestedOccurrenceId,
  ) || null;
  const t = (key, replacements) => translateCore(shell.locale, key, replacements);
  const automationState = useMemo(() => ({
    loading: scopes.isLoading || automations.isLoading || candidates.isLoading || connections.isLoading,
    fetching: scopes.isFetching || automations.isFetching || candidates.isFetching || connections.isFetching,
    error: [scopes, scope, automations, candidates, connections].find((query) => query.error && query.data === undefined)?.error || null,
    staleError: [scopes, scope, automations, candidates, connections].find((query) => query.error && query.data !== undefined)?.error || null,
  }), [scopes, scope, automations, candidates, connections]);

  return {
    ...shell,
    t,
    principal,
    scopes: listedScopes,
    automationScope: scope.data?.data || ownPersonalScope,
    automations: automations.data?.data || [],
    candidates: candidates.data?.data || [],
    connections: connections.data?.data || [],
    canManageAutomations,
    selectedAutomationId,
    selectAutomation(automationId) {
      setRequestedAutomationId("");
      setRequestedOccurrenceId("");
      setSelectedAutomationId(automationId);
    },
    selectedOccurrences: occurrences.data?.data || [],
    requestedOccurrenceId,
    selectedOccurrence,
    occurrencesState: {
      loading: occurrences.isLoading,
      error: occurrences.error || null,
      retry: occurrences.refetch,
    },
    automationState,
    automationMutations: mutations,
    loading: shell.loading || automationState.loading,
    error: shell.error || automationState.error,
    staleSurfaceError: shell.staleSurfaceError || automationState.staleError,
    retry() {
      return Promise.all([
        shell.retry(),
        scopes.refetch(),
        ...(personalScopeId && canManageAutomations ? [scope.refetch()] : []),
        automations.refetch(),
        ...(canManageAutomations ? [candidates.refetch(), connections.refetch()] : []),
        ...(selectedAutomationId ? [occurrences.refetch()] : []),
      ]);
    },
    retryStaleSurface() {
      return Promise.all([
        scopes.refetch(),
        ...(personalScopeId && canManageAutomations ? [scope.refetch()] : []),
        automations.refetch(),
        ...(canManageAutomations ? [candidates.refetch(), connections.refetch()] : []),
        ...(selectedAutomationId ? [occurrences.refetch()] : []),
      ]);
    },
  };
}
