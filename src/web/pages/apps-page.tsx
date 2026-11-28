import { useState } from "react";
import type { AppProject, AppService, AppsStats, SwitchStatus } from "../../shared/types";
import { Chip } from "../components/chip";
import { CleanupPanel } from "../components/cleanup-panel";
import { FilterBar, Select } from "../components/filter-bar";
import { Meter } from "../components/meter";
import { PageHeader } from "../components/page-header";
import { Empty, Panel } from "../components/panel";
import { StatusSquare } from "../components/status-square";
import { descriptionFor } from "../lib/app-descriptions";
import { appStatus, isAsleep, needsAttention } from "../lib/app-status";
import { bytes, duration, percent } from "../lib/format";
import { setQuery, useSearch } from "../lib/router";
import { since } from "../lib/time";

const PINS_KEY = "keep:apps:pins";
const DEFAULT_PINS = ["infrastructure", "games"];
const DATABASES = new Set(["postgres", "redis", "mysql", "mariadb", "mongo", "libsql"]);
/** Memory meters are drawn against this unless the app is bigger. */
const MEM_SCALE = 2 * 1024 ** 3;

const STATUS_TEXT: Record<string, string> = { done: "deployed", running: "deploying", idle: "not deployed", error: "failed" };

interface Entry {
  service: AppService;
  project: AppProject;
  environment: string;
  preview: boolean;
  pr: string | null;
}

const took = (seconds: number) => (seconds >= 60 ? duration(seconds) : `${Math.round(seconds)}s`);

function readPins(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(PINS_KEY) ?? "null");
    return Array.isArray(value) ? value : DEFAULT_PINS;
  } catch {
    return DEFAULT_PINS;
  }
}

/** Previews and staging: non-production environments, `*-previews` / `*-staging` projects, or PR-numbered services. */
function isPreview(project: AppProject, environment: string, service: AppService): boolean {
  return environment !== "production" || /previews?$|staging/i.test(project.name) || /(^|-)pr-\d+|preview|staging/i.test(service.name);
}

function entries(apps: AppsStats): Entry[] {
  return apps.projects.flatMap((project) =>
    project.environments.flatMap((environment) =>
      environment.services.map((service) => ({
        service,
        project,
        environment: environment.name,
        preview: isPreview(project, environment.name, service),
        pr: /pr-(\d+)/i.exec(service.name)?.[1] ?? null,
      })),
    ),
  );
}

function Domains({ domains }: { domains: string[] }) {
  const [open, setOpen] = useState(false);
  const [first, ...rest] = domains;
  if (!first) return <span className="muted small">no domain</span>;
  return (
    <span className="card-domains">
      <a className="link ellipsis" href={`https://${first}`} target="_blank" rel="noreferrer">
        {first}
        <span className="arrow">↗</span>
      </a>
      {rest.length > 0 && (
        <button type="button" className="chip chip-button" aria-expanded={open} onClick={() => setOpen(!open)}>
          +{rest.length}
        </button>
      )}
      {open && (
        <span className="popover" role="dialog" aria-label="all domains">
          {domains.map((domain) => (
            <a key={domain} className="link" href={`https://${domain}`} target="_blank" rel="noreferrer">
              {domain}
              <span className="arrow">↗</span>
            </a>
          ))}
        </span>
      )}
    </span>
  );
}

function AppCard({ entry, asleep }: { entry: Entry; asleep: boolean }) {
  const { service } = entry;
  const status = asleep ? "none" : appStatus(service);
  const deploy = service.lastDeploy;
  const failed = deploy?.status === "error";
  const description = descriptionFor(service.name) ?? (entry.pr ? `pull request #${entry.pr} preview` : null);
  const memMax = Math.max(MEM_SCALE, service.memBytes);
  return (
    <article className="card">
      <div className="card-head">
        <StatusSquare status={status} label={`${service.running}/${service.total} running`} />
        <a className="card-name ellipsis" href={service.url} target="_blank" rel="noreferrer" title="open in dokploy">
          {service.name}
        </a>
        <span className="card-count muted">
          {service.running}/{service.total}
        </span>
        <Chip>{service.kind}</Chip>
      </div>
      <Domains domains={service.domains} />
      <div className="meter-row">
        <span className="muted">cpu</span>
        <Meter value={service.cpu} label={`${service.name} cpu`} />
        <span className="n-pct">{percent(service.cpu)}</span>
      </div>
      <div className="meter-row meter-row-wide">
        <span className="muted">mem</span>
        <Meter value={service.memBytes / memMax} thresholds={{ warn: 2, crit: 2 }} label={`${service.name} memory`} />
        <span className="n-bytes">{bytes(service.memBytes)}</span>
      </div>
      <div className={`card-deploy small ${failed ? "level-crit" : "muted"}`} title={deploy?.title}>
        {asleep ? "asleep · start it from jobs" : deploy ? `${STATUS_TEXT[deploy.status] ?? deploy.status} ${since(Date.parse(deploy.at))}${deploy.durationSec ? ` · took ${took(deploy.durationSec)}` : ""}` : "never deployed"}
      </div>
      <div className="card-desc small ellipsis">{description ?? " "}</div>
    </article>
  );
}

