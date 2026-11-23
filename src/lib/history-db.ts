import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { Points, RangeHistory, RangeName } from "../shared/types";

const DAY = 86400;
const RETENTION_SEC = 31 * DAY;
/** Per-minute rows are dropped after 31 days; the daily averages kept below serve the 90 d and 1 y ranges. */
const DAILY_RETENTION_SEC = 800 * DAY;

export const RANGES: Record<Exclude<RangeName, "live">, { spanSec: number; stepSec: number }> = {
  "1h": { spanSec: 3600, stepSec: 60 },
  "24h": { spanSec: 86400, stepSec: 300 },
  "7d": { spanSec: 7 * 86400, stepSec: 1800 },
  "30d": { spanSec: 30 * 86400, stepSec: 7200 },
  "90d": { spanSec: 90 * DAY, stepSec: DAY },
  "1y": { spanSec: 365 * DAY, stepSec: DAY },
};

interface Accumulator {
  sum: number;
  count: number;
  max: number;
}

/** Folds 1-second points into one row per key per minute (avg + max) and keeps 31 days. */
export class HistoryDb {
  private readonly db: Database;
  private current = new Map<string, Accumulator>();
  private minute = 0;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(`${dataDir}/history.db`, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS points (ts INTEGER NOT NULL, key TEXT NOT NULL, avg REAL NOT NULL, max REAL NOT NULL, PRIMARY KEY (key, ts)) WITHOUT ROWID",
    );
    // One row per key per UTC day, rolled up from `points` before those are deleted.
    this.db.run(
      "CREATE TABLE IF NOT EXISTS daily (ts INTEGER NOT NULL, key TEXT NOT NULL, avg REAL NOT NULL, max REAL NOT NULL, PRIMARY KEY (key, ts)) WITHOUT ROWID",
    );
    const last = this.db.query<{ ts: number | null }, []>("SELECT MAX(ts) AS ts FROM daily").get()?.ts ?? null;
    this.rollup(last === null ? 0 : last - DAY);
  }

  add(points: Points, nowMs: number): void {
    const minute = Math.floor(nowMs / 60_000) * 60;
    if (this.minute && minute !== this.minute) this.flush();
    this.minute = minute;

    for (const [key, value] of Object.entries(points)) {
      if (!Number.isFinite(value)) continue;
      const acc = this.current.get(key) ?? { sum: 0, count: 0, max: -Infinity };
      acc.sum += value;
      acc.count += 1;
      acc.max = Math.max(acc.max, value);
      this.current.set(key, acc);
    }
  }

  private flush(): void {
    const insert = this.db.prepare("INSERT OR REPLACE INTO points (ts, key, avg, max) VALUES (?, ?, ?, ?)");
    const rows = [...this.current];
    this.db.transaction(() => {
      for (const [key, acc] of rows) insert.run(this.minute, key, acc.sum / acc.count, acc.max);
    })();
    this.current = new Map();
    if (this.minute % 3600 === 0) {
      // Days are recomputed for two days back, so a day is complete before its minutes age out.
      this.rollup(this.minute - 2 * DAY);
      this.db.run("DELETE FROM points WHERE ts < ?", [this.minute - RETENTION_SEC]);
      this.db.run("DELETE FROM daily WHERE ts < ?", [this.minute - DAILY_RETENTION_SEC]);
    }
  }

  /** Recomputes the daily average and peak of every key (or just `keys`) from `fromSec` on. Safe to repeat. */
  private rollup(fromSec: number, keys: string[] = []): void {
    const from = Math.floor(fromSec / DAY) * DAY;
    const only = keys.length ? `AND key IN (${keys.map(() => "?").join(",")})` : "";
    this.db
      .query(
        `INSERT OR REPLACE INTO daily (ts, key, avg, max)
         SELECT (ts / ${DAY}) * ${DAY}, key, AVG(avg), MAX(max) FROM points WHERE ts >= ? ${only} GROUP BY 1, key`,
      )
      .run(from, ...keys);
  }

  /** One key's 1-minute averages between two times (seconds), for detail like when a check was down. */
  minutes(key: string, fromSec: number, toSec: number): { ts: number; avg: number }[] {
    return this.db
      .query<{ ts: number; avg: number }, [string, number, number]>("SELECT ts, avg FROM points WHERE key = ? AND ts >= ? AND ts < ? ORDER BY ts")
      .all(key, fromSec, toSec);
  }

  query(range: Exclude<RangeName, "live">, keys: string[], nowMs: number): RangeHistory {
    const { spanSec, stepSec } = RANGES[range];
    const end = Math.floor(nowMs / 1000 / stepSec) * stepSec;
    const start = end - spanSec + stepSec;
    const buckets = spanSec / stepSec;
    const series: RangeHistory["series"] = {};
    if (keys.length === 0) return { range, stepSec, start, series };

    let rows: { bucket: number; key: string; avg: number; max: number }[];
    if (stepSec >= DAY) {
      // Long ranges read the daily rows; today's is refreshed first so the last bar isn't an hour behind.
      this.rollup(nowMs / 1000 - 2 * DAY, keys);
      rows = this.db
        .query<{ bucket: number; key: string; avg: number; max: number }, (string | number)[]>(
          `SELECT ts AS bucket, key, avg, max FROM daily WHERE ts >= ? AND key IN (${keys.map(() => "?").join(",")})`,
        )
        .all(start, ...keys);
    } else {
      rows = this.db
        .query<{ bucket: number; key: string; avg: number; max: number }, (string | number)[]>(
          `SELECT (ts / ?1) * ?1 AS bucket, key, AVG(avg) AS avg, MAX(max) AS max
             FROM points
            WHERE ts >= ?2 AND key IN (${keys.map(() => "?").join(",")})
            GROUP BY bucket, key`,
        )
        .all(stepSec, start, ...keys);
    }

    for (const key of keys) series[key] = { avg: new Array(buckets).fill(null), max: new Array(buckets).fill(null) };
    for (const row of rows) {
      const index = (row.bucket - start) / stepSec;
      const entry = series[row.key];
      if (!entry || index < 0 || index >= buckets) continue;
      entry.avg[index] = row.avg;
      entry.max[index] = row.max;
    }
    return { range, stepSec, start, series };
  }
}
