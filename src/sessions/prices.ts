import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { ModelPrice, PriceTier } from "../shared/types";

export const MODELS_DEV_URL = "https://models.dev/api.json";
/** Kept even when no session used them yet, so a new tool is priced from its first message. */
const ALWAYS = ["anthropic", "openai", "azure", "openrouter", "opencode", "google"];
/** Resellers list the same model ids; the maker's own price is the one billed for direct use. */
const FIRST_PARTY = ["anthropic", "openai", "google", "azure", "opencode", "openrouter"];
/** OpenCode reports reasoning tokens apart from output; Claude Code counts them inside output. */
const REASONING_SEPARATE: Record<string, boolean> = { opencode: true };

export interface Tokens {
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

type Rates = Pick<ModelPrice, "input" | "output" | "cacheRead" | "cacheWrite">;

/** USD for one message. Long prompts use the highest tier their prompt size passes. */
export function messageCost(price: ModelPrice, tokens: Tokens, tool: string): number {
  const prompt = tokens.tokensIn + tokens.cacheRead + tokens.cacheWrite;
  let rates: Rates = price;
  for (const tier of price.tiers) if (prompt > tier.above) rates = tier;
  const reasoning = REASONING_SEPARATE[tool] ? tokens.tokensReasoning * (price.reasoning ?? rates.output) : 0;
  return (
    (tokens.tokensIn * rates.input +
      tokens.tokensOut * rates.output +
      tokens.cacheRead * (rates.cacheRead ?? rates.input) +
      tokens.cacheWrite * (rates.cacheWrite ?? rates.input) +
      reasoning) /
    1e6
  );
}

/** `anthropic/claude-sonnet-4.5-20250929` → `claude-sonnet-4-5`. */
export function normalizeModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/^[\w-]+\//, "")
    .replace(/-\d{8}$/, "")
    .replace(/\./g, "-");
}

const key = (provider: string, model: string) => `${provider}/${model}`;

/** Exact match, then normalized under the same provider, then the same model from any provider (makers first). */
export function matchPrice(prices: Map<string, ModelPrice[]>, provider: string | null, model: string): ModelPrice[] | null {
  const exact = provider ? prices.get(key(provider, model)) : undefined;
  if (exact) return exact;
  const normalized = normalizeModel(model);
  const sameProvider = provider ? prices.get(key(provider, normalized)) : undefined;
  if (sameProvider) return sameProvider;
  const candidates = [...prices.entries()].filter(([name]) => name.slice(name.indexOf("/") + 1) === normalized);
  if (!candidates.length) return null;
  const rank = (name: string) => {
    const index = FIRST_PARTY.indexOf(name.slice(0, name.indexOf("/")));
    return index === -1 ? FIRST_PARTY.length : index;
  };
  candidates.sort(([a], [b]) => rank(a) - rank(b));
  return candidates[0]?.[1] ?? null;
}

/** The price in force at `at`; messages older than the first stored price use the oldest one. */
export function priceAt(history: ModelPrice[], at: number): ModelPrice | null {
  let found: ModelPrice | null = history[0] ?? null;
  for (const price of history) if (price.validFrom <= at) found = price;
  return found;
}

interface DevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
  context_over_200k?: DevCost;
  tiers?: (DevCost & { tier?: { type?: string; size?: number } })[];
}

type DevCatalog = Record<string, { models?: Record<string, { cost?: DevCost }> }>;

function tier(above: number, cost: DevCost): PriceTier | null {
  if (typeof cost.input !== "number" || typeof cost.output !== "number") return null;
  return { above, input: cost.input, output: cost.output, cacheRead: cost.cache_read ?? null, cacheWrite: cost.cache_write ?? null };
}

/** models.dev entries with an input and output price, as rows. */
export function parseCatalog(catalog: DevCatalog, providers: Set<string>, at: number): ModelPrice[] {
  const rows: ModelPrice[] = [];
  for (const [provider, entry] of Object.entries(catalog)) {
    if (!providers.has(provider)) continue;
    for (const [model, info] of Object.entries(entry.models ?? {})) {
      const cost = info.cost;
      if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") continue;
      const tiers = [
        ...(cost.context_over_200k ? [tier(200_000, cost.context_over_200k)] : []),
        ...(cost.tiers ?? []).filter((t) => t.tier?.type === "context" && typeof t.tier.size === "number").map((t) => tier(t.tier?.size ?? 0, t)),
      ]
        .filter((t): t is PriceTier => t !== null)
        .sort((a, b) => a.above - b.above);
      rows.push({
        provider,
        model,
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cache_read ?? null,
        cacheWrite: cost.cache_write ?? null,
        reasoning: cost.reasoning ?? null,
        tiers,
        source: "models.dev",
        validFrom: at,
      });
    }
  }
  return rows;
}

