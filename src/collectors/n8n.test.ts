import { expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { collectN8n, requestN8nRun } from "./n8n";

test("reads paginated workflows without leaking node parameters and tolerates missing execution access", async () => {
  const dir = await mkdtemp(`${tmpdir()}/keep-n8n-`);
  await Bun.write(`${dir}/integrations.env`, "N8N_API_KEY=test-key\n");
  const previous = globalThis.fetch;
  const previousKey = process.env.N8N_API_KEY;
  delete process.env.N8N_API_KEY;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    expect((init?.headers as Record<string, string>)["X-N8N-API-KEY"]).toBe("test-key");
    if (url.includes("executions")) return new Response(null, { status: 403 });
    if (url.includes("cursor=")) return Response.json({ data: [{ id: "2", name: "second", active: false }], nextCursor: null });
    return Response.json({ data: [{ id: "1", name: "first", active: true, nodes: [{ name: "start", type: "n8n.trigger", position: [1, 2], parameters: { secret: "do-not-send" } }], connections: { start: { main: [null, [{ node: "finish" }]] } } }], nextCursor: "next" });
  }) as typeof fetch;
  try {
    const result = await collectN8n("http://n8n:5678", dir);
    expect(result.status).toBe("connected");
    expect(result.workflows).toHaveLength(2);
    expect(result.workflows[0]?.edges).toEqual([{ from: "start", to: "finish" }]);
    expect(JSON.stringify(result)).not.toContain("do-not-send");
    expect(result.executionsAvailable).toBe(false);
    expect(urls).toHaveLength(3);
  } finally {
    globalThis.fetch = previous;
    if (previousKey === undefined) delete process.env.N8N_API_KEY;
    else process.env.N8N_API_KEY = previousKey;
  }
});

test("uses fresh host metadata and rejects stale readings", async () => {
  const dir = await mkdtemp(`${tmpdir()}/keep-n8n-host-`);
  const path = `${dir}/n8n-status.json`;
  const reading = { status: "connected", updatedAt: Date.now(), workflows: [], executions: [], executionsAvailable: true, truncated: false };
  await Bun.write(path, JSON.stringify(reading));
  expect((await collectN8n(null, dir)).status).toBe("connected");
  await Bun.write(path, JSON.stringify({ ...reading, updatedAt: Date.now() - 181_000 }));
  expect((await collectN8n(null, dir)).status).toBe("unreachable");
});

test("queues only workflows enabled by fresh host metadata", async () => {
  const dir = await mkdtemp(`${tmpdir()}/keep-n8n-request-`);
  await Bun.write(`${dir}/n8n-status.json`, JSON.stringify({ status: "connected", updatedAt: Date.now(), executions: [], workflows: [
    { id: "safe", name: "safe", active: true, runnable: true, nodes: [], edges: [] },
    { id: "other", name: "other", active: true, runnable: false, nodes: [], edges: [] },
  ] }));
  expect(await requestN8nRun(dir, "run-n8n:safe;reboot")).toBe(false);
  expect(await requestN8nRun(dir, "run-n8n:other")).toBe(false);
  expect(await requestN8nRun(dir, "run-n8n:safe")).toBe(true);
  expect((await readdir(`${dir}/n8n-requests`)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
});
