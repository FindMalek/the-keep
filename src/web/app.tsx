import { useEffect } from "react";
import { DitherDefs } from "./components/dither";
import { BottomNav, ICONS, Sidebar, type NavItem } from "./components/sidebar";
import { StatusBar } from "./components/status-bar";
import { TitleBar } from "./components/title-bar";
import { allServices, needsAttention } from "./lib/app-status";
import { redirect, usePath } from "./lib/router";
import { useLiveData } from "./lib/use-live-data";
import { ActivityPage } from "./pages/activity-page";
import { AppsPage } from "./pages/apps-page";
import { BucketsPage } from "./pages/buckets-page";
import { HomePage } from "./pages/home-page";
import { JobsPage } from "./pages/jobs-page";
import { LogsPage } from "./pages/logs-page";
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

  const unhealthyApps = snapshot ? allServices(snapshot.apps).filter((service) => needsAttention(service, snapshot.jobs.switches)).length : 0;
  const failedJobs = snapshot ? snapshot.jobs.jobs.filter((job) => job.lastResult === "failed").length : 0;
  const downChecks = snapshot ? snapshot.uptime.monitors.filter((monitor) => monitor.status === 0).length : 0;
  const items: NavItem[] = [
    { path: "/", group: "the keep", label: "home", icon: ICONS.home, primary: true },
    { path: "/uptime", group: "infra", label: "uptime", icon: ICONS.uptime, alerts: downChecks, primary: true },
    { path: "/apps", group: "infra", label: "apps", icon: ICONS.apps, alerts: unhealthyApps, primary: true },
    { path: "/jobs", group: "infra", label: "jobs", icon: ICONS.jobs, alerts: failedJobs },
    { path: "/logs", group: "infra", label: "logs", icon: ICONS.logs, primary: true },
    { path: "/activity", group: "infra", label: "activity", icon: ICONS.activity },
    { path: "/media", group: "personal", label: "media", icon: ICONS.media },
    { path: "/buckets", group: "personal", label: "buckets", icon: ICONS.buckets },
    { path: "/sessions", group: "ai", label: "sessions", icon: ICONS.sessions },
  ];

  return (
    <div className="app">
      <DitherDefs />
      <TitleBar host={snapshot?.host ?? null} connection={connection} cpu={history.cpu ?? []} />
      <div className="shell">
        <Sidebar items={items} path={path} />
        <main className="page">
          {!snapshot ? (
            <div className="loading">
              <span className="muted">{connection === "offline" ? "server unreachable, retrying" : "connecting"}</span>
            </div>
          ) : path === "/apps" ? (
            <AppsPage apps={snapshot.apps} switches={snapshot.jobs.switches} />
          ) : path === "/jobs" ? (
            <JobsPage jobs={snapshot.jobs} />
          ) : path === "/logs" ? (
            <LogsPage journal={snapshot.journal} dozzle={snapshot.links.dozzle ?? null} />
          ) : path === "/media" ? (
            <MediaPage snapshot={snapshot} />
          ) : path === "/buckets" ? (
            <BucketsPage garage={snapshot.garage} />
          ) : path === "/uptime" ? (
            <UptimePage uptime={snapshot.uptime} kumaUrl={snapshot.links.kuma} apps={snapshot.apps} />
          ) : path === "/activity" ? (
            <ActivityPage />
          ) : path === "/sessions" ? (
            <SessionsPage aiUsage={snapshot.jobs.aiUsage} />
          ) : (
            <HomePage snapshot={snapshot} history={history} historySize={historySize} />
          )}
        </main>
      </div>
      <StatusBar host={snapshot?.host ?? null} />
      <BottomNav items={items} path={path} />
    </div>
  );
}
