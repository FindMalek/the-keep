import { useCallback, useEffect, useRef, useState } from "react";
import type { JournalStats, LogEntry, LogHistogram, LogPage } from "../../shared/types";
import { DitherBars } from "../components/dither-bars";
import { Select } from "../components/filter-bar";
import { LogRow } from "../components/log-row";
import { PageHeader, Tabs } from "../components/page-header";
import { Empty, Link, Panel } from "../components/panel";
import { bytes, compact } from "../lib/format";
import { go, setQuery, useSearch } from "../lib/router";
import { clock } from "../lib/time";

const RANGES = ["15m", "1h", "6h", "24h", "7d"] as const;
type Range = (typeof RANGES)[number];
const RANGE_SEC: Record<Range, number> = { "15m": 900, "1h": 3600, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400 };
const BUCKETS: Record<Range, number> = { "15m": 45, "1h": 60, "6h": 72, "24h": 96, "7d": 84 };
/** Chips map onto journald priorities: errors are 0-3. */
const LEVELS = [
  { key: "E", label: "errors", prio: [0, 1, 2, 3] },
  { key: "W", label: "warnings", prio: [4] },
  { key: "I", label: "info", prio: [5, 6] },
  { key: "D", label: "debug", prio: [7] },
] as const;
const MAX_ROWS = 5000;
const LIVE_MS = 2000;

interface Filters {
  q: string;
  range: Range;
  since: string | null;
  until: string | null;
  levels: string[];
  units: string[];
  sources: string[];
  boot: string;
}

function readFilters(search: URLSearchParams): Filters {
  return {
    q: search.get("q") ?? "",
    range: (RANGES as readonly string[]).includes(search.get("range") ?? "") ? (search.get("range") as Range) : "1h",
    since: search.get("since"),
    until: search.get("until"),
    levels: (search.get("lvl") ?? "").split("").filter((key) => LEVELS.some((level) => level.key === key)),
    units: search.getAll("unit"),
    sources: search.getAll("source"),
    boot: search.get("boot") ?? "",
  };
}

/** Explicit since/until win; otherwise the range counts back from now. Unix seconds. */
function timeWindow(filters: Filters): { since: number; until: number | null } {
  if (filters.since) return { since: Number(filters.since), until: filters.until ? Number(filters.until) : null };
  return { since: Math.floor(Date.now() / 1000) - RANGE_SEC[filters.range], until: null };
}

function params(filters: Filters, extra: Record<string, string> = {}): URLSearchParams {
  const out = new URLSearchParams();
  const { since, until } = timeWindow(filters);
  if (filters.q) out.set("q", filters.q);
  out.set("since", String(since));
  if (until) out.set("until", String(until));
  const prio = LEVELS.filter((level) => filters.levels.includes(level.key)).flatMap((level) => level.prio);
  if (prio.length) out.set("prio", prio.join(","));
  for (const unit of filters.units) out.append("unit", unit);
  for (const source of filters.sources) out.append("source", source);
  if (filters.boot) out.set("boot", filters.boot);
  for (const [key, value] of Object.entries(extra)) out.set(key, value);
  return out;
}

async function getJson<T>(url: string): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(url);
    if (!response.ok) return { data: null, error: (await response.text()) || `error ${response.status}` };
    return { data: (await response.json()) as T, error: null };
  } catch {
    return { data: null, error: "could not reach the server" };
  }
}

function useOptions(): { units: string[]; boots: { id: string; index: number; first: number }[] } {
  const [units, setUnits] = useState<string[]>([]);
  const [boots, setBoots] = useState<{ id: string; index: number; first: number }[]>([]);
  useEffect(() => {
    void getJson<string[]>("/api/logs/units").then(({ data }) => data && setUnits(data));
    void getJson<{ id: string; index: number; first: number }[]>("/api/logs/boots").then(({ data }) => data && setBoots(data));
  }, []);
  return { units, boots };
}

