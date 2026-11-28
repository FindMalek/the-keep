import { useEffect, useState } from "react";
import type { BackrestStats } from "../../shared/types";
import { bytes } from "../lib/format";
import { since, until } from "../lib/time";
import { Empty, Panel, Subhead } from "./panel";
import { StatusSquare } from "./status-square";

function useBackrest(): BackrestStats | null {
  const [data, setData] = useState<BackrestStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/backrest");
        if (!response.ok) throw new Error(String(response.status));
        if (!cancelled) setData((await response.json()) as BackrestStats);
      } catch {
        if (!cancelled) setData((previous) => previous ?? { status: "unreachable", plans: [], snapshotsAvailable: false, snapshots: [] });
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return data;
}

/** Backrest plans and the newest snapshots of the local repository. */
export function BackupsPanel() {
  const data = useBackrest();
  const newest = data?.snapshots.reduce<BackrestStats["snapshots"][number] | null>((best, item) => (!best || item.at > best.at ? item : best), null);
  const stale = newest ? Date.now() - newest.at > 36 * 3600_000 : true;
  const snapshots = [...(data?.snapshots ?? [])].sort((a, b) => b.at - a.at);
  return (
    <Panel id="backups" title="backups" span={4} meta={newest ? <span className={stale ? "level-warn" : ""}>last snapshot {since(newest.at)}</span> : (data?.status ?? "loading")}>
      {!data ? (
        <Empty>loading</Empty>
      ) : data.status !== "connected" ? (
        <Empty>{data.status === "not configured" ? "keep-backrest-status hasn't reported yet" : "backrest could not be read"}</Empty>
      ) : (
        <div className="stack">
          {data.plans.length === 0 ? (
            <Empty>no backup plans</Empty>
          ) : (
            <ul className="list">
              {data.plans.map((plan) => (
                <li key={plan.id} className="line">
                  <span>
                    <StatusSquare status={plan.failed ? "down" : plan.warning ? "warn" : "ok"} label={plan.failed ? `${plan.failed} failed` : "ok"} /> {plan.id}
                  </span>
                  <span className="facts-inline muted">
                    <span className="n-count">{plan.snapshots} snaps</span>
                    {plan.protectedBytes !== null && <span className="n-bytes">{bytes(plan.protectedBytes)}</span>}
                    {plan.nextAt && <span>next {until(plan.nextAt)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Subhead aside={data.snapshotsAvailable ? `${snapshots.length}` : "unavailable"}>snapshots</Subhead>
          {snapshots.length === 0 ? (
            <Empty>no snapshots yet</Empty>
          ) : (
            <ul className="list">
              {snapshots.slice(0, 8).map((item) => (
                <li key={`${item.repo}:${item.id}`} className="line">
                  <span className="mono">{item.id.slice(0, 10)}</span>
                  <span className="facts-inline muted">
                    <span>{item.repo || item.plan}</span>
                    <span className="n-ago">{since(item.at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}
