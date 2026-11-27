import { Fragment, useEffect, useRef, useState } from "react";
import type { AiUsageEntry, SessionListRow, UsageDay } from "../../shared/types";
import { DitherBars } from "../components/dither-bars";
import { FilterBar, Select } from "../components/filter-bar";
import { HeatMatrix } from "../components/heat";
import { PageHeader, Tabs } from "../components/page-header";
import { Empty, Panel } from "../components/panel";
import { SessionDetail } from "../components/session-detail";
import { StatTiles, type Tile } from "../components/stat-tiles";
import { cleanTitle, compact, percent, projectOf, usd } from "../lib/format";
import { navigate, setQuery, useSearch } from "../lib/router";
import { clock, dayLabel, since } from "../lib/time";
import { useFacets, useSessionList, type SessionQuery } from "../lib/use-sessions";

const RANGES = ["7d", "30d", "90d"] as const;
type Range = (typeof RANGES)[number];
const DAYS: Record<Range, number> = { "7d": 7, "30d": 30, "90d": 90 };
const DAY = 86_400_000;

const tokensOf = (row: { tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number }) => row.tokensIn + row.tokensOut + row.cacheRead + row.cacheWrite;
const shortModel = (model: string) => model.replace(/^claude-/, "").replace(/^anthropic\//, "");

function isoDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
}

interface DayTotal {
  usd: number;
  tokens: number;
  sessions: number;
}

function byDay(usage: UsageDay[]): Map<string, DayTotal> {
  const days = new Map<string, DayTotal>();
  for (const row of usage) {
    const entry = days.get(row.day) ?? { usd: 0, tokens: 0, sessions: 0 };
    entry.usd += row.costUsd;
    entry.tokens += tokensOf(row);
    // A session can use several models in a day; the busiest model's count is the closest honest number.
    entry.sessions = Math.max(entry.sessions, row.sessions);
    days.set(row.day, entry);
  }
  return days;
}

