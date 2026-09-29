import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

import { workbenchApi } from "./api/client.js";
import { createWorkbenchQueryClient } from "./api/queryClient.js";
import { AuthScreen } from "./components/auth/AuthScreen.jsx";
import { WorkspaceConnectionScreen } from "./components/auth/WorkspaceConnectionScreen.jsx";
import { parseWorkbenchPath } from "./routing/workbenchRoutes.js";

// Invitation and native approval are rare entry paths; load them only when opened.
const InvitationAcceptScreen = lazy(() => import("./components/auth/InvitationAcceptScreen.jsx")
  .then(({ InvitationAcceptScreen: component }) => ({ default: component })));
const InvitationCompleteScreen = lazy(() => import("./components/auth/InvitationAcceptScreen.jsx")
  .then(({ InvitationCompleteScreen: component }) => ({ default: component })));
const NativeAuthorizationScreen = lazy(() => import("./components/auth/NativeAuthorizationScreen.jsx")
  .then(({ NativeAuthorizationScreen: component }) => ({ default: component })));

const featureRoutes = Object.freeze({
  agent: lazy(() => import("./features/agent/AgentRoute.jsx")),
  work: lazy(() => import("./features/work/WorkRoute.jsx")),
  skills: lazy(() => import("./features/skills/SkillsRoute.jsx")),
  loops: lazy(() => import("./features/loops/LoopsRoute.jsx")),
  builder: lazy(() => import("./features/builder/BuilderRoute.jsx")),
  runs: lazy(() => import("./features/runs/RunsRoute.jsx")),
  library: lazy(() => import("./features/library/LibraryRoute.jsx")),
  members: lazy(() => import("./features/members/MembersRoute.jsx")),
  automations: lazy(() => import("./features/automations/AutomationsRoute.jsx")),
  "not-found": lazy(() => import("./features/not-found/NotFoundRoute.jsx")),
});

const skillPages = new Set([
  "skills",
  "create-skill",
  "skill-overview",
  "skill-editor",
  "skill-instructions",
  "skill-files",
  "skill-tests",
  "skill-versions",
]);
const loopPages = new Set([
  "loops",
  "workflows",
  "loop-overview",
  "run-preflight",
  "loop-publish",
  "create-loop",
]);
const libraryPages = new Set(["library", "library-loop-detail", "library-skill-detail"]);

export function featureForRoute(route = {}) {
  if (skillPages.has(route.page)) return "skills";
  if (loopPages.has(route.page)) return "loops";
  if (libraryPages.has(route.page)) return "library";
  if (route.page === "builder") return "builder";
  if (route.page === "runs") return "runs";
  if (route.page === "members") return "members";
  if (route.page === "automations") return "automations";
  if (route.page === "work") return "work";
  if (route.page === "not-found") return "not-found";
  return "agent";
}

function useWorkbenchRoute() {
  const readRoute = () => ({
    ...parseWorkbenchPath(globalThis.location?.pathname || "/"),
    locationKey: `${globalThis.location?.pathname || "/"}${globalThis.location?.search || ""}${globalThis.location?.hash || ""}`,
  });
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const update = () => setRoute(readRoute());
    globalThis.addEventListener?.("popstate", update);
    globalThis.addEventListener?.("workbench:navigate", update);
    return () => {
      globalThis.removeEventListener?.("popstate", update);
      globalThis.removeEventListener?.("workbench:navigate", update);
    };
  }, []);

  return route;
}

class FeatureErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(previousProps) {
    if (previousProps.featureKey !== this.props.featureKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="authPage">
        <section className="authCard" role="alert">
          <h1>页面加载失败</h1>
          <p className="authNotice">{this.state.error?.message || "请重试当前页面。"}</p>
          <button type="button" className="authSubmit" onClick={() => globalThis.location?.reload?.()}>
            重新加载
          </button>
        </section>
      </main>
    );
  }
}

function AuthenticatedWorkbench({ authUser, onLogout }) {
  const route = useWorkbenchRoute();
  const feature = featureForRoute(route);
  const FeatureRoute = useMemo(() => featureRoutes[feature], [feature]);

  return (
    <FeatureErrorBoundary featureKey={feature}>
      <Suspense
        fallback={(
          <main className="authPage" data-testid="loopops.feature.loading">
            <p>正在打开当前功能…</p>
          </main>
        )}
      >
        <FeatureRoute authUser={authUser} onLogout={onLogout} navigationKey={route.locationKey} />
      </Suspense>
    </FeatureErrorBoundary>
  );
}

