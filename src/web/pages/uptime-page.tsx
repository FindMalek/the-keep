import { useEffect, useMemo, useState } from "react";
import type { AppsStats, KumaMonitor, RangeHistory, UptimeStats } from "../../shared/types";
import { publicUrlOf } from "../lib/app-status";
import { FilterBar, Select } from "../components/filter-bar";
import { PageHeader, Tabs } from "../components/page-header";
import { Empty, Panel } from "../components/panel";
import { Sparkline } from "../components/sparkline";
import { StatusSquare, type Status } from "../components/status-square";
import { UptimeStrip } from "../components/uptime-strip";
import { fold, mean } from "../lib/buckets";
import { ms, shortHost } from "../lib/format";
import { clockTime, outages } from "../lib/outages";
import { setQuery, useSearch } from "../lib/router";
import { useRangeHistory } from "../lib/use-range-history";
import { PHONE, useMedia } from "../lib/use-media";

const RANGES = ["24h", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];
/** 30 min, 2 h and 8 h buckets. */
const BUCKETS: Record<Range, number> = { "24h": 48, "7d": 84, "30d": 90 };
const FILTERS = ["all", "down", "dipped", "certs"] as const;

function pct(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1) return "100%";
  return `${(Math.floor(value * 10000) / 100).toFixed(2)}%`;
}

const ratioClass = (value: number | null) => (value === null || value >= 0.999 ? "" : value >= 0.99 ? "level-warn" : "level-crit");
const certClass = (days: number | null) => (days === null ? "" : days < 7 ? "level-crit" : days < 14 ? "level-warn" : "");

/** The square shows the worse of now and the range: a check that's up but was down for an hour today is orange. */
function squareOf(monitor: KumaMonitor, ratio: number | null): Status {
  if (monitor.status === 0) return "down";
  if (monitor.status !== 1) return "warn";
  if (ratio !== null && ratio < 0.99) return "warn";
  return "ok";
}

const details = new Map<string, Promise<{ ts: number; avg: number }[]>>();
function minutesOf(key: string, from: number, to: number): Promise<{ ts: number; avg: number }[]> {
  const id = `${key}:${from}:${to}`;
  if (!details.has(id))
    details.set(
      id,
      fetch(`/api/minutes?${new URLSearchParams({ key, from: String(from), to: String(to) })}`)
        .then((response) => (response.ok ? response.json() : []))
        .catch(() => []),
    );
  return details.get(id) as Promise<{ ts: number; avg: number }[]>;
}

function BucketTip({ monitorId, from, to, value }: { monitorId: string; from: number; to: number; value: number | null }) {
  const [runs, setRuns] = useState<{ from: number; to: number }[] | null>(null);
  useEffect(() => {
    setRuns(null);
    if (value === null || value >= 0.999) return;
    let current = true;
    void minutesOf(`kuma:${monitorId}:up`, from, to).then((minutes) => current && setRuns(outages(minutes)));
    return () => {
      current = false;
    };
  }, [monitorId, from, to, value]);
  const span = to - from > 86400 / 2 ? `${new Date(from * 1000).toLocaleDateString([], { day: "numeric", month: "short" }).toLowerCase()} ` : "";
  return (
    <>
      <span className="muted">
        {span}
        {clockTime(from)}–{clockTime(to)}
      </span>{" "}
      {value === null ? "no data" : value >= 0.999 ? "up the whole time" : `${(value * 100).toFixed(1)}% up`}
      {runs?.slice(0, 3).map((run) => (
        <span key={run.from} className="tip-line level-crit">
          down {clockTime(run.from)}–{clockTime(run.to)} ({Math.round((run.to - run.from) / 60)} min)
        </span>
      ))}
    </>
  );
}

interface Row {
  monitor: KumaMonitor;
  strip: (number | null)[];
  ratio: number | null;
}

