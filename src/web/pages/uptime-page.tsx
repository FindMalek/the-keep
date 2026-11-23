import { useEffect, useMemo, useState } from "react";
import type { KumaMonitor, RangeHistory, RangeName, UptimeStats } from "../../shared/types";
import { PageHeader, Tabs } from "../components/page-header";
import { Panel } from "../components/panel";
import { StatusSquare, type Status } from "../components/status-square";
import { shortHost } from "../lib/format";
import { clockTime, outages } from "../lib/outages";
import { useRangeHistory } from "../lib/use-range-history";

const RANGES = ["24h", "7d", "30d", "90d", "1y"] as const satisfies readonly RangeName[];
type UptimeRange = (typeof RANGES)[number];
const RANGE_KEY = "keep:uptime-range";
/** How many bars a range is folded into (always whole buckets), and what the column says. */
const BARS: Record<UptimeRange, { count: number; label: string }> = {
  "24h": { count: 48, label: "last 24 hours" },
  "7d": { count: 56, label: "last 7 days" },
  "30d": { count: 30, label: "last 30 days" },
  "90d": { count: 90, label: "last 90 days" },
  "1y": { count: 52, label: "last year" },
};
/** Minutes are only kept for 31 days, so down-times inside a bar can only be listed for recent ones. */
const MINUTES_KEPT_MS = 31 * 86_400_000;
const MINUTES_MAX_SEC = 2 * 3600;

function storedRange(): UptimeRange {
  try {
    const value = localStorage.getItem(RANGE_KEY);
    return (RANGES as readonly (string | null)[]).includes(value) ? (value as UptimeRange) : "24h";
  } catch {
    return "24h";
  }
}

/** Daily and weekly bars are UTC days, so their dates are shown in UTC; shorter bars use the local clock. */
const dateOf = (seconds: number, utc = false): string =>
  new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(utc ? { timeZone: "UTC" } : {}) }).toLowerCase();

/** What a bar covers: clock times within a day, a date for a day, dates for a week. */
function spanLabel(from: number, to: number, barSec: number): string {
  if (barSec >= 7 * 86_400) return `${dateOf(from, true)}–${dateOf(to - 1, true)}`;
  if (barSec >= 86_400) return dateOf(from, true);
  if (barSec > 1800) return `${dateOf(from)} ${clockTime(from)}–${clockTime(to)}`;
  return `${clockTime(from)}–${clockTime(to)}`;
}

function statusOf(monitor: KumaMonitor): Status {
  if (monitor.status === 1) return "ok";
  if (monitor.status === 0) return "down";
  return "warn";
}

function ratio(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1) return "100%";
  return `${(Math.floor(value * 10000) / 100).toFixed(2)}%`;
}

function ratioClass(value: number | null): string {
  if (value === null || value >= 0.999) return "";
  return value >= 0.99 ? "level-warn" : "level-crit";
}

function certClass(days: number | null): string {
  if (days === null) return "";
  if (days < 7) return "level-crit";
  return days < 14 ? "level-warn" : "";
}

/**
 * The range's buckets folded into `count` bars (average of "up", null when there is no data). Bars are aligned to the
 * newest bucket, so any leftover bucket at the old end is the one dropped.
 */
function bars(history: RangeHistory | null, id: string, count: number): { values: (number | null)[]; startSec: number; barSec: number } {
  const buckets = history?.series[`kuma:${id}:up`]?.avg ?? [];
  const size = Math.max(1, Math.floor(buckets.length / count));
  const offset = Math.max(0, buckets.length - size * count);
  const values = Array.from({ length: count }, (_, bar) => {
    const slice = buckets.slice(offset + bar * size, offset + (bar + 1) * size).filter((value): value is number => value !== null);
    return slice.length ? slice.reduce((sum, value) => sum + value, 0) / slice.length : null;
  });
  return { values, startSec: (history?.start ?? 0) + offset * (history?.stepSec ?? 0), barSec: size * (history?.stepSec ?? 1) };
}

