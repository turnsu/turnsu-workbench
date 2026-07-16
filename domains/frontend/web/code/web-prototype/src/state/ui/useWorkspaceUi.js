import { useEffect, useMemo, useState } from "react";
import { normalizeWorkbenchRoute, parseWorkbenchPath, workbenchPathFor } from "../../routing/workbenchRoutes.js";

const UI_STORAGE_KEY = "loopops.ui.v1";

function readPreferences() {
  if (typeof window === "undefined") return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(UI_STORAGE_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function useWorkspaceUi() {
  const initial = useMemo(readPreferences, []);
  const initialRoute = useMemo(
    () => typeof window === "undefined" ? { page: "loops" } : parseWorkbenchPath(window.location.pathname),
    [],
  );
  const [route, setRoute] = useState(initialRoute);
  const [activePage, setActivePageState] = useState(initialRoute.page || "loops");
  const [theme, setThemeState] = useState(initial.theme === "dark" ? "dark" : "light");
  const [locale, setLocaleState] = useState(initial.locale === "zh" ? "zh" : "en");
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
      document.documentElement.style.colorScheme = theme;
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ activePage, theme, locale }));
    }
  }, [activePage, theme, locale]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handlePopState = () => {
      const next = parseWorkbenchPath(window.location.pathname);
      setRoute(next);
      setActivePageState(next.page);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
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
      if (nextPath !== currentPath) window.history[replace ? "replaceState" : "pushState"]({}, "", nextPath);
    }
    setRoute(next);
    setActivePageState(next.page);
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
