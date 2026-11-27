import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { SessionFacets, SessionListRow, UsageDay } from "../shared/types";
import { projectOf } from "../shared/project";
import { PriceBook } from "./prices";
import type { ParsedSession, Session, SessionMessage } from "./types";

export interface SessionFilter {
  limit?: number;
  offset?: number;
  tool?: string | null;
  machine?: string | null;
  /** Last path segment of the working directory. */
  project?: string | null;
  model?: string | null;
  q?: string | null;
  /** Unix ms, on `started_at`. */
  from?: number | null;
  to?: number | null;
}

interface TokenRow {
  session_id: string;
  tool: string;
  model: string | null;
  provider: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_reasoning: number;
  cache_read: number;
  cache_write: number;
  at: number;
}

/** Sessions live in their own SQLite file next to the dashboard's history DB. */
export class SessionStore {
  private readonly db: Database;
  readonly prices: PriceBook;

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
    this.prices = new PriceBook(this.db, `${dataDir}/prices.json`);
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

  /** Every session id with its last activity, without the cost work `list` does. */
  index(): { id: string; endedAt: number }[] {
    return this.db.query("SELECT id, ended_at AS endedAt FROM sessions ORDER BY started_at DESC").all() as { id: string; endedAt: number }[];
  }

  endedAt(id: string): number | null {
    return (this.db.query("SELECT ended_at FROM sessions WHERE id = ?").get(id) as { ended_at: number } | null)?.ended_at ?? null;
  }

  private where(filter: SessionFilter): { sql: string; args: (string | number)[] } {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (filter.tool) clauses.push("s.tool = ?") && args.push(filter.tool);
    if (filter.machine) clauses.push("s.machine = ?") && args.push(filter.machine);
    // Same rule as projectOf: the repo itself, its .claude/worktrees, or a `repo-TICKET-123` sibling checkout.
    if (filter.project)
      clauses.push("(s.directory LIKE ? OR s.directory LIKE ? OR s.directory LIKE ? OR s.directory LIKE ?)") &&
        args.push(`%/${filter.project}`, `%/${filter.project}/.claude/worktrees/%`, `%/${filter.project}/worktrees/%`, `%/${filter.project}-%-%`);
    if (filter.model) clauses.push("EXISTS (SELECT 1 FROM messages x WHERE x.session_id = s.id AND x.model = ?)") && args.push(filter.model);
    if (filter.q) clauses.push("(s.title LIKE ? OR s.directory LIKE ? OR s.branch LIKE ?)") && args.push(...Array(3).fill(`%${filter.q}%`));
    if (filter.from) clauses.push("s.started_at >= ?") && args.push(filter.from);
    if (filter.to) clauses.push("s.started_at < ?") && args.push(filter.to);
    return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", args };
  }

  /** Newest first, with token totals including cache and a cost computed from stored prices. */
  list(filter: SessionFilter = {}): SessionListRow[] {
    const { sql, args } = this.where(filter);
    const rows = this.db
      .query(`SELECT s.*, COUNT(m.seq) AS n, COALESCE(SUM(m.tokens_in),0) AS tin, COALESCE(SUM(m.tokens_out),0) AS tout,
                COALESCE(SUM(m.cache_read),0) AS cr, COALESCE(SUM(m.cache_write),0) AS cw
              FROM sessions s LEFT JOIN messages m ON m.session_id = s.id ${sql}
              GROUP BY s.id ORDER BY s.started_at DESC LIMIT ? OFFSET ?`)
      .all(...args, filter.limit ?? 50, filter.offset ?? 0) as any[];
    const costs = this.costs(rows.map((r) => r.id));
    return rows.map((r) => {
      const cost = costs.get(r.id);
      return {
        id: r.id, tool: r.tool, machine: r.machine, directory: r.directory, branch: r.branch, title: r.title,
        startedAt: r.started_at, endedAt: r.ended_at, messageCount: r.n,
        tokensIn: r.tin, tokensOut: r.tout, cacheRead: r.cr, cacheWrite: r.cw,
        costUsd: cost?.priced ? cost.usd : null, reportedUsd: r.cost_usd, unpriced: cost?.unpriced ?? 0, models: [...(cost?.models ?? [])],
      };
    });
  }

