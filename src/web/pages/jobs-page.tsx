import { useEffect, useState } from "react";
import type { ActionRecord, BackupStatus, GitHubCiStatus, JobRun, JobStatus, JobsStats } from "../../shared/types";
import { ActionButton } from "../components/action-button";
import { LogRow } from "../components/log-row";
import { PageHeader, Tabs } from "../components/page-header";
import { Empty, Link, Panel } from "../components/panel";
import { StatusSquare, type Status } from "../components/status-square";
import { whoIs } from "../lib/devices";
import { bytes, duration, humanSchedule } from "../lib/format";
import { clock } from "../lib/time";
import { useActivity } from "../lib/use-activity";
import { BackupsPanel } from "../components/backrest-details";
import { WorkflowsPanel } from "../components/workflows-panel";

const HOWTO_KEY = "keep:jobs:howto";

function relative(unixSec: number | null): string {
  if (unixSec === null) return "—";
  const delta = unixSec - Date.now() / 1000;
  if (Math.abs(delta) < 60) return delta >= 0 ? "in <1m" : "just now";
  return delta >= 0 ? `in ${duration(delta)}` : `${duration(-delta)} ago`;
}

const took = (seconds: number) => (seconds >= 60 ? duration(seconds) : `${Math.max(1, Math.round(seconds))}s`);
/** keep-agent rewrites jobs.json every minute; three missed beats means it stopped. */
const STALE_SEC = 180;

/** A next run in the past means the timer didn't fire, or the agent stopped reporting. */
function nextRun(unixSec: number | null): { text: string; overdue: boolean } {
  if (unixSec === null) return { text: "—", overdue: false };
  const late = Date.now() / 1000 - unixSec;
  if (late > 60) return { text: `overdue ${duration(late)}`, overdue: true };
  return { text: relative(unixSec), overdue: false };
}

const dated = (iso: string) => {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function jobStatus(job: JobStatus): Status {
  if (job.planned) return "warn";
  if (job.lastResult === "failed") return "down";
  if (job.lastResult === "running") return "warn";
  return job.lastResult === "success" ? "ok" : "none";
}

function useRuns(name: string | null): { runs: JobRun[] | null; error: string | null } {
  const [state, setState] = useState<{ runs: JobRun[] | null; error: string | null }>({ runs: null, error: null });
  useEffect(() => {
    setState({ runs: null, error: null });
    if (!name) return;
    let current = true;
    fetch(`/api/jobs/runs?name=${encodeURIComponent(name)}&limit=2`)
      .then(async (response) => (response.ok ? { runs: (await response.json()) as JobRun[], error: null } : { runs: [], error: await response.text() }))
      .catch(() => ({ runs: [], error: "could not reach the server" }))
      .then((next) => current && setState(next));
    return () => {
      current = false;
    };
  }, [name]);
  return state;
}

function RunLog({ job }: { job: JobStatus }) {
  const { runs, error } = useRuns(job.name);
  const [which, setWhich] = useState<"last run" | "previous run">("last run");
  const run = runs?.[which === "last run" ? 0 : 1];
  return (
    <div className="job-detail">
      <div className="job-detail-bar">
        <Tabs options={["last run", "previous run"] as const} value={which} onChange={setWhich} label="run" />
        {run && (
          <span className="small muted ellipsis">
            {new Date(run.start).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).toLowerCase()} · {run.end ? took((run.end - run.start) / 1000) : "running"} ·{" "}
            <span className={run.result === "failed" ? "level-crit" : ""}>{run.result}</span> · {run.lines.length} lines
          </span>
        )}
        <span className="job-detail-actions">
          {job.runnable && <ActionButton action={`run:${job.name}`} label="run now" />}
          <Link href={`/logs?unit=${encodeURIComponent(`${job.name}.service`)}${run ? `&since=${Math.floor(run.start / 1000) - 1}` : ""}`}>open in logs</Link>
        </span>
      </div>
      {runs === null ? (
        <p className="small muted">reading the journal…</p>
      ) : error ? (
        <p className="small level-warn">{error}</p>
      ) : !run ? (
        <p className="small muted">no {which} in the journal (it keeps 14 days)</p>
      ) : (
        <ul className="log-list log-list-short">
          {run.lines.map((entry) => (
            <LogRow key={entry.cursor} entry={entry} short />
          ))}
        </ul>
      )}
    </div>
  );
}

