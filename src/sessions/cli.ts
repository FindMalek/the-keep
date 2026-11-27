#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parseClaudeSession } from "./claude-code";
import { toClaudeJsonl, toHandoffMarkdown, toOpenCodeJson } from "./export";
import { readOpenCode } from "./opencode";
import { SessionStore } from "./store";
import type { ParsedSession } from "./types";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = flag("data") ?? process.env.KEEP_SESSIONS_DIR ?? join(homedir(), ".local/share/keep-sessions");
const machine = flag("machine") ?? hostname().split(".")[0]!;
const excludes = (flag("exclude") ?? process.env.KEEP_SESSIONS_EXCLUDE ?? "").split(",").filter(Boolean);
const skipped = (dir: string | null) => !!dir && excludes.some((e) => dir.includes(e));
const store = new SessionStore(dataDir);

function safeDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function ingest(): void {
  let added = 0;
  const claudeRoot = flag("claude") ?? join(homedir(), ".claude/projects");
  for (const proj of safeDir(claudeRoot)) {
    for (const f of safeDir(join(claudeRoot, proj)).filter((n) => n.endsWith(".jsonl"))) {
      const path = join(claudeRoot, proj, f);
      const known = store.endedAt(`claude-code:${machine}:${f.slice(0, -6)}`);
      if (known !== null && known >= statSync(path).mtimeMs - 1000) continue;
      const parsed = parseClaudeSession(readFileSync(path, "utf8"), machine);
      if (!parsed || skipped(parsed.session.directory)) continue;
      store.upsert(parsed);
      added++;
    }
  }
  const ocDb = flag("opencode") ?? join(homedir(), ".local/share/opencode/opencode.db");
  try {
    for (const parsed of readOpenCode(ocDb, machine)) {
      if (skipped(parsed.session.directory)) continue;
      if ((store.endedAt(parsed.session.id) ?? 0) >= parsed.session.endedAt) continue;
      store.upsert(parsed);
      added++;
    }
  } catch (e) {
    console.error(`opencode: ${(e as Error).message}`);
  }
  console.log(`ingested ${added} sessions`);
}

function opencodeProjectId(dbPath: string, directory: string | null): string | null {
  if (!directory) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT id FROM project WHERE worktree = ?").get(directory) as { id: string } | null;
    db.close();
    return row?.id ?? null;
  } catch {
    return null;
  }
}

function exportTo(p: ParsedSession, target: string | undefined): void {
  if (target === "claude") {
    const cwd = flag("cwd") ?? p.session.directory ?? process.cwd();
    const { id: newId, jsonl } = toClaudeJsonl(p, { cwd });
    const dir = join(homedir(), ".claude/projects", cwd.replaceAll("/", "-").replaceAll(".", "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${newId}.jsonl`), jsonl);
    console.log(`written. resume with: cd ${cwd} && claude --resume ${newId}`);
  } else if (target === "opencode") {
    const projectID = flag("project") ?? opencodeProjectId(flag("opencode") ?? join(homedir(), ".local/share/opencode/opencode.db"), p.session.directory);
    if (!projectID) {
      console.error("no OpenCode project for that directory yet: run `opencode` once in it, or pass --project <id>");
      process.exit(1);
    }
    const { json } = toOpenCodeJson(p, { projectID });
    const out = flag("out") ?? join(dataDir, "export-opencode.json");
    writeFileSync(out, json);
    console.log(`written ${out}. import with: opencode session import ${out}${p.session.directory ? ` --directory ${p.session.directory}` : ""}`);
  } else if (target === "markdown") console.log(toHandoffMarkdown(p));
  else {
    console.error("usage: export|pull <session-id> claude|opencode|markdown");
    process.exit(1);
  }
}

const keepUrl = () => {
  const url = flag("url") ?? process.env.KEEP_URL;
  if (!url) {
    console.error("set KEEP_URL (the dashboard's tailnet address) or pass --url");
    process.exit(1);
  }
  return url.replace(/\/$/, "");
};

/** Sends sessions that are new or grew since the last push. Remembers what it sent in `pushed.json`. */
async function push(): Promise<void> {
  const url = keepUrl();
  const markerPath = join(dataDir, "pushed.json");
  let pushed: Record<string, number> = {};
  try {
    pushed = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    // first run
  }
  let sent = 0;
  for (const row of store.index()) {
    if ((pushed[row.id] ?? 0) >= row.endedAt) continue;
    const parsed = store.get(row.id)!;
    const res = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { "x-keep-action": "1", "content-type": "application/json" },
      body: JSON.stringify(parsed),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.error(`push ${row.id}: ${res.status}`);
      continue;
    }
    pushed[row.id] = row.endedAt;
    sent++;
    writeFileSync(markerPath, JSON.stringify(pushed));
  }
  console.log(`pushed ${sent} sessions`);
}

async function pull(id: string | undefined, target: string | undefined): Promise<void> {
  const res = await fetch(`${keepUrl()}/api/session?id=${encodeURIComponent(id ?? "")}`, { headers: { "x-keep-action": "1" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    console.error(`pull: ${res.status}`);
    process.exit(1);
  }
  exportTo((await res.json()) as ParsedSession, target);
}

function need(id: string | undefined) {
  const p = id ? store.get(id) : null;
  if (!p) {
    console.error("session not found; run `list` for ids");
    process.exit(1);
  }
  return p;
}

if (cmd === "ingest") ingest();
else if (cmd === "list") {
  for (const s of store.list({ limit: Number(flag("limit") ?? 20) }))
    console.log(
      `${s.id}  ${new Date(s.startedAt).toISOString().slice(0, 16)}  ${String(s.messageCount).padStart(4)} msgs  ${(s.tokensIn + s.tokensOut + s.cacheRead + s.cacheWrite).toLocaleString()} tok  ${s.costUsd == null ? "-" : `$${s.costUsd.toFixed(2)}`}  ${s.title ?? ""}`,
    );
} else if (cmd === "export") exportTo(need(args[0]), args[1]);
else if (cmd === "push") {
  ingest();
  await push();
} else if (cmd === "pull") await pull(args[0], args[1]);
else {
  console.error("usage: keep-sessions ingest|list|push|export <id> claude|opencode|markdown|pull <id> claude|opencode|markdown [--url ...] [--data dir] [--machine name] [--exclude a,b]");
  process.exit(1);
}
