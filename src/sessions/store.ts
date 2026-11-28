import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { SessionFacets, SessionListRow, UsageDay } from "../shared/types";
import { projectOf } from "../shared/project";
import { touchedFiles } from "./export";
import { PriceBook } from "./prices";
import type { Conversation, ConversationSummary, ParsedSession, Session, SessionMessage, SessionPage, SubagentRun, TouchedFile } from "./types";

/** Claude Code's Agent/Task tool result names the run it started. */
const AGENT_ID = /agentId: ([0-9a-f]{6,})/;
const SPAWN_TOOLS = new Set(["Agent", "Task"]);
/** A spawning call is at most this long before its run's first message, and never after it by more than clock skew. */
const SPAWN_BEFORE = 15 * 60_000;
const SPAWN_AFTER = 60_000;

interface LinkRow {
  child_id: string;
  parent_id: string;
  parent_seq: number | null;
  call_index: number | null;
}

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
  /** First-page summaries by session id; reading every tool call of a long conversation is the slow part of a page. */
  private readonly summaries = new Map<string, ConversationSummary>();

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
    // No foreign key: a parent is deleted and re-inserted on every upsert, and its runs must stay attached.
    this.db.run("CREATE TABLE IF NOT EXISTS links (child_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, parent_seq INTEGER, call_index INTEGER)");
    this.db.run("CREATE INDEX IF NOT EXISTS links_parent ON links (parent_id)");
    this.db.run("PRAGMA foreign_keys = ON");
    this.prices = new PriceBook(this.db, `${dataDir}/prices.json`);
    // Sessions stored before links existed get linked once.
    if ((this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version < 1) {
      this.db.transaction(() => {
        for (const id of this.db.query("SELECT id FROM sessions WHERE native_id LIKE 'agent:%'").all() as { id: string }[]) {
          const row = this.get(id.id);
          if (row) this.linkChild(row);
        }
      })();
      this.db.run("PRAGMA user_version = 1");
    }
  }

  private link(child: string, parent: string, seq: number | null, call: number | null): void {
    this.db.run("INSERT OR REPLACE INTO links VALUES (?,?,?,?)", [child, parent, seq, call]);
  }

  /** A conversation (or a run, since runs spawn runs) names its runs in the Agent call's result; older runs are matched by their prompt. */
  private linkParent({ session: s, messages }: ParsedSession): void {
    if (s.tool !== "claude-code") return;
    const byPrompt = this.db.query(
      `SELECT s.id FROM sessions s JOIN messages m ON m.session_id = s.id AND m.seq = 0
       WHERE s.machine = ? AND s.native_id LIKE 'agent:%' AND s.id != ? AND m.text = ? AND s.started_at BETWEEN ? AND ?`,
    );
    for (const m of messages) {
      m.toolCalls.forEach((call, index) => {
        const agent = AGENT_ID.exec(call.output ?? "")?.[1];
        if (agent) return this.link(`claude-code:${s.machine}:agent:${agent}`, s.id, m.seq, index);
        const prompt = (call.input as { prompt?: unknown } | null)?.prompt;
        if (!SPAWN_TOOLS.has(call.name) || typeof prompt !== "string") return;
        const child = byPrompt.get(s.machine, s.id, prompt, m.at - SPAWN_AFTER, m.at + SPAWN_BEFORE) as { id: string } | null;
        if (child) this.link(child.id, s.id, m.seq, index);
      });
    }
  }

  private linkChild({ session: s, messages }: ParsedSession): void {
    if (s.tool !== "claude-code" || !s.nativeId.startsWith("agent:")) return;
    const known = this.db.query("SELECT * FROM links WHERE child_id = ?").get(s.id) as LinkRow | null;
    if (known?.parent_seq !== null && known?.parent_seq !== undefined) return;
    const agent = s.nativeId.slice("agent:".length);
    const prompt = messages[0]?.role === "user" ? messages[0].text : null;
    // instr, not LIKE: prompts are full of % and _.
    const needles = [`agentId: ${agent}`, ...(prompt ? [JSON.stringify(prompt).slice(1, -1)] : [])];
    for (const needle of needles) {
      const rows = this.db
        .query(
          `SELECT m.session_id, m.seq, m.tool_calls FROM messages m JOIN sessions p ON p.id = m.session_id
           WHERE p.machine = ? AND p.id != ? AND m.role = 'assistant' AND m.at BETWEEN ? AND ? AND instr(m.tool_calls, ?) > 0`,
        )
        .all(s.machine, s.id, s.startedAt - SPAWN_BEFORE, s.startedAt + SPAWN_AFTER, needle) as { session_id: string; seq: number; tool_calls: string }[];
      for (const row of rows) {
        const calls = JSON.parse(row.tool_calls) as SessionMessage["toolCalls"];
        const index = calls.findIndex((call) =>
          needle.startsWith("agentId: ") ? AGENT_ID.exec(call.output ?? "")?.[1] === agent : (call.input as { prompt?: unknown } | null)?.prompt === prompt,
        );
        if (index >= 0) return this.link(s.id, row.session_id, row.seq, index);
      }
    }
    if (s.parentId && !known) this.link(s.id, s.parentId, null, null);
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
      this.linkParent({ session: s, messages });
      this.linkChild({ session: s, messages });
    })();
    this.summaries.delete(s.id);
    const parent = this.parentOf(s.id);
    if (parent) this.summaries.delete(parent.parent_id);
  }

  /** Every session id with its last activity, without the cost work `list` does. */
  index(): { id: string; endedAt: number }[] {
    return this.db.query("SELECT id, ended_at AS endedAt FROM sessions ORDER BY started_at DESC").all() as { id: string; endedAt: number }[];
  }

  endedAt(id: string): number | null {
    return (this.db.query("SELECT ended_at FROM sessions WHERE id = ?").get(id) as { ended_at: number } | null)?.ended_at ?? null;
  }

  private where(filter: SessionFilter): { sql: string; args: (string | number)[] } {
    // A run linked to a stored conversation is shown inside it, not as its own row.
    const clauses: string[] = ["s.id NOT IN (SELECT l.child_id FROM links l JOIN sessions p ON p.id = l.parent_id)"];
    const args: (string | number)[] = [];
    if (filter.tool) clauses.push("s.tool = ?") && args.push(filter.tool);
    if (filter.machine) clauses.push("s.machine = ?") && args.push(filter.machine);
    // Same rule as projectOf: the repo itself, its .claude/worktrees, or a `repo-TICKET-123` sibling checkout.
    if (filter.project)
      clauses.push("(s.directory LIKE ? OR s.directory LIKE ? OR s.directory LIKE ? OR s.directory LIKE ?)") &&
        args.push(`%/${filter.project}`, `%/${filter.project}/.claude/worktrees/%`, `%/${filter.project}/worktrees/%`, `%/${filter.project}-%-%`);
    if (filter.model)
      clauses.push("EXISTS (SELECT 1 FROM messages x WHERE (x.session_id = s.id OR x.session_id IN (SELECT child_id FROM links WHERE parent_id = s.id)) AND x.model = ?)") &&
        args.push(filter.model);
    if (filter.q) clauses.push("(s.title LIKE ? OR s.directory LIKE ? OR s.branch LIKE ?)") && args.push(...Array(3).fill(`%${filter.q}%`));
    if (filter.from) clauses.push("s.started_at >= ?") && args.push(filter.from);
    if (filter.to) clauses.push("s.started_at < ?") && args.push(filter.to);
    return { sql: `WHERE ${clauses.join(" AND ")}`, args };
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
    const ids = rows.map((r) => r.id);
    const children = ids.length
      ? (this.db
          .query(`SELECT l.parent_id, l.child_id, COALESCE(SUM(m.tokens_in),0) AS tin, COALESCE(SUM(m.tokens_out),0) AS tout,
                    COALESCE(SUM(m.cache_read),0) AS cr, COALESCE(SUM(m.cache_write),0) AS cw
                  FROM links l LEFT JOIN messages m ON m.session_id = l.child_id
                  WHERE l.parent_id IN (${ids.map(() => "?").join(",")}) GROUP BY l.child_id`)
          .all(...ids) as { parent_id: string; child_id: string; tin: number; tout: number; cr: number; cw: number }[])
      : [];
    const costs = this.costs([...ids, ...children.map((c) => c.child_id)]);
    return rows.map((r) => {
      const runs = children.filter((c) => c.parent_id === r.id);
      const parts = [r.id, ...runs.map((c) => c.child_id)].map((id) => costs.get(id)).filter((c) => !!c);
      const sum = (key: "tin" | "tout" | "cr" | "cw") => r[key] + runs.reduce((total, c) => total + c[key], 0);
      return {
        id: r.id, tool: r.tool, machine: r.machine, directory: r.directory, branch: r.branch, title: r.title,
        startedAt: r.started_at, endedAt: r.ended_at, messageCount: r.n,
        tokensIn: sum("tin"), tokensOut: sum("tout"), cacheRead: sum("cr"), cacheWrite: sum("cw"),
        costUsd: parts.some((c) => c.priced) ? parts.reduce((total, c) => total + c.usd, 0) : null,
        reportedUsd: r.cost_usd,
        unpriced: parts.reduce((total, c) => total + c.unpriced, 0),
        models: [...new Set(parts.flatMap((c) => [...c.models]))],
        subagents: runs.length,
        agentRun: r.native_id.startsWith("agent:"),
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

  private parentOf(id: string): LinkRow | null {
    return this.db.query("SELECT l.* FROM links l JOIN sessions p ON p.id = l.parent_id WHERE l.child_id = ?").get(id) as LinkRow | null;
  }

  private messages(id: string, offset = 0, limit = -1): SessionMessage[] {
    return (this.db.query("SELECT * FROM messages WHERE session_id = ? ORDER BY seq LIMIT ? OFFSET ?").all(id, limit, offset) as any[]).map(
      (r): SessionMessage => ({
        seq: r.seq, role: r.role, text: r.text, reasoning: r.reasoning, toolCalls: JSON.parse(r.tool_calls), model: r.model, provider: r.provider,
        tokensIn: r.tokens_in, tokensOut: r.tokens_out, tokensReasoning: r.tokens_reasoning, cacheRead: r.cache_read, cacheWrite: r.cache_write,
        costUsd: r.cost_usd, latencyMs: r.latency_ms, at: r.at,
      }),
    );
  }

  private session(id: string): Session | null {
    const s = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    if (!s) return null;
    const session = rowToSession(s);
    const parent = this.parentOf(id);
    if (parent) session.parentId = parent.parent_id;
    return session;
  }

  get(id: string): ParsedSession | null {
    const session = this.session(id);
    return session ? { session, messages: this.messages(id) } : null;
  }

  private runs(id: string): LinkRow[] {
    return this.db
      .query("SELECT l.* FROM links l JOIN sessions c ON c.id = l.child_id WHERE l.parent_id = ? ORDER BY c.started_at")
      .all(id) as LinkRow[];
  }

  /** The conversation with every subagent run's messages, for `pull` and the exports. */
  conversation(id: string): Conversation | null {
    const parsed = this.get(id);
    if (!parsed) return null;
    const subagents: SubagentRun[] = [];
    for (const link of this.runs(id)) {
      const child = this.get(link.child_id);
      if (!child) continue;
      subagents.push({
        id: child.session.id, title: child.session.title, parentSeq: link.parent_seq, callIndex: link.call_index,
        startedAt: child.session.startedAt, endedAt: child.session.endedAt, messages: child.messages,
      });
    }
    return { ...parsed, subagents };
  }

  private messageCost(m: SessionMessage, tool: string): number | null {
    return m.role === "assistant" ? this.prices.cost(m, tool) : null;
  }

  /** One page of messages; the first page also carries the whole conversation's summary. */
  page(id: string, offset: number, limit: number): SessionPage | null {
    const session = this.session(id);
    if (!session) return null;
    const parentTitle = session.parentId
      ? ((this.db.query("SELECT title FROM sessions WHERE id = ?").get(session.parentId) as { title: string | null } | null)?.title ?? null)
      : null;
    const messages = this.messages(id, offset, limit);
    const total = (this.db.query("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(id) as { n: number }).n;
    return {
      session,
      parent: session.parentId ? { id: session.parentId, title: parentTitle } : null,
      offset,
      total,
      messages,
      costs: messages.map((m) => this.messageCost(m, session.tool)),
      ...(offset === 0 ? { summary: this.summary(session) } : {}),
    };
  }

  private summary(session: Session): ConversationSummary {
    const cached = this.summaries.get(session.id);
    if (cached) return cached;
    const models = new Map<string, ConversationSummary["models"][number]>();
    const tools = new Map<string, number>();
    const files = new Map<string, TouchedFile>();
    let tokens = 0;
    let costUsd = 0;
    let priced = false;
    const tally = (messages: SessionMessage[], tool: string) => {
      let runTokens = 0;
      let runCost = 0;
      let runPriced = false;
      for (const m of messages) {
        const t = m.tokensIn + m.tokensOut + m.cacheRead + m.cacheWrite;
        runTokens += t;
        for (const call of m.toolCalls) tools.set(call.name, (tools.get(call.name) ?? 0) + 1);
        touchedFiles(m.toolCalls, files);
        if (m.role !== "assistant" || !m.model || m.model === "<synthetic>") continue;
        const cost = this.messageCost(m, tool);
        if (cost !== null) (runCost += cost), (runPriced = true);
        const entry = models.get(m.model) ?? { model: m.model, tokensIn: 0, tokensOut: 0, cache: 0, costUsd: 0 };
        entry.tokensIn += m.tokensIn;
        entry.tokensOut += m.tokensOut;
        entry.cache += m.cacheRead + m.cacheWrite;
        entry.costUsd += cost ?? 0;
        models.set(m.model, entry);
      }
      tokens += runTokens;
      costUsd += runCost;
      priced ||= runPriced;
      return { tokens: runTokens, costUsd: runPriced ? runCost : null, models: [...new Set(messages.map((m) => m.model).filter((m): m is string => !!m && m !== "<synthetic>"))] };
    };
    const own = this.messages(session.id);
    tally(own, session.tool);
    const subagents = this.runs(session.id).flatMap((link) => {
      const child = this.get(link.child_id);
      if (!child) return [];
      const run = tally(child.messages, child.session.tool);
      return [{
        id: child.session.id, title: child.session.title, parentSeq: link.parent_seq, callIndex: link.call_index,
        startedAt: child.session.startedAt, endedAt: child.session.endedAt, messageCount: child.messages.length, ...run,
      }];
    });
    const summary: ConversationSummary = {
      messageCount: own.length,
      tokens,
      costUsd,
      priced,
      models: [...models.values()].sort((a, b) => b.costUsd - a.costUsd),
      replies: own.filter((m) => m.role === "assistant").map((m) => ({ seq: m.seq, tokens: m.tokensIn + m.tokensOut + m.cacheRead + m.cacheWrite })),
      tools: [...tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      files: [...files.values()].sort((a, b) => b.edits - a.edits || b.reads - a.reads || a.path.localeCompare(b.path)),
      subagents,
    };
    if (this.summaries.size > 50) this.summaries.delete(this.summaries.keys().next().value!);
    this.summaries.set(session.id, summary);
    return summary;
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
