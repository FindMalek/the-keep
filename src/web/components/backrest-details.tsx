import { useEffect, useState } from "react";
import type { BackrestStats } from "../../shared/types";
import { bytes } from "../lib/format";
import { since, until } from "../lib/time";

export function BackrestDetails() {
  const [data, setData] = useState<BackrestStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/backrest");
        if (!response.ok) throw new Error("dashboard request failed");
        if (!cancelled) setData(await response.json() as BackrestStats);
      } catch {
        if (!cancelled) setData((previous) => previous ?? { status: "unreachable", plans: [], snapshotsAvailable: false, snapshots: [] });
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  if (!data) return <p className="empty">loading backup history</p>;
  if (data.status === "not configured") return <p className="empty">Backrest is not connected. Snapshot history and backup health cannot be confirmed here.</p>;
  if (data.status === "unreachable") return <p className="empty">Backrest is unreachable or rejected the configured credentials.</p>;
  return <>
    {data.source === "host" && <p className="muted small">local repository snapshots · backup execution status is not available from this source</p>}
    {data.plans.length === 0 ? <p className="empty">no backup plans reported</p> : <PlanList plans={data.plans} />}
    <h3 className="subhead">recent snapshots</h3>
    {!data.snapshotsAvailable ? <p className="empty">snapshot history unavailable</p> : data.snapshots.length === 0 ? <p className="empty">no snapshots reported by this source</p> : <SnapshotList snapshots={data.snapshots} />}
  </>;
}

function PlanList({ plans }: { plans: BackrestStats["plans"] }) {
  return <table className="table"><thead><tr><th>plan</th><th className="right">snapshots</th><th className="right hide-narrow">protected</th><th>last 30 days</th><th className="right">next</th></tr></thead><tbody>
    {plans.map((plan) => <tr key={plan.id}><td>{plan.id}</td><td className="right num">{plan.snapshots}</td><td className="right num hide-narrow">{plan.protectedBytes === null ? "—" : bytes(plan.protectedBytes)}</td><td>{plan.success === null ? "not reported" : <>{plan.success} ok · {plan.warning} warnings · <span className={plan.failed ? "level-crit" : undefined}>{plan.failed} failed</span></>}</td><td className="right muted">{plan.nextAt ? until(plan.nextAt) : "—"}</td></tr>)}
  </tbody></table>;
}

function SnapshotList({ snapshots }: { snapshots: BackrestStats["snapshots"] }) {
  return <table className="table"><thead><tr><th>snapshot</th><th>plan</th><th className="hide-narrow">repository</th><th className="right">reported</th></tr></thead><tbody>
    {snapshots.map((item) => <tr key={`${item.repo}:${item.id}`}><td className="mono">{item.id.slice(0, 12)}</td><td>{item.plan || "—"}</td><td className="hide-narrow muted">{item.repo || "—"}</td><td className="right muted">{item.at ? since(item.at) : "—"}</td></tr>)}
  </tbody></table>;
}
