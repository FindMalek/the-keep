import type { ParsedSession, SessionMessage, SessionModelUsage, ToolCall } from "./types";

type Json = Record<string, any>;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: Json) => b?.type === "text")
    .map((b: Json) => String(b.text ?? ""))
    .join("\n");
}

/** Parses one Claude Code session file (JSONL). Streaming splits one API reply into several lines sharing `message.id`; they are merged. */
export function parseClaudeSession(jsonl: string, machine: string): ParsedSession | null {
  const lines: Json[] = [];
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      // a half-written last line while the session is live
    }
  }

  const nativeId = lines.find((l) => typeof l.sessionId === "string")?.sessionId as string | undefined;
  if (!nativeId) return null;

  const messages: SessionMessage[] = [];
  const byApiId = new Map<string, SessionMessage>();
  const toolById = new Map<string, ToolCall>();
  let directory: string | null = null;
  let branch: string | null = null;
  let title: string | null = null;
  const costRuns = new Map<number, Json>();

  for (const l of lines) {
    directory ??= typeof l.cwd === "string" ? l.cwd : null;
    branch ??= typeof l.gitBranch === "string" && l.gitBranch ? l.gitBranch : null;
    if (l.type === "ai-title" && typeof l.aiTitle === "string") title = l.aiTitle;
    if (l.type === "cost-state" && typeof l.startTime === "number") costRuns.set(l.startTime, l);

    const at = Date.parse(l.timestamp ?? "") || 0;
    if (l.isSidechain) continue;

    if (l.type === "user" && l.message) {
      const content = l.message.content;
      if (Array.isArray(content)) {
        for (const b of content as Json[]) {
          if (b?.type !== "tool_result") continue;
          const call = toolById.get(b.tool_use_id);
          if (!call) continue;
          call.output = typeof b.content === "string" ? b.content : userText(b.content);
          call.status = b.is_error ? "error" : "completed";
        }
      }
      if (l.isMeta || l.origin?.kind === "system") continue;
      const text = userText(content);
      if (!text.trim()) continue;
      messages.push(blank("user", text, at));
    }

    if (l.type === "assistant" && l.message) {
      const m = l.message as Json;
      const key = String(m.id ?? l.uuid);
      let msg = byApiId.get(key);
      if (!msg) {
        msg = blank("assistant", "", at);
        msg.model = m.model ?? null;
        byApiId.set(key, msg);
        messages.push(msg);
      }
      const u = (m.usage ?? {}) as Json;
      msg.tokensIn = Math.max(msg.tokensIn, num(u.input_tokens));
      msg.tokensOut = Math.max(msg.tokensOut, num(u.output_tokens));
      msg.tokensReasoning = Math.max(msg.tokensReasoning, num(u.output_tokens_details?.thinking_tokens));
      msg.cacheRead = Math.max(msg.cacheRead, num(u.cache_read_input_tokens));
      msg.cacheWrite = Math.max(msg.cacheWrite, num(u.cache_creation_input_tokens));
      for (const b of (Array.isArray(m.content) ? m.content : []) as Json[]) {
        if (b.type === "text") msg.text += (msg.text ? "\n" : "") + String(b.text ?? "");
        else if (b.type === "thinking" && b.thinking) msg.reasoning = (msg.reasoning ?? "") + String(b.thinking);
        else if (b.type === "tool_use") {
          const call: ToolCall = { name: String(b.name), input: b.input, output: null, status: "unknown" };
          msg.toolCalls.push(call);
          toolById.set(String(b.id), call);
        }
      }
    }
  }
  if (!messages.length) return null;

  // cost-state is cumulative per process (`startTime`); resumed sessions start a new run, so sum each run's last reading
  const models = new Map<string, SessionModelUsage>();
  let costUsd = 0;
  for (const run of costRuns.values()) {
    costUsd += num(run.totalCostUSD);
    for (const [model, u] of Object.entries((run.modelUsage ?? {}) as Record<string, Json>)) {
      const cur = models.get(model) ?? { model, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
      cur.tokensIn += num(u.inputTokens);
      cur.tokensOut += num(u.outputTokens);
      cur.cacheRead += num(u.cacheReadInputTokens);
      cur.cacheWrite += num(u.cacheCreationInputTokens);
      cur.costUsd = (cur.costUsd ?? 0) + num(u.costUSD);
      models.set(model, cur);
    }
  }

  const stamps = messages.map((m) => m.at).filter(Boolean);
  messages.forEach((m, i) => (m.seq = i));
  return {
    session: {
      id: `claude-code:${machine}:${nativeId}`,
      nativeId,
      tool: "claude-code",
      machine,
      directory,
      branch,
      title: title ?? messages.find((m) => m.role === "user")?.text.trim().replace(/\s+/g, " ").slice(0, 80) ?? null,
      startedAt: Math.min(...stamps),
      endedAt: Math.max(...stamps),
      costUsd: costRuns.size ? costUsd : null,
      models: [...models.values()],
    },
    messages,
  };
}

function blank(role: SessionMessage["role"], text: string, at: number): SessionMessage {
  return {
    seq: 0,
    role,
    text,
    reasoning: null,
    toolCalls: [],
    model: null,
    provider: role === "assistant" ? "anthropic" : null,
    tokensIn: 0,
    tokensOut: 0,
    tokensReasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: null,
    latencyMs: null,
    at,
  };
}