function DbCard({ entry }: { entry: Entry }) {
  const { service } = entry;
  return (
    <article className="card card-db">
      <div className="card-head">
        <StatusSquare status={service.total === 0 ? "none" : appStatus(service)} />
        <a className="card-name ellipsis" href={service.url} target="_blank" rel="noreferrer">
          {service.name}
        </a>
        <Chip>{service.kind}</Chip>
      </div>
      <span className="small muted">{service.memBytes ? `${bytes(service.memBytes)} · ` : ""}{service.total === 0 ? "no container" : `${service.running}/${service.total} running`}</span>
    </article>
  );
}

function Cards({ items, switches }: { items: Entry[]; switches: SwitchStatus[] }) {
  const apps = items.filter((entry) => !DATABASES.has(entry.service.kind));
  const dbs = items.filter((entry) => DATABASES.has(entry.service.kind));
  return (
    <>
      {apps.length > 0 && (
        <div className="cards">
          {apps.map((entry) => (
            <AppCard key={entry.service.id} entry={entry} asleep={isAsleep(entry.service, switches)} />
          ))}
        </div>
      )}
      {dbs.length > 0 && (
        <div className="cards cards-db">
          {dbs.map((entry) => (
            <DbCard key={entry.service.id} entry={entry} />
          ))}
        </div>
      )}
    </>
  );
}

const FILTERS = ["all", "running", "failing", "asleep", "previews"] as const;
type Filter = (typeof FILTERS)[number];
const SORTS: Record<string, (a: Entry, b: Entry) => number> = {
  name: (a, b) => a.service.name.localeCompare(b.service.name),
  status: (a, b) => rank(a) - rank(b) || a.service.name.localeCompare(b.service.name),
  cpu: (a, b) => b.service.cpu - a.service.cpu,
  memory: (a, b) => b.service.memBytes - a.service.memBytes,
  deploy: (a, b) => Date.parse(b.service.lastDeploy?.at ?? "0") - Date.parse(a.service.lastDeploy?.at ?? "0"),
};
const rank = (entry: Entry) => ({ down: 0, warn: 1, none: 2, ok: 3 })[appStatus(entry.service)];

/** A project box is as wide as its cards need (3 columns per card, up to the full row). */
function spanFor(items: Entry[]): 3 | 6 | 9 | 12 {
  const cards = items.filter((entry) => !DATABASES.has(entry.service.kind)).length || Math.ceil(items.length / 2);
  return cards >= 4 ? 12 : cards === 3 ? 9 : cards === 2 ? 6 : 3;
}

