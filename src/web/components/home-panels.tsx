import type { AppsStats, ContainerStats, DnsStats, GarageStats, HostInfo, InternetStats, JournalStats, KumaMonitor, MountStats, RangeHistory, SwitchStatus, UptimeStats, UsageItem, UsageStats } from "../../shared/types";
import { allServices, publicUrlOf } from "../lib/app-status";
import { bytes, compact, mbps, ms, percent, shortHost } from "../lib/format";
import { levelOf, QUOTA } from "../lib/level";
import { go, navigate } from "../lib/router";
import { clock, since } from "../lib/time";
import { DitherBars } from "./dither-bars";
import { HeatCell } from "./heat";
import { Meter } from "./meter";
import { BoxFoot, Empty, Link, Panel, Subhead } from "./panel";
import { Sparkline } from "./sparkline";
import { StatusSquare } from "./status-square";

/** `fri 13:00`: fits the column on a phone, unlike "yesterday 13:00". */
function shortStamp(ms: number): string {
  return `${new Date(ms).toLocaleDateString([], { weekday: "short" }).toLowerCase()} ${clock(ms)}`;
}

export function InternetPanel({ internet, link }: { internet: InternetStats; link: string | null }) {
  const latest = internet.latest;
  const recent = [...internet.history].reverse().slice(0, 5);
  return (
    <Panel id="internet" title="internet" span={6} meta={latest ? `${latest.isp?.toLowerCase() ?? "speedtest"} · tested ${since(Date.parse(latest.at))}` : "speedtest"} href={link ?? undefined}>
      {!latest ? (
        <Empty>no speed test yet · runs every 4 h</Empty>
      ) : (
        <>
          <div className="summary">
            <span>
              <span className="muted">↓</span> <span className="n-mbps">{mbps(latest.downBps)}</span>
            </span>
            <span>
              <span className="muted">↑</span> <span className="n-mbps">{mbps(latest.upBps)}</span>
            </span>
            <span>
              <span className="n-ms">{ms(latest.pingMs)}</span> <span className="muted">ping</span>
            </span>
          </div>
          <DitherBars
            values={internet.history.map((result) => result.downBps)}
            overlay={internet.history.map((result) => result.upBps)}
            overlayTone="secondary"
            height={40}
            format={(value) => mbps(value, 0)}
            label="download per test, upload drawn inside, last 7 days"
            labels={internet.history.map((result) => `${new Date(result.at).toLocaleDateString([], { weekday: "short" }).toLowerCase()} ${clock(Date.parse(result.at))}`)}
            describe={(index) => {
              const result = internet.history[index];
              return result ? `${clock(Date.parse(result.at))} · ↓ ${mbps(result.downBps)} · ↑ ${mbps(result.upBps)} · ${ms(result.pingMs)}` : "";
            }}
          />
          <table className="table table-compact">
            <colgroup>
              <col style={{ minWidth: "10ch" }} />
              <col style={{ width: "10ch" }} />
              <col style={{ width: "10ch" }} />
              <col style={{ width: "6ch" }} />
            </colgroup>
            <thead>
              <tr>
                <th>when</th>
                <th className="right">down</th>
                <th className="right">up</th>
                <th className="right">ping</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((result) => (
                <tr key={result.at}>
                  <td className="muted mono small">{shortStamp(Date.parse(result.at))}</td>
                  <td className="num right">{mbps(result.downBps)}</td>
                  <td className="num right muted">{mbps(result.upBps)}</td>
                  <td className="num right muted">{ms(result.pingMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

export function DnsPanel({ dns }: { dns: DnsStats }) {
  const ratio = dns.queries ? dns.blocked / dns.queries : 0;
  const hours = dns.hourlyQueries.length;
  return (
    <Panel id="dns" title="ad blocking" span={6} meta={dns.reachable ? (dns.protection ? `adguard on · ${percent(ratio)} blocked · ${ms(dns.avgMs)} avg` : <span className="level-crit">protection off</span>) : "adguard"}>
      {!dns.reachable ? (
        <Empty>adguard not reachable</Empty>
      ) : (
        <>
          <div className="summary">
            <span>
              <span className="n-count">{compact(dns.queries)}</span> <span className="muted">queries</span>
            </span>
            <span>
              <span className="n-count">{compact(dns.blocked)}</span> <span className="muted">blocked</span>
            </span>
          </div>
          <DitherBars
            values={dns.hourlyQueries}
            overlay={dns.hourlyBlocked}
            overlayTone="secondary"
            height={40}
            format={(value) => `${compact(value)} q`}
            label="queries per hour with blocked inside, last 24 hours"
            labels={dns.hourlyQueries.map((_, index) => (index === hours - 1 ? "now" : `−${hours - 1 - index}h`))}
            describe={(index) => `${index === hours - 1 ? "this hour" : `${hours - 1 - index}h ago`} · ${compact(dns.hourlyQueries[index] ?? 0)} queries · ${compact(dns.hourlyBlocked[index] ?? 0)} blocked`}
          />
          <Subhead>most blocked</Subhead>
          {dns.topBlocked.length === 0 ? (
            <Empty>nothing yet</Empty>
          ) : (
            <ul className="list">
              {dns.topBlocked.slice(0, 7).map((entry) => (
                <li className="line" key={entry.domain}>
                  <span className="ellipsis mono">{entry.domain}</span>
                  <span className="n-count muted">{compact(entry.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}

/** Where a space item lives: what keep-usage wrote, else the Dokploy service with that name, else its bucket. */
function urlFor(item: UsageItem, apps: AppsStats): string {
  if (item.url) return item.url;
  const names = [item.detail.toLowerCase(), item.label.toLowerCase()];
  const service = allServices(apps).find((candidate) => names.includes(candidate.name.toLowerCase()) && candidate.domains.length);
  if (service) return `https://${service.domains[0]}`;
  if (item.detail.includes("bucket")) return `/buckets?b=${encodeURIComponent(item.label)}`;
  return "/apps";
}

export function SpacePanel({ garage, usage, mounts, apps }: { garage: GarageStats; usage: UsageStats; mounts: MountStats[]; apps: AppsStats }) {
  const data = mounts.find((mount) => mount.path === "/srv");
  const free = data ? data.total - data.used : null;
  const items = usage.items ?? [];

  return (
    <Panel id="space" title="space" span={12} meta={free === null ? undefined : `${bytes(free)} free on /srv`}>
      <Subhead aside={usage.at ? `measured ${since(Date.parse(usage.at))}` : undefined}>apps</Subhead>
      {items.length === 0 ? (
        <Empty>measuring · every 30 min</Empty>
      ) : (
        <div className="space-grid">
          {items.map((item) => {
            const ratio = item.limit ? item.used / item.limit : 0;
            const level = levelOf(ratio, QUOTA);
            return (
              <HeatCell
                key={item.key}
                size={32}
                label={item.label}
                value={item.limit ? ratio : 0}
                tone={level === "normal" ? "ink" : level}
                notch={item.hard}
                href={urlFor(item, apps)}
                title={`${item.label} · ${item.detail} · ${bytes(item.used)}${item.limit ? ` of ${bytes(item.limit)} (${percent(ratio)})` : ""}${item.hard ? " · hard limit" : " · alert only"}`}
                text={
                  <>
                    <span className="n-bytes">{bytes(item.used)}</span>
                    <span className="muted">{item.limit ? `of ${bytes(item.limit)}` : "no limit"}</span>
                  </>
                }
              />
            );
          })}
        </div>
      )}
      <Subhead aside={<Link href="/buckets">browse buckets</Link>}>garage buckets · {garage.healthy === false ? <span className="level-crit">unreachable</span> : "healthy"}</Subhead>
      <div className="space-grid">
        {garage.buckets.map((bucket) => {
          const ratio = bucket.quotaBytes ? bucket.bytes / bucket.quotaBytes : 0;
          const level = levelOf(ratio, QUOTA);
          return (
            <HeatCell
              key={bucket.name}
              size={32}
              label={bucket.name}
              value={bucket.quotaBytes ? ratio : 0}
              tone={level === "normal" ? "ink" : level}
              notch={bucket.quotaBytes !== null}
              href={`/buckets?b=${encodeURIComponent(bucket.name)}`}
              title={`${bucket.name} · ${bucket.objects.toLocaleString()} objects · ${bytes(bucket.bytes)}${bucket.quotaBytes ? ` of ${bytes(bucket.quotaBytes)}` : ""}`}
              text={
                <>
                  <span className="n-bytes">{bytes(bucket.bytes)}</span>
                  <span className="muted">{bucket.quotaBytes ? `of ${bytes(bucket.quotaBytes)} · ${compact(bucket.objects)} obj` : `no quota · ${compact(bucket.objects)} obj`}</span>
                </>
              }
            />
          );
        })}
      </div>
      <BoxFoot>
        density = used / limit · orange from 80% · <span className="notch-key" aria-hidden="true" /> hard limit, the app refuses writes past it; the rest only alert
      </BoxFoot>
    </Panel>
  );
}

export const isSite = (monitor: KumaMonitor) => monitor.type !== "docker";

export function SitesPanel({ uptime, host, history, apps }: { uptime: UptimeStats; host: HostInfo; history: RangeHistory | null; apps: AppsStats }) {
  const sites = uptime.monitors.filter(isSite);
  const up = sites.filter((monitor) => monitor.status === 1).length;
  const dnsKnown = host.dnsIp !== null && host.publicIp !== null;
  const dnsOk = host.dnsIp === host.publicIp;

  return (
    <Panel id="sites" title="sites" span={12} meta={`${up}/${sites.length} up · kuma · 24 h`} href="/uptime">
      {!uptime.reachable ? (
        <Empty>uptime kuma not reachable</Empty>
      ) : (
        <ul className="sites">
          {sites.map((monitor) => {
            const url = publicUrlOf(monitor, apps);
            const day = monitor.uptime1d;
            const square = monitor.status === 0 ? "down" : day !== null && day < 0.99 ? "warn" : monitor.status === 1 ? "ok" : "none";
            const series = history?.series[`kuma:${monitor.id}:ms`];
            return (
              <li key={monitor.id} className={`site${url ? " row-target" : ""}`}>
                <StatusSquare status={square} label={`${monitor.status === 1 ? "up now" : monitor.status === 0 ? "down now" : "pending"}${day !== null ? ` · ${(day * 100).toFixed(2)}% over 24h` : ""}`} />
                {url ? (
                  <a className="site-name ellipsis" href={url} target="_blank" rel="noreferrer">
                    {monitor.name}
                  </a>
                ) : (
                  <span className="site-name ellipsis">{monitor.name}</span>
                )}
                <span className={`site-host${url ? "" : " muted"}`}>
                  <span className={url ? "link ellipsis" : "ellipsis"}>{url ? shortHost(url) : monitor.url ? `${shortHost(monitor.url)} · internal` : monitor.type}</span>
                  {url && <span className="arrow">↗</span>}
                </span>
                <span className="site-spark">
                  {series ? <Sparkline values={series.avg} capacity={series.avg.length} stepSec={history?.stepSec ?? 300} format={ms} height={16} label={`${monitor.name} response, 24h`} bare robust /> : null}
                </span>
                <span className="n-ms">{ms(monitor.responseMs)}</span>
                <span className={`n-pct2 ${day !== null && day < 0.99 ? "level-warn" : "muted"}`}>{day === null ? "—" : `${(day * 100).toFixed(2)}%`}</span>
              </li>
            );
          })}
          <li className="site">
            <StatusSquare status={!dnsKnown ? "none" : dnsOk ? "ok" : "down"} />
            <span className="site-name">dns</span>
            <span className="site-host muted">
              <span className="ellipsis">home → {host.dnsIp ?? "—"}</span>
            </span>
            <span className="site-spark" />
            <span className="muted site-wide">{!dnsKnown ? "checking" : dnsOk ? "matches public ip" : `public ${host.publicIp}`}</span>
          </li>
        </ul>
      )}
    </Panel>
  );
}

interface Problem {
  text: string;
  /** Crit for a crash or failing health check; a clean exit or an app asleep on purpose is just information. */
  serious: boolean;
}

function problem(container: ContainerStats, switches: SwitchStatus[]): Problem | null {
  if (container.state === "running") return container.health === "unhealthy" ? { text: "unhealthy", serious: true } : null;
  const asleep = switches.some((app) => !app.running && container.name.toLowerCase().includes(app.name.toLowerCase()));
  if (asleep) return { text: "asleep, wakes on demand", serious: false };
  const code = /\((\d+)\)/.exec(container.status)?.[1];
  return { text: container.status.toLowerCase(), serious: code !== undefined && code !== "0" };
}

/** Docker's own view: catches what Dokploy doesn't manage. Problems only, then the heaviest. */
export function ContainersPanel({ containers, switches }: { containers: ContainerStats[]; switches: SwitchStatus[] }) {
  const running = containers.filter((container) => container.state === "running").length;
  const issues = containers.map((container) => ({ container, issue: problem(container, switches) })).filter((entry): entry is { container: ContainerStats; issue: Problem } => entry.issue !== null);
  const serious = issues.filter((entry) => entry.issue.serious).length;
  const heaviest = [...containers].filter((c) => c.state === "running").sort((a, b) => b.memBytes - a.memBytes).slice(0, 5);

  return (
    <Panel id="containers" title="containers" span={6} meta={`${running}/${containers.length} running`} href="/apps">
      <Meter value={containers.length ? running / containers.length : 0} thresholds={{ warn: 2, crit: 2 }} label="containers running" />
      <p className="small muted">
        <span className="num">{running}</span> running · <span className={serious ? "level-crit" : ""}>{serious} failing</span> · <span className="num">{containers.length - running}</span> stopped
      </p>
      <Subhead>not running</Subhead>
      {issues.length === 0 ? (
        <p className="small muted">nothing · all healthy</p>
      ) : (
        <ul className="list">
          {issues.slice(0, 5).map(({ container, issue }) => (
            <li className="line" key={container.id}>
              <span className="ellipsis">
                <StatusSquare status={issue.serious ? "down" : "none"} /> {container.name}
              </span>
              <span className={`small ellipsis ${issue.serious ? "level-crit" : "muted"}`}>{issue.text}</span>
            </li>
          ))}
        </ul>
      )}
      <Subhead>top by memory</Subhead>
      <ul className="list">
        {heaviest.map((container) => (
          <li className="line" key={container.id}>
            <a className="link ellipsis" href={`/apps?q=${encodeURIComponent(container.project ?? container.name)}`} onClick={navigate}>
              {container.name}
            </a>
            <span className="n-bytes muted">{bytes(container.memBytes)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

const hourStart = (at: number) => (at > 1e12 ? at : at * 1000);

/** How much the system writes to its journal, and who; every bar and source opens the logs page. */
export function JournalPanel({ journal }: { journal: JournalStats }) {
  const lastHour = journal.hours.at(-1)?.lines ?? 0;
  const errors = journal.hours.reduce((sum, hour) => sum + hour.errors, 0);
  const openHour = (index: number) => {
    const hour = journal.hours[index];
    if (!hour) return;
    const from = Math.floor(hourStart(hour.at) / 1000);
    go(`/logs?since=${from}&until=${from + 3600}`);
  };

  return (
    <Panel
      id="logs"
      title="system log"
      span={6}
      href="/logs"
      meta={journal.at === null ? "not collected" : `${compact(lastHour / 60)} lines/min${journal.diskBytes !== null ? ` · ${bytes(journal.diskBytes)}${journal.capBytes ? ` / ${bytes(journal.capBytes)}` : ""}` : ""}`}
    >
      {journal.hours.length === 0 ? (
        <Empty>journal summary not available</Empty>
      ) : (
        <>
          <DitherBars
            values={journal.hours.map((hour) => hour.lines)}
            overlay={journal.hours.map((hour) => hour.errors)}
            height={48}
            format={compact}
            label="log lines per hour with errors, last 24 hours; pick an hour to open it"
            labels={journal.hours.map((hour) => clock(hourStart(hour.at)))}
            describe={(index) => {
              const hour = journal.hours[index];
              return hour ? `${clock(hourStart(hour.at))} · ${compact(hour.lines)} lines · ${compact(hour.errors)} errors` : "";
            }}
            onPick={openHour}
          />
          <p className="small muted">
            last 24 h · {compact(journal.hours.reduce((sum, hour) => sum + hour.lines, 0))} lines · {compact(errors)} errors
          </p>
          <Subhead>loudest last hour</Subhead>
          <ul className="list loudest">
            {journal.top.slice(0, 6).map((source) => (
              <li className="line" key={source.source}>
                <a className="link mono ellipsis" href={`/logs?source=${encodeURIComponent(source.source)}`} onClick={navigate}>
                  {source.source}
                </a>
                <span className="n-count muted">{compact(source.lines)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

