import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { collectBackrest } from "./backrest";

test("summarizes plans and excludes forgotten snapshots", async () => {
  const dir = await mkdtemp(`${tmpdir()}/keep-backrest-`);
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("POST");
    if (String(input).endsWith("GetSummaryDashboard")) return Response.json({ planSummaries: [{ id: "daily", totalSnapshots: "2", protectedBytes: "100", backupsFailed30days: "1" }] });
    expect(JSON.parse(String(init?.body))).toEqual({ lastN: 200 });
    return Response.json({ operations: [
      { snapshotId: "one", repoId: "local", planId: "daily", unixTimeStartMs: "200", operationIndexSnapshot: {} },
      { snapshotId: "old", repoId: "local", unixTimeStartMs: "100", operationIndexSnapshot: { forgot: true } },
    ] });
  }) as typeof fetch;
  try {
    const result = await collectBackrest("http://backrest:9898", dir);
    expect(result.plans[0]).toMatchObject({ id: "daily", snapshots: 2, protectedBytes: 100, failed: 1 });
    expect(result.snapshots).toEqual([{ id: "one", repo: "local", plan: "daily", at: 200 }]);
  } finally {
    globalThis.fetch = previous;
  }
});
