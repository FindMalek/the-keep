/*
 * Dev only: serves the UI from captured API responses, for working on the dashboard away from the host.
 *   KEEP_FIXTURES=/path/to/fixtures bun scripts/dev-fixtures.ts
 * The fixture dir holds snapshot.json, activity.json, h-<range>-*.json (history), sessions/all.jsonl (one
 * /api/session body per line) and optionally buckets/<name>/… (served as fake Garage buckets). Never commit
 * fixtures: they hold real IPs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import index from "../src/web/index.html";
import { apiRoutes, PAGE_PATHS } from "../src/routes";
import { SessionStore } from "../src/sessions/store";
import type { BucketSource } from "../src/collectors/garage-s3";
import { createJournal } from "../src/collectors/logs";
import { loadConfig } from "../src/lib/config";
import type { InitialPayload, RangeHistory, TickPayload } from "../src/shared/types";

const dir = process.env.KEEP_FIXTURES;
if (!dir) throw new Error("set KEEP_FIXTURES to the fixture directory");
const json = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), "utf8")) as T;

const initial = json<InitialPayload>("snapshot.json");
// Captures from before a field existed get it filled the way the server would.
for (const mount of initial.snapshot.mounts) mount.role ??= mount.label === "backup" ? "backup" : "data";
const activity = json<Record<string, unknown>>("activity.json");
// Shift every stored timestamp so "6h ago" in the capture stays "6h ago" today.
const shift = Date.now() - initial.snapshot.at;

const history = new Map<string, RangeHistory>();
for (const file of readdirSync(dir).filter((name) => /^h-\w+-\w+\.json$/.test(name))) {
  const part = json<RangeHistory>(file);
  const merged = history.get(part.range) ?? { ...part, series: {} };
  merged.start = part.start + Math.round(shift / 1000);
  Object.assign(merged.series, part.series);
  history.set(part.range, merged);
}

const dataDir = join(dir, "data");
const sessions = new SessionStore(dataDir);
const sessionFile = join(dir, "sessions", "all.jsonl");
if (existsSync(sessionFile) && !sessions.count()) {
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) if (line.trim().startsWith("{")) sessions.upsert(JSON.parse(line));
}

if (!sessions.prices.updatedAt) await sessions.prices.refresh(sessions.providers()).catch((error) => console.error(error));

/** Folders under fixtures/buckets/<name>/ stand in for Garage buckets. */
const bucketRoot = join(dir, "buckets");
const buckets: BucketSource = {
  async list(bucket, prefix, after, limit) {
    const base = join(bucketRoot, bucket, prefix);
    if (!existsSync(base) || !statSync(base).isDirectory()) return { prefixes: [], objects: [], next: null };
    const names = readdirSync(base).sort();
    const prefixes = names.filter((name) => statSync(join(base, name)).isDirectory()).map((name) => `${prefix}${name}/`);
    const files = names
      .filter((name) => !statSync(join(base, name)).isDirectory())
      .map((name) => ({ key: relative(join(bucketRoot, bucket), join(base, name)), stat: statSync(join(base, name)) }))
      .filter((file) => !after || file.key > after);
    const page = files.slice(0, limit);
    return {
      prefixes: after ? [] : prefixes,
      objects: page.map((file) => ({ key: file.key, size: file.stat.size, modified: file.stat.mtimeMs, etag: null })),
      next: files.length > limit ? (page.at(-1)?.key ?? null) : null,
    };
  },
  async *walk(bucket, prefix) {
    const root = join(bucketRoot, bucket);
    const files: { key: string; size: number; modified: number; etag: null }[] = [];
    const visit = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        const stat = statSync(path);
        if (stat.isDirectory()) visit(path);
        else files.push({ key: relative(root, path), size: stat.size, modified: stat.mtimeMs, etag: null });
      }
    };
    visit(root);
    const matching = files.filter((file) => file.key.startsWith(prefix));
    for (let index = 0; index < matching.length; index += 1000) yield matching.slice(index, index + 1000);
  },
  // Pretends: fixtures are never changed, so a delete can be tried over and over.
  async remove(_bucket, keys) {
    return { deleted: keys.length, failed: [] };
  },
  async get(bucket, key, range) {
    const path = join(bucketRoot, bucket, key);
    if (!path.startsWith(join(bucketRoot, bucket)) || !existsSync(path)) return null;
    const file = Bun.file(path);
    return { body: range ? file.slice(range.start, range.end + 1).stream() : file.stream(), size: file.size, type: file.type };
  },
};

const snapshotAt = () => ({ ...initial.snapshot, at: Date.now() });
const keys = Object.keys(initial.history);
let tickIndex = 0;

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8091),
  development: true,
  routes: {
    ...Object.fromEntries(PAGE_PATHS.map((path) => [path, index])),
    ...apiRoutes({
      sessions,
      journal: createJournal({ command: loadConfig().journalctl, directory: loadConfig().journalDir }),
      jobNames: () => initial.snapshot.jobs.jobs.map((job) => job.name),
      buckets: () => buckets,
      bucketNames: () => initial.snapshot.garage.buckets.map((bucket) => bucket.name),
      deleteBuckets: () => (process.env.GARAGE_S3_DELETE_BUCKETS ?? "").split(",").filter(Boolean),
      logBucketDelete: (record) => console.log("bucket delete", record.detail),
    }),
    "/api/snapshot": () => Response.json({ ...initial, snapshot: snapshotAt() } satisfies InitialPayload),
    "/api/activity": () => Response.json(activity),
    "/api/history": (request: Request) => {
      const range = new URL(request.url).searchParams.get("range") ?? "";
      const wanted = (new URL(request.url).searchParams.get("keys") ?? "").split(",");
      const found = history.get(range);
      if (!found) return new Response("bad range", { status: 400 });
      return Response.json({ ...found, series: Object.fromEntries(wanted.filter((key) => found.series[key]).map((key) => [key, found.series[key]])) });
    },
    "/api/minutes": (request: Request) => {
      const params = new URL(request.url).searchParams;
      const from = Number(params.get("from"));
      const to = Number(params.get("to"));
      const minutes = [];
      for (let ts = from - (from % 60); ts < to; ts += 60) minutes.push({ ts, avg: (ts / 60) % 97 === 3 ? 0 : 1 });
      return Response.json(minutes);
    },
    "/api/stream": () => {
      let id: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<string>({
        start(controller) {
          id = setInterval(() => {
            tickIndex = (tickIndex + 1) % 300;
            const points = Object.fromEntries(keys.map((key) => [key, initial.history[key]?.[tickIndex] ?? 0]));
            controller.enqueue(`data: ${JSON.stringify({ snapshot: snapshotAt(), points } satisfies TickPayload)}\n\n`);
          }, 1000);
        },
        cancel() {
          clearInterval(id);
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    },
  },
});

console.log(`fixtures on http://localhost:${server.port}`);
