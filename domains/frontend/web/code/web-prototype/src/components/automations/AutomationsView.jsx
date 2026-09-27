import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  CalendarClock,
  CirclePause,
  CirclePlay,
  Clock3,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Plus,
  Search,
  ChevronRight,
  ChevronDown,
} from "lucide-react";

import { Button, Dialog } from "../../design-system/index.jsx";
import { EmptyState } from "../shared/EmptyState.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";

// This screen grants unattended *Workflow Runs*, not a broad policy editor.
// The API still supports all PRD effect classes, while this focused flow only
// offers the one class the Automation lifecycle consumes.
const defaultBudget = Object.freeze({ maxCostUsdMicros: 1_000_000, maxRuntimeSeconds: 600 });

function idempotencyKey(kind) {
  return `${kind}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function localCopy(locale, zh, en) {
  return locale === "zh" ? zh : en;
}

function formatDate(value, locale, timeZone) {
  if (!value) return localCopy(locale, "尚未安排", "Not scheduled");
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) })
    : value;
}

function automationRunPath(occurrence) {
  if (!occurrence?.workflowId || !occurrence?.runId) return "";
  return `/loops/${encodeURIComponent(occurrence.workflowId)}/runs/${encodeURIComponent(occurrence.runId)}`;
}

function visibleOccurrences(occurrences, requestedOccurrenceId) {
  if (!requestedOccurrenceId) return occurrences.slice(0, 3);
  const requested = occurrences.find((occurrence) => occurrence.occurrenceId === requestedOccurrenceId);
  if (!requested) return occurrences.slice(0, 3);
  return [
    requested,
    ...occurrences.filter((occurrence) => occurrence.occurrenceId !== requestedOccurrenceId),
  ].slice(0, 3);
}

function unattended(scope) {
  const policy = scope?.policy?.defaultPermission;
  return policy?.mode === "auto"
    ? policy.autoApprovedEffectClasses?.includes("execute") === true
    : policy?.mode === "custom"
      ? policy.autoApprovedActionIds?.includes("workflow_run") === true
      : false;
}

function initialGrantExpiryIso() {
  const value = new Date();
  // The server deliberately caps unattended authority at 90 days. A short,
  // visible initial grant keeps the default usable without silently creating a
  // grant that every real Product API rejects.
  value.setDate(value.getDate() + 30);
  return value.toISOString();
}

function dailyTime(expression) {
  const [minute = "00", hour = "09"] = String(expression || "").split(" ");
  return {
    hour: /^\d{1,2}$/.test(hour) ? hour.padStart(2, "0") : "09",
    minute: /^\d{1,2}$/.test(minute) ? minute.padStart(2, "0") : "00",
  };
}

function localDateTimeValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const part = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

function utcDateTimeValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function eligibleConnections(requirement, connections) {
  const byId = new Map(connections.map((connection) => [connection.connectionId, connection]));
  return (requirement.eligibleConnectionIds || [])
    .map((connectionId) => byId.get(connectionId))
    .filter(Boolean);
}

function sameConnectionSelections(left, right) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => left[key] === right[key]);
}

function ScopePermission({ workspace, scope }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const copy = (zh, en) => localCopy(workspace.locale, zh, en);
  if (!scope || unattended(scope)) return null;
  async function allow() {
    setSaving(true); setError("");
    try {
      const previous = scope.policy.defaultPermission;
      await workspace.automationMutations.reviseScopePolicy.mutateAsync({
        scopeId: scope.scopeId, ifMatch: scope.etag, idempotencyKey: idempotencyKey("scope-policy"),
        data: { observationTier: scope.policy.observationTier, defaultPermission: {
          ...(previous.mode === "auto"
            ? { mode: "auto", autoApprovedEffectClasses: [...new Set([...(previous.autoApprovedEffectClasses || []), "execute"])] }
            : { mode: "custom", autoApprovedActionIds: [...new Set([...(previous.mode === "custom" ? previous.autoApprovedActionIds : []), "workflow_run"])] }),
        } },
      });
    } catch (cause) { setError(cause?.message || copy("未能保存权限，请重试。", "Could not save permission. Try again.")); }
    finally { setSaving(false); }
  }
  return <section className="automationPermission">
    <ShieldCheck size={18} aria-hidden="true" /><div><strong>{copy("允许在后台执行", "Allow background runs")}</strong>
      <p>{copy("定时任务需要在你离线时运行。此设置允许你的个人工作流无需逐次确认即可执行；其他操作仍遵循原有权限。", "Scheduled tasks need to run while you are away. This setting allows your personal workflows to run without asking each time; other permissions remain unchanged.")}</p>
      <Button variant="secondary" onClick={allow} disabled={saving || !workspace.canManageAutomations} data-testid="loopops.automations.policy.save">{saving ? copy("正在保存…", "Saving…") : copy("允许我的工作流后台运行", "Allow my workflows to run in the background")}</Button>
      {error ? <p className="automationError" role="alert">{error}</p> : null}</div>
  </section>;
}

function AutomationCreateDialog({ workspace, onClose, onCreated }) {
  const copy = (zh, en) => localCopy(workspace.locale, zh, en);
  const scope = workspace.automationScope;
  const available = workspace.candidates.filter((candidate) => candidate.scopeId === scope?.scopeId);
  const [candidateId, setCandidateId] = useState(available[0]?.loopVersionId || "");
  const [displayName, setDisplayName] = useState("");
  const [time, setTime] = useState("09:00");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [misfire, setMisfire] = useState("run_once");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [connectionSelections, setConnectionSelections] = useState({});
  const candidate = available.find((item) => item.loopVersionId === candidateId) || available[0] || null;
  const requirements = candidate?.connectionRequirements || [];
  const optionsByRequirement = useMemo(() => new Map(requirements.map((item) => [item.requirementId, eligibleConnections(item, workspace.connections)])), [candidate, workspace.connections]);
  useEffect(() => {
    setConnectionSelections((current) => {
      const next = Object.fromEntries(requirements.map((item) => [item.requirementId, (optionsByRequirement.get(item.requirementId) || []).some((connection) => connection.connectionId === current[item.requirementId]) ? current[item.requirementId] : ""]));
      return sameConnectionSelections(current, next) ? current : next;
    });
  }, [candidate, optionsByRequirement]);
  const missingConnection = requirements.some((item) => !(optionsByRequirement.get(item.requirementId) || []).some((connection) => connection.connectionId === connectionSelections[item.requirementId]));
  const ready = workspace.canManageAutomations && Boolean(candidate) && unattended(scope) && !missingConnection;
  async function create(event) {
    event.preventDefault();
    if (!ready || creating) return;
    const [hour, minute] = time.split(":").map(Number);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) { setError(copy("请选择每天的运行时间。", "Choose a daily run time.")); return; }
    try { new Intl.DateTimeFormat("en", { timeZone: timezone.trim() }); }
    catch { setError(copy("时区无效，请检查后重试。", "The time zone is invalid.")); return; }
    setCreating(true); setError("");
    try {
      const result = await workspace.automationMutations.createAutomation.mutateAsync({ idempotencyKey: idempotencyKey("automation-create"), data: {
        scopeId: scope.scopeId, displayName: displayName.trim() || candidate.name, loopVersionId: candidate.loopVersionId,
        trigger: { kind: "daily_cron", expression: `${minute} ${hour} * * *`, timezone: timezone.trim() },
        inputBindings: candidate.inputBindings.map(({ bindingId, inputKey, source }) => ({ bindingId, inputKey, source })),
        connectionBindings: requirements.map(({ requirementId }) => ({ requirementId, connectionId: connectionSelections[requirementId] })),
        budgetPolicy: defaultBudget,
        misfirePolicy: misfire === "skip" ? { kind: "skip", maxLatenessSeconds: 0 } : { kind: "run_once", maxLatenessSeconds: 300 },
        grantExpiresAt: initialGrantExpiryIso(), grantReviewAt: null,
      } });
      onCreated(result.data.automationId);
    } catch (cause) { setError(cause?.message || copy("未能创建任务，你的设置已保留。", "Could not create the task. Your settings are preserved.")); }
    finally { setCreating(false); }
  }
  return <Dialog open title={copy("新建定时任务", "New scheduled task")} onClose={() => !creating && onClose()}
    initialFocusSelector="[data-testid='loopops.automations.create.name']" returnFocusSelector="[data-testid='loopops.automations.new']"
    actions={<><Button variant="plain" disabled={creating} onClick={onClose}>{copy("取消", "Cancel")}</Button>{candidate ? <Button variant="primary" type="submit" form="automation-create" disabled={creating || !ready} data-testid="loopops.automations.create">{creating ? copy("正在创建…", "Creating…") : copy("创建任务", "Create task")}</Button> : null}</>}>
    {!workspace.canManageAutomations ? <div className="automationSetup"><ShieldCheck size={25} /><h3>{copy("需要管理员创建", "An administrator needs to create this task")}</h3><p>{copy("你可以查看任务和结果。请联系工作空间所有者或管理员安排定时执行。", "You can view tasks and results. Ask your workspace owner or administrator to schedule a task.")}</p></div>
    : !scope ? <p role="alert" className="automationWarning">{copy("暂时无法读取你的执行权限，请关闭后刷新重试。", "Your permissions could not be loaded. Close this dialog and refresh.")}</p>
    : !candidate ? <div className="automationSetup"><CalendarClock size={28} /><h3>{copy("先准备一个可以运行的任务", "Prepare a runnable task first")}</h3><p>{copy("目前没有可定时执行的工作流。先描述任务、完成配置并试跑，发布后就能在这里安排执行时间。", "There are no workflows ready to schedule. Describe your task, configure and test it, then publish it to set a schedule here.")}</p><Button variant="primary" onClick={() => { onClose(); workspace.navigateToPath("/loops/new"); }}>{copy("准备工作流", "Prepare a workflow")}</Button><Button variant="plain" onClick={() => { onClose(); workspace.navigateToPath("/loops"); }}>{copy("查看已有工作流", "View existing workflows")}</Button></div>
    : <form id="automation-create" className="automationCreateForm" onSubmit={create}>
      <label><span>{copy("任务名称", "Task name")}</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={candidate.name} maxLength="200" disabled={creating} data-testid="loopops.automations.create.name" /></label>
      <label><span>{copy("要执行的工作流", "Workflow to run")}</span><select value={candidate.loopVersionId} onChange={(event) => setCandidateId(event.target.value)} disabled={creating}>{available.map((item) => <option key={item.loopVersionId} value={item.loopVersionId}>{item.name} · v{item.version}</option>)}</select>{candidate.description ? <small>{candidate.description}</small> : null}</label>
      <label><span>{copy("运行时间", "Schedule")}</span><div className="automationDailyTime"><span>{copy("每天", "Every day")}</span><input aria-label={copy("每天运行时间", "Daily run time")} type="time" value={time} onChange={(event) => setTime(event.target.value)} required disabled={creating} /><small>{timezone}</small></div></label>
      {candidate.inputBindings.length ? <p className="automationPinSummary">{copy("使用资料：", "Uses: ")}{candidate.inputBindings.map((pin) => pin.label).join(" · ")}</p> : null}
      {requirements.map((requirement) => { const options = optionsByRequirement.get(requirement.requirementId) || []; return <label key={requirement.requirementId}><span>{requirement.description || requirement.capabilityKey}</span><select value={connectionSelections[requirement.requirementId] || ""} onChange={(event) => setConnectionSelections((current) => ({ ...current, [requirement.requirementId]: event.target.value }))} disabled={creating || !options.length} data-testid={`loopops.automations.connection.${requirement.requirementId}`}><option value="" disabled>{copy("选择已连接的账号", "Choose a connected account")}</option>{options.map((connection) => <option key={connection.connectionId} value={connection.connectionId}>{connection.label}</option>)}</select>{!options.length ? <small role="alert">{copy("还没有可用连接，请先在团队资源库中连接账号。", "No connection is available. Connect an account in the team library first.")}</small> : null}</label>; })}
      <details className="automationAdvanced"><summary>{copy("更多设置", "More settings")}<ChevronDown size={15} /></summary><div><label><span>{copy("时区", "Time zone")}</span><input value={timezone} onChange={(event) => setTimezone(event.target.value)} disabled={creating} /></label><label><span>{copy("错过运行时间时", "When a run is late")}</span><select value={misfire} onChange={(event) => setMisfire(event.target.value)} disabled={creating}><option value="run_once">{copy("5 分钟内补跑一次", "Run once within 5 minutes")}</option><option value="skip">{copy("跳过本次", "Skip this run")}</option></select></label><p>{copy("每次运行上限 1 美元、10 分钟。后台执行授权在 30 天后到期；创建后可在任务设置中调整。", "Each run is limited to US$1 and 10 minutes. Background authorization expires after 30 days; adjust these limits in the task settings after creation.")}</p></div></details>
      <ScopePermission workspace={workspace} scope={scope} />
      <p className="automationPinSummary">{copy("使用已确认的工作流和资料版本。单次上限 1 美元、10 分钟，授权有效期 30 天。", "Uses confirmed workflow and information versions. Limited to US$1 and 10 minutes per run, with authorization valid for 30 days.")}</p>
      {error ? <p className="automationError" role="alert">{error}</p> : null}
    </form>}
  </Dialog>;
}

function AutomationEditDialog({ workspace, automation, onClose }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const saving = workspace.automationMutations.reviseAutomation.isPending;

  useEffect(() => {
    if (!automation) return;
    const { hour, minute } = dailyTime(automation.trigger.expression);
    setForm({
      displayName: automation.displayName,
      hour,
      minute,
      timezone: automation.trigger.timezone,
      misfire: automation.misfirePolicy.kind,
      maxLatenessMinutes: automation.misfirePolicy.kind === "run_once"
        ? String(Math.max(1, Math.ceil(automation.misfirePolicy.maxLatenessSeconds / 60)))
        : "5",
      maxCostUsd: String(automation.budgetPolicy.maxCostUsdMicros / 1_000_000),
      maxRuntimeSeconds: String(automation.budgetPolicy.maxRuntimeSeconds),
      grantExpiresAt: localDateTimeValue(automation.grantExpiresAt),
      grantReviewAt: localDateTimeValue(automation.grantReviewAt),
    });
    setError("");
  }, [automation]);

  if (!automation || !form) return null;
  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    const hour = Number(form.hour); const minute = Number(form.minute);
    const maxCostUsdMicros = Math.round(Number(form.maxCostUsd) * 1_000_000);
    const maxRuntimeSeconds = Number(form.maxRuntimeSeconds);
    const maxLatenessMinutes = Number(form.maxLatenessMinutes);
    const grantExpiresAt = utcDateTimeValue(form.grantExpiresAt);
    const grantReviewAt = form.grantReviewAt ? utcDateTimeValue(form.grantReviewAt) : null;
    if (!form.displayName.trim() || !Number.isInteger(hour) || hour < 0 || hour > 23
      || !Number.isInteger(minute) || minute < 0 || minute > 59 || !form.timezone.trim()) {
      setError(localCopy(workspace.locale, "请填写名称，并选择有效的运行时间与时区。", "Enter a name, a valid daily run time, and a time zone."));
      return;
    }
    if (!Number.isInteger(maxCostUsdMicros) || maxCostUsdMicros < 0
      || !Number.isInteger(maxRuntimeSeconds) || maxRuntimeSeconds < 1 || maxRuntimeSeconds > 86_400
      || (form.misfire === "run_once" && (!Number.isInteger(maxLatenessMinutes) || maxLatenessMinutes < 1 || maxLatenessMinutes > 1_440))) {
      setError(localCopy(workspace.locale, "请输入有效的预算、最长运行时间和补跑窗口。", "Enter a valid budget, maximum run time, and late-run window."));
      return;
    }
    if (!grantExpiresAt || Date.parse(grantExpiresAt) <= Date.now()) {
      setError(localCopy(workspace.locale, "授权到期时间必须在未来。", "The grant expiry must be in the future."));
      return;
    }
    if (grantReviewAt && Date.parse(grantReviewAt) > Date.parse(grantExpiresAt)) {
      setError(localCopy(workspace.locale, "复核时间不能晚于授权到期时间。", "The review time cannot be later than the grant expiry."));
      return;
    }
    setError("");
    try {
      await workspace.automationMutations.reviseAutomation.mutateAsync({
        automationId: automation.automationId,
        idempotencyKey: idempotencyKey("automation-revise"),
        data: {
          displayName: form.displayName.trim(),
          loopVersionId: automation.loopVersionId,
          trigger: { kind: "daily_cron", expression: `${minute} ${hour} * * *`, timezone: form.timezone.trim() },
          inputBindings: automation.inputBindings.map(({ bindingId, inputKey, source }) => ({ bindingId, inputKey, source })),
          connectionBindings: automation.connectionBindings.map(({ requirementId, connectionId }) => ({ requirementId, connectionId })),
          budgetPolicy: { maxCostUsdMicros, maxRuntimeSeconds },
          misfirePolicy: form.misfire === "skip"
            ? { kind: "skip", maxLatenessSeconds: 0 }
            : { kind: "run_once", maxLatenessSeconds: maxLatenessMinutes * 60 },
          grantExpiresAt,
          grantReviewAt,
        },
      });
      onClose();
    } catch (cause) {
      setError(cause?.message || localCopy(workspace.locale, "未能保存更改，请重试。", "Could not save changes. Try again."));
    }
  };

  return (
    <Dialog
      open
      title={localCopy(workspace.locale, "编辑定时任务", "Edit scheduled task")}
      onClose={() => !saving && onClose()}
      initialFocusSelector="[data-testid='loopops.automations.edit.name']"
      returnFocusSelector={`[data-testid='loopops.automations.edit.${automation.automationId}']`}
      actions={<><Button variant="secondary" onClick={onClose} disabled={saving}>{localCopy(workspace.locale, "取消", "Cancel")}</Button><Button type="submit" form="automation-edit" variant="primary" disabled={saving}>{saving ? localCopy(workspace.locale, "保存中…", "Saving…") : localCopy(workspace.locale, "保存更改", "Save changes")}</Button></>}
    >
      <form id="automation-edit" className="automationEditForm" onSubmit={submit}>
        <p className="automationPinSummary">{localCopy(workspace.locale, "修改名称或运行安排。要更换工作流或使用的资料，请创建新任务。", "Edit the name or schedule. To use a different workflow or source, create a new task.")}</p>
        <label><span>{localCopy(workspace.locale, "名称", "Name")}</span><input value={form.displayName} onChange={update("displayName")} maxLength="200" disabled={saving} data-testid="loopops.automations.edit.name" /></label>
        <label><span>{localCopy(workspace.locale, "运行时间", "Schedule")}</span><div className="automationDailyTime"><span>{localCopy(workspace.locale, "每天", "Every day")}</span><input type="time" aria-label={localCopy(workspace.locale, "每天运行时间", "Daily run time")} value={`${form.hour}:${form.minute}`} onChange={(event) => { const [hour, minute] = event.target.value.split(":"); setForm((current) => ({ ...current, hour, minute })); }} required disabled={saving} /><small>{form.timezone}</small></div></label>
        <details className="automationAdvanced"><summary>{localCopy(workspace.locale, "运行限制与更多设置", "Run limits and more settings")}<ChevronDown size={15} /></summary><div>
        <label><span>{localCopy(workspace.locale, "时区", "Time zone")}</span><input value={form.timezone} onChange={update("timezone")} disabled={saving} /></label>
        <label><span>{localCopy(workspace.locale, "错过计划时", "When late")}</span><select value={form.misfire} onChange={update("misfire")} disabled={saving}><option value="run_once">{localCopy(workspace.locale, "补跑一次", "Run once")}</option><option value="skip">{localCopy(workspace.locale, "跳过", "Skip")}</option></select></label>
        {form.misfire === "run_once" ? <label><span>{localCopy(workspace.locale, "补跑窗口（分钟）", "Late-run window (minutes)")}</span><input inputMode="numeric" value={form.maxLatenessMinutes} onChange={update("maxLatenessMinutes")} disabled={saving} /></label> : null}
        <div className="automationEditBudget"><label><span>{localCopy(workspace.locale, "每次运行预算（美元）", "Budget per run (USD)")}</span><input type="number" min="0" step="0.000001" required value={form.maxCostUsd} onChange={update("maxCostUsd")} disabled={saving} /></label><label><span>{localCopy(workspace.locale, "最长运行（秒）", "Max runtime (seconds)")}</span><input inputMode="numeric" value={form.maxRuntimeSeconds} onChange={update("maxRuntimeSeconds")} disabled={saving} /></label></div>
        <div className="automationEditBudget"><label><span>{localCopy(workspace.locale, "授权到期", "Grant expiry")}</span><input type="datetime-local" value={form.grantExpiresAt} onChange={update("grantExpiresAt")} disabled={saving} /></label><label><span>{localCopy(workspace.locale, "可选复核时间", "Optional review time")}</span><input type="datetime-local" value={form.grantReviewAt} onChange={update("grantReviewAt")} disabled={saving} /></label></div>
        </div></details>
        {error ? <p className="automationError" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}

function stateLabel(value, locale) {
  const labels = {
    active: ["运行中", "Active"], paused: ["已暂停", "Paused"], archived: ["已归档", "Archived"],
    draft: ["草稿", "Draft"], checking: ["检查中", "Checking"], blocked: ["需要处理", "Needs attention"],
    completed: ["已完成", "Completed"], failed: ["未能完成", "Failed"], cancelled: ["已取消", "Cancelled"],
    partial: ["部分完成", "Partially completed"], effect_outcome_unknown: ["结果待确认", "Outcome unconfirmed"],
    due: ["等待执行", "Waiting"], accepted: ["已安排", "Scheduled"], misfired: ["错过时间", "Missed"], skipped: ["已跳过", "Skipped"],
    queued: ["排队中", "Queued"], running: ["正在执行", "Running"], awaiting_review: ["等待确认", "Awaiting review"],
  };
  return labels[value] ? localCopy(locale, ...labels[value]) : localCopy(locale, "状态待确认", "Status unconfirmed");
}
function scheduleLabel(automation, locale) {
  const { hour, minute } = dailyTime(automation.trigger.expression);
  return `${localCopy(locale, "每天", "Every day")} ${hour}:${minute}`;
}
function AutomationCard({ workspace, automation, occurrences, selected, requestedOccurrenceId, onSelect, onEdit }) {
  const copy = (zh, en) => localCopy(workspace.locale, zh, en);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const canManage = workspace.canManageAutomations && automation.ownerId === workspace.principal.userId && automation.scopeId === workspace.automationScope?.scopeId;
  async function transition(target) {
    setPending(target); setError("");
    try { await workspace.automationMutations.transitionAutomation.mutateAsync({ automationId: automation.automationId, transition: target, ifMatch: automation.etag, idempotencyKey: idempotencyKey(`automation-${target}`) }); }
    catch (cause) { setError(cause?.message || copy("未能更新状态，请重试。", "Could not update the task. Try again.")); }
    finally { setPending(""); }
  }
  const isActive = automation.status === "active";
  const displayed = visibleOccurrences(occurrences || [], requestedOccurrenceId);
  return <article className={`automationTask ${selected ? "selected" : ""}`} data-testid={`loopops.automations.card.${automation.automationId}`}>
    <div className="automationTaskRow">
      <button type="button" className="automationTaskOpen" onClick={() => onSelect(selected ? "" : automation.automationId)} aria-expanded={selected}>
        <span className="automationTaskIcon"><Clock3 size={19} /></span><span className="automationTaskIdentity"><strong>{automation.displayName || copy("未命名任务", "Untitled task")}</strong><span>{scheduleLabel(automation, workspace.locale)} <i>·</i> {automation.trigger.timezone}</span></span>
        <ChevronRight className="automationTaskChevron" size={16} />
      </button>
      <div className="automationTaskNext"><StatusPill tone={isActive ? "success" : automation.status === "blocked" ? "warning" : "neutral"}>{stateLabel(automation.status, workspace.locale)}</StatusPill><span>{isActive ? `${copy("下次：", "Next: ")}${formatDate(automation.nextRunAt, workspace.locale, automation.trigger.timezone)}` : automation.lastRunAt ? `${copy("上次：", "Last: ")}${formatDate(automation.lastRunAt, workspace.locale, automation.trigger.timezone)}` : copy("尚无运行记录", "No runs yet")}</span></div>
      {canManage && automation.status !== "archived" ? <div className="automationRowActions"><button type="button" title={copy("编辑任务", "Edit task")} aria-label={`${copy("编辑", "Edit")} ${automation.displayName}`} disabled={Boolean(pending)} onClick={() => onEdit(automation.automationId)} data-testid={`loopops.automations.edit.${automation.automationId}`}><Pencil size={16} /></button><button type="button" title={copy(isActive ? "暂停任务" : "恢复任务", isActive ? "Pause task" : "Resume task")} aria-label={`${copy(isActive ? "暂停" : "恢复", isActive ? "Pause" : "Resume")} ${automation.displayName}`} disabled={Boolean(pending)} onClick={() => transition(isActive ? "pause" : "activate")}>{isActive ? <CirclePause size={17} /> : <CirclePlay size={17} />}</button></div> : null}
    </div>
    {error ? <p className="automationError" role="alert">{error}</p> : null}
    {selected ? <div className="automationTaskDetails">
      <div className="automationRunSummary"><h3>{copy("最近运行", "Recent runs")}</h3><span>{automation.lastOutcome ? stateLabel(automation.lastOutcome, workspace.locale) : copy("尚无结果", "No results yet")}</span></div>
      {automation.status === "blocked" ? <p className="automationWarning">{copy("任务已停止自动执行。请检查任务设置、连接和授权，再恢复运行。", "Automatic runs have stopped. Check the task settings, connections, and authorization before resuming.")}</p> : null}
      {workspace.occurrencesState.loading ? <p className="automationEmptyHint" role="status">{copy("正在加载运行记录…", "Loading recent runs…")}</p>
        : workspace.occurrencesState.error ? <div className="automationError" role="alert">{copy("暂时无法读取运行记录。", "Recent runs could not be loaded.")} <Button variant="plain" onClick={workspace.occurrencesState.retry}>{copy("重试", "Retry")}</Button></div>
        : displayed.length ? <div className="automationOccurrenceList">{displayed.map((occurrence) => { const path = automationRunPath(occurrence); return <div key={occurrence.occurrenceId} className={occurrence.occurrenceId === requestedOccurrenceId ? "selected" : ""}><span>{formatDate(occurrence.scheduledFor, workspace.locale, automation.trigger.timezone)}</span><span className="automationOccurrenceMeta"><span>{stateLabel(occurrence.runStatus || occurrence.status, workspace.locale)}</span>{path ? <Button variant="plain" size="sm" onClick={() => workspace.navigateToPath(path)} data-testid={`loopops.automations.occurrence.${occurrence.occurrenceId}.run`}>{copy("查看结果", "View result")}</Button> : null}</span></div>; })}</div>
        : <p className="automationEmptyHint">{copy("第一次运行后，结果会显示在这里。", "Results will appear here after the first run.")}</p>}
      <div className="automationDetailFooter"><span>{copy("后台执行授权至 ", "Authorized until ")}{formatDate(automation.grantExpiresAt, workspace.locale)}{automation.grantReviewAt ? ` · ${copy("复核：", "Review: ")}${formatDate(automation.grantReviewAt, workspace.locale)}` : ""}</span>{canManage && automation.status !== "archived" ? <Button variant="plain" size="sm" icon={<Archive size={14} />} disabled={Boolean(pending)} onClick={() => transition("archive")}>{pending === "archive" ? copy("正在归档…", "Archiving…") : copy("归档任务", "Archive task")}</Button> : null}</div>
    </div> : null}
  </article>;
}

export function AutomationsView({ workspace }) {
  const copy = (zh, en) => localCopy(workspace.locale, zh, en);
  const [editingAutomationId, setEditingAutomationId] = useState("");
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const editing = workspace.automations.find((automation) => automation.automationId === editingAutomationId) || null;
  const filters = [{ id: "all", label: copy("全部", "All") }, { id: "active", label: copy("运行中", "Active") }, { id: "paused", label: copy("已暂停", "Paused") }, { id: "archived", label: copy("已归档", "Archived") }];
  const visible = workspace.automations.filter((item) => (filter === "all" ? item.status !== "archived" : item.status === filter) && item.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const hasTasks = workspace.automations.length > 0;
  if (workspace.automationState.loading && !hasTasks && !workspace.scopes.length) return <EmptyState title={copy("正在加载定时任务", "Loading scheduled tasks")} body={copy("正在读取任务和最近运行记录。", "Loading your tasks and recent runs.")} testId="loopops.automations.loading" />;
  if (workspace.automationState.error) return <EmptyState title={copy("暂时无法加载定时任务", "Could not load scheduled tasks")} body={copy("请检查连接后重试，你的任务不会丢失。", "Check your connection and try again. Your tasks are preserved.")} actionLabel={copy("重试", "Retry")} onAction={workspace.retry} testId="loopops.automations.error" />;
  return <div className="automationsPage" data-testid="loopops.automations.page">
    <header className="automationsHeader"><div><h1>{copy("定时任务", "Scheduled tasks")}</h1><p>{copy("让重复的工作按时完成，回来查看结果。", "Let recurring work run on schedule. Come back to the results.")}</p></div><Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)} data-testid="loopops.automations.new">{copy("新建任务", "New task")}</Button></header>
    <div className="automationListToolbar"><label className="automationSearch"><Search size={16} aria-hidden="true" /><input type="search" aria-label={copy("搜索定时任务", "Search scheduled tasks")} placeholder={copy("搜索定时任务", "Search scheduled tasks")} value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="automationFilterRow"><div className="automationFilters" role="group" aria-label={copy("任务状态", "Task status")}>{filters.map((item) => <button type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div><button type="button" className="automationRefresh" onClick={workspace.retry} disabled={workspace.automationState.fetching} aria-label={copy("刷新定时任务", "Refresh scheduled tasks")} title={copy("刷新", "Refresh")}><RefreshCw size={16} /></button></div></div>
    {workspace.requestedOccurrenceId && !workspace.selectedOccurrence && !workspace.occurrencesState.loading ? <p className="automationWarning" role="alert">{copy("这条运行记录已不在当前可访问范围内。", "This run is no longer accessible.")}</p> : null}
    {visible.length ? <section className="automationTaskList" aria-label={copy("定时任务列表", "Scheduled tasks")}>{visible.map((automation) => <AutomationCard key={automation.automationId} workspace={workspace} automation={automation} occurrences={automation.automationId === workspace.selectedAutomationId ? workspace.selectedOccurrences : []} selected={automation.automationId === workspace.selectedAutomationId} requestedOccurrenceId={workspace.requestedOccurrenceId} onSelect={workspace.selectAutomation} onEdit={setEditingAutomationId} />)}</section>
      : <section className="automationEmpty" data-testid="loopops.automations.empty"><span className="automationEmptyIcon"><CalendarClock size={27} strokeWidth={1.4} /></span><h2>{query ? copy("没有找到这个任务", "No matching tasks") : filter !== "all" ? copy("这个分类还没有任务", "No tasks in this view") : copy("把重复的工作安排好", "Put recurring work on your schedule")}</h2><p>{query ? copy("试试其他关键词，或清空搜索查看全部任务。", "Try another search or clear it to see all tasks.") : filter !== "all" ? copy("切换到全部，查看其他定时任务。", "Select All to see your other tasks.") : copy("选择已准备好的工作流，设定每天运行的时间。运行状态和结果会保存在这里。", "Choose a prepared workflow and a daily run time. Its status and results will appear here.")}</p>{query || filter !== "all" ? <Button variant="secondary" onClick={() => { setQuery(""); setFilter("all"); }}>{copy("查看全部任务", "View all tasks")}</Button> : <Button variant="secondary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>{copy("创建第一个任务", "Create your first task")}</Button>}</section>}
    {creating ? <AutomationCreateDialog workspace={workspace} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setQuery(""); setFilter("all"); workspace.selectAutomation(id); }} /> : null}
    <AutomationEditDialog workspace={workspace} automation={editing} onClose={() => setEditingAutomationId("")} />
  </div>;
}