function JobRow({ job, open, onToggle }: { job: JobStatus; open: boolean; onToggle: () => void }) {
  const status = jobStatus(job);
  const external = !job.runnable && !job.planned;
  const next = nextRun(job.nextRun);
  return (
    <li className={`job${open ? " is-open" : ""}`}>
      <button type="button" className="job-line" aria-expanded={open} onClick={onToggle}>
        <StatusSquare status={status} label={job.lastResult ?? "no runs yet"} />
        <span className="job-name">
          <span className="mono">{job.name}</span>
          <span className="job-desc">{job.description}</span>
        </span>
        <span className="job-when">
          <span className={`job-schedule ${job.planned ? "level-warn" : "muted"}`} title={job.schedule}>
            {humanSchedule(job.schedule)}
          </span>
          <span className="job-last">
            <span className="only-phone-inline muted">last </span>
            <span className={job.lastResult === "failed" ? "level-crit" : ""}>{relative(job.lastRun)}</span>
            {job.durationSec !== null && job.durationSec >= 1 && <span className="muted"> · {took(job.durationSec)}</span>}
          </span>
          <span className={`job-next ${next.overdue && !external ? "level-warn" : "muted"}`}>
            <span className="only-phone-inline">next </span>
            {external ? "own scheduler" : next.text}
          </span>
        </span>
        <span className="job-toggle" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open &&
        (external ? (
          <p className="job-detail small muted">not a systemd timer on this host: it runs on its own scheduler, so there's no run button and its logs live in its own app.</p>
        ) : job.planned ? (
          <p className="job-detail small level-warn">listed so it isn't forgotten, but not set up on the host yet.</p>
        ) : (
          <RunLog job={job} />
        ))}
    </li>
  );
}

function backupStatus(status: BackupStatus | null): Status {
  if (!status) return "none";
  return status.status === "success" ? "ok" : status.status === "failed" ? "down" : status.status === "running" ? "warn" : "none";
}

function ServerPanel({ jobs }: { jobs: JobsStats }) {
  const backup = jobs.backup;
  return (
    <Panel id="server" title="server" span={4} meta="via keep-agent">
      <ul className="actions">
        <li className="action">
          <span>
            <span className="action-name">
              <StatusSquare status={backupStatus(backup)} /> backups
            </span>
            <span className="small muted">
              {!backup ? "backrest reports no status" : !backup.at ? backup.status : `${backup.status} · ${relative(Date.parse(backup.at) / 1000)}${backup.sizeBytes ? ` · ${bytes(backup.sizeBytes)}` : ""}`}
            </span>
          </span>
        </li>
        <li className="action">
          <span>
            <span className="action-name">tidy up</span>
            <span className="small muted">
              docker leftovers, old logs, caches. data untouched.
              {jobs.tidy && ` last ${relative(Date.parse(jobs.tidy.at) / 1000)}, freed ${bytes(jobs.tidy.freedBytes)}.`}
            </span>
          </span>
          <ActionButton action="tidy" label="tidy now" />
        </li>
        {jobs.switches.map((app) => (
          <li className="action" key={app.name}>
            <span>
              <span className="action-name">
                <StatusSquare status={app.running ? "ok" : "none"} /> {app.name}
              </span>
              <span className="small muted">
                {app.running ? "running" : "asleep"}
                {app.description && ` · ${app.description}`}
              </span>
            </span>
            {app.running ? <ActionButton action={`stop:${app.name}`} label="stop" confirm="click again to stop" /> : <ActionButton action={`start:${app.name}`} label="start" />}
          </li>
        ))}
        <li className="action">
          <span>
            <span className="action-name">reboot</span>
            <span className="small muted">back in about 90 seconds</span>
          </span>
          <ActionButton action="reboot" label="reboot" confirm="click again" danger />
        </li>
      </ul>
    </Panel>
  );
}

