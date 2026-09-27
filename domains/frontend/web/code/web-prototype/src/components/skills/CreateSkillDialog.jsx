import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  FileCode2,
  FileText,
  FileUp,
  Plus,
  ShieldCheck,
  Trash2,
  Wrench,
  Workflow,
  X,
} from "lucide-react";

import { Button, Dialog, SegmentedControl } from "../../design-system/index.jsx";
import { useAttachmentMutations } from "../../api/queries.js";
import { useResponsiveCapability } from "../../hooks/useResponsiveCapability.js";
import {
  packageSize,
  registeredToolSkillPackage,
} from "./draft-skill-package.js";
import {
  acceptsMaterialMediaType,
  materialAcceptAttribute,
  materialFormatOptions,
  materialFormatSummary,
  materialMediaTypeForFile,
  normalizeMaterialMediaTypes,
  SUPPORTED_MATERIAL_MEDIA_TYPES,
  toggleMaterialFormat,
} from "./material-formats.js";
import {
  appendScenarioTags,
  parseScenarioTags,
  removeScenarioTag,
  SCENARIO_TAG_LIMITS,
} from "./multi-value-inputs.js";
import { unpackZipSkillPackage } from "./zip-skill-package.js";
import "../../styles/skills.css";

const SKILL_CATEGORIES = ["finance", "research", "coding", "automation", "image", "data", "ops", "other"];
const DEFINITION_STEPS = ["type", "contract", "runtime", "organize", "draft", "smoke", "review"];
const PARAMETER_TYPES = ["string", "number", "boolean", "json", "markdown"];
const OUTPUT_TYPES = ["json", "markdown", "string", "file"];
const initialRepository = {
  repositoryUrl: "",
  ref: "main",
  skillDirectory: "",
};

