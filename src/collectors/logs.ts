import type { JobRun, LogEntry, LogHistogram, LogPage } from "../shared/types";

export interface LogQuery {
  q: string | null;
  since: string | null;
  until: string | null;
  /** Priorities to show, 0 (emerg) to 7 (debug); empty means all. */
  prio: number[];
  units: string[];
  sources: string[];
  boot: string | null;
  before: string | null;
  after: string | null;
  limit: number;
  fields: boolean;
}

const UNIT = /^[\w@.:-]+\.(service|timer|scope|socket|mount|slice)$/;
const SOURCE = /^[\w.@:-]{1,64}$/;
const BOOT = /^-?\d{1,3}$|^[0-9a-f]{32}$/;
const CURSOR = /^[\w=;-]{1,300}$/;
const TIME = /^\d{9,11}(\.\d+)?$|^-\d{1,4}(s|m|min|h|d)$|^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
const FIELDS = ["MESSAGE", "PRIORITY", "SYSLOG_IDENTIFIER", "_COMM", "_SYSTEMD_UNIT", "_PID", "_TRANSPORT"];

/** Parses `/api/logs` params; returns an error message instead of passing anything unchecked to journalctl. */
export function parseLogQuery(params: URLSearchParams): LogQuery | string {
  const q = params.get("q")?.trim() || null;
  if (q && q.length > 200) return "q: at most 200 characters";
  const since = params.get("since") || null;
  const until = params.get("until") || null;
  for (const [name, value] of [["since", since], ["until", until]] as const) if (value && !TIME.test(value)) return `${name}: unix seconds, -1h or YYYY-MM-DD HH:MM`;
  const prio = (params.get("prio") ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number);
  if (prio.some((value) => !Number.isInteger(value) || value < 0 || value > 7)) return "prio: numbers 0-7";
  const units = params.getAll("unit");
  if (units.some((unit) => !UNIT.test(unit))) return "unit: a systemd unit name";
  const sources = params.getAll("source");
  if (sources.some((source) => !SOURCE.test(source))) return "source: a syslog identifier";
  const boot = params.get("boot") || null;
  if (boot && !BOOT.test(boot)) return "boot: an offset or boot id";
  const before = params.get("before") || null;
  const after = params.get("after") || null;
  if ((before && !CURSOR.test(before)) || (after && !CURSOR.test(after))) return "bad cursor";
  const limit = Math.min(500, Math.max(1, Number(params.get("limit") ?? 200) || 200));
  return { q, since, until, prio: [...new Set(prio)].sort(), units, sources, boot, before, after, limit, fields: params.get("fields") === "1" };
}

function time(value: string): string {
  return /^\d/.test(value) && !value.includes("-") ? `@${value}` : value;
}

/** journalctl's -p takes one range; a gap (errors and info, no warnings) widens it and the caller drops the rest. */
function prioRange(prio: number[]): string | null {
  if (!prio.length || prio.length === 8) return null;
  return `${prio[0]}..${prio.at(-1)}`;
}

/** The filter part of the argv, shared by the entry list and the histogram. */
export function filterArgs(query: Pick<LogQuery, "q" | "since" | "until" | "prio" | "units" | "sources" | "boot">): string[] {
  const args: string[] = [];
  if (query.q) args.push(`--grep=${query.q}`, "--case-sensitive=false");
  if (query.since) args.push(`--since=${time(query.since)}`);
  if (query.until) args.push(`--until=${time(query.until)}`);
  const range = prioRange(query.prio);
  if (range) args.push(`--priority=${range}`);
  for (const unit of query.units) args.push(`--unit=${unit}`);
  if (query.boot) args.push(`--boot=${query.boot}`);
  // Matches on one field are OR'd by journalctl; they go last because they are positional.
  for (const source of query.sources) args.push(`SYSLOG_IDENTIFIER=${source}`);
  return args;
}

