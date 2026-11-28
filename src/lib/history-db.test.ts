import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryDb } from "./history-db";

const DAY_MS = 86_400_000;
// a whole hour boundary on a UTC day start, so flushes also run the hourly rollup and cleanup
const day = (n: number) => Date.UTC(2026, 5, 1) + n * DAY_MS;
const fresh = () => new HistoryDb(mkdtempSync(join(tmpdir(), "keep-history-")));

describe("long ranges", () => {
  test("90d averages each UTC day and the last bar is the current day", () => {
    const db = fresh();
    const noon = 12 * 3_600_000;
    db.add({ up: 1 }, day(0) + noon);
    db.add({ up: 0 }, day(0) + noon + 60_000);
    db.add({ up: 1 }, day(1) + noon);
    db.add({ up: 1 }, day(2) + noon); // flushes the day before

    const { series, stepSec } = db.query("90d", ["up"], day(2) + noon + 30 * 60_000);
    expect(stepSec).toBe(86_400);
    expect(series.up!.avg.length).toBe(90);
    expect(series.up!.avg[87]).toBe(0.5);
    expect(series.up!.max[87]).toBe(1);
    expect(series.up!.avg[88]).toBe(1);
  });

  test("a day's average outlives its per-minute rows", () => {
    const db = fresh();
    const old = day(0) + 12 * 3_600_000;
    const now = old + 40 * DAY_MS; // past the 31 day minute retention
    db.add({ up: 0.5 }, old);
    db.add({ up: 1 }, now); // flushes `old` and rolls it up
    db.add({ up: 1 }, now + 60_000); // flushes `now`, which deletes minutes older than 31 days

    expect(db.minutes("up", old / 1000 - 3600, old / 1000 + 3600)).toEqual([]);
    const { series } = db.query("90d", ["up"], now);
    expect(series.up!.avg[89 - 40]).toBe(0.5);
  });
});