function Volume({ filters, journal, onPick }: { filters: Filters; journal: JournalStats; onPick: (from: number, to: number) => void }) {
  const [histogram, setHistogram] = useState<LogHistogram | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plain = !filters.q && !filters.levels.length && !filters.units.length && !filters.sources.length && !filters.boot && !filters.since;
  // The hourly summary keep-disk-watch already writes covers an unfiltered day; reading a day of journal per request doesn't scale.
  const useSummary = plain && filters.range === "24h";
  const tooLong = filters.range === "7d" && !filters.since;
  const key = params(filters).toString();

  useEffect(() => {
    setHistogram(null);
    setError(null);
    if (useSummary || tooLong) return;
    const { since, until } = timeWindow(filters);
    let current = true;
    void getJson<LogHistogram>(`/api/logs/histogram?${params(filters, { from: String(since * 1000), to: String((until ?? Date.now() / 1000) * 1000), buckets: String(BUCKETS[filters.range]) })}`).then(
      ({ data, error: message }) => {
        if (!current) return;
        setHistogram(data);
        setError(message);
      },
    );
    return () => {
      current = false;
    };
  }, [key, useSummary, tooLong]);

  const hourAt = (at: number) => (at > 1e12 ? at : at * 1000);
  const series = useSummary
    ? { from: hourAt(journal.hours[0]?.at ?? 0), stepMs: 3600_000, buckets: journal.hours.map((hour) => ({ lines: hour.lines, errors: hour.errors })), partial: false }
    : histogram;
  const total = series?.buckets.reduce((sum, bucket) => sum + bucket.lines, 0) ?? 0;
  const errors = series?.buckets.reduce((sum, bucket) => sum + bucket.errors, 0) ?? 0;
  const stepLabel = series ? (series.stepMs >= 3600_000 ? `${Math.round(series.stepMs / 3600_000)} h` : series.stepMs >= 60_000 ? `${Math.round(series.stepMs / 60_000)} min` : `${Math.round(series.stepMs / 1000)} s`) : "";

  return (
    <Panel
      title="volume"
      meta={
        series ? (
          <>
            {compact(total)} lines · {compact(errors)} errors · {stepLabel} bars{series.partial ? " · cut short, too many lines" : ""}
          </>
        ) : tooLong ? (
          "up to 24 h"
        ) : (
          "counting…"
        )
      }
    >
      {tooLong ? (
        <p className="small muted">counting a week of journal is too slow to do on every visit; pick 24 h or less, or click a day in the entries.</p>
      ) : error ? (
        <p className="small level-warn">{error}</p>
      ) : (
        <DitherBars
          values={series ? series.buckets.map((bucket) => bucket.lines) : Array(BUCKETS[filters.range]).fill(null)}
          overlay={series?.buckets.map((bucket) => bucket.errors)}
          height={56}
          axis={!!series}
          format={compact}
          label="log lines per bucket with errors; pick a bar to show only that time"
          labels={series?.buckets.map((_, index) => clock(series.from + index * series.stepMs))}
          describe={(index) => {
            const bucket = series?.buckets[index];
            return series && bucket ? `${clock(series.from + index * series.stepMs)} · ${compact(bucket.lines)} lines · ${compact(bucket.errors)} errors` : "";
          }}
          onPick={(index) => series && onPick(Math.floor((series.from + index * series.stepMs) / 1000), Math.ceil((series.from + (index + 1) * series.stepMs) / 1000))}
        />
      )}
    </Panel>
  );
}

