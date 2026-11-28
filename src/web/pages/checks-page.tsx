import { useEffect, useState } from "react";
import { PageHeader, Tabs } from "../components/page-header";
import { Empty, Panel } from "../components/panel";
import { StatusSquare, type Status } from "../components/status-square";
import { UptimeStrip } from "../components/uptime-strip";
import { since } from "../lib/time";
import { setQuery, useSearch } from "../lib/router";
import { PHONE, useMedia } from "../lib/use-media";

/** What host/keep-bot.py writes to <data>/healthchecks.json from the healthchecks.io API every 10 minutes. */
interface Ping {
  n: number;
  type: "success" | "fail" | "start" | "log" | "ign";
  date: string;
  duration?: number | null;
}
interface Check {
  name: string;
  slug: string | null;
  desc: string | null;
  status: "up" | "down" | "grace" | "new" | "paused" | "started";
  timeout: number | null;
  grace: number | null;
  nPings: number;
  lastPing: string | null;
  nextPing: string | null;
  pings: Ping[];
  flips: { timestamp: string; up: number }[];
}
interface Payload {
  updatedAt: number;
  checks: Check[];
}

const RANGES = ["24h", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];
const SPAN: Record<Range, number> = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };

const STATUS: Record<Check["status"], Status> = { up: "ok", started: "ok", new: "warn", grace: "warn", paused: "warn", down: "down" };

function period(seconds: number | null): string {
  if (!seconds) return "—";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

/** Share of each bucket the check was up, from its flips (status changes); null before the first known state. */
function strip(check: Check, start: number, end: number, count: number): (number | null)[] {
  const flips = check.flips.map((flip) => ({ at: Date.parse(flip.timestamp) / 1000, up: flip.up === 1 })).sort((a, b) => a.at - b.at);
  const step = (end - start) / count;
  return Array.from({ length: count }, (_, index) => {
    const from = start + index * step;
    const to = from + step;
    let state = [...flips].reverse().find((flip) => flip.at <= from)?.up ?? (flips.length ? null : check.status !== "new" ? true : null);
    let cursor = from;
    let upFor = 0;
    let known = 0;
    for (const flip of flips.filter((f) => f.at > from && f.at < to)) {
      if (state !== null) {
        known += flip.at - cursor;
        if (state) upFor += flip.at - cursor;
      }
      state = flip.up;
      cursor = flip.at;
    }
    if (state !== null) {
      known += to - cursor;
      if (state) upFor += to - cursor;
    }
    return known ? upFor / known : null;
  });
}

function useHealthchecks(): Payload | null | "missing" {
  const [data, setData] = useState<Payload | null | "missing">(null);
  useEffect(() => {
    let current = true;
    const load = () =>
      fetch("/api/healthchecks")
        .then((response) => (response.ok ? response.json() : "missing"))
        .then((payload) => current && setData(payload))
        .catch(() => current && setData("missing"));
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, []);
  return data;
}

function CheckRow({ check, range, count }: { check: Check; range: Range; count: number }) {
  const end = Date.now() / 1000;
  const start = end - SPAN[range];
  const values = strip(check, start, end, count);
  const step = SPAN[range] / count;
  const recent = check.pings.filter((ping) => Date.parse(ping.date) / 1000 >= start);
  const fails = recent.filter((ping) => ping.type === "fail").length;
  const successes = recent.filter((ping) => ping.type === "success").length;
  const ratio = successes + fails ? successes / (successes + fails) : null;
  return (
    <li className="check">
      <StatusSquare status={STATUS[check.status] ?? "warn"} label={check.status} />
      <span className="check-name">
        <span className="ellipsis">{check.name}</span>
        <span className="check-host muted ellipsis" title={check.desc ?? undefined}>
          every {period(check.timeout)} · grace {period(check.grace)}
        </span>
      </span>
      <span className="check-strip">
        <UptimeStrip
          values={values}
          label={`${check.name}, healthy share per bucket`}
          describe={(index) => {
            const from = (start + index * step) * 1000;
            const to = from + step * 1000;
            const inside = check.pings.filter((ping) => Date.parse(ping.date) >= from && Date.parse(ping.date) < to);
            return (
              <>
                <span className="muted">{new Date(from).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).toLowerCase()}</span>{" "}
                {values[index] === null ? "no data" : values[index] === 1 ? "healthy" : `${Math.round((values[index] ?? 0) * 100)}% healthy`}
                {inside.length > 0 && (
                  <span className="tip-line">
                    {inside.filter((p) => p.type === "success").length} ok · {inside.filter((p) => p.type === "fail").length} failed pings
                  </span>
                )}
              </>
            );
          }}
        />
      </span>
      <span className="check-speed">
        <span className="n-ms" title={`${check.nPings} pings in total`}>
          {recent.length >= 100 ? "100+" : recent.length} pings
        </span>
      </span>
      <span className={`check-ratio n-pct2 ${fails ? "level-crit" : ""}`} title={`${successes} ok, ${fails} failed in the last ${range} (from the last 100 pings)`}>
        {ratio === null ? "—" : `${Math.round(ratio * 100)}%`}
      </span>
      <span className={`check-cert n-temp ${check.status === "down" ? "level-crit" : ""}`} title={check.lastPing ?? "never pinged"}>
        {check.lastPing ? since(Date.parse(check.lastPing)) : "never"}
      </span>
    </li>
  );
}

export function ChecksPage() {
  const data = useHealthchecks();
  const search = useSearch();
  const range = (RANGES as readonly string[]).includes(search.get("range") ?? "") ? (search.get("range") as Range) : "7d";
  const phone = useMedia(PHONE);
  const count = phone ? 36 : 72;

  if (data === null) return <PageHeader title="checks" meta="loading" />;
  if (data === "missing")
    return (
      <>
        <PageHeader title="checks" />
        <Panel title="healthchecks.io">
          <Empty>no data yet. keep-bot writes it every 10 minutes once HC_API_KEY is in /etc/keep/bot.env</Empty>
        </Panel>
      </>
    );

  const checks = [...data.checks].sort(
    (a, b) => Number(b.status === "down") - Number(a.status === "down") || (a.timeout ?? 0) - (b.timeout ?? 0) || a.name.localeCompare(b.name),
  );
  const down = checks.filter((check) => check.status === "down");
  const pings = checks.reduce((sum, check) => sum + check.nPings, 0);
  return (
    <>
      <PageHeader
        title="checks"
        meta={
          <>
            <span className={down.length ? "level-crit" : ""}>
              {checks.length - down.length}/{checks.length} on time
            </span>{" "}
            · {pings.toLocaleString()} pings · watched from outside by healthchecks.io · alerts in telegram · updated {since(data.updatedAt * 1000)}
          </>
        }
      >
        <Tabs options={RANGES} value={range} onChange={(next) => setQuery({ range: next === "7d" ? null : next })} label="range" />
        <a className="button button-quiet hide-phone" href="https://healthchecks.io/" target="_blank" rel="noreferrer">
          healthchecks.io ↗
        </a>
      </PageHeader>
      <div className="grid">
        <Panel title="heartbeats and jobs" meta={`${checks.length} checks`} flush>
          {checks.length === 0 ? (
            <div className="box-pad">
              <Empty>no checks yet</Empty>
            </div>
          ) : (
            <ul className="checks">
              <li className="check check-head" aria-hidden="true">
                <span />
                <span>check</span>
                <span>{range} · oldest left</span>
                <span className="right">pings</span>
                <span className="right">ok</span>
                <span className="right">last</span>
              </li>
              {checks.map((check) => (
                <CheckRow key={check.slug ?? check.name} check={check} range={range} count={count} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
