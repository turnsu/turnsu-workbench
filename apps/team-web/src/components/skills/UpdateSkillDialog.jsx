import { useEffect, useState } from "react";

import { Button, Dialog } from "../../design-system/index.jsx";

export function UpdateSkillDialog({ workspace }) {
  const skill = workspace.skillUpdateDialog;
  const t = workspace.t;
  const [form, setForm] = useState({ name: "", description: "", category: "" });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!skill) return;
    setForm({
      name: skill.title,
      description: skill.description,
      category: skill.scenarios?.[0] || "",
    });
  }, [skill]);

  const valid = Boolean(form.name.trim() && form.description.trim() && form.category.trim());

  async function submit(event) {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await workspace.createSkillUpdateDraft({
        name: form.name.trim(),
        description: form.description.trim(),
        category: form.category.trim(),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={Boolean(skill)}
      title={t("skillUpdate.title")}
      onClose={workspace.closeSkillUpdateDialog}
      initialFocusSelector="[data-testid='loopops.skill-update.name']"
      returnFocusSelector="[data-testid='loopops.skill-versions.create-update'], [data-testid='loopops.skill-update.open']"
      actions={(
        <>
          <Button variant="secondary" onClick={workspace.closeSkillUpdateDialog} data-testid="loopops.skill-update.cancel">
            {t("actions.cancel")}
          </Button>
          <Button variant="primary" type="submit" form="skill-update-form" disabled={!valid || submitting} data-testid="loopops.skill-update.submit">
            {submitting ? t("skillUpdate.creating") : t("skillUpdate.createDraft")}
          </Button>
        </>
      )}
    >
      <form id="skill-update-form" className="createLoopForm" onSubmit={submit} data-testid="loopops.skill-update.dialog">
        <p data-testid="loopops.skill-update.immutability-note">{t("skillUpdate.intro", { version: skill?.version || "" })}</p>
        <label>
          <span>{t("skillCreate.name")}</span>
          <input data-testid="loopops.skill-update.name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
        </label>
        <label>
          <span>{t("skillCreate.description")}</span>
          <textarea data-testid="loopops.skill-update.description" rows={3} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} />
        </label>
        <label>
          <span>{t("skillCreate.category")}</span>
          <input data-testid="loopops.skill-update.category" value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))} />
        </label>
      </form>
    </Dialog>
  );
}
