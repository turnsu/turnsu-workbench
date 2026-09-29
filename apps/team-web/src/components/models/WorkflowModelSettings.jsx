import { ModelSwitch } from "./ModelSwitch.jsx";
import { useModelCatalog } from "../../state/models/index.js";

export function WorkflowModelSettings({ settings = {}, onChange, t, disabled = false, testId = "loopops.workflow.models" }) {
  const controller = useModelCatalog({
    capabilities: ["chat", "tool_calling"],
    context: "workflow_agent",
    selectionKind: "profile",
  });
  const images = useModelCatalog({
    capabilities: ["image_generation"],
    context: "workflow_model_task",
    selectionKind: "profile",
  });
  return (
    <section className="modelSettingsPanel" data-testid={testId}>
      <header><h3>{t("model.runSettings")}</h3><p>{t("model.runSettingsHint")}</p></header>
      <div className="modelSettingsGrid">
        <div className="modelSettingsField"><span>{t("model.workflowController")}</span>
        <ModelSwitch
          options={controller.options}
          selectionKind="profile"
          requiredCapabilities={["chat", "tool_calling"]}
          value={settings.agentControllerModelProfileId || ""}
          onChange={(value) => onChange?.("agentControllerModelProfileId", value)}
          label={t("model.workflowController")}
          allowInherit
          inheritLabel={t("model.inherit")}
          disabled={disabled}
          loading={controller.isLoading}
          unavailableLabel={t("model.unavailable")}
          historicalLabel={t("model.historical")}
          groupLabels={{ text: t("model.groupText"), image: t("model.groupImage") }}
          testId={`${testId}.controller`}
        />
        </div>
        <div className="modelSettingsField"><span>{t("model.workflowImage")}</span>
        <ModelSwitch
          options={images.options}
          selectionKind="profile"
          requiredCapabilities={["image_generation"]}
          value={settings.imageGenerationModelProfileId || ""}
          onChange={(value) => onChange?.("imageGenerationModelProfileId", value)}
          label={t("model.workflowImage")}
          allowInherit
          inheritLabel={t("model.inherit")}
          disabled={disabled}
          loading={images.isLoading}
          unavailableLabel={t("model.unavailable")}
          historicalLabel={t("model.historical")}
          groupLabels={{ text: t("model.groupText"), image: t("model.groupImage") }}
          testId={`${testId}.image`}
        />
        </div>
      </div>
      <label className="modelFallbackField">
        <input
          type="checkbox"
          checked={settings.workflowFallbackAllowed === true}
          onChange={(event) => onChange?.("workflowFallbackAllowed", event.target.checked)}
          disabled={disabled}
          data-testid={`${testId}.fallback`}
        />
        <span>{t("model.workflowFallback")}<small>{t("model.workflowFallbackHint")}</small></span>
      </label>
    </section>
  );
}

export function NodeModelOverride({ capability, value, onChange, t, disabled = false, testId = "loopops.workflow.node-model" }) {
  const catalog = useModelCatalog({
    capabilities: [capability],
    context: "workflow_model_task",
    selectionKind: "profile",
  });
  return (
    <ModelSwitch
      options={catalog.options}
      selectionKind="profile"
      requiredCapabilities={[capability]}
      value={value || ""}
      onChange={onChange}
      label={t("model.nodeOverride")}
      hint={t("model.nodeOverrideHint")}
      allowInherit
      inheritLabel={t("model.inherit")}
      disabled={disabled}
      loading={catalog.isLoading}
      unavailableLabel={t("model.unavailable")}
      historicalLabel={t("model.historical")}
      groupLabels={{ text: t("model.groupText"), image: t("model.groupImage") }}
      testId={testId}
    />
  );
}