/** Uptime over the whole range: the average of its buckets that have data. */
function rangeRatio(history: RangeHistory | null, id: string): number | null {
  const known = (history?.series[`kuma:${id}:up`]?.avg ?? []).filter((value): value is number => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}

interface Detail {
  loading: boolean;
  runs: { from: number; to: number }[];
}

/** Each bar's minutes, fetched the first time it's hovered (kept for the page's life). */
const details = new Map<string, Promise<{ ts: number; avg: number }[]>>();
function minutesOf(key: string, from: number, to: number): Promise<{ ts: number; avg: number }[]> {
  const id = `${key}:${from}`;
  if (!details.has(id))
    details.set(
      id,
      fetch(`/api/minutes?${new URLSearchParams({ key, from: String(from), to: String(to) })}`)
        .then((response) => (response.ok ? response.json() : []))
        .catch(() => []),
    );
  return details.get(id) as Promise<{ ts: number; avg: number }[]>;
}

/**
 * The bars of one check. Hover a bar (or focus the strip and use ←/→) for the time it covers, how much of it was up,
 * and for recent short bars the minutes it wasn't.
 */
function Bars({ values, monitorId, start, barSec, label }: { values: (number | null)[]; monitorId: string; start: number; barSec: number; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const from = active === null ? 0 : start + active * barSec;
  const to = from + barSec;
  const value = active === null ? null : values[active];

  useEffect(() => {
    const listable = barSec <= MINUTES_MAX_SEC && to * 1000 > Date.now() - MINUTES_KEPT_MS;
    if (active === null || value === null || value === undefined || value >= 0.999 || !listable) return setDetail(null);
    let current = true;
    setDetail({ loading: true, runs: [] });
    void minutesOf(`kuma:${monitorId}:up`, from, to).then((minutes) => current && setDetail({ loading: false, runs: outages(minutes) }));
    return () => {
      current = false;
    };
  }, [active, value, monitorId, from, to, barSec]);

  return (
    <div
      className="bars"
      tabIndex={0}
      role="group"
      aria-label={label}
      onPointerLeave={() => setActive(null)}
      onBlur={() => setActive(null)}
      onFocus={() => setActive((current) => current ?? values.length - 1)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        setActive((current) => Math.max(0, Math.min(values.length - 1, (current ?? values.length - 1) + (event.key === "ArrowLeft" ? -1 : 1))));
      }}
    >
      {values.map((bar, index) => (
        <span
          key={index}
          className={`${bar === null ? "bar bar-none" : bar >= 0.999 ? "bar bar-up" : bar > 0 ? "bar bar-partial" : "bar bar-down"}${index === active ? " bar-active" : ""}`}
          onPointerEnter={() => setActive(index)}
        />
      ))}
      {active !== null && (
        <span className="bars-tip" role="status" style={{ left: `${((active + 0.5) / values.length) * 100}%` }}>
          <span>
            <span className="muted">{spanLabel(from, to, barSec)}</span>{" "}
            {value === null || value === undefined ? "no data" : value >= 0.999 ? "up the whole time" : `${Math.round(value * 100)}% up`}
            {detail?.loading && <span className="muted"> · …</span>}
          </span>
          {detail?.runs.map((run) => (
            <span key={run.from} className="bars-tip-line level-crit">
              down {clockTime(run.from)}–{clockTime(run.to)} ({Math.round((run.to - run.from) / 60)} min)
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function MonitorBars({ monitor, history, range }: { monitor: KumaMonitor; history: RangeHistory | null; range: UptimeRange }) {
  const { values, startSec, barSec } = bars(history, monitor.id, BARS[range].count);
  return <Bars values={values} monitorId={monitor.id} start={startSec} barSec={barSec} label={`${BARS[range].label}, one bar per ${barSec >= 86_400 ? `${Math.round(barSec / 86_400)} day(s)` : `${Math.round(barSec / 60)} minutes`}`} />;
}

/** Same columns for sites and containers so the two tables line up. */
function MonitorTable({ monitors, history, range }: { monitors: KumaMonitor[]; history: RangeHistory | null; range: UptimeRange }) {
  // Kuma already reports 24 h and 30 d, so a column for those ranges would repeat it.
  const showRange = range !== "24h" && range !== "30d";
  return (
    <table className="table uptime">
      <thead>
        <tr>
          <th aria-label="status" />
          <th>check</th>
          <th className="hide-narrow">{BARS[range].label}</th>
          <th className="right">response</th>
          <th className="right">24h</th>
          {showRange && <th className="right">{range}</th>}
          <th className="right hide-narrow">30d</th>
          <th className="right hide-narrow">cert</th>
        </tr>
      </thead>
      <tbody>
        {monitors.map((monitor) => (
          <tr key={monitor.id}>
            <td>
              <StatusSquare status={statusOf(monitor)} />
            </td>
            <td>
              {monitor.name.replace(/^container: /, "")}
              {monitor.url && <span className="muted hide-narrow"> · {shortHost(monitor.url)}</span>}
            </td>
            <td className="hide-narrow">
              <MonitorBars monitor={monitor} history={history} range={range} />
            </td>
            <td className="num right">{monitor.responseMs === null ? "—" : `${monitor.responseMs} ms`}</td>
            <td className={`num right ${ratioClass(monitor.uptime1d)}`}>{ratio(monitor.uptime1d)}</td>
            {showRange && <td className={`num right ${ratioClass(rangeRatio(history, monitor.id))}`}>{ratio(rangeRatio(history, monitor.id))}</td>}
            <td className={`num right hide-narrow ${ratioClass(monitor.uptime30d)}`}>{ratio(monitor.uptime30d)}</td>
            <td className={`num right hide-narrow ${certClass(monitor.certDays)}`}>
              {monitor.certDays === null ? "—" : `${monitor.certDays}d`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function UptimePage({ uptime, kumaUrl }: { uptime: UptimeStats; kumaUrl: string | null }) {
  const keys = useMemo(() => uptime.monitors.map((monitor) => `kuma:${monitor.id}:up`), [uptime.monitors]);
  const [range, setRange] = useState<UptimeRange>(storedRange);
  const history = useRangeHistory(range, keys);

  function selectRange(next: UptimeRange): void {
    setRange(next);
    try {
      localStorage.setItem(RANGE_KEY, next);
    } catch {
      // Remembering the range is a convenience only.
    }
  }

  const sites = uptime.monitors.filter((monitor) => monitor.type !== "docker");
  const containers = uptime.monitors.filter((monitor) => monitor.type === "docker");
  const down = uptime.monitors.filter((monitor) => monitor.status === 0).length;

  return (
    <>
      <PageHeader
        title="uptime"
        meta={
          uptime.reachable ? (
            <span>
              <span className={down ? "level-crit" : ""}>
                {uptime.monitors.length - down}/{uptime.monitors.length} up
              </span>{" "}
              · checked every 60s by uptime kuma · alerts to your phone via ntfy
            </span>
          ) : (
            <span className="level-crit">uptime kuma unreachable</span>
          )
        }
      >
        <Tabs options={RANGES} value={range} onChange={selectRange} label="time range" />
        {kumaUrl && (
          <a className="button" href={kumaUrl} target="_blank" rel="noreferrer">
            edit checks ↗
          </a>
        )}
      </PageHeader>
      <div className="stack">
        <Panel title="sites" area="sites" meta={`${sites.length} checks`}>
          <MonitorTable monitors={sites} history={history} range={range} />
        </Panel>
        <Panel title="containers" area="containers" meta={`${containers.length} checks`}>
          <MonitorTable monitors={containers} history={history} range={range} />
        </Panel>
      </div>
    </>
  );
}
