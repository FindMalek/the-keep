import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SmartHistoryRow } from "../shared/types";
import { newestRunAlerts, smartHistory, worsened } from "./smart";

const row = (over: Partial<SmartHistoryRow> = {}): SmartHistoryRow => ({
  at: "2026-11-01T04:00:00+00:00",
  device: "/dev/sda",
  health: "passed",
  wearPercent: 10,
  temperatureC: 36,
  reallocated: 0,
  pending: 0,
  powerOnHours: 1000,
  ...over,
});

describe("worsened", () => {
  test("says nothing while a disk is steady, even with old errors", () => {
    const previous = row({ reallocated: 4, pending: 1 });
    expect(worsened(previous, row({ reallocated: 4, pending: 1, powerOnHours: 1024 }))).toEqual([]);
  });

  test("flags more reallocated or pending sectors, a wear jump and a first failure", () => {
    const previous = row({ reallocated: 4, pending: 0, wearPercent: 10 });
    const alerts = worsened(previous, row({ reallocated: 6, pending: 2, wearPercent: 16, health: "failed" }));
    expect(alerts).toHaveLength(4);
    expect(alerts.join(" ")).toContain("reallocated sectors 4 -> 6");
    expect(worsened(row({ health: "failed" }), row({ health: "failed" }))).toEqual([]);
  });

  test("heat alerts when it crosses the line, not on every hot run", () => {
    expect(worsened(row({ temperatureC: 50 }), row({ temperatureC: 61 }))).toHaveLength(1);
    expect(worsened(row({ temperatureC: 61 }), row({ temperatureC: 62 }))).toEqual([]);
  });
});

describe("history file", () => {
  test("skips a torn last line, and each disk is compared with its own previous run", () => {
    const file = join(mkdtempSync(join(tmpdir(), "keep-smart-")), "smart-history.jsonl");
    const lines = [
      row({ at: "2026-11-01T04:00:00+00:00", device: "/dev/sda", reallocated: 0 }),
      row({ at: "2026-11-01T04:00:00+00:00", device: "/dev/sdb", reallocated: 7 }),
      row({ at: "2026-11-02T04:00:00+00:00", device: "/dev/sda", reallocated: 3 }),
      row({ at: "2026-11-02T04:00:00+00:00", device: "/dev/sdb", reallocated: 7 }),
    ].map((r) => JSON.stringify(r));
    writeFileSync(file, `${lines.join("\n")}\n{"at":"2026-11-03T04:00:0`);

    const rows = smartHistory(file);
    expect(rows).toHaveLength(4);
    expect(newestRunAlerts(rows, "2026-11-02T04:00:00+00:00")).toEqual(["/dev/sda: reallocated sectors 0 -> 3"]);
  });
});
