import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Check,
  Circle,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Send,
  Share2,
  Sparkles,
  X,
} from "lucide-react";

import { Button, Dialog, TextArea, TextInput } from "../../design-system/index.jsx";
import { TurnsuMark } from "../shared/TurnsuBrand.jsx";
import {
  useAgentMutations,
  useAgentProposalQuery,
  useAttachmentMutations,
  useWorkItemContinuationAgentEntryMutation,
  useWorkItemDecisionMutation,
  useWorkItemDetailQuery,
  useWorkItemPromotionMutation,
  useWorkItemPromotionParticipantsQuery,
  useWorkItemThreadCommentMutation,
  useWorkItemThreadEntriesQuery,
  useTeamWorkMutations,
  useProjectsQuery,
} from "../../api/queries.js";
import { defaultModelSelection, useModelCatalog } from "../../state/models/index.js";
import { useLoopTaskRun, useMainAgent } from "../../state/agents/index.js";
import { ArtifactImage } from "../models/ArtifactImage.jsx";
import { ModelSwitch } from "../models/ModelSwitch.jsx";
import { AgentResultReader, resultOutputs } from "./AgentResultReader.jsx";
import { AgentMarkdown } from "./AgentMarkdown.js";
import { useWorkbenchNavigation } from "../shell/WorkbenchNavigation.jsx";
import { PromoteToWorkItemDialog } from "./PromoteToWorkItemDialog.jsx";
import { WorkItemHandoffDialog } from "./WorkItemHandoffDialog.jsx";

const TERMINAL = new Set(["completed", "failed", "cancelled", "blocked"]);
const RESULT_READER_DEFAULT_WIDTH = 384;
const RESULT_READER_MIN_WIDTH = 360;
const RESULT_READER_MAX_WIDTH = 640;
const RESULT_READER_STORAGE_PREFIX = "looloomi:agent-result-reader-width";

const COPY = {
  zh: {
    emptyTitle: "今天，想完成什么？",
    emptyBody: "给出目标，附上材料。从一个想法，推进到一份可用的成果。",
    privateHint: "私人任务 · 你决定何时与团队分享",
    examplesTitle: "从这些工作开始",
    prompt: "描述你想要的结果…",
    continuePrompt: "继续补充要求…",
    send: "发送",
    working: "正在处理",
    queueHint: "当前任务正在处理，这条消息会排队。",
    addImage: "添加图片",
    addFile: "添加文件",
    attachmentUploading: "正在上传和处理…",
    attachmentRetry: "重试",
    attachmentFailed: "文件处理失败，请重试或移除。",
    attachmentUnsupported: "当前模型不能读取这张图片。换个支持图片输入的模型，或移除图片后再发送。",
    noAttachmentModel: "当前模型无法处理所选附件。请选择能力匹配的模型，或移除附件后继续。",
    changeModel: "换模型",
    removeImage: "移除图片",
    removeFile: "移除文件",
    noModel: "现在还没有可用的模型，请联系管理员开通。",
    model: "模型",
    modelHint: "这里只选择本次任务使用的模型，账号密钥由团队统一管理。",
    textModels: "文本模型",
    multimodalModels: "多模态模型",
    chatCapability: "对话",
    toolCapability: "使用工具",
    structuredCapability: "结构化结果",
    imageInputCapability: "图片理解",
    unavailable: "不可用",
    historical: "历史选择",
    capabilityUnavailable: "当前没有可用于这项任务的模型。",
    modelTaskUnsupported: "这个模型不能执行当前任务，请选择支持对话和工具的模型。",
    loadingModel: "正在准备可用模型…",
    newTask: "新任务",
    backToTasks: "任务",
    ready: "准备开始",
    queued: "排队中",
    running: "进行中",
    waiting_review: "等你确认",
    completed: "已完成",
    failed: "未完成",
    cancelled: "已取消",
    blocked: "暂时无法继续",
    details: "执行细节",
    cancel: "取消",
    retryLoad: "重新加载",
    openResult: "打开结果",
    resultReady: "结果已准备好",
    sourceLoop: "来自 Loop 运行",
    sourceManual: "手动任务",
    imageResult: "生成的图片",
    attachmentName: "文件附件",
    requestedSessionUnavailable: "这个任务不存在、你无权访问，或已被删除。请选择其他任务，或明确新建任务。",
    requestedSessionTitle: "任务不可用",
    loopRunLoading: "正在读取 Loop 运行…",
    loopRunUnavailable: "Loop 运行暂时无法读取。这不是业务阻塞状态，请重试。",
    loopRunDetailsUnavailable: "部分执行明细未能加载，可以重试。",
    loopRunCancelReason: "从 Agent 任务页取消 Loop 运行",
    loopRunTimeline: "Loop 执行",
    loopRunResult: "Loop 结果",
    shareWorkItem: "共享给团队",
    workItemReady: "团队工作已创建",
    workItemReadyHint: "已创建安全交接；私有任务记录仍只属于你。",
    openWorkItem: "查看共享交接",
    workEntryTitle: "和团队一起推进",
    newTeamWork: "委派团队工作",
    newTeamWorkHint: "共享目标和成果，保留私人执行空间",
    continueWork: "接续团队工作",
    continueWorkHint: "从已共享的成果继续，不必重新交代背景",
    createTeamEntryTitle: "新建团队工作并委派",
    createTeamEntryHint: "创建团队工作并开始你的私人任务。团队只看到你在这里填写的交接说明。",
    teamEntrySummary: "安全交接摘要",
    teamEntryProject: "项目（可选）",
    teamEntryMembers: "协作成员",
    teamEntryCreate: "创建并开始执行",
    teamEntryCreating: "正在创建并提交…",
    teamEntryUnavailable: "团队 Work 创建失败；没有创建部分共享记录，请重试。",
    continuationEntryTitle: "接续团队工作",
    continuationEntryHint: "从已共享的交接和成果继续。你的新任务与对话仍然保密。",
    continuationEntryCancel: "取消继续",
    continuationEntryLoading: "正在读取团队工作…",
    continuationEntryUnavailable: "这项工作不存在、你已无权访问，或访问已被撤销。",
    examples: [
      ["整理会议", "提取决定、负责人和下一步", "请根据我提供的会议记录，整理已达成的决定、行动项、负责人和截止时间。没有明确的信息标为待确认。"],
      ["读懂资料", "带着问题，找到有依据的答案", "请分析我提供的资料，先总结关键结论并标明依据，再列出影响结论的未知项。"],
      ["推进计划", "把目标拆成可以执行的工作", "请把我提供的目标和笔记整理成执行计划，说明交付物、依赖和下一步，只询问会改变方案的关键问题。"],
    ],
  },
  en: {
    emptyTitle: "What will you accomplish today?",
    emptyBody: "Share your goal and materials. Take an idea through to a useful outcome.",
    privateHint: "Private task · Share with your team when you choose",
    examplesTitle: "Start with a real piece of work",
    prompt: "Describe the outcome you want…",
    continuePrompt: "Add another requirement…",
    send: "Send",
    working: "Working",
    queueHint: "This task is active. Your next message will be queued.",
    addImage: "Add image",
    addFile: "Attach file",
    attachmentUploading: "Uploading and processing…",
    attachmentRetry: "Retry",
    attachmentFailed: "The file could not be processed. Retry or remove it.",
    attachmentUnsupported: "This model cannot read the image. Choose a model with image input, or remove it before sending.",
    noAttachmentModel: "The current model cannot process the selected attachment. Choose a compatible model or remove the attachment.",
    changeModel: "Change model",
    removeImage: "Remove image",
    removeFile: "Remove file",
    noModel: "No model is available. Ask a workspace administrator to enable one.",
    model: "Model",
    modelHint: "Choose the model for this task. The team manages access.",
    textModels: "Text models",
    multimodalModels: "Multimodal models",
    chatCapability: "Chat",
    toolCapability: "Tools",
    structuredCapability: "Structured output",
    imageInputCapability: "Image understanding",
    unavailable: "Unavailable",
    historical: "Historical selection",
    capabilityUnavailable: "No model is available for this task.",
    modelTaskUnsupported: "This model cannot run the current task. Choose one that supports chat and tools.",
    loadingModel: "Preparing available models…",
    newTask: "New task",
    backToTasks: "Tasks",
    ready: "Ready",
    queued: "Queued",
    running: "In progress",
    waiting_review: "Needs your review",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    blocked: "Blocked",
    details: "Execution details",
    cancel: "Cancel",
    retryLoad: "Reload",
    openResult: "Open result",
    resultReady: "Result ready",
    sourceLoop: "From a Loop run",
    sourceManual: "Manual task",
    imageResult: "Generated image",
    attachmentName: "File attachment",
    requestedSessionUnavailable: "This task does not exist, is unavailable to you, or was deleted. Choose another task or explicitly start a new one.",
    requestedSessionTitle: "Task unavailable",
    loopRunLoading: "Loading the Loop run…",
    loopRunUnavailable: "The Loop run is temporarily unavailable. This is not a business blocked state. Try again.",
    loopRunDetailsUnavailable: "Some execution details could not be loaded. Try again.",
    loopRunCancelReason: "Cancelled from the Agent task page",
    loopRunTimeline: "Loop execution",
    loopRunResult: "Loop result",
    shareWorkItem: "Share as team Work Item",
    workItemReady: "Shared Work Item created",
    workItemReadyHint: "A safe handoff is ready; your private task history remains private.",
    openWorkItem: "View shared handoff",
    workEntryTitle: "Or start from shared work",
    newTeamWork: "New team Work Item",
    newTeamWorkHint: "Record the shared goal, members, and owner first; execution remains in each person’s private branch.",
    continueWork: "Continue an existing Work Item",
    continueWorkHint: "Carries only the shared handoff and evidence, never another person’s private task history.",
    createTeamEntryTitle: "Create and delegate a team Work Item",
    createTeamEntryHint: "This atomically creates shared Work, your private branch, and its first task. Teammates see only the safe handoff summary below.",
    teamEntrySummary: "Safe handoff summary",
    teamEntryProject: "Project (optional)",
    teamEntryMembers: "Collaborators",
    teamEntryCreate: "Create and start work",
    teamEntryCreating: "Creating and submitting…",
    teamEntryUnavailable: "The team Work entry could not be created. No partial shared record was created; try again.",
    continuationEntryTitle: "Continue shared Work",
    continuationEntryHint: "Only the shared handoff and evidence are carried over. Your personal branch and first task are created atomically when you send the next task.",
    continuationEntryCancel: "Cancel continuation",
    continuationEntryLoading: "Checking the shared Work you can access…",
    continuationEntryUnavailable: "This shared Work does not exist, is no longer available to you, or access was revoked.",
    examples: [
      ["Organize meeting actions", "Extract owners and due dates"],
      ["Summarize a document", "List decisions and open questions"],
      ["Turn notes into a plan", "Create concrete next steps"],
    ],
  },
};

