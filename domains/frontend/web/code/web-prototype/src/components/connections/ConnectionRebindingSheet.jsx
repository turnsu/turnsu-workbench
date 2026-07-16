import { useEffect, useMemo, useState } from "react";
import { Cable, CheckCircle2, Plus, Settings2, ShieldCheck } from "lucide-react";

import { useConnectionMutations, useConnectionsQuery } from "../../api/queries.js";
import { Button, Dialog } from "../../design-system/index.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";

const idempotencyKey = (kind) => `${kind}-${globalThis.crypto?.randomUUID?.() || Date.now()}`;

function isReady(connection) {
  return connection?.status === "connected" && connection?.validation?.status === "valid";
}

function statusKey(connection) {
  if (isReady(connection)) return "connections.status.ready";
  if (connection?.status === "disabled") return "connections.status.disabled";
  if (connection?.validation?.status === "invalid") return "connections.status.invalid";
  return "connections.status.needsSetup";
}

function toneFor(connection) {
  if (isReady(connection)) return "success";
  if (connection?.status === "disabled") return "neutral";
  return "warning";
}

function ConnectionSummary({ connection, t, action }) {
  return (
    <div className="connectionSummary">
      <div><span>{t("connections.capability")}</span><strong>{connection.capabilityKey}</strong></div>
      <div><span>{t("connections.label")}</span><strong>{connection.label}</strong></div>
      <div><span>{t("connections.permissionSummary")}</span><p>{connection.configuration?.permissionSummary || t("connections.permissionMissing")}</p></div>
      <div><span>{t("connections.status")}</span><StatusPill tone={toneFor(connection)}>{t(statusKey(connection))}</StatusPill></div>
      {action}
    </div>
  );
}

