import { useEffect, useRef, useState } from "react";
import { Button, Dialog } from "../../design-system/index.jsx";
import { useCreateModelProfileMutation, useModelConfigurationMembersQuery } from "../../api/queries.js";
import "./model-setup.css";

const INITIAL = { displayName: "DeepSeek", provider: "deepseek", providerModelId: "deepseek-flash", secretRef: "", makeDefault: true, forUserId: "" };
const ERRORS = {
  request_invalid: ["这份配置与服务端格式不一致，请刷新页面后重试。", "This configuration does not match the server. Refresh the page and retry."],
  model_secret_already_bound: ["这个凭证版本已绑定模型。可使用已有模型，或请管理员提供新版本。", "This credential revision already belongs to a model. Use that model or request a new revision."],
  model_secret_unavailable: ["找不到这个工作区的凭证。请确认管理员已挂载对应名称和版本，再重试。", "The credential is missing. Ask the deployment administrator to mount this reference in your workspace, then retry."],
  model_provider_auth_failed: ["服务商拒绝了这个凭证。请检查 API Key 的有效性与访问权限。", "The provider rejected this credential. Check its validity and access."],
  model_provider_model_unavailable: ["这个凭证无法访问所填模型，请检查服务商提供的模型 ID。", "This credential cannot access that model. Check the provider's model ID."],
  model_provider_unavailable: ["暂时无法连接模型服务。已填写的内容保留了，请稍后重试。", "The provider is unavailable. Your entries are preserved; try again shortly."],
  model_configuration_unavailable: ["服务端尚未配置凭证存储，请联系部署管理员完成设置。", "The server needs a configured Secret Store. Contact the deployment administrator."],
  model_configuration_forbidden: ["无法为所选成员配置模型。请确认成员仍在当前工作区且账号可用，再重新选择。", "This member cannot receive a model. Check that their workspace membership and account are active, then choose again."],
};

