import { Fragment, useState, type ReactNode } from "react";
import type { LogEntry } from "../../shared/types";
import { CopyValue } from "./copy-value";

export const PRIORITY_LETTER = ["E", "E", "E", "E", "W", "N", "I", "D"];
const PRIORITY_NAME = ["emerg", "alert", "crit", "error", "warning", "notice", "info", "debug"];

export function logTime(at: number, withDate = true): string {
  const date = new Date(at / 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  return withDate ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}` : time;
}

/** Wraps every case-insensitive match of `query` in <mark>. */
export function highlight(text: string, query: string | null): ReactNode {
  if (!query) return text;
  let pattern: RegExp;
  try {
    pattern = new RegExp(`(${query})`, "gi");
  } catch {
    return text;
  }
  const parts = text.split(pattern);
  if (parts.length === 1) return text;
  return parts.map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : <Fragment key={index}>{part}</Fragment>));
}

interface LogRowProps {
  entry: LogEntry;
  query?: string | null;
  onSource?: (source: string) => void;
  onContext?: (entry: LogEntry) => void;
  /** Time only, no date (a job run's own log). */
  short?: boolean;
}

/** time · priority letter · source · message; Enter or click opens the full message and every journal field. */
export function LogRow({ entry, query = null, onSource, onContext, short }: LogRowProps) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<Record<string, string> | null>(entry.fields ?? null);
  const tone = entry.priority <= 3 ? "level-crit" : entry.priority === 4 ? "level-warn" : "";

  async function toggle(): Promise<void> {
    setOpen(!open);
    if (!open && !fields) {
      const response = await fetch(`/api/logs/entry?cursor=${encodeURIComponent(entry.cursor)}`).catch(() => null);
      const full = response?.ok ? ((await response.json()) as LogEntry | null) : null;
      setFields(full?.fields ?? {});
    }
  }

  return (
    <li className={`log-row${open ? " is-open" : ""}${entry.priority <= 3 ? " is-error" : ""}`}>
      <div
        className="log-line"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button, a")) return;
          void toggle();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void toggle();
          }
        }}
      >
        <span className="log-time">{logTime(entry.at, !short)}</span>
        <span className={`log-prio ${tone}`} title={PRIORITY_NAME[entry.priority]}>
          {PRIORITY_LETTER[entry.priority] ?? "?"}
        </span>
        {onSource ? (
          <button type="button" className="log-source" title={`only ${entry.source}`} onClick={() => onSource(entry.source)}>
            {entry.source}
          </button>
        ) : (
          <span className="log-source">{entry.source}</span>
        )}
        <span className="log-message">{highlight(entry.message, query)}</span>
        <span className="log-toggle" aria-hidden="true">
          {open ? "⌃" : "⌄"}
        </span>
      </div>
      {open && (
        <div className="log-detail">
          <pre className="log-full">{highlight(entry.message, query)}</pre>
          {fields === null ? (
            <span className="muted small">loading fields…</span>
          ) : (
            <dl className="log-fields">
              {Object.entries(fields)
                .filter(([key]) => !key.startsWith("__") || key === "__CURSOR")
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{key === "__CURSOR" ? <CopyValue value={value} display={`${value.slice(0, 24)}…`} /> : value}</dd>
                  </div>
                ))}
            </dl>
          )}
          {onContext && (
            <button type="button" className="button button-quiet" onClick={() => onContext(entry)}>
              show context
            </button>
          )}
        </div>
      )}
    </li>
  );
}