function MonitorRow({ row, history, start, bucketSec, apps }: { row: Row; history: RangeHistory | null; start: number; bucketSec: number; apps: AppsStats }) {
  const { monitor, strip, ratio } = row;
  const url = publicUrlOf(monitor, apps);
  const speed = history?.series[`kuma:${monitor.id}:ms`];
  const name = monitor.name.replace(/^container: /, "");
  return (
    <li className="check" id={`check-${monitor.id}`}>
      <StatusSquare
        status={squareOf(monitor, ratio)}
        label={`${monitor.status === 1 ? "up now" : monitor.status === 0 ? "down now" : "pending"} · ${pct(ratio)} over the range`}
      />
      <span className="check-name">
        <span className="ellipsis">{name}</span>
        {url ? (
          <a className="check-host" href={url} target="_blank" rel="noreferrer">
            <span className="link ellipsis">{shortHost(url)}</span>
            <span className="arrow">↗</span>
          </a>
        ) : (
          <span className="check-host muted">{monitor.type === "docker" ? "container" : monitor.url ? `${shortHost(monitor.url)} · internal` : monitor.type}</span>
        )}
      </span>
      <span className="check-strip">
        <UptimeStrip
          values={strip}
          label={`${name}, uptime per bucket`}
          describe={(index) => <BucketTip monitorId={monitor.id} from={start + index * bucketSec} to={start + (index + 1) * bucketSec} value={strip[index] ?? null} />}
        />
      </span>
      {monitor.type !== "docker" && (
      <span className="check-speed">
        <span className="check-spark">
          {speed ? <Sparkline values={speed.avg} capacity={speed.avg.length} stepSec={history?.stepSec ?? 300} format={ms} height={16} label={`${name} response time`} bare robust /> : null}
        </span>
        <span className="n-ms">{ms(monitor.responseMs)}</span>
      </span>
      )}
      <span className={`check-ratio n-pct2 ${ratioClass(ratio)}`} title={monitor.uptime30d !== null ? `kuma 30d: ${pct(monitor.uptime30d)}` : undefined}>
        {pct(ratio)}
      </span>
      {monitor.type !== "docker" && (
        <span className={`check-cert n-temp ${certClass(monitor.certDays)}`} title="days until the tls certificate expires">
          {monitor.certDays === null ? "—" : `${monitor.certDays}d`}
        </span>
      )}
    </li>
  );
}

/**
 * Uptime for the range. Kuma's own 24 h and 30 d figures count every check, including outages shorter than the
 * dashboard's 1-minute samples, so they win where they exist; 7 d averages the stored samples (each step weighs the same).
 */
function rangeRatio(monitor: KumaMonitor, range: Range, raw: (number | null)[] | undefined): number | null {
  if (range === "24h" && monitor.uptime1d !== null) return monitor.uptime1d;
  if (range === "30d" && monitor.uptime30d !== null) return monitor.uptime30d;
  return mean(raw ?? []);
}