  count(filter: SessionFilter = {}): number {
    const { sql, args } = this.where(filter);
    return (this.db.query(`SELECT COUNT(*) AS n FROM sessions s ${sql}`).get(...args) as { n: number }).n;
  }

  private tokenRows(where: string, args: (string | number)[]): TokenRow[] {
    return this.db
      .query(`SELECT m.session_id, s.tool, m.model, m.provider, m.tokens_in, m.tokens_out, m.tokens_reasoning, m.cache_read, m.cache_write, m.at
              FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.role = 'assistant' AND ${where}`)
      .all(...args) as TokenRow[];
  }

  private costOf(row: TokenRow): number | null {
    return this.prices.cost(
      { provider: row.provider, model: row.model, at: row.at, tokensIn: row.tokens_in, tokensOut: row.tokens_out, tokensReasoning: row.tokens_reasoning, cacheRead: row.cache_read, cacheWrite: row.cache_write },
      row.tool,
    );
  }

  private costs(ids: string[]): Map<string, { usd: number; priced: boolean; unpriced: number; models: Set<string> }> {
    const result = new Map<string, { usd: number; priced: boolean; unpriced: number; models: Set<string> }>();
    if (!ids.length) return result;
    for (const row of this.tokenRows(`m.session_id IN (${ids.map(() => "?").join(",")})`, ids)) {
      const entry = result.get(row.session_id) ?? { usd: 0, priced: false, unpriced: 0, models: new Set<string>() };
      if (row.model && row.model !== "<synthetic>") entry.models.add(row.model);
      const cost = this.costOf(row);
      if (cost === null) entry.unpriced += row.tokens_in + row.tokens_out > 0 ? 1 : 0;
      else (entry.usd += cost), (entry.priced = true);
      result.set(row.session_id, entry);
    }
    return result;
  }

  /** Distinct values for the list's filter menus. */
  facets(): SessionFacets {
    const column = (sql: string) => (this.db.query(sql).all() as { v: string | null }[]).map((r) => r.v).filter((v): v is string => !!v);
    const projects = new Set(column("SELECT DISTINCT directory AS v FROM sessions").map(projectOf));
    return {
      tools: column("SELECT DISTINCT tool AS v FROM sessions ORDER BY v"),
      machines: column("SELECT DISTINCT machine AS v FROM sessions ORDER BY v"),
      projects: [...projects].sort(),
      models: column("SELECT DISTINCT model AS v FROM messages WHERE role = 'assistant' AND model IS NOT NULL AND model != '<synthetic>' ORDER BY v"),
    };
  }

  providers(): string[] {
    return (this.db.query("SELECT DISTINCT provider AS v FROM messages WHERE provider IS NOT NULL").all() as { v: string }[]).map((r) => r.v);
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

  /** Tokens (cache included) and computed cost per day, tool and model. `tzMinutes` shifts days to the viewer's clock. */
  usageByDay(sinceMs: number, tzMinutes = 0): UsageDay[] {
    const days = new Map<string, UsageDay & { ids: Set<string> }>();
    for (const row of this.tokenRows("m.at >= ?", [sinceMs])) {
      const model = row.model ?? "?";
      if (model === "<synthetic>") continue;
      const day = new Date(row.at - tzMinutes * 60_000).toISOString().slice(0, 10);
      const name = `${day} ${row.tool} ${model}`;
      const entry = days.get(name) ?? { day, tool: row.tool, model, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: 0, sessions: 0, ids: new Set<string>() };
      entry.tokensIn += row.tokens_in;
      entry.tokensOut += row.tokens_out;
      entry.cacheRead += row.cache_read;
      entry.cacheWrite += row.cache_write;
      const cost = this.costOf(row);
      if (cost === null) entry.unpriced += 1;
      else entry.costUsd += cost;
      entry.ids.add(row.session_id);
      days.set(name, entry);
    }
    return [...days.values()]
      .map(({ ids, ...entry }) => ({ ...entry, sessions: ids.size }))
      .sort((a, b) => a.day.localeCompare(b.day));
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
