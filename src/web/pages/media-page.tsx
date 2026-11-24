import type { Snapshot } from "../../shared/types";
import { MusicPanel, ReadingPanel } from "../components/home-panels";
import { PageHeader } from "../components/page-header";
import { Panel } from "../components/panel";
import { BackrestDetails } from "../components/backrest-details";
import { bytes, duration } from "../lib/format";
import { since } from "../lib/time";

/** What i listen to and read, from navidrome and miniflux. */
export function MediaPage({ snapshot }: { snapshot: Snapshot }) {
  const backup = snapshot.jobs.backup;
  const backupJobs = snapshot.jobs.jobs.filter((job) => job.name.includes("backup"));
  return (
    <>
      <PageHeader title="media" meta="music, reading and backups" />
      <div className="grid media">
        <MusicPanel music={snapshot.home.music} link={snapshot.links.navidrome} />
        <ReadingPanel reading={snapshot.home.reading} link={snapshot.links.miniflux} />
        <Panel title="backups" area="backup" meta="latest reported status">
          {backup?.at ? (
            <div className="backup-summary">
              <div><span className="muted">last reported</span><strong>{since(Date.parse(backup.at))}</strong></div>
              <div><span className="muted">status</span><strong className={backup.status === "failed" ? "level-crit" : ""}>{backup.status}</strong></div>
              <div><span className="muted">size</span><strong>{backup.sizeBytes !== null ? bytes(backup.sizeBytes) : "—"}</strong></div>
              <div><span className="muted">duration</span><strong>{backup.durationSec !== null ? duration(backup.durationSec) : "—"}</strong></div>
            </div>
          ) : null}
          <BackrestDetails />
          {backupJobs.map((job) => <div className="backup-job" key={job.name}>
            <span><strong>{job.name}</strong><span className="muted"> · {job.description}</span></span>
            <span className="muted">{job.lastRun ? `${job.lastResult ?? "unknown"} · ${since(job.lastRun * 1000)}` : "no run reported"}</span>
          </div>)}
        </Panel>
      </div>
    </>
  );
}
