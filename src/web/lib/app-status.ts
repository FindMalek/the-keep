import type { AppService, AppsStats, KumaMonitor, SwitchStatus } from "../../shared/types";
import type { Status } from "../components/status-square";

export function appStatus(service: AppService): Status {
  if (service.status === "error" || service.lastDeploy?.status === "error") return "down";
  if (service.total > 0 && service.running === 0) return "down";
  if (service.status === "idle" || service.status === "running" || service.running < service.total) return "warn";
  return "ok";
}

export function allServices(apps: AppsStats): AppService[] {
  return apps.projects.flatMap((project) => project.environments.flatMap((environment) => environment.services));
}

/** Apps that sleep on purpose (agent.json switches) aren't failures when they're stopped. */
export function isAsleep(service: AppService, switches: SwitchStatus[]): boolean {
  const name = service.name.toLowerCase();
  // `minecraft` is the switch; `minecraft-site` shares the prefix but runs on its own, so it must also be short of containers.
  return switches.some((app) => !app.running && (name === app.name.toLowerCase() || (name.startsWith(app.name.toLowerCase()) && service.running < service.total)));
}

/** The one "needs attention" rule, used by the nav badge and the apps page: down, has containers, not asleep. */
export function needsAttention(service: AppService, switches: SwitchStatus[]): boolean {
  return appStatus(service) === "down" && service.total > 0 && !isAsleep(service, switches);
}

/**
 * Where a person can open a check. Kuma checks some apps on the docker network (`http://dozzle:8080`); those map to
 * the Dokploy service of that name and its public domain. Null when there is nothing a browser can reach.
 */
export function publicUrlOf(monitor: KumaMonitor, apps: AppsStats): string | null {
  if (!monitor.url) return null;
  if (/^https:\/\//.test(monitor.url)) return monitor.url;
  let host = "";
  try {
    host = new URL(monitor.url).hostname;
  } catch {
    return null;
  }
  const names = [host, host.replace(/^keep-/, "")];
  const service = allServices(apps).find((candidate) => names.includes(candidate.name) && candidate.domains.length);
  return service ? `https://${service.domains[0]}` : null;
}
