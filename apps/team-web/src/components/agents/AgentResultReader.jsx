import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  X,
} from "lucide-react";

import { workbenchApi } from "../../api/client.js";
import { ArtifactImage } from "../models/ArtifactImage.jsx";
import { AgentMarkdown } from "./AgentMarkdown.js";

function textResponse(record) {
  if (record?.result?.kind === "agent_message") return record.result.response || "";
  if (record?.result?.response) return record.result.response;
  return "";
}

function artifactReferences(record) {
  const candidates = [
    ...(record?.artifactRefs || []),
    ...(record?.result?.artifactRefs || []),
    ...(record?.result?.result?.artifactRefs || []),
  ];
  const byId = new Map();
  for (const artifact of candidates) {
    if (artifact?.artifactId) byId.set(artifact.artifactId, artifact);
  }
  return [...byId.values()];
}

export function resultOutputs(record, title, locale) {
  const zh = locale === "zh";
  const outputs = [];
  const response = textResponse(record);
  if (response) {
    outputs.push({
      id: `${record?.turnId || record?.runId || "result"}:response`,
      kind: "markdown",
      title: title || (zh ? "任务结果" : "Task result"),
      content: response,
    });
  }
  artifactReferences(record).forEach((artifact, index) => {
    outputs.push({
      id: artifact.artifactId,
      kind: "image",
      title: `${title || (zh ? "任务结果" : "Task result")} · ${index + 1}`,
      artifact,
    });
  });
  return outputs;
}

function durationLabel(record, locale) {
  if (!record?.startedAt || !record?.finishedAt) return locale === "zh" ? "未记录" : "Not recorded";
  const elapsed = Math.max(0, new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime());
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) return locale === "zh" ? `${seconds} 秒` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return locale === "zh" ? `${minutes} 分 ${remainder} 秒` : `${minutes}m ${remainder}s`;
}

function usageLabel(record, locale) {
  const usage = record?.result?.usage || record?.result?.result?.usage;
  const notRecorded = locale === "zh" ? "未记录" : "Not recorded";
  if (!usage) return notRecorded;

  const labels = [];
  if (Number.isInteger(usage.steps)) {
    labels.push(locale === "zh" ? `${usage.steps} 步` : `${usage.steps} steps`);
  }
  if (Number.isInteger(usage.modelRequests)) {
    labels.push(locale === "zh" ? `${usage.modelRequests} 次模型请求` : `${usage.modelRequests} model requests`);
  }
  if (Number.isInteger(usage.totalTokens) && usage.totalTokens > 0) {
    labels.push(locale === "zh" ? `${usage.totalTokens} tokens` : `${usage.totalTokens} tokens`);
  } else if (usage.modelRequests > 0) {
    labels.push(locale === "zh" ? "Token 用量未记录" : "Token usage not recorded");
  }
  if (Number.isInteger(usage.inputBytes)) {
    labels.push(locale === "zh" ? `输入 ${usage.inputBytes} B` : `${usage.inputBytes} B input`);
  }
  if (Number.isInteger(usage.outputBytes)) {
    labels.push(locale === "zh" ? `输出 ${usage.outputBytes} B` : `${usage.outputBytes} B output`);
  }
  if (Number.isInteger(usage.imageCount)) {
    labels.push(locale === "zh" ? `${usage.imageCount} 张图片` : `${usage.imageCount} images`);
  }
  if (Number.isInteger(usage.costUsdMicros) && usage.costUsdMicros > 0) {
    const dollars = usage.costUsdMicros / 1_000_000;
    labels.push(new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: dollars > 0 && dollars < 0.01 ? 6 : 2,
    }).format(dollars));
  } else if (usage.modelRequests > 0) {
    labels.push(locale === "zh" ? "费用未记录" : "Cost not recorded");
  }
  return labels.length ? labels.join(" · ") : notRecorded;
}

