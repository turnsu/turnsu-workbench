import { useState } from "react";

const REBIND_CODES = new Set([
  "connection_rebind_required",
  "connection_not_ready",
  "connection_binding_invalid",
]);

function requirementFromError(error) {
  const requirementId = String(error?.details?.requirementId || "").trim();
  if (!REBIND_CODES.has(error?.code) || !requirementId) return null;
  return { requirementId };
}

export function useConnectionRebindingAction({ readOnly, onError }) {
  const [pending, setPending] = useState(null);
  const [busyAction, setBusyAction] = useState("");
  const [sheetError, setSheetError] = useState("");

  async function complete(action, connectionBindings) {
    setBusyAction(action.actionKey);
    setSheetError("");
    try {
      const result = await action.execute(connectionBindings);
      setPending(null);
      await action.onSuccess?.(result);
      return result;
    } catch (error) {
      const requirement = requirementFromError(error);
      if (requirement) {
        setPending((current) => ({
          ...action,
          requirements: [
            ...(current?.requirements || action.requirements || []),
            requirement,
          ].filter((item, index, items) => (
            items.findIndex((candidate) => candidate.requirementId === item.requirementId) === index
          )),
        }));
        setSheetError(error.code);
        return null;
      }
      onError?.(error);
      return null;
    } finally {
      setBusyAction("");
    }
  }

  function run(action) {
    if (readOnly || busyAction) return Promise.resolve(null);
    const requirements = action.requirements || [];
    if (requirements.length > 0) {
      setPending({ ...action, requirements });
      setSheetError("");
      return Promise.resolve(null);
    }
    return complete({ ...action, requirements }, []);
  }

  return {
    busyAction,
    run,
    sheetProps: {
      open: Boolean(pending),
      actionLabel: pending?.actionLabel || "",
      requirements: pending?.requirements || [],
      submitting: Boolean(pending && busyAction),
      errorCode: sheetError,
      onClose() {
        if (!busyAction) {
          setPending(null);
          setSheetError("");
        }
      },
      onSubmit(connectionBindings) {
        return pending ? complete(pending, connectionBindings) : Promise.resolve(null);
      },
    },
  };
}