function row(kind, values = {}) {
  const rowId = `${kind}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
  return {
    rowId,
    name: "",
    description: "",
    required: kind === "material",
    type: kind === "material" ? "file" : kind === "output" ? "json" : "string",
    ...(kind === "material" ? {
      identifier: `material_${rowId.replace(/[^A-Za-z0-9]/g, "").slice(-10)}`,
      acceptedMediaTypes: [],
    } : {}),
    ...values,
  };
}

function initialForm(locale = "en") {
  return {
    name: "",
    description: "",
    category: "other",
    materials: [],
    parameters: [],
    outputs: [row("output", {
      name: "result",
      description: String(locale).toLowerCase().startsWith("zh") ? "主要产物" : "Primary result",
    })],
    tags: "",
    runtimeId: "",
    timeoutSeconds: null,
    memoryMiB: null,
    smokePurpose: "",
    smokeInput: "",
    expectedOutcome: "",
  };
}

function normalizeMode(value) {
  if (value === "define" || value === "create") return "create";
  return ["tool", "files", "zip", "repository", "server"].includes(value) ? value : "create";
}

function requestedMode(workspace, embedded) {
  let mode;
  if (embedded && typeof globalThis.location?.search === "string") {
    const routeMode = new URLSearchParams(globalThis.location.search).get("mode");
    if (routeMode) mode = normalizeMode(routeMode);
  }
  mode ||= normalizeMode(workspace.createSkillDialogMode);
  return mode === "server" && workspace.authUser?.role !== "admin" ? "files" : mode;
}

function requestedRuntimeRecovery(embedded) {
  if (!embedded || typeof globalThis.location?.search !== "string") return "";
  const query = new URLSearchParams(globalThis.location.search);
  return query.get("setup") === "runtime" ? query.get("runtimeId") || "" : "";
}

function localCopy(locale) {
  const zh = String(locale || "").toLowerCase().startsWith("zh");
  return zh ? {
    stepCount: (step) => `第 ${step} 步，共 7 步`,
    define: "定义新技能",
    defineHint: "从职责、材料和产物开始，生成可检查的私有草稿。",
    import: "导入已有技能",
    importHint: "检查文件夹、ZIP、公共 GitHub 仓库或管理员目录。",
    responsibilities: "职责",
    materials: "需要的材料",
    materialsHint: "要分析的文件；可以没有。",
    materialDeclarationHint: "这里只声明运行时需要什么，不会上传文件。试运行样本在第 6 步提供。",
    parameters: "需要的参数",
    parametersHint: "运行时入参；可以没有。",
    outputs: "会生成什么",
    addMaterial: "添加材料要求",
    addParameter: "添加参数",
    addOutput: "添加产物",
    identifier: "字段名",
    materialName: "材料名称",
    materialPurpose: "用途说明",
    acceptedFormats: "接受格式",
    acceptedFormatsHint: "至少选择一种；第 6 步的文件和工作区材料会按这里过滤。",
    acceptedFormatsRequired: "请至少选择一种接受格式。",
    acceptedFormatsPlaceholder: "选择可接受的格式",
    selectedFormats: (count) => `已选择 ${count} 种格式`,
    documentFormats: "文本与文档",
    imageFormats: "图片",
    selectAll: "全选",
    clearSelection: "清空",
    materialFormatMismatch: "这个文件的格式不符合该材料要求，请选择上面声明的格式。",
    materialResourceFormatMismatch: "这个工作区材料的格式不符合该材料要求。",
    compatibleResourcesOnly: "只显示格式匹配、处理完成的工作区材料。",
    description: "说明",
    required: "必须",
    optional: "可选",
    remove: "移除",
    runtimeUnavailable: "当前工作区尚未配置这个隔离运行环境。",
    runtimeLoading: "正在读取工作区运行环境…",
    runtimeError: "运行环境目录暂时不可用。",
    noRuntime: "当前工作区没有可用的隔离运行环境，请联系管理员配置。",
    scaffoldError: "草稿文件暂时无法由 Product API 生成，请重试。",
    scaffolding: "正在生成草稿文件…",
    retry: "重试",
    isolated: "隔离容器",
    noNetwork: "无网络",
    scratchOnly: "仅临时目录",
    timeout: "超时",
    memory: "内存",
    seconds: "秒",
    riskTitle: "风险由系统推导",
    riskBody: "你不需要自评风险。系统会根据代码、权限、Action 绑定与运行边界检查后给出结果。",
    files: "将生成的文件",
    preview: "内容预览",
    smokePurpose: "试运行要证明什么",
    smokePurposePlaceholder: "例如：能从会议记录生成负责人和截止日明确的行动项",
    smokeInput: "示例输入",
    expectedOptional: "预期效果（可选）",
    expectedHint: "这里只记录自然语言测试目的，不会伪装成 exact JSON assertion，也不会在向导里自动运行。",
    overview: "概述",
    definition: "定义",
    io: "材料、参数与产物",
    package: "包含文件",
    smoke: "试运行要证明",
    edit: "返回修改",
    privateTitle: "只创建私有草稿",
    privateBody: "只有你能看到；保存后不会自动运行、验证或发布。",
    saveDraft: "没问题，保存草稿",
    continue: "继续",
    previous: "上一步",
    cancel: "取消",
    tool: "接入工具",
    toolHint: "只能从团队已注册的精确 Action ID 导入。",
    toolCatalogTitle: "接入团队审批过的工具",
    toolCatalogBody: "只列出 Product API 返回的注册项；接入后仍需试跑、确认和发布。",
    toolCatalogLoading: "正在读取已注册工具…",
    toolCatalogError: "已注册工具目录暂时不可用。",
    toolCatalogEmpty: "团队还没有已注册的工具。",
    toolRegistered: "已注册",
    connectTool: "接入",
    exactActions: "精确 Action ID",
    toolRead: "读取",
    toolWrite: "写入",
    toolConfirmation: "执行前需确认",
    loop: "创建 Loop",
    loopHint: "Workflow 属于 Loop，不会在这里生成伪 Skill。",
    promptRuntime: "受治理的模型路由；不包含可执行代码。",
    chooseRuntime: "选择隔离运行环境",
    scenarioTags: "适合场景",
    scenarioTagsPlaceholder: "输入场景后按 Enter",
    scenarioTagsHint: `按 Enter 或逗号添加，最多 ${SCENARIO_TAG_LIMITS.maxItems} 个。`,
    scenarioTagsLimit: `最多添加 ${SCENARIO_TAG_LIMITS.maxItems} 个场景标签。`,
    removeScenarioTag: (tag) => `移除标签 ${tag}`,
    noRequirements: "不需要，直接就能跑",
    completeStep: "请补全当前步骤中的必填内容后继续。",
    fieldRequired: "此项必填",
    identifierInvalid: "字段名必须以字母开头，只能包含字母、数字、_ 或 -。",
    identifierDuplicate: "字段名与另一项重复。",
    prepareMaterials: "准备试运行材料",
    prepareMaterialsHint: "上传个人临时附件，或选择可复用的 Workspace Resource。样本不会写入 Skill Draft。",
    chooseWorkspaceMaterial: "选择工作区材料",
    orUploadMaterial: "或上传个人附件",
    materialProcessing: "处理中",
    materialRequired: "请为必需材料提供试运行样本。",
    removeMaterial: "移除",
    readinessDraft: "可创建 Draft",
    readinessTest: "可测试",
    readinessRun: "可运行",
    mobileImportTitle: "请在桌面端继续导入",
    mobileImportBody: "手机端只支持轻量定义新 Skill。目录、ZIP、GitHub 与服务器导入需要桌面浏览器。",
    copyDesktopLink: "复制桌面链接",
    desktopLinkCopied: "已复制",
    desktopLinkCopyFailed: "无法复制，请使用下方邮件链接或稍后重试。",
    emailDesktopLink: "通过邮件发送链接",
  } : {
    stepCount: (step) => `Step ${step} of 7`,
    define: "Define a new Skill",
    defineHint: "Start from responsibilities, materials, and outputs; create a reviewable private draft.",
    import: "Import an existing Skill",
    importHint: "Inspect a folder, ZIP, public GitHub repository, or admin directory.",
    responsibilities: "Responsibility",
    materials: "Required materials",
    materialsHint: "Files to analyze; this can be empty.",
    materialDeclarationHint: "Declare what a future run needs here. Upload first-test samples in step 6.",
    parameters: "Required parameters",
    parametersHint: "Runtime inputs; this can be empty.",
    outputs: "Generated outputs",
    addMaterial: "Add material requirement",
    addParameter: "Add parameter",
    addOutput: "Add output",
    identifier: "Field name",
    materialName: "Material name",
    materialPurpose: "Purpose",
    acceptedFormats: "Accepted formats",
    acceptedFormatsHint: "Choose at least one. Step 6 filters uploads and workspace materials by this contract.",
    acceptedFormatsRequired: "Choose at least one accepted format.",
    acceptedFormatsPlaceholder: "Choose accepted formats",
    selectedFormats: (count) => `${count} format${count === 1 ? "" : "s"} selected`,
    documentFormats: "Text and documents",
    imageFormats: "Images",
    selectAll: "Select all",
    clearSelection: "Clear",
    materialFormatMismatch: "This file does not match the accepted formats for this material.",
    materialResourceFormatMismatch: "This workspace material does not match the accepted formats.",
    compatibleResourcesOnly: "Only ready workspace materials with a matching format are shown.",
    description: "Description",
    required: "Required",
    optional: "Optional",
    remove: "Remove",
    runtimeUnavailable: "This isolated runtime is not configured for the workspace.",
    runtimeLoading: "Loading workspace runtimes…",
    runtimeError: "The runtime catalog is unavailable.",
    noRuntime: "No isolated runtime is ready for this workspace. Ask an administrator to configure one.",
    scaffoldError: "The Product API could not generate the draft package. Try again.",
    scaffolding: "Generating draft files…",
    retry: "Retry",
    isolated: "Isolated container",
    noNetwork: "No network",
    scratchOnly: "Scratch only",
    timeout: "Timeout",
    memory: "Memory",
    seconds: "sec",
    riskTitle: "Risk is system-derived",
    riskBody: "You do not self-assess risk. The system derives it after checking code, permissions, Action bindings, and isolation.",
    files: "Generated files",
    preview: "Content preview",
    smokePurpose: "What should the first test prove?",
    smokePurposePlaceholder: "For example: produce action items with clear owners and due dates",
    smokeInput: "Example input",
    expectedOptional: "Expected effect (optional)",
    expectedHint: "This is a natural-language test purpose, not an exact JSON assertion. The wizard does not run it automatically.",
    overview: "Overview",
    definition: "Definition",
    io: "Materials, parameters, and outputs",
    package: "Included files",
    smoke: "Test purpose",
    edit: "Edit",
    privateTitle: "Creates a private draft only",
    privateBody: "Only you can see it. Saving does not run, validate, or publish it.",
    saveDraft: "Save private draft",
    continue: "Continue",
    previous: "Previous",
    cancel: "Cancel",
    tool: "Connect a tool",
    toolHint: "Import only an exact Action ID registered by the team.",
    toolCatalogTitle: "Connect a team-approved tool",
    toolCatalogBody: "Only Product API registrations are listed. Testing, confirmation, and publication remain separate.",
    toolCatalogLoading: "Loading registered tools…",
    toolCatalogError: "The registered Tool catalog is unavailable.",
    toolCatalogEmpty: "No tools have been registered for this team.",
    toolRegistered: "Registered",
    connectTool: "Connect",
    exactActions: "Exact Action IDs",
    toolRead: "Read",
    toolWrite: "Write",
    toolConfirmation: "Confirmation required",
    loop: "Create a Loop",
    loopHint: "A Workflow is a Loop; no fake Skill is generated here.",
    promptRuntime: "Governed model route with no executable package code.",
    chooseRuntime: "Choose an isolated runtime",
    scenarioTags: "Best-fit scenarios",
    scenarioTagsPlaceholder: "Type a scenario and press Enter",
    scenarioTagsHint: `Press Enter or comma to add up to ${SCENARIO_TAG_LIMITS.maxItems}.`,
    scenarioTagsLimit: `Add no more than ${SCENARIO_TAG_LIMITS.maxItems} scenario tags.`,
    removeScenarioTag: (tag) => `Remove tag ${tag}`,
    noRequirements: "Nothing required; it can run directly",
    completeStep: "Complete the required fields in this step to continue.",
    fieldRequired: "Required",
    identifierInvalid: "Start with a letter and use only letters, numbers, _ or -.",
    identifierDuplicate: "This identifier duplicates another row.",
    prepareMaterials: "Prepare first-test materials",
    prepareMaterialsHint: "Upload a personal temporary attachment or choose a reusable Workspace Resource. Samples are not written into the Skill Draft.",
    chooseWorkspaceMaterial: "Choose workspace material",
    orUploadMaterial: "Or upload personal attachment",
    materialProcessing: "Processing",
    materialRequired: "Provide a first-test sample for each required material.",
    removeMaterial: "Remove",
    readinessDraft: "Draftable",
    readinessTest: "Testable",
    readinessRun: "Runnable",
    mobileImportTitle: "Continue import on desktop",
    mobileImportBody: "Mobile supports the lightweight Skill definition flow only. Folder, ZIP, GitHub, and server imports require a desktop browser.",
    copyDesktopLink: "Copy desktop link",
    desktopLinkCopied: "Copied",
    desktopLinkCopyFailed: "The link could not be copied. Use the email link below or retry.",
    emailDesktopLink: "Email the desktop link",
  };
}

async function encodeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary);
}

function decodeFile(file) {
  try {
    const binary = globalThis.atob(file.contentBase64);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return "";
  }
}

function browserPackageFiles(files) {
  const paths = files.map((file) => file.webkitRelativePath || file.name);
  const firstSegments = paths.map((path) => path.split("/", 1)[0]);
  const sharedDirectory = paths.every((path) => path.includes("/")) && new Set(firstSegments).size === 1
    ? `${firstSegments[0]}/`
    : "";
  return files.map((file, index) => ({
    file,
    path: sharedDirectory ? paths[index].slice(sharedDirectory.length) : paths[index],
  }));
}

function repositoryPreview(repository) {
  try {
    const url = new URL(repository.repositoryUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol !== "https:"
      || url.hostname !== "github.com"
      || url.username
      || url.password
      || url.search
      || url.hash
      || segments.length !== 2
    ) return null;
    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/, "");
    if (!owner || !repo) return null;
    return {
      owner,
      repo,
      ref: repository.ref.trim() || "main",
      subdirectory: repository.skillDirectory.trim() || "/",
    };
  } catch {
    return null;
  }
}

function uploadProgress(upload, fallbackPhase) {
  if (Number.isFinite(upload?.percent)) return { ...upload, phase: upload.phase || fallbackPhase, error: false };
  const totalBytes = Number(upload?.sizeBytes) || 0;
  const receivedBytes = Number(upload?.transfer?.receivedBytes) || 0;
  const complete = upload?.transfer?.complete === true
    || ["ready_draft", "needs_decision", "promoted"].includes(upload?.state);
  return {
    phase: complete
      ? "complete"
      : ["quarantined", "scanning", "parsing"].includes(upload?.state) ? "checking" : fallbackPhase,
    totalBytes,
    receivedBytes,
    percent: complete ? 100 : totalBytes > 0 ? (receivedBytes / totalBytes) * 100 : 0,
    error: upload?.state === "failed",
  };
}

function interfaceIdentifier(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^[^a-zA-Z]+/, "")
    .slice(0, 64);
}

function rowIssues(rows, copy, kind) {
  const normalized = rows.map((item) => interfaceIdentifier(
    kind === "material" ? item.identifier : item.name,
  ));
  return Object.fromEntries(rows.map((item, index) => {
    const issues = {};
    if (!item.name.trim()) issues.name = copy.fieldRequired;
    else if (kind !== "material" && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.name.trim())) issues.name = copy.identifierInvalid;
    else if (normalized.filter((value) => value === normalized[index]).length > 1) issues.name = copy.identifierDuplicate;
    if (!item.description.trim()) issues.description = copy.fieldRequired;
    if (kind === "material" && normalizeMaterialMediaTypes(item.acceptedMediaTypes).length === 0) {
      issues.acceptedMediaTypes = copy.acceptedFormatsRequired;
    }
    return [item.rowId, issues];
  }));
}

function rowsValid(rows, copy, kind) {
  return Object.values(rowIssues(rows, copy, kind)).every((issues) => Object.keys(issues).length === 0);
}

function ChoiceChips({ value, options, onChange, label }) {
  return (
    <div className="skillChoiceChips" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          className={value === option ? "active" : ""}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          key={option}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function MaterialFormatSelect({
  item,
  setItems,
  copy,
  locale,
  invalid,
  describedBy,
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState("below");
  const [panelMaxHeight, setPanelMaxHeight] = useState(420);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const options = materialFormatOptions(locale);
  const groups = [
    { label: copy.documentFormats, options: options.filter((option) => option.id !== "image") },
    { label: copy.imageFormats, options: options.filter((option) => option.id === "image") },
  ];
  const selectedMediaTypes = normalizeMaterialMediaTypes(item.acceptedMediaTypes);
  const selectedOptions = options.filter((option) => (
    option.mediaTypes.every((mediaType) => selectedMediaTypes.includes(mediaType))
  ));
  const summary = selectedOptions.length === 0
    ? copy.acceptedFormatsPlaceholder
    : selectedOptions.length <= 2
      ? selectedOptions.map((option) => option.label).join("、")
      : `${selectedOptions.slice(0, 2).map((option) => option.label).join("、")} +${selectedOptions.length - 2}`;

  const update = (acceptedMediaTypes) => {
    setItems((current) => current.map((entry) => (
      entry.rowId === item.rowId ? { ...entry, acceptedMediaTypes } : entry
    )));
  };

  const positionPopover = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportHeight = globalThis.window?.innerHeight || 720;
    const below = Math.max(0, viewportHeight - rect.bottom - 84);
    const above = Math.max(0, rect.top - 14);
    const nextPlacement = below < 300 && above > below ? "above" : "below";
    const available = nextPlacement === "above" ? above : below;
    setPlacement(nextPlacement);
    setPanelMaxHeight(Math.max(210, Math.min(420, available)));
  };

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    globalThis.document?.addEventListener("pointerdown", closeOnOutsidePointer);
    globalThis.window?.addEventListener("resize", positionPopover);
    return () => {
      globalThis.document?.removeEventListener("pointerdown", closeOnOutsidePointer);
      globalThis.window?.removeEventListener("resize", positionPopover);
    };
  }, [open]);

  return (
    <div
      className="skillMultiSelect"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="skillMultiSelectTrigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onClick={() => {
          if (!open) positionPopover();
          setOpen((current) => !current);
        }}
      >
        <span>
          <strong>{summary}</strong>
          <small>{copy.selectedFormats(selectedOptions.length)}</small>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="skillMultiSelectPopover"
          role="dialog"
          aria-label={copy.acceptedFormats}
          data-placement={placement}
          style={{ "--skill-multiselect-max-height": `${panelMaxHeight}px` }}
        >
          <div className="skillMultiSelectHeader">
            <strong>{copy.acceptedFormats}</strong>
            <span>{copy.selectedFormats(selectedOptions.length)}</span>
          </div>
          <div className="skillMultiSelectOptions" role="group" aria-label={copy.acceptedFormats}>
            {groups.map((group) => (
              <section key={group.label}>
                <h4>{group.label}</h4>
                {group.options.map((option) => {
                  const checked = option.mediaTypes.every((mediaType) => selectedMediaTypes.includes(mediaType));
                  return (
                    <label className={checked ? "selected" : ""} key={option.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => update(toggleMaterialFormat(item.acceptedMediaTypes, option.id))}
                      />
                      <span>{option.label}</span>
                    </label>
                  );
                })}
              </section>
            ))}
          </div>
          <div className="skillMultiSelectActions">
            <button
              type="button"
              onClick={() => update([...SUPPORTED_MATERIAL_MEDIA_TYPES])}
              disabled={selectedMediaTypes.length === SUPPORTED_MATERIAL_MEDIA_TYPES.length}
            >
              {copy.selectAll}
            </button>
            <button type="button" onClick={() => update([])} disabled={selectedMediaTypes.length === 0}>
              {copy.clearSelection}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ScenarioTagInput({ value, onChange, copy }) {
  const inputId = useId();
  const inputRef = useRef(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const tags = parseScenarioTags(value);

  const commit = (source) => {
    const candidate = String(source ?? "").trim();
    if (!candidate) return;
    const next = appendScenarioTags(tags, candidate);
    const attempted = parseScenarioTags([...tags, ...candidate.split(/[,，]/)]);
    if (tags.length >= SCENARIO_TAG_LIMITS.maxItems && next.length === tags.length) {
      setError(copy.scenarioTagsLimit);
      return;
    }
    if (attempted.length >= SCENARIO_TAG_LIMITS.maxItems
      && candidate.split(/[,，]/).filter((entry) => entry.trim()).length > next.length - tags.length) {
      setError(copy.scenarioTagsLimit);
    } else {
      setError("");
    }
    onChange(next.join(", "));
    setDraft("");
  };

  return (
    <div className="skillTagField">
      <label htmlFor={inputId}>{copy.scenarioTags}</label>
      <div
        className="skillTagInput"
        data-limit-reached={tags.length >= SCENARIO_TAG_LIMITS.maxItems ? "true" : undefined}
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((tag) => (
          <span className="skillTagToken" key={tag}>
            {tag}
            <button
              type="button"
              aria-label={copy.removeScenarioTag(tag)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                onChange(removeScenarioTag(tags, tag).join(", "));
                setError("");
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          ref={inputRef}
          value={draft}
          maxLength={SCENARIO_TAG_LIMITS.maxLength}
          placeholder={tags.length ? "" : copy.scenarioTagsPlaceholder}
          aria-describedby={`${inputId}-hint${error ? ` ${inputId}-error` : ""}`}
          aria-invalid={error ? "true" : undefined}
          disabled={tags.length >= SCENARIO_TAG_LIMITS.maxItems}
          onBlur={() => commit(draft)}
          onChange={(event) => {
            const next = event.target.value;
            if (/[,，]/.test(next)) {
              const parts = next.split(/[,，]/);
              const remainder = parts.pop() || "";
              commit(parts.join(","));
              setDraft(remainder);
            } else {
              setDraft(next);
              if (error) setError("");
            }
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" || event.key === "," || event.key === "，") {
              event.preventDefault();
              commit(draft);
            } else if (event.key === "Backspace" && !draft && tags.length) {
              event.preventDefault();
              onChange(tags.slice(0, -1).join(", "));
            }
          }}
        />
      </div>
      <small id={`${inputId}-hint`}>{copy.scenarioTagsHint}</small>
      {error ? <small id={`${inputId}-error`} role="alert">{error}</small> : null}
    </div>
  );
}

function Stepper({ label, value, limits, unit, onChange, testId }) {
  const minimum = Number(limits?.minimum) || 1;
  const maximum = Number(limits?.maximum) || minimum;
  const step = Number(limits?.step) || 1;
  const resolved = Number.isFinite(value) ? value : Number(limits?.default) || minimum;
  const update = (delta) => onChange(Math.max(minimum, Math.min(maximum, resolved + delta * step)));
  return (
    <div className="skillBudgetStepper" data-testid={testId}>
      <span>{label}</span>
      <div>
        <button type="button" onClick={() => update(-1)} disabled={resolved <= minimum} aria-label={`${label} -`}>−</button>
        <output aria-live="polite">{resolved} {unit}</output>
        <button type="button" onClick={() => update(1)} disabled={resolved >= maximum} aria-label={`${label} +`}>＋</button>
      </div>
      <small>{minimum}–{maximum} {unit}</small>
    </div>
  );
}

function InterfaceRows({
  kind,
  items,
  setItems,
  copy,
  locale,
  showIssues,
}) {
  const typeOptions = kind === "parameter" ? PARAMETER_TYPES : kind === "output" ? OUTPUT_TYPES : [];
  const issues = rowIssues(items, copy, kind);
  return (
    <div className={`skillInterfaceEditor skillInterface-${kind}`}>
      {items.length ? items.map((item) => (
        <div
          className={`skillInterfaceRow ${kind === "material" ? "skillMaterialRequirementRow" : ""}`}
          key={item.rowId}
        >
          <label>
            <span>{kind === "material" ? copy.materialName : copy.identifier} *</span>
            <input
              value={item.name}
              aria-invalid={showIssues && Boolean(issues[item.rowId]?.name)}
              aria-describedby={showIssues && issues[item.rowId]?.name ? `${item.rowId}-name-error` : undefined}
              data-field-error={showIssues && issues[item.rowId]?.name ? "true" : undefined}
              onChange={(event) => setItems((current) => current.map((entry) => entry.rowId === item.rowId ? { ...entry, name: event.target.value } : entry))}
            />
            {showIssues && issues[item.rowId]?.name ? <small id={`${item.rowId}-name-error`} role="alert">{issues[item.rowId].name}</small> : null}
          </label>
          <label className="skillInterfaceDescription">
            <span>{kind === "material" ? copy.materialPurpose : copy.description} *</span>
            <input
              value={item.description}
              aria-invalid={showIssues && Boolean(issues[item.rowId]?.description)}
              aria-describedby={showIssues && issues[item.rowId]?.description ? `${item.rowId}-description-error` : undefined}
              data-field-error={showIssues && issues[item.rowId]?.description ? "true" : undefined}
              onChange={(event) => setItems((current) => current.map((entry) => entry.rowId === item.rowId ? { ...entry, description: event.target.value } : entry))}
            />
            {showIssues && issues[item.rowId]?.description ? <small id={`${item.rowId}-description-error`} role="alert">{issues[item.rowId].description}</small> : null}
          </label>
          {kind === "material" ? (
            <fieldset
              className="skillMaterialFormatPicker"
              aria-describedby={showIssues && issues[item.rowId]?.acceptedMediaTypes ? `${item.rowId}-formats-error` : `${item.rowId}-formats-hint`}
            >
              <legend>{copy.acceptedFormats} *</legend>
              <MaterialFormatSelect
                item={item}
                setItems={setItems}
                copy={copy}
                locale={locale}
                invalid={showIssues && Boolean(issues[item.rowId]?.acceptedMediaTypes)}
                describedBy={showIssues && issues[item.rowId]?.acceptedMediaTypes
                  ? `${item.rowId}-formats-error`
                  : `${item.rowId}-formats-hint`}
              />
              {showIssues && issues[item.rowId]?.acceptedMediaTypes
                ? <small id={`${item.rowId}-formats-error`} role="alert">{issues[item.rowId].acceptedMediaTypes}</small>
                : <small id={`${item.rowId}-formats-hint`}>{copy.acceptedFormatsHint}</small>}
            </fieldset>
          ) : typeOptions.length ? (
            <ChoiceChips
              label="type"
              value={item.type}
              options={typeOptions}
              onChange={(type) => setItems((current) => current.map((entry) => entry.rowId === item.rowId ? { ...entry, type } : entry))}
            />
          ) : null}
          {kind !== "output" ? (
            <button
              type="button"
              className={`skillRequiredToggle ${item.required ? "active" : ""}`}
              aria-pressed={item.required}
              onClick={() => setItems((current) => current.map((entry) => entry.rowId === item.rowId ? { ...entry, required: !entry.required } : entry))}
            >
              {item.required ? copy.required : copy.optional}
            </button>
          ) : null}
          <button
            type="button"
            className="skillRemoveRow"
            aria-label={copy.remove}
            onClick={() => setItems((current) => current.filter((entry) => entry.rowId !== item.rowId))}
          >
            <Trash2 size={15} />
          </button>
        </div>
      )) : <p className="skillInterfaceEmpty">{copy.noRequirements}</p>}
    </div>
  );
}

function runtimeTestId(runtimeId) {
  return runtimeId === "python3.12"
    ? "loopops.create-skill.runtime.python"
    : runtimeId === "nodejs20-typescript"
      ? "loopops.create-skill.runtime.node-typescript"
      : undefined;
}

function scaffoldRequest(form, definitionType) {
  return {
    definitionType,
    name: form.name.trim(),
    description: form.description.trim(),
    category: form.category.trim(),
    tags: parseScenarioTags(form.tags),
    materials: form.materials.map((item) => ({
      name: item.name.trim(),
      identifier: item.identifier,
      description: item.description.trim(),
      required: item.required !== false,
      acceptedMediaTypes: normalizeMaterialMediaTypes(item.acceptedMediaTypes),
    })),
    parameters: form.parameters.map((item) => ({
      name: item.name.trim(),
      description: item.description.trim(),
      required: item.required === true,
      type: item.type,
    })),
    outputs: form.outputs.map((item) => ({
      name: item.name.trim(),
      description: item.description.trim(),
      type: item.type,
    })),
    smoke: {
      purpose: form.smokePurpose.trim(),
      input: form.smokeInput.trim(),
      expectedOutcome: form.expectedOutcome.trim(),
    },
    ...(definitionType === "script" ? {
      runtime: {
        runtimeId: form.runtimeId,
        timeoutSeconds: form.timeoutSeconds,
        memoryMiB: form.memoryMiB,
      },
    } : {}),
  };
}

export function CreateSkillDialog({
  workspace,
  embedded = false,
  navigationKey = "",
}) {
  const t = workspace.t;
  const copy = localCopy(workspace.locale);
  const responsive = useResponsiveCapability();
  const attachmentMutations = useAttachmentMutations();
  const mounted = useRef(true);
  const materialUploadTokens = useRef(new Map());
  const initialCreationState = useRef(null);
  const initialRuntimeRecoveryId = requestedRuntimeRecovery(embedded);
  if (!initialCreationState.current) {
    const initial = {
      form: initialForm(workspace.locale),
      definitionType: "prompt",
      currentStep: 1,
    };
    initialCreationState.current = initialRuntimeRecoveryId
      ? {
          ...initial,
          form: { ...initial.form, runtimeId: initialRuntimeRecoveryId },
          definitionType: "script",
          currentStep: 3,
        }
      : initial;
  }
  const [form, setForm] = useState(() => initialCreationState.current.form);
  const [files, setFiles] = useState([]);
  const [zipFile, setZipFile] = useState(null);
  const [mode, setMode] = useState(() => requestedMode(workspace, embedded));
  const [definitionType, setDefinitionType] = useState(initialCreationState.current.definitionType);
  const [definitionStep, setDefinitionStep] = useState(initialCreationState.current.currentStep);
  const [repository, setRepository] = useState(initialRepository);
  const [serverRoot, setServerRoot] = useState("");
  const [serverCandidates, setServerCandidates] = useState([]);
  const [serverSelection, setServerSelection] = useState([]);
  const [serverScanning, setServerScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [decisionAcknowledged, setDecisionAcknowledged] = useState(false);
  const [transfer, setTransfer] = useState(null);
  const [retryKey, setRetryKey] = useState(null);
  const [toolRetryPackage, setToolRetryPackage] = useState(null);
  const [packageError, setPackageError] = useState("");
  const [scaffoldedPackage, setScaffoldedPackage] = useState(null);
  const [scaffolding, setScaffolding] = useState(false);
  const [previewPath, setPreviewPath] = useState("SKILL.md");
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [materialSamples, setMaterialSamples] = useState({});
  const [mobileLinkCopied, setMobileLinkCopied] = useState(false);
  const [mobileLinkError, setMobileLinkError] = useState("");
  const [runtimeRecoveryId, setRuntimeRecoveryId] = useState(initialRuntimeRecoveryId);
  const runtimes = Array.isArray(workspace.skillRuntimes) ? workspace.skillRuntimes : [];
  const registeredTools = Array.isArray(workspace.registeredToolPackages)
    ? workspace.registeredToolPackages
    : [];
  const runtimeLoading = Boolean(workspace.skillRuntimesState?.loading);
  const runtimeError = workspace.skillRuntimesState?.error || null;
  const selectedRuntime = runtimes.find((runtime) => runtime.runtimeId === form.runtimeId) || null;
  const inspected = workspace.pendingSkillPackage;
  const needsDecision = inspected?.upload?.state === "needs_decision";
  const fileLabel = useMemo(() => files.map((file) => file.name).join(", "), [files]);
  const readiness = workspace.creationReadiness?.actions || {};
  const selectedActionReadiness = definitionType === "script"
    ? readiness.scriptSkill
    : readiness.promptSkill;
  const materialSamplesReady = form.materials.every((material) => (
    material.required === false || materialSamples[material.rowId]?.source
  ));
  const importGate = {
    tool: readiness.registeredToolSkill?.importable,
    files: readiness.skillDirectoryImport?.importable,
    zip: readiness.skillZipImport?.importable,
    repository: readiness.publicGithubSkillImport?.importable,
    server: readiness.serverSkillImport?.importable,
  }[mode];
  const importReady = mode === "create" || importGate?.status === "ready";
  const parsedRepository = mode === "repository" ? repositoryPreview(repository) : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const activeMaterials = new Map(form.materials.map((material) => [material.rowId, material]));
    setMaterialSamples((current) => {
      const stale = Object.entries(current).filter(([rowId, sample]) => (
        sample && !activeMaterials.has(rowId)
      ));
      const mismatched = Object.entries(current).filter(([rowId, sample]) => {
        const material = activeMaterials.get(rowId);
        const mediaType = sample?.mediaType
          || sample?.source?.attachment?.mediaType
          || "";
        return Boolean(
          material
          && sample?.source
          && mediaType
          && !acceptsMaterialMediaType(material.acceptedMediaTypes, mediaType),
        );
      });
      if (!stale.length && !mismatched.length) return current;
      for (const [rowId, sample] of stale) {
        materialUploadTokens.current.delete(rowId);
        discardMaterialSample(sample);
      }
      for (const [rowId, sample] of mismatched) {
        materialUploadTokens.current.delete(rowId);
        discardMaterialSample(sample);
      }
      const mismatchedIds = new Set(mismatched.map(([rowId]) => rowId));
      return Object.fromEntries(Object.entries(current)
        .filter(([rowId]) => activeMaterials.has(rowId))
        .map(([rowId, sample]) => [
          rowId,
          mismatchedIds.has(rowId)
            ? {
                label: sample.label,
                status: "failed",
                mediaType: sample.mediaType,
                source: null,
                error: copy.materialFormatMismatch,
              }
            : sample,
        ]));
    });
  }, [form.materials]);

  useEffect(() => {
    if (embedded || workspace.createSkillDialogOpen) {
      setMode(requestedMode(workspace, embedded));
    }
  }, [embedded, workspace.createSkillDialogMode, workspace.createSkillDialogOpen, navigationKey]);

  useEffect(() => {
    const requestedRuntimeId = requestedRuntimeRecovery(embedded);
    setRuntimeRecoveryId(requestedRuntimeId);
    if (!requestedRuntimeId) return;
    setMode("create");
    setDefinitionType("script");
    setDefinitionStep(3);
    setForm((current) => current.runtimeId === requestedRuntimeId
      ? current
      : { ...current, runtimeId: requestedRuntimeId });
  }, [embedded, navigationKey]);

  useEffect(() => {
    if (definitionType !== "script" || form.runtimeId || !runtimes.length) return;
    const firstReady = runtimes.find((runtime) => runtime.availability === "ready") || runtimes[0];
    if (!firstReady) return;
    setForm((current) => ({
      ...current,
      runtimeId: firstReady.runtimeId,
      timeoutSeconds: firstReady.timeoutSeconds.default,
      memoryMiB: firstReady.memoryMiB.default,
    }));
  }, [definitionType, form.runtimeId, runtimes]);

  const scaffoldData = useMemo(
    () => scaffoldRequest(form, definitionType),
    [definitionType, form],
  );
  const scaffoldKey = useMemo(() => JSON.stringify(scaffoldData), [scaffoldData]);
  const definitionPackage = mode === "create" && scaffoldedPackage?.key === scaffoldKey
    ? scaffoldedPackage.files
    : [];

  const contractReady = Boolean(
    form.name.trim()
    && form.description.trim()
    && form.outputs.length
    && rowsValid(form.materials, copy, "material")
    && rowsValid(form.parameters, copy, "parameter")
    && rowsValid(form.outputs, copy, "output"),
  );
  const runtimeDraftReady = definitionType === "prompt" || Boolean(selectedRuntime);
  const runtimeExecutionReady = definitionType === "prompt"
    ? selectedActionReadiness?.testable?.status === "ready"
    : Boolean(selectedRuntime?.availability === "ready");
  const readyToInspect = mode === "server"
    ? Boolean(importReady && serverRoot.trim() && serverSelection.length)
    : mode === "create"
      ? Boolean(contractReady && runtimeDraftReady && form.category && definitionPackage.length && form.smokePurpose.trim() && form.smokeInput.trim() && materialSamplesReady)
      : Boolean(importReady && (mode === "files"
        ? files.length
        : mode === "zip"
          ? zipFile
          : mode === "repository"
            ? parsedRepository
            : false));
  const definitionStepReady = [
    true,
    contractReady,
    runtimeDraftReady,
    Boolean(form.category),
    Boolean(definitionPackage.length),
    Boolean(form.smokePurpose.trim() && form.smokeInput.trim() && materialSamplesReady),
    readyToInspect,
  ][definitionStep - 1];

  function setRows(key) {
    return (updater) => setForm((current) => ({
      ...current,
      [key]: typeof updater === "function" ? updater(current[key]) : updater,
    }));
  }

  function resetLocalState({ preserveMaterialSamples = false } = {}) {
    if (!preserveMaterialSamples) {
      for (const sample of Object.values(materialSamples)) {
        if (sample?.attachmentId) {
          void attachmentMutations.deleteAttachment.mutateAsync({
            attachmentId: sample.attachmentId,
            idempotencyKey: `discard-wizard-material-${sample.attachmentId}`,
          }).catch(() => {});
        }
      }
    }
    setForm(initialForm(workspace.locale));
    setFiles([]);
    setZipFile(null);
    setMode(requestedMode(workspace, embedded));
    setDefinitionType("prompt");
    setDefinitionStep(1);
    setRepository(initialRepository);
    setServerRoot("");
    setServerCandidates([]);
    setServerSelection([]);
    setTransfer(null);
    setRetryKey(null);
    setToolRetryPackage(null);
    setPackageError("");
    setScaffoldedPackage(null);
    setScaffolding(false);
    setDecisionAcknowledged(false);
    setPreviewPath("SKILL.md");
    setValidationAttempted(false);
    setMaterialSamples({});
    setMobileLinkCopied(false);
    setMobileLinkError("");
  }

  function closeFlow() {
    resetLocalState();
    if (embedded) workspace.navigateToPath("/skills", { replace: true });
    else workspace.closeCreateSkillDialog();
  }

  function goBack() {
    if (mode === "create" && definitionStep > 1) {
      setDefinitionStep((current) => current - 1);
      setValidationAttempted(false);
      return;
    }
    if (mode !== "create") {
      setMode("create");
      setDefinitionStep(1);
      return;
    }
    closeFlow();
  }

  async function advanceDefinitionStep() {
    if (scaffolding) return;
    if (!definitionStepReady) {
      setValidationAttempted(true);
      globalThis.requestAnimationFrame?.(() => {
        document.querySelector('[data-field-error="true"]')?.focus();
      });
      return;
    }
    setValidationAttempted(false);
    if (definitionStep >= 4 && !definitionPackage.length) {
      setScaffolding(true);
      setPackageError("");
      try {
        const result = await workspace.scaffoldSkillDraftPackage(scaffoldData);
        setScaffoldedPackage({ key: scaffoldKey, ...result.data });
        setPreviewPath(result.data.files[0]?.path || "SKILL.md");
      } catch {
        setPackageError(copy.scaffoldError);
        return;
      } finally {
        setScaffolding(false);
      }
    }
    setDefinitionStep((current) => Math.min(DEFINITION_STEPS.length, current + 1));
  }

  function discardMaterialSample(sample) {
    if (!sample?.attachmentId) return;
    void attachmentMutations.deleteAttachment.mutateAsync({
      attachmentId: sample.attachmentId,
      idempotencyKey: `discard-wizard-material-${sample.attachmentId}`,
    }).catch(() => {});
  }

  function chooseMaterialResource(material, resourceId) {
    materialUploadTokens.current.delete(material.rowId);
    discardMaterialSample(materialSamples[material.rowId]);
    const resource = workspace.resources.find((item) => (
      item.resourceId === resourceId
      && item.readiness?.status === "ready"
      && item.version
      && item.contentHash
    ));
    if (resource && !acceptsMaterialMediaType(material.acceptedMediaTypes, resource.mediaType)) {
      setMaterialSamples((current) => ({
        ...current,
        [material.rowId]: {
          label: resource.label,
          status: "failed",
          mediaType: resource.mediaType,
          source: null,
          error: copy.materialResourceFormatMismatch,
        },
      }));
      return;
    }
    setMaterialSamples((current) => ({
      ...current,
      [material.rowId]: resource ? {
        label: resource.label,
        status: "ready",
        mediaType: resource.mediaType,
        source: {
          kind: "workspace_resource",
          resource: {
            resourceId: resource.resourceId,
            version: resource.version,
            label: resource.label,
            contentHash: resource.contentHash,
          },
        },
      } : null,
    }));
  }

  async function uploadMaterialSample(material, file) {
    if (!file) return;
    const mediaType = materialMediaTypeForFile(file);
    if (!mediaType || !acceptsMaterialMediaType(material.acceptedMediaTypes, mediaType)) {
      setMaterialSamples((current) => ({
        ...current,
        [material.rowId]: {
          label: file.name,
          status: "failed",
          mediaType,
          source: null,
          error: copy.materialFormatMismatch,
        },
      }));
      return;
    }
    const uploadToken = Symbol(material.rowId);
    materialUploadTokens.current.set(material.rowId, uploadToken);
    discardMaterialSample(materialSamples[material.rowId]);
    setMaterialSamples((current) => ({
      ...current,
      [material.rowId]: {
        label: file.name,
        status: "processing",
        mediaType,
        source: null,
      },
    }));
    try {
      const result = await attachmentMutations.createAttachment.mutateAsync({
        file,
        idempotencyKey: `wizard-material-${material.rowId}-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
      });
      const attachment = result.data.attachment;
      if (
        !mounted.current
        || materialUploadTokens.current.get(material.rowId) !== uploadToken
        || !form.materials.some((item) => item.rowId === material.rowId)
      ) {
        discardMaterialSample({ attachmentId: attachment.attachmentId });
        return;
      }
      if (attachment.processing.status !== "ready") {
        discardMaterialSample({ attachmentId: attachment.attachmentId });
        throw new Error(attachment.processing.message || "attachment_processing_failed");
      }
      setMaterialSamples((current) => ({
        ...current,
        [material.rowId]: {
          label: attachment.fileName,
          status: "ready",
          mediaType: attachment.mediaType,
          attachmentId: attachment.attachmentId,
          source: {
            kind: "attachment",
            attachment: {
              attachmentId: attachment.attachmentId,
              version: attachment.version,
              contentHash: attachment.contentHash,
              mediaType: attachment.mediaType,
            },
          },
        },
      }));
    } catch (error) {
      if (!mounted.current || materialUploadTokens.current.get(material.rowId) !== uploadToken) return;
      setMaterialSamples((current) => ({
        ...current,
        [material.rowId]: {
          label: file.name,
          status: "failed",
          mediaType,
          source: null,
          error: error?.message || "attachment_processing_failed",
        },
      }));
    }
  }

  function removeMaterialSample(material) {
    materialUploadTokens.current.delete(material.rowId);
    discardMaterialSample(materialSamples[material.rowId]);
    setMaterialSamples((current) => ({ ...current, [material.rowId]: null }));
  }

  function smokeTestHandoff() {
    return {
      purpose: form.smokePurpose.trim(),
      input: form.smokeInput.trim(),
      expectedOutcome: form.expectedOutcome.trim(),
      materialBindings: form.materials.flatMap((material) => (
        materialSamples[material.rowId]?.source
          ? [{
              materialKey: material.identifier,
              source: materialSamples[material.rowId].source,
            }]
          : []
      )),
    };
  }

  async function preparePackage(event) {
    event?.preventDefault();
    if (!readyToInspect || submitting || inspected) return;
    setSubmitting(true);
    setTransfer({ phase: mode === "repository" ? "importing" : "preparing", percent: 0, receivedBytes: 0, totalBytes: 0, error: false });
    try {
      if (mode === "server") {
        const imported = await workspace.importServerSkills(serverRoot.trim(), serverSelection, retryKey);
        if (!imported?.failed) closeFlow();
        return;
      }
      const metadata = {
        name: form.name.trim(),
        description: form.description.trim(),
        category: form.category.trim(),
      };
      const onProgress = (progress) => setTransfer(uploadProgress(progress, mode === "repository" ? "importing" : "uploading"));
      let result;
      if (mode !== "repository") {
        const zipPackage = mode === "zip" ? await unpackZipSkillPackage(zipFile) : null;
        const createdPackage = mode === "create" ? definitionPackage : null;
        const packageFiles = createdPackage || zipPackage?.files || await Promise.all(browserPackageFiles(files).map(async ({ file, path }) => ({
          path,
          contentBase64: await encodeFile(file),
        })));
        result = await workspace.inspectSkillPackage({
          ...metadata,
          filename: mode === "create"
            ? scaffoldedPackage.filename
            : zipPackage?.filename || (files.length === 1 ? files[0].name : "skill-package"),
          sizeBytes: mode === "create"
            ? scaffoldedPackage.sizeBytes
            : zipPackage?.sizeBytes || files.reduce((total, file) => total + file.size, 0),
          files: packageFiles,
        }, retryKey, onProgress);
      } else {
        result = await workspace.importSkillRepository({
          ...metadata,
          repositoryUrl: repository.repositoryUrl.trim(),
          ref: repository.ref.trim() || "main",
          skillDirectory: repository.skillDirectory.trim(),
        }, retryKey, onProgress);
      }
      if (result?.failed) {
        setRetryKey(result.idempotencyKey);
        setTransfer((current) => ({ ...(current || {}), phase: "paused", error: true }));
      } else if (result) {
        setRetryKey(null);
        setTransfer((current) => ({ ...(current || {}), phase: "complete", percent: 100, error: false }));
      }
    } catch {
      if (mode === "zip") setPackageError(t("skillCreate.zipInvalid"));
      setTransfer((current) => ({ ...(current || {}), phase: "paused", error: true }));
    } finally {
      setSubmitting(false);
    }
  }

  async function connectRegisteredTool(toolPackage) {
    if (
      submitting
      || inspected
      || !importReady
      || toolPackage?.registrationStatus !== "registered"
    ) return;
    setSubmitting(true);
    setPackageError("");
    setToolRetryPackage(toolPackage);
    setTransfer({ phase: "preparing", percent: 0, receivedBytes: 0, totalBytes: 0, error: false });
    try {
      const packageFiles = registeredToolSkillPackage(toolPackage);
      const result = await workspace.inspectSkillPackage({
        name: toolPackage.label,
        description: toolPackage.description,
        category: "automation",
        filename: `${toolPackage.skillName}-registered-tool`,
        sizeBytes: packageSize(packageFiles),
        files: packageFiles,
      }, retryKey, (progress) => setTransfer(uploadProgress(progress, "uploading")));
      if (result?.failed) {
        setRetryKey(result.idempotencyKey);
        setTransfer((current) => ({ ...(current || {}), phase: "paused", error: true }));
      } else if (result) {
        setRetryKey(null);
        setToolRetryPackage(null);
        setTransfer((current) => ({ ...(current || {}), phase: "complete", percent: 100, error: false }));
      }
    } catch {
      setPackageError(copy.toolCatalogError);
      setTransfer((current) => ({ ...(current || {}), phase: "paused", error: true }));
    } finally {
      setSubmitting(false);
    }
  }

  const footer = inspected ? (
    <>
      <Button variant="secondary" onClick={closeFlow} data-testid="loopops.create-skill.cancel">{copy.cancel}</Button>
      <span className="skillPrivatePromise"><ShieldCheck size={16} /><span><strong>{copy.privateTitle}</strong><small>{copy.privateBody}</small></span></span>
      <Button
        variant="primary"
        onClick={async () => {
          if (needsDecision && !decisionAcknowledged) return;
          setSubmitting(true);
          try {
            // The wizard records test intent in SKILL.md. Test/Validate/Publish remain separate.
            const result = await workspace.createSkillDraftFromPackage({
              permissionAcknowledged: needsDecision && decisionAcknowledged,
              smokeTest: smokeTestHandoff(),
            });
            if (result) {
              resetLocalState({ preserveMaterialSamples: true });
            }
          } finally {
            setSubmitting(false);
          }
        }}
        disabled={submitting || (needsDecision && !decisionAcknowledged)}
        data-testid="loopops.create-skill.create-draft"
      >
        {submitting ? t("skillCreate.creatingDraft") : copy.saveDraft}
      </Button>
    </>
  ) : mode === "create" ? (
    <>
      <Button
        variant="plain"
        icon={definitionStep > 1 ? <ArrowLeft size={15} /> : undefined}
        onClick={() => definitionStep > 1 ? setDefinitionStep((current) => current - 1) : closeFlow()}
        data-testid={definitionStep > 1 ? "loopops.create-skill.wizard.back" : "loopops.create-skill.cancel"}
      >
        {definitionStep > 1 ? copy.previous : copy.cancel}
      </Button>
      <span className="skillWizardFooterProgress">{copy.stepCount(definitionStep)}</span>
      {definitionStep < DEFINITION_STEPS.length ? (
        <Button
          variant="primary"
          icon={<ArrowRight size={15} />}
          disabled={scaffolding}
          onClick={advanceDefinitionStep}
          data-testid="loopops.create-skill.wizard.next"
        >
          {scaffolding ? copy.scaffolding : copy.continue}
        </Button>
      ) : (
        <Button variant="primary" type="submit" form="create-skill-form" disabled={!readyToInspect || submitting} data-testid="loopops.create-skill.submit">
          {submitting ? t("skillCreate.preparing") : copy.saveDraft}
        </Button>
      )}
    </>
  ) : mode === "tool" ? (
    <Button variant="secondary" onClick={closeFlow}>{copy.cancel}</Button>
  ) : (
    <>
      <Button variant="secondary" onClick={closeFlow}>{copy.cancel}</Button>
      <Button variant="primary" type="submit" form="create-skill-form" disabled={!readyToInspect || submitting} data-testid="loopops.create-skill.submit">
        {submitting ? t("skillCreate.preparing") : t("skillCreate.confirm")}
      </Button>
    </>
  );

  const formContent = (
    <form id="create-skill-form" className="skillCreationPage" onSubmit={preparePackage} data-testid="loopops.create-skill.page">
      <header className="skillCreationHeader">
        <button type="button" onClick={goBack} aria-label={definitionStep > 1 || mode !== "create" ? copy.previous : copy.cancel}><ArrowLeft size={18} /></button>
        <div><span>Skills</span><h1>{t("skillCreate.title")}</h1></div>
      </header>

      {!inspected ? (
        <div className="skillEntryChoices" role="group" aria-label={t("skillCreate.entryMode")}>
          <button
            type="button"
            className={mode === "create" ? "active" : ""}
            onClick={() => { setMode("create"); setDefinitionStep(1); }}
            data-testid="loopops.create-skill.entry-define"
          >
            <FileCode2 size={20} /><span><strong>{copy.define}</strong><small>{copy.defineHint}</small></span>
          </button>
          {responsive.skillPackageImport ? (
            <button
              type="button"
              className={mode !== "create" ? "active" : ""}
              onClick={() => setMode("files")}
              data-testid="loopops.create-skill.entry-import"
            >
              <FileUp size={20} /><span><strong>{copy.import}</strong><small>{copy.importHint}</small></span>
            </button>
          ) : null}
        </div>
      ) : null}

      {inspected ? (
        <section className="packageReview skillCreationInspection" data-testid="loopops.create-skill.package-review">
          <div className="packageReviewSummary">
            <strong>{t(needsDecision ? "skillCreate.packageNeedsDecision" : "skillCreate.packageReady")}</strong>
            <span>{t("skillCreate.fileCount", { count: inspected.upload.inspection?.inventory?.length || files.length })}</span>
          </div>
          {inspected.upload.findings?.length ? (
            <ul className="issueList">
              {inspected.upload.findings.map((finding, index) => (
                <li key={`${finding.code || "finding"}-${index}`}>{finding.message || finding.code}</li>
              ))}
            </ul>
          ) : <p className="muted">{t("skillCreate.noBlockingFindings")}</p>}
          {needsDecision ? (
            <div data-testid="loopops.create-skill.executable-confirmation">
              <p>{t("skillCreate.executableIsolationSummary")}</p>
              <label className="permissionAcknowledgement">
                <input
                  type="checkbox"
                  checked={decisionAcknowledged}
                  onChange={(event) => setDecisionAcknowledged(event.target.checked)}
                  data-testid="loopops.create-skill.executable-acknowledgement"
                />
                <span><strong>{t("skillCreate.executableAcknowledgement")}</strong><small>{t("skillCreate.executableAcknowledgementDetail")}</small></span>
              </label>
            </div>
          ) : null}
          <div className="skillPrivateNotice"><ShieldCheck size={18} /><div><strong>{copy.privateTitle}</strong><p>{copy.privateBody}</p></div></div>
        </section>
      ) : mode === "create" ? (
        <div className="skillWizardLayout">
          <nav className="skillWizardSteps" aria-label={t("skillCreate.wizardProgress")} data-testid="loopops.create-skill.wizard.steps">
            <p>
              <span>{copy.stepCount(definitionStep)}</span>
              <strong className="skillWizardCurrentLabel">{t(`skillCreate.wizard.${DEFINITION_STEPS[definitionStep - 1]}`)}</strong>
            </p>
            <ol>
              {DEFINITION_STEPS.map((step, index) => {
                const number = index + 1;
                return (
                  <li className={definitionStep === number ? "active" : definitionStep > number ? "complete" : ""} key={step}>
                    <button type="button" disabled={number >= definitionStep} onClick={() => setDefinitionStep(number)}>
                      <span className="skillWizardStepMarker">{definitionStep > number ? <Check size={13} /> : number}</span>
                      <span className="skillWizardStepLabel">{t(`skillCreate.wizard.${step}`)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          <section className="skillWizardContent" data-testid="loopops.create-skill.definition-wizard" data-step={definitionStep}>
            {definitionStep === 1 ? (
              <>
                <div className="skillWizardHeading"><h2>{t("skillCreate.wizard.typeTitle")}</h2><p>{t("skillCreate.wizard.typeCaption")}</p></div>
                <div className="skillTypeGrid">
                  <button type="button" className={definitionType === "prompt" ? "active" : ""} onClick={() => setDefinitionType("prompt")} data-testid="loopops.create-skill.type-prompt">
                    <FileCode2 /><strong>{t("skillCreate.typePrompt")}</strong><small>{copy.promptRuntime}</small>
                  </button>
                  <button type="button" className={definitionType === "script" ? "active" : ""} onClick={() => setDefinitionType("script")} data-testid="loopops.create-skill.type-script">
                    <FileCode2 /><strong>Script</strong><small>Python 3.12 / Node.js 20 · TypeScript</small>
                  </button>
                  <button type="button" onClick={() => setMode("tool")} data-testid="loopops.create-skill.tool-import">
                    <Wrench /><strong>{copy.tool}</strong><small>{copy.toolHint}</small>
                  </button>
                  <button type="button" onClick={() => { if (!embedded) workspace.closeCreateSkillDialog(); workspace.openCreateLoop(); }} data-testid="loopops.create-skill.type-workflow-loop">
                    <Workflow /><strong>{copy.loop}</strong><small>{copy.loopHint}</small>
                  </button>
                </div>
              </>
            ) : null}

            {definitionStep === 2 ? (
              <>
                <div className="skillWizardHeading"><h2>{t("skillCreate.wizard.contractTitle")}</h2><p>{t("skillCreate.wizard.contractCaption")}</p></div>
                <div className="skillFieldGrid">
                  <label><span>{t("skillCreate.name")} *</span><input value={form.name} aria-invalid={validationAttempted && !form.name.trim()} data-field-error={validationAttempted && !form.name.trim() ? "true" : undefined} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} data-testid="loopops.create-skill.name" autoFocus />{validationAttempted && !form.name.trim() ? <small role="alert">{copy.fieldRequired}</small> : null}</label>
                  <label className="wide"><span>{copy.responsibilities} *</span><textarea rows={3} value={form.description} aria-invalid={validationAttempted && !form.description.trim()} data-field-error={validationAttempted && !form.description.trim() ? "true" : undefined} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} data-testid="loopops.create-skill.description" />{validationAttempted && !form.description.trim() ? <small role="alert">{copy.fieldRequired}</small> : null}</label>
                </div>
                <section className="skillContractGroup" data-testid="loopops.create-skill.wizard.materials">
                  <div><h3>{copy.materials}</h3><p>{copy.materialsHint} {copy.materialDeclarationHint}</p><Button type="button" variant="secondary" icon={<Plus size={14} />} onClick={() => setRows("materials")((current) => [...current, row("material")])}>{copy.addMaterial}</Button></div>
                  <InterfaceRows kind="material" items={form.materials} setItems={setRows("materials")} copy={copy} locale={workspace.locale} showIssues={validationAttempted} />
                </section>
                <section className="skillContractGroup" data-testid="loopops.create-skill.wizard.parameters">
                  <div><h3>{copy.parameters}</h3><p>{copy.parametersHint}</p><Button type="button" variant="secondary" icon={<Plus size={14} />} onClick={() => setRows("parameters")((current) => [...current, row("parameter")])}>{copy.addParameter}</Button></div>
                  <InterfaceRows kind="parameter" items={form.parameters} setItems={setRows("parameters")} copy={copy} locale={workspace.locale} showIssues={validationAttempted} />
                </section>
                <section className="skillContractGroup" data-testid="loopops.create-skill.wizard.outputs">
                  <div><h3>{copy.outputs}</h3><Button type="button" variant="secondary" icon={<Plus size={14} />} onClick={() => setRows("outputs")((current) => [...current, row("output")])}>{copy.addOutput}</Button></div>
                  <InterfaceRows kind="output" items={form.outputs} setItems={setRows("outputs")} copy={copy} locale={workspace.locale} showIssues={validationAttempted} />
                </section>
              </>
            ) : null}

            {definitionStep === 3 ? (
              <>
                <div className="skillWizardHeading"><h2>{t("skillCreate.wizard.runtimeTitle")}</h2><p>{t("skillCreate.wizard.runtimeCaption")}</p></div>
                {definitionType === "prompt" ? (
                  <div className="skillRuntimeDecision"><strong>{t("skillCreate.typePrompt")}</strong><p>{copy.promptRuntime}</p></div>
                ) : (
                  <>
                    <h3>{copy.chooseRuntime}</h3>
                    <div className="skillRuntimeCatalog" data-testid="loopops.create-skill.runtime-catalog">
                      {runtimeLoading ? <p>{copy.runtimeLoading}</p> : null}
                      {runtimeError ? (
                        <div className="skillRuntimeError" role="alert"><span>{copy.runtimeError}</span>{workspace.skillRuntimesState?.retry ? <Button variant="secondary" onClick={workspace.skillRuntimesState.retry}>{copy.retry}</Button> : null}</div>
                      ) : null}
                      {!runtimeLoading && !runtimeError && !runtimes.length ? <p className="skillRuntimeEmpty">{copy.noRuntime}</p> : null}
                      {!runtimeLoading && !runtimeError && runtimeRecoveryId && !selectedRuntime ? (
                        <p className="skillRuntimeError" role="alert" data-testid="loopops.create-skill.runtime-recovery-unavailable">
                          {workspace.locale === "zh"
                            ? `需要处理的运行环境 ${runtimeRecoveryId} 不在当前工作区目录中。请联系管理员；现有 Draft 不会被修改。`
                            : `Runtime ${runtimeRecoveryId} is not present in this workspace catalog. Contact an administrator; the current Draft is unchanged.`}
                        </p>
                      ) : null}
                      {runtimes.map((runtime) => {
                        const ready = runtime.availability === "ready";
                        return (
                          <button
                            type="button"
                            key={runtime.runtimeId}
                            className={form.runtimeId === runtime.runtimeId ? "active" : ""}
                            onClick={() => setForm((current) => ({
                              ...current,
                              runtimeId: runtime.runtimeId,
                              timeoutSeconds: runtime.timeoutSeconds.default,
                              memoryMiB: runtime.memoryMiB.default,
                            }))}
                            data-testid={runtimeTestId(runtime.runtimeId)}
                          >
                            <strong>{runtime.versionLabel || runtime.label}</strong>
                            <span>{copy.isolated} · {copy.noNetwork} · {copy.scratchOnly}</span>
                            {!ready ? <small role="status">{runtime.availabilityReason || copy.runtimeUnavailable} {workspace.locale === "zh" ? "仍可先保存 Draft。" : "You can still save a Draft."}</small> : <small>{runtime.entrypoint}</small>}
                          </button>
                        );
                      })}
                    </div>
                    {selectedRuntime ? (
                      <div className="skillBudgetGrid">
                        <Stepper label={copy.timeout} value={form.timeoutSeconds} limits={selectedRuntime.timeoutSeconds} unit={copy.seconds} onChange={(value) => setForm((current) => ({ ...current, timeoutSeconds: value }))} testId="loopops.create-skill.runtime.timeout" />
                        <Stepper label={copy.memory} value={form.memoryMiB} limits={selectedRuntime.memoryMiB} unit="MiB" onChange={(value) => setForm((current) => ({ ...current, memoryMiB: value }))} testId="loopops.create-skill.runtime.memory" />
                      </div>
                    ) : null}
                  </>
                )}
                <div className="skillRiskNotice"><ShieldCheck size={18} /><div><strong>{copy.riskTitle}</strong><p>{copy.riskBody}</p></div></div>
              </>
            ) : null}

            {definitionStep === 4 ? (
              <>
                <div className="skillWizardHeading"><h2>{t("skillCreate.wizard.organizeTitle")}</h2><p>{t("skillCreate.wizard.organizeCaption")}</p></div>
                <div className="skillCategoryChips" role="group" aria-label={t("skillCreate.category")}>
                  {SKILL_CATEGORIES.map((category) => (
                    <button type="button" className={form.category === category ? "active" : ""} aria-pressed={form.category === category} onClick={() => setForm((current) => ({ ...current, category }))} key={category}>
                      {t(`skillCreate.category.${category}`)}
                    </button>
                  ))}
                </div>
                <ScenarioTagInput
                  value={form.tags}
                  copy={copy}
                  onChange={(tags) => setForm((current) => ({ ...current, tags }))}
                />
              </>
            ) : null}

            {definitionStep === 5 ? (
              <>
                <div className="skillWizardHeading"><h2>{t("skillCreate.wizard.draftTitle")}</h2><p>{t("skillCreate.wizard.draftCaption")}</p></div>
                <div className="skillPackagePreview" data-testid="loopops.create-skill.package-preview">
                  <div><h3>{copy.files}</h3>{definitionPackage.map((file) => <button type="button" className={previewPath === file.path ? "active" : ""} onClick={() => setPreviewPath(file.path)} key={file.path}>{file.path}</button>)}</div>
                  <section><h3>{copy.preview}</h3><pre>{decodeFile(definitionPackage.find((file) => file.path === previewPath) || definitionPackage[0] || {})}</pre></section>
                </div>
              </>
            ) : null}

            {definitionStep === 6 ? (
              <>
                <div className="skillWizardHeading"><h2>{t("skillCreate.wizard.smokeTitle")}</h2><p>{t("skillCreate.wizard.smokeCaption")}</p></div>
                <label><span>{copy.smokePurpose} *</span><textarea rows={3} value={form.smokePurpose} aria-invalid={validationAttempted && !form.smokePurpose.trim()} data-field-error={validationAttempted && !form.smokePurpose.trim() ? "true" : undefined} placeholder={copy.smokePurposePlaceholder} onChange={(event) => setForm((current) => ({ ...current, smokePurpose: event.target.value }))} data-testid="loopops.create-skill.smoke-purpose" />{validationAttempted && !form.smokePurpose.trim() ? <small role="alert">{copy.fieldRequired}</small> : null}</label>
                <label><span>{copy.smokeInput} *</span><textarea rows={3} value={form.smokeInput} aria-invalid={validationAttempted && !form.smokeInput.trim()} data-field-error={validationAttempted && !form.smokeInput.trim() ? "true" : undefined} onChange={(event) => setForm((current) => ({ ...current, smokeInput: event.target.value }))} data-testid="loopops.create-skill.smoke-input" />{validationAttempted && !form.smokeInput.trim() ? <small role="alert">{copy.fieldRequired}</small> : null}</label>
                <label><span>{copy.expectedOptional}</span><textarea rows={3} value={form.expectedOutcome} onChange={(event) => setForm((current) => ({ ...current, expectedOutcome: event.target.value }))} data-testid="loopops.create-skill.smoke-outcome" /></label>
                <small className="skillCreateRuntimeNote">{copy.expectedHint}</small>
                {form.materials.length ? (
                  <fieldset className="skillMaterialBindings" data-testid="loopops.create-skill.smoke-materials">
                    <legend>{copy.prepareMaterials}</legend>
                    <p className="muted">{copy.prepareMaterialsHint}</p>
                    {form.materials.map((material) => {
                      const selected = materialSamples[material.rowId];
                      const selectedResourceId = selected?.source?.kind === "workspace_resource"
                        ? selected.source.resource.resourceId
                        : "";
                      return (
                        <div className="skillMaterialBinding" key={material.rowId}>
                          <label>
                            <span>{material.name || copy.materials}{material.required ? " *" : ` · ${copy.optional}`}</span>
                            <small>{copy.acceptedFormats}: {materialFormatSummary(material.acceptedMediaTypes, workspace.locale)}</small>
                            <select
                              value={selectedResourceId}
                              onChange={(event) => chooseMaterialResource(material, event.target.value)}
                            >
                              <option value="">{copy.chooseWorkspaceMaterial}</option>
                              {workspace.resources.filter((resource) => (
                                resource.readiness?.status === "ready"
                                && resource.version
                                && resource.contentHash
                                && acceptsMaterialMediaType(
                                  material.acceptedMediaTypes,
                                  resource.mediaType,
                                )
                              )).map((resource) => (
                                <option key={resource.resourceId} value={resource.resourceId}>{resource.label}</option>
                              ))}
                            </select>
                            <small>{copy.compatibleResourcesOnly}</small>
                          </label>
                          <label className="skillMaterialUpload">
                            <span>{copy.orUploadMaterial}</span>
                            <input
                              type="file"
                              accept={materialAcceptAttribute(material.acceptedMediaTypes)}
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                event.currentTarget.value = "";
                                void uploadMaterialSample(material, file);
                              }}
                            />
                          </label>
                          {selected ? (
                            <div className={`skillMaterialStatus skillMaterialStatus-${selected.status}`}>
                              <FileText size={14} />
                              <span>{selected.label}</span>
                              {selected.status === "processing" ? <small>{copy.materialProcessing}</small> : null}
                              {selected.error ? <small role="alert">{selected.error}</small> : null}
                              <button type="button" onClick={() => removeMaterialSample(material)}>{copy.removeMaterial}</button>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                    {validationAttempted && !materialSamplesReady ? <p className="skillStepValidation" role="alert">{copy.materialRequired}</p> : null}
                  </fieldset>
                ) : null}
              </>
            ) : null}

            {definitionStep === 7 ? (
              <>
                <div className="skillWizardHeading"><h2>{t("skillCreate.wizard.reviewTitle")}</h2><p>{t("skillCreate.wizard.reviewCaption")}</p></div>
                <div className="skillReviewSections" data-testid="loopops.create-skill.wizard-review">
                  <section><span>{copy.overview}</span><div><strong>{form.name}</strong><p>{form.description}</p><small>{t(`skillCreate.category.${form.category}`)} · {parseScenarioTags(form.tags).join("、") || "—"}</small></div><button type="button" onClick={() => setDefinitionStep(2)}>{copy.edit}</button></section>
                  <section>
                    <span>{copy.definition}</span>
                    <div>
                      <strong>{definitionType === "script" ? "Script" : t("skillCreate.typePrompt")}</strong>
                      <p>{definitionType === "script" ? `${selectedRuntime?.versionLabel || form.runtimeId} · ${copy.isolated}` : copy.promptRuntime}</p>
                      {definitionType === "script" ? (
                        <small data-testid="loopops.create-skill.review-budget">
                          {copy.timeout}: {form.timeoutSeconds} {copy.seconds} · {copy.memory}: {form.memoryMiB} MiB · {copy.noNetwork} · {copy.scratchOnly}
                        </small>
                      ) : null}
                    </div>
                    <button type="button" onClick={() => setDefinitionStep(definitionType === "script" ? 3 : 1)}>{copy.edit}</button>
                  </section>
                  <section>
                    <span>{copy.io}</span>
                    <div>
                      <p>{copy.materials}: {form.materials.map((item) => `${item.name}（${materialFormatSummary(item.acceptedMediaTypes, workspace.locale)}）`).join(", ") || "—"}</p>
                      <p>{copy.parameters}: {form.parameters.map((item) => item.name).join(", ") || "—"}</p>
                      <p>{copy.outputs}: {form.outputs.map((item) => item.name).join(", ")}</p>
                    </div>
                    <button type="button" onClick={() => setDefinitionStep(2)}>{copy.edit}</button>
                  </section>
                  <section><span>{copy.package}</span><div><p>{definitionPackage.map((file) => file.path).join(" · ")}</p></div><button type="button" onClick={() => setDefinitionStep(5)}>{copy.edit}</button></section>
                  <section><span>{copy.smoke}</span><div><strong>{form.smokePurpose}</strong><p>{form.smokeInput}</p><small>{form.expectedOutcome || copy.expectedOptional}</small></div><button type="button" onClick={() => setDefinitionStep(6)}>{copy.edit}</button></section>
                </div>
                <div className="skillReadinessSummary" data-testid="loopops.create-skill.readiness">
                  {[
                    [copy.readinessDraft, selectedActionReadiness?.draftable],
                    [copy.readinessTest, selectedActionReadiness?.testable],
                    [copy.readinessRun, selectedActionReadiness?.runnable],
                  ].map(([label, gate]) => (
                    <div key={label} className={`skillReadiness-${gate?.status || "checking"}`}>
                      <strong>{label}</strong>
                      <span>{gate?.status || "checking"}</span>
                      <small>{gate?.message || ""}</small>
                    </div>
                  ))}
                  {!runtimeExecutionReady && definitionType === "script" ? <p role="status">{selectedRuntime?.availabilityReason || copy.runtimeUnavailable}</p> : null}
                </div>
                <div className="skillPrivateNotice"><ShieldCheck size={18} /><div><strong>{copy.privateTitle}</strong><p>{copy.privateBody}</p></div></div>
              </>
            ) : null}
            {!definitionStepReady ? <p className="skillStepValidation" role="status">{copy.completeStep}</p> : null}
          </section>
        </div>
      ) : !responsive.skillPackageImport ? (
        <section className="skillImportFlow skillMobileImportBoundary" data-testid="loopops.create-skill.mobile-import-boundary">
          <FileUp size={28} />
          <h2>{copy.mobileImportTitle}</h2>
          <p>{copy.mobileImportBody}</p>
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              const link = `${globalThis.location?.origin || ""}/skills/new?mode=${encodeURIComponent(mode)}`;
              setMobileLinkError("");
              try {
                if (typeof globalThis.navigator?.clipboard?.writeText !== "function") {
                  throw new Error("clipboard_unavailable");
                }
                await globalThis.navigator.clipboard.writeText(link);
                setMobileLinkCopied(true);
              } catch {
                setMobileLinkCopied(false);
                setMobileLinkError(copy.desktopLinkCopyFailed);
              }
            }}
          >
            {mobileLinkCopied ? copy.desktopLinkCopied : copy.copyDesktopLink}
          </Button>
          {mobileLinkError ? <p role="alert">{mobileLinkError}</p> : null}
          <a
            href={`mailto:?subject=${encodeURIComponent("Skill import")}&body=${encodeURIComponent(`${globalThis.location?.origin || ""}/skills/new?mode=${mode}`)}`}
          >
            {copy.emailDesktopLink}
          </a>
          <Button type="button" variant="plain" onClick={() => { setMode("create"); setDefinitionStep(1); }}>{copy.define}</Button>
        </section>
      ) : (
        <section className="skillImportFlow">
          <SegmentedControl
            label={t("skillCreate.sourceMode")}
            value={mode}
            onChange={(value) => {
              setMode(value);
              setTransfer(null);
              setRetryKey(null);
              setToolRetryPackage(null);
              setPackageError("");
            }}
            layout="fill"
            options={[
              { value: "tool", label: copy.tool, testId: "loopops.create-skill.mode-tool" },
              { value: "files", label: t("skillCreate.modeDirectory"), testId: "loopops.create-skill.mode-files" },
              { value: "zip", label: t("skillCreate.modeZip"), testId: "loopops.create-skill.mode-zip" },
              { value: "repository", label: t("skillCreate.modeRepository"), testId: "loopops.create-skill.mode-github" },
              ...(workspace.authUser?.role === "admin" ? [{ value: "server", label: t("skillCreate.modeServer"), testId: "loopops.create-skill.mode-server" }] : []),
            ]}
          />
          {importGate && importGate.status !== "ready" ? (
            <div className="skillRuntimeError" role="status">
              <span>{importGate.message}</span>
              {importGate.recoveryRoute ? (
                <Button type="button" variant="secondary" onClick={() => workspace.navigateToPath(importGate.recoveryRoute)}>
                  {copy.retry}
                </Button>
              ) : null}
            </div>
          ) : null}
          {mode === "tool" ? (
            <div className="registeredToolCatalog" data-testid="loopops.create-skill.tool-catalog">
              <div className="skillWizardHeading">
                <h2>{copy.toolCatalogTitle}</h2>
                <p>{copy.toolCatalogBody}</p>
              </div>
              {workspace.registeredToolPackagesState?.loading ? <p>{copy.toolCatalogLoading}</p> : null}
              {workspace.registeredToolPackagesState?.error ? (
                <div className="skillRuntimeError" role="alert">
                  <span>{copy.toolCatalogError}</span>
                  {workspace.registeredToolPackagesState.retry ? (
                    <Button type="button" variant="secondary" onClick={workspace.registeredToolPackagesState.retry}>{copy.retry}</Button>
                  ) : null}
                </div>
              ) : null}
              {!workspace.registeredToolPackagesState?.loading
                && !workspace.registeredToolPackagesState?.error
                && !registeredTools.length
                ? <p className="skillRuntimeEmpty">{copy.toolCatalogEmpty}</p>
                : null}
              <div className="registeredToolList">
                {registeredTools.map((toolPackage) => (
                  <article key={toolPackage.toolPackageId} data-testid="loopops.create-skill.tool-package">
                    <div className="registeredToolSummary">
                      <span>{copy.toolRegistered}</span>
                      <h3>{toolPackage.label}</h3>
                      <p>{toolPackage.description}</p>
                    </div>
                    <div className="registeredToolActions">
                      <strong>{copy.exactActions}</strong>
                      <ul>
                        {toolPackage.actions.map((action) => (
                          <li key={action.actionId}>
                            <code data-action-id={action.actionId} data-testid="loopops.create-skill.tool-action-id">{action.actionId}</code>
                            <small>{action.effect === "write" ? copy.toolWrite : copy.toolRead}{action.confirmationRequired ? ` · ${copy.toolConfirmation}` : ""}</small>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <Button
                      type="button"
                      variant="primary"
                      disabled={!importReady || submitting || toolPackage.registrationStatus !== "registered"}
                      title={!importReady ? importGate?.message : undefined}
                      onClick={() => connectRegisteredTool(toolPackage)}
                      data-testid="loopops.create-skill.tool-connect"
                    >
                      {submitting && toolRetryPackage?.toolPackageId === toolPackage.toolPackageId
                        ? t("skillCreate.preparing")
                        : copy.connectTool}
                    </Button>
                  </article>
                ))}
              </div>
            </div>
          ) : mode === "files" ? (
            <label className="skillPackagePicker">
              <span>{t("skillCreate.files")}</span>
              <input type="file" multiple webkitdirectory="" directory="" className="visuallyHidden" onChange={(event) => { setFiles(Array.from(event.target.files || [])); setTransfer(null); setRetryKey(null); }} data-testid="loopops.create-skill.files" />
              <span className="skillPackagePickerAction"><FileUp size={17} /><span><strong>{t("skillCreate.chooseFiles")}</strong><small>{fileLabel ? t("skillCreate.selectedFiles", { count: files.length }) : t("skillCreate.noFiles")}</small></span></span>
              {fileLabel ? <small className="skillPackagePickerNames" title={fileLabel}>{fileLabel}</small> : <small>{t("skillCreate.filesHint")}</small>}
            </label>
          ) : mode === "zip" ? (
            <label className="skillPackagePicker" data-testid="loopops.create-skill.zip-picker">
              <span>{t("skillCreate.zip")}</span>
              <input type="file" accept=".zip,application/zip,application/x-zip-compressed" className="visuallyHidden" onChange={(event) => { setZipFile(event.target.files?.[0] || null); setPackageError(""); setTransfer(null); setRetryKey(null); }} data-testid="loopops.create-skill.zip" />
              <span className="skillPackagePickerAction"><FileUp size={17} /><span><strong>{t("skillCreate.chooseZip")}</strong><small>{zipFile ? zipFile.name : t("skillCreate.noZip")}</small></span></span>
              <small>{t("skillCreate.zipHint")}</small>
            </label>
          ) : mode === "repository" ? (
            <div className="repositoryImportFields" data-testid="loopops.create-skill.repository-fields">
              <label><span>{t("skillCreate.repositoryUrl")}</span><input type="url" value={repository.repositoryUrl} placeholder="https://github.com/owner/repository" onChange={(event) => setRepository((current) => ({ ...current, repositoryUrl: event.target.value }))} data-testid="loopops.create-skill.repository-url" /></label>
              <div className="repositoryImportOptional">
                <label><span>{t("skillCreate.repositoryRef")}</span><input value={repository.ref} onChange={(event) => setRepository((current) => ({ ...current, ref: event.target.value }))} data-testid="loopops.create-skill.repository-ref" /></label>
                <label><span>{t("skillCreate.repositoryDirectory")}</span><input value={repository.skillDirectory} placeholder={t("skillCreate.repositoryDirectoryPlaceholder")} onChange={(event) => setRepository((current) => ({ ...current, skillDirectory: event.target.value }))} data-testid="loopops.create-skill.repository-directory" /></label>
              </div>
              {repository.repositoryUrl.trim() ? (
                parsedRepository ? (
                  <dl className="repositoryImportSummary" data-testid="loopops.create-skill.repository-summary">
                    <div><dt>Owner</dt><dd>{parsedRepository.owner}</dd></div>
                    <div><dt>Repository</dt><dd>{parsedRepository.repo}</dd></div>
                    <div><dt>Ref</dt><dd>{parsedRepository.ref}</dd></div>
                    <div><dt>{workspace.locale === "zh" ? "目录" : "Subdirectory"}</dt><dd>{parsedRepository.subdirectory}</dd></div>
                  </dl>
                ) : (
                  <p className="skillStepValidation" role="alert">
                    {workspace.locale === "zh"
                      ? "请输入公开 GitHub 仓库的根地址，例如 https://github.com/owner/repository。"
                      : "Enter the root URL of a public GitHub repository, such as https://github.com/owner/repository."}
                  </p>
                )
              ) : null}
              <small>{t("skillCreate.repositoryHint")}</small>
            </div>
          ) : (
            <div className="repositoryImportFields serverSkillImport" data-testid="loopops.create-skill.server-fields">
              <label><span>{t("skillCreate.serverRoot")}</span><input value={serverRoot} placeholder="/absolute/allowlisted/skills" onChange={(event) => { setServerRoot(event.target.value); setServerCandidates([]); setServerSelection([]); }} data-testid="loopops.create-skill.server-root" /></label>
              <Button type="button" variant="secondary" disabled={!serverRoot.trim() || serverScanning} onClick={async () => {
                setServerScanning(true);
                try {
                  const result = await workspace.scanServerSkills(serverRoot.trim());
                  setServerCandidates(result?.candidates || []);
                  setServerSelection([]);
                } finally {
                  setServerScanning(false);
                }
              }} data-testid="loopops.create-skill.server-scan">{serverScanning ? t("skillCreate.serverScanning") : t("skillCreate.serverScan")}</Button>
              <small>{t("skillCreate.serverHint")}</small>
              {serverCandidates.length ? (
                <div className="serverSkillCandidates" data-testid="loopops.create-skill.server-candidates">
                  {serverCandidates.map((candidate) => {
                    const unavailable = candidate.status !== "ready" || candidate.alreadyExists;
                    return (
                      <label key={candidate.relativeDirectory}>
                        <input type="checkbox" disabled={unavailable} checked={serverSelection.includes(candidate.relativeDirectory)} onChange={(event) => setServerSelection((current) => event.target.checked ? [...current, candidate.relativeDirectory] : current.filter((entry) => entry !== candidate.relativeDirectory))} />
                        <span><strong>{candidate.name}</strong><small>{candidate.alreadyExists ? t("skillCreate.serverExists") : candidate.status === "ready" ? candidate.description : t("skillCreate.serverInvalid")}</small></span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </div>
          )}
        </section>
      )}

      {transfer && !inspected ? (
        <section className={`skillTransferStatus ${transfer.error ? "error" : ""}`} aria-live="polite" data-testid="loopops.create-skill.upload-status">
          <div><strong>{t(`skillCreate.transfer.${transfer.phase || "preparing"}`)}</strong><span>{Math.max(0, Math.min(100, Math.round(transfer.percent || 0)))}%</span></div>
          <progress max="100" value={Math.max(0, Math.min(100, transfer.percent || 0))} data-testid="loopops.create-skill.upload-progress" />
          {transfer.error ? (
            <Button
              type="button"
              variant="secondary"
              onClick={mode === "tool" && toolRetryPackage
                ? () => connectRegisteredTool(toolRetryPackage)
                : preparePackage}
              disabled={submitting}
              data-testid="loopops.create-skill.retry"
            >
              {t("skillCreate.retryTransfer")}
            </Button>
          ) : null}
        </section>
      ) : null}
      {packageError ? <p className="agentComposerError" role="alert">{packageError}</p> : null}
      {embedded ? <footer className="skillCreationFooter">{footer}</footer> : null}
    </form>
  );

  if (embedded) return formContent;
  return (
    <Dialog
      open={workspace.createSkillDialogOpen}
      title={t("skillCreate.title")}
      initialFocusSelector='[data-testid="loopops.create-skill.entry-define"]'
      returnFocusSelector='[data-testid="loopops.global-create"], [data-testid="loopops.topbar.primary.create-skill"], [data-testid="loopops.skills.create"]'
      onClose={closeFlow}
      actions={footer}
    >
      {formContent}
    </Dialog>
  );
}
