import { useEffect, useMemo, useState } from "react";
import { Image as ImageIcon, MessageSquare, Sparkles, X } from "lucide-react";

import { Button, SegmentedControl } from "../../design-system/index.jsx";
import { defaultModelSelection, useModelCatalog } from "../../state/models/index.js";
import { useMainAgent } from "../../state/agents/index.js";
import { ArtifactImage } from "../models/ArtifactImage.jsx";
import { ChatComposer } from "../models/ChatComposer.jsx";
import { ImageComposer } from "../models/ImageComposer.jsx";
import { ModelPicker } from "../models/ModelPicker.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";

const TERMINAL = new Set(["completed", "failed", "cancelled", "blocked"]);

function turnResult(turn) {
  return turn?.result?.modelResult || turn?.result || null;
}

function artifactRefs(turn) {
  const result = turnResult(turn);
  return result?.artifactRefs || result?.artifacts || [];
}

function responseText(turn) {
  const result = turnResult(turn);
  return result?.response || result?.content || result?.message || "";
}

function revisionLabel(profiles, revisionId) {
  if (!revisionId) return "—";
  for (const profile of profiles) {
    const revision = profile.currentRevision || profile.revision;
    const historical = [profile.selectedRevision, profile.historicalRevision, ...(profile.revisions || [])]
      .filter(Boolean)
      .find((item) => item.revisionId === revisionId);
    const match = revision?.revisionId === revisionId ? revision : historical;
    if (match) return `${profile.displayName || match.modelDisplayName} · r${match.revisionNumber || "?"}`;
  }
  return revisionId;
}

