import { randomUUID } from "node:crypto";
import type { Conversation, ParsedSession, SessionMessage, SubagentRun, ToolCall, TouchedFile } from "./types";

const TOOL_OUTPUT_LIMIT = 2000;

function clip(s: string, n = TOOL_OUTPUT_LIMIT): string {
  return s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s;
}

function describeTool(c: ToolCall): string {
  const input = typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {});
  return `[tool ${c.name}] ${clip(input, 500)}${c.output ? `\n→ ${clip(c.output)}` : ""}`;
}

const EDIT_TOOLS = /^(edit|multiedit|write|notebookedit|patch|apply_patch)$/i;
const READ_TOOLS = /^read$/i;

/** Files a run read or changed, from the tool inputs of Claude Code and OpenCode file tools. */
export function touchedFiles(calls: Iterable<ToolCall>, into = new Map<string, TouchedFile>()): Map<string, TouchedFile> {
  for (const call of calls) {
    const edit = EDIT_TOOLS.test(call.name);
    if (!edit && !READ_TOOLS.test(call.name)) continue;
    const input = (call.input ?? {}) as Record<string, unknown>;
    const path = [input.file_path, input.filePath, input.notebook_path, input.path].find((v): v is string => typeof v === "string" && !!v);
    if (!path) continue;
    const entry = into.get(path) ?? { path, edits: 0, reads: 0 };
    if (edit) entry.edits += 1;
    else entry.reads += 1;
    into.set(path, entry);
  }
  return into;
}

/** A few lines saying what a subagent run did, so an export carries it without its whole transcript. */
export function subagentDigest(run: SubagentRun): string {
  const calls = run.messages.flatMap((m) => m.toolCalls);
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  const files = [...touchedFiles(calls).values()];
  const changed = files.filter((f) => f.edits).map((f) => f.path);
  const last = run.messages.findLast((m) => m.role === "assistant" && m.text.trim())?.text ?? "";
  return [
    `[subagent run "${run.title ?? run.id}": ${run.messages.length} messages${counts.size ? `; tools ${[...counts].map(([n, c]) => `${n}×${c}`).join(" ")}` : ""}]`,
    changed.length ? `files changed: ${changed.join(", ")}` : files.length ? `files read: ${files.map((f) => f.path).slice(0, 20).join(", ")}` : "",
    last ? `its last reply: ${clip(last)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Folds subagent runs into the conversation: each digest goes into the output of the tool call that spawned it, or,
 * when that call is unknown, onto the last message before the run started.
 */
export function foldSubagents(p: Conversation): ParsedSession {
  if (!p.subagents?.length) return p;
  const messages = p.messages.map((m) => ({ ...m, toolCalls: m.toolCalls.map((c) => ({ ...c })) }));
  for (const run of p.subagents) {
    const digest = subagentDigest(run);
    const call = run.parentSeq === null ? undefined : messages.find((m) => m.seq === run.parentSeq)?.toolCalls[run.callIndex ?? -1];
    if (call) {
      call.output = `${digest}\n${call.output ?? ""}`.trim();
      continue;
    }
    const host = messages.findLast((m) => m.at <= run.startedAt && m.role !== "system") ?? messages.at(-1);
    if (host) host.text = `${host.text}\n\n${digest}`.trim();
  }
  return { session: p.session, messages };
}

/** The message as plain text, with tool calls folded in, so any tool can replay it without matching tool schemas. */
export function flatten(m: SessionMessage): string {
  return [m.text, ...m.toolCalls.map(describeTool)].filter(Boolean).join("\n\n");
}

/** Claude Code JSONL. Drop it at `~/.claude/projects/<cwd with / as ->/<id>.jsonl`, then `claude --resume <id>`. */
export function toClaudeJsonl(conversation: Conversation, opts: { cwd?: string; version?: string } = {}): { id: string; jsonl: string } {
  const p = foldSubagents(conversation);
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
export function toOpenCodeJson(conversation: Conversation, opts: { projectID: string }): { id: string; json: string } {
  const p = foldSubagents(conversation);
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
export function toHandoffMarkdown(conversation: Conversation, maxChars = 60_000): string {
  const p = foldSubagents(conversation);
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