export function ConnectionRebindingSheet({
  open,
  actionLabel,
  requirements,
  submitting,
  errorCode,
  readOnly,
  onClose,
  onSubmit,
  onRequestAccess,
  t,
}) {
  const connectionsQuery = useConnectionsQuery(open);
  const connectionMutations = useConnectionMutations();
  const [selectedByRequirement, setSelectedByRequirement] = useState({});
  const [localConnections, setLocalConnections] = useState({});
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ label: "", permissionSummary: "" });
  const [configurationError, setConfigurationError] = useState("");
  const [configuring, setConfiguring] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelectedByRequirement({});
      setLocalConnections({});
      setEditing(null);
      setConfigurationError("");
    }
  }, [open]);

  const connections = useMemo(() => {
    const values = connectionsQuery.data?.data || [];
    return values.map((connection) => localConnections[connection.connectionId] || connection)
      .concat(Object.values(localConnections).filter((connection) => (
        !values.some((item) => item.connectionId === connection.connectionId)
      )));
  }, [connectionsQuery.data, localConnections]);

  const requirementRows = requirements.map((requirement) => {
    const matches = connections.filter((connection) => connection.capabilityKey === requirement.requirementId);
    const selected = matches.find((connection) => (
      connection.connectionId === selectedByRequirement[requirement.requirementId]
    )) || null;
    return { ...requirement, matches, selected };
  });
  const bindingsReady = requirementRows.length > 0 && requirementRows.every(({ selected }) => isReady(selected));
  const disabledReason = readOnly
    ? t("connections.viewerReason")
    : connectionsQuery.isLoading
      ? t("connections.loading")
      : !bindingsReady
        ? t("connections.bindingRequired")
        : "";

  function openConfiguration(requirementId, connection = null) {
    if (readOnly) return;
    setEditing({ requirementId, connection });
    setForm({
      label: connection?.label || "",
      permissionSummary: connection?.configuration?.permissionSummary || "",
    });
    setConfigurationError("");
  }

  async function saveAndValidate() {
    const label = form.label.trim();
    const permissionSummary = form.permissionSummary.trim();
    if (!label || !permissionSummary || !editing || configuring) return;
    setConfiguring(true);
    setConfigurationError("");
    try {
      const saved = editing.connection
        ? await connectionMutations.updateConnection.mutateAsync({
            connectionId: editing.connection.connectionId,
            idempotencyKey: idempotencyKey("connection-update"),
            label,
            permissionSummary,
          })
        : await connectionMutations.createConnection.mutateAsync({
            idempotencyKey: idempotencyKey("connection-create"),
            capabilityKey: editing.requirementId,
            label,
            permissionSummary,
          });
      const validated = await connectionMutations.validateConnection.mutateAsync({
        connectionId: saved.data.connectionId,
        ifMatch: saved.etag,
        idempotencyKey: idempotencyKey("connection-validate"),
      });
      setLocalConnections((current) => ({ ...current, [validated.data.connectionId]: validated.data }));
      setSelectedByRequirement((current) => ({
        ...current,
        [editing.requirementId]: validated.data.connectionId,
      }));
      setEditing(null);
    } catch (error) {
      setConfigurationError(error?.code || "unknown");
    } finally {
      setConfiguring(false);
    }
  }

  const mainActions = (
    <>
      <Button variant="secondary" onClick={onClose} disabled={submitting}>{t("actions.cancel")}</Button>
      <Button
        variant="primary"
        icon={<ShieldCheck size={15} />}
        disabled={!bindingsReady || readOnly || submitting}
        title={disabledReason || undefined}
        onClick={() => onSubmit(requirementRows.map(({ requirementId, selected }) => ({
          requirementId,
          connectionId: selected.connectionId,
        })))}
        data-testid="loopops.connections.submit-bindings"
      >
        {submitting ? t("connections.submitting") : actionLabel}
      </Button>
    </>
  );

  const configurationActions = (
    <>
      <Button variant="secondary" disabled={configuring} onClick={() => setEditing(null)}>{t("actions.cancel")}</Button>
      <Button
        variant="primary"
        icon={<CheckCircle2 size={15} />}
        disabled={configuring || !form.label.trim() || !form.permissionSummary.trim()}
        title={!form.label.trim() || !form.permissionSummary.trim() ? t("connections.fieldsRequired") : undefined}
        onClick={saveAndValidate}
        data-testid="loopops.connections.save-validate"
      >
        {configuring ? t("connections.validating") : t("connections.saveAndValidate")}
      </Button>
    </>
  );

  return (
    <Dialog
      open={open}
      title={editing ? t("connections.configureTitle") : t("connections.rebindTitle")}
      onClose={submitting || configuring ? undefined : onClose}
      actions={editing ? configurationActions : mainActions}
    >
      <div className="connectionRebinding" data-testid="loopops.connections.rebinding">
        {editing ? (
          <div className="connectionConfigurationForm">
            <div className="connectionCapabilityReadout"><Cable size={16} /><span>{t("connections.capability")}</span><strong>{editing.requirementId}</strong></div>
            <label>
              <span>{t("connections.label")}</span>
              <input value={form.label} disabled={configuring} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} maxLength={200} />
            </label>
            <label>
              <span>{t("connections.permissionSummary")}</span>
              <textarea value={form.permissionSummary} disabled={configuring} onChange={(event) => setForm((current) => ({ ...current, permissionSummary: event.target.value }))} rows={4} maxLength={1000} />
            </label>
            <div className="connectionFormStatus"><span>{t("connections.status")}</span><StatusPill tone="warning">{t("connections.status.needsSetup")}</StatusPill></div>
            <p className="connectionBindingReason">{t("connections.fieldsRequired")}</p>
            {configurationError ? <p className="connectionInlineError" role="alert">{t("connections.configurationFailed")}</p> : null}
          </div>
        ) : (
          <>
            <p className="connectionRebindingIntro">{t("connections.rebindIntro", { action: actionLabel })}</p>
            {connectionsQuery.isError ? (
              <div className="connectionBlockingState" role="alert">
                <p>{t("connections.loadFailed")}</p>
                <Button variant="secondary" onClick={() => connectionsQuery.refetch()}>{t("actions.retry")}</Button>
              </div>
            ) : null}
            {requirementRows.map(({ requirementId, matches, selected }) => (
              <section className="connectionRequirement" key={requirementId}>
                <div className="connectionRequirementHeader"><Cable size={17} /><div><span>{t("connections.capability")}</span><strong>{requirementId}</strong></div></div>
                {matches.length ? (
                  <>
                    <label className="connectionSelectLabel">
                      <span>{t("connections.choose")}</span>
                      <select
                        value={selected?.connectionId || ""}
                        disabled={connectionsQuery.isLoading}
                        onChange={(event) => setSelectedByRequirement((current) => ({
                          ...current,
                          [requirementId]: event.target.value,
                        }))}
                      >
                        <option value="">{t("connections.choosePlaceholder")}</option>
                        {matches.map((connection) => <option key={connection.connectionId} value={connection.connectionId}>{connection.label} - {t(statusKey(connection))}</option>)}
                      </select>
                    </label>
                    {selected ? (
                      <ConnectionSummary
                        connection={selected}
                        t={t}
                        action={!readOnly && !isReady(selected) ? (
                          <Button variant="secondary" icon={<Settings2 size={15} />} onClick={() => openConfiguration(requirementId, selected)}>{t("connections.finishSetup")}</Button>
                        ) : null}
                      />
                    ) : null}
                  </>
                ) : connectionsQuery.isLoading ? <p>{t("connections.loading")}</p> : (
                  <div className="connectionBlockingState">
                    <p>{t("connections.missing")}</p>
                    {readOnly ? (
                      <Button variant="secondary" onClick={onRequestAccess}>{t("permissions.requestAccess")}</Button>
                    ) : (
                      <Button variant="secondary" icon={<Plus size={15} />} onClick={() => openConfiguration(requirementId)}>{t("connections.create")}</Button>
                    )}
                  </div>
                )}
              </section>
            ))}
            {errorCode ? <p className="connectionInlineError" role="status">{t(`connections.error.${errorCode}`)}</p> : null}
            {disabledReason ? <p className="connectionBindingReason">{disabledReason}</p> : null}
          </>
        )}
      </div>
    </Dialog>
  );
}
