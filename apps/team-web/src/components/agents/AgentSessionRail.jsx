import { useState } from "react";
import {
  ChevronRight,
  Search,
  CornerUpRight,
} from "lucide-react";

const STATUS_COPY = {
  zh: {
    idle: "准备开始",
    queued: "排队中",
    running: "进行中",
    waiting_review: "等你确认",
    completed: "已完成",
    failed: "未完成",
    cancelled: "已取消",
    blocked: "暂时无法继续",
  },
  en: {
    idle: "Ready",
    queued: "Queued",
    running: "In progress",
    waiting_review: "Needs your review",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    blocked: "Blocked",
  },
};

function dateGroup(value, locale) {
  const date = new Date(value || 0);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const difference = Math.round((start - day) / 86_400_000);
  if (locale === "zh") {
    if (difference <= 0) return "今天";
    if (difference === 1) return "昨天";
    return "更早";
  }
  if (difference <= 0) return "Today";
  if (difference === 1) return "Yesterday";
  return "Earlier";
}

function groupSessions(sessions, locale) {
  const groups = new Map();
  for (const session of sessions) {
    const label = dateGroup(session.updatedAt || session.createdAt, locale);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(session);
  }
  return [...groups.entries()];
}

function statusLabel(session, locale) {
  const status = STATUS_COPY[locale]?.[session.taskStatus]
    || STATUS_COPY.en[session.taskStatus]
    || session.taskStatus;
  if (session.source?.kind !== "loop_run") return status;
  return locale === "zh" ? `Loop 运行 · ${status}` : `Loop run · ${status}`;
}

export function AgentSessionRail({
  sessions,
  selectedSessionId,
  collapsed,
  loading,
  error,
  locale,
  onSelect,
  onNew,
  onToggle,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  onRetry,
}) {
  const zh = locale === "zh";
  const [search, setSearch] = useState("");
  const filtered = sessions.filter((session) => session.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const groups = groupSessions(filtered, locale);
  const title = zh ? "任务" : "Tasks";

  return (
    <aside
      className={`agentSessionRail ${collapsed ? "collapsed" : ""}`}
      aria-label={title}
      data-testid="loopops.main-agent.sessions"
    >
      <label className="workbenchTaskSearch"><Search size={15} aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={zh ? "搜索任务" : "Search tasks"} aria-label={zh ? "搜索已加载任务" : "Search loaded tasks"} /></label>
      <header className="agentSessionRailHeader"><strong>{zh ? "最近任务" : "Recent tasks"}</strong></header>

      {loading ? (
        <p className="agentSessionRailMessage" role="status">{zh ? "正在加载任务…" : "Loading tasks…"}</p>
      ) : error ? (
        <p className="agentSessionRailMessage error" role="status">
          {zh ? "任务列表暂时无法加载。" : "Tasks could not be loaded."} <button type="button" onClick={onRetry}>{zh ? "重试" : "Retry"}</button>
        </p>
      ) : sessions.length ? (
        <nav className="agentSessionList" aria-label={title} data-testid="loopops.main-agent.session-list">
          {groups.map(([group, items]) => (
            <section className="agentSessionGroup" key={group}>
              {!collapsed ? <h2>{group}</h2> : null}
              {items.map((session) => {
                const loopTask = session.source?.kind === "loop_run";
                const selected = session.sessionId === selectedSessionId;
                return (
                  <button
                    type="button"
                    className={`agentSessionItem ${selected ? "selected" : ""}`}
                    key={session.sessionId}
                    aria-current={selected ? "page" : undefined}
                    aria-label={`${loopTask ? "Loop · " : ""}${session.title} · ${statusLabel(session, locale)}`}
                    title={`${session.title} · ${statusLabel(session, locale)}`}
                    onClick={() => onSelect(session.sessionId)}
                    data-session-id={session.sessionId}
                  >
                    <span className={`agentSessionStatus status-${session.taskStatus}`} aria-hidden="true" />
                    {!collapsed ? (
                      <>
                        <span className="agentSessionText">
                          <strong>
                            {loopTask ? (
                              <CornerUpRight
                                size={13}
                                aria-label={zh ? "Loop 任务" : "Loop task"}
                                data-testid="loopops.agent.loop-task"
                              />
                            ) : null}
                            <span>{session.title}</span>
                          </strong>
                          {!["completed", "idle"].includes(session.taskStatus) ? <small>{statusLabel(session, locale)}</small> : null}
                        </span>
                        <ChevronRight className="agentSessionChevron" size={15} aria-hidden="true" />
                      </>
                    ) : null}
                  </button>
                );
              })}
            </section>
          ))}
          {search && !filtered.length ? <p className="agentSessionRailMessage">{zh ? "已加载任务中没有匹配项。" : "No matches in loaded tasks."}</p> : null}
          {hasMore && !collapsed ? (
            <button
              type="button"
              className="agentSessionLoadMore"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore
                ? (zh ? "正在加载…" : "Loading…")
                : (zh ? "加载更早任务" : "Load earlier tasks")}
            </button>
          ) : null}
        </nav>
      ) : (
        <p className="agentSessionRailMessage">
          {zh
            ? "还没有任务。点击「新任务」开始。"
            : "No tasks yet. Describe an outcome to get started."}
        </p>
      )}
    </aside>
  );
}
