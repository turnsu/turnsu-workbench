import "./turnsu-brand.css";

// Reuse the approved cat-and-t paths from the existing Turnsu website.
const ASSETS = "/brand/turnsu";

export function TurnsuMark({ size = 24, className = "" }) {
  const asset = size <= 20 ? "turnsu-icon-32.png" : "turnsu-symbol.svg";
  return <img className={`turnsuMark ${className}`} src={`${ASSETS}/${asset}`} width={size} height={size} alt="" aria-hidden="true" />;
}

export function TurnsuBrand({ compact = false }) {
  return (
    <span className={`turnsuBrand${compact ? " turnsuBrand-responsive" : ""}`} role="img" aria-label="Turnsu">
      <img className="turnsuWordmark turnsuWordmark-light" src={`${ASSETS}/turnsu-lockup.svg`} width="150" height="40" alt="" />
      <img className="turnsuWordmark turnsuWordmark-dark" src={`${ASSETS}/turnsu-lockup-light.svg`} width="150" height="40" alt="" />
      {compact ? <TurnsuMark size={40} className="turnsuCompactMark" /> : null}
    </span>
  );
}
