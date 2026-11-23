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
}

export interface ParsedSession {
  session: Session;
  messages: SessionMessage[];
}
