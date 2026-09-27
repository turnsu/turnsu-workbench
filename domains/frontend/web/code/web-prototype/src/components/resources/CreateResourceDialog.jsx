import { useEffect, useRef, useState } from "react";

import { useAttachmentMutations } from "../../api/queries.js";
import { Button, Dialog } from "../../design-system/index.jsx";

const initialForm = { label: "", mediaType: "text/markdown", content: "" };

function encodeText(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary);
}

export function CreateResourceDialog({ workspace }) {
  const [form, setForm] = useState(initialForm);
  const [mode, setMode] = useState("text");
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(true);
  const operationGeneration = useRef(0);
  const attachments = useAttachmentMutations();
  const t = workspace.t;
  const valid = Boolean(form.label.trim() && (mode === "text" ? form.content.trim() : file));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationGeneration.current += 1;
    };
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (!valid || submitting) return;
    const generation = ++operationGeneration.current;
    setSubmitting(true);
    setError("");
    try {
      let created;
      if (mode === "text") {
        created = await workspace.createTextResource({
          label: form.label.trim(),
          mediaType: form.mediaType,
          contentBase64: encodeText(form.content),
        });
      } else {
        const processed = await attachments.createAttachment.mutateAsync({
          file,
          idempotencyKey: `workspace-resource-attachment-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
        });
        const attachment = processed.data.attachment;
        if (!mounted.current || operationGeneration.current !== generation) {
          void attachments.deleteAttachment.mutateAsync({
            attachmentId: attachment.attachmentId,
            idempotencyKey: `discard-resource-upload-${attachment.attachmentId}`,
          }).catch(() => {});
          return;
        }
        if (attachment.processing.status !== "ready") {
          throw new Error(attachment.processing.message || "attachment_processing_failed");
        }
        created = await workspace.createResourceFromAttachment({
          label: form.label.trim(),
          attachment: {
            attachmentId: attachment.attachmentId,
            version: attachment.version,
            contentHash: attachment.contentHash,
            mediaType: attachment.mediaType,
          },
        });
      }
      if (created && mounted.current && operationGeneration.current === generation) {
        workspace.completeResourceCreation(created);
        setForm(initialForm);
        setFile(null);
        setMode("text");
      }
    } catch (failure) {
      if (mounted.current && operationGeneration.current === generation) {
        setError(failure?.message || "resource_creation_failed");
      }
    } finally {
      if (mounted.current && operationGeneration.current === generation) setSubmitting(false);
    }
  }

  function close() {
    if (!submitting) workspace.closeCreateResourceDialog();
  }

  return (
    <Dialog
      open={workspace.createResourceDialogOpen}
      title={t("materialCreate.title")}
      onClose={close}
      actions={<><Button variant="secondary" onClick={close} disabled={submitting}>{t("actions.cancel")}</Button><Button variant="primary" type="submit" form="create-resource-form" disabled={!valid || submitting} data-testid="loopops.create-material.submit">{submitting ? t("materialCreate.submitting") : t("materialCreate.confirm")}</Button></>}
    >
      <form id="create-resource-form" className="createLoopForm" onSubmit={submit}>
        <p>{t("materialCreate.intro")}</p>
        <label><span>{t("materialCreate.name")}</span><input value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} data-testid="loopops.create-material.name" /></label>
        <div className="resourceCreateModes" role="group" aria-label={t("materialCreate.format")}>
          <Button type="button" variant={mode === "text" ? "primary" : "secondary"} onClick={() => setMode("text")}>{workspace.locale === "zh" ? "文本资料" : "Text material"}</Button>
          <Button type="button" variant={mode === "file" ? "primary" : "secondary"} onClick={() => setMode("file")}>{workspace.locale === "zh" ? "上传文件" : "Upload file"}</Button>
        </div>
        {mode === "text" ? (
          <>
            <label><span>{t("materialCreate.format")}</span><select value={form.mediaType} onChange={(event) => setForm((current) => ({ ...current, mediaType: event.target.value }))}><option value="text/markdown">Markdown</option><option value="text/plain">Plain text</option><option value="text/csv">CSV</option></select></label>
            <label><span>{t("materialCreate.content")}</span><textarea rows={8} value={form.content} onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))} data-testid="loopops.create-material.content" /></label>
          </>
        ) : (
          <label className="skillPackagePicker">
            <span>{workspace.locale === "zh" ? "材料文件" : "Material file"}</span>
            <input
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.pdf,.docx,.xlsx"
              onChange={(event) => {
                setFile(event.target.files?.[0] || null);
                setError("");
              }}
              data-testid="loopops.create-material.file"
            />
            <small>{file?.name || (workspace.locale === "zh" ? "支持图片、MD/TXT/CSV、文本 PDF、DOCX、XLSX" : "Images, MD/TXT/CSV, text PDF, DOCX, and XLSX")}</small>
          </label>
        )}
        {error ? <p role="alert" className="agentComposerError">{error}</p> : null}
      </form>
    </Dialog>
  );
}
