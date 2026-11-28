import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityPayload } from "../../shared/types";
import { Chip } from "../components/chip";
import { CopyValue } from "../components/copy-value";
import { FilterBar } from "../components/filter-bar";
import { HeatMatrix } from "../components/heat";
import { PageHeader, Tabs } from "../components/page-header";
import { Empty, Panel, Subhead } from "../components/panel";
import { StatusSquare } from "../components/status-square";
import { browserOf, whoIs } from "../lib/devices";
import { bytes } from "../lib/format";
import { buildTimeline, groupTimeline, summarize, type TimelineEvent, type TimelineRow } from "../lib/timeline";
import { clock, dayLabel, since, until } from "../lib/time";
import { useActivity } from "../lib/use-activity";
import { useWidth } from "../components/dither";
import { PHONE, useMedia } from "../lib/use-media";

const PAGE_ROWS = 80;
const FILTERS = ["all", "logins", "failed", "commands", "deploys", "system"] as const;
type Filter = (typeof FILTERS)[number];
const DAY = 86_400_000;

function matches(event: TimelineEvent, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "failed") return event.kind === "failed login";
  return event.filter === filter;
}

function NowPanel({ data }: { data: ActivityPayload }) {
  const who = (ip: string | null) => whoIs(ip, data.devices, data.publicIp);
  const signedIn = data.dokploySessions.filter((session) => Date.parse(session.expiresAt) > Date.now());
  const expired = data.dokploySessions.length - signedIn.length;
  const viewers = data.viewers.filter((viewer) => viewer.live || Date.now() - viewer.lastSeen < 3600_000);
  const total = data.openSessions.length + signedIn.length + viewers.filter((viewer) => viewer.live).length;
  return (
    <Panel id="now" title="now" meta={`${total} connected`}>
      <Subhead>ssh</Subhead>
      {data.openSessions.length === 0 ? (
        <p className="small muted">no open sessions</p>
      ) : (
        <ul className="people">
          {data.openSessions.map((session) => {
            const source = who(session.source);
            return (
              <li key={session.id}>
                <span className="ellipsis">
                  {session.user} <span className="muted">· {source.name}</span>
                </span>
                <span className="muted small">
                  {source.via} · open {session.since ? since(session.since * 1000).replace(" ago", "") : "—"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Subhead aside={expired && signedIn.length ? `+${expired} expired` : undefined}>dokploy</Subhead>
      {signedIn.length === 0 ? (
        <p className="small muted">nobody signed in</p>
      ) : (
        <ul className="people">
          {signedIn.map((session) => {
            const source = who(session.ip);
            return (
              <li key={session.id}>
                <span className="ellipsis">
                  {session.email} <span className="muted">· {source.name}</span>
                </span>
                <span className="muted small">
                  {browserOf(session.userAgent)} · expires {until(Date.parse(session.expiresAt))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Subhead>this dashboard · last hour</Subhead>
      {viewers.length === 0 ? (
        <p className="small muted">nobody</p>
      ) : (
        <ul className="people">
          {viewers.map((viewer) => {
            const source = who(viewer.ip);
            return (
              <li key={viewer.ip}>
                <span className="ellipsis">
                  {source.name} {viewer.live && <Chip tone="solid">live</Chip>}
                </span>
                <span className="muted small">
                  {source.via} · {browserOf(viewer.userAgent)}
                  {!viewer.live && ` · ${since(viewer.lastSeen)}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function DevicesPanel({ data }: { data: ActivityPayload }) {
  const online = data.devices.filter((device) => device.online).length;
  const lanOnline = data.networkDevices.filter((device) => device.online).length;
  return (
    <Panel id="devices" title="devices" meta={`${online} on tailnet · ${lanOnline} on lan`}>
      <Subhead aside={`${data.devices.length}`}>tailnet</Subhead>
      <ul className="devices">
        {data.devices.map((device) => (
          <li key={device.name} title={device.self ? undefined : `in ${bytes(device.rxBytes)} · out ${bytes(device.txBytes)} · ${device.route}`}>
            <StatusSquare status={device.online ? "ok" : "none"} label={device.online ? "online" : "offline"} />
            <span className="ellipsis">
              {device.name} <span className="muted small">{device.self ? "this server" : device.os.toLowerCase()}</span>
            </span>
            <CopyValue value={device.tailscaleIp} />
            <span className="muted small device-seen">{device.online ? (device.self ? "" : device.route.split(" ")[0]) : device.lastSeen ? since(Date.parse(device.lastSeen)) : "—"}</span>
          </li>
        ))}
      </ul>
      <Subhead aside={`${data.networkDevices.length} seen`}>lan</Subhead>
      {data.networkDevices.length === 0 ? (
        <p className="small muted">no lan scan yet</p>
      ) : (
        <ul className="devices">
          {data.networkDevices.map((device) => {
            // The scan names unknown devices by their MAC; say so instead of printing it twice.
            const unnamed = !device.name || device.name === device.mac;
            return (
              <li key={device.ip} title={device.mac ? `mac ${device.mac}` : undefined}>
                <StatusSquare status={device.online ? "ok" : "none"} label={device.online ? "online" : "offline"} />
                <span className={`ellipsis${unnamed ? " muted" : ""}`}>{unnamed ? "unnamed device" : device.name}</span>
                <CopyValue value={device.ip} />
                <span className="muted small device-seen">{device.storage ? `${bytes(device.storage.used)} used` : ""}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function Row({ row, showKind }: { row: TimelineRow; showKind: boolean }) {
  const [open, setOpen] = useState(false);
  const { first, events } = row;
  const folded = events.length > 1;
  const last = events.at(-1) ?? first;
  const kinds = new Set(events.map((event) => event.kind));
  return (
    <>
      <li className={`event${folded ? " is-folded" : ""}`}>
        <span className="event-time">{folded && clock(last.at) !== clock(first.at) ? `${clock(last.at)}–${clock(first.at)}` : clock(first.at)}</span>
        <span className="event-kind">
          {(showKind || first.tone !== "plain" || folded) && <Chip tone={first.tone === "solid" ? "plain" : first.tone}>{kinds.size > 1 ? "session" : first.kind}</Chip>}
          {folded && <span className="event-count">×{events.length}</span>}
        </span>
        <span className="event-who ellipsis">
          {first.who}
          {first.via && <span className="muted"> · {first.via}</span>}
        </span>
        <span className="event-what ellipsis" title={first.what}>
          {folded ? summarize(events) : first.what}
        </span>
        <span className="event-ref">
          {folded ? (
            <button type="button" className="pin" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "▾" : "▸"}
            </button>
          ) : first.ref ? (
            <CopyValue value={first.ref} display="⧉" />
          ) : null}
        </span>
      </li>
      {open &&
        events.map((event, index) => (
          <li key={index} className="event is-child">
            <span className="event-time">{clock(event.at)}</span>
            <span className="event-kind">{showKind && <Chip tone={event.tone === "solid" ? "plain" : event.tone}>{event.kind}</Chip>}</span>
            <span className="event-who ellipsis muted">{event.who}</span>
            <span className="event-what ellipsis" title={event.what}>
              {event.what}
            </span>
            <span className="event-ref">{event.ref && <CopyValue value={event.ref} display="⧉" />}</span>
          </li>
        ))}
    </>
  );
}

function Timeline({ data, phone }: { data: ActivityPayload; phone: boolean }) {
  const [box, width] = useWidth<HTMLDivElement>();
  // 24 hour columns plus the 40 px day labels fill the box; 2 px gaps.
  const cell = Math.max(10, Math.min(phone ? 12 : 32, Math.floor((width - 40) / 24) - 2));
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [hour, setHour] = useState<[number, number] | null>(null);
  const [limit, setLimit] = useState(PAGE_ROWS);
  const more = useRef<HTMLLIElement>(null);
  const events = useMemo(() => buildTimeline(data), [data]);

  // Rows are days, newest at the top; columns are hours of the local day.
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Array.from({ length: 7 }, (_, index) => midnight - index * DAY);
  const matrix = days.map((start) =>
    Array.from({ length: 24 }, (_, h) => (start + h * 3600_000 > Date.now() ? null : events.filter((event) => event.at >= start + h * 3600_000 && event.at < start + (h + 1) * 3600_000).length)),
  );

  const needle = query.trim().toLowerCase();
  const slot = hour ? [(days[hour[0]] ?? 0) + hour[1] * 3600_000, (days[hour[0]] ?? 0) + (hour[1] + 1) * 3600_000] : null;
  const shown = events
    .filter((event) => matches(event, filter))
    .filter((event) => !needle || `${event.who} ${event.what} ${event.ref ?? ""} ${event.kind}`.toLowerCase().includes(needle))
    .filter((event) => !slot || (event.at >= (slot[0] ?? 0) && event.at < (slot[1] ?? 0)));
  const rows = groupTimeline(shown);
  const visible = rows.slice(0, limit);
  const count = (f: Filter) => events.filter((event) => matches(event, f)).length;
  const failed = count("failed");

  useEffect(() => setLimit(PAGE_ROWS), [filter, needle, hour]);
  useEffect(() => {
    const node = more.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && setLimit((current) => current + PAGE_ROWS), { rootMargin: "400px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible.length, rows.length]);

  return (
    <Panel
      id="timeline"
      title="timeline"
      meta={
        <>
          {events.length} events · 7 days{failed > 0 && <span className="level-crit"> · {failed} failed logins</span>}
        </>
      }
    >
      <div ref={box} className="matrix-fit">
      <HeatMatrix
        matrix={matrix}
        rowLabels={days.map((start, index) => (index === 0 ? "today" : new Date(start).toLocaleDateString([], { weekday: "short" }).toLowerCase()))}
        columnLabels={Array.from({ length: 24 }, (_, h) => (h % 3 === 0 ? String(h).padStart(2, "0") : ""))}
        cell={cell}
        tip={(r, c) => {
          const value = matrix[r]?.[c];
          return `${dayLabel(days[r] ?? 0)} ${String(c).padStart(2, "0")}:00 · ${value === null ? "later today" : `${value} events`}${hour ? "" : " · click to filter"}`;
        }}
        picked={hour}
        onPick={(r, c) => setHour(hour && hour[0] === r && hour[1] === c ? null : [r, c])}
        label="events per hour, last 7 days"
        format={(value) => String(Math.round(value))}
      />
      </div>
      <FilterBar
        query={query}
        onQuery={setQuery}
        placeholder="search who, what, ref"
        value={filter}
        onChange={(value) => setFilter(value as Filter)}
        options={FILTERS.filter((f) => f !== "failed" || failed > 0).map((f) => ({ value: f, label: f, count: count(f), tone: f === "failed" ? "crit" : undefined }))}
      >
        {hour && (
          <button type="button" className="filter-chip" aria-pressed="true" onClick={() => setHour(null)}>
            {dayLabel(days[hour[0]] ?? 0)} {String(hour[1]).padStart(2, "0")}:00 ×
          </button>
        )}
      </FilterBar>
      {rows.length === 0 ? (
        <Empty>nothing matches</Empty>
      ) : (
        <ul className="events">
          {visible.map((row, index) => {
            const previous = visible[index - 1];
            const newDay = !previous || dayLabel(previous.first.at) !== dayLabel(row.first.at);
            return (
              <Fragment key={`${row.first.group}-${row.first.at}`}>
                {newDay && <li className="event-day">{dayLabel(row.first.at)}</li>}
                <Row row={row} showKind={filter === "all"} />
              </Fragment>
            );
          })}
          {visible.length < rows.length && (
            <li ref={more} className="event-more small muted">
              loading {Math.min(PAGE_ROWS, rows.length - visible.length)} more…
            </li>
          )}
        </ul>
      )}
    </Panel>
  );
}

const TABS = ["timeline", "now", "devices"] as const;

export function ActivityPage() {
  const data = useActivity();
  const phone = useMedia(PHONE);
  const [tab, setTab] = useState<(typeof TABS)[number]>("timeline");
  if (!data) return <PageHeader title="activity" meta="loading…" />;
  return (
    <>
      <PageHeader title="activity" meta={`host log read ${data.updatedAt ? since(Date.parse(data.updatedAt)) : "never"}`}>
        {phone && <Tabs options={TABS} value={tab} onChange={setTab} label="section" />}
      </PageHeader>
      <div className="grid">
        {(!phone || tab !== "timeline") && (
          <div className="column column-4 column-plain">
            {(!phone || tab === "now") && <NowPanel data={data} />}
            {(!phone || tab === "devices") && <DevicesPanel data={data} />}
          </div>
        )}
        {(!phone || tab === "timeline") && (
          <div className="column column-8">
            <Timeline data={data} phone={phone} />
          </div>
        )}
      </div>
    </>
  );
}