export function AppsPage({ apps, switches }: { apps: AppsStats; switches: SwitchStatus[] }) {
  const search = useSearch();
  const [query, setText] = useState(search.get("q") ?? "");
  const [pins, setPins] = useState<string[]>(readPins);
  const [showPreviews, setShowPreviews] = useState(false);
  const filter: Filter = (FILTERS as readonly string[]).includes(search.get("f") ?? "") ? (search.get("f") as Filter) : "all";
  const sort = search.get("sort") && SORTS[search.get("sort") ?? ""] ? (search.get("sort") as string) : "name";
  const flat = search.get("group") === "none";

  const all = entries(apps);
  const counts = {
    all: all.length,
    running: all.filter((entry) => appStatus(entry.service) === "ok").length,
    failing: all.filter((entry) => needsAttention(entry.service, switches)).length,
    asleep: all.filter((entry) => isAsleep(entry.service, switches)).length,
    previews: all.filter((entry) => entry.preview).length,
  };
  const needle = query.trim().toLowerCase();
  const matches = all
    .filter((entry) => {
      if (filter === "running") return appStatus(entry.service) === "ok";
      if (filter === "failing") return needsAttention(entry.service, switches);
      if (filter === "asleep") return isAsleep(entry.service, switches);
      if (filter === "previews") return entry.preview;
      return true;
    })
    .filter((entry) => {
      if (!needle) return true;
      const haystack = [entry.service.name, entry.project.name, descriptionFor(entry.service.name) ?? "", ...entry.service.domains].join(" ").toLowerCase();
      return haystack.includes(needle);
    })
    .sort(SORTS[sort]);

  const togglePin = (name: string) => {
    const key = name.toLowerCase();
    const next = pins.includes(key) ? pins.filter((pin) => pin !== key) : [...pins, key];
    setPins(next);
    try {
      localStorage.setItem(PINS_KEY, JSON.stringify(next));
    } catch {
      // Pins are a convenience only.
    }
  };

  // Previews get their own group unless that's what the filter asks for.
  const groupPreviews = filter !== "previews" && !needle;
  const main = groupPreviews ? matches.filter((entry) => !entry.preview) : matches;
  const previews = groupPreviews ? matches.filter((entry) => entry.preview) : [];
  const projects = [...new Map(main.map((entry) => [entry.project.id, entry.project])).values()].sort((a, b) => {
    const pa = pins.includes(a.name.toLowerCase()) ? 0 : 1;
    const pb = pins.includes(b.name.toLowerCase()) ? 0 : 1;
    return pa - pb || a.name.localeCompare(b.name);
  });
  const attention = counts.failing;

  return (
    <>
      <PageHeader
        title="apps"
        meta={
          <>
            {all.length} services · {apps.projects.length} projects
            {attention > 0 && <span className="level-crit"> · {attention} {attention === 1 ? "needs" : "need"} attention</span>}
            {!apps.reachable && <span className="level-crit"> · dokploy unreachable</span>}
          </>
        }
      />
      <div className="grid grid-dense">
        <div className="grid-full">
          <FilterBar
            query={query}
            onQuery={(value) => {
              setText(value);
              setQuery({ q: value });
            }}
            placeholder="search apps, domains"
            value={filter}
            onChange={(value) => setQuery({ f: value === "all" ? null : value })}
            options={[
              { value: "all", label: "all", count: counts.all },
              { value: "running", label: "running", count: counts.running },
              { value: "failing", label: "failing", count: counts.failing, tone: counts.failing ? "crit" : undefined },
              ...(counts.asleep ? [{ value: "asleep", label: "asleep", count: counts.asleep }] : []),
              { value: "previews", label: "previews", count: counts.previews },
            ]}
          >
            <Select
              label="group"
              value={flat ? "none" : "project"}
              onChange={(value) => setQuery({ group: value === "project" ? null : value })}
              options={[
                { value: "project", label: "project" },
                { value: "none", label: "none" },
              ]}
            />
            <Select
              label="sort"
              value={sort}
              onChange={(value) => setQuery({ sort: value === "name" ? null : value })}
              options={Object.keys(SORTS).map((key) => ({ value: key, label: key === "deploy" ? "last deploy" : key }))}
            />
          </FilterBar>
        </div>
        {matches.length === 0 && (
          <Panel title="no matches">
            <Empty>nothing matches “{query || filter}”</Empty>
          </Panel>
        )}
        {flat ? (
          main.length > 0 && (
            <Panel title="all services" meta={`${main.length}`}>
              <Cards items={main} switches={switches} />
            </Panel>
          )
        ) : (
          projects.map((project) => {
            const items = main.filter((entry) => entry.project.id === project.id);
            const pinned = pins.includes(project.name.toLowerCase());
            return (
              <Panel
                key={project.id}
                span={spanFor(items)}
                className="is-cards"
                id={`project-${project.name.toLowerCase()}`}
                title={project.name.toLowerCase()}
                meta={items.length > 1 ? `${items.length} services${project.description ? ` · ${project.description.toLowerCase()}` : ""}` : (project.description?.toLowerCase() ?? undefined)}
                actions={
                  <button type="button" className={`pin${pinned ? " is-pinned" : ""}`} onClick={() => togglePin(project.name)} aria-pressed={pinned} title={pinned ? "unpin" : "pin to the top"}>
                    {pinned ? "★ pinned" : "☆ pin"}
                  </button>
                }
              >
                <Cards items={items} switches={switches} />
              </Panel>
            );
          })
        )}
        {previews.length > 0 && (
          <Panel
            title="previews & staging"
            meta={`${previews.length} · ${[...new Set(previews.map((entry) => entry.project.name.toLowerCase().replace(/-previews?$/, "")))].join(" · ")}`}
            actions={
              <button type="button" className="pin" aria-expanded={showPreviews} onClick={() => setShowPreviews(!showPreviews)}>
                {showPreviews ? "hide" : "show"}
              </button>
            }
          >
            {showPreviews ? (
              <Cards items={[...previews].sort(SORTS.deploy)} switches={switches} />
            ) : (
              <p className="small muted">pull request previews and staging copies, newest deploy first. collapsed so production stays on top.</p>
            )}
          </Panel>
        )}
        <CleanupPanel runs={apps.cleanupRuns} />
      </div>
    </>
  );
}
