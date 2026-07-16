export function Section({ title, caption, actions, children, className = "", ...props }) {
  return (
    <section className={`section ${className}`.trim()} {...props}>
      <header className="sectionHeader">
        <div>
          <h2>{title}</h2>
          {caption ? <p>{caption}</p> : null}
        </div>
        {actions ? <div className="sectionActions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
