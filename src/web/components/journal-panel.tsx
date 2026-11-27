import type { JournalStats } from "../../shared/types";
import { bytes } from "../lib/format";
import { Panel } from "./panel";

/** How much the system writes to its log (systemd journal: kernel, docker, every service), and who. */
export function JournalPanel({ journal }: { journal: JournalStats }) {
  const lastHour = journal.hours.at(-1)?.lines ?? 0;
  const top = Math.max(1, ...journal.hours.map((hour) => hour.lines));
  const errors = journal.hours.reduce((sum, hour) => sum + hour.errors, 0);

  return (
    <Panel
      title="system log"
      area="logs"
      meta={
        journal.at === null ? (
          <span className="faint">not collected</span>
        ) : (
          <span>
            {Math.round(lastHour / 60)} lines/min
            {journal.diskBytes !== null && (
              <span className="muted"> · {bytes(journal.diskBytes)}{journal.capBytes ? ` / ${bytes(journal.capBytes)}` : ""}</span>
            )}
          </span>
        )
      }
    >
      {journal.hours.length === 0 ? (
        <p className="empty">journal summary not available</p>
      ) : (
        <>
          <svg className="bars tall" viewBox="0 0 24 40" preserveAspectRatio="none" role="img" aria-label="log lines per hour, last 24 hours">
            {journal.hours.map((hour, index) => (
              <g key={hour.at}>
                <rect x={index + 0.15} width={0.7} y={40 - (40 * hour.lines) / top} height={(40 * hour.lines) / top} />
                {hour.errors > 0 && <rect className="crit" x={index + 0.15} width={0.7} y={40 - (40 * hour.errors) / top} height={Math.max(0.6, (40 * hour.errors) / top)} />}
              </g>
            ))}
          </svg>
          <p className="muted small">
            last 24 h · {journal.hours.reduce((sum, hour) => sum + hour.lines, 0).toLocaleString()} lines ·{" "}
            <span className={errors ? "level-crit" : ""}>{errors.toLocaleString()} errors</span>
          </p>
          <h3 className="subhead">loudest in the last hour</h3>
          <ul className="list journal">
            {journal.top.map((source) => (
              <li key={source.source}>
                <span className="mono">{source.source}</span>
                <span className="num">{source.lines.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
