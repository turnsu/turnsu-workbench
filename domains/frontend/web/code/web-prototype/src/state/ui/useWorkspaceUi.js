import { useEffect, useMemo, useState } from "react";
import { normalizeWorkbenchRoute, parseWorkbenchPath, workbenchPathFor } from "../../routing/workbenchRoutes.js";

const LEGACY_UI_STORAGE_KEY = "loopops.ui.v1";
const UI_STORAGE_PREFIX = "loopops.ui.v2";

function preferenceKey(scope) {
  return `${UI_STORAGE_PREFIX}:${encodeURIComponent(String(scope || "anonymous"))}`;
}

function readPreferences(scope) {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(preferenceKey(scope))
      || (scope === "anonymous" ? window.localStorage.getItem(LEGACY_UI_STORAGE_KEY) : null)
      || "{}";
    const value = JSON.parse(stored);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function initialLocale(preferences) {
  if (preferences?.locale === "zh" || preferences?.locale === "en") return preferences.locale;
  // A saved preference always wins.  In a first visit, however, a Chinese
  // browser should not have to discover the language switch before the
  // product becomes readable.
  return typeof navigator !== "undefined" && /^zh(?:-|$)/i.test(navigator.language || "")
    ? "zh"
    : "en";
}

export function useWorkspaceUi({ preferenceScope = "anonymous" } = {}) {
  const initial = useMemo(() => readPreferences(preferenceScope), [preferenceScope]);
  const initialRoute = useMemo(
    () => typeof window === "undefined" ? { page: "agent" } : parseWorkbenchPath(window.location.pathname),
    [],
  );
  const [route, setRoute] = useState(initialRoute);
  const [activePage, setActivePageState] = useState(initialRoute.page || "agent");
  const [theme, setThemeState] = useState(initial.theme === "dark" ? "dark" : "light");
  const [locale, setLocaleState] = useState(() => initialLocale(initial));
  const [query, setQuery] = useState("");
  const [loopFilter, setLoopFilter] = useState("All");
  const [skillFilter, setSkillFilter] = useState("All");
  const [toasts, setToasts] = useState([]);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  const [connectionRecovered, setConnectionRecovered] = useState(false);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.locale = locale;
      document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
      document.documentElement.style.colorScheme = theme;
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem(preferenceKey(preferenceScope), JSON.stringify({ theme, locale }));
    }
  }, [preferenceScope, theme, locale]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handleLocationChange = () => {
      const next = parseWorkbenchPath(window.location.pathname);
      setRoute(next);
      setActivePageState(next.page);
    };
    window.addEventListener("popstate", handleLocationChange);
    window.addEventListener("workbench:navigate", handleLocationChange);
    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      window.removeEventListener("workbench:navigate", handleLocationChange);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handleOnline = () => setOnline((wasOnline) => {
      if (!wasOnline) setConnectionRecovered(true);
      return true;
    });
    const handleOffline = () => {
      setConnectionRecovered(false);
      setOnline(false);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!connectionRecovered) return undefined;
    const timeout = window.setTimeout(() => setConnectionRecovered(false), 5000);
    return () => window.clearTimeout(timeout);
  }, [connectionRecovered]);

  function navigateTo(nextRoute, { replace = false } = {}) {
    const next = normalizeWorkbenchRoute(nextRoute);
    if (typeof window !== "undefined") {
      const nextPath = workbenchPathFor(next);
      const currentPath = window.location.pathname;
      if (nextPath !== currentPath || window.location.search) {
        window.history[replace ? "replaceState" : "pushState"]({}, "", nextPath);
        window.dispatchEvent(new Event("workbench:navigate"));
      }
    }
    setRoute(next);
    setActivePageState(next.page);
  }

  function navigateToPath(path, { replace = false } = {}) {
    if (typeof window === "undefined") return;
    const target = new URL(path, window.location.origin);
    window.history[replace ? "replaceState" : "pushState"](
      {},
      "",
      `${target.pathname}${target.search}${target.hash}`,
    );
    const next = parseWorkbenchPath(target.pathname);
    setRoute(next);
    setActivePageState(next.page);
    window.dispatchEvent(new Event("workbench:navigate"));
  }

  function pushToast(message, actionLabel = "", action = null) {
    const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((items) => {
      const deduped = items.filter((item) => item.message !== message || item.actionLabel !== actionLabel);
      return [{ id, message, actionLabel, action }, ...deduped].slice(0, 2);
    });
  }

  return {
    activePage,
    route,
    navigateTo,
    navigateToPath,
    setActivePage(page) {
      const normalized = page === "workflows" ? "loops" : page === "templates" ? "builder" : page;
      navigateTo({ page: normalized });
    },
    theme,
    setTheme(value) { setThemeState(value === "dark" ? "dark" : "light"); },
    toggleTheme() { setThemeState((value) => value === "dark" ? "light" : "dark"); },
    locale,
    setLocale(value) { setLocaleState(value === "zh" ? "zh" : "en"); },
    query,
    setQuery,
    loopFilter,
    setLoopFilter,
    skillFilter,
    setSkillFilter,
    online,
    connectionRecovered,
    dismissConnectionRecovery() { setConnectionRecovered(false); },
    toasts,
    pushToast,
    dismissToast(id) { setToasts((items) => items.filter((item) => item.id !== id)); },
  };
}
