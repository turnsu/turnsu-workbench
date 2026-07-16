import { useState } from "react";

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
  const [submitting, setSubmitting] = useState(false);
  const t = workspace.t;
  const valid = Boolean(form.label.trim() && form.content.trim());

  async function submit(event) {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const created = await workspace.createTextResource({
        label: form.label.trim(), mediaType: form.mediaType, contentBase64: encodeText(form.content),
      });
      if (created) setForm(initialForm);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={workspace.createResourceDialogOpen}
      title={t("materialCreate.title")}
      onClose={workspace.closeCreateResourceDialog}
      actions={<><Button variant="secondary" onClick={workspace.closeCreateResourceDialog}>{t("actions.cancel")}</Button><Button variant="primary" type="submit" form="create-resource-form" disabled={!valid || submitting} data-testid="loopops.create-material.submit">{submitting ? t("materialCreate.submitting") : t("materialCreate.confirm")}</Button></>}
    >
      <form id="create-resource-form" className="createLoopForm" onSubmit={submit}>
        <p>{t("materialCreate.intro")}</p>
        <label><span>{t("materialCreate.name")}</span><input value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} data-testid="loopops.create-material.name" /></label>
        <label><span>{t("materialCreate.format")}</span><select value={form.mediaType} onChange={(event) => setForm((current) => ({ ...current, mediaType: event.target.value }))}><option value="text/markdown">Markdown</option><option value="text/plain">Plain text</option></select></label>
        <label><span>{t("materialCreate.content")}</span><textarea rows={8} value={form.content} onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))} data-testid="loopops.create-material.content" /></label>
      </form>
    </Dialog>
  );
}
