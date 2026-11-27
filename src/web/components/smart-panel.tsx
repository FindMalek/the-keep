import type { SmartDisk, SmartStats } from "../../shared/types";
import { Panel } from "./panel";

const DAYS = 30;

/** GB written per day over the last 30 days, from the daily totals. */
function dailyWrites(disk: SmartDisk): number[] {
  const points = (disk.history ?? []).filter((point) => point.writtenGB !== null).slice(-(DAYS + 1));
  return points.slice(1).map((point, index) => Math.max(0, point.writtenGB! - points[index]!.writtenGB!));
}

function WriteBars({ values }: { values: number[] }) {
  const top = Math.max(1, ...values);
  return (
    <svg className="bars" viewBox={`0 0 ${DAYS} 20`} preserveAspectRatio="none" role="img" aria-label="GB written per day, last 30 days">
      {values.slice(-DAYS).map((value, index, all) => (
        <rect key={index} x={DAYS - all.length + index + 0.15} width={0.7} y={20 - (20 * value) / top} height={(20 * value) / top} />
      ))}
    </svg>
  );
}

export function SmartPanel({ smart }: { smart: SmartStats }) {
  const failing = smart.disks.filter((disk) => disk.health === "failed" || (disk.badSectors ?? 0) > 0).length;
  const unknown = smart.disks.filter((disk) => disk.health === "unknown").length;

  return (
    <Panel
      title="disk health"
      area="smart"
      meta={
        failing ? (
          <span className="level-crit">{failing} failing</span>
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
          {smart.disks.map((disk) => {
            const writes = dailyWrites(disk);
            const week = writes.slice(-7);
            const perDay = week.length ? week.reduce((sum, value) => sum + value, 0) / week.length : null;
            const left = disk.wearPercent !== null ? 100 - disk.wearPercent : null;
            return (
              <li key={disk.device}>
                <span className="mono">
                  {disk.device.replace("/dev/", "")} <span className="muted">{disk.kind ?? ""}</span>
                </span>
                <span className={disk.health === "passed" && !disk.badSectors ? "level-ok" : disk.health === "failed" || disk.badSectors ? "level-crit" : "level-warn"}>
                  {disk.badSectors ? `${disk.badSectors} bad sectors` : disk.health}
                </span>
                <span className={`num ${left !== null && left < 80 ? "level-warn" : ""}`} title="rated endurance left">
                  {left !== null ? `${left}% life` : disk.asleep ? "asleep" : "—"}
                </span>
                <span className="num muted small">
                  {disk.writtenGB != null ? `${(disk.writtenGB / 1000).toFixed(1)} TB written` : ""}
                  {perDay !== null ? ` · ${Math.round(perDay)} GB/day` : ""}
                  {disk.temperatureC != null ? ` · ${disk.temperatureC} °C` : ""}
                </span>
                {writes.length > 1 && <WriteBars values={writes} />}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
