import { useMemo } from "react";

import { modelPickerOptions } from "../../state/models/index.js";

export function ModelPicker({
  profiles = [],
  options: suppliedOptions,
  requiredCapabilities = [],
  selectionKind = "revision",
  value = "",
  onChange,
  label = "Model",
  hint = "",
  inheritLabel = "Use workspace default",
  allowInherit = false,
  disabled = false,
  loading = false,
  unavailableLabel = "Unavailable",
  historicalLabel = "Historical selection",
  testId = "loopops.model-picker",
}) {
  const options = useMemo(() => {
    const resolved = suppliedOptions || modelPickerOptions(profiles, {
      requiredCapabilities,
      selectionKind,
      selectedValue: value,
    });
    if (!value || resolved.some((option) => option.value === value)) return resolved;
    return [{
      value,
      label: value,
      providerLabel: "",
      disabled: true,
      historical: true,
    }, ...resolved];
  }, [suppliedOptions, profiles, requiredCapabilities.join("\u0000"), selectionKind, value]);
  const selected = options.find((option) => option.value === value);
  const readyOptions = options.filter((option) => !option.disabled);

  return (
    <label className="modelPicker" data-testid={testId}>
      <span className="modelPickerLabel">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        disabled={disabled || loading || (!allowInherit && !readyOptions.length)}
        aria-describedby={hint ? `${testId}-hint` : undefined}
        data-selection-kind={selectionKind}
        data-capabilities={requiredCapabilities.join(",")}
      >
        {allowInherit ? <option value="">{inheritLabel}</option> : null}
        {!allowInherit && !value ? <option value="" disabled>{loading ? "…" : unavailableLabel}</option> : null}
        {options.map((option) => (
          <option key={`${option.value}:${option.historical ? "history" : "current"}`} value={option.value} disabled={option.disabled}>
            {option.label}
            {option.providerLabel ? ` · ${option.providerLabel}` : ""}
            {option.revisionNumber ? ` · r${option.revisionNumber}` : ""}
            {option.historical ? ` · ${historicalLabel}` : option.disabled ? ` · ${unavailableLabel}` : ""}
          </option>
        ))}
      </select>
      {hint ? <small id={`${testId}-hint`}>{hint}</small> : null}
      {selected?.historical || (selected?.disabled && selected?.value === value) ? (
        <small className="modelPickerHistory" role="status">{historicalLabel}</small>
      ) : null}
    </label>
  );
}
