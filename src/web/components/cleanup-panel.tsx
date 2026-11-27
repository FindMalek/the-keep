import { useState } from "react";
import type { CleanupItem, CleanupRun } from "../../shared/types";
import { Chip } from "./chip";
import { Empty, Panel, Subhead } from "./panel";
import { since, stamp } from "../lib/time";

type Block = { kind: "run"; run: CleanupRun } | { kind: "quiet"; runs: CleanupRun[] };

/** Runs that removed something get their own block; stretches of empty runs collapse into one line. */
function blocks(runs: CleanupRun[]): Block[] {
  const result: Block[] = [];
  for (const run of runs) {
    const previous = result.at(-1);
    if (run.removed.length > 0) result.push({ kind: "run", run });
    else if (previous?.kind === "quiet") previous.runs.push(run);
    else result.push({ kind: "quiet", runs: [run] });
  }
  return result;
}

const reasonTone = (reason: string): "crit" | "warn" | "plain" => (reason === "failed" ? "crit" : reason === "stuck" ? "warn" : "plain");

function Item({ item }: { item: CleanupItem }) {
  return (
    <li className="cleanup-item">
      <Chip>{item.type}</Chip>
      <span className="ellipsis">
        {item.type === "deployment" ? (
          <>
            {item.project.toLowerCase()} <span className="muted">/</span> {item.service} <span className="muted">· {item.title.toLowerCase()} · {stamp(Date.parse(item.createdAt))}</span>
          </>
        ) : (
          <span className="mono">{item.path}</span>
        )}
      </span>
      <Chip tone={reasonTone(item.reason)}>{item.reason}</Chip>
    </li>
  );
}

/** keep-cleanup's log: collapsed to one line until opened, since it is rarely the reason to visit apps. */
export function CleanupPanel({ runs }: { runs: CleanupRun[] }) {
  const [open, setOpen] = useState(false);
  const last = runs[0];
  const total = runs.reduce((sum, run) => sum + run.removed.length, 0);
  const unmanaged = last?.unmanaged ?? [];

  return (
    <Panel
      id="cleanup"
      title="cleanup log"
      meta={last ? `last run ${since(Date.parse(last.at))} · removed ${last.removed.length} · ${total} over ${runs.length} runs` : "no runs yet"}
      actions={
        <button type="button" className="pin" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "hide" : "show"}
        </button>
      }
    >
      {!open ? (
        <p className="small muted">
          keep-cleanup removes failed and stuck dokploy deployments daily at 04:30 utc and keeps the newest 3.
          {unmanaged.length > 0 && ` ${unmanaged.length} containers aren't managed by dokploy and are never removed.`}
        </p>
      ) : runs.length === 0 ? (
        <Empty>no runs yet</Empty>
      ) : (
        <>
          {unmanaged.length > 0 && (
            <>
              <Subhead>unmanaged · never removed automatically</Subhead>
              <ul className="list">
                {unmanaged.map((container) => (
                  <li className="line" key={container.id ?? container.name}>
                    <span>
                      {container.name} <span className="muted">· {container.stack ?? "no compose project"}</span>
                    </span>
                    <span className="muted small">{container.state}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <Subhead>runs</Subhead>
          <ul className="cleanup">
            {blocks(runs).map((block) =>
              block.kind === "quiet" ? (
                <li key={`q-${block.runs[0]?.id}`} className="cleanup-run muted small">
                  {block.runs.length === 1
                    ? `${stamp(Date.parse(block.runs[0]?.at ?? ""))} · nothing to remove`
                    : `${block.runs.length} runs with nothing to remove · ${stamp(Date.parse(block.runs.at(-1)?.at ?? ""))} → ${stamp(Date.parse(block.runs[0]?.at ?? ""))}`}
                </li>
              ) : (
                <li key={block.run.id} className="cleanup-run">
                  <span className="small">
                    {stamp(Date.parse(block.run.at))} <span className="muted">· {block.run.removed.length} removed{block.run.durationMs != null && ` · ${block.run.durationMs} ms`}</span>
                  </span>
                  <ul>
                    {block.run.removed.map((item, index) => (
                      <Item key={`${block.run.id}-${item.id ?? index}`} item={item} />
                    ))}
                  </ul>
                </li>
              ),
            )}
          </ul>
        </>
      )}
    </Panel>
  );
}
