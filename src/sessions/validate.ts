import type { ParsedSession } from "./types";

const TOOLS = new Set(["claude-code", "opencode"]);

/** Shape check for what machines post; the store trusts it after this. */
export function isParsedSession(value: unknown): value is ParsedSession {
  const v = value as Partial<ParsedSession> | null;
  const s = v?.session;
  return (
    !!s &&
    typeof s.id === "string" &&
    s.id.length < 200 &&
    TOOLS.has(s.tool) &&
    typeof s.machine === "string" &&
    typeof s.nativeId === "string" &&
    Number.isFinite(s.startedAt) &&
    Number.isFinite(s.endedAt) &&
    Array.isArray(s.models) &&
    (s.parentId === undefined || s.parentId === null || (typeof s.parentId === "string" && s.parentId.length < 200)) &&
    Array.isArray(v.messages) &&
    v.messages.every(
      (m) => ["user", "assistant", "system"].includes(m?.role) && typeof m.text === "string" && Number.isFinite(m.seq) && Array.isArray(m.toolCalls),
    )
  );
}