export function UptimePage({ uptime, kumaUrl, apps }: { uptime: UptimeStats; kumaUrl: string | null; apps: AppsStats }) {
  const search = useSearch();
  const range = (RANGES as readonly string[]).includes(search.get("range") ?? "") ? (search.get("range") as Range) : "24h";
  const filter = (FILTERS as readonly string[]).includes(search.get("f") ?? "") ? (search.get("f") as (typeof FILTERS)[number]) : "all";
  const sort = search.get("sort") === "name" ? "name" : "worst";
  const [query, setQueryText] = useState(search.get("q") ?? "");
  const phone = useMedia(PHONE);

  const keys = useMemo(() => uptime.monitors.flatMap((monitor) => [`kuma:${monitor.id}:up`, `kuma:${monitor.id}:ms`]), [uptime.monitors]);
  const history = useRangeHistory(range, keys);
  const count = phone ? 48 : BUCKETS[range];
  const span = history ? (history.series[`kuma:${uptime.monitors[0]?.id}:up`]?.avg.length ?? 0) * history.stepSec : 0;
  const bucketSec = span ? span / count : 1800;
  const start = history?.start ?? 0;

  const rows: Row[] = uptime.monitors.map((monitor) => {
    const raw = history?.series[`kuma:${monitor.id}:up`]?.avg;
    const strip = fold(raw ?? [], count);
    return { monitor, strip, ratio: rangeRatio(monitor, range, raw) };
  });
  const down = rows.filter((row) => row.monitor.status === 0);
  const degraded = rows.filter((row) => row.monitor.status === 1 && row.ratio !== null && row.ratio < 0.999);
  const certs = rows.filter((row) => row.monitor.certDays !== null && row.monitor.certDays < 30);
  const worst = [...rows].filter((row) => row.ratio !== null).sort((a, b) => (a.ratio ?? 1) - (b.ratio ?? 1))[0];

  const needle = query.trim().toLowerCase();
  const shown = rows
    .filter((row) => (filter === "down" ? row.monitor.status === 0 : filter === "dipped" ? degraded.includes(row) : filter === "certs" ? certs.includes(row) : true))
    .filter((row) => !needle || row.monitor.name.toLowerCase().includes(needle) || (row.monitor.url ?? "").includes(needle))
    .sort((a, b) => (sort === "name" ? a.monitor.name.localeCompare(b.monitor.name) : (a.ratio ?? 2) - (b.ratio ?? 2) || a.monitor.name.localeCompare(b.monitor.name)));
  const sites = shown.filter((row) => row.monitor.type !== "docker");
  const containers = shown.filter((row) => row.monitor.type === "docker");

  // Per bucket, the worst check: one strip that says whether anything was wrong at that time.
  const summary = Array.from({ length: count }, (_, index) => {
    const values = rows.map((row) => row.strip[index]).filter((value): value is number => value !== null && value !== undefined);
    return values.length ? Math.min(...values) : null;
  });
  const firstDownAt = (index: number) => {
    const row = rows.find((candidate) => (candidate.strip[index] ?? 1) < 0.999);
    if (row) document.getElementById(`check-${row.monitor.id}`)?.scrollIntoView({ block: "center" });
  };

  const list = (title: string, items: Row[], docker = false) => (
    <Panel title={title} meta={`${items.length} checks`} flush>
      {items.length === 0 ? (
        <div className="box-pad">
          <Empty>nothing matches</Empty>
        </div>
      ) : (
        <ul className={`checks${docker ? " is-docker" : ""}`}>
          <li className="check check-head" aria-hidden="true">
            <span />
            <span>check</span>
            <span>{range} · oldest left</span>
            {!docker && <span className="right">response</span>}
            <span className="right">uptime</span>
            {!docker && <span className="right">cert</span>}
          </li>
          {items.map((row) => (
            <MonitorRow key={row.monitor.id} row={row} history={history} start={start} bucketSec={bucketSec} apps={apps} />
          ))}
        </ul>
      )}
    </Panel>
  );

  return (
    <>
      <PageHeader
        title="uptime"
        meta={
          uptime.reachable ? (
            <>
              <span className={down.length ? "level-crit" : ""}>
                {uptime.monitors.length - down.length}/{uptime.monitors.length} up
              </span>{" "}
              · checked every 60s · alerts in telegram and ntfy
            </>
          ) : (
            <span className="level-crit">uptime kuma unreachable</span>
          )
        }
      >
        <Tabs options={RANGES} value={range} onChange={(next) => setQuery({ range: next === "24h" ? null : next })} label="range" />
        {kumaUrl && (
          <a className="button button-quiet hide-phone" href={kumaUrl} target="_blank" rel="noreferrer">
            edit checks ↗
          </a>
        )}
      </PageHeader>
      <div className="grid">
        <Panel title="summary" meta={`${count} × ${bucketSec >= 3600 ? `${Math.round(bucketSec / 3600)} h` : `${Math.round(bucketSec / 60)} min`}`}>
          <div className="summary">
            <span>
              <span className="num">{uptime.monitors.length}</span> <span className="muted">checks</span>
            </span>
            <span className={down.length ? "level-crit" : ""}>
              <span className="num">{down.length}</span> <span className={down.length ? "" : "muted"}>down</span>
            </span>
            <span className={degraded.length ? "level-warn" : ""}>
              <span className="num">{degraded.length}</span> <span className={degraded.length ? "" : "muted"}>dipped</span>
            </span>
            {worst && (worst.ratio ?? 1) < 0.999 ? (
              <span>
                <span className="muted">worst</span> {worst.monitor.name.replace(/^container: /, "")} <span className={ratioClass(worst.ratio)}>{pct(worst.ratio)}</span>
              </span>
            ) : (
              <span className="muted">all ≥ 99.9%</span>
            )}
            <span className={certs.length ? "level-warn" : "muted"}>{certs.length} certs under 30d</span>
          </div>
          <div className="check check-summary">
            <span />
            <span className="check-name muted small">worst check per bucket</span>
            <span className="check-strip">
          <UptimeStrip
            values={summary}
            height={24}
            label="worst check per bucket"
            describe={(index) => (
              <>
                <span className="muted">
                  {clockTime(start + index * bucketSec)}–{clockTime(start + (index + 1) * bucketSec)}
                </span>{" "}
                {summary[index] === null ? "no data" : (summary[index] ?? 1) >= 0.999 ? "everything up" : `worst ${((summary[index] ?? 0) * 100).toFixed(1)}% up · click to find it`}
              </>
            )}
            onPick={firstDownAt}
          />
            </span>
          </div>
          <p className="legend-strip small muted">
            <span className="key key-up" /> up <span className="key key-part" /> partly down <span className="key key-down" /> down <span className="key key-none" /> no data
          </p>
        </Panel>
        <div className="grid-full">
          <FilterBar
            query={query}
            onQuery={(value) => {
              setQueryText(value);
              setQuery({ q: value });
            }}
            placeholder="search checks"
            value={filter}
            onChange={(value) => setQuery({ f: value === "all" ? null : value })}
            options={[
              { value: "all", label: "all", count: rows.length },
              { value: "down", label: "down", count: down.length, tone: down.length ? "crit" : undefined },
              { value: "dipped", label: "dipped", count: degraded.length, tone: degraded.length ? "warn" : undefined },
              { value: "certs", label: "certs < 30d", count: certs.length },
            ]}
          >
            <Select
              label="sort"
              value={sort}
              onChange={(value) => setQuery({ sort: value === "worst" ? null : value })}
              options={[
                { value: "worst", label: "worst first" },
                { value: "name", label: "name" },
              ]}
            />
          </FilterBar>
        </div>
        {list("sites", sites)}
        {containers.length > 0 && list("containers", containers, true)}
      </div>
    </>
  );
}
