import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeSession } from "./claude-code";
import { toClaudeJsonl, toHandoffMarkdown, toOpenCodeJson } from "./export";
import { parseOpenCodeMessage } from "./opencode";
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
});

describe("opencode", () => {
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
