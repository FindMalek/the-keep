import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createSessionScope } from "./scope";
import { parseClaudeSession } from "./claude-code";
import { SessionStore } from "./store";
import { repositoryFor } from "./repository";

test("limits sessions to real paths under allowed roots", () => {
  const base = mkdtempSync(join(tmpdir(), "keep-scope-"));
  const allowed = join(base, "personal");
  const outside = join(base, "personal-company");
  mkdirSync(allowed);
  mkdirSync(outside);
  symlinkSync(outside, join(allowed, "escape"));
  const include = createSessionScope([allowed], []);
  expect(include(allowed)).toBe(true);
  expect(include(outside)).toBe(false);
  expect(include(join(allowed, "escape"))).toBe(false);
  expect(include(null)).toBe(false);
});

test("labels nested sessions with the Git repository name", () => {
  const base = mkdtempSync(join(tmpdir(), "keep-repo-"));
  const repo = join(base, "project");
  mkdirSync(repo);
  mkdirSync(join(repo, "nested"));
  execFileSync("git", ["init", "-q", repo]);
  expect(repositoryFor(join(repo, "nested"))).toBe("project");
  expect(repositoryFor(join(repo, ".claude", "worktrees", "removed"))).toBe("project");
  expect(repositoryFor(join(repo, "missing"))).toBeNull();
  expect(repositoryFor(base)).toBeNull();
});

test("push excludes previously ingested sessions outside the allowed roots", async () => {
  const base = mkdtempSync(join(tmpdir(), "keep-push-scope-"));
  const allowed = join(base, "personal");
  const outside = join(base, "company");
  mkdirSync(allowed);
  mkdirSync(outside);
  const storeDir = join(base, "store");
  const store = new SessionStore(storeDir);
  for (const [id, cwd] of [["one", allowed], ["two", outside]]) {
    const line = JSON.stringify({ sessionId: id, cwd, type: "user", timestamp: "2026-11-01T10:00:00Z", uuid: id, message: { role: "user", content: id } });
    store.upsert(parseClaudeSession(line, "mac")!);
  }
  store.close();
  const received: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method === "GET") return Response.json({ repositories: [] });
    const body = await request.json() as { session: { directory: string } };
    received.push(body.session.directory);
    return new Response(null, { status: 202 });
  } });
  try {
    const child = Bun.spawn([process.execPath, "src/sessions/cli.ts", "push", "--data", storeDir, "--include", allowed, "--claude", join(base, "missing"), "--opencode", join(base, "missing.db"), "--url", String(server.url)], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(received).toEqual([allowed]);
  } finally {
    server.stop(true);
  }
});

test("does not upload to a dashboard without repository labels", async () => {
  const base = mkdtempSync(join(tmpdir(), "keep-push-old-"));
  let posts = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    if (request.method === "POST") posts++;
    return Response.json({ sessions: [] });
  } });
  try {
    const child = Bun.spawn([process.execPath, "src/sessions/cli.ts", "push", "--data", join(base, "store"), "--claude", join(base, "missing"), "--opencode", join(base, "missing.db"), "--url", String(server.url)], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).not.toBe(0);
    expect(posts).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("sends session data through the configured local SOCKS proxy", async () => {
  const base = mkdtempSync(join(tmpdir(), "keep-proxy-"));
  const repo = join(base, "project");
  mkdirSync(repo);
  const bin = join(base, "bin");
  mkdirSync(bin);
  const capture = join(base, "request.json");
  writeFileSync(join(bin, "curl"), '#!/bin/sh\ncase "$*" in *offset=0*) printf "{\\"repositories\\":[]}\\n200" ;; *) cat > "$CAPTURE"; printf "\\n202" ;; esac\n', { mode: 0o755 });
  const storeDir = join(base, "store");
  const store = new SessionStore(storeDir);
  const line = JSON.stringify({ sessionId: "one", cwd: repo, type: "user", timestamp: "2026-11-01T10:00:00Z", uuid: "one", message: { role: "user", content: "hello" } });
  store.upsert(parseClaudeSession(line, "mac")!);
  store.close();
  const child = Bun.spawn([process.execPath, "src/sessions/cli.ts", "push", "--data", storeDir, "--include", repo, "--claude", join(base, "missing"), "--opencode", join(base, "missing.db"), "--url", "https://keep.example"], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, CAPTURE: capture, KEEP_SESSIONS_SOCKS_PROXY: "127.0.0.1:1055" },
  });
  expect(await child.exited).toBe(0);
  expect(JSON.parse(readFileSync(capture, "utf8")).session.directory).toBe(repo);
});

test("pushes updated Claude sessions even when message timestamps do not change", async () => {
  const base = mkdtempSync(join(tmpdir(), "keep-push-updated-"));
  const repo = join(base, "project");
  const claude = join(base, "claude");
  const projectDir = join(claude, "project");
  mkdirSync(repo);
  mkdirSync(claude);
  mkdirSync(projectDir);
  const file = join(projectDir, "one.jsonl");
  const line = (id: string) => JSON.stringify({ sessionId: "one", cwd: repo, type: "user", timestamp: "2026-01-01T00:00:00Z", uuid: id, message: { role: "user", content: id } }) + "\n";
  writeFileSync(file, line("one"));
  const received: number[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method === "GET") return Response.json({ repositories: [] });
    const body = await request.json() as { messages: unknown[] };
    received.push(body.messages.length);
    return new Response(null, { status: 202 });
  } });
  const args = [process.execPath, "src/sessions/cli.ts", "push", "--data", join(base, "store"), "--include", repo, "--claude", claude, "--opencode", join(base, "missing.db"), "--url", String(server.url)];
  try {
    expect(await Bun.spawn(args, { stdout: "pipe", stderr: "pipe" }).exited).toBe(0);
    appendFileSync(file, line("two"));
    const later = new Date(Date.now() + 2000);
    utimesSync(file, later, later);
    expect(await Bun.spawn(args, { stdout: "pipe", stderr: "pipe" }).exited).toBe(0);
    expect(received).toEqual([1, 2]);
  } finally {
    server.stop(true);
  }
});
