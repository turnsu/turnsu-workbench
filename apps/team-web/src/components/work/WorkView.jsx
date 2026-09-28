import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowLeft,
  Settings2,
  BriefcaseBusiness,
  FolderKanban,
  Plus,
  RefreshCw,
} from "lucide-react";

import { Button, Dialog, TextArea, TextInput } from "../../design-system/index.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";
import { EmptyState } from "../shared/EmptyState.jsx";
import { createStableCreationIntent, isCreationOutcomeUnknown } from "./create-intent.js";
import { WorkItemLoops } from "./WorkItemLoops.jsx";
import { WorkItemActivity } from "./WorkItemActivity.jsx";

function uiId(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function copyFor(locale) {
  return locale === "zh" ? {
    kicker: "团队协作",
    title: "团队工作",
    caption: "一起推进目标，让进展、责任和成果清晰可见。",
    refresh: "刷新",
    syncing: "正在同步…",
    newProject: "新建项目",
    newWorkItem: "新建工作",
    projects: "项目",
    projectScope: "项目范围",
    workQueue: "工作进展",
    workQueueHint: "查看下一步，或接手一项工作继续推进。",
    allWork: "全部工作",
    myWork: "与我有关",
    active: "进行中",
    blocked: "已阻塞",
    review: "待审核",
    completed: "已完成",
    ended: "已结束",
    cancelled: "已取消",
    closeDetail: "关闭详情",
    showing: "当前显示",
    itemUnit: "项",
    noProjects: "还没有项目。可以先创建工作，之后再按项目组织。",
    noWork: "这里还没有工作。写下一个目标，明确负责人，一起开始。",
    privateTask: "私人任务",
    privateTaskHint: "先在私人任务中处理，准备好后再分享成果。",
    boundaryTitle: "团队看得到成果，私人对话仍然保密",
    boundaryHint: "只分享你明确提交的交接、决定和文件。",
    startPrivateTask: "开始私人任务",
    createProjectTitle: "新建项目",
    createWorkTitle: "新建工作",
    titleLabel: "标题",
    objectiveLabel: "目标",
    summaryLabel: "交接说明",
    priorityLabel: "优先级",
    projectLabel: "项目（可选）",
    membersLabel: "成员",
    membersHint: "选择可以查看和协作的成员。",
    noDirectory: "还没有其他成员，你可以先自己开始。",
    create: "创建",
    creating: "创建中…",
    cancel: "取消",
    manageMembers: "管理项目成员",
    saveMembers: "保存成员",
    saving: "保存中…",
    projectMembers: "项目成员",
    owner: "负责人",
    due: "到期时间",
    noDue: "未设到期时间",
    priority: "优先级",
    status: "状态",
    ownerLabel: "负责人",
    nextAction: "下一步",
    blockedReason: "阻塞原因",
    update: "更新",
    updating: "更新中…",
    open: "查看",
    continue: "交给 Agent 继续",
    continueShort: "继续处理",
    handoffAndProgress: "交接与进展",
    continuing: "正在准备你的任务…",
    sharedBoundary: "这份工作只包含已共享的信息；你的私人对话不会自动分享。",
    projectCreated: "项目已创建。",
    workCreated: "工作已创建。",
    creationOutcomeUnknown: "结果暂未确认。保持当前内容并再次创建时，系统会复用同一请求，不会新建重复项。",
    workUpdated: "工作已更新。",
    membersSaved: "项目成员已更新。",
    updateUnavailable: "你可以查看这项工作，但暂时不能修改。",
    projectUnavailable: "项目未找到或你没有访问权限。",
    openProject: "打开项目",
    clearProject: "显示全部项目",
    teamWork: "团队工作",
    member: "成员",
    noNextAction: "尚未明确下一步",
    staleTitle: "当前显示的是上次同步结果",
    staleHint: "最新刷新失败，但当前数据、筛选和选择仍被保留。可以继续查看或再次同步。",
    you: "我",
    contributor: "可协作",
    viewer: "只读",
    draft: "草稿",
    ready: "待开始",
    waiting_review: "等待审核",
    urgent: "紧急",
    high: "高",
    medium: "中",
    low: "低",
  } : {
    kicker: "Team collaboration",
    title: "Team Work",
    caption: "Keep goals, progress, ownership and outcomes clear.",
    refresh: "Refresh",
    syncing: "Syncing…",
    newProject: "New Project",
    newWorkItem: "New work",
    projects: "Projects",
    projectScope: "Project scope",
    workQueue: "Work in progress",
    workQueueHint: "Review the next step or pick up work and keep it moving.",
    allWork: "All Work",
    myWork: "My Work",
    active: "Active",
    blocked: "Blocked",
    review: "Review",
    completed: "Completed",
    ended: "Ended",
    cancelled: "Cancelled",
    closeDetail: "Close details",
    showing: "Showing",
    itemUnit: "items",
    noProjects: "You do not have access to a Project yet. An Owner or Admin can create one and add members explicitly.",
    noWork: "No shared Work Item matches this view yet. A new item keeps a safe handoff and accountable owner—not private conversation history.",
    privateTask: "Private task",
    privateTaskHint: "Start in your personal Session only; you can later promote a safe summary deliberately.",
    boundaryTitle: "Shared work, private execution",
    boundaryHint: "Only handoffs, decisions and files you explicitly share appear here.",
    startPrivateTask: "Start private task",
    createProjectTitle: "New Project",
    createWorkTitle: "New work",
    titleLabel: "Title",
    objectiveLabel: "Objective",
    summaryLabel: "Handoff notes",
    priorityLabel: "Priority",
    projectLabel: "Project (optional)",
    membersLabel: "Members",
    membersHint: "Only explicitly selectable current-workspace members appear here. Project membership remains editable after creation.",
    noDirectory: "No other member is available to add yet. You can still create a Project or Work Item for yourself.",
    create: "Create",
    creating: "Creating…",
    cancel: "Cancel",
    manageMembers: "Manage Project members",
    saveMembers: "Save members",
    saving: "Saving…",
    projectMembers: "Project members",
    owner: "Owner",
    due: "Due",
    noDue: "No due date",
    priority: "Priority",
    status: "Status",
    ownerLabel: "Accountable owner",
    nextAction: "Next action",
    blockedReason: "Blocked reason",
    update: "Update",
    updating: "Updating…",
    open: "Open",
    continue: "Continue in my private task",
    continueShort: "Continue",
    handoffAndProgress: "Handoff and progress",
    continuing: "Creating your branch…",
    sharedBoundary: "The team can see the Work Item, handoff, Decisions, shared Artifacts, and notes. Private prompts, Sessions, and credentials never appear here.",
    projectCreated: "Project created.",
    workCreated: "Team Work Item created.",
    creationOutcomeUnknown: "The result is not confirmed yet. Submit the unchanged form again to recover the same request without creating a duplicate.",
    workUpdated: "Work Item updated.",
    membersSaved: "Project members updated.",
    updateUnavailable: "You can view this Work Item, but cannot update it.",
    projectUnavailable: "The Project is unavailable or you do not have access.",
    openProject: "Open Project",
    clearProject: "Show all Projects",
    teamWork: "Team Work",
    member: "Member",
    noNextAction: "Next action not set",
    staleTitle: "Showing the last synced result",
    staleHint: "The latest refresh failed, but current data, filters, and selection were preserved. Keep reviewing or sync again.",
    you: "You",
    contributor: "Contributor",
    viewer: "View only",
    draft: "Draft",
    ready: "Ready",
    waiting_review: "Waiting review",
    urgent: "Urgent",
    high: "High",
    medium: "Medium",
    low: "Low",
  };
}

function label(value, copy) {
  return copy[value] || String(value || "").replaceAll("_", " ");
}

function displayName(member, currentUserId, copy) {
  if (member.userId === currentUserId) return `${member.displayName || member.username} · ${copy.owner}`;
  return member.displayName || member.username || member.userId;
}

function memberNames(item, directory, currentUserId) {
  const lookup = new Map([
    ...directory.map((member) => [member.userId, member.displayName || member.username || member.userId]),
    [currentUserId, currentUserId],
  ]);
  return (item.members || []).map((member) => lookup.get(member.userId) || member.userId).join(" · ");
}

function toIsoEndOfDay(value) {
  if (!value) return null;
  const timestamp = Date.parse(`${value}T23:59:59.999Z`);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function toDateInput(value) {
  return value ? String(value).slice(0, 10) : "";
}

function memberRole(item, userId) {
  return item?.members?.find((member) => member.userId === userId) || null;
}

function workItemCanManage(item, workspace) {
  if (item?.source?.kind !== "team_work_item") return false;
  const own = memberRole(item, workspace.principal.userId);
  return ["owner", "admin"].includes(workspace.membershipRole)
    || (item.accountableOwnerUserId === workspace.principal.userId && own?.accessGrant?.access === "owner");
}

function statusOptions(current) {
  const transitions = {
    draft: ["ready", "cancelled"],
    ready: ["active", "blocked", "cancelled"],
    active: ["waiting_review", "blocked", "cancelled"],
    waiting_review: ["active", "completed", "cancelled"],
    blocked: ["active", "cancelled"],
    completed: ["active"],
    cancelled: [],
  };
  return [current, ...(transitions[current] || [])];
}

function ProjectCreateDialog({ workspace, copy }) {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [memberIds, setMemberIds] = useState([]);
  const [error, setError] = useState("");
  const intent = useRef(createStableCreationIntent({ kind: "project-create" }));
  const pending = workspace.teamWorkMutations.createProject.isPending;

  useEffect(() => {
    if (workspace.createMode === "project") {
      intent.current.begin();
      setError("");
    } else {
      intent.current.reset();
    }
  }, [workspace.createMode]);

  async function submit(event) {
    event.preventDefault();
    if (!title.trim() || !objective.trim()) return;
    setError("");
    const data = { title: title.trim(), objective: objective.trim(), members: memberIds.map((userId) => ({ userId })) };
    try {
      const result = await workspace.teamWorkMutations.createProject.mutateAsync({
        principal: workspace.principal,
        idempotencyKey: intent.current.keyFor(data),
        data,
      });
      intent.current.reset();
      workspace.pushToast(copy.projectCreated);
      workspace.closeCreate();
      workspace.selectProject(result.data.projectId);
      setTitle(""); setObjective(""); setMemberIds([]);
    } catch (cause) {
      setError(`${cause?.message || copy.projectUnavailable}${isCreationOutcomeUnknown(cause) ? ` ${copy.creationOutcomeUnknown}` : ""}`);
    }
  }

  return (
    <Dialog
      open={workspace.createMode === "project"}
      title={copy.createProjectTitle}
      onClose={() => !pending && workspace.closeCreate()}
      initialFocusSelector="[data-testid='loopops.work.project.title']"
      returnFocusSelector="[data-testid='loopops.work.create-project']"
      actions={<><Button variant="secondary" onClick={workspace.closeCreate} disabled={pending}>{copy.cancel}</Button><Button type="submit" form="work-project-create" variant="primary" disabled={pending || !title.trim() || !objective.trim()}>{pending ? copy.creating : copy.create}</Button></>}
    >
      <form id="work-project-create" className="workForm" onSubmit={submit}>
        <TextInput label={copy.titleLabel} hiddenLabel={false} value={title} onChange={setTitle} maxLength={200} required data-testid="loopops.work.project.title" />
        <TextArea label={copy.objectiveLabel} hiddenLabel={false} value={objective} onChange={setObjective} rows={3} maxLength={2_000} required />
        <MemberSelection copy={copy} directory={workspace.participantDirectory} selected={memberIds} onChange={setMemberIds} currentUserId={workspace.principal.userId} />
        {error ? <p className="workFormError" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}

function MemberSelection({ copy, directory, selected, onChange, currentUserId }) {
  return (
    <fieldset className="workMemberSelection">
      <legend>{copy.membersLabel}</legend>
      <p>{copy.membersHint}</p>
      {directory.length ? <div>{directory.map((member) => {
        const checked = selected.includes(member.userId);
        return <label key={member.userId}><input type="checkbox" checked={checked} onChange={() => onChange(checked ? selected.filter((id) => id !== member.userId) : [...selected, member.userId])} /><span>{displayName(member, currentUserId, copy)}</span></label>;
      })}</div> : <p>{copy.noDirectory}</p>}
    </fieldset>
  );
}

function WorkItemCreateDialog({ workspace, copy }) {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [summary, setSummary] = useState("");
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState("medium");
  const [dueAt, setDueAt] = useState("");
  const [memberIds, setMemberIds] = useState([]);
  const [error, setError] = useState("");
  const intent = useRef(createStableCreationIntent({ kind: "team-work-create" }));
  const pending = workspace.teamWorkMutations.createTeamWorkItem.isPending;

  useEffect(() => {
    if (workspace.createMode === "work-item") {
      intent.current.begin();
      setProjectId(workspace.selectedProjectId || "");
      setError("");
    } else {
      intent.current.reset();
    }
  }, [workspace.createMode, workspace.selectedProjectId]);

  async function submit(event) {
    event.preventDefault();
    if (!title.trim() || !objective.trim() || !summary.trim()) return;
    setError("");
    const data = {
      projectId: projectId || null,
      title: title.trim(), objective: objective.trim(), summary: summary.trim(), priority,
      dueAt: toIsoEndOfDay(dueAt),
      members: memberIds.map((userId) => ({ userId, access: "contribute", roles: ["participant"] })),
    };
    try {
      const result = await workspace.teamWorkMutations.createTeamWorkItem.mutateAsync({
        principal: workspace.principal,
        idempotencyKey: intent.current.keyFor(data),
        data,
      });
      intent.current.reset();
      workspace.pushToast(copy.workCreated);
      workspace.closeCreate();
      workspace.selectWorkItem(result.data.workItemId);
      setTitle(""); setObjective(""); setSummary(""); setDueAt(""); setMemberIds([]);
    } catch (cause) {
      setError(`${cause?.message || copy.updateUnavailable}${isCreationOutcomeUnknown(cause) ? ` ${copy.creationOutcomeUnknown}` : ""}`);
    }
  }

  return (
    <Dialog
      open={workspace.createMode === "work-item"}
      title={copy.createWorkTitle}
      onClose={() => !pending && workspace.closeCreate()}
      initialFocusSelector="[data-testid='loopops.work.item.title']"
      returnFocusSelector="[data-testid='loopops.work.create-work-item']"
      actions={<><Button variant="secondary" onClick={workspace.closeCreate} disabled={pending}>{copy.cancel}</Button><Button type="submit" form="work-item-create" variant="primary" disabled={pending || !title.trim() || !objective.trim() || !summary.trim()}>{pending ? copy.creating : copy.create}</Button></>}
    >
      <form id="work-item-create" className="workForm" onSubmit={submit}>
        <TextInput label={copy.titleLabel} hiddenLabel={false} value={title} onChange={setTitle} maxLength={200} required data-testid="loopops.work.item.title" />
        <TextArea label={copy.objectiveLabel} hiddenLabel={false} value={objective} onChange={setObjective} rows={3} maxLength={2_000} required />
        <TextArea label={copy.summaryLabel} hiddenLabel={false} value={summary} onChange={setSummary} rows={3} maxLength={8_000} required />
        <div className="workFormGrid">
          <label><span>{copy.projectLabel}</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">{copy.teamWork}</option>{workspace.projects.map((project) => <option value={project.projectId} key={project.projectId}>{project.title}</option>)}</select></label>
          <label><span>{copy.priorityLabel}</span><select value={priority} onChange={(event) => setPriority(event.target.value)}>{["low", "medium", "high", "urgent"].map((value) => <option value={value} key={value}>{label(value, copy)}</option>)}</select></label>
          <label><span>{copy.due}</span><input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
        </div>
        <MemberSelection copy={copy} directory={workspace.participantDirectory} selected={memberIds} onChange={setMemberIds} currentUserId={workspace.principal.userId} />
        {error ? <p className="workFormError" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}

function ProjectMemberDialog({ workspace, project, copy, onClose }) {
  const [memberIds, setMemberIds] = useState(() => project.members.filter((member) => member.userId !== workspace.principal.userId).map((member) => member.userId));
  const [error, setError] = useState("");
  const pending = workspace.teamWorkMutations.reviseProjectMembers.isPending;
  const canManage = ["owner", "admin"].includes(workspace.membershipRole) || project.accountableOwnerUserId === workspace.principal.userId;

  useEffect(() => {
    setMemberIds(project.members.filter((member) => member.userId !== workspace.principal.userId).map((member) => member.userId));
    setError("");
  }, [project.projectId, project.members, workspace.principal.userId]);

  async function save() {
    setError("");
    try {
      await workspace.teamWorkMutations.reviseProjectMembers.mutateAsync({
        principal: workspace.principal,
        projectId: project.projectId,
        ifMatch: project.etag,
        idempotencyKey: uiId("project-members"),
        data: { members: memberIds.map((userId) => ({ userId })) },
      });
      workspace.pushToast(copy.membersSaved);
      onClose();
    } catch (cause) {
      setError(cause?.message || copy.projectUnavailable);
    }
  }

  return (
    <Dialog
      open={Boolean(project)}
      title={copy.projectMembers}
      onClose={() => !pending && onClose()}
      actions={<><Button variant="secondary" onClick={onClose} disabled={pending}>{copy.cancel}</Button>{canManage ? <Button variant="primary" onClick={save} disabled={pending}>{pending ? copy.saving : copy.saveMembers}</Button> : null}</>}
    >
      <p className="workDialogHint">{project.title}</p>
      {canManage ? <MemberSelection copy={copy} directory={workspace.participantDirectory} selected={memberIds} onChange={setMemberIds} currentUserId={workspace.principal.userId} /> : <ProjectMemberList project={project} copy={copy} />}
      {error ? <p className="workFormError" role="alert">{error}</p> : null}
    </Dialog>
  );
}

function ProjectMemberList({ project, copy }) {
  return <ul className="workMemberList">{project.members.map((member) => <li key={member.userId}><span>{member.userId}</span><StatusPill>{member.role === "owner" ? copy.owner : copy.member}</StatusPill></li>)}</ul>;
}

function ProjectCard({ project, workspace, copy, selected, itemCount }) {
  return (
    <button type="button" className={`projectCard ${selected ? "selected" : ""}`} onClick={() => workspace.selectProject(project.projectId)} aria-pressed={selected}>
      <span className="projectCardIcon"><FolderKanban size={16} aria-hidden="true" /></span>
      <span className="projectCardCopy"><strong>{project.title}</strong><small>{project.objective}</small><span>{itemCount} {copy.itemUnit} · {project.members.length} {copy.member}</span></span>
      <ArrowRight size={14} aria-hidden="true" />
    </button>
  );
}

function WorkItemCard({ item, workspace, copy, selected, projectTitle }) {
  const currentMember = memberRole(item, workspace.principal.userId);
  const canContinue = ["owner", "contribute"].includes(currentMember?.accessGrant?.access);
  const owner = workspace.participantDirectory.find((member) => member.userId === item.accountableOwnerUserId);
  const ownerName = item.accountableOwnerUserId === workspace.principal.userId
    ? copy.you
    : owner?.displayName || owner?.username || item.accountableOwnerUserId;

  function continueItem(event) {
    event.stopPropagation();
    workspace.continueInPrivateBranch(item.workItemId);
  }

  return (
    <article className={`workItemCard ${selected ? "selected" : ""}`} data-testid={`loopops.work.item.${item.workItemId}`}>
      <button type="button" className="workItemCardMain" onClick={() => workspace.selectWorkItem(item.workItemId)} aria-pressed={selected}>
        <span className={`workItemStatusRail status-${item.status}`} aria-hidden="true" />
        <span className="workItemIdentity">
          <span className="workItemEyebrow"><StatusPill>{label(item.status, copy)}</StatusPill>{["urgent", "high"].includes(item.priority) ? <StatusPill tone="warning">{label(item.priority, copy)}</StatusPill> : null}<span>{projectTitle || copy.teamWork}</span></span>
          <strong>{item.title}</strong>
          <small>{item.objective}</small>
        </span>
        <span className="workItemCell workItemOwner"><small>{copy.ownerLabel}</small><strong>{ownerName}</strong></span>
        {item.nextAction ? <span className="workItemCell workItemNext"><small>{copy.nextAction}</small><strong>{item.nextAction}</strong></span> : null}
        {item.dueAt ? <span className="workItemCell workItemDue"><small>{copy.due}</small><strong>{new Date(item.dueAt).toLocaleDateString(workspace.locale)}</strong></span> : null}
        <ArrowRight className="workItemOpen" size={16} aria-hidden="true" />
      </button>
      {canContinue ? <div className="workItemCardActions"><Button variant="plain" size="sm" onClick={continueItem} title={copy.continue}>{copy.continueShort}</Button></div> : null}
    </article>
  );
}

function WorkItemDetail({ workspace, item, copy }) {
  const detailRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const zh = workspace.locale.startsWith("zh");
  const [status, setStatus] = useState(item.status);
  const [priority, setPriority] = useState(item.priority);
  const [ownerUserId, setOwnerUserId] = useState(item.accountableOwnerUserId);
  const [dueAt, setDueAt] = useState(toDateInput(item.dueAt));
  const [nextAction, setNextAction] = useState(item.nextAction || "");
  const [blockedReason, setBlockedReason] = useState(item.blockedReason || "");
  const [error, setError] = useState("");
  const pending = workspace.teamWorkMutations.updateTeamWorkItem.isPending;
  const canManage = workItemCanManage(item, workspace);
  const currentMember = memberRole(item, workspace.principal.userId);
  const canContinue = ["owner", "contribute"].includes(currentMember?.accessGrant?.access);

  useEffect(() => {
    detailRef.current?.focus({ preventScroll: true });
    detailRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [item.workItemId]);

  useEffect(() => {
    setStatus(item.status); setPriority(item.priority); setOwnerUserId(item.accountableOwnerUserId);
    setDueAt(toDateInput(item.dueAt)); setNextAction(item.nextAction || ""); setBlockedReason(item.blockedReason || ""); setError("");
  }, [item.workItemId, item.status, item.priority, item.accountableOwnerUserId, item.dueAt, item.nextAction, item.blockedReason, editing]);

  async function update(event) {
    event.preventDefault();
    if (!canManage) return;
    if (status === "blocked" && !blockedReason.trim()) {
      setError(copy.blockedReason);
      return;
    }
    setError("");
    try {
      await workspace.teamWorkMutations.updateTeamWorkItem.mutateAsync({
        principal: workspace.principal,
        workItemId: item.workItemId,
        ifMatch: item.etag,
        idempotencyKey: uiId("team-work-update"),
        data: {
          status,
          priority,
          accountableOwnerUserId: ownerUserId,
          dueAt: toIsoEndOfDay(dueAt),
          blockedReason: status === "blocked" ? blockedReason.trim() : null,
          nextAction: nextAction.trim() || null,
        },
      });
      workspace.pushToast(copy.workUpdated);
      setEditing(false);
    } catch (cause) {
      setError(cause?.message || copy.updateUnavailable);
    }
  }

  async function continueItem() {
    setError("");
    workspace.continueInPrivateBranch(item.workItemId);
  }

  return (
    <section className="workDetail" aria-label={item.title} ref={detailRef} tabIndex={-1}>
      <nav className="workDetailNavigation" aria-label={zh ? "工作导航" : "Work navigation"}>
        <Button variant="plain" size="sm" icon={<ArrowLeft size={15} />} onClick={() => workspace.selectWorkItem("")}>{zh ? "返回工作列表" : "Back to work"}</Button>
        {canManage ? <Button variant="plain" size="sm" icon={<Settings2 size={15} />} onClick={() => setEditing(true)}>{zh ? "管理工作" : "Manage work"}</Button> : null}
      </nav>
      <header><h2>{item.title}</h2></header>
      <p className="workDetailObjective">{item.objective}</p>
      <div className="workDetailMeta"><StatusPill>{label(item.status, copy)}</StatusPill><span>{copy.owner} · {item.accountableOwnerUserId === workspace.principal.userId ? copy.you : memberNames({ members: [{ userId: item.accountableOwnerUserId }] }, workspace.participantDirectory, workspace.principal.userId)}</span><span>{item.members.length} {copy.member}</span>{item.dueAt ? <span>{copy.due} · {new Date(item.dueAt).toLocaleDateString(workspace.locale)}</span> : null}</div>
      {item.nextAction || item.blockedReason ? <section className="workDetailFocus" aria-label={copy.nextAction}>
        {item.nextAction ? <span><small>{copy.nextAction}</small><strong>{item.nextAction}</strong></span> : null}
        {item.status === "blocked" && item.blockedReason ? <span className="blocked"><small>{copy.blockedReason}</small><strong>{item.blockedReason}</strong></span> : null}
      </section> : null}
      <div className="workDetailActions">{canContinue ? <Button variant="primary" onClick={continueItem}>{copy.continueShort}</Button> : null}
      </div>
      <WorkItemLoops key={item.workItemId} workspace={workspace} item={item} canRun={canContinue} />
      <WorkItemActivity key={`activity:${item.workItemId}`} workspace={workspace} item={item} canContribute={canContinue} />
      <Dialog open={editing} title={zh ? "管理工作" : "Manage work"} onClose={() => !pending && setEditing(false)}
        actions={<><Button variant="plain" disabled={pending} onClick={() => setEditing(false)}>{copy.cancel}</Button><Button form="work-details-edit" type="submit" variant="primary" disabled={pending}>{pending ? copy.updating : copy.update}</Button></>}>
      <form id="work-details-edit" className="workUpdateForm" onSubmit={update}>
        <label><span>{copy.status}</span><select value={status} onChange={(event) => setStatus(event.target.value)}>{statusOptions(item.status).map((value) => <option value={value} key={value}>{label(value, copy)}</option>)}</select></label>
        <label><span>{copy.priority}</span><select value={priority} onChange={(event) => setPriority(event.target.value)}>{["low", "medium", "high", "urgent"].map((value) => <option value={value} key={value}>{label(value, copy)}</option>)}</select></label>
        <label><span>{copy.ownerLabel}</span><select value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)}>{item.members.map((member) => <option value={member.userId} key={member.userId}>{member.userId === workspace.principal.userId ? copy.you : memberNames({ members: [member] }, workspace.participantDirectory, workspace.principal.userId)}</option>)}</select></label>
        <label><span>{copy.due}</span><input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
        <TextArea label={copy.nextAction} hiddenLabel={false} value={nextAction} onChange={setNextAction} rows={2} maxLength={2_000} />
        {status === "blocked" ? <TextArea label={copy.blockedReason} hiddenLabel={false} value={blockedReason} onChange={setBlockedReason} rows={2} maxLength={2_000} required /> : null}
        {error ? <p className="workFormError" role="alert">{error}</p> : null}
      </form></Dialog>
    </section>
  );
}

export function WorkView({ workspace }) {
  const copy = copyFor(workspace.locale);
  const [memberDialogProjectId, setMemberDialogProjectId] = useState("");
  const selectedProject = workspace.selectedProject || workspace.projects.find((project) => project.projectId === workspace.selectedProjectId) || null;
  const memberDialogProject = memberDialogProjectId && workspace.selectedProject?.projectId === memberDialogProjectId
    ? workspace.selectedProject
    : null;
  const selectedItem = workspace.selectedWorkItem || null;
  const listRef = useRef(null);
  const previousSelection = useRef(workspace.selectedWorkItemId);
  useEffect(() => {
    if (previousSelection.current && !workspace.selectedWorkItemId) {
      listRef.current?.focus({ preventScroll: true });
    }
    previousSelection.current = workspace.selectedWorkItemId;
  }, [workspace.selectedWorkItemId]);
  const filter = workspace.workFilter || "all";
  const scopedItems = workspace.workItems.filter((item) => !workspace.selectedProjectId || item.projectId === workspace.selectedProjectId);
  const filteredItems = scopedItems.filter((item) => {
    if (filter === "my") return item.members.some((member) => (
      member.userId === workspace.principal.userId
        && ["accountable_owner", "requestor", "assignee", "reviewer", "participant"].some(
          (role) => member.roles?.includes(role),
        )
    ));
    if (filter === "active") return item.status === "active";
    if (filter === "blocked") return item.status === "blocked";
    if (filter === "review") return item.status === "waiting_review";
    if (filter === "completed") return ["completed", "cancelled"].includes(item.status);
    return true;
  });
  const projectNames = new Map(workspace.projects.map((project) => [project.projectId, project.title]));
  const filterOptions = [
    ["all", copy.allWork, scopedItems.length],
    ["my", copy.myWork, scopedItems.filter((item) => item.members.some((member) => member.userId === workspace.principal.userId)).length],
    ["active", copy.active, scopedItems.filter((item) => item.status === "active").length],
    ["blocked", copy.blocked, scopedItems.filter((item) => item.status === "blocked").length],
    ["review", copy.review, scopedItems.filter((item) => item.status === "waiting_review").length],
    ["completed", copy.ended, scopedItems.filter((item) => ["completed", "cancelled"].includes(item.status)).length],
  ];

  if (workspace.teamWorkState.loading && !workspace.projects.length && !workspace.workItems.length) {
    return <EmptyState title={copy.title} body={copy.caption} testId="loopops.work.loading" />;
  }
  if (workspace.teamWorkState.error) {
    return <EmptyState title={copy.title} body={workspace.teamWorkState.error.message || copy.projectUnavailable} actionLabel={copy.refresh} onAction={workspace.retry} testId="loopops.work.error" />;
  }

  return (
    <div className={`surface workPage ${selectedItem ? "detailOpen" : ""}`} data-testid="loopops.work.page">
      <header className="workHeader">
        <div><h1>{copy.title}</h1></div>
        <div className="workHeaderActions">
          {workspace.teamWorkState.fetching ? <span className="workSyncState" role="status">{copy.syncing}</span> : null}
          <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={workspace.retry} disabled={workspace.teamWorkState.fetching}>{copy.refresh}</Button>
          {workspace.canCreateProject ? <Button variant="secondary" icon={<FolderKanban size={15} />} onClick={() => workspace.openCreate("project")} data-testid="loopops.work.create-project">{copy.newProject}</Button> : null}
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => workspace.openCreate("work-item")} disabled={!workspace.canCreateWorkItem} data-testid="loopops.work.create-work-item">{copy.newWorkItem}</Button>
        </div>
      </header>
      {workspace.teamWorkState.staleError ? <section className="workStaleBanner" role="status"><div><strong>{copy.staleTitle}</strong><span>{copy.staleHint}</span></div><Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={workspace.retryStaleSurface} disabled={workspace.teamWorkState.fetching}>{copy.refresh}</Button></section> : null}
      <div className="workBoard">
        <aside className="workProjects" aria-label={copy.projects}>
          <div className="workSectionHeading"><h2>{copy.projects}</h2></div>
          <button type="button" className={!workspace.selectedProjectId ? "workProjectAll active" : "workProjectAll"} onClick={() => workspace.selectProject("")}><BriefcaseBusiness size={15} /><span>{copy.allWork}</span><small>{workspace.workItems.length}</small></button>
          <div className="projectCardList">{workspace.projects.map((project) => <ProjectCard key={project.projectId} project={project} workspace={workspace} copy={copy} selected={project.projectId === workspace.selectedProjectId} itemCount={workspace.workItems.filter((item) => item.projectId === project.projectId).length} />)}</div>
          {!workspace.projects.length ? <p className="workEmptyNote">{copy.noProjects}</p> : null}
        </aside>
        {!workspace.selectedWorkItemId ? <section className="workList" id="work-item-list" ref={listRef} tabIndex={-1} aria-label={copy.allWork}>
          {selectedProject ? <section className="workScopeSummary"><div><p>{copy.projectScope}</p><h2>{selectedProject.title}</h2><span>{selectedProject.objective}</span></div><div><span>{selectedProject.members.length} {copy.member}</span><Button variant="plain" size="sm" onClick={() => setMemberDialogProjectId(selectedProject.projectId)} disabled={!workspace.selectedProject || workspace.selectedProjectState.isFetching}>{copy.manageMembers}</Button></div></section> : null}
          <div className="workListHeader"><div>{!selectedProject ? <h2>{copy.workQueue}</h2> : null}</div><span className="workResultCount" aria-live="polite">{copy.showing} <strong>{filteredItems.length}</strong> {copy.itemUnit}</span></div>
          <div className="workFilters" role="group" aria-label={copy.allWork}>{filterOptions.filter(([value, , count]) => count > 0 || ["all", "my", filter].includes(value)).map(([value, text, count]) => <button type="button" key={value} className={filter === value ? "active" : ""} onClick={() => workspace.selectWorkFilter(value)} aria-pressed={filter === value}><span>{text}</span><strong>{count}</strong></button>)}</div>
          {filteredItems.length ? <div className="workItemGrid">{filteredItems.map((item) => <WorkItemCard key={item.workItemId} item={item} workspace={workspace} copy={copy} selected={item.workItemId === workspace.selectedWorkItemId} projectTitle={projectNames.get(item.projectId)} />)}</div> : <div className="workEmptyNote"><p>{copy.noWork}</p>{workspace.canCreateWorkItem ? <Button variant="secondary" size="sm" onClick={() => workspace.openCreate("work-item")}>{copy.newWorkItem}</Button> : null}</div>}
        </section> : null}
        {workspace.selectedWorkItemId ? workspace.selectedWorkItemState.isLoading ? <aside className="workDetail"><p role="status">{copy.refresh}</p></aside> : selectedItem ? <WorkItemDetail workspace={workspace} item={selectedItem} copy={copy} /> : <aside className="workDetail"><p role="alert">{copy.updateUnavailable}</p></aside> : null}
      </div>
      <ProjectCreateDialog workspace={workspace} copy={copy} />
      <WorkItemCreateDialog workspace={workspace} copy={copy} />
      {memberDialogProject ? <ProjectMemberDialog workspace={workspace} project={memberDialogProject} copy={copy} onClose={() => setMemberDialogProjectId("")} /> : null}
    </div>
  );
}
