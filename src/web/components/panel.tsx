import type { CSSProperties, ReactNode } from "react";
import { navigate } from "../lib/router";

interface PanelProps {
  title: ReactNode;
  meta?: ReactNode;
  /** Right-aligned header slot for links, tabs and buttons. */
  actions?: ReactNode;
  /** Makes the title a link. */
  href?: string;
  /** Anchor for tile jumps and deep links. */
  id?: string;
  /** Columns of the 12-column grid. On medium screens 6 becomes half width and everything else full width. */
  span?: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12;
  className?: string;
  /** Body without padding (tables, lists that run edge to edge). */
  flush?: boolean;
  children: ReactNode;
  label?: string;
}

/** A box: 1 px edge, 36 px header with the title and its meta, body that fills the row's height. */
export function Panel({ title, meta, actions, href, id, span = 12, className, flush, children, label }: PanelProps) {
  const spanMedium = span <= 6 && span >= 5 ? 3 : 6;
  const style = { "--span": span, "--span-m": spanMedium } as CSSProperties;
  const internal = href?.startsWith("/");
  return (
    <section id={id} className={`box${className ? ` ${className}` : ""}`} style={style} aria-label={label ?? (typeof title === "string" ? title : undefined)}>
      <header className="box-header">
        <h2 className="box-title">
          <span className="box-mark" aria-hidden="true" />
          {href ? (
            <a href={href} onClick={internal ? navigate : undefined} target={internal ? undefined : "_blank"} rel={internal ? undefined : "noreferrer"}>
              {title} <span className="arrow">{internal ? "→" : "↗"}</span>
            </a>
          ) : (
            title
          )}
        </h2>
        {meta !== undefined && <span className="box-meta">{meta}</span>}
        {actions && <span className="box-actions">{actions}</span>}
      </header>
      <div className={`box-body${flush ? " is-flush" : ""}`}>{children}</div>
    </section>
  );
}

/** A footnote pinned to the bottom of a box. */
export function BoxFoot({ children }: { children: ReactNode }) {
  return <div className="box-foot">{children}</div>;
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span>{children}</span>
      {action && <span>{action}</span>}
    </div>
  );
}

/** A subhead with a rule after it: `volumes ─────`. */
export function Subhead({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <h3 className="subhead">
      <span>{children}</span>
      {aside && <span className="subhead-aside">{aside}</span>}
    </h3>
  );
}

/** Text link: internal ones route in-app, external ones open a new tab with ↗. */
export function Link({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const internal = href.startsWith("/");
  return (
    <a
      className={`link${className ? ` ${className}` : ""}`}
      href={href}
      onClick={internal ? navigate : undefined}
      target={internal ? undefined : "_blank"}
      rel={internal ? undefined : "noreferrer"}
    >
      {children}
      {!internal && <span className="arrow">↗</span>}
    </a>
  );
}