function GitHubPanel({ github }: { github: GitHubCiStatus | null }) {
  if (!github || (!github.runners.length && !github.runs.length)) return null;
  const online = github.runners.filter((r) => r.status === "online").length;
  return (
    <Panel id="github" title="github runners" span={4} meta={`${online}/${github.runners.length} online`}>
      <ul className="list">
        {github.runners.map((runner) => (
          <li className="line" key={`${runner.repo}-${runner.id}`}>
            <span>
              <StatusSquare status={runner.status === "offline" ? "down" : runner.busy ? "warn" : "ok"} /> {runner.name} <span className="muted">· {runner.repo}</span>
            </span>
            <span className="muted small">{runner.busy ? "busy" : runner.status}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ActionRow({ record, who }: { record: ActionRecord; who: string | null }) {
  const [open, setOpen] = useState(false);
  const status: Status = record.status === "done" ? "ok" : record.status === "refused" ? "warn" : "down";
  const hasMore = !!record.output;
  const detail = record.detail.replace(/^stoped$/, "stopped");
  return (
    <li className={`action-log${open ? " is-open" : ""}`}>
      <button type="button" className="action-line" onClick={() => hasMore && setOpen(!open)} aria-expanded={hasMore ? open : undefined} disabled={!hasMore}>
        <span className="mono muted">{dated(record.at)}</span>
        <span className="mono ellipsis">{record.action}</span>
        <span className="action-status">
          <StatusSquare status={status} /> {record.status}
        </span>
        <span className="ellipsis">
          {detail}
          {who && <span className="muted"> · by {who}</span>}
        </span>
        <span className="muted mono right">
          {record.durationSec != null ? took(record.durationSec) : "—"}
          {record.freedBytes != null && ` · ${bytes(record.freedBytes)}`}
          {record.exitCode != null && record.exitCode !== 0 && <span className="level-crit"> · exit {record.exitCode}</span>}
        </span>
        <span className="job-toggle" aria-hidden="true">
          {hasMore ? (open ? "▾" : "▸") : ""}
        </span>
      </button>
      {open && record.output && <pre className="action-output">{record.output}</pre>}
    </li>
  );
}

export function JobsPage({ jobs }: { jobs: JobsStats }) {
  const [open, setOpen] = useState<string | null>(null);
  const [howto, setHowto] = useState(() => {
    try {
      return localStorage.getItem(HOWTO_KEY) !== "hidden";
    } catch {
      return true;
    }
  });
  const activity = useActivity();
  const failing = jobs.jobs.filter((job) => job.lastResult === "failed").length;
  const checkedAgo = jobs.updatedAt ? Date.now() / 1000 - Date.parse(jobs.updatedAt) / 1000 : null;
  const stale = checkedAgo !== null && checkedAgo > STALE_SEC;
  const actions = [...jobs.actions].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const unrecorded = actions.every((record) => record.requestedBy === undefined);
  const nameOf = (ip: string | null | undefined) => {
    if (!ip) return null;
    const who = whoIs(ip, activity?.devices ?? [], activity?.publicIp ?? null);
    return `${who.name} (${who.via})`;
  };

  const hide = () => {
    setHowto(false);
    try {
      localStorage.setItem(HOWTO_KEY, "hidden");
    } catch {
      // Remembering is a convenience only.
    }
  };

  return (
    <>
      <PageHeader title="jobs" meta={<>{jobs.jobs.length} scheduled{failing ? <span className="level-crit"> · {failing} failed</span> : ""} · schedules as the timers say, run times in your clock</>} />
      <div className="grid">
        {howto && (
          <div className="howto grid-full">
            <p>
              each job is a <span className="mono">systemd</span> timer on the host. <span className="mono">keep-agent</span> reads them every minute into{" "}
              <span className="mono">jobs.json</span>; “run now” drops a request the agent checks against its allow-list. a job's log is read straight from the journal.
            </p>
            <button type="button" className="pin" onClick={hide} aria-label="hide this note">
              ×
            </button>
          </div>
        )}
        <Panel id="scheduled" title="scheduled" span={8} meta={jobs.updatedAt ? <span className={stale ? "level-warn" : ""}>{stale ? `agent last reported ${relative(Date.parse(jobs.updatedAt) / 1000)}, next runs may be stale` : `checked ${relative(Date.parse(jobs.updatedAt) / 1000)}`}</span> : <span className="level-warn">agent not reporting</span>} flush>
          {jobs.jobs.length === 0 ? (
            <div className="box-pad">
              <Empty>keep-agent hasn't written jobs.json yet</Empty>
            </div>
          ) : (
            <ul className="jobs">
              <li className="job-head" aria-hidden="true">
                <span />
                <span>job</span>
                <span>schedule</span>
                <span className="right">last run</span>
                <span className="right">next run</span>
                <span />
              </li>
              {jobs.jobs.map((job) => (
                <JobRow key={job.name} job={job} open={open === job.name} onToggle={() => setOpen(open === job.name ? null : job.name)} />
              ))}
            </ul>
          )}
        </Panel>
        <div className="column column-4">
          <ServerPanel jobs={jobs} />
          <GitHubPanel github={jobs.github} />
        </div>
        <Panel id="actions" title="recent actions" meta={`last ${actions.length}, newest first`} flush>
          {actions.length === 0 ? (
            <div className="box-pad">
              <Empty>nothing requested yet</Empty>
            </div>
          ) : (
            <>
              <ul className="action-logs">
                <li className="action-line action-head" aria-hidden="true">
                  <span>when</span>
                  <span>action</span>
                  <span>result</span>
                  <span>detail</span>
                  <span className="right">took</span>
                  <span />
                </li>
                {actions.map((record) => (
                  <ActionRow key={`${record.at}-${record.action}`} record={record} who={nameOf(record.requestedBy)} />
                ))}
              </ul>
              {unrecorded && <p className="log-more small muted">these were requested before the agent recorded who asked, how long it took and what it printed</p>}
            </>
          )}
        </Panel>
        <WorkflowsPanel />
        <BackupsPanel />
      </div>
    </>
  );
}