export function LogsPage({ journal, dozzle }: { journal: JournalStats; dozzle: string | null }) {
  const search = useSearch();
  const filters = readFilters(search);
  const key = params(filters).toString().replace(/since=\d+&?/, "");
  const { units, boots } = useOptions();
  const [text, setText] = useState(filters.q);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(search.get("live") === "1");
  const [unseen, setUnseen] = useState(0);
  const more = useRef<HTMLDivElement>(null);
  const generation = useRef(0);

  const load = useCallback(
    async (cursor: string | null) => {
      const mine = generation.current;
      setLoading(true);
      const { data, error: message } = await getJson<LogPage>(`/api/logs?${params(filters, { limit: "200", ...(cursor ? { before: cursor } : {}) })}`);
      if (mine !== generation.current) return;
      setLoading(false);
      setError(message);
      if (!data) return;
      setEntries((current) => (cursor ? [...current, ...data.entries].slice(0, MAX_ROWS) : data.entries));
      setBefore(data.before);
      if (!cursor) setAfter(data.after);
    },
    [key],
  );

  useEffect(() => {
    generation.current += 1;
    setEntries([]);
    setBefore(null);
    setUnseen(0);
    void load(null);
  }, [load]);

  useEffect(() => {
    const node = more.current;
    if (!node || !before) return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && !loading && void load(before), { rootMargin: "600px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [before, loading, load]);

  useEffect(() => {
    if (!live || !after || filters.until) return;
    const id = setInterval(async () => {
      const { data } = await getJson<LogPage>(`/api/logs?${params(filters, { limit: "200", after: after ?? "" })}`);
      if (!data || !data.entries.length) return;
      setAfter(data.after);
      setEntries((current) => [...data.entries, ...current].slice(0, MAX_ROWS));
      if (window.scrollY > 300) setUnseen((count) => count + data.entries.length);
    }, LIVE_MS);
    return () => clearInterval(id);
  }, [live, after, key]);

  useEffect(() => {
    const id = setTimeout(() => text !== filters.q && setQuery({ q: text }), 400);
    return () => clearTimeout(id);
  }, [text, filters.q]);

  const toggleLevel = (levelKey: string) => {
    const next = filters.levels.includes(levelKey) ? filters.levels.filter((k) => k !== levelKey) : [...filters.levels, levelKey];
    setQuery({ lvl: next.sort().join("") || null });
  };
  const active: { label: string; clear: () => void }[] = [
    ...filters.units.map((unit) => ({ label: `unit ${unit}`, clear: () => setQuery({ unit: filters.units.filter((u) => u !== unit) }) })),
    ...filters.sources.map((source) => ({ label: `source ${source}`, clear: () => setQuery({ source: filters.sources.filter((s) => s !== source) }) })),
    ...(filters.since ? [{ label: `${clock(Number(filters.since) * 1000)}${filters.until ? `–${clock(Number(filters.until) * 1000)}` : " → now"}`, clear: () => setQuery({ since: null, until: null }) }] : []),
    ...(filters.boot ? [{ label: `boot ${filters.boot.slice(0, 8)}`, clear: () => setQuery({ boot: null }) }] : []),
  ];

  const copyLink = () => void navigator.clipboard?.writeText(window.location.href).catch(() => {});

  return (
    <>
      <PageHeader
        title="logs"
        meta={`journald${journal.diskBytes !== null ? ` · ${bytes(journal.diskBytes)}${journal.capBytes ? ` / ${bytes(journal.capBytes)}` : ""}` : ""} · 14 days kept`}
      >
        <button
          type="button"
          className="filter-chip"
          aria-pressed={live}
          onClick={() => {
            setLive(!live);
            setQuery({ live: live ? null : "1" });
          }}
          title="poll for new lines every 2 seconds"
        >
          <span className={`live-dot${live ? " is-on" : ""}`} aria-hidden="true" /> live
        </button>
        <button type="button" className="filter-chip" onClick={copyLink}>
          copy link
        </button>
      </PageHeader>
      <div className="grid">
        <div className="grid-full log-filters">
          <div className="filter-bar">
            <label className="search search-wide">
              <span className="sr-only">grep the journal</span>
              <input
                type="search"
                value={text}
                placeholder="grep (regex, any case)"
                spellCheck={false}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") setQuery({ q: text });
                  if (event.key === "Escape") setText("");
                }}
              />
            </label>
            <div className="log-scroll">
              <Tabs options={RANGES} value={filters.range} onChange={(range) => setQuery({ range: range === "1h" ? null : range, since: null, until: null })} label="time range" />
              <div className="filter-chips" role="group" aria-label="priority">
                <button type="button" className="filter-chip" aria-pressed={filters.levels.length === 0} onClick={() => setQuery({ lvl: null })}>
                  all
                </button>
                {LEVELS.map((level) => (
                  <button key={level.key} type="button" className="filter-chip" aria-pressed={filters.levels.includes(level.key)} onClick={() => toggleLevel(level.key)} title={level.label}>
                    <span className={level.key === "E" ? "level-crit" : level.key === "W" ? "level-warn" : ""}>{level.key}</span> <span className="filter-count">{level.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="filter-extra log-selects">
              <Select label="unit" value="" onChange={(unit) => unit && setQuery({ unit: [...new Set([...filters.units, unit])] })} options={[{ value: "", label: units.length ? "add…" : "…" }, ...units.map((unit) => ({ value: unit, label: unit }))]} />
              <Select
                label="boot"
                value={filters.boot}
                onChange={(boot) => setQuery({ boot: boot || null })}
                options={[{ value: "", label: "all" }, ...boots.map((boot) => ({ value: String(boot.index), label: boot.index === 0 ? "current" : `${boot.index} · ${new Date(boot.first).toLocaleDateString([], { day: "numeric", month: "short" }).toLowerCase()}` }))]}
              />
            </div>
          </div>
          {active.length > 0 && (
            <div className="active-filters">
              <span className="muted small">active</span>
              {active.map((filter) => (
                <button key={filter.label} type="button" className="chip chip-button" onClick={filter.clear}>
                  {filter.label} ×
                </button>
              ))}
              <button type="button" className="link small" onClick={() => go("/logs")}>
                clear all
              </button>
            </div>
          )}
        </div>
        <Volume filters={filters} journal={journal} onPick={(since, until) => setQuery({ since: String(since), until: String(until) })} />
        <Panel
          title="entries"
          meta={`${entries.length}${before ? "+" : ""} · newest first`}
          actions={dozzle ? <Link href={dozzle}>container logs in dozzle</Link> : undefined}
          flush
        >
          {unseen > 0 && (
            <button
              type="button"
              className="new-pill"
              onClick={() => {
                window.scrollTo({ top: 0, behavior: "smooth" });
                setUnseen(0);
              }}
            >
              {unseen} new ↑
            </button>
          )}
          {error ? (
            <div className="box-pad">
              <Empty>
                <span className="level-warn">{error}</span>
              </Empty>
            </div>
          ) : entries.length === 0 ? (
            <div className="box-pad">
              <Empty>{loading ? "reading the journal…" : "no entries match. container output isn't in journald: docker keeps it in json files, see dozzle."}</Empty>
            </div>
          ) : (
            <ul className="log-list">
              {entries.map((entry) => (
                <LogRow
                  key={entry.cursor}
                  entry={entry}
                  query={filters.q || null}
                  onSource={(source) => setQuery({ source: [...new Set([...filters.sources, source])] })}
                  onContext={(around) => go(`/logs?since=${Math.floor(around.at / 1e6) - 30}&until=${Math.ceil(around.at / 1e6) + 30}`)}
                />
              ))}
            </ul>
          )}
          <div ref={more} className="log-more small muted">
            {before ? (loading ? "loading older…" : "scroll for older") : entries.length ? "start of the range" : ""}
          </div>
        </Panel>
      </div>
    </>
  );
}

