import { Button } from "./Button.jsx";

export function EmptyState({ title, body, actionLabel, onAction, testId }) {
  return (
    <section className="emptyState" data-testid={testId}>
      <h2>{title}</h2>
      <p>{body}</p>
      {actionLabel ? (
        <Button variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </section>
  );
}
