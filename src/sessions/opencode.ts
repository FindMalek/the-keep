import { Database } from "bun:sqlite";
import type { ParsedSession, SessionMessage, ToolCall } from "./types";
import { repositoryFor } from "./repository";

type Json = Record<string, any>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function toolOutput(state: Json | undefined): string | null {
  const parts = state?.content;
  if (Array.isArray(parts)) return parts.filter((p: Json) => p?.type === "text").map((p: Json) => String(p.text ?? "")).join("\n");
  return typeof state?.output === "string" ? state.output : null;
}

export function parseOpenCodeMessage(type: string, data: Json, seq: number): SessionMessage | null {
  const at = num(data.time?.created);
  const base = { seq, at, reasoning: null, toolCalls: [] as ToolCall[], model: null, provider: null, tokensIn: 0, tokensOut: 0, tokensReasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, latencyMs: null };

  if (type === "user") {
    const text = String(data.text ?? "").replace(/^"([\s\S]*)"$/, "$1");
    return text.trim() ? { ...base, role: "user", text } : null;
  }
  if (type === "assistant") {
    const content: Json[] = Array.isArray(data.content) ? data.content : [];
    const t = data.tokens ?? {};
    return {
      ...base,
      role: "assistant",
      text: content.filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("\n"),
      reasoning: content.filter((c) => c.type === "reasoning").map((c) => String(c.text ?? "")).join("\n") || null,
      toolCalls: content
        .filter((c) => c.type === "tool")
        .map((c) => ({
          name: String(c.name),
          input: c.state?.input,
          output: toolOutput(c.state),
          status: c.state?.status === "completed" ? "completed" : c.state?.status === "error" ? "error" : "unknown",
        })),
      model: data.model?.id ?? null,
      provider: data.model?.providerID ?? null,
      tokensIn: num(t.input),
      tokensOut: num(t.output),
      tokensReasoning: num(t.reasoning),
      cacheRead: num(t.cache?.read),
      cacheWrite: num(t.cache?.write),
      costUsd: typeof data.cost === "number" ? data.cost : null,
      latencyMs: data.time?.completed && at ? num(data.time.completed) - at : null,
    };
  }
  if (type === "system") {
    const text = String(data.text ?? "");
    return text.trim() ? { ...base, role: "system", text } : null;
  }
  return null;
}

/** Reads sessions from OpenCode's SQLite database, read-only. */
export function* readOpenCode(dbPath: string, machine: string, since = 0, include: (directory: string | null) => boolean = () => true, changed: (id: string, updatedAt: number) => boolean = () => true): Generator<ParsedSession> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const sessions = db
      .query("SELECT s.*, p.worktree AS project_worktree FROM session_v2 s LEFT JOIN project p ON p.id = s.project_id WHERE s.time_updated > ? ORDER BY s.time_created")
      .all(since) as Json[];
    const msgs = db.query("SELECT type, data, seq FROM session_message WHERE session_id = ? ORDER BY seq");
    for (const s of sessions) {
      if (!include(s.directory ?? null) || !changed(s.id, s.time_updated)) continue;
      const messages: SessionMessage[] = [];
      for (const row of msgs.all(s.id) as Json[]) {
        let data: Json;
        try {
          data = JSON.parse(row.data);
        } catch {
          continue;
        }
        const m = parseOpenCodeMessage(row.type, data, messages.length);
        if (m) messages.push(m);
      }
      if (!messages.length) continue;
      const model = s.model ? (JSON.parse(s.model) as Json) : null;
      yield {
        session: {
          id: `opencode:${machine}:${s.id}`,
          nativeId: s.id,
          tool: "opencode",
          machine,
          directory: s.directory ?? null,
          repository: repositoryFor(s.directory ?? null) ?? repositoryFor(s.project_worktree ?? null),
          branch: null,
          title: s.title ?? null,
          startedAt: s.time_created,
          endedAt: s.time_updated,
          costUsd: s.cost,
          models: model
            ? [{ model: model.id, tokensIn: s.tokens_input, tokensOut: s.tokens_output, cacheRead: s.tokens_cache_read, cacheWrite: s.tokens_cache_write, costUsd: s.cost }]
            : [],
        },
        messages,
      };
    }
  } finally {
    db.close();
  }
}
