import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";

import { Theme } from "@astryxdesign/core/theme";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { IconButton as AstryxIconButton } from "@astryxdesign/core/IconButton";
import { Badge as AstryxBadge } from "@astryxdesign/core/Badge";
import {
  SegmentedControl as AstryxSegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { TextInput as AstryxTextInput } from "@astryxdesign/core/TextInput";
import { TextArea as AstryxTextArea } from "@astryxdesign/core/TextArea";
import { neutralTheme } from "@astryxdesign/theme-neutral";
import { useId, useLayoutEffect, useRef } from "react";

const toneToBadge = {
  neutral: "neutral",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "error",
  error: "error",
};

const buttonVariants = {
  primary: "primary",
  secondary: "secondary",
  ghost: "ghost",
  plain: "ghost",
  destructive: "destructive",
  danger: "destructive",
};

export function LoopTheme({ mode = "light", children }) {
  return (
    <Theme theme={neutralTheme} mode={mode}>
      {children}
    </Theme>
  );
}

export function Button({
  children,
  label,
  variant = "secondary",
  disabled,
  size = "md",
  className = "",
  ...props
}) {
  const visibleLabel =
    label || (typeof children === "string" ? children : props["aria-label"] || "Action");

  return (
    <AstryxButton
      {...props}
      className={`loopButton loopButton-${variant} ${className}`.trim()}
      label={visibleLabel}
      variant={buttonVariants[variant] || "secondary"}
      isDisabled={disabled}
      disabled={disabled}
      aria-disabled={disabled ? "true" : undefined}
      size={size}
    >
      {children || visibleLabel}
    </AstryxButton>
  );
}

export function IconButton({ label, icon, variant = "ghost", disabled, size = "md", ...props }) {
  return (
    <AstryxIconButton
      {...props}
      label={label}
      icon={icon}
      variant={buttonVariants[variant] || "ghost"}
      isDisabled={disabled}
      disabled={disabled}
      aria-disabled={disabled ? "true" : undefined}
      size={size}
    />
  );
}

export function Badge({ children, tone = "neutral", label, ...props }) {
  return <AstryxBadge {...props} variant={toneToBadge[tone] || "neutral"} label={label || children} />;
}

export function SegmentedControl({ label, value, onChange, options, size = "sm", layout = "hug", ...props }) {
  return (
    <div
      {...props}
      className={`segmentedControl segmented-${size} segmented-${layout}`}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          disabled={option.disabled}
          data-testid={option.testId}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function TextInput({ label, onChange, hiddenLabel = true, ...props }) {
  return (
    <AstryxTextInput
      {...props}
      label={label}
      isLabelHidden={hiddenLabel}
      onChange={(value, event) => onChange?.(value, event)}
    />
  );
}

export function TextArea({ label, onChange, hiddenLabel = true, ...props }) {
  return (
    <AstryxTextArea
      {...props}
      label={label}
      isLabelHidden={hiddenLabel}
      onChange={(value, event) => onChange?.(value, event)}
    />
  );
}

export function DataTable({
  columns,
  rows,
  getRowId,
  selectedId,
  onRowClick,
  renderCell,
  className = "",
  ...props
}) {
  return (
    <div className={`dataTableWrap ${className}`} {...props}>
      <div className="dataTable" role="table">
        <div
          className="dataRow dataHeaderRow"
          role="row"
          style={{ gridTemplateColumns: columns.map((column) => column.width || "1fr").join(" ") }}
        >
          {columns.map((column) => (
            <div className="dataCell dataHeaderCell" role="columnheader" key={column.key}>
              {column.label}
            </div>
          ))}
        </div>
        {rows.map((row) => {
          const rowId = getRowId(row);
          return (
            <div
              key={rowId}
              role="row"
              className={`dataRow ${selectedId === rowId ? "selected" : ""}`}
              onClick={() => onRowClick?.(row)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onRowClick?.(row);
                }
              }}
              tabIndex={onRowClick ? 0 : undefined}
              aria-selected={selectedId === rowId}
              style={{ gridTemplateColumns: columns.map((column) => column.width || "1fr").join(" ") }}
              data-row-id={rowId}
            >
              {columns.map((column) => (
                <div className="dataCell" role="cell" key={column.key}>
                  {renderCell ? renderCell(row, column.key) : row[column.key]}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SideNav({ children, ...props }) {
  return <nav {...props}>{children}</nav>;
}

export function Tabs({ tabs, value, onChange, label = "Tabs" }) {
  return <SegmentedControl label={label} value={value} onChange={onChange} options={tabs} />;
}

export function ChatComposer({ value, onChange, onSend, placeholder, label, testId }) {
  return (
    <div className="chatComposer">
      <TextArea
        label={label}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        rows={3}
        data-testid={testId ? `${testId}.input` : undefined}
        aria-label={label}
      />
      <Button variant="primary" onClick={onSend} data-testid={testId}>
        Send message
      </Button>
    </div>
  );
}

export function Toast({ children, actionLabel, onAction, onDismiss }) {
  return (
    <div className="toastItem" role="status">
      <span>{children}</span>
      {actionLabel ? (
        <Button variant="ghost" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
      <button className="toastClose" onClick={onDismiss} aria-label="Dismiss toast">
        ×
      </button>
    </div>
  );
}

const dialogFocusable = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function visibleDialogControls(root) {
  return [...(root?.querySelectorAll(dialogFocusable) || [])].filter((element) => {
    const style = globalThis.getComputedStyle?.(element);
    const rect = element.getBoundingClientRect();
    return style?.display !== "none" && style?.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  });
}

export function Dialog({ open, title, children, actions, onClose, initialFocusSelector, returnFocusSelector }) {
  const layerRef = useRef(null);
  const openerRef = useRef(null);
  const titleId = useId();

  useLayoutEffect(() => {
    if (!open) return undefined;
    openerRef.current = document.activeElement;
    const preferred = initialFocusSelector
      ? layerRef.current?.querySelector(initialFocusSelector)
      : null;
    let frame;
    if (preferred) preferred.focus({ preventScroll: true });
    else {
      frame = globalThis.requestAnimationFrame?.(() => {
        visibleDialogControls(layerRef.current)[0]?.focus({ preventScroll: true });
      });
    }
    return () => {
      if (frame !== undefined) globalThis.cancelAnimationFrame?.(frame);
      const recorded = openerRef.current;
      const opener = recorded?.isConnected && recorded !== document.body
        ? recorded
        : returnFocusSelector ? document.querySelector(returnFocusSelector) : null;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      openerRef.current = null;
    };
  }, [open, initialFocusSelector, returnFocusSelector]);

  function handleKeyDown(event) {
    if (event.key === "Escape" && onClose) {
      event.preventDefault();
      event.stopPropagation();
      const recorded = openerRef.current;
      const opener = recorded?.isConnected && recorded !== document.body
        ? recorded
        : returnFocusSelector ? document.querySelector(returnFocusSelector) : null;
      onClose();
      globalThis.queueMicrotask?.(() => {
        if (opener?.isConnected) opener.focus({ preventScroll: true });
      });
      return;
    }
    if (event.key !== "Tab") return;
    const controls = visibleDialogControls(layerRef.current);
    if (!controls.length) {
      event.preventDefault();
      layerRef.current?.focus();
      return;
    }
    const first = controls[0];
    const last = controls.at(-1);
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !layerRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;
  return (
    <div
      ref={layerRef}
      className="dialogLayer"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <section className="dialogPanel">
        <h2 id={titleId}>{title}</h2>
        {children}
        {actions ? <div className="buttonRow">{actions}</div> : null}
      </section>
    </div>
  );
}