function requestText(turn) {
  return turn?.input?.message || turn?.input?.prompt || turn?.message || "";
}

function responseText(turn) {
  if (turn?.result?.kind === "agent_message") return turn.result.response || "";
  return turn?.result?.response || "";
}

function artifactReferences(turn) {
  const candidates = [
    ...(turn?.artifactRefs || []),
    ...(turn?.result?.artifactRefs || []),
    ...(turn?.result?.result?.artifactRefs || []),
  ];
  return [...new Map(candidates.filter((item) => item?.artifactId).map((item) => [item.artifactId, item])).values()];
}

function revisionLabel(profiles, revisionId, locale) {
  if (!revisionId) return "—";
  for (const profile of profiles) {
    const revisions = [
      profile.currentRevision,
      profile.selectedRevision,
      profile.historicalRevision,
      ...(profile.revisions || []),
    ].filter(Boolean);
    const match = revisions.find((revision) => revision.revisionId === revisionId);
    if (match) return profile.displayName || match.modelDisplayName || revisionId;
  }
  return locale === "zh" ? "历史模型" : "Historical model";
}

function eventSummary(event, locale) {
  const labels = locale === "zh"
    ? {
        "turn.queued": "任务已加入队列",
        "turn.started": "Agent 开始处理",
        "turn.steered": "已补充当前任务要求",
        "turn.cancellation_requested": "已请求取消任务",
        "turn.completed": "任务已完成",
        "turn.failed": "任务未完成",
        "turn.cancelled": "任务已取消",
        "turn.blocked": "任务暂时无法继续",
      }
    : {
        "turn.queued": "Task added to the queue",
        "turn.started": "Agent started working",
        "turn.steered": "Current task requirements updated",
        "turn.cancellation_requested": "Task cancellation requested",
        "turn.completed": "Task completed",
        "turn.failed": "Task failed",
        "turn.cancelled": "Task cancelled",
        "turn.blocked": "Task blocked",
      };
  return labels[event.type] || event.summary;
}