export function AgentResultReader({
  record,
  turn,
  session,
  locale,
  modelLabel,
  initialIndex = 0,
  onClose,
}) {
  const zh = locale === "zh";
  const resultRecord = record || turn;
  const outputs = useMemo(
    () => resultOutputs(resultRecord, session?.title, locale),
    [locale, resultRecord, session?.title],
  );
  const [index, setIndex] = useState(initialIndex);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    setIndex(Math.min(initialIndex, Math.max(outputs.length - 1, 0)));
    setFeedback("");
  }, [initialIndex, outputs.length, resultRecord?.runId, resultRecord?.turnId]);

  const output = outputs[index] || null;
  const requested = resultRecord?.requestedModelRevisionId || resultRecord?.result?.requestedModelRevisionId;
  const actual = resultRecord?.actualModelRevisionId || resultRecord?.result?.actualModelRevisionId || requested;
  const source = session?.source?.kind === "loop_run"
    ? (zh ? "来自 Loop 运行" : "From a Loop run")
    : (zh ? "手动任务" : "Manual task");

  async function copyContent() {
    if (output?.kind !== "markdown") return;
    try {
      const writeText = globalThis.navigator?.clipboard?.writeText;
      if (typeof writeText !== "function") throw new Error("clipboard_unavailable");
      await writeText.call(globalThis.navigator.clipboard, output.content);
      setFeedback(zh ? "已复制" : "Copied");
    } catch {
      setFeedback(zh ? "复制失败，请手动选择内容。" : "Copy failed. Select the content manually.");
    }
  }

  function downloadText() {
    if (output?.kind !== "markdown") return;
    const url = URL.createObjectURL(new Blob([output.content], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(output.title || "result").replaceAll(/[\\/:*?"<>|]/g, "-")}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (!output) return null;

  return (
    <aside
      className="agentResultReader"
      aria-labelledby="agent-result-reader-title"
      data-testid="loopops.main-agent.result-reader"
    >
      <header className="agentResultReaderHeader">
        <button type="button" className="agentReaderMobileBack" onClick={onClose}>
          <ArrowLeft size={16} aria-hidden="true" />
          {zh ? "任务" : "Task"}
        </button>
        <button
          type="button"
          className="agentReaderClose"
          onClick={onClose}
          aria-label={zh ? "关闭结果" : "Close result"}
        >
          <X size={16} aria-hidden="true" />
        </button>
        <strong id="agent-result-reader-title">{output.title}</strong>
        <div className="agentResultPager" aria-label={zh ? "切换结果" : "Change result"}>
          <span data-testid="loopops.main-agent.result.count">{index + 1}/{outputs.length}</span>
          <button
            type="button"
            onClick={() => setIndex((current) => Math.max(0, current - 1))}
            disabled={index === 0}
            aria-label={zh ? "上一个结果" : "Previous result"}
            data-testid="loopops.main-agent.result.previous"
          >
            <ChevronLeft size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setIndex((current) => Math.min(outputs.length - 1, current + 1))}
            disabled={index >= outputs.length - 1}
            aria-label={zh ? "下一个结果" : "Next result"}
            data-testid="loopops.main-agent.result.next"
          >
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="agentResultReaderBody">
        <p className="agentResultMeta">
          {output.kind === "markdown"
            ? <FileText size={14} aria-hidden="true" />
            : <ImageIcon size={14} aria-hidden="true" />}
          <span>
            {output.kind === "markdown" ? "Markdown" : output.artifact.mediaType}
            {resultRecord?.finishedAt ? ` · ${new Intl.DateTimeFormat(zh ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" }).format(new Date(resultRecord.finishedAt))}` : ""}
          </span>
        </p>

        {output.kind === "markdown" ? (
          <AgentMarkdown content={output.content} locale={locale} />
        ) : (
          <ArtifactImage
            artifactId={output.artifact.artifactId}
            alt={output.title}
            className="agentReaderImage"
          />
        )}

        <div className="agentResultActions">
          {output.kind === "markdown" ? (
            <>
              <button
                type="button"
                onClick={downloadText}
                data-testid="loopops.main-agent.result.download"
              >
                <Download size={14} />{zh ? "下载 .md" : "Download .md"}
              </button>
              <button
                type="button"
                onClick={copyContent}
                data-testid="loopops.main-agent.result.copy"
              >
                <Copy size={14} />{zh ? "复制内容" : "Copy"}
              </button>
            </>
          ) : (
            <a
              href={workbenchApi.artifactContentUrl(output.artifact.artifactId)}
              download
              data-testid="loopops.main-agent.result.download"
            >
              <Download size={14} />{zh ? "下载图片" : "Download image"}
            </a>
          )}
          {feedback ? <span role="status">{feedback}</span> : null}
        </div>

        <details
          className="agentRunInformation"
          data-testid="loopops.main-agent.result.run-info"
        >
          <summary>{zh ? "运行信息" : "Run information"}</summary>
          <dl>
            <div><dt>{zh ? "模型" : "Model"}</dt><dd>{modelLabel(actual || requested)}</dd></div>
            <div><dt>{zh ? "来源" : "Source"}</dt><dd>{source}</dd></div>
            <div><dt>{zh ? "用时" : "Duration"}</dt><dd>{durationLabel(resultRecord, locale)}</dd></div>
            <div>
              <dt>{zh ? "用量" : "Usage"}</dt>
              <dd data-testid="loopops.main-agent.result.usage">{usageLabel(resultRecord, locale)}</dd>
            </div>
          </dl>
        </details>
      </div>
    </aside>
  );
}
