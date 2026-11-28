import { readText } from "../lib/host";
import type { BackrestStats } from "../shared/types";

type Summary = { id: string; totalSnapshots?: string; protectedBytes?: string; backupsSuccessLast30days?: string; backupsWarningLast30days?: string; backupsFailed30days?: string; nextBackupTimeMs?: string };
type Operation = { snapshotId?: string; planId?: string; repoId?: string; unixTimeStartMs?: string; operationIndexSnapshot?: { forgot?: boolean } };

const empty = (status: BackrestStats["status"]): BackrestStats => ({ status, plans: [], snapshotsAvailable: false, snapshots: [] });
/** keep-backrest-status runs daily at 06:00 so the backup HDD can sleep; older than a day and a bit means it stopped. */
const MAX_AGE_MS = 26 * 3600_000;
const number = (value: string | undefined): number => Number(value) || 0;

async function hostReading(dataDir: string): Promise<BackrestStats> {
  const text = await readText(`${dataDir}/backrest-status.json`);
  if (!text) return empty("not configured");
  try {
    const data = JSON.parse(text) as BackrestStats & { updatedAt?: number };
    const age = Date.now() - (data.updatedAt ?? 0);
    if (data.status !== "connected" || age < -60_000 || age > MAX_AGE_MS || !Array.isArray(data.plans) || !Array.isArray(data.snapshots)) return empty("unreachable");
    return { status: "connected", source: "host", plans: data.plans, snapshots: data.snapshots, snapshotsAvailable: data.snapshotsAvailable };
  } catch {
    return empty("unreachable");
  }
}

export async function collectBackrest(baseUrl: string | null, dataDir: string): Promise<BackrestStats> {
  if (!baseUrl) return hostReading(dataDir);
  const env = (await readText(`${dataDir}/integrations.env`)) ?? "";
  const read = (name: string) => process.env[name] ?? new RegExp(`^${name}=(.*)$`, "m").exec(env)?.[1]?.trim();
  const user = read("BACKREST_USER");
  const password = read("BACKREST_PASSWORD");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user && password) headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const post = async <T>(method: string, body: object): Promise<T> => {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1.Backrest/${method}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Backrest returned ${response.status}`);
    return await response.json() as T;
  };
  try {
    const [summary, operations] = await Promise.all([
      post<{ planSummaries?: Summary[] }>("GetSummaryDashboard", {}),
      post<{ operations?: Operation[] }>("GetOperations", { lastN: 200 }).catch(() => null),
    ]);
    return {
      status: "connected",
      source: "api",
      plans: (summary.planSummaries ?? []).map((plan) => ({ id: plan.id, snapshots: number(plan.totalSnapshots), protectedBytes: number(plan.protectedBytes), success: number(plan.backupsSuccessLast30days), warning: number(plan.backupsWarningLast30days), failed: number(plan.backupsFailed30days), nextAt: number(plan.nextBackupTimeMs) || null })),
      snapshotsAvailable: operations !== null,
      snapshots: (operations?.operations ?? []).filter((op) => op.operationIndexSnapshot && !op.operationIndexSnapshot.forgot && op.snapshotId).map((op) => ({ id: op.snapshotId!, plan: op.planId ?? "", repo: op.repoId ?? "", at: number(op.unixTimeStartMs) })).sort((a, b) => b.at - a.at).slice(0, 10),
    };
  } catch {
    const host = await hostReading(dataDir);
    return host.status === "connected" ? host : empty("unreachable");
  }
}
