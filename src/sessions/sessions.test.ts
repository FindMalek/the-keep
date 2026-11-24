import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeSession } from "./claude-code";
import { toClaudeJsonl, toHandoffMarkdown, toOpenCodeJson } from "./export";
import { parseOpenCodeMessage, readOpenCode } from "./opencode";
import { SessionStore } from "./store";

const line = (o: unknown) => JSON.stringify(o);
const base = { sessionId: "s1", cwd: "/work/app", gitBranch: "main" };

const claudeFixture = [
  line({ ...base, type: "user", timestamp: "2026-11-01T10:00:00Z", uuid: "u1", message: { role: "user", content: "fix the bug" } }),
  // one API reply streamed as two lines sharing message.id: usage must count once
  line({ ...base, type: "assistant", timestamp: "2026-11-01T10:00:02Z", uuid: "a1", message: { id: "m1", model: "claude-x", content: [{ type: "text", text: "looking" }], usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 100 } } }),
  line({ ...base, type: "assistant", timestamp: "2026-11-01T10:00:03Z", uuid: "a2", message: { id: "m1", model: "claude-x", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }], usage: { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 100 } } }),
  line({ ...base, type: "user", timestamp: "2026-11-01T10:00:04Z", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] } }),
  line({ ...base, type: "cost-state", startTime: 1, totalCostUSD: 0.5, modelUsage: { "claude-x": { inputTokens: 5, outputTokens: 40, costUSD: 0.5 } } }),
  line({ ...base, type: "cost-state", startTime: 1, totalCostUSD: 0.75, modelUsage: { "claude-x": { inputTokens: 9, outputTokens: 50, costUSD: 0.75 } } }),
  line({ ...base, type: "cost-state", startTime: 2, totalCostUSD: 0.25, modelUsage: { "claude-x": { inputTokens: 1, outputTokens: 5, costUSD: 0.25 } } }),
  '{"type":"assistant","half written',
].join("\n");

