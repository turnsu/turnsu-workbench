import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Cpu } from "lucide-react";

import { modelPickerOptions } from "../../state/models/index.js";

function optionGroup(option) {
  return option.capabilities?.includes("image_generation") ? "image" : "text";
}

function capabilitySummary(option, labels = {}) {
  return (option.capabilities || [])
    .map((capability) => labels[capability] || capability.replaceAll("_", " "))
    .join(" · ");
}

export function ModelSwitch({
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
  groupLabels = {},
  getOptionGroup = optionGroup,
  capabilityLabels = {},
  unavailableReason = "",
  testId = "loopops.model-switch",
}) {
  const root = useRef(null);
  const trigger = useRef(null);
  const [open, setOpen] = useState(false);
  const options = useMemo(() => {
    const resolved = suppliedOptions || modelPickerOptions(profiles, {
      requiredCapabilities,
      selectionKind,
      selectedValue: value,
    });
    if (!value || resolved.some((option) => option.value === value)) return resolved;
    return [{ value, label: value, providerLabel: "", disabled: true, historical: true, capabilities: [] }, ...resolved];
  }, [suppliedOptions, profiles, requiredCapabilities.join("\u0000"), selectionKind, value]);
  const selected = options.find((option) => option.value === value);
  const readyOptions = options.filter((option) => !option.disabled);
  const available = allowInherit || readyOptions.length > 0;
  const grouped = options.reduce((result, option) => {
    const group = getOptionGroup(option);
    result[group] ||= [];
    result[group].push(option);
    return result;
  }, {});

  useEffect(() => {
    if (!open) return undefined;
    function closeWhenOutside(event) {
      if (!root.current?.contains(event.target)) setOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") {
        setOpen(false);
        queueMicrotask(() => trigger.current?.focus());
      }
    }
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function choose(next) {
    onChange?.(next);
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  }

  function focusOption(edge = "selected") {
    queueMicrotask(() => {
      const optionButtons = [...(root.current?.querySelectorAll('[role="option"]:not(:disabled)') || [])];
      const selectedButton = optionButtons.find((button) => button.getAttribute("aria-selected") === "true");
      const target = edge === "last"
        ? optionButtons.at(-1)
        : edge === "first"
          ? optionButtons[0]
          : selectedButton || optionButtons[0];
      target?.focus();
    });
  }

  function openFromKeyboard(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setOpen(true);
    focusOption(event.key === "ArrowUp" || event.key === "End" ? "last" : "selected");
  }

  function moveOptionFocus(event) {
    const optionButtons = [...(root.current?.querySelectorAll('[role="option"]:not(:disabled)') || [])];
    const currentIndex = optionButtons.indexOf(document.activeElement);
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      optionButtons[event.key === "Home" ? 0 : optionButtons.length - 1]?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp"].includes(event.key) || !optionButtons.length) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + delta + optionButtons.length) % optionButtons.length;
    optionButtons[nextIndex]?.focus();
  }

  const selectedLabel = loading ? "…" : !value && allowInherit ? inheritLabel : selected?.label || unavailableLabel;
  return (
    <div className="modelSwitch" ref={root} data-testid={testId}>
      <button
        ref={trigger}
        type="button"
        className="modelSwitchTrigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || loading || !available}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={openFromKeyboard}
        data-selection-kind={selectionKind}
        data-capabilities={requiredCapabilities.join(",")}
      >
        <Cpu size={14} aria-hidden="true" />
        <span>{selectedLabel}</span>
        {selected?.revisionNumber ? <small>r{selected.revisionNumber}</small> : null}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="modelSwitchPopover" role="listbox" aria-label={label} onKeyDown={moveOptionFocus}>
          {allowInherit ? (
            <button type="button" role="option" aria-selected={!value} className={!value ? "selected" : ""} onClick={() => choose("")}>
              <span>{inheritLabel}</span>
            </button>
          ) : null}
          {Object.entries(grouped).map(([group, groupOptions]) => (
            <section key={group}>
              <h4>{groupLabels[group] || group}</h4>
              {groupOptions.map((option) => (
                <button
                  type="button"
                  role="option"
                  key={`${option.value}:${option.historical ? "historical" : "current"}`}
                  aria-selected={option.value === value}
                  className={option.value === value ? "selected" : ""}
                  disabled={option.disabled}
                  onClick={() => choose(option.value)}
                >
                  <span>
                    <strong>{option.label}</strong>
                    <small>{capabilitySummary(option, capabilityLabels) || getOptionGroup(option)}{option.revisionNumber ? ` · r${option.revisionNumber}` : ""}</small>
                    {option.disabled && option.readinessReason ? <small className="modelSwitchReason">{option.readinessReason}</small> : null}
                  </span>
                  {option.historical ? <em>{historicalLabel}</em> : null}
                </button>
              ))}
            </section>
          ))}
          {hint ? <p>{hint}</p> : null}
        </div>
      ) : null}
      {!loading && !available && unavailableReason ? (
        <span className="modelSwitchFeedback" role="status">{unavailableReason}</span>
      ) : null}
    </div>
  );
}
