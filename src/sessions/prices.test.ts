import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ModelPrice } from "../shared/types";
import { matchPrice, messageCost, normalizeModel, parseCatalog, PriceBook, priceAt } from "./prices";

const price = (overrides: Partial<ModelPrice> = {}): ModelPrice => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
  reasoning: null,
  tiers: [],
  source: "models.dev",
  validFrom: 0,
  ...overrides,
});
const tokens = { tokensIn: 1_000_000, tokensOut: 1_000_000, tokensReasoning: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 };

describe("prices", () => {
  test("cost counts input, output and both cache directions", () => {
    expect(messageCost(price(), tokens, "claude-code")).toBeCloseTo(3 + 15 + 0.3 + 3.75);
  });

  test("missing cache prices fall back to the input price", () => {
    expect(messageCost(price({ cacheRead: null, cacheWrite: null }), tokens, "claude-code")).toBeCloseTo(3 + 15 + 3 + 3);
  });

  test("a prompt past a tier uses that tier's rates", () => {
    const tiered = price({ tiers: [{ above: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 }] });
    expect(messageCost(tiered, { ...tokens, tokensIn: 100_000, cacheRead: 0, cacheWrite: 0, tokensOut: 0 }, "claude-code")).toBeCloseTo(0.3);
    expect(messageCost(tiered, { ...tokens, tokensIn: 300_000, cacheRead: 0, cacheWrite: 0, tokensOut: 0 }, "claude-code")).toBeCloseTo(1.8);
  });

  test("reasoning is billed apart only for tools that report it apart", () => {
    const withReasoning = { ...tokens, tokensIn: 0, cacheRead: 0, cacheWrite: 0, tokensOut: 0, tokensReasoning: 1_000_000 };
    expect(messageCost(price({ reasoning: 10 }), withReasoning, "claude-code")).toBe(0);
    expect(messageCost(price({ reasoning: 10 }), withReasoning, "opencode")).toBeCloseTo(10);
  });

  test("model names normalize across providers, dates and dots", () => {
    expect(normalizeModel("anthropic/Claude-Sonnet-4.5-20250929")).toBe("claude-sonnet-4-5");
    const prices = new Map([
      ["openrouter/claude-sonnet-4-5", [price({ provider: "openrouter", input: 9 })]],
      ["anthropic/claude-sonnet-4-5", [price()]],
    ]);
    expect(matchPrice(prices, "opencode", "anthropic/claude-sonnet-4.5")?.[0]?.input).toBe(3);
    expect(matchPrice(prices, "openrouter", "claude-sonnet-4-5")?.[0]?.input).toBe(9);
    expect(matchPrice(prices, null, "gpt-unknown")).toBeNull();
  });

  test("the price in force at a message's time wins, older messages use the first", () => {
    const history = [price({ validFrom: 100, input: 3 }), price({ validFrom: 200, input: 2 })];
    expect(priceAt(history, 50)?.input).toBe(3);
    expect(priceAt(history, 250)?.input).toBe(2);
  });

  test("storing only adds a row when a price changed", () => {
    const book = new PriceBook(new Database(":memory:"), null);
    const catalog = { anthropic: { models: { "claude-sonnet-4-5": { cost: { input: 3, output: 15, context_over_200k: { input: 6, output: 22.5 } } } } } };
    expect(book.store(parseCatalog(catalog, new Set(["anthropic"]), 1), 1)).toBe(1);
    expect(book.store(parseCatalog(catalog, new Set(["anthropic"]), 2), 2)).toBe(0);
    expect(book.list()[0]?.tiers[0]?.above).toBe(200_000);
    catalog.anthropic.models["claude-sonnet-4-5"].cost.input = 2;
    expect(book.store(parseCatalog(catalog, new Set(["anthropic"]), 3), 3)).toBe(1);
    expect(book.resolve("anthropic", "claude-sonnet-4-5")).toHaveLength(2);
  });
});
