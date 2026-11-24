import { readFileSync } from "node:fs";
import type { SmartHistoryRow, SmartStats } from "../shared/types";

const DATA_DIR = process.env.DATA_DIR ?? "/data";
const PATH = `${DATA_DIR}/smart.json`;
const HISTORY_PATH = `${DATA_DIR}/smart-history.jsonl`;
/** A daily run of a few disks is ~1000 rows a year; this keeps years of it and bounds a runaway file. */
const MAX_ROWS = 20_000;

export function smart(): SmartStats {
  try {
    const data = JSON.parse(readFileSync(PATH, "utf8")) as SmartStats;
    return { at: data.at ?? null, disks: data.disks ?? [] };
  } catch {
    return { at: null, disks: [] };
  }
}

/** Every recorded run, oldest first. A torn last line (the host was mid-write) is skipped. */
export function smartHistory(path = HISTORY_PATH): SmartHistoryRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: SmartHistoryRow[] = [];
  for (const line of text.split("\n").slice(-MAX_ROWS)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as SmartHistoryRow;
      if (typeof row.at === "string" && typeof row.device === "string") rows.push(row);
    } catch {
      // torn or hand-edited line
    }
  }
  return rows;
}

const WEAR_JUMP = 5;
const HOT_C = 60;

/** What got worse for one disk between two runs; empty when nothing did. Alerts fire on change, not on every run. */
export function worsened(previous: SmartHistoryRow | undefined, current: SmartHistoryRow): string[] {
  const out: string[] = [];
  const name = current.device;
  if (current.health === "failed" && previous?.health !== "failed") out.push(`${name} reports SMART failure`);
  if (previous) {
    if ((current.reallocated ?? 0) > (previous.reallocated ?? 0))
      out.push(`${name}: reallocated sectors ${previous.reallocated ?? 0} -> ${current.reallocated}`);
    if ((current.pending ?? 0) > (previous.pending ?? 0)) out.push(`${name}: pending sectors ${previous.pending ?? 0} -> ${current.pending}`);
    if ((current.wearPercent ?? 0) - (previous.wearPercent ?? 0) >= WEAR_JUMP)
      out.push(`${name}: wear jumped ${previous.wearPercent}% -> ${current.wearPercent}%`);
  }
  if ((current.temperatureC ?? 0) >= HOT_C && (previous?.temperatureC ?? 0) < HOT_C) out.push(`${name}: running hot at ${current.temperatureC}C`);
  return out;
}

/** Messages for the disks of the newest run (rows with `at`), each compared with that disk's run before it. */
export function newestRunAlerts(rows: SmartHistoryRow[], at: string): string[] {
  const alerts: string[] = [];
  for (const current of rows.filter((row) => row.at === at)) {
    const previous = rows.filter((row) => row.device === current.device && row.at < at).at(-1);
    alerts.push(...worsened(previous, current));
  }
  return alerts;
}
