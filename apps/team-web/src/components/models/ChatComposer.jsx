import { Send } from "lucide-react";

import { Button, TextArea } from "../../design-system/index.jsx";

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  busy = false,
  label = "Message",
  placeholder = "Describe what you need",
  submitLabel = "Send",
  busyLabel = "Sending…",
  testId = "loopops.chat-composer",
}) {
  const ready = Boolean(String(value || "").trim()) && !disabled && !busy;
  return (
    <form
      className="modelComposer chatModelComposer"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSubmit?.();
      }}
      aria-busy={busy ? "true" : undefined}
      data-testid={testId}
    >
      <TextArea
        label={label}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        rows={4}
        width="100%"
        disabled={disabled || busy}
        data-testid={`${testId}.input`}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && ready) {
            event.preventDefault();
            onSubmit?.();
          }
        }}
      />
      <div className="modelComposerActions">
        <small>⌘ Enter</small>
        <Button type="submit" variant="primary" icon={<Send size={15} />} disabled={!ready} data-testid={`${testId}.submit`}>
          {busy ? busyLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