function CostPanel({ usage, range, onDay }: { usage: UsageDay[]; range: Range; onDay: (day: string) => void }) {
  const days = byDay(usage);
  // A calendar of mostly empty squares says nothing; it appears once there are two weeks of history.
  const showCalendar = days.size >= 14 && range !== "7d";
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  // Weeks run Monday to Sunday; the last column holds this week.
  const weekday = (today.getDay() + 6) % 7;
  const weeks = range === "90d" ? 13 : 5;
  const firstMonday = todayStart - weekday * DAY - (weeks - 1) * 7 * DAY;
  const cellDay = (row: number, column: number) => firstMonday + (column * 7 + row) * DAY;
  const matrix = Array.from({ length: 7 }, (_, row) =>
    Array.from({ length: weeks }, (_, column) => {
      const start = cellDay(row, column);
      return start > todayStart ? null : (days.get(isoDay(start))?.usd ?? 0);
    }),
  );
  const months = Array.from({ length: weeks }, (_, column) => {
    const start = new Date(cellDay(0, column));
    const previous = new Date(cellDay(0, column - 1));
    // The first column's month only when it has room before the next month starts.
    const label = start.toLocaleDateString([], { month: "short" }).toLowerCase();
    if (column === 0) return new Date(cellDay(0, 2)).getMonth() === start.getMonth() ? label : "";
    return start.getMonth() !== previous.getMonth() ? label : "";
  });
  const span = DAYS[range];
  const series = Array.from({ length: span }, (_, index) => todayStart - (span - 1 - index) * DAY);

  return (
    <Panel id="cost" title="cost per day" span={8} meta={`${showCalendar ? `${weeks} weeks · darker is more · ` : ""}pick a day to list its sessions`}>
      {showCalendar && (
      <HeatMatrix
        matrix={matrix}
        rowLabels={["mon", "", "wed", "", "fri", "", "sun"]}
        columnLabels={months}
        cell={16}
        gap={4}
        tip={(row, column) => {
          const start = cellDay(row, column);
          const total = days.get(isoDay(start));
          const label = new Date(start).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }).toLowerCase();
          return total ? `${label} · ${usd(total.usd)} · ${compact(total.tokens)} tokens · ${total.sessions}+ sessions` : `${label} · nothing`;
        }}
        onPick={(row, column) => onDay(isoDay(cellDay(row, column)))}
        label={`cost per day, last ${weeks} weeks`}
      />
      )}
      <DitherBars
        values={series.map((start) => days.get(isoDay(start))?.usd ?? 0)}
        height={showCalendar ? 48 : 72}
        format={usd}
        label={`cost per day, last ${span} days`}
        labels={series.map((start) => new Date(start).toLocaleDateString([], { day: "numeric", month: "short" }).toLowerCase())}
        onPick={(index) => onDay(isoDay(series[index] ?? todayStart))}
      />
      {!showCalendar && (
        <table className="table table-compact">
          <colgroup>
            <col />
            <col style={{ width: "9ch" }} />
            <col style={{ width: "9ch" }} />
            <col style={{ width: "10ch" }} />
          </colgroup>
          <thead>
            <tr>
              <th>recent days</th>
              <th className="right">tokens</th>
              <th className="right">sessions</th>
              <th className="right">cost</th>
            </tr>
          </thead>
          <tbody>
            {[...days]
              .sort((a, b) => b[0].localeCompare(a[0]))
              .slice(0, 5)
              .map(([day, total]) => (
                <tr key={day} className="row-click" onClick={() => onDay(day)}>
                  <td>{new Date(dayStart(day)).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }).toLowerCase()}</td>
                  <td className="num right muted">{compact(total.tokens)}</td>
                  <td className="num right muted">{total.sessions}+</td>
                  <td className="num right">{usd(total.usd)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function ModelsPanel({ usage, onModel }: { usage: UsageDay[]; onModel: (model: string) => void }) {
  const models = new Map<string, { tokensIn: number; tokensOut: number; cache: number; usd: number; unpriced: number }>();
  for (const row of usage) {
    const entry = models.get(row.model) ?? { tokensIn: 0, tokensOut: 0, cache: 0, usd: 0, unpriced: 0 };
    entry.tokensIn += row.tokensIn;
    entry.tokensOut += row.tokensOut;
    entry.cache += row.cacheRead + row.cacheWrite;
    entry.usd += row.costUsd;
    entry.unpriced += row.unpriced;
    models.set(row.model, entry);
  }
  const rows = [...models].sort((a, b) => b[1].usd - a[1].usd);
  const unpriced = rows.filter(([, entry]) => entry.unpriced > 0);
  return (
    <Panel id="models" title="by model" span={4} meta="in · out · cache · cost">
      {rows.length === 0 ? (
        <Empty>no usage in this range</Empty>
      ) : (
        <table className="table table-compact">
          <colgroup>
            <col />
            <col style={{ width: "7ch" }} />
            <col style={{ width: "7ch" }} />
            <col style={{ width: "7ch" }} />
            <col style={{ width: "9ch" }} />
          </colgroup>
          <thead>
            <tr>
              <th>model</th>
              <th className="right">in</th>
              <th className="right">out</th>
              <th className="right">cache</th>
              <th className="right">cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([model, entry]) => (
              <tr key={model} className="row-click" onClick={() => onModel(model)} title={`show ${model} sessions`}>
                <td className="ellipsis">{shortModel(model)}</td>
                <td className="num right muted">{compact(entry.tokensIn)}</td>
                <td className="num right muted">{compact(entry.tokensOut)}</td>
                <td className="num right muted">{compact(entry.cache)}</td>
                <td className="num right">{entry.unpriced ? <span className="level-warn">—</span> : usd(entry.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="small muted box-foot">
        {unpriced.length ? (
          <span className="level-warn">{unpriced.length} unpriced: add it to prices.json in the data dir</span>
        ) : (
          "computed from token counts × stored prices; cache read and write included"
        )}
      </p>
    </Panel>
  );
}

function SessionRow({ row }: { row: SessionListRow }) {
  const tokens = tokensOf(row);
  const differs = row.costUsd !== null && row.reportedUsd !== null && row.reportedUsd > 0 && Math.abs(row.costUsd - row.reportedUsd) / row.reportedUsd > 0.05;
  return (
    <li className="session row-target">
      <span className="session-when">{clock(row.startedAt)}</span>
      <a className="session-title ellipsis" href={`/sessions?s=${encodeURIComponent(row.id)}`} onClick={navigate}>
        {cleanTitle(row.title) || row.id.split(":").at(-1)}
      </a>
      <span className="session-project ellipsis muted" title={row.directory ?? undefined}>
        {projectOf(row.directory)}
      </span>
      <span className="session-tool ellipsis muted" title={row.machine}>
        {row.tool.replace("claude-code", "claude")}
      </span>
      <span className="session-model ellipsis muted">{row.models.map(shortModel).join(", ") || "—"}</span>
      <span className="n-count">{compact(tokens)}</span>
      <span className="n-usd" title={row.reportedUsd !== null ? `tool reported ${usd(row.reportedUsd)}` : "tool reported no cost"}>
        {differs && <span className="muted">≠ </span>}
        {row.costUsd === null ? <span className="muted">—</span> : usd(row.costUsd)}
      </span>
    </li>
  );
}

function limitTiles(aiUsage: AiUsageEntry[]): Tile[] {
  return aiUsage.slice(0, 2).flatMap((entry) => [
    { key: `${entry.tool}-5h`, label: `${entry.tool} 5h`, value: entry.fiveHourPct === null ? "—" : `${Math.round(entry.fiveHourPct)}%`, sub: entry.machine, ratio: (entry.fiveHourPct ?? 0) / 100, target: "list" },
    { key: `${entry.tool}-wk`, label: `${entry.tool} week`, value: entry.weeklyPct === null ? "—" : `${Math.round(entry.weeklyPct)}%`, sub: entry.machine, ratio: (entry.weeklyPct ?? 0) / 100, target: "list" },
  ]);
}

export function SessionsPage({ aiUsage }: { aiUsage: AiUsageEntry[] }) {
  const search = useSearch();
  const selected = search.get("s");
  const range: Range = (RANGES as readonly string[]).includes(search.get("range") ?? "") ? (search.get("range") as Range) : "30d";
  const query: SessionQuery = {
    tool: search.get("tool") ?? "",
    machine: search.get("machine") ?? "",
    project: search.get("project") ?? "",
    model: search.get("model") ?? "",
    q: search.get("q") ?? "",
    from: search.get("from") ? Number(search.get("from")) : null,
    to: search.get("to") ? Number(search.get("to")) : null,
  };
  const [text, setText] = useState(query.q);
  const list = useSessionList(query);
  const facets = useFacets();
  const more = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setTimeout(() => text !== query.q && setQuery({ q: text }), 300);
    return () => clearTimeout(id);
  }, [text, query.q]);

  useEffect(() => {
    const node = more.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && list.more(), { rootMargin: "400px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [list.more, list.rows.length]);

  if (selected) return <SessionDetail id={selected} />;

  const usage = list.usage ?? [];
  const cutoff = isoDay(Date.now() - (DAYS[range] - 1) * DAY);
  const inRange = usage.filter((row) => row.day >= cutoff);
  const cost = inRange.reduce((sum, row) => sum + row.costUsd, 0);
  const tokens = inRange.reduce((sum, row) => sum + tokensOf(row), 0);
  const prompt = inRange.reduce((sum, row) => sum + row.tokensIn + row.cacheRead + row.cacheWrite, 0);
  const cacheHit = prompt ? inRange.reduce((sum, row) => sum + row.cacheRead, 0) / prompt : 0;
  const today = byDay(usage).get(isoDay(Date.now()));
  // Divide by days that actually have sessions: a 30-day average over 2 days of history would be fiction.
  const activeDays = new Set(inRange.map((row) => row.day)).size;
  const perDay = activeDays ? cost / activeDays : 0;

  const tiles: Tile[] = [
    { key: "cost", label: `cost ${range}`, value: usd(cost), sub: `${usd(perDay)}/day · ${activeDays} active`, series: [...byDay(inRange).values()].map((day) => day.usd), target: "cost" },
    { key: "today", label: "today", value: usd(today?.usd ?? 0), sub: `${compact(today?.tokens ?? 0)} tokens`, target: "list" },
    { key: "tokens", label: `tokens ${range}`, value: compact(tokens), sub: "in + out + cache", target: "models" },
    { key: "cache", label: "cache hit", value: percent(cacheHit), sub: "of prompt tokens", ratio: cacheHit, thresholds: { warn: 2, crit: 2 }, target: "models" },
    ...limitTiles(aiUsage),
  ];

  const option = (values: string[] | undefined, all: string) => [{ value: "", label: all }, ...(values ?? []).map((value) => ({ value, label: value }))];
  const dayFilter = query.from && query.to && query.to - query.from <= DAY + 3600_000 ? new Date(query.from).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }).toLowerCase() : null;

  return (
    <>
      <PageHeader title="sessions" meta={`${list.total.toLocaleString()} ${query.q || query.tool || query.model || query.project || query.machine || query.from ? "match" : "logged"} · prices from models.dev${list.pricesUpdatedAt ? `, ${since(list.pricesUpdatedAt)}` : ""}`}>
        <Tabs options={RANGES} value={range} onChange={(next) => setQuery({ range: next === "30d" ? null : next })} label="range" />
      </PageHeader>
      <div className="grid">
        <StatTiles tiles={tiles} label="ai usage" />
        <CostPanel usage={usage} range={range} onDay={(day) => setQuery({ from: dayStart(day), to: dayStart(day) + DAY })} />
        <ModelsPanel usage={inRange} onModel={(model) => setQuery({ model })} />
        <Panel id="list" title="sessions" meta={`${list.rows.length} of ${list.total}`} flush>
          <div className="box-pad">
            <FilterBar query={text} onQuery={setText} placeholder="search titles, projects, branches" className="session-filters">
              {dayFilter && (
                <button type="button" className="filter-chip" aria-pressed="true" onClick={() => setQuery({ from: null, to: null })}>
                  {dayFilter} ×
                </button>
              )}
              <Select label="tool" value={query.tool} onChange={(value) => setQuery({ tool: value })} options={option(facets?.tools, "all")} />
              <Select label="machine" value={query.machine} onChange={(value) => setQuery({ machine: value })} options={option(facets?.machines, "all")} />
              <Select label="project" value={query.project} onChange={(value) => setQuery({ project: value })} options={option(facets?.projects, "all")} />
              <Select label="model" value={query.model} onChange={(value) => setQuery({ model: value })} options={option(facets?.models, "all")} />
            </FilterBar>
          </div>
          {list.rows.length === 0 ? (
            <div className="box-pad">
              <Empty>{list.loading ? "loading…" : "no sessions match"}</Empty>
            </div>
          ) : (
            <ul className="sessions">
              <li className="session session-head" aria-hidden="true">
                <span>time</span>
                <span>session</span>
                <span>project</span>
                <span>tool</span>
                <span>model</span>
                <span className="right">tokens</span>
                <span className="right">cost</span>
              </li>
              {list.rows.map((row, index) => {
                const previous = list.rows[index - 1];
                const newDay = !previous || dayLabel(previous.startedAt) !== dayLabel(row.startedAt);
                return (
                  <Fragment key={row.id}>
                    {newDay && <li className="event-day session-day">{dayLabel(row.startedAt)}</li>}
                    <SessionRow row={row} />
                  </Fragment>
                );
              })}
            </ul>
          )}
          <div ref={more} className="log-more small muted">
            {list.rows.length < list.total ? (list.loading ? "loading more…" : "scroll for more") : list.rows.length ? "that's all" : ""} · cost is computed from tokens × stored prices; ≠ marks sessions
            where the tool reported a different amount (hover the cost to see it)
          </div>
        </Panel>
      </div>
    </>
  );
}
