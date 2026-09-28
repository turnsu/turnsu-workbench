import { useEffect, useMemo, useState } from "react";

import { Button, Dialog } from "../../design-system/index.jsx";

function normalized(value) {
  return String(value || "").trim();
}

function defaultForm(session) {
  const title = normalized(session?.title).slice(0, 200);
  return {
    title,
    objective: title,
    summary: "",
    participants: [],
    artifactIds: [],
  };
}

function participantLabel(participant) {
  return participant.displayName === participant.username
    ? participant.displayName
    : `${participant.displayName} · @${participant.username}`;
}

export function PromoteToWorkItemDialog({
  open,
  session,
  artifacts = [],
  participantsQuery,
  submitting = false,
  error = "",
  locale = "en",
  onClose,
  onSubmit,
}) {
  const [form, setForm] = useState(() => defaultForm(session));

  useEffect(() => {
    if (!open) return;
    setForm(defaultForm(session));
  }, [open, session?.sessionId, session?.title]);

  const candidates = participantsQuery?.data?.data || [];
  const availableArtifacts = useMemo(() => {
    const byId = new Map((artifacts || [])
      .filter((artifact) => artifact?.artifactId)
      .map((artifact) => [artifact.artifactId, artifact]));
    return [...byId.values()];
  }, [artifacts]);
  const selectedParticipants = new Map(form.participants.map((participant) => [
    participant.userId,
    participant,
  ]));
  const canSubmit = Boolean(
    normalized(form.title)
      && normalized(form.objective)
      && normalized(form.summary)
      && form.participants.length
      && !submitting
      && !participantsQuery?.isLoading
      && !participantsQuery?.error,
  );
  const copy = locale === "zh"
    ? {
        title: "共享给团队",
        intro: "只向你选择的协作者共享这里填写的摘要和所选成果。私人对话与执行记录仍仅你可见。",
        workTitle: "工作标题",
        objective: "协作目标",
        summary: "可共享交接摘要",
        summaryHint: "用队友可以直接继续的语言写出结论、上下文和下一步；不要粘贴私有对话。",
        participants: "选择协作者",
        participantsLoading: "正在读取当前工作区的可选协作者…",
        participantsEmpty: "当前还没有其他团队成员。请先邀请成员加入工作区，再共享这项成果。",
        artifacts: "选择要共享的产物（可选）",
        contribute: "可继续",
        read: "仅查看",
        cancel: "取消",
        submit: "创建团队工作",
        submitting: "正在创建…",
        error: "无法创建团队工作，请检查内容后重试。",
      }
    : {
        title: "Share as a team Work Item",
        intro: "Only the summary, selected artifacts, and teammates you explicitly choose here are shared. Private task history, raw conversation, and Worker logs are never copied.",
        workTitle: "Work Item title",
        objective: "Collaboration objective",
        summary: "Shareable handoff summary",
        summaryHint: "Write the conclusion, context, and next step a teammate needs. Do not paste private conversation.",
        participants: "Choose teammates",
        participantsLoading: "Loading eligible teammates in this workspace…",
        participantsEmpty: "There are no other active teammates to share with.",
        artifacts: "Choose artifacts to share (optional)",
        contribute: "Can continue",
        read: "View only",
        cancel: "Cancel",
        submit: "Create shared Work Item",
        submitting: "Creating…",
        error: "The shared Work Item could not be created. Check the details and retry.",
      };

  function toggleParticipant(candidate) {
    setForm((current) => {
      const exists = current.participants.some((participant) => participant.userId === candidate.userId);
      return {
        ...current,
        participants: exists
          ? current.participants.filter((participant) => participant.userId !== candidate.userId)
          : [...current.participants, { userId: candidate.userId, access: "contribute" }],
      };
    });
  }

  function updateParticipantAccess(userId, access) {
    setForm((current) => ({
      ...current,
      participants: current.participants.map((participant) => (
        participant.userId === userId ? { ...participant, access } : participant
      )),
    }));
  }

  function toggleArtifact(artifactId) {
    setForm((current) => ({
      ...current,
      artifactIds: current.artifactIds.includes(artifactId)
        ? current.artifactIds.filter((currentId) => currentId !== artifactId)
        : [...current.artifactIds, artifactId],
    }));
  }

  async function submit(event) {
    event.preventDefault();
    if (!canSubmit) return;
    await onSubmit({
      title: normalized(form.title),
      objective: normalized(form.objective),
      summary: normalized(form.summary),
      participants: form.participants,
      artifactIds: form.artifactIds,
    });
  }

  return (
    <Dialog
      open={open}
      title={copy.title}
      onClose={submitting ? undefined : onClose}
      initialFocusSelector="[data-testid='loopops.main-agent.work-item.title']"
      returnFocusSelector="[data-testid='loopops.main-agent.work-item.open']"
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {copy.cancel}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="agent-work-item-promotion-form"
            disabled={!canSubmit}
            data-testid="loopops.main-agent.work-item.submit"
          >
            {submitting ? copy.submitting : copy.submit}
          </Button>
        </>
      )}
    >
      <form
        id="agent-work-item-promotion-form"
        className="agentWorkItemPromotionForm"
        onSubmit={submit}
        data-testid="loopops.main-agent.work-item.dialog"
      >
        <p className="agentWorkItemPrivacyNote">{copy.intro}</p>
        <label>
          <span>{copy.workTitle}</span>
          <input
            value={form.title}
            maxLength={200}
            onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
            data-testid="loopops.main-agent.work-item.title"
          />
        </label>
        <label>
          <span>{copy.objective}</span>
          <textarea
            rows={2}
            value={form.objective}
            maxLength={2000}
            onChange={(event) => setForm((current) => ({ ...current, objective: event.target.value }))}
            data-testid="loopops.main-agent.work-item.objective"
          />
        </label>
        <label>
          <span>{copy.summary}</span>
          <textarea
            rows={5}
            value={form.summary}
            maxLength={8000}
            placeholder={copy.summaryHint}
            onChange={(event) => setForm((current) => ({ ...current, summary: event.target.value }))}
            data-testid="loopops.main-agent.work-item.summary"
          />
        </label>

        <fieldset className="agentWorkItemPromotionChoices">
          <legend>{copy.participants}</legend>
          {participantsQuery?.isLoading ? <p role="status">{copy.participantsLoading}</p> : null}
          {participantsQuery?.error ? <p role="alert">{participantsQuery.error.message || copy.error}</p> : null}
          {!participantsQuery?.isLoading && !participantsQuery?.error && !candidates.length ? (
            <p>{copy.participantsEmpty}</p>
          ) : null}
          {candidates.map((candidate) => {
            const selected = selectedParticipants.get(candidate.userId);
            return (
              <label className="agentWorkItemParticipant" key={candidate.userId}>
                <input
                  type="checkbox"
                  checked={Boolean(selected)}
                  onChange={() => toggleParticipant(candidate)}
                  disabled={submitting}
                />
                <span>
                  <strong>{participantLabel(candidate)}</strong>
                  <small>{candidate.role}</small>
                </span>
                {selected ? (
                  <select
                    aria-label={`${participantLabel(candidate)} access`}
                    value={selected.access}
                    onChange={(event) => updateParticipantAccess(candidate.userId, event.target.value)}
                    disabled={submitting}
                  >
                    <option value="contribute">{copy.contribute}</option>
                    <option value="read">{copy.read}</option>
                  </select>
                ) : null}
              </label>
            );
          })}
        </fieldset>

        {availableArtifacts.length ? (
          <fieldset className="agentWorkItemPromotionChoices">
            <legend>{copy.artifacts}</legend>
            {availableArtifacts.map((artifact) => (
              <label className="agentWorkItemArtifact" key={artifact.artifactId}>
                <input
                  type="checkbox"
                  checked={form.artifactIds.includes(artifact.artifactId)}
                  onChange={() => toggleArtifact(artifact.artifactId)}
                  disabled={submitting}
                />
                <span>{artifact.mediaType || artifact.artifactId}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {error ? <p className="agentWorkItemPromotionError" role="alert">{error || copy.error}</p> : null}
      </form>
    </Dialog>
  );
}
