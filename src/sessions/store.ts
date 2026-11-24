import { Database } from "bun:sqlite";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
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
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = `${dataDir}/sessions.db`;
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    for (const suffix of ["-wal", "-shm"]) {
      try { chmodSync(`${path}${suffix}`, 0o600); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, tool TEXT NOT NULL, machine TEXT NOT NULL, native_id TEXT NOT NULL,
      directory TEXT, branch TEXT, title TEXT, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
      cost_usd REAL, models TEXT NOT NULL)`);
    const columns = this.db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
    this.db.run("CREATE TABLE IF NOT EXISTS session_repositories (session_id TEXT PRIMARY KEY, repository TEXT)");
    this.db.run("CREATE INDEX IF NOT EXISTS session_repositories_name ON session_repositories (repository)");
    if (columns.some((column) => column.name === "repository")) {
      this.db.run("INSERT OR IGNORE INTO session_repositories (session_id,repository) SELECT id,repository FROM sessions");
    }
    this.db.run("CREATE TABLE IF NOT EXISTS source_files (path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL)");
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
      this.db.run("INSERT INTO sessions (id,tool,machine,native_id,directory,branch,title,started_at,ended_at,cost_usd,models) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
        s.id, s.tool, s.machine, s.nativeId, s.directory ?? null, s.branch ?? null, s.title ?? null, s.startedAt, s.endedAt, s.costUsd ?? null, JSON.stringify(s.models),
      ]);
      this.db.run("INSERT OR REPLACE INTO session_repositories (session_id,repository) VALUES (?,?)", [s.id, s.repository ?? null]);
      const ins = this.db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      for (const m of messages) {
        ins.run(s.id, m.seq, m.role, m.text, m.reasoning ?? null, JSON.stringify(m.toolCalls), m.model ?? null, m.provider ?? null, m.tokensIn ?? 0, m.tokensOut ?? 0, m.tokensReasoning ?? 0, m.cacheRead ?? 0, m.cacheWrite ?? 0, m.costUsd ?? null, m.latencyMs ?? null, m.at ?? 0);
      }
    })();
  }

  endedAt(id: string): number | null {
    return (this.db.query("SELECT ended_at FROM sessions WHERE id = ?").get(id) as { ended_at: number } | null)?.ended_at ?? null;
  }

  sourceUnchanged(path: string, mtime: number, size: number): boolean {
    const row = this.db.query("SELECT mtime, size FROM source_files WHERE path = ?").get(path) as { mtime: number; size: number } | null;
    return row?.mtime === mtime && row.size === size;
  }

  markSource(path: string, mtime: number, size: number): void {
    this.db.run("INSERT OR REPLACE INTO source_files (path,mtime,size) VALUES (?,?,?)", [path, mtime, size]);
  }

  list(limit = 50, offset = 0, repository: string | null = null): SessionRow[] {
    const rows = this.db
      .query(`SELECT s.*, r.repository AS repo_label, COUNT(m.seq) AS n, COALESCE(SUM(m.tokens_in),0) AS tin, COALESCE(SUM(m.tokens_out),0) AS tout
              FROM sessions s LEFT JOIN messages m ON m.session_id = s.id LEFT JOIN session_repositories r ON r.session_id = s.id
              WHERE (? IS NULL OR (? = '' AND r.repository IS NULL) OR r.repository = ?)
              GROUP BY s.id ORDER BY s.started_at DESC, s.id DESC LIMIT ? OFFSET ?`)
      .all(repository, repository, repository, limit, offset) as any[];
    return rows.map((r) => ({ ...rowToSession(r), messageCount: r.n, tokensIn: r.tin, tokensOut: r.tout }));
  }

  count(repository: string | null = null): number {
    const row = this.db.query("SELECT COUNT(*) AS n FROM sessions s LEFT JOIN session_repositories r ON r.session_id = s.id WHERE (? IS NULL OR (? = '' AND r.repository IS NULL) OR r.repository = ?)")
      .get(repository, repository, repository) as { n: number };
    return row.n;
  }

  repositories(): string[] {
    return (this.db.query("SELECT DISTINCT r.repository FROM session_repositories r JOIN sessions s ON s.id = r.session_id WHERE r.repository IS NOT NULL AND r.repository <> '' ORDER BY r.repository COLLATE NOCASE").all() as { repository: string }[]).map((row) => row.repository);
  }

  get(id: string): ParsedSession | null {
    const s = this.db.query("SELECT s.*, r.repository AS repo_label FROM sessions s LEFT JOIN session_repositories r ON r.session_id = s.id WHERE s.id = ?").get(id) as any;
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
    id: r.id, nativeId: r.native_id, tool: r.tool, machine: r.machine, directory: r.directory, repository: r.repo_label ?? null, branch: r.branch, title: r.title,
    startedAt: r.started_at, endedAt: r.ended_at, costUsd: r.cost_usd, models: JSON.parse(r.models),
  };
}
