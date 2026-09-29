import { Button } from "./Button.jsx";
import { StatusPill } from "./StatusPill.jsx";

export function ObjectHeader({ mark, title, kicker, description, meta = [], primaryLabel, primaryDisabled = false, onPrimary, secondary }) {
  return (
    <section className="objectHeader">
      <div className="objectMark" aria-hidden="true">
        {mark}
      </div>
      <div className="objectHeaderBody">
        <div className="objectKicker">{kicker}</div>
        <div className="objectHeaderTitle">
          <h2>{title}</h2>
          {secondary}
        </div>
        {description ? <p>{description}</p> : null}
        <div className="objectMeta">
          {meta.map((item) => (
            <StatusPill key={`${item.label}-${item.value}`} tone={item.tone}>
              {item.label ? `${item.label}: ${item.value}` : item.value}
            </StatusPill>
          ))}
        </div>
      </div>
      {primaryLabel ? (
        <Button variant="primary" disabled={primaryDisabled} onClick={onPrimary}>
          {primaryLabel}
        </Button>
      ) : null}
    </section>
  );
}