describe("claude code", () => {
  const parsed = parseClaudeSession(claudeFixture, "mac")!;

  test("merges streamed lines, attaches tool results, ignores a torn last line", () => {
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const reply = parsed.messages[1]!;
    expect(reply.tokensOut).toBe(40);
    expect(reply.cacheRead).toBe(100);
    expect(reply.toolCalls).toEqual([{ name: "Read", input: { path: "a.ts" }, output: "file body", status: "completed" }]);
  });

  test("session cost sums each process run's last reading", () => {
    expect(parsed.session.costUsd).toBeCloseTo(1.0);
    expect(parsed.session.models[0]!.tokensOut).toBe(55);
  });

  test("title falls back to the first prompt when the session has no ai-title yet", () => {
    expect(parsed.session.title).toBe("fix the bug");
  });

  test("an exported Claude file parses back to the same conversation", () => {
    const { jsonl } = toClaudeJsonl(parsed);
    const back = parseClaudeSession(jsonl, "other")!;
    expect(back.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(back.messages[1]!.text).toContain("[tool Read]");
    expect(back.session.directory).toBe("/work/app");
  });

  test("keeps subagent conversations separate from their parent", () => {
    const line = JSON.stringify({ ...base, agentId: "agent1", isSidechain: true, type: "user", timestamp: "2026-11-01T10:00:00Z", message: { role: "user", content: "subtask" } });
    expect(parseClaudeSession(line, "mac")).toBeNull();
    const agent = parseClaudeSession(line, "mac", true)!;
    expect(agent.session.id).toBe("claude-code:mac:agent:agent1");
    expect(agent.messages[0]?.text).toBe("subtask");
  });

  test("uses an unknown time when a conversation has no timestamps", () => {
    const parsed = parseClaudeSession(JSON.stringify({ ...base, type: "user", message: { role: "user", content: "hello" } }), "mac")!;
    expect(parsed.session.startedAt).toBe(0);
    expect(parsed.session.endedAt).toBe(0);
  });
});

describe("opencode", () => {
  test("imports child sessions as separate conversations", () => {
    const dir = mkdtempSync(join(tmpdir(), "keep-opencode-"));
    const path = join(dir, "opencode.db");
    const db = new Database(path);
    db.run("CREATE TABLE project (id TEXT, worktree TEXT)");
    db.run("CREATE TABLE session_v2 (id TEXT, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, model TEXT, cost REAL, time_created INTEGER, time_updated INTEGER)");
    db.run("CREATE TABLE session_message (session_id TEXT, type TEXT, data TEXT, seq INTEGER)");
    db.run("INSERT INTO session_v2 VALUES ('parent', NULL, NULL, NULL, NULL, NULL, NULL, 1, 2), ('child', NULL, 'parent', NULL, NULL, NULL, NULL, 1, 2)");
    db.run("INSERT INTO session_message VALUES ('parent', 'user', '{\"text\":\"hello\"}', 0), ('child', 'user', '{\"text\":\"subtask\"}', 0)");
    db.close();
    expect([...readOpenCode(path, "mac")].map((entry) => entry.session.nativeId)).toEqual(["parent", "child"]);
  });

  test("reads tokens, cost, reasoning and tool output from an assistant message", () => {
    const m = parseOpenCodeMessage(
      "assistant",
      {
        time: { created: 1000, completed: 1900 },
        model: { id: "gemini", providerID: "openrouter" },
        tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
        cost: 0.01,
        content: [
          { type: "reasoning", text: "hmm" },
          { type: "text", text: "done" },
          { type: "tool", name: "bash", state: { status: "completed", input: { cmd: "ls" }, content: [{ type: "text", text: "a\nb" }] } },
        ],
      },
      0,
    )!;
    expect(m).toMatchObject({ tokensIn: 10, tokensOut: 2, tokensReasoning: 3, cacheRead: 4, cacheWrite: 5, costUsd: 0.01, latencyMs: 900, provider: "openrouter", reasoning: "hmm" });
    expect(m.toolCalls[0]).toMatchObject({ name: "bash", output: "a\nb", status: "completed" });
  });
});

describe("store and exports", () => {
  const parsed = parseClaudeSession(claudeFixture, "mac")!;

  test("upsert replaces a growing session instead of duplicating it", () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "keep-sessions-")));
    store.upsert(parsed);
    store.upsert({ ...parsed, messages: parsed.messages.slice(0, 1) });
    expect(store.list()).toHaveLength(1);
    expect(store.get(parsed.session.id)!.messages).toHaveLength(1);
    store.close();
  });

  test("stores repository labels and filters sessions without exposing the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "keep-sessions-private-"));
    const store = new SessionStore(dir);
    store.upsert({ ...parsed, session: { ...parsed.session, repository: "the-keep" } });
    store.upsert({ ...parsed, session: { ...parsed.session, id: "other", repository: "jobflow" } });
    expect(store.repositories()).toEqual(["jobflow", "the-keep"]);
    expect(store.count("jobflow")).toBe(1);
    expect(store.list(50, 0, "jobflow")[0]?.repository).toBe("jobflow");
    expect(statSync(join(dir, "sessions.db")).mode & 0o777).toBe(0o600);
    store.close();
  });

  test("preserves existing sessions when adding repository labels", () => {
    const dir = mkdtempSync(join(tmpdir(), "keep-sessions-old-"));
    const db = new Database(join(dir, "sessions.db"));
    db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, tool TEXT NOT NULL, machine TEXT NOT NULL, native_id TEXT NOT NULL, directory TEXT, branch TEXT, title TEXT, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, cost_usd REAL, models TEXT NOT NULL)");
    db.run("INSERT INTO sessions VALUES ('old', 'opencode', 'mac', '1', NULL, NULL, NULL, 1, 2, NULL, '[]')");
    db.close();
    const store = new SessionStore(dir);
    expect(store.get("old")?.session.repository).toBeNull();
    expect(store.count()).toBe(1);
    store.close();
    const oldVersion = new Database(join(dir, "sessions.db"));
    oldVersion.run("INSERT INTO sessions VALUES ('old-code', 'opencode', 'mac', '2', NULL, NULL, NULL, 1, 2, NULL, '[]')");
    oldVersion.close();
    const reopened = new SessionStore(dir);
    expect(reopened.count()).toBe(2);
    reopened.close();
  });

  test("re-reads a source only when its size or modification time changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "keep-session-source-"));
    const store = new SessionStore(dir);
    expect(store.sourceUnchanged("session.jsonl", 10, 20)).toBe(false);
    store.markSource("session.jsonl", 10, 20);
    expect(store.sourceUnchanged("session.jsonl", 10, 20)).toBe(true);
    expect(store.sourceUnchanged("session.jsonl", 10, 21)).toBe(false);
    store.close();
  });

  test("keeps labels from an earlier local schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "keep-sessions-repo-"));
    const db = new Database(join(dir, "sessions.db"));
    db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, tool TEXT NOT NULL, machine TEXT NOT NULL, native_id TEXT NOT NULL, directory TEXT, branch TEXT, title TEXT, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, cost_usd REAL, models TEXT NOT NULL, repository TEXT)");
    db.run("INSERT INTO sessions VALUES ('old', 'opencode', 'mac', '1', NULL, NULL, NULL, 1, 2, NULL, '[]', 'jobflow')");
    db.close();
    const store = new SessionStore(dir);
    expect(store.get("old")?.session.repository).toBe("jobflow");
    store.close();
  });

  test("OpenCode export uses time-ordered ids and the given project", () => {
    const { id, json } = toOpenCodeJson(parsed, { projectID: "abc" });
    const out = JSON.parse(json);
    expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(out.info.projectID).toBe("abc");
    expect(out.messages.map((m: { type: string }) => m.type)).toEqual(["user", "assistant"]);
    expect(out.messages[0].id < out.messages[1].id).toBe(true);
  });

  test("handoff keeps the newest turns when over the size limit", () => {
    const md = toHandoffMarkdown(parsed, 60);
    expect(md).toContain("earlier turns omitted");
    expect(md).toContain("[tool Read]");
  });
});
