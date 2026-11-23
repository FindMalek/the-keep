import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { ParsedSession, Session, SessionMessage } from "./types";

export interface SessionRow extends Session {
  messageCount: number;
  tokensIn: number;
  tokensOut: number;
}

export interface UsageRow {
  day: string;
  tool: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/** Sessions live in their own SQLite file next to the dashboard's history DB. */
export class SessionStore {
  private readonly db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(`${dataDir}/sessions.db`, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, tool TEXT NOT NULL, machine TEXT NOT NULL, native_id TEXT NOT NULL,
      directory TEXT, branch TEXT, title TEXT, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
      cost_usd REAL, models TEXT NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS messages (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
      role TEXT NOT NULL, text TEXT NOT NULL, reasoning TEXT, tool_calls TEXT NOT NULL,
      model TEXT, provider TEXT, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL,
      tokens_reasoning INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
      cost_usd REAL, latency_ms INTEGER, at INTEGER NOT NULL, PRIMARY KEY (session_id, seq)) WITHOUT ROWID`);
    this.db.run("CREATE INDEX IF NOT EXISTS messages_at ON messages (at)");
    this.db.run("CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started_at DESC)");
    this.db.run("PRAGMA foreign_keys = ON");
  }

  /** Idempotent: a session that was already stored is replaced, so a growing live session just updates. */
  upsert({ session: s, messages }: ParsedSession): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM sessions WHERE id = ?", [s.id]);
      this.db.run("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
        s.id, s.tool, s.machine, s.nativeId, s.directory ?? null, s.branch ?? null, s.title ?? null, s.startedAt, s.endedAt, s.costUsd ?? null, JSON.stringify(s.models),
      ]);
      const ins = this.db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      for (const m of messages) {
        ins.run(s.id, m.seq, m.role, m.text, m.reasoning ?? null, JSON.stringify(m.toolCalls), m.model ?? null, m.provider ?? null, m.tokensIn ?? 0, m.tokensOut ?? 0, m.tokensReasoning ?? 0, m.cacheRead ?? 0, m.cacheWrite ?? 0, m.costUsd ?? null, m.latencyMs ?? null, m.at ?? 0);
      }
    })();
  }

  endedAt(id: string): number | null {
    return (this.db.query("SELECT ended_at FROM sessions WHERE id = ?").get(id) as { ended_at: number } | null)?.ended_at ?? null;
  }

  list(limit = 50, offset = 0): SessionRow[] {
    const rows = this.db
      .query(`SELECT s.*, COUNT(m.seq) AS n, COALESCE(SUM(m.tokens_in),0) AS tin, COALESCE(SUM(m.tokens_out),0) AS tout
              FROM sessions s LEFT JOIN messages m ON m.session_id = s.id GROUP BY s.id ORDER BY s.started_at DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as any[];
    return rows.map((r) => ({ ...rowToSession(r), messageCount: r.n, tokensIn: r.tin, tokensOut: r.tout }));
  }

  get(id: string): ParsedSession | null {
    const s = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    if (!s) return null;
    const messages = (this.db.query("SELECT * FROM messages WHERE session_id = ? ORDER BY seq").all(id) as any[]).map(
      (r): SessionMessage => ({
        seq: r.seq, role: r.role, text: r.text, reasoning: r.reasoning, toolCalls: JSON.parse(r.tool_calls), model: r.model, provider: r.provider,
        tokensIn: r.tokens_in, tokensOut: r.tokens_out, tokensReasoning: r.tokens_reasoning, cacheRead: r.cache_read, cacheWrite: r.cache_write,
        costUsd: r.cost_usd, latencyMs: r.latency_ms, at: r.at,
      }),
    );
    return { session: rowToSession(s), messages };
  }

  /** Tokens and cost per day, tool and model. Per-message cost where the tool reports it, else the session's per-model cost. */
  usageByDay(sinceMs: number): UsageRow[] {
    return this.db
      .query(`SELECT strftime('%Y-%m-%d', at/1000, 'unixepoch') AS day, s.tool AS tool, COALESCE(m.model,'?') AS model,
                SUM(m.tokens_in) AS tokensIn, SUM(m.tokens_out) AS tokensOut, COALESCE(SUM(m.cost_usd),0) AS costUsd
              FROM messages m JOIN sessions s ON s.id = m.session_id
              WHERE m.role = 'assistant' AND m.at >= ? GROUP BY day, tool, model ORDER BY day`)
      .all(sinceMs) as UsageRow[];
  }

  close(): void {
    this.db.close();
  }
}

function rowToSession(r: any): Session {
  return {
    id: r.id, nativeId: r.native_id, tool: r.tool, machine: r.machine, directory: r.directory, branch: r.branch, title: r.title,
    startedAt: r.started_at, endedAt: r.ended_at, costUsd: r.cost_usd, models: JSON.parse(r.models),
  };
}