/** Newest first. Older pages start at the `before` cursor (journalctl includes it, so ask for one more). */
export function pageArgs(query: LogQuery): string[] {
  const output = ["--output=json", "--no-pager"];
  if (!query.fields) output.push(`--output-fields=${FIELDS.join(",")}`);
  const filters = filterArgs(query);
  const positional = filters.filter((arg) => !arg.startsWith("-"));
  const options = filters.filter((arg) => arg.startsWith("-"));
  if (query.after) return [...output, ...options, `--after-cursor=${query.after}`, `--lines=${query.limit}`, ...positional];
  if (query.before) return [...output, ...options, "--reverse", `--cursor=${query.before}`, `--lines=${query.limit + 1}`, ...positional];
  return [...output, ...options, "--reverse", `--lines=${query.limit}`, ...positional];
}

type Raw = Record<string, unknown>;

/** journald sends non-UTF-8 values as byte arrays. */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return new TextDecoder().decode(new Uint8Array(value as number[]));
  return value === undefined || value === null ? "" : String(value);
}

export function toEntry(raw: Raw, withFields: boolean): LogEntry {
  const pid = Number(text(raw._PID));
  const entry: LogEntry = {
    cursor: text(raw.__CURSOR),
    at: Number(text(raw.__REALTIME_TIMESTAMP)),
    priority: raw.PRIORITY === undefined ? 6 : Number(text(raw.PRIORITY)),
    source: text(raw.SYSLOG_IDENTIFIER) || text(raw._COMM) || (text(raw._TRANSPORT) === "kernel" ? "kernel" : "?"),
    unit: text(raw._SYSTEMD_UNIT) || null,
    pid: Number.isFinite(pid) && pid > 0 ? pid : null,
    message: text(raw.MESSAGE),
  };
  if (withFields) {
    entry.fields = Object.fromEntries(
      Object.entries(raw)
        .filter(([key]) => key !== "MESSAGE")
        .map(([key, value]) => [key, text(value)]),
    );
  }
  return entry;
}

function parseLines(output: string): Raw[] {
  const rows: Raw[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(line) as Raw);
    } catch {
      // A line cut by the output cap.
    }
  }
  return rows;
}

export interface JournalOptions {
  /** argv prefix, e.g. ["journalctl"]. */
  command: string[];
  /** Journal files mounted from the host; null reads the local journal. */
  directory: string | null;
  timeoutMs?: number;
  maxBytes?: number;
}

export class JournalError extends Error {}