export function ModelSetupDialog({ open, onClose, onCreated, principal = {}, locale = "zh" }) {
  const zh = locale === "zh";
  const [form, setForm] = useState(INITIAL);
  const [advanced, setAdvanced] = useState(false);
  const mutation = useCreateModelProfileMutation();
  const membersQuery = useModelConfigurationMembersQuery(principal, open);
  const members = (membersQuery.data?.data ?? []).filter((member) => !member.disabled && member.userId !== principal.userId);
  const attempt = useRef(null);
  const formRef = useRef(null);
  useEffect(() => { if (open) mutation.reset(); }, [open]);
  useEffect(() => { setForm(INITIAL); attempt.current = null; }, [principal.userId, principal.workspaceId]);
  const update = (name, value) => setForm((current) => ({ ...current, [name]: value }));
  const close = () => { if (!mutation.isPending) onClose(); };
  const submit = async (event) => {
    event.preventDefault();
    if (mutation.isPending || !formRef.current?.reportValidity()) return;
    const { forUserId, ...configuration } = form;
    const data = { ...configuration, ...(forUserId ? { forUserId } : {}), displayName: form.displayName.trim(), providerModelId: form.providerModelId.trim(), secretRef: form.secretRef.trim() };
    const signature = JSON.stringify(data);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    try {
      const result = await mutation.mutateAsync({ data, idempotencyKey: attempt.current.key });
      onCreated(result.data.profileId, {
        forUserId: forUserId || principal.userId,
        recipientName: forUserId ? members.find((member) => member.userId === forUserId)?.username : null,
      });
      setForm(INITIAL);
      attempt.current = null;
      onClose();
    } catch { /* Keep values and the same receipt key for a safe retry. */ }
  };
  const message = mutation.error ? (ERRORS[mutation.error.code]?.[zh ? 0 : 1]
    || (zh ? "未能保存模型配置，请检查内容后重试。" : "Could not save this model. Check the entries and retry.")) : "";
  return (
    <Dialog open={open} title={zh ? "连接模型" : "Connect a model"} onClose={close}
      initialFocusSelector="[name=provider]" returnFocusSelector=".settingsAddModel"
      actions={<><Button onClick={close} disabled={mutation.isPending}>{zh ? "取消" : "Cancel"}</Button>
        <Button variant="primary" type="submit" form="model-setup" disabled={mutation.isPending}>
          {mutation.isPending ? (zh ? "正在验证并保存…" : "Verifying…") : (zh ? "验证并启用" : "Verify and enable")}
        </Button></>}>
      <form id="model-setup" ref={formRef} className="modelSetupForm" onSubmit={submit} aria-busy={mutation.isPending}>
        <p className="modelSetupIntro">{zh ? "选择服务商，连接已由部署管理员准备好的模型授权。" : "Choose a provider and connect the model access prepared by your deployment administrator."}</p>
        <fieldset disabled={mutation.isPending}>
          <label>{zh ? "服务商" : "Provider"}<select name="provider" value={form.provider} onChange={(event) => {
            const provider = event.target.value;
            mutation.reset();
            setAdvanced(provider === "openai");
            setForm((current) => ({ ...current, provider, providerModelId: provider === "deepseek" ? "deepseek-flash" : "", displayName: provider === "deepseek" ? "DeepSeek" : "OpenAI" }));
          }}><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option></select></label>
          <label>{zh ? "使用对象" : "Model user"}<select value={form.forUserId} onChange={(event) => update("forUserId", event.target.value)} disabled={membersQuery.isPending || membersQuery.isError}>
            <option value="">{zh ? "我自己" : "Myself"}</option>
            {members.map((member) => <option key={member.userId} value={member.userId}>{member.username}</option>)}
          </select></label>
          {membersQuery.isPending ? <p className="modelSetupHint" role="status">{zh ? "正在读取团队成员…" : "Loading team members…"}</p> : null}
          {membersQuery.isError ? <p className="modelSetupError" role="alert">{zh ? "团队成员暂时无法读取。" : "Could not load team members."} <button type="button" onClick={() => membersQuery.refetch()}>{zh ? "重试" : "Retry"}</button></p> : null}
          <label>{zh ? "服务端凭据" : "Server credential"}<input name="secretRef" required autoComplete="off" spellCheck={false} maxLength={138}
            pattern={"[A-Za-z][A-Za-z0-9._\\-]{0,127}:[1-9][0-9]{0,8}"} placeholder="deepseek:1"
            aria-describedby="model-setup-credential-hint" value={form.secretRef} onChange={(event) => update("secretRef", event.target.value)} /></label>
          <p id="model-setup-credential-hint" className="modelSetupHint">{zh ? "填写管理员提供的凭据名称，例如 deepseek:1。若尚未准备好授权，请先联系部署管理员。无需在这里填写 API Key。" : "Enter the reference provided by your administrator, such as deepseek:1. If access is not ready, contact your deployment administrator. No API key is needed here."}</p>
          <details className="modelSetupAdvanced" open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
            <summary>{zh ? "模型与显示名称" : "Model and display name"}<span>{form.providerModelId || (zh ? "需要选择模型" : "Choose a model")}</span></summary>
            <div className="modelSetupRow">
              <label>{zh ? "模型 ID" : "Model ID"}<input required maxLength={256} value={form.providerModelId} onInvalid={() => setAdvanced(true)} onChange={(event) => update("providerModelId", event.target.value)} placeholder={zh ? "服务商提供的模型 ID" : "Provider model ID"} /></label>
              <label>{zh ? "显示名称" : "Display name"}<input name="displayName" required maxLength={120} value={form.displayName} onInvalid={() => setAdvanced(true)} onChange={(event) => update("displayName", event.target.value)} /></label>
            </div>
          </details>
          <label className="modelSetupCheckbox"><input type="checkbox" checked={form.makeDefault} onChange={(event) => update("makeDefault", event.target.checked)} />{form.forUserId ? (zh ? "作为该成员新任务的默认模型" : "Use by default for this member's new tasks") : (zh ? "作为我新任务的默认模型" : "Use by default for my new tasks")}</label>
        </fieldset>
        {message ? <p className="modelSetupError" role="alert">{message}</p> : null}
        {mutation.error?.code ? <details className="modelSetupHint"><summary>{zh ? "错误详情" : "Error details"}</summary><code>{mutation.error.code}</code></details> : null}
        {mutation.error?.code === "model_provider_model_unavailable" && mutation.error.details?.availableModelIds?.length ? (
          <label>{zh ? "账号可用模型" : "Available models"}<select value="" onChange={(event) => {
            update("providerModelId", event.target.value); mutation.reset();
          }}><option value="">{zh ? "选择模型后重新验证" : "Choose a model and retry"}</option>
            {mutation.error.details.availableModelIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </select></label>
        ) : null}
      </form>
    </Dialog>
  );
}
