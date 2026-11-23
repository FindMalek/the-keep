import { randomUUID } from "node:crypto";
import type { ParsedSession, SessionMessage, ToolCall } from "./types";

const TOOL_OUTPUT_LIMIT = 2000;

function clip(s: string, n = TOOL_OUTPUT_LIMIT): string {
  return s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s;
}

function describeTool(c: ToolCall): string {
  const input = typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {});
  return `[tool ${c.name}] ${clip(input, 500)}${c.output ? `\n→ ${clip(c.output)}` : ""}`;
}

/** The message as plain text, with tool calls folded in, so any tool can replay it without matching tool schemas. */
export function flatten(m: SessionMessage): string {
  return [m.text, ...m.toolCalls.map(describeTool)].filter(Boolean).join("\n\n");
}

/** Claude Code JSONL. Drop it at `~/.claude/projects/<cwd with / as ->/<id>.jsonl`, then `claude --resume <id>`. */
export function toClaudeJsonl(p: ParsedSession, opts: { cwd?: string; version?: string } = {}): { id: string; jsonl: string } {
  const id = randomUUID();
  const cwd = opts.cwd ?? p.session.directory ?? process.cwd();
  const version = opts.version ?? "2.1.319";
  const lines: unknown[] = [];
  let parent: string | null = null;
  for (const m of p.messages) {
    const text = flatten(m);
    if (!text.trim() || m.role === "system") continue;
    const uuid = randomUUID();
    const timestamp = new Date(m.at || Date.now()).toISOString();
    const common = { parentUuid: parent, isSidechain: false, uuid, timestamp, userType: "external", entrypoint: "cli", cwd, sessionId: id, version };
    if (m.role === "user") {
      lines.push({ ...common, type: "user", message: { role: "user", content: text } });
    } else {
      lines.push({
        ...common,
        type: "assistant",
        message: {
          id: `msg_${uuid.replaceAll("-", "")}`,
          type: "message",
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    parent = uuid;
  }
  return { id, jsonl: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" };
}

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** OpenCode ids sort by time: `<prefix>_` + 12 hex of (ms * 4096 + counter) + 14 random base62. Importing rejects anything else. */
function ascendingId(prefix: "ses" | "msg", ms: number, counter: number): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => BASE62[b % 62]).join("");
  return `${prefix}_${(BigInt(ms) * 0x1000n + BigInt(counter)).toString(16).padStart(12, "0").slice(-12)}${rand}`;
}

/**
 * OpenCode session JSON, the same shape `opencode session export` writes. Import with `opencode session import <file>`.
 * `projectID` must be an OpenCode project that already exists on the importing machine (see `opencodeProjectId`).
 */
export function toOpenCodeJson(p: ParsedSession, opts: { projectID: string }): { id: string; json: string } {
  const now = Date.now();
  const id = ascendingId("ses", now, 0);
  const model = { id: p.session.models[0]?.model ?? "imported", providerID: "imported", variant: "default" };
  const messages = p.messages
    .filter((m) => m.role !== "system" && flatten(m).trim())
    .map((m, i) => {
      const msgId = ascendingId("msg", now, i + 1);
      const at = m.at || now;
      return m.role === "user"
        ? { id: msgId, time: { created: at }, text: flatten(m), files: [], type: "user" }
        : {
            id: msgId,
            type: "assistant",
            time: { created: at, streamed: at, completed: at },
            agent: "build",
            model,
            content: [{ type: "text", text: flatten(m) }],
            finish: "stop",
            cost: 0,
            tokens: ZERO_TOKENS,
          };
    });
  const info = {
    id,
    projectID: opts.projectID,
    model,
    cost: 0,
    tokens: ZERO_TOKENS,
    time: { created: p.session.startedAt, updated: p.session.endedAt },
    title: p.session.title ?? "Imported session",
    location: { directory: p.session.directory ?? "/" },
  };
  return { id, json: JSON.stringify({ info, messages }, null, 2) };
}

/** Tool-agnostic fallback: paste into any assistant. */
export function toHandoffMarkdown(p: ParsedSession, maxChars = 60_000): string {
  const head = `# Session handoff: ${p.session.title ?? p.session.nativeId}\n\nFrom ${p.session.tool} on ${p.session.machine}${p.session.directory ? ` in \`${p.session.directory}\`` : ""}. Continue from where this left off.\n`;
  const turns = p.messages.filter((m) => m.role !== "system").map((m) => `## ${m.role === "user" ? "User" : "Assistant"}\n\n${flatten(m)}`);
  let out = "";
  for (let i = turns.length - 1; i >= 0; i--) {
    if (out && out.length + turns[i]!.length > maxChars) {
      out = `_(earlier turns omitted)_\n\n${out}`;
      break;
    }
    out = `${turns[i]}\n\n${out}`;
  }
  return `${head}\n${out}`;
}
