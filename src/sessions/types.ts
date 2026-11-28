export type Tool = "claude-code" | "opencode";

export interface ToolCall {
  name: string;
  input: unknown;
  output: string | null;
  status: "completed" | "error" | "unknown";
}

export interface SessionMessage {
  seq: number;
  role: "user" | "assistant" | "system";
  text: string;
  reasoning: string | null;
  toolCalls: ToolCall[];
  model: string | null;
  provider: string | null;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** null when the source does not report a per-message price */
  costUsd: number | null;
  latencyMs: number | null;
  at: number;
}

export interface SessionModelUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}

export interface Session {
  /** `${tool}:${machine}:${nativeId}` */
  id: string;
  nativeId: string;
  tool: Tool;
  machine: string;
  directory: string | null;
  branch: string | null;
  title: string | null;
  startedAt: number;
  endedAt: number;
  costUsd: number | null;
  models: SessionModelUsage[];
  /** Set on a Claude Code subagent run: the id of the conversation that spawned it. */
  parentId?: string | null;
}

export interface ParsedSession {
  session: Session;
  messages: SessionMessage[];
}

/** A subagent run inside a conversation, placed at the tool call that spawned it (null when that call is unknown). */
export interface SubagentRun {
  id: string;
  title: string | null;
  parentSeq: number | null;
  callIndex: number | null;
  startedAt: number;
  endedAt: number;
  messages: SessionMessage[];
}

/** A conversation with its subagent runs, as `/api/session` returns it for `pull` and the exports. */
export interface Conversation extends ParsedSession {
  subagents?: SubagentRun[];
}

export interface TouchedFile {
  path: string;
  edits: number;
  reads: number;
}

export interface SubagentSummary {
  id: string;
  title: string | null;
  parentSeq: number | null;
  callIndex: number | null;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  tokens: number;
  costUsd: number | null;
  models: string[];
}

/** Whole-conversation numbers for the top of the detail page; subagent runs are included. */
export interface ConversationSummary {
  messageCount: number;
  tokens: number;
  costUsd: number;
  priced: boolean;
  models: { model: string; tokensIn: number; tokensOut: number; cache: number; costUsd: number }[];
  /** Tokens per own assistant reply, for the chart that jumps to a reply. */
  replies: { seq: number; tokens: number }[];
  tools: { name: string; count: number }[];
  files: TouchedFile[];
  subagents: SubagentSummary[];
}

/** One page of `/api/session?id=…&offset=…&limit=…`; `summary` comes with the first page only. */
export interface SessionPage {
  session: Session;
  parent: { id: string; title: string | null } | null;
  offset: number;
  total: number;
  messages: SessionMessage[];
  costs: (number | null)[];
  summary?: ConversationSummary;
}