function mutationKey(kind) {
  return `${kind}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function selectedCanReadImages(option) {
  const capabilities = option?.capabilities || [];
  return capabilities.includes("image_input");
}

function attachmentSupportedByModel(attachment, option) {
  if (!attachment) return true;
  if (attachment.mediaType?.startsWith("image/")) return selectedCanReadImages(option);
  return (option?.capabilities || []).includes("chat");
}

function selectedCanSubmit(option) {
  if (!option || option.disabled) return false;
  const capabilities = option.capabilities || [];
  return capabilities.includes("chat") && capabilities.includes("tool_calling");
}

function agentModelGroup(option) {
  return option.capabilities?.includes("image_input") ? "multimodal" : "text";
}

function clampResultReaderWidth(value) {
  return Math.min(RESULT_READER_MAX_WIDTH, Math.max(RESULT_READER_MIN_WIDTH, Number(value) || RESULT_READER_DEFAULT_WIDTH));
}

function resultReaderStorageKey(userId) {
  return `${RESULT_READER_STORAGE_PREFIX}:${userId || "anonymous"}`;
}

function readResultReaderWidth(userId) {
  try {
    return clampResultReaderWidth(globalThis.localStorage?.getItem(resultReaderStorageKey(userId)));
  } catch {
    return RESULT_READER_DEFAULT_WIDTH;
  }
}

function ResultReaderResizeHandle({ width, onChange, onCommit, onReset, locale }) {
  const drag = useRef(null);
  const label = locale === "zh" ? "调整结果面板宽度" : "Resize result panel";

  function finishDrag(event) {
    if (!drag.current) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onCommit(width);
  }

  return (
    <div
      className="agentResultResizeHandle"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={RESULT_READER_MIN_WIDTH}
      aria-valuemax={RESULT_READER_MAX_WIDTH}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title={locale === "zh" ? "拖动调整宽度，双击恢复默认" : "Drag to resize; double-click to reset"}
      data-testid="loopops.main-agent.result.resize"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        onChange(clampResultReaderWidth(
          drag.current.startWidth - (event.clientX - drag.current.startX),
        ));
      }}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home"
          ? RESULT_READER_DEFAULT_WIDTH
          : clampResultReaderWidth(width + (event.key === "ArrowLeft" ? 16 : -16));
        onChange(next);
        onCommit(next);
      }}
    />
  );
}

function TaskComposer({
  value,
  onChange,
  attachments,
  onAttachment,
  onRemoveAttachment,
  onRetryAttachment,
  modelControl,
  selectedOption,
  disabled,
  submissionDisabled = false,
  disabledReason,
  busy,
  queueing,
  onSubmit,
  copy,
}) {
  const input = useRef(null);
  const form = useRef(null);
  const unsupportedAttachment = attachments.some(
    (attachment) => !attachmentSupportedByModel(attachment, selectedOption),
  );
  const attachmentPending = attachments.some(
    (attachment) => ["uploading", "processing"].includes(attachment.status),
  );
  const attachmentFailed = attachments.some(
    (attachment) => ["failed", "blocked"].includes(attachment.status),
  );
  const attachmentReady = attachments.some(
    (attachment) => attachment.status === "ready" && attachment.ref,
  );
  const ready = Boolean(
    (value.trim() || attachmentReady)
    && !disabled
    && !submissionDisabled
    && !busy
    && !unsupportedAttachment
    && !attachmentPending
    && !attachmentFailed,
  );

  function acceptFiles(files) {
    if (disabled || busy) return;
    const values = [...(files || [])].slice(0, Math.max(0, 8 - attachments.length));
    values.forEach((file) => onAttachment(file));
  }

  function handlePaste(event) {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    acceptFiles(files);
  }

  function openModelPicker() {
    form.current?.querySelector(".modelSwitchTrigger")?.click();
  }

  return (
    <form
      ref={form}
      className="agentTaskComposer"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSubmit();
      }}
      onDragOver={(event) => {
        if ((event.dataTransfer?.items || []).length) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        const files = [...(event.dataTransfer?.files || [])];
        if (!files.length) return;
        event.preventDefault();
        acceptFiles(files);
      }}
    >
      {attachments.length ? (
        <div className="agentAttachmentList" aria-label={copy.attachmentName}>
          {attachments.map((attachment) => {
            const pending = ["uploading", "processing"].includes(attachment.status);
            const failed = ["failed", "blocked"].includes(attachment.status);
            return (
              <div className="agentAttachmentChip" key={attachment.clientId}>
                {attachment.mediaType?.startsWith("image/")
                  ? <ImageIcon size={14} aria-hidden="true" />
                  : <FileText size={14} aria-hidden="true" />}
                <span>{attachment.name || copy.attachmentName}</span>
                {pending ? <small>{copy.attachmentUploading}</small> : null}
                {failed && attachment.retryable ? (
                  <button type="button" onClick={() => onRetryAttachment(attachment.clientId)}>
                    {copy.attachmentRetry}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(attachment.clientId)}
                  aria-label={copy.removeFile}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      <textarea
        aria-label={copy.prompt}
        aria-describedby="task-composer-shortcut"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={copy.continuePrompt}
        rows={3}
        disabled={disabled || busy}
        onPaste={handlePaste}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            if (ready) onSubmit();
          }
        }}
        data-testid="loopops.main-agent.input"
      />
      <span id="task-composer-shortcut" className="srOnly">{copy.send === "发送" ? "Enter 发送，Shift+Enter 换行" : "Enter to send, Shift+Enter for a new line"}</span>

      <div className="agentTaskComposerToolbar">
        <input
          ref={input}
          className="agentAttachmentInput"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(event) => {
            acceptFiles(event.target.files);
            event.target.value = "";
          }}
          data-testid="loopops.main-agent.attachment"
          tabIndex={-1}
          aria-hidden="true"
        />
        <button
          type="button"
          className="agentAttachmentButton"
          onClick={() => input.current?.click()}
          aria-label={copy.addFile}
          title={copy.addFile}
          disabled={disabled || busy || attachments.length >= 8}
          data-testid="loopops.main-agent.attachment.trigger"
        >
          <Paperclip size={17} aria-hidden="true" />
        </button>
        <span className="agentComposerSpacer" />
        {modelControl}
        <kbd>⌘ ⏎</kbd>
        <button
          type="submit"
          className="agentSendButton"
          disabled={!ready}
          title={unsupportedAttachment ? copy.attachmentUnsupported : disabledReason}
          data-testid="loopops.main-agent.submit"
        >
          <span>{busy ? copy.working : copy.send}</span>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
        </button>
      </div>

      {attachmentFailed ? (
        <div className="agentAttachmentNotice" role="alert">
          <span>{attachments.find((item) => ["failed", "blocked"].includes(item.status))?.error || copy.attachmentFailed}</span>
        </div>
      ) : unsupportedAttachment ? (
        <div className="agentAttachmentNotice" role="alert" data-testid="loopops.main-agent.attachment.unsupported">
          <span>{copy.noAttachmentModel}</span>
          <button type="button" onClick={openModelPicker}>{copy.changeModel}</button>
        </div>
      ) : queueing ? (
        <p className="agentComposerHint" role="status">{copy.queueHint}</p>
      ) : null}
    </form>
  );
}

function AgentEmptyState({ copy, onExample, onNewTeamWork, onContinueWork, children }) {
  return (
    <div className="agentEmptyState">

      <div>
        <h1>{copy.emptyTitle}</h1>
        <p>{copy.emptyBody}</p>
      </div>
      {children}
      <p className="agentPrivateHint">{copy.privateHint}</p>
      <div className="agentSuggestionGrid">
        {copy.examples.map(([title, detail, prompt]) => (
          <button type="button" key={title} onClick={() => onExample(prompt || title)}>
            <strong>{title}</strong>

          </button>
        ))}
      </div>
      <details className="agentWorkEntryChoices">
        <summary>{copy.workEntryTitle}</summary>
        <div>
          <button type="button" onClick={onNewTeamWork} data-testid="loopops.main-agent.entry.new-team-work">
            <strong>{copy.newTeamWork}</strong>
            <small>{copy.newTeamWorkHint}</small>
          </button>
          <button type="button" onClick={onContinueWork} data-testid="loopops.main-agent.entry.continue-work">
            <strong>{copy.continueWork}</strong>
            <small>{copy.continueWorkHint}</small>
          </button>
        </div>
      </details>
    </div>
  );
}

function TeamWorkEntryDialog({
  open,
  copy,
  locale,
  prompt,
  projects,
  directory,
  currentUserId,
  submitting,
  error,
  onClose,
  onSubmit,
}) {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [summary, setSummary] = useState("");
  const [projectId, setProjectId] = useState("");
  const [memberIds, setMemberIds] = useState([]);

  useEffect(() => {
    if (!open) return;
    const initial = String(prompt || "").trim();
    setTitle(initial.slice(0, 200));
    setObjective(initial.slice(0, 2_000));
    setSummary(initial.slice(0, 8_000));
    setProjectId("");
    setMemberIds([]);
  }, [open, prompt]);

  function toggleMember(userId) {
    setMemberIds((current) => current.includes(userId)
      ? current.filter((value) => value !== userId)
      : [...current, userId]);
  }

  function submit(event) {
    event.preventDefault();
    if (!title.trim() || !objective.trim() || !summary.trim()) return;
    onSubmit({
      projectId: projectId || null,
      title: title.trim(),
      objective: objective.trim(),
      summary: summary.trim(),
      members: memberIds.map((userId) => ({
        userId,
        access: "contribute",
        roles: ["participant"],
      })),
    });
  }

  return (
    <Dialog
      open={open}
      title={copy.createTeamEntryTitle}
      onClose={() => !submitting && onClose()}
      initialFocusSelector="[data-testid='loopops.main-agent.team-entry.title']"
      returnFocusSelector="[data-testid='loopops.main-agent.entry.new-team-work']"
      actions={<>
        <Button variant="secondary" onClick={onClose} disabled={submitting}>{copy.cancel}</Button>
        <Button type="submit" form="agent-team-work-entry" variant="primary" disabled={submitting || !title.trim() || !objective.trim() || !summary.trim()}>
          {submitting ? copy.teamEntryCreating : copy.teamEntryCreate}
        </Button>
      </>}
    >
      <form id="agent-team-work-entry" className="agentTeamWorkEntryForm" onSubmit={submit}>
        <p className="agentTeamWorkEntryHint">{copy.createTeamEntryHint}</p>
        <TextInput
          label={locale === "zh" ? "标题" : "Title"}
          value={title}
          onChange={setTitle}
          maxLength={200}
          required
          data-testid="loopops.main-agent.team-entry.title"
        />
        <TextArea
          label={locale === "zh" ? "目标" : "Objective"}
          value={objective}
          onChange={setObjective}
          rows={3}
          maxLength={2_000}
          required
        />
        <TextArea
          label={copy.teamEntrySummary}
          value={summary}
          onChange={setSummary}
          rows={3}
          maxLength={8_000}
          required
        />
        <label className="agentTeamWorkEntrySelect">
          <span>{copy.teamEntryProject}</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">{locale === "zh" ? "不归属项目" : "No Project"}</option>
            {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.title}</option>)}
          </select>
        </label>
        {directory.filter((member) => member.userId !== currentUserId).length ? (
          <fieldset className="agentTeamWorkEntryMembers">
            <legend>{copy.teamEntryMembers}</legend>
            {directory.filter((member) => member.userId !== currentUserId).map((member) => (
              <label key={member.userId}>
                <input type="checkbox" checked={memberIds.includes(member.userId)} onChange={() => toggleMember(member.userId)} />
                <span>{member.displayName || member.username}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {error ? <p className="agentTeamWorkEntryError" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}

function TurnTimeline({
  session,
  turns,
  events,
  activeTurn,
  locale,
  copy,
  onCancel,
  onRetry,
  onOpenResult,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
}) {
  return (
    <ol className="agentTimeline" data-testid="loopops.main-agent.history">
      {hasEarlier ? (
        <li className="agentHistoryLoadMore">
          <button type="button" disabled={loadingEarlier} onClick={onLoadEarlier}>
            {loadingEarlier
              ? (locale === "zh" ? "正在加载…" : "Loading…")
              : (locale === "zh" ? "加载更早消息" : "Load earlier messages")}
          </button>
        </li>
      ) : null}
      {turns.map((turn) => {
        const turnEvents = events.filter((event) => event.turnId === turn.turnId);
        const response = responseText(turn);
        const artifacts = artifactReferences(turn);
        const outputs = resultOutputs(turn, session?.title, locale);
        const active = activeTurn?.turnId === turn.turnId && !TERMINAL.has(turn.status);
        const status = copy[turn.status] || turn.status;
        const loopSource = session?.source?.kind === "loop_run";
        return (
          <li className={`agentTimelineTurn status-${turn.status}`} key={turn.turnId}>
            <div className="agentUserMessage">
              <MessageSquare size={15} aria-hidden="true" />
              <p>{requestText(turn)}</p>
            </div>
            <div className="agentResponse">
              <header>
                <span className={`agentResponseStatus status-${turn.status}`} aria-hidden="true">
                  {turn.status === "completed"
                    ? <Check size={13} />
                    : active ? <LoaderCircle className="spin" size={13} /> : <Circle size={11} />}
                </span>
                <strong>Turnsu</strong>
                <span>{status}</span>
                {active ? (
                  <button type="button" className="agentInlineAction" onClick={onCancel}>
                    {copy.cancel}
                  </button>
                ) : null}
              </header>

              {turnEvents.length ? (
                <details className="agentExecutionDetails">
                  <summary>{copy.details}</summary>
                  <ol>{turnEvents.map((event) => <li key={event.eventId}>{eventSummary(event, locale)}</li>)}</ol>
                </details>
              ) : null}
              {response ? <AgentMarkdown content={response} locale={locale} /> : null}
              {turn.status === "failed" || turn.status === "blocked" ? (
                <div className="agentTurnRecovery" role="alert">
                  <span>{turn.error?.message || status}</span>
                  <button type="button" onClick={onRetry}><RefreshCw size={13} />{copy.retryLoad}</button>
                </div>
              ) : null}
              {turn.kind === "model_task" && artifacts[0] ? (
                <ArtifactImage
                  artifactId={artifacts[0].artifactId}
                  alt={copy.imageResult}
                  className="agentTimelineImage"
                />
              ) : null}
              {outputs.length ? (
                <section className="agentResultCard">
                  <FileText size={15} aria-hidden="true" />
                  <span>{locale === "zh" ? "查看、复制或下载这份结果" : "View, copy or download this result"}</span>
                  <button
                    type="button"
                    className="agentOpenResult"
                    onClick={(event) => onOpenResult(turn, event.currentTarget)}
                    data-testid="loopops.main-agent.result.open"
                  >
                    {copy.openResult}
                    <span aria-hidden="true">→</span>
                  </button>
                </section>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function loopRunArtifactRefs(invocations = []) {
  const refs = invocations.flatMap((invocation) => invocation.artifactRefs || [])
    .map((artifact) => typeof artifact === "string"
      ? { artifactId: artifact, mediaType: "application/octet-stream" }
      : artifact)
    .filter((artifact) => artifact?.artifactId);
  return [...new Map(refs.map((artifact) => [artifact.artifactId, artifact])).values()];
}

function loopRunUsage(invocations = []) {
  const fields = ["steps", "modelRequests", "inputBytes", "outputBytes", "imageCount", "costUsdMicros"];
  const usage = Object.fromEntries(fields.map((field) => [
    field,
    invocations.reduce((total, invocation) => total + Number(invocation.usage?.[field] || 0), 0),
  ]));
  return invocations.some((invocation) => invocation.usage) ? usage : undefined;
}

function loopRunResultRecord(detail, invocations) {
  if (!detail?.run) return null;
  const readModel = detail.readModel || {};
  return {
    runId: detail.run.runId,
    recordKind: "loop_run",
    status: detail.run.status,
    startedAt: detail.run.startedAt,
    finishedAt: detail.run.finishedAt,
    result: {
      response: readModel.finalAnswer?.content || "",
      artifactRefs: loopRunArtifactRefs(invocations),
      usage: loopRunUsage(invocations),
    },
  };
}

function LoopRunTimeline({
  detail,
  invocations,
  executionEvents,
  loading,
  error,
  detailsError,
  cancelling,
  locale,
  copy,
  onRetry,
  onCancel,
  onOpenResult,
}) {
  if (loading) return <p className="agentLoopRunState" role="status">{copy.loopRunLoading}</p>;
  if (error || !detail?.run) {
    return (
      <div className="agentTurnRecovery agentLoopRunState" role="alert">
        <span>{copy.loopRunUnavailable}</span>
        <button type="button" onClick={onRetry}><RefreshCw size={13} />{copy.retryLoad}</button>
      </div>
    );
  }
  const run = detail.run;
  const readModel = detail.readModel || {};
  const terminal = TERMINAL.has(run.status);
  const resultRecord = loopRunResultRecord(detail, invocations);
  const outputs = resultOutputs(resultRecord, copy.loopRunResult, locale);

  return (
    <section className={`agentLoopRun status-${run.status}`} data-testid="loopops.main-agent.loop-run">
      {detailsError ? <div className="agentTurnRecovery" role="status"><span>{copy.loopRunDetailsUnavailable}</span><button type="button" onClick={onRetry}>{copy.retryLoad}</button></div> : null}
      <header>
        <span className={`agentResponseStatus status-${run.status}`} aria-hidden="true">
          {run.status === "completed"
            ? <Check size={13} />
            : terminal ? <Circle size={11} /> : <LoaderCircle className="spin" size={13} />}
        </span>
        <div>
          <strong>{copy.loopRunTimeline}</strong>
          <small>{copy[run.status] || run.status}</small>
        </div>
        {!terminal ? (
          <button
            type="button"
            className="agentInlineAction"
            disabled={cancelling}
            onClick={onCancel}
            data-testid="loopops.main-agent.loop-run.cancel"
          >
            {copy.cancel}
          </button>
        ) : null}
      </header>
      {readModel.nodeTimeline?.length ? (
        <ol className="agentLoopNodeTimeline" data-testid="loopops.main-agent.loop-run.timeline">
          {readModel.nodeTimeline.map((node) => (
            <li key={`${node.nodeId}-${node.attempt}`}>
              <span className={`agentResponseStatus status-${node.status}`} aria-hidden="true" />
              <div><strong>{node.summary || node.nodeId}</strong><small>{copy[node.status] || node.status}</small></div>
            </li>
          ))}
        </ol>
      ) : <p className="agentLoopRunQueued">{copy[run.status] || run.status}</p>}
      {executionEvents.length ? (
        <details className="agentExecutionDetails">
          <summary>{copy.details}</summary>
          <ol>{executionEvents.slice(-25).map((event) => (
            <li key={event.eventId || `${event.attemptId}-${event.sequence}`}>
              {event.summary || event.type}
            </li>
          ))}</ol>
        </details>
      ) : null}
      {readModel.failure ? (
        <div className="agentTurnRecovery" role="alert">
          <span>{readModel.failure.message || copy.failed}</span>
          <button type="button" onClick={onRetry}><RefreshCw size={13} />{copy.retryLoad}</button>
        </div>
      ) : null}
      {outputs.length ? (
        <section className="agentResultCard" data-testid="loopops.main-agent.loop-run.result">
          <div><strong>{copy.loopRunResult}</strong><span>{copy.resultReady}</span></div>
          <div className="agentResultChips">
            {readModel.finalAnswer?.content ? <span><FileText size={12} />Markdown</span> : null}
            {loopRunArtifactRefs(invocations).map((artifact) => (
              <span key={artifact.artifactId}><ImageIcon size={12} />{artifact.mediaType}</span>
            ))}
            <span>{copy.sourceLoop}</span>
          </div>
          <button
            type="button"
            className="agentOpenResult"
            onClick={(event) => onOpenResult(resultRecord, event.currentTarget)}
            data-testid="loopops.main-agent.loop-run.result.open"
          >
            {copy.openResult}<span aria-hidden="true">→</span>
          </button>
        </section>
      ) : null}
    </section>
  );
}

export function MainAgentView({ workspace, navigationKey = "" }) {
  const locale = workspace.locale === "zh" ? "zh" : "en";
  const copy = COPY[locale];
  const canConfigureModel = ["owner", "admin"].includes(workspace.membershipRole);
  const navigation = useWorkbenchNavigation();
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [selectedModelProfileId, setSelectedModelProfileId] = useState("");
  const [resultRecord, setResultRecord] = useState(null);
  const [resultReaderWidth, setResultReaderWidth] = useState(RESULT_READER_DEFAULT_WIDTH);
  const [mobileView, setMobileView] = useState("task");
  const [submitError, setSubmitError] = useState("");
  const [proposalDecisionError, setProposalDecisionError] = useState("");
  const [workItemDialogOpen, setWorkItemDialogOpen] = useState(false);
  const [workItemPromotion, setWorkItemPromotion] = useState(null);
  const [workItemPromotionError, setWorkItemPromotionError] = useState("");
  const [workItemContinuationError, setWorkItemContinuationError] = useState("");
  const [teamWorkEntryOpen, setTeamWorkEntryOpen] = useState(false);
  const [teamWorkEntryError, setTeamWorkEntryError] = useState("");
  const attachmentMutations = useAttachmentMutations();
  const cancelledAttachmentIds = useRef(new Set());
  const resultTrigger = useRef(null);
  const routeQuery = useMemo(
    () => new URLSearchParams(globalThis.location?.search || ""),
    [navigationKey],
  );
  const requestedSessionId = routeQuery.get("session") || "";
  const requestedProposalId = routeQuery.get("proposal") || "";
  const requestedWorkItemId = routeQuery.get("workItem") || "";
  const requestedContinuationWorkItemId = routeQuery.get("continueWorkItem") || "";
  const activeWorkItemId = requestedWorkItemId || requestedContinuationWorkItemId;

  const modelCatalog = useModelCatalog({
    capabilities: ["chat", "tool_calling"],
    context: "agent_controller",
    selectionKind: "profile",
    selectedProfileId: selectedModelProfileId,
  });
  const agent = useMainAgent({
    workspaceId: workspace.serverState?.workspace?.workspaceId,
    userId: workspace.session?.userId,
    requestedSessionId,
  });
  const principal = useMemo(() => ({
    workspaceId: workspace.serverState?.workspace?.workspaceId || "",
    userId: workspace.session?.userId || "",
  }), [workspace.serverState?.workspace?.workspaceId, workspace.session?.userId]);
  const requestedProposal = useAgentProposalQuery(
    requestedSessionId,
    requestedProposalId,
    Boolean(requestedSessionId && requestedProposalId),
    principal,
  );
  const proposalMutations = useAgentMutations();
  const workItemPromotionMutation = useWorkItemPromotionMutation();
  const workItemContinuationAgentEntryMutation = useWorkItemContinuationAgentEntryMutation();
  const workItemThreadCommentMutation = useWorkItemThreadCommentMutation();
  const workItemDecisionMutation = useWorkItemDecisionMutation();
  const teamWorkMutations = useTeamWorkMutations();
  const workItemPromotionParticipants = useWorkItemPromotionParticipantsQuery(
    principal,
    workItemDialogOpen,
  );
  const teamWorkParticipants = useWorkItemPromotionParticipantsQuery(
    principal,
    teamWorkEntryOpen,
  );
  const teamWorkProjects = useProjectsQuery(
    principal,
    { status: "active", limit: 100 },
    teamWorkEntryOpen,
  );
  const requestedWorkItem = useWorkItemDetailQuery(
    principal,
    activeWorkItemId,
    Boolean(activeWorkItemId),
  );
  const requestedWorkItemThread = useWorkItemThreadEntriesQuery(
    principal,
    requestedWorkItemId,
    Boolean(requestedWorkItemId),
  );
  const continuationWorkItem = requestedContinuationWorkItemId
    ? requestedWorkItem.data?.data?.workItem || null
    : null;
  const proposalRecord = requestedProposal.data?.data || null;
  const selectedSession = agent.session
    || agent.sessions.find((session) => session.sessionId === agent.sessionId)
    || null;
  const loopTask = useLoopTaskRun(selectedSession, Boolean(selectedSession?.source?.runId));
  const agentModelOptions = useMemo(
    () => modelCatalog.options
      .filter((option) => option.capabilities?.includes("chat"))
      .map((option) => ({ ...option, revisionNumber: null })),
    [modelCatalog.options],
  );
  const selectedOption = agentModelOptions.find((option) => option.value === selectedModelProfileId);
  const promotionArtifacts = useMemo(() => {
    const byId = new Map(agent.history.flatMap(artifactReferences)
      .map((artifact) => [artifact.artifactId, artifact]));
    return [...byId.values()];
  }, [agent.history]);

  useEffect(() => {
    if (!modelCatalog.profiles.length) return;
    const preferred = selectedSession?.lastUsedModelProfileId;
    if (preferred && agentModelOptions.some((option) => option.value === preferred && !option.disabled)) {
      setSelectedModelProfileId(preferred);
      return;
    }
    const defaultChat = defaultModelSelection(modelCatalog.profiles, "chat", "profile");
    const availableDefault = agentModelOptions.some(
      (option) => option.value === defaultChat && !option.disabled,
    ) ? defaultChat : agentModelOptions.find((option) => !option.disabled)?.value;
    setSelectedModelProfileId(availableDefault || "");
  }, [agent.sessionId, agentModelOptions, modelCatalog.profiles, selectedSession?.lastUsedModelProfileId]);

  useEffect(() => {
    setResultReaderWidth(readResultReaderWidth(workspace.session?.userId));
  }, [workspace.session?.userId]);

  useEffect(() => {
    if (agent.requestedSessionError !== "session_not_found_or_forbidden") return;
    setSubmitError(copy.requestedSessionUnavailable);
  }, [agent.requestedSessionError, copy.requestedSessionUnavailable]);

  const continuationRouteRef = useRef("");
  useEffect(() => {
    if (!requestedContinuationWorkItemId) {
      continuationRouteRef.current = "";
      return;
    }
    if (continuationRouteRef.current === requestedContinuationWorkItemId) return;
    continuationRouteRef.current = requestedContinuationWorkItemId;
    // A continuation must never look like another session's next message.
    // Start a fresh local draft; the server creates the actual branch only
    // when the atomic Agent-entry mutation is accepted.
    agent.beginNewSession();
  }, [agent.beginNewSession, requestedContinuationWorkItemId]);

  const modelControl = (
    <div className="agentModelControls">
    <ModelSwitch
      options={agentModelOptions}
      selectionKind="profile"
      value={selectedModelProfileId}
      onChange={setSelectedModelProfileId}
      label={copy.model}
      hint={copy.modelHint}
      loading={modelCatalog.isLoading}
      unavailableLabel={copy.unavailable}
      historicalLabel={copy.historical}
      groupLabels={{ text: copy.textModels, multimodal: copy.multimodalModels }}
      getOptionGroup={agentModelGroup}
      capabilityLabels={{
        chat: copy.chatCapability,
        tool_calling: copy.toolCapability,
        structured_output: copy.structuredCapability,
        image_input: copy.imageInputCapability,
      }}
      unavailableReason=""
      testId="loopops.main-agent.model"
    />
    </div>
  );

  function clearAttachment(clientId, { deleteRemote = true } = {}) {
    const current = attachments.find((item) => item.clientId === clientId);
    cancelledAttachmentIds.current.add(clientId);
    setAttachments((items) => items.filter((item) => item.clientId !== clientId));
    if (deleteRemote && current?.attachmentId) {
      attachmentMutations.deleteAttachment.mutate({
        attachmentId: current.attachmentId,
        idempotencyKey: mutationKey("delete-attachment"),
      });
    }
  }

  function clearAllAttachments({ deleteRemote = true } = {}) {
    for (const attachment of attachments) {
      cancelledAttachmentIds.current.add(attachment.clientId);
    }
    const remoteAttachmentIds = deleteRemote
      ? attachments.map((item) => item.attachmentId).filter(Boolean)
      : [];
    setAttachments([]);
    for (const attachmentId of remoteAttachmentIds) {
      attachmentMutations.deleteAttachment.mutate({
        attachmentId,
        idempotencyKey: mutationKey("delete-attachment"),
      });
    }
  }

  async function uploadAttachment(file, { clientId = mutationKey("attachment"), replace = false } = {}) {
    if (!replace && attachments.length >= 8) {
      setSubmitError(locale === "zh" ? "一次最多添加 8 个文件。" : "Add no more than 8 files at a time.");
      return;
    }
    cancelledAttachmentIds.current.delete(clientId);
    setSubmitError("");
    setAttachments((items) => {
      const pending = {
        clientId,
        file,
        name: file.name,
        mediaType: file.type,
        status: "uploading",
        progress: 10,
      };
      return replace
        ? items.map((item) => item.clientId === clientId ? pending : item)
        : [...items, pending];
    });
    try {
      const result = await attachmentMutations.createAttachment.mutateAsync({
        file,
        idempotencyKey: `upload-${clientId}`,
      });
      const record = result.data.attachment;
      if (cancelledAttachmentIds.current.has(clientId)) {
        await attachmentMutations.deleteAttachment.mutateAsync({
          attachmentId: record.attachmentId,
          idempotencyKey: mutationKey("delete-orphaned-attachment"),
        }).catch(() => {});
        return;
      }
      setAttachments((items) => items.map((item) => item.clientId === clientId ? {
        ...item,
        name: record.fileName,
        mediaType: record.mediaType,
        attachmentId: record.attachmentId,
        status: record.processing.status,
        retryable: record.processing.retryable,
        error: record.processing.status === "ready" ? "" : record.processing.message,
        progress: 100,
        ref: record.processing.status === "ready" ? {
          attachmentId: record.attachmentId,
          version: record.version,
          contentHash: record.contentHash,
          mediaType: record.mediaType,
        } : null,
      } : item));
    } catch (error) {
      if (cancelledAttachmentIds.current.has(clientId)) return;
      setAttachments((items) => items.map((item) => item.clientId === clientId ? {
        ...item,
        status: "failed",
        retryable: true,
        error: error?.message || copy.attachmentFailed,
      } : item));
    }
  }

  async function retryAttachment(clientId) {
    const attachment = attachments.find((item) => item.clientId === clientId);
    if (!attachment) return;
    if (!attachment.attachmentId) {
      if (attachment.file) {
        await uploadAttachment(attachment.file, { clientId, replace: true });
      }
      return;
    }
    setAttachments((items) => items.map((item) => item.clientId === clientId
      ? { ...item, status: "processing", error: "" }
      : item));
    try {
      const result = await attachmentMutations.retryAttachment.mutateAsync({
        attachmentId: attachment.attachmentId,
        idempotencyKey: mutationKey("retry-attachment"),
      });
      const record = result.data.attachment;
      setAttachments((items) => items.map((item) => item.clientId === clientId ? {
        ...item,
        status: record.processing.status,
        retryable: record.processing.retryable,
        error: record.processing.status === "ready" ? "" : record.processing.message,
        ref: record.processing.status === "ready" ? {
          attachmentId: record.attachmentId,
          version: record.version,
          contentHash: record.contentHash,
          mediaType: record.mediaType,
        } : null,
      } : item));
    } catch (error) {
      setAttachments((items) => items.map((item) => item.clientId === clientId ? {
        ...item,
        status: "failed",
        retryable: true,
        error: error?.message || copy.attachmentFailed,
      } : item));
    }
  }

  async function submit() {
    const readyAttachments = attachments.filter((item) => item.status === "ready" && item.ref);
    if (
      (!prompt.trim() && !readyAttachments.length)
      || !selectedModelProfileId
      || !selectedCanSubmit(selectedOption)
      || attachments.some((item) => !attachmentSupportedByModel(item, selectedOption))
      || readyAttachments.length !== attachments.length
    ) return;
    setSubmitError("");
    if (requestedContinuationWorkItemId) {
      await submitWorkItemContinuationEntry(readyAttachments);
      return;
    }
    try {
      await agent.sendMessage(
        prompt.trim(),
        selectedModelProfileId,
        readyAttachments.map((item) => item.ref),
      );
      setPrompt("");
      setAttachments([]);
      setMobileView("task");
    } catch (error) {
      setSubmitError(error?.message || (locale === "zh" ? "任务没有提交成功，请重试。" : "The task could not be submitted."));
    }
  }

  function openTeamWorkEntry() {
    if (!prompt.trim() || !selectedModelProfileId || !selectedCanSubmit(selectedOption)) {
      setSubmitError(locale === "zh"
        ? "先输入要委派的任务，并选择可用模型。"
        : "Enter the task to delegate and choose an available model first.");
      return;
    }
    setSubmitError("");
    setTeamWorkEntryError("");
    setTeamWorkEntryOpen(true);
  }

  async function createTeamWorkEntry(data) {
    const readyAttachments = attachments.filter((item) => item.status === "ready" && item.ref);
    if (readyAttachments.length !== attachments.length) return;
    setTeamWorkEntryError("");
    try {
      const result = await teamWorkMutations.createTeamWorkItemAgentEntry.mutateAsync({
        principal,
        idempotencyKey: mutationKey("create-team-work-item-agent-entry"),
        data: {
          ...data,
          modelProfileId: selectedModelProfileId,
          initialTask: {
            message: prompt.trim(),
            ...(readyAttachments.length ? { attachments: readyAttachments.map((item) => item.ref) } : {}),
          },
        },
      });
      const sessionId = result?.data?.continuation?.agentSessionId;
      if (!sessionId) throw new Error("team_work_agent_entry_session_missing");
      setTeamWorkEntryOpen(false);
      // The accepted Turn owns these attachments now. Clear the composer, but
      // do not issue delete requests for refs that were just persisted with it.
      selectSession(sessionId, { deleteAttachmentsRemotely: false });
    } catch (error) {
      setTeamWorkEntryError(error?.message || copy.teamEntryUnavailable);
    }
  }

  function selectSession(sessionId, { deleteAttachmentsRemotely = true } = {}) {
    agent.selectSession(sessionId);
    const nextUrl = new URL(globalThis.location?.href || "http://localhost/");
    nextUrl.pathname = "/";
    nextUrl.searchParams.set("session", sessionId);
    nextUrl.searchParams.delete("new");
    nextUrl.searchParams.delete("proposal");
    nextUrl.searchParams.delete("workItem");
    nextUrl.searchParams.delete("continueWorkItem");
    workspace.navigateToPath(
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
      { replace: true },
    );
    setPrompt("");
    clearAllAttachments({ deleteRemote: deleteAttachmentsRemotely });
    setSubmitError("");
    setResultRecord(null);
    setWorkItemDialogOpen(false);
    setWorkItemPromotion(null);
    setWorkItemPromotionError("");
    setWorkItemContinuationError("");
    setMobileView("task");
  }

  function beginNewSession() {
    agent.beginNewSession();
    const nextUrl = new URL(globalThis.location?.href || "http://localhost/");
    nextUrl.searchParams.delete("session");
    nextUrl.searchParams.delete("new");
    nextUrl.searchParams.delete("proposal");
    nextUrl.searchParams.delete("workItem");
    nextUrl.searchParams.delete("continueWorkItem");
    workspace.navigateToPath(
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
      { replace: true },
    );
    setPrompt("");
    clearAllAttachments();
    setResultRecord(null);
    setWorkItemDialogOpen(false);
    setWorkItemPromotion(null);
    setWorkItemPromotionError("");
    setWorkItemContinuationError("");
    setSubmitError("");
    setMobileView("task");
  }

  useEffect(() => {
    navigation.taskActions.current = { newTask: beginNewSession, selectTask: selectSession };
    return () => { navigation.taskActions.current = null; };
  });
  useEffect(() => { navigation.setActiveSessionId(agent.draftingNewSession ? "" : agent.sessionId); }, [agent.sessionId, agent.draftingNewSession, navigation.setActiveSessionId]);
  const newTaskRequest = routeQuery.get("new");
  const handledNewTaskRequest = useRef(null);
  useEffect(() => {
    if (!newTaskRequest || handledNewTaskRequest.current === newTaskRequest) return;
    handledNewTaskRequest.current = newTaskRequest;
    beginNewSession();
  }, [newTaskRequest]);

  function openResult(record, trigger) {
    resultTrigger.current = trigger;
    setResultRecord(record);
    setMobileView("result");
  }

  function openWorkItemPromotion() {
    setWorkItemPromotionError("");
    setWorkItemDialogOpen(true);
  }

  function closeWorkItemPromotion() {
    if (workItemPromotionMutation.isPending) return;
    setWorkItemDialogOpen(false);
    setWorkItemPromotionError("");
  }

  async function promoteToWorkItem(data) {
    if (!selectedSession?.sessionId) return;
    setWorkItemPromotionError("");
    try {
      const result = await workItemPromotionMutation.mutateAsync({
        sessionId: selectedSession.sessionId,
        data,
        idempotencyKey: mutationKey("promote-agent-session-to-work-item"),
        principal,
      });
      setWorkItemPromotion(result.data);
      setWorkItemDialogOpen(false);
    } catch (error) {
      setWorkItemPromotionError(error?.message || (
        locale === "zh" ? "团队工作创建失败，请重试。" : "The shared Work Item could not be created."
      ));
    }
  }

  function openWorkItemDetail(workItemId) {
    if (!workItemId) return;
    setWorkItemContinuationError("");
    const nextUrl = new URL(globalThis.location?.href || "http://localhost/");
    nextUrl.pathname = "/";
    nextUrl.searchParams.set("workItem", workItemId);
    nextUrl.searchParams.delete("continueWorkItem");
    workspace.navigateToPath(
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
      { replace: false },
    );
  }

  function closeWorkItemDetail() {
    if (workItemContinuationAgentEntryMutation.isPending
      || workItemThreadCommentMutation.isPending
      || workItemDecisionMutation.isPending) return;
    const nextUrl = new URL(globalThis.location?.href || "http://localhost/");
    nextUrl.searchParams.delete("workItem");
    nextUrl.searchParams.delete("continueWorkItem");
    workspace.navigateToPath(
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
      { replace: true },
    );
    setWorkItemContinuationError("");
  }

  function beginWorkItemContinuation() {
    if (!requestedWorkItemId) return;
    agent.beginNewSession();
    setPrompt("");
    clearAllAttachments();
    setSubmitError("");
    setWorkItemContinuationError("");
    const nextUrl = new URL(globalThis.location?.href || "http://localhost/");
    nextUrl.pathname = "/";
    nextUrl.searchParams.delete("session");
    nextUrl.searchParams.delete("new");
    nextUrl.searchParams.delete("proposal");
    nextUrl.searchParams.delete("workItem");
    nextUrl.searchParams.set("continueWorkItem", requestedWorkItemId);
    workspace.navigateToPath(
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
      { replace: true },
    );
  }

  function cancelWorkItemContinuation() {
    const nextUrl = new URL(globalThis.location?.href || "http://localhost/");
    nextUrl.searchParams.delete("continueWorkItem");
    workspace.navigateToPath(
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
      { replace: true },
    );
    setWorkItemContinuationError("");
  }

  async function submitWorkItemContinuationEntry(readyAttachments) {
    if (!requestedContinuationWorkItemId) return;
    setWorkItemContinuationError("");
    try {
      const result = await workItemContinuationAgentEntryMutation.mutateAsync({
        workItemId: requestedContinuationWorkItemId,
        idempotencyKey: mutationKey("create-work-item-continuation-agent-entry"),
        principal,
        data: {
          modelProfileId: selectedModelProfileId,
          initialTask: {
            message: prompt.trim(),
            ...(readyAttachments.length ? { attachments: readyAttachments.map((item) => item.ref) } : {}),
          },
        },
      });
      const sessionId = result?.data?.continuation?.agentSessionId;
      if (!sessionId) throw new Error("work_item_continuation_session_missing");
      selectSession(sessionId, { deleteAttachmentsRemotely: false });
    } catch (error) {
      setWorkItemContinuationError(error?.message || (
        locale === "zh" ? "无法接续这项工作，请重试。" : "Your Work Item continuation could not be created."
      ));
    }
  }

  async function addWorkItemComment(content) {
    if (!requestedWorkItemId) return;
    return workItemThreadCommentMutation.mutateAsync({
      workItemId: requestedWorkItemId,
      data: { content },
      idempotencyKey: mutationKey("create-work-item-thread-comment"),
      principal,
    });
  }

  async function recordWorkItemDecision(data) {
    if (!requestedWorkItemId) return;
    return workItemDecisionMutation.mutateAsync({
      workItemId: requestedWorkItemId,
      data,
      idempotencyKey: mutationKey("record-work-item-decision"),
      principal,
    });
  }

  function closeResult() {
    setResultRecord(null);
    setMobileView("task");
    queueMicrotask(() => resultTrigger.current?.focus());
  }

  function persistResultReaderWidth(width) {
    try {
      globalThis.localStorage?.setItem(
        resultReaderStorageKey(workspace.session?.userId),
        String(Math.round(clampResultReaderWidth(width))),
      );
    } catch {
      // Width persistence is an optional per-user UI preference.
    }
  }

  function resetResultReaderWidth() {
    setResultReaderWidth(RESULT_READER_DEFAULT_WIDTH);
    persistResultReaderWidth(RESULT_READER_DEFAULT_WIDTH);
  }

  async function decideProposal(decision) {
    if (!requestedSessionId || !requestedProposalId) return;
    setProposalDecisionError("");
    try {
      await proposalMutations[decision === "apply" ? "applyProposal" : "rejectProposal"].mutateAsync({
        sessionId: requestedSessionId,
        proposalId: requestedProposalId,
        idempotencyKey: mutationKey(`${decision}-agent-proposal`),
        principal,
      });
    } catch (error) {
      setProposalDecisionError(error?.message || (
        locale === "zh" ? "提案处理失败，请重试。" : "The proposal could not be processed."
      ));
    }
  }

  const sessionTitle = agent.draftingNewSession
    ? copy.newTask
    : selectedSession?.title || copy.newTask;
  const hasTaskContent = selectedSession?.source?.kind === "loop_run" || agent.history.length > 0;
  const modelReady = selectedCanSubmit(selectedOption);
  const requestedSessionUnavailable = agent.requestedSessionError === "session_not_found_or_forbidden";
  const continuationEntryLoading = Boolean(
    requestedContinuationWorkItemId && requestedWorkItem.isLoading,
  );
  const continuationEntryUnavailable = Boolean(
    requestedContinuationWorkItemId && requestedWorkItem.error,
  );
  const continuationEntryReady = !requestedContinuationWorkItemId || Boolean(continuationWorkItem);
  const promotablePrivateTask = Boolean(
    selectedSession?.sessionId
      && selectedSession?.scope?.kind === "main"
      && selectedSession?.source?.kind === "manual"
      && !selectedSession?.workItemContext
      && selectedSession?.taskStatus === "completed"
      && !workspace.readOnlyWorkspace,
  );
  const composerDisabledReason = requestedSessionUnavailable
    ? copy.requestedSessionUnavailable
    : continuationEntryLoading
      ? copy.continuationEntryLoading
      : continuationEntryUnavailable
        ? copy.continuationEntryUnavailable
    : workspace.readOnlyWorkspace
    ? (locale === "zh" ? "你现在只能查看，不能提交任务。" : "You can view this workspace but cannot submit tasks.")
    : agent.loading || modelCatalog.isLoading
      ? copy.loadingModel
      : !modelReady ? copy.modelTaskUnsupported : "";
  const pageError = workItemContinuationError || submitError || agent.error?.message || modelCatalog.error?.message || "";
  const composer = (
          <div className="agentComposerDock" data-testid="loopops.main-agent.composer">
            {!modelCatalog.isLoading && !agentModelOptions.some((option) => !option.disabled) ? (
              <div
                className="agentModelNotice"
                role="status"
                data-testid="loopops.main-agent.model-unavailable"
              >
                <Bot size={16} aria-hidden="true" />
                <span>{canConfigureModel ? (locale === "zh" ? "连接模型，开始你的第一项任务。" : "Connect a model to start your first task.") : copy.noModel}</span>
                {canConfigureModel ? <button type="button" onClick={() => navigation.openSettings()}>{locale === "zh" ? "连接模型" : "Connect model"}</button> : null}
                <button type="button" onClick={() => modelCatalog.refetch()}>{copy.retryLoad}</button>
              </div>
            ) : null}
            <TaskComposer
              value={prompt}
              onChange={setPrompt}
              attachments={attachments}
              onAttachment={uploadAttachment}
              onRemoveAttachment={(clientId) => clearAttachment(clientId)}
              onRetryAttachment={retryAttachment}
              modelControl={modelControl}
              selectedOption={selectedOption}
              disabled={requestedSessionUnavailable
                || agent.loading
                || !continuationEntryReady
                || workspace.readOnlyWorkspace}
              submissionDisabled={!modelReady}
              disabledReason={composerDisabledReason}
              busy={agent.busy || workItemContinuationAgentEntryMutation.isPending}
              queueing={agent.running}
              onSubmit={submit}
              copy={{ ...copy, continuePrompt: hasTaskContent ? copy.continuePrompt : copy.prompt }}
            />
            {pageError ? <p className="agentComposerError" role="alert">{pageError}</p> : null}
          </div>
  );

  return (
    <div className="mainAgentPage" data-testid="loopops.main-agent.page">
      <div
        className={`agentWorkspaceGrid ${resultRecord ? "readerOpen" : ""}`}
        style={resultRecord ? { "--agent-reader-width": `${resultReaderWidth}px` } : undefined}
        data-mobile-view={mobileView}
        data-testid="loopops.main-agent.surface"
      >

        <section className={`agentTaskWorkspace ${!hasTaskContent ? "isNewTask" : ""}`} aria-label={sessionTitle}>
          <header className="agentTaskHeader">
            <button type="button" className="agentTaskMobileBack" onClick={() => setMobileView("sessions")}>
              <ArrowLeft size={16} aria-hidden="true" />
              {copy.backToTasks}
            </button>
            <div>
              {hasTaskContent ? <h1>{sessionTitle}</h1> : <h2>{sessionTitle}</h2>}
              <span className={`agentTaskStatus status-${selectedSession?.taskStatus || "idle"}`}>
                {copy[selectedSession?.taskStatus] || copy.ready}
              </span>
            </div>
            {selectedSession?.workItemContext ? (
              <button
                type="button"
                className="agentTaskShareButton"
                onClick={() => openWorkItemDetail(selectedSession.workItemContext.workItemId)}
                data-testid="loopops.main-agent.work-item.return"
              >
                <Share2 size={14} aria-hidden="true" />
                <span>{locale === "zh" ? "团队工作与进展" : "Team work and progress"}</span>
              </button>
            ) : promotablePrivateTask ? (
              <button
                type="button"
                className="agentTaskShareButton"
                onClick={openWorkItemPromotion}
                data-testid="loopops.main-agent.work-item.open"
              >
                <Share2 size={14} aria-hidden="true" />
                <span>{copy.shareWorkItem}</span>
              </button>
            ) : null}
          </header>

          {requestedProposalId ? (
            <section className="agentProposalReview" aria-live="polite" data-testid="loopops.main-agent.requested-proposal">
              <header>
                <span><Sparkles size={16} aria-hidden="true" /></span>
                <div>
                  <strong>{locale === "zh" ? "个人分支提案" : "Personal branch proposal"}</strong>
                  <small>{proposalRecord?.status || (requestedProposal.isLoading ? (locale === "zh" ? "正在加载" : "Loading") : requestedProposalId)}</small>
                </div>
              </header>
              {proposalRecord ? (
                <>
                  <p>{proposalRecord.summary}</p>
                  <ol>
                    {(proposalRecord.operations || []).slice(0, 12).map((operation, index) => (
                      <li key={`${operation.path}-${index}`}>
                        <code>{operation.op}</code>
                        <span>{operation.path}</span>
                      </li>
                    ))}
                  </ol>
                  {(proposalRecord.operations || []).length > 12 ? (
                    <small>
                      {locale === "zh"
                        ? `另有 ${proposalRecord.operations.length - 12} 项变更`
                        : `${proposalRecord.operations.length - 12} more changes`}
                    </small>
                  ) : null}
                  {["proposed", "conflicting"].includes(proposalRecord.status) ? (
                    <div className="agentProposalActions">
                      <button
                        type="button"
                        data-testid="loopops.main-agent.proposal.reject"
                        onClick={() => decideProposal("reject")}
                        disabled={proposalMutations.rejectProposal.isPending || proposalMutations.applyProposal.isPending}
                      >
                        {locale === "zh" ? "拒绝提案" : "Reject"}
                      </button>
                      {proposalRecord.status === "proposed" ? (
                        <button
                          type="button"
                          className="primary"
                          data-testid="loopops.main-agent.proposal.apply"
                          onClick={() => decideProposal("apply")}
                          disabled={proposalMutations.rejectProposal.isPending || proposalMutations.applyProposal.isPending}
                        >
                          {locale === "zh" ? "应用到正式对象" : "Apply to canonical object"}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : requestedProposal.error ? (
                <p role="alert">{requestedProposal.error.message}</p>
              ) : null}
              <small>
                {locale === "zh"
                  ? "系统会在后端进行三方合并；同路径冲突不会修改正式对象。"
                  : "The server performs a three-way merge; same-path conflicts never modify the canonical object."}
              </small>
              {proposalDecisionError ? <p role="alert">{proposalDecisionError}</p> : null}
            </section>
          ) : null}

          <div className="agentConversationScroll">
            {requestedContinuationWorkItemId && (continuationWorkItem || continuationEntryLoading || continuationEntryUnavailable) ? (
              <section
                className="agentWorkItemPromotionReceipt"
                role="status"
                data-testid="loopops.main-agent.work-item.continuation.entry"
              >
                <Check size={15} aria-hidden="true" />
                <div>
                  <strong>{continuationWorkItem
                    ? `${copy.continuationEntryTitle}: ${continuationWorkItem.title}`
                    : copy.continuationEntryTitle}</strong>
                  <span>{continuationEntryLoading
                    ? copy.continuationEntryLoading
                    : continuationEntryUnavailable
                      ? copy.continuationEntryUnavailable
                      : copy.continuationEntryHint}</span>
                </div>
                <button
                  type="button"
                  className="agentWorkItemReceiptAction"
                  onClick={cancelWorkItemContinuation}
                  disabled={workItemContinuationAgentEntryMutation.isPending}
                  data-testid="loopops.main-agent.work-item.continuation.cancel"
                >
                  {copy.continuationEntryCancel}
                </button>
              </section>
            ) : null}
            {workItemPromotion ? (
              <section className="agentWorkItemPromotionReceipt" role="status" data-testid="loopops.main-agent.work-item.receipt">
                <Check size={15} aria-hidden="true" />
                <div>
                  <strong>{copy.workItemReady}</strong>
                  <span>{copy.workItemReadyHint}</span>
                </div>
                <button
                  type="button"
                  className="agentWorkItemReceiptAction"
                  onClick={() => openWorkItemDetail(workItemPromotion.workItem.workItemId)}
                  data-testid="loopops.main-agent.work-item.detail.open"
                >
                  {copy.openWorkItem}
                </button>
              </section>
            ) : null}
            {requestedSessionUnavailable ? (
              <div className="agentEmptyState" role="alert" data-testid="loopops.main-agent.requested-session-unavailable">
                <span className="agentEmptyIcon"><Bot size={19} aria-hidden="true" /></span>
                <div>
                  <h1>{copy.requestedSessionTitle}</h1>
                  <p>{copy.requestedSessionUnavailable}</p>
                </div>
                <Button variant="primary" onClick={beginNewSession}>{copy.newTask}</Button>
              </div>
            ) : selectedSession?.source?.kind === "loop_run" ? (
              <LoopRunTimeline
                detail={loopTask.detail}
                invocations={loopTask.invocations}
                executionEvents={loopTask.executionEvents}
                loading={loopTask.loading}
                error={loopTask.error}
                detailsError={loopTask.detailsError}
                cancelling={loopTask.cancelling}
                locale={locale}
                copy={copy}
                onRetry={loopTask.retry}
                onCancel={() => loopTask.cancel(copy.loopRunCancelReason)}
                onOpenResult={openResult}
                hasEarlier={agent.hasEarlierTurns}
                loadingEarlier={agent.loadingEarlier}
                onLoadEarlier={agent.loadEarlierTurns}
              />
            ) : agent.history.length ? (
              <TurnTimeline
                session={selectedSession}
                turns={agent.history}
                events={agent.events}
                activeTurn={agent.activeTurn}
                locale={locale}
                copy={copy}
                onCancel={() => agent.cancelActive()}
                onRetry={agent.retry}
                onOpenResult={openResult}
                hasEarlier={agent.hasEarlierTurns}
                loadingEarlier={agent.loadingEarlier}
                onLoadEarlier={agent.loadEarlierTurns}
              />
            ) : requestedContinuationWorkItemId ? (
              <div className="agentEmptyState agentContinuationBrief">
                <div>
                  <h1>{locale === "zh" ? "下一步，想完成什么？" : "What should happen next?"}</h1>
                  {continuationWorkItem?.objective ? <p>{continuationWorkItem.objective}</p> : null}
                </div>
                {composer}
              </div>
            ) : (
              <AgentEmptyState
                copy={copy}
                onExample={setPrompt}
                onNewTeamWork={openTeamWorkEntry}
                onContinueWork={() => workspace.navigateToPath("/work")}
              >
                {composer}
              </AgentEmptyState>
            )}
          </div>

          {hasTaskContent || requestedSessionUnavailable ? composer : null}
        </section>

        {resultRecord ? (
          <>
            <ResultReaderResizeHandle
              width={resultReaderWidth}
              onChange={setResultReaderWidth}
              onCommit={persistResultReaderWidth}
              onReset={resetResultReaderWidth}
              locale={locale}
            />
            <AgentResultReader
              record={resultRecord}
              session={selectedSession}
              locale={locale}
              modelLabel={(revisionId) => revisionLabel(modelCatalog.profiles, revisionId, locale)}
              onClose={closeResult}
            />
          </>
        ) : null}
      </div>

      <PromoteToWorkItemDialog
        open={workItemDialogOpen}
        session={selectedSession}
        artifacts={promotionArtifacts}
        participantsQuery={workItemPromotionParticipants}
        submitting={workItemPromotionMutation.isPending}
        error={workItemPromotionError}
        locale={locale}
        onClose={closeWorkItemPromotion}
        onSubmit={promoteToWorkItem}
      />
      <TeamWorkEntryDialog
        open={teamWorkEntryOpen}
        copy={copy}
        locale={locale}
        prompt={prompt}
        projects={teamWorkProjects.data?.data || []}
        directory={teamWorkParticipants.data?.data || []}
        currentUserId={principal.userId}
        submitting={teamWorkMutations.createTeamWorkItemAgentEntry.isPending}
        error={teamWorkEntryError}
        onClose={() => {
          if (teamWorkMutations.createTeamWorkItemAgentEntry.isPending) return;
          setTeamWorkEntryOpen(false);
          setTeamWorkEntryError("");
        }}
        onSubmit={createTeamWorkEntry}
      />
      <WorkItemHandoffDialog
        open={Boolean(requestedWorkItemId)}
        detailQuery={requestedWorkItem}
        threadQuery={requestedWorkItemThread}
        currentUserId={principal.userId}
        locale={locale}
        onClose={closeWorkItemDetail}
        onContinue={beginWorkItemContinuation}
        onAddComment={addWorkItemComment}
        onRecordDecision={recordWorkItemDecision}
        postingComment={workItemThreadCommentMutation.isPending}
        recordingDecision={workItemDecisionMutation.isPending}
        continuationError={workItemContinuationError}
      />
    </div>
  );
}
