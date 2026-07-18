import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

import { defaultModelSelection, useModelCatalog } from "../../state/models/index.js";
import { useAgentSessionController } from "../../state/agents/index.js";
import { ChatComposer } from "../models/ChatComposer.jsx";
import { ModelPicker } from "../models/ModelPicker.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";

export function SkillCreatorAgentPanel({ workspace, draft }) {
  const t = workspace.t;
  const [modelRevisionId, setModelRevisionId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const catalog = useModelCatalog({
    capabilities: ["chat", "tool_calling", "structured_output"],
    context: "builder",
    selectedRevisionId: modelRevisionId,
  });
  const creator = useAgentSessionController({
    workspaceId: workspace.serverState?.workspace?.workspaceId,
    userId: workspace.session?.userId,
    definitionId: "skill_creator",
    definitionKind: "module",
    objectKind: "skill_draft",
    objectId: draft?.skillDraftId,
    enabled: Boolean(draft?.skillDraftId),
  });

  useEffect(() => {
    if (!modelRevisionId && catalog.profiles.length) {
      setModelRevisionId(defaultModelSelection(catalog.profiles, "structured_output", "revision"));
    }
  }, [modelRevisionId, catalog.profiles]);
  const selectedModel = catalog.options.find((option) => option.value === modelRevisionId);

  async function submit() {
    setError("");
    try {
      await creator.sendMessage(message, modelRevisionId, selectedModel?.profileId);
      setMessage("");
    } catch (nextError) {
      setError(nextError?.message || t("error.unknown"));
    }
  }

  return (
    <section className="creatorAgentPanel modelSettingsPanel" data-testid="loopops.skill.creator-agent">
      <header><h3><Sparkles size={14} /> {t("skillCreator.agentTitle")}</h3><p>{t("skillCreator.agentCaption")}</p></header>
      {creator.history.length ? (
        <ol className="creatorAgentHistory">
          {creator.history.map((turn) => (
            <li key={turn.turnId}>
              <span><strong>{turn.input?.message || turn.message}</strong><small>{turn.result?.response || turn.result?.content || t(`skillCreator.status.${turn.status}`)}</small></span>
              <StatusPill tone={turn.status === "completed" ? "success" : turn.status === "failed" || turn.status === "blocked" ? "danger" : "info"}>{t(`skillCreator.status.${turn.status}`)}</StatusPill>
            </li>
          ))}
        </ol>
      ) : null}
      <ModelPicker
        options={catalog.options}
        requiredCapabilities={["chat", "tool_calling", "structured_output"]}
        value={modelRevisionId}
        onChange={setModelRevisionId}
        label={t("model.builder")}
        hint={t("model.turnPinHint")}
        loading={catalog.isLoading}
        unavailableLabel={t("model.unavailable")}
        historicalLabel={t("model.historical")}
        testId="loopops.skill.creator-agent.model"
      />
      <ChatComposer
        value={message}
        onChange={setMessage}
        onSubmit={submit}
        disabled={!selectedModel || selectedModel.disabled || Boolean(creator.activeTurn) || creator.loading || workspace.readOnlyWorkspace}
        busy={creator.busy}
        label={t("skillCreator.requestLabel")}
        placeholder={t("skillCreator.requestPlaceholder")}
        submitLabel={t("skillCreator.requestProposal")}
        busyLabel={t("agent.main.working")}
        testId="loopops.skill.creator-agent.composer"
      />
      <p className="muted">{t("skillCreator.proposalSafety")}</p>
      {error || creator.error ? <p className="agentComposerError" role="alert">{error || creator.error?.message}</p> : null}
    </section>
  );
}
