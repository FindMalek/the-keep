import { Fragment, useEffect, useState, type ReactNode } from "react";
import { navigate } from "../lib/router";
import { ThemeToggle } from "./status-bar";

export interface NavItem {
  path: string;
  /** Items with the same group sit under one heading; a new group starts a new heading. */
  group: string;
  label: string;
  icon: ReactNode;
  /** Count of things needing attention, shown in red. */
  alerts?: number;
  /** In the phone's bottom bar; the rest go under "more". */
  primary?: boolean;
}

const icon = (children: ReactNode) => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    {children}
  </svg>
);

export const ICONS = {
  home: icon(
    <>
      <rect x="0.5" y="0.5" width="4.5" height="4.5" />
      <rect x="7" y="0.5" width="4.5" height="4.5" />
      <rect x="0.5" y="7" width="4.5" height="4.5" />
      <rect x="7" y="7" width="4.5" height="4.5" />
    </>,
  ),
  jobs: icon(
    <>
      <rect x="0.5" y="0.5" width="11" height="11" />
      <path d="M6 2.5V6h3" />
    </>,
  ),
  activity: icon(
    <>
      <rect x="0.5" y="0.5" width="11" height="11" />
      <path d="M2.5 6.5h2l1.5-3 1.5 5 1-2h1" />
    </>,
  ),
  uptime: icon(
    <>
      <rect x="0.5" y="6.5" width="2" height="5" />
      <rect x="3.5" y="4.5" width="2" height="7" />
      <rect x="6.5" y="2.5" width="2" height="9" />
      <rect x="9.5" y="0.5" width="2" height="11" />
    </>,
  ),
  media: icon(
    <>
      <path d="M4.5 9.5V2l6-1.5V8" />
      <rect x="0.5" y="8.5" width="4" height="3" />
      <rect x="6.5" y="7" width="4" height="3" />
    </>,
  ),
  sessions: icon(
    <>
      <rect x="0.5" y="0.5" width="11" height="8" />
      <path d="M3 3.5h6M3 6h4M2.5 11.5l2-3" />
    </>,
  ),
  apps: icon(
    <>
      <rect x="0.5" y="0.5" width="11" height="3" />
      <rect x="0.5" y="4.5" width="11" height="3" />
      <rect x="0.5" y="8.5" width="11" height="3" />
    </>,
  ),
  logs: icon(
    <>
      <path d="M0.5 1.5h2M4 1.5h7.5M0.5 4.5h2M4 4.5h5M0.5 7.5h2M4 7.5h7M0.5 10.5h2M4 10.5h4" />
    </>,
  ),
  buckets: icon(
    <>
      <path d="M1 2.5h10l-1.2 9H2.2z" />
      <path d="M0.5 2.5h11" />
      <path d="M4 5.5h4" />
    </>,
  ),
  more: icon(
    <>
      <rect x="0.5" y="5" width="2" height="2" />
      <rect x="5" y="5" width="2" height="2" />
      <rect x="9.5" y="5" width="2" height="2" />
    </>,
  ),
};

function Item({ item, path, onClick }: { item: NavItem; path: string; onClick?: () => void }) {
  return (
    <a
      href={item.path}
      className="nav-item"
      aria-current={item.path === path ? "page" : undefined}
      onClick={(event) => {
        navigate(event);
        onClick?.();
      }}
    >
      <span className="nav-icon">{item.icon}</span>
      <span className="nav-label">{item.label}</span>
      {item.alerts ? <span className="nav-alert">{item.alerts}</span> : null}
    </a>
  );
}

export function Sidebar({ items, path }: { items: NavItem[]; path: string }) {
  return (
    <nav className="sidebar" aria-label="pages">
      {items.map((item, index) => (
        <Fragment key={item.path}>
          {item.group !== items[index - 1]?.group && <span className="sidebar-label">{item.group}</span>}
          <Item item={item} path={path} />
        </Fragment>
      ))}
    </nav>
  );
}

/** Phone: five slots, the last opens a sheet with everything else and the theme toggle. */
export function BottomNav({ items, path }: { items: NavItem[]; path: string }) {
  const [open, setOpen] = useState(false);
  const primary = items.filter((item) => item.primary);
  const rest = items.filter((item) => !item.primary);
  const restActive = rest.some((item) => item.path === path);
  const restAlerts = rest.reduce((sum, item) => sum + (item.alerts ?? 0), 0);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <nav className="bottom-nav" aria-label="pages">
        {primary.map((item) => (
          <Item key={item.path} item={item} path={path} onClick={() => setOpen(false)} />
        ))}
        <button type="button" className="nav-item" aria-current={restActive ? "page" : undefined} aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="nav-icon">{ICONS.more}</span>
          <span className="nav-label">more</span>
          {restAlerts ? <span className="nav-alert">{restAlerts}</span> : null}
        </button>
      </nav>
      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet" role="dialog" aria-label="more pages" onClick={(event) => event.stopPropagation()}>
            {rest.map((item) => (
              <Item key={item.path} item={item} path={path} onClick={() => setOpen(false)} />
            ))}
            <div className="sheet-row">
              <ThemeToggle />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
