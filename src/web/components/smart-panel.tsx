import type { SmartDisk, SmartHistoryRow, SmartStats } from "../../shared/types";
import { useSmartHistory } from "../lib/use-smart-history";
import { Panel } from "./panel";
import { Sparkline } from "./sparkline";

const DAY_SEC = 86_400;

/** "36°C · 12,345 h on · 3 reallocated" for whatever the disk reports; nonzero error counts are colored. */
function Facts({ disk }: { disk: SmartDisk }) {
  const parts = [
    disk.temperatureC != null ? `${disk.temperatureC}°C` : null,
    disk.powerOnHours != null ? `${disk.powerOnHours.toLocaleString()} h on` : null,
  ].filter(Boolean);
  // NVMe has no pending-sector count; its error counter is media errors.
  const errorLabel = disk.pending == null ? "media errors" : "reallocated";
  return (
    <span className="smart-facts muted small">
      {parts.join(" · ")}
      {disk.reallocated != null && (
        <span className={disk.reallocated > 0 ? "level-warn" : ""}>
          {parts.length ? " · " : ""}
          {disk.reallocated} {errorLabel}
        </span>
      )}
      {disk.pending != null && disk.pending > 0 && <span className="level-crit"> · {disk.pending} pending</span>}
    </span>
  );
}

/** Temperature and wear over the recorded runs; needs two points to draw a line. */
function History({ rows }: { rows: SmartHistoryRow[] }) {
  const series = (pick: (row: SmartHistoryRow) => number | null | undefined) => rows.map((row) => pick(row) ?? null);
  const temperature = series((row) => row.temperatureC);
  const wear = series((row) => row.wearPercent);
  const drawable = (values: (number | null)[]) => values.filter((value) => value !== null).length >= 2;
  if (!drawable(temperature) && !drawable(wear)) return null;
  return (
    <div className="smart-graphs">
      {drawable(temperature) && (
        <Sparkline values={temperature} capacity={temperature.length} stepSec={DAY_SEC} format={(value) => `${Math.round(value)}°C`} height={36} label={`${rows[0]?.device} temperature`} />
      )}
      {drawable(wear) && (
        <Sparkline values={wear} capacity={wear.length} stepSec={DAY_SEC} format={(value) => `${Math.round(value)}% wear`} height={36} label={`${rows[0]?.device} wear`} />
      )}
    </div>
  );
}

export function SmartPanel({ smart }: { smart: SmartStats }) {
  const history = useSmartHistory();
  const failing = smart.disks.filter((disk) => disk.health === "failed").length;
  const unknown = smart.disks.filter((disk) => disk.health === "unknown").length;

  return (
    <Panel
      title="disk health"
      area="smart"
      meta={
        failing ? (
          <span className="level-crit">{failing} failed</span>
        ) : unknown ? (
          <span className="level-warn">{unknown} unknown</span>
        ) : smart.disks.length ? (
          <span className="level-ok">{smart.disks.length} ok</span>
        ) : (
          <span className="faint">not checked</span>
        )
      }
    >
      {smart.disks.length === 0 ? (
        <p className="empty">smart data not available</p>
      ) : (
        <ul className="list smart">
          {smart.disks.map((disk) => (
            <li key={disk.device}>
              <span className="mono">{disk.device}</span>
              <span className={disk.health === "passed" ? "level-ok" : disk.health === "failed" ? "level-crit" : "level-warn"}>
                {disk.health}
              </span>
              <span className="num">{disk.wearPercent !== null ? `${disk.wearPercent}% wear` : "—"}</span>
              <Facts disk={disk} />
              <History rows={history.filter((row) => row.device === disk.device)} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
