import { useEffect } from "react";
import { ICONS, Sidebar, type NavItem } from "./components/sidebar";
import { StatusBar } from "./components/status-bar";
import { TitleBar } from "./components/title-bar";
import { allServices, appStatus } from "./lib/app-status";
import { redirect, usePath } from "./lib/router";
import { useLiveData } from "./lib/use-live-data";
import { ActivityPage } from "./pages/activity-page";
import { AppsPage } from "./pages/apps-page";
import { HomePage } from "./pages/home-page";
import { JobsPage } from "./pages/jobs-page";
import { MediaPage } from "./pages/media-page";
import { SessionsPage } from "./pages/sessions-page";
import { UptimePage } from "./pages/uptime-page";

export function App() {
  const { snapshot, history, historySize, connection } = useLiveData();
  const path = usePath();
  // The overview and system pages became one: old bookmarks still land somewhere.
  useEffect(() => {
    if (path === "/system" || path === "/overview") redirect("/");
  }, [path]);

  const unhealthyApps = snapshot ? allServices(snapshot.apps).filter((service) => appStatus(service) === "down").length : 0;
  const failedJobs = snapshot ? snapshot.jobs.jobs.filter((job) => job.lastResult === "failed").length : 0;
  const downChecks = snapshot ? snapshot.uptime.monitors.filter((monitor) => monitor.status === 0).length : 0;
  const items: NavItem[] = [
    { path: "/", group: "the keep", label: "home", icon: ICONS.overview },
    { path: "/uptime", group: "infra", label: "uptime", icon: ICONS.uptime, alerts: downChecks },
    { path: "/apps", group: "infra", label: "apps", icon: ICONS.apps, alerts: unhealthyApps },
    { path: "/jobs", group: "infra", label: "jobs", icon: ICONS.jobs, alerts: failedJobs },
    { path: "/activity", group: "infra", label: "activity", icon: ICONS.activity },
    { path: "/media", group: "personal", label: "media", icon: ICONS.media },
    { path: "/sessions", group: "ai", label: "sessions", icon: ICONS.sessions },
  ];

  return (
    <div className="app">
      <TitleBar host={snapshot?.host ?? null} connection={connection} />
      <div className="shell">
        <Sidebar items={items} path={path} />
        <main className="page">
          {!snapshot ? (
            <div className="loading">
              <span className="muted">{connection === "offline" ? "server unreachable, retrying" : "connecting"}</span>
            </div>
          ) : path === "/apps" ? (
            <AppsPage apps={snapshot.apps} />
          ) : path === "/jobs" ? (
            <JobsPage jobs={snapshot.jobs} />
          ) : path === "/media" ? (
            <MediaPage snapshot={snapshot} />
          ) : path === "/uptime" ? (
            <UptimePage uptime={snapshot.uptime} kumaUrl={snapshot.links.kuma} />
          ) : path === "/activity" ? (
            <ActivityPage />
          ) : path === "/sessions" ? (
            <SessionsPage />
          ) : (
            <HomePage snapshot={snapshot} history={history} historySize={historySize} />
          )}
        </main>
      </div>
      <StatusBar host={snapshot?.host ?? null} />
    </div>
  );
}