export function App() {
  const route = useWorkbenchRoute();
  const [auth, setAuth] = useState({ loading: true, status: null, user: null, error: null });
  const [retryingConnection, setRetryingConnection] = useState(false);
  const [queryClient, setQueryClient] = useState(createWorkbenchQueryClient);
  const authenticatedPrincipal = useRef("");
  const authRequestGeneration = useRef(0);
  const rotatePrincipalState = (nextPrincipal = "", { resetApiSession = true } = {}) => {
    if (resetApiSession) workbenchApi.resetSession();
    setQueryClient((current) => {
      current.cancelQueries();
      current.clear();
      return createWorkbenchQueryClient();
    });
    authenticatedPrincipal.current = nextPrincipal;
  };

  const refresh = async () => {
    const generation = ++authRequestGeneration.current;
    try {
      const result = await workbenchApi.authStatus();
      if (generation !== authRequestGeneration.current) return null;
      const nextUser = result.data.user || null;
      const nextPrincipal = result.data.authenticated && nextUser
        ? `${nextUser.userId || nextUser.username || ""}:${result.data.workspaceId || ""}`
        : "";
      if (
        !nextPrincipal
        || (authenticatedPrincipal.current && authenticatedPrincipal.current !== nextPrincipal)
      ) {
        rotatePrincipalState(nextPrincipal);
      } else {
        authenticatedPrincipal.current = nextPrincipal;
      }
      setAuth({
        loading: false,
        status: result.data,
        user: nextUser,
        error: null,
      });
      if (!result.data.authenticated && ![
        "/login", "/register", "/invite", "/invite/complete",
      ].includes(globalThis.location?.pathname)) {
        globalThis.history?.replaceState?.(
          {},
          "",
          result.data.bootstrapRequired ? "/register" : "/login",
        );
      }
      return result.data;
    } catch (error) {
      if (generation !== authRequestGeneration.current) return null;
      rotatePrincipalState("");
      setAuth({ loading: false, status: null, user: null, error });
      return null;
    }
  };

  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const revalidate = () => refresh();
    const revalidateVisible = () => {
      if (globalThis.document?.visibilityState === "visible") refresh();
    };
    globalThis.addEventListener?.("focus", revalidate);
    globalThis.document?.addEventListener?.("visibilitychange", revalidateVisible);
    return () => {
      globalThis.removeEventListener?.("focus", revalidate);
      globalThis.document?.removeEventListener?.("visibilitychange", revalidateVisible);
    };
  }, []);

  async function retryConnection() {
    setRetryingConnection(true);
    try {
      await refresh();
    } finally {
      setRetryingConnection(false);
    }
  }

  if (auth.loading) {
    return <main className="authPage"><p>正在连接工作台…</p></main>;
  }
  const authRoute = content => (
    <FeatureErrorBoundary featureKey={route.page}>
      <Suspense fallback={<main className="authPage"><p>正在打开授权页面…</p></main>}>
        {content}
      </Suspense>
    </FeatureErrorBoundary>
  );
  if (route.page === "invite") {
    return authRoute(<InvitationAcceptScreen authenticated={Boolean(auth.status?.authenticated && auth.user)} />);
  }
  if (route.page === "invite-complete") {
    return authRoute(<InvitationCompleteScreen authenticated={Boolean(auth.status?.authenticated && auth.user)} />);
  }
  if (route.page === "native-authorize") {
    return authRoute(<NativeAuthorizationScreen authenticated={Boolean(auth.status?.authenticated && auth.user)} />);
  }
  if (auth.error || !auth.status) {
    return <WorkspaceConnectionScreen error={auth.error} retrying={retryingConnection} onRetry={retryConnection} />;
  }
  if (!auth.status.authenticated || !auth.user) {
    return (
      <AuthScreen
        status={auth.status}
        onRefresh={refresh}
        onAuthenticated={({ user, workspaceId }) => {
          authRequestGeneration.current += 1;
          rotatePrincipalState(
            `${user.userId || user.username || ""}:${workspaceId}`,
            { resetApiSession: false },
          );
          setAuth((current) => ({
            ...current,
            user,
            status: { ...current.status, authenticated: true, user, workspaceId },
          }));
        }}
      />
    );
  }
  return (
    <QueryClientProvider client={queryClient}>
      <AuthenticatedWorkbench
        key={auth.user.userId || auth.user.username}
        authUser={auth.user}
        onLogout={async () => {
          await workbenchApi.logout();
          rotatePrincipalState("");
          globalThis.history?.replaceState?.({}, "", "/login");
          await refresh();
        }}
      />
    </QueryClientProvider>
  );
}
