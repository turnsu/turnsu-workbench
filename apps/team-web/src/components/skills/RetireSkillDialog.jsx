import { useEffect, useState } from "react";

import { Button, Dialog } from "../../design-system/index.jsx";

export function RetireSkillDialog({ workspace }) {
  const skill = workspace.retireSkillDialog;
  const t = workspace.t;
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (skill) setReason("");
  }, [skill]);

  async function submit(event) {
    event.preventDefault();
    if (!reason.trim() || submitting) return;
    setSubmitting(true);
    try {
      await workspace.retireSkill(reason.trim());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={Boolean(skill)}
      title={t("skillRetire.title")}
      onClose={workspace.closeRetireSkillDialog}
      actions={(
        <>
          <Button variant="secondary" onClick={workspace.closeRetireSkillDialog}>{t("actions.cancel")}</Button>
          <Button variant="destructive" type="submit" form="retire-skill-form" disabled={!reason.trim() || submitting} data-testid="loopops.skill-retire.submit">
            {submitting ? t("skillRetire.submitting") : t("skillRetire.confirm")}
          </Button>
        </>
      )}
    >
      <form id="retire-skill-form" className="createLoopForm" onSubmit={submit}>
        <p>{t("skillRetire.intro", { title: skill?.title || "" })}</p>
        <label>
          <span>{t("skillRetire.reason")}</span>
          <textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} data-testid="loopops.skill-retire.reason" />
        </label>
      </form>
    </Dialog>
  );
}