export function createJournal({ command, directory, timeoutMs = 10_000, maxBytes = 5 * 1024 * 1024 }: JournalOptions) {
  const base = [...command, ...(directory ? [`--directory=${directory}`] : [])];

  /** Runs journalctl and hands each stdout chunk to `onChunk`; stops early when it returns false. */
  async function stream(args: string[], onChunk: (chunk: string) => boolean | void): Promise<{ partial: boolean }> {
    const proc = Bun.spawn([...base, ...args], { stdout: "pipe", stderr: "pipe" });
    let partial = false;
    const timer = setTimeout(() => {
      partial = true;
      proc.kill();
    }, timeoutMs);
    const decoder = new TextDecoder();
    try {
      for await (const chunk of proc.stdout) {
        if (onChunk(decoder.decode(chunk, { stream: true })) === false) {
          partial = true;
          proc.kill();
          break;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    const code = await proc.exited;
    // 1 with no output is "no entries" for --grep; anything on stderr without output is a real error.
    if (code !== 0 && !partial) {
      const error = (await new Response(proc.stderr).text()).trim();
      if (error && !/^-- No entries --$/m.test(error)) throw new JournalError(error.split("\n")[0] ?? "journalctl failed");
    }
    return { partial };
  }

  async function run(args: string[]): Promise<string> {
    let out = "";
    await stream(args, (chunk) => {
      out += chunk;
      return out.length < maxBytes;
    });
    return out;
  }

  async function page(query: LogQuery): Promise<LogPage> {
    let rows = parseLines(await run(pageArgs(query)));
    if (query.after) rows.reverse();
    if (query.before && text(rows[0]?.__CURSOR) === query.before) rows = rows.slice(1);
    let entries = rows.map((row) => toEntry(row, query.fields));
    if (query.prio.length) entries = entries.filter((entry) => query.prio.includes(entry.priority));
    const last = rows.at(-1);
    const full = rows.length >= query.limit;
    return {
      entries,
      before: full && last ? text(last.__CURSOR) : null,
      after: rows.length ? text(rows[0]?.__CURSOR) : query.after,
    };
  }

  async function entry(cursor: string): Promise<LogEntry | null> {
    if (!CURSOR.test(cursor)) return null;
    const rows = parseLines(await run(["--output=json", "--no-pager", `--cursor=${cursor}`, "--lines=1", "--reverse"]));
    const row = rows.find((candidate) => text(candidate.__CURSOR) === cursor) ?? rows[0];
    return row ? toEntry(row, true) : null;
  }

  /** Line and error counts per bucket. Reads only timestamps and priorities, and stops at the timeout. */
  async function histogram(query: LogQuery, fromMs: number, toMs: number, count: number): Promise<LogHistogram> {
    const stepMs = Math.max(1000, Math.ceil((toMs - fromMs) / count));
    const buckets = Array.from({ length: count }, () => ({ lines: 0, errors: 0 }));
    const args = [
      "--output=json",
      "--no-pager",
      "--output-fields=PRIORITY",
      ...filterArgs({ ...query, since: String(Math.floor(fromMs / 1000)), until: String(Math.ceil(toMs / 1000)) }),
    ];
    let rest = "";
    const { partial } = await stream(args, (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const at = /"__REALTIME_TIMESTAMP":"(\d+)"/.exec(line);
        if (!at?.[1]) continue;
        const index = Math.floor((Number(at[1]) / 1000 - fromMs) / stepMs);
        const bucket = buckets[index];
        if (!bucket) continue;
        const prio = /"PRIORITY":"(\d)"/.exec(line);
        if (query.prio.length && !query.prio.includes(Number(prio?.[1] ?? 6))) continue;
        bucket.lines += 1;
        if (prio && Number(prio[1]) <= 3) bucket.errors += 1;
      }
    });
    return { from: fromMs, stepMs, buckets, partial };
  }

  let unitCache: { at: number; units: string[] } | null = null;
  async function units(): Promise<string[]> {
    if (unitCache && Date.now() - unitCache.at < 5 * 60_000) return unitCache.units;
    const list = (await run(["--field=_SYSTEMD_UNIT", "--no-pager"])).split("\n").filter((unit) => UNIT.test(unit));
    unitCache = { at: Date.now(), units: list.sort() };
    return unitCache.units;
  }

  async function boots(): Promise<{ id: string; index: number; first: number; last: number }[]> {
    const out = await run(["--list-boots", "--output=json", "--no-pager"]);
    try {
      const list = JSON.parse(out) as { index: number; boot_id: string; first_entry: number; last_entry: number }[];
      return list.map((boot) => ({ id: boot.boot_id, index: boot.index, first: boot.first_entry / 1000, last: boot.last_entry / 1000 })).reverse();
    } catch {
      return [];
    }
  }

  /** The newest `limit` runs of a systemd service, oldest line first within each run. */
  async function runs(unit: string, limit: number): Promise<JobRun[]> {
    if (!UNIT.test(unit)) return [];
    const fields = [...FIELDS, "_SYSTEMD_INVOCATION_ID", "INVOCATION_ID", "JOB_RESULT"];
    const rows = parseLines(await run(["--output=json", "--no-pager", `--output-fields=${fields.join(",")}`, `--unit=${unit}`, "--reverse", "--lines=3000"]));
    const groups = new Map<string, Raw[]>();
    for (const row of rows) {
      const id = text(row._SYSTEMD_INVOCATION_ID) || text(row.INVOCATION_ID);
      if (!id) continue;
      if (!groups.has(id)) {
        if (groups.size >= limit) break;
        groups.set(id, []);
      }
      groups.get(id)?.push(row);
    }
    return [...groups].map(([invocation, group]) => {
      const lines = group.reverse().map((row) => toEntry(row, false));
      const outcome = group.map((row) => text(row.JOB_RESULT)).find(Boolean);
      const result: JobRun["result"] = outcome === "done" ? "success" : outcome ? "failed" : "running";
      return {
        invocation,
        start: (lines[0]?.at ?? 0) / 1000,
        end: outcome ? (lines.at(-1)?.at ?? 0) / 1000 : null,
        result,
        lines: lines.slice(-500),
      };
    });
  }

  return { page, entry, histogram, units, boots, runs };
}

export type Journal = ReturnType<typeof createJournal>;
