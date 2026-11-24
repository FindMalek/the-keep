#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parseClaudeSession } from "./claude-code";
import { toClaudeJsonl, toHandoffMarkdown, toOpenCodeJson } from "./export";
import { readOpenCode } from "./opencode";
import { SessionStore } from "./store";
import { createSessionScope } from "./scope";
import { repositoryFor } from "./repository";
import type { ParsedSession } from "./types";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = flag("data") ?? process.env.KEEP_SESSIONS_DIR ?? join(homedir(), ".local/share/keep-sessions");
const machine = flag("machine") ?? hostname().split(".")[0]!;
const includes = (flag("include") ?? process.env.KEEP_SESSIONS_INCLUDE ?? "").split(",").map((path) => path.trim()).filter(Boolean);
const excludes = (flag("exclude") ?? process.env.KEEP_SESSIONS_EXCLUDE ?? "").split(",").map((path) => path.trim()).filter(Boolean);
const included = createSessionScope(includes, excludes);
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
    const projectDir = join(claudeRoot, proj);
    const entries = safeDir(projectDir);
    const files = entries.filter((name) => name.endsWith(".jsonl")).map((name) => ({ path: join(projectDir, name), sidechain: false }));
    for (const entry of entries.filter((name) => !name.endsWith(".jsonl"))) {
      const agents = join(projectDir, entry, "subagents");
      for (const name of safeDir(agents).filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))) {
        files.push({ path: join(agents, name), sidechain: true });
      }
    }
    for (const file of files) {
      const { path } = file;
      let content: string;
      let mtime: number;
      let size: number;
      try {
        const stat = statSync(path);
        mtime = stat.mtimeMs;
        size = stat.size;
        if (store.sourceUnchanged(path, mtime, size)) continue;
        content = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const parsed = parseClaudeSession(content, machine, file.sidechain);
      if (!parsed) {
        store.markSource(path, mtime, size);
        continue;
      }
      if (!included(parsed.session.directory)) continue;
      parsed.session.endedAt = Math.max(parsed.session.endedAt, mtime);
      parsed.session.repository ??= repositoryFor(parsed.session.directory);
      store.upsert(parsed);
      store.markSource(path, mtime, size);
      added++;
    }
  }
  const ocDb = flag("opencode") ?? join(homedir(), ".local/share/opencode/opencode.db");
  try {
    for (const parsed of readOpenCode(ocDb, machine, 0, included, (id, updatedAt) => (store.endedAt(`opencode:${machine}:${id}`) ?? -1) < updatedAt)) {
      parsed.session.repository ??= repositoryFor(parsed.session.directory);
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
  const parsed = new URL(url);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.username || parsed.password || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))) {
    throw new Error("session sync requires HTTPS, except on localhost");
  }
  return url.replace(/\/$/, "");
};

async function sessionRequest(url: string, body?: string): Promise<{ status: number; body: string }> {
  const proxy = process.env.KEEP_SESSIONS_SOCKS_PROXY;
  if (!proxy) {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST", headers: { "x-keep-action": "1", "content-type": "application/json" },
      body, redirect: "error", signal: AbortSignal.timeout(60_000),
    });
    return { status: response.status, body: await response.text() };
  }
  if (!/^(localhost|127\.0\.0\.1):\d{1,5}$/.test(proxy)) throw new Error("session proxy must be local");
  const args = ["curl", "--silent", "--show-error", "--socks5-hostname", proxy,
    "--connect-timeout", "10", "--max-time", "60", "--header", "x-keep-action: 1", "--header", "content-type: application/json",
    "--write-out", "\n%{http_code}"];
  if (body !== undefined) args.push("--data-binary", "@-");
  args.push(url);
  const child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  if (body !== undefined) child.stdin.write(body);
  child.stdin.end();
  const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error(`session proxy request failed (${exit})`);
  const match = /\n(\d{3})$/.exec(output);
  if (!match) throw new Error("invalid session proxy response");
  return { status: Number(match[1]), body: output.slice(0, match.index) };
}

/** Sends sessions that are new or changed since the last push. */
async function push(): Promise<void> {
  const url = keepUrl();
  const capability = await sessionRequest(`${url}/api/sessions?offset=0`);
  if (capability.status !== 200 || !Array.isArray(JSON.parse(capability.body).repositories)) {
    throw new Error("dashboard must support repository labels before sessions can be synced");
  }
  ingest();
  const markerPath = join(dataDir, "pushed-v2.json");
  let pushed: Record<string, number> = {};
  try {
    pushed = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    // first run
  }
  let sent = 0;
  for (const row of store.list(100_000)) {
    if (!included(row.directory)) continue;
    if (pushed[row.id] !== undefined && pushed[row.id]! >= row.endedAt) continue;
    const parsed = store.get(row.id)!;
    parsed.session.repository ??= repositoryFor(parsed.session.directory);
    const response = await sessionRequest(`${url}/api/sessions`, JSON.stringify(parsed));
    if (response.status < 200 || response.status >= 300) {
      console.error(`push ${row.id}: ${response.status}`);
      continue;
    }
    pushed[row.id] = row.endedAt;
    sent++;
    writeFileSync(markerPath, JSON.stringify(pushed), { mode: 0o600 });
    chmodSync(markerPath, 0o600);
  }
  console.log(`pushed ${sent} sessions`);
}

async function pull(id: string | undefined, target: string | undefined): Promise<void> {
  const res = await sessionRequest(`${keepUrl()}/api/session?id=${encodeURIComponent(id ?? "")}`);
  if (res.status < 200 || res.status >= 300) {
    console.error(`pull: ${res.status}`);
    process.exit(1);
  }
  exportTo(JSON.parse(res.body) as ParsedSession, target);
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
  for (const s of store.list(Number(flag("limit") ?? 20)))
    console.log(
      `${s.id}  ${new Date(s.startedAt).toISOString().slice(0, 16)}  ${String(s.messageCount).padStart(4)} msgs  ${(s.tokensIn + s.tokensOut).toLocaleString()} tok  ${s.costUsd == null ? "-" : `$${s.costUsd.toFixed(2)}`}  ${s.title ?? ""}`,
    );
} else if (cmd === "export") exportTo(need(args[0]), args[1]);
else if (cmd === "push") {
  await push();
} else if (cmd === "pull") await pull(args[0], args[1]);
else {
  console.error("usage: keep-sessions ingest|list|push|export <id> claude|opencode|markdown|pull <id> claude|opencode|markdown [--url ...] [--data dir] [--machine name] [--include a,b] [--exclude a,b]");
  process.exit(1);
}