const same = (a: ModelPrice, b: ModelPrice) =>
  a.input === b.input &&
  a.output === b.output &&
  a.cacheRead === b.cacheRead &&
  a.cacheWrite === b.cacheWrite &&
  a.reasoning === b.reasoning &&
  JSON.stringify(a.tiers) === JSON.stringify(b.tiers);

/** Per-model prices in `sessions.db`. A new row only when a price changes, so old messages keep their old price. */
export class PriceBook {
  private prices = new Map<string, ModelPrice[]>();
  private resolved = new Map<string, ModelPrice[] | null>();
  updatedAt: number | null = null;

  constructor(
    private readonly db: Database,
    private readonly manualPath: string | null,
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS model_prices (
      provider TEXT NOT NULL, model TEXT NOT NULL, valid_from INTEGER NOT NULL,
      input REAL NOT NULL, output REAL NOT NULL, cache_read REAL, cache_write REAL, reasoning REAL,
      tiers TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY (provider, model, valid_from))`);
    db.run("CREATE TABLE IF NOT EXISTS price_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    this.load();
  }

  private load(): void {
    this.prices.clear();
    this.resolved.clear();
    const rows = this.db.query("SELECT * FROM model_prices ORDER BY valid_from").all() as any[];
    for (const r of rows) this.push({
      provider: r.provider, model: r.model, validFrom: r.valid_from, input: r.input, output: r.output,
      cacheRead: r.cache_read, cacheWrite: r.cache_write, reasoning: r.reasoning, tiers: JSON.parse(r.tiers), source: r.source,
    });
    for (const manual of this.manual()) this.prices.set(key(manual.provider, manual.model), [manual]);
    this.updatedAt = (this.db.query("SELECT value FROM price_meta WHERE key = 'fetched'").get() as { value: number } | null)?.value ?? null;
  }

  private push(price: ModelPrice): void {
    const list = this.prices.get(key(price.provider, price.model)) ?? [];
    list.push(price);
    this.prices.set(key(price.provider, price.model), list);
  }

  /** `prices.json` in the data dir: `[{provider, model, input, output, cache_read?, cache_write?}]`, wins over models.dev. */
  private manual(): ModelPrice[] {
    if (!this.manualPath) return [];
    try {
      const list = JSON.parse(readFileSync(this.manualPath, "utf8")) as (DevCost & { provider: string; model: string })[];
      return parseCatalog(
        Object.fromEntries(list.map((entry) => [entry.provider, { models: { [entry.model]: { cost: entry } } }])),
        new Set(list.map((entry) => entry.provider)),
        0,
      ).map((price) => ({ ...price, source: "manual" as const }));
    } catch {
      return [];
    }
  }

  /** Stores what changed; returns how many rows were added. */
  store(rows: ModelPrice[], at: number): number {
    const latest = new Map<string, ModelPrice>();
    for (const [name, history] of this.prices) {
      const stored = history.filter((price) => price.source === "models.dev").at(-1);
      if (stored) latest.set(name, stored);
    }
    const insert = this.db.prepare("INSERT OR REPLACE INTO model_prices VALUES (?,?,?,?,?,?,?,?,?,?)");
    let added = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        const current = latest.get(key(row.provider, row.model));
        if (current && same(current, row)) continue;
        insert.run(row.provider, row.model, row.validFrom, row.input, row.output, row.cacheRead, row.cacheWrite, row.reasoning, JSON.stringify(row.tiers), row.source);
        added += 1;
      }
      this.db.run("INSERT OR REPLACE INTO price_meta VALUES ('fetched', ?)", [at]);
    })();
    this.load();
    return added;
  }

  /** Fetches models.dev; on failure keeps what is stored. */
  async refresh(seenProviders: string[], fetcher: typeof fetch = fetch): Promise<number> {
    const response = await fetcher(MODELS_DEV_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`models.dev ${response.status}`);
    const now = Date.now();
    return this.store(parseCatalog((await response.json()) as DevCatalog, new Set([...ALWAYS, ...seenProviders]), now), now);
  }

  resolve(provider: string | null, model: string | null): ModelPrice[] | null {
    if (!model) return null;
    const name = key(provider ?? "", model);
    if (!this.resolved.has(name)) this.resolved.set(name, matchPrice(this.prices, provider, model));
    return this.resolved.get(name) ?? null;
  }

  /** USD for a message, or null when its model has no price. */
  cost(message: Tokens & { provider: string | null; model: string | null; at: number }, tool: string): number | null {
    const history = this.resolve(message.provider, message.model);
    const price = history ? priceAt(history, message.at) : null;
    return price ? messageCost(price, message, tool) : null;
  }

  /** The newest price of every model. */
  list(): ModelPrice[] {
    return [...this.prices.values()].map((history) => history.at(-1)).filter((price): price is ModelPrice => price !== undefined);
  }
}
