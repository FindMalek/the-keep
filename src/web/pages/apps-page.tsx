import { useState } from "react";
import type { AppService, AppsStats } from "../../shared/types";
import { CleanupPanel } from "../components/cleanup-panel";
import { DomainList } from "../components/domain-list";
import { PageHeader } from "../components/page-header";
import { StatusSquare } from "../components/status-square";
import { allServices, appStatus } from "../lib/app-status";
import { descriptionFor } from "../lib/app-descriptions";
import { bytes, duration, percent } from "../lib/format";

const STATUS_TEXT: Record<string, string> = {
  done: "deployed",
  running: "deploying",
  idle: "not deployed",
  error: "failed",
};

function since(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return seconds < 60 ? "just now" : `${duration(seconds)} ago`;
}

function ServiceName({ service }: { service: AppService }) {
  const description = descriptionFor(service.name);
  return (
    <span className="service-name">
      <a className="row-link" href={service.url} target="_blank" rel="noreferrer" title={description}>
        {service.name}
      </a>
      {description && <span className="service-tooltip">{description}</span>}
    </span>
  );
}

function ServiceRow({ service }: { service: AppService }) {
  const deploy = service.lastDeploy;
  const isDatabase = service.kind !== "application" && service.kind !== "compose";

  return (
    <tr>
      <td>
        <StatusSquare status={appStatus(service)} />
      </td>
      <td>
        <ServiceName service={service} />
      </td>
      <td className="muted hide-narrow">{service.kind}</td>
      <td className="hide-narrow">
        {service.domains.length === 0 ? (
          <span className="faint">{isDatabase ? "internal" : "no domain"}</span>
        ) : (
          <DomainList domains={service.domains} />
        )}
      </td>
      <td className="num right">
        {service.total ? (
          <span className={service.running < service.total ? "level-warn" : ""}>
            {service.running}/{service.total}
          </span>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td className="num right hide-narrow">{service.running ? percent(service.cpu) : "—"}</td>
      <td className="num right hide-narrow">{service.running ? bytes(service.memBytes) : "—"}</td>
      <td className="right">
        {deploy ? (
          <>
            <span className={deploy.status === "error" ? "level-crit" : ""}>{STATUS_TEXT[deploy.status] ?? deploy.status}</span>{" "}
            <span className="muted">
              {since(deploy.at)}
              {deploy.durationSec !== null && <span className="hide-narrow"> · {Math.round(deploy.durationSec)}s</span>}
            </span>
          </>
        ) : (
          <span className="muted">{STATUS_TEXT[service.status] ?? service.status}</span>
        )}
      </td>
    </tr>
  );
}

export function AppsPage({ apps }: { apps: AppsStats }) {
  const [query, setQuery] = useState("");
  const [showCleanup, setShowCleanup] = useState(false);
  const services = allServices(apps);
  const failing = services.filter((service) => appStatus(service) !== "ok").length;
  const search = query.trim().toLowerCase();
  const projects = apps.projects.filter((project) => !search || project.name.toLowerCase().includes(search) || project.environments.some((env) => env.services.some((service) => service.name.toLowerCase().includes(search))));

  return (
    <>
      <PageHeader
        title="apps"
        meta={
          apps.reachable
            ? `${services.length} services · ${apps.projects.length} projects${failing ? ` · ${failing} need attention` : ""}`
            : "dokploy unreachable"
        }
      />
      <div className="stack">
        <div className="apps-toolbar">
          <label htmlFor="apps-search">find a service</label>
          <input id="apps-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="search projects or services" />
        </div>
        {!apps.reachable && <p className="empty dashboard-notice">Dokploy is unavailable. Check the dashboard's Dokploy URL and API key.</p>}
        {apps.reachable && services.length === 0 && <p className="empty dashboard-notice">No services returned by Dokploy.</p>}
        {apps.reachable && search && projects.length === 0 && <p className="empty dashboard-notice">No matching projects or services.</p>}
        {projects.map((project) => (
          <section className="panel" key={project.id} aria-label={project.name}>
            <header className="panel-header">
              <h2>{project.name.toLowerCase()}</h2>
              <span className="panel-meta">{project.description ?? ""}</span>
            </header>
            <div className="panel-body">
              {project.environments.map((environment) => (
                <div key={environment.name}>
                  {project.environments.length > 1 && <h3 className="subhead env">{environment.name}</h3>}
                  {environment.services.length === 0 ? (
                    <p className="empty">no services</p>
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th aria-label="status" />
                          <th>service</th>
                          <th className="hide-narrow">type</th>
                          <th className="hide-narrow">domains</th>
                          <th className="right">containers</th>
                          <th className="right hide-narrow">cpu</th>
                          <th className="right hide-narrow">memory</th>
                          <th className="right">last deploy</th>
                        </tr>
                      </thead>
                      <tbody>
                        {environment.services.filter((service) => !search || project.name.toLowerCase().includes(search) || service.name.toLowerCase().includes(search)).map((service) => (
                          <ServiceRow key={service.id} service={service} />
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
        <details className="cleanup-disclosure" onToggle={(event) => setShowCleanup(event.currentTarget.open)}>
          <summary>cleanup history · {apps.cleanupRuns.length} runs</summary>
          {showCleanup && <CleanupPanel runs={apps.cleanupRuns} />}
        </details>
      </div>
    </>
  );
}