export function MainAgentView({ workspace }) {
  const t = workspace.t;
  const [mode, setMode] = useState("chat");
  const [message, setMessage] = useState("");
  const [imageInput, setImageInput] = useState({ prompt: "", negativePrompt: "", aspectRatio: "1:1", outputFormat: "png" });
  const [chatRevisionId, setChatRevisionId] = useState("");
  const [imageRevisionId, setImageRevisionId] = useState("");
  const [error, setError] = useState("");
  const chatCatalog = useModelCatalog({ capabilities: ["chat", "tool_calling"], context: "agent_controller", selectedRevisionId: chatRevisionId });
  const imageCatalog = useModelCatalog({ capabilities: ["image_generation"], context: "direct_model_task", selectedRevisionId: imageRevisionId });
  const agent = useMainAgent({
    workspaceId: workspace.serverState?.workspace?.workspaceId,
    userId: workspace.session?.userId,
  });

  useEffect(() => {
    if (!chatRevisionId && chatCatalog.profiles.length) {
      setChatRevisionId(defaultModelSelection(chatCatalog.profiles, "chat", "revision"));
    }
  }, [chatRevisionId, chatCatalog.profiles]);

  useEffect(() => {
    if (!imageRevisionId && imageCatalog.profiles.length) {
      setImageRevisionId(defaultModelSelection(imageCatalog.profiles, "image_generation", "revision"));
    }
  }, [imageRevisionId, imageCatalog.profiles]);

  const allProfiles = useMemo(
    () => [...chatCatalog.profiles, ...imageCatalog.profiles.filter((profile) => !chatCatalog.profiles.some((item) => item.profileId === profile.profileId))],
    [chatCatalog.profiles, imageCatalog.profiles],
  );
  const selectedChatOption = chatCatalog.options.find((option) => option.value === chatRevisionId);
  const selectedImageOption = imageCatalog.options.find((option) => option.value === imageRevisionId);
  const imageParameterSupport = selectedImageOption?.profile?.currentRevision?.parameterSupport || null;

  useEffect(() => {
    if (imageParameterSupport?.kind !== "image_generation") return;
    setImageInput((current) => ({
      ...current,
      negativePrompt: imageParameterSupport.negativePrompt === false ? "" : current.negativePrompt,
      aspectRatio: imageParameterSupport.aspectRatios.includes(current.aspectRatio)
        ? current.aspectRatio
        : imageParameterSupport.aspectRatios[0],
      outputFormat: imageParameterSupport.outputFormats.includes(current.outputFormat)
        ? current.outputFormat
        : imageParameterSupport.outputFormats[0],
      seed: imageParameterSupport.seed === false ? "" : current.seed,
    }));
  }, [imageRevisionId, imageParameterSupport]);

  async function sendMessage() {
    setError("");
    try {
      await agent.sendMessage(message, chatRevisionId, selectedChatOption?.profileId);
      setMessage("");
    } catch (nextError) {
      setError(nextError?.message || t("error.unknown"));
    }
  }

  async function createImage() {
    setError("");
    try {
      await agent.createImage(imageInput, imageRevisionId, selectedImageOption?.profileId);
      setImageInput((current) => ({ ...current, prompt: "", negativePrompt: "" }));
    } catch (nextError) {
      setError(nextError?.message || t("error.unknown"));
    }
  }

  const active = agent.activeTurn && !TERMINAL.has(agent.activeTurn.status);
  const selectedOption = mode === "chat" ? selectedChatOption : selectedImageOption;
  const selectionReady = Boolean(selectedOption && !selectedOption.disabled);

  return (
    <div className="surface mainAgentPage" data-testid="loopops.main-agent.surface">
      <header className="mainAgentHeader">
        <div>
          <p className="objectKicker"><Sparkles size={14} /> {t("agent.main.kicker")}</p>
          <h1>{t("agent.main.title")}</h1>
          <p>{t("agent.main.caption")}</p>
        </div>
        {agent.session ? <StatusPill tone={active ? "info" : "success"}>{active ? t("agent.main.working") : t("agent.main.ready")}</StatusPill> : null}
      </header>

      <div className="mainAgentLayout">
        <main className="mainAgentConversation" aria-live="polite">
          {!agent.history.length ? (
            <section className="agentEmptyState">
              <Sparkles size={22} />
              <h2>{t("agent.main.emptyTitle")}</h2>
              <p>{t("agent.main.emptyBody")}</p>
            </section>
          ) : (
            <ol className="agentTurnList" data-testid="loopops.main-agent.history">
              {agent.history.map((turn) => {
                const requested = turn.requestedModelRevisionId || turn.modelProfileRevisionId;
                const actual = turn.actualModelRevisionId || turnResult(turn)?.actualModelRevisionId;
                const fallback = Boolean(actual && requested && actual !== requested);
                return (
                  <li key={turn.turnId} className={`agentTurn agentTurn-${turn.status}`} data-testid={`loopops.main-agent.turn.${turn.turnId}`}>
                    <div className="agentTurnRequest">
                      <span>{turn.kind === "model_task" ? <ImageIcon size={14} /> : <MessageSquare size={14} />}</span>
                      <p>{turn.input?.message || turn.input?.prompt || turn.message}</p>
                    </div>
                    <div className="agentTurnResult">
                      {responseText(turn) ? <p>{responseText(turn)}</p> : null}
                      {artifactRefs(turn).map((artifact) => (
                        <ArtifactImage key={artifact.artifactId || artifact} artifactId={artifact.artifactId || artifact} alt={turn.input?.prompt || t("agent.image.generatedAlt")} />
                      ))}
                      {!TERMINAL.has(turn.status) ? <p className="muted">{t("agent.main.turnWorking")}</p> : null}
                      {turn.error ? <p className="agentTurnError" role="alert">{turn.error.message || turn.error.code}</p> : null}
                    </div>
                    <dl className="agentTurnModel">
                      <div><dt>{t("model.requested")}</dt><dd>{revisionLabel(allProfiles, requested)}</dd></div>
                      <div><dt>{t("model.actual")}</dt><dd>{revisionLabel(allProfiles, actual || requested)}{fallback ? ` · ${t("model.fallbackUsed")}` : ""}</dd></div>
                    </dl>
                  </li>
                );
              })}
            </ol>
          )}
        </main>

        <aside className="mainAgentComposerPanel">
          <SegmentedControl
            label={t("agent.main.taskType")}
            value={mode}
            onChange={setMode}
            options={[
              { value: "chat", label: t("agent.main.chatMode") },
              { value: "image", label: t("agent.main.imageMode") },
            ]}
            data-testid="loopops.main-agent.mode"
          />
          {mode === "chat" ? (
            <ModelPicker
              options={chatCatalog.options}
              requiredCapabilities={["chat", "tool_calling"]}
              value={chatRevisionId}
              onChange={setChatRevisionId}
              label={t("model.controller")}
              hint={t("model.turnPinHint")}
              loading={chatCatalog.isLoading}
              unavailableLabel={t("model.unavailable")}
              historicalLabel={t("model.historical")}
              testId="loopops.main-agent.model.chat"
            />
          ) : (
            <ModelPicker
              options={imageCatalog.options}
              requiredCapabilities={["image_generation"]}
              value={imageRevisionId}
              onChange={setImageRevisionId}
              label={t("model.imageGenerator")}
              hint={t("model.turnPinHint")}
              loading={imageCatalog.isLoading}
              unavailableLabel={t("model.unavailable")}
              historicalLabel={t("model.historical")}
              testId="loopops.main-agent.model.image"
            />
          )}
          {mode === "chat" ? (
            <ChatComposer
              value={message}
              onChange={setMessage}
              onSubmit={sendMessage}
              disabled={!selectionReady || Boolean(active) || agent.loading || workspace.readOnlyWorkspace}
              busy={agent.busy}
              label={t("agent.chat.message")}
              placeholder={t("agent.chat.placeholder")}
              submitLabel={t("agent.chat.send")}
              busyLabel={t("agent.main.working")}
              testId="loopops.main-agent.chat"
            />
          ) : (
            <ImageComposer
              value={imageInput}
              onChange={setImageInput}
              onSubmit={createImage}
              parameterSupport={imageParameterSupport}
              disabled={!selectionReady || Boolean(active) || agent.loading || workspace.readOnlyWorkspace}
              busy={agent.busy}
              labels={{
                prompt: t("agent.image.prompt"),
                negativePrompt: t("agent.image.negativePrompt"),
                placeholder: t("agent.image.placeholder"),
                aspectRatio: t("agent.image.aspectRatio"),
                outputFormat: t("agent.image.outputFormat"),
                seed: t("agent.image.seed"),
                governedHint: t("agent.image.governedHint"),
                submit: t("agent.image.create"),
                busy: t("agent.image.creating"),
              }}
              testId="loopops.main-agent.image"
            />
          )}
          {active && !workspace.readOnlyWorkspace ? (
            <Button variant="secondary" icon={<X size={15} />} onClick={() => agent.cancelActive()} data-testid="loopops.main-agent.cancel">
              {t("actions.cancel")}
            </Button>
          ) : null}
          {error || agent.error ? <p className="agentComposerError" role="alert">{error || agent.error?.message}</p> : null}
        </aside>
      </div>
    </div>
  );
}
