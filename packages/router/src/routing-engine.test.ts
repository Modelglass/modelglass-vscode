/**
 * SCO-230 — tests for the routing engine's scoring/ranking logic.
 *
 * Fixture-based, same convention as lib.test.ts/switch-check-lib.test.ts —
 * a makeModel() helper with sensible defaults + overrides, no live API
 * calls. Covers a clean-mapping category (bug-fix), a fallback category
 * (autocomplete), and the two behaviours most likely to hide a real bug:
 * terminal-cli's harness-comparability exclusion and refactor's
 * benchmark-then-capability cascade — a happy-path-only test suite would
 * miss both.
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MODELGLASS_FETCH_TIMEOUT_MS,
  fetchLLMModels,
  normaliseOfferings,
  rankAgenticMultiStep,
  rankAutocomplete,
  rankBugFix,
  rankDocGen,
  rankLibraryAwareFeatureWork,
  rankModelsForCategory,
  rankNewCodeGeneration,
  rankRefactor,
  rankTerminalCli,
  tiesWithAnchor,
  rankTestGen,
  type ModelEntry,
  type Offering,
  type RoutableModel,
} from "./routing-engine.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<RoutableModel> & { name: string }): RoutableModel {
  return {
    slug: overrides.name.toLowerCase().replace(/\s+/g, "-"),
    provider: "test-provider",
    modelId: `test/${overrides.name.toLowerCase().replace(/\s+/g, "-")}`,
    benchmarks: [],
    capability: new Map(),
    inputPricePerM: null,
    outputPricePerM: null,
    ...overrides,
  };
}

function bench(benchmark: string, score: number, extra: Partial<{ variant: string; harness: string; stderr: number }> = {}) {
  return { benchmark, score, source: { url: "https://example.test", type: "vendor" }, ...extra };
}

function makeOffering(overrides: Partial<Offering> & { provider: string }): Offering {
  return {
    slug: `test-${overrides.provider}`,
    tiers: [
      { id: "input", pricing: [{ amount: 1, unit: "per_1m_tokens_input", effective_from: "2026-01-01" }] },
      { id: "output", pricing: [{ amount: 2, unit: "per_1m_tokens_output", effective_from: "2026-01-01" }] },
    ],
    ...overrides,
  };
}

function makeModelEntry(overrides: Partial<ModelEntry> & { model_id: string; name: string }): ModelEntry {
  return { offerings: [], ...overrides };
}

// ---------------------------------------------------------------------------
// SCO-260 item #9 / SCO-280 — normaliseOfferings: one RoutableModel per
// offering, not one per model collapsed to its cheapest offering
// ---------------------------------------------------------------------------

describe("normaliseOfferings", () => {
  // SCO-633 — a retired offering (e.g. Anthropic's claude-sonnet-4, retired
  // 2026-06-15) must never become a routing candidate. Its price is closed
  // out in the registry, but currentPrice() falls back to the last price, so
  // without a status check it would still look routable, and cheap.
  test("SCO-633: a retired offering is excluded; the model's other offerings remain", () => {
    const entry = makeModelEntry({
      model_id: "acme/multi",
      name: "Multi",
      offerings: [
        makeOffering({ provider: "anthropic", slug: "multi-anthropic", model: { status: "retired" } }),
        makeOffering({ provider: "openrouter", slug: "multi-openrouter", model: { status: "ga" } }),
      ],
    });
    const result = normaliseOfferings(entry);
    assert.deepEqual(result.map((r) => r.provider), ["openrouter"]);
  });

  test("SCO-633: a model whose every offering is retired produces NO routable entries (not the zero-offering fallback)", () => {
    const entry = makeModelEntry({
      model_id: "anthropic/claude-sonnet-4",
      name: "Claude Sonnet 4",
      offerings: [makeOffering({ provider: "anthropic", slug: "claude-sonnet-4-anthropic", model: { status: "retired" } })],
    });
    assert.deepEqual(normaliseOfferings(entry), []);
  });

  test("SCO-633: a deprecated offering is still routable (it works until its retirement date)", () => {
    const entry = makeModelEntry({
      model_id: "acme/old",
      name: "Old",
      offerings: [makeOffering({ provider: "openai", slug: "old-openai", model: { status: "deprecated" } })],
    });
    assert.equal(normaliseOfferings(entry).length, 1);
  });

  test("a model with two provider offerings (the real case: llama-3.3-70b via Groq + Together) produces one entry per provider", () => {
    const entry = makeModelEntry({
      model_id: "meta/llama-3.3-70b",
      name: "Llama 3.3 70B",
      offerings: [
        makeOffering({
          provider: "groq",
          slug: "llama-3-3-70b-groq",
          tiers: [
            { id: "input", pricing: [{ amount: 0.59, unit: "per_1m_tokens_input", effective_from: "2026-01-01" }] },
            { id: "output", pricing: [{ amount: 0.79, unit: "per_1m_tokens_output", effective_from: "2026-01-01" }] },
          ],
        }),
        makeOffering({
          provider: "together-ai",
          slug: "llama-3-3-70b-together-ai",
          tiers: [
            { id: "input", pricing: [{ amount: 0.88, unit: "per_1m_tokens_input", effective_from: "2026-01-01" }] },
            { id: "output", pricing: [{ amount: 0.88, unit: "per_1m_tokens_output", effective_from: "2026-01-01" }] },
          ],
        }),
      ],
    });

    const result = normaliseOfferings(entry);

    assert.equal(result.length, 2);
    const byProvider = new Map(result.map((r) => [r.provider, r]));
    assert.equal(byProvider.get("groq")?.inputPricePerM, 0.59);
    assert.equal(byProvider.get("together-ai")?.inputPricePerM, 0.88);
    // The old behavior this replaces: only the cheaper (Groq) offering
    // would have survived at all — a Together-keyed user saw nothing.
    // Both must be present now, each carrying its OWN offering's price,
    // not the globally-cheapest one.
    assert.equal(result.every((r) => r.modelId === "meta/llama-3.3-70b"), true);
  });

  test("a synthetic current-gen multi-provider model (not just the one real legacy case) also produces one entry per offering", () => {
    const entry = makeModelEntry({
      model_id: "openai/synthetic-multi-host",
      name: "Synthetic Multi-Host",
      offerings: [
        makeOffering({ provider: "openai", slug: "synthetic-multi-host-openai" }),
        makeOffering({ provider: "openrouter", slug: "openai/synthetic-multi-host" }),
        makeOffering({ provider: "together-ai", slug: "synthetic-multi-host-together-ai" }),
      ],
    });

    const result = normaliseOfferings(entry);

    assert.deepEqual(
      result.map((r) => r.provider).sort(),
      ["openai", "openrouter", "together-ai"],
    );
    // Regression guard: this must never again collapse to a single winner.
    assert.equal(result.length, entry.offerings.length);
  });

  test("a single-offering model (the common case) behaves exactly as before — one entry, unchanged", () => {
    const entry = makeModelEntry({
      model_id: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      offerings: [makeOffering({ provider: "anthropic", slug: "claude-sonnet-5-anthropic" })],
    });

    const result = normaliseOfferings(entry);

    assert.equal(result.length, 1);
    assert.equal(result[0]!.provider, "anthropic");
  });

  test("a model with zero offerings still produces exactly one placeholder entry, matching the old function's behavior", () => {
    const entry = makeModelEntry({ model_id: "vendor/benchmark-only", name: "Benchmark Only" });

    const result = normaliseOfferings(entry);

    assert.equal(result.length, 1);
    assert.equal(result[0]!.provider, "");
    assert.equal(result[0]!.slug, "vendor/benchmark-only");
    assert.equal(result[0]!.inputPricePerM, null);
  });

  test("benchmarks and capability are copied onto every offering's entry, not just the first", () => {
    const entry = makeModelEntry({
      model_id: "meta/llama-3.3-70b",
      name: "Llama 3.3 70B",
      knowledge: { benchmarks: [bench("swe-bench-pro", 0.5)], capability_profile: [{ dimension: "coding", rating: "strong" }] },
      offerings: [makeOffering({ provider: "groq" }), makeOffering({ provider: "together-ai" })],
    });

    const result = normaliseOfferings(entry);

    assert.equal(result.length, 2);
    for (const r of result) {
      assert.equal(r.benchmarks.length, 1);
      assert.equal(r.capability.get("coding"), "strong");
    }
  });
});

// ---------------------------------------------------------------------------
// 3.1 Bug-fix — clean mapping (SWE-bench Pro preferred, Verified fallback)
// ---------------------------------------------------------------------------

describe("rankBugFix", () => {
  // SCO-330 (default-flip, 2026-07-29): the DEFAULT (no minScore argument)
  // is now cheapest-among-models-clearing-that-benchmark's-own-default-bar
  // (DEFAULT_MIN_SCORE_BY_BENCHMARK["swe-bench-pro"] = 0.5), not
  // score-descending. Both 0.69 and 0.58 clear 0.5, so the cheaper one wins
  // by default now — this replaces the old "ranks... descending" test,
  // which asserted exactly the behavior SCO-329/330 identified as the bug.
  test("both models clear the default SWE-bench Pro bar (0.5) — cheapest of the two wins by default", () => {
    const strong = makeModel({ name: "Strong", benchmarks: [bench("swe-bench-pro", 0.69)], inputPricePerM: 10 });
    const weaker = makeModel({ name: "Weaker", benchmarks: [bench("swe-bench-pro", 0.58)], inputPricePerM: 1 });
    const { ranked, excluded } = rankBugFix([weaker, strong]);
    assert.deepEqual(ranked.map((r) => r.model.name), ["Weaker", "Strong"]);
    assert.equal(excluded.length, 0);
  });

  test("a model below the default SWE-bench Pro bar is excluded, even if cheaper than every qualifier", () => {
    const qualifies = makeModel({ name: "Qualifies", benchmarks: [bench("swe-bench-pro", 0.55)], inputPricePerM: 10 });
    const tooWeak = makeModel({ name: "TooWeak", benchmarks: [bench("swe-bench-pro", 0.3)], inputPricePerM: 0.5 });
    const { ranked, excluded } = rankBugFix([tooWeak, qualifies]);
    assert.deepEqual(ranked.map((r) => r.model.name), ["Qualifies"]);
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0]!.model.name, "TooWeak");
    assert.match(excluded[0]!.reason, /below the default quality bar/);
  });

  test("prefers SWE-bench Pro over Verified when a model has both", () => {
    const model = makeModel({
      name: "Both",
      benchmarks: [bench("swe-bench-pro", 0.6), bench("swe-bench-verified", 0.9)],
    });
    const { ranked } = rankBugFix([model]);
    assert.equal(ranked[0]!.score, 0.6);
    assert.match(ranked[0]!.scoreLabel, /SWE-bench Pro/);
  });

  test("falls back to SWE-bench Verified when Pro is absent", () => {
    const model = makeModel({ name: "Verified only", benchmarks: [bench("swe-bench-verified", 0.72)] });
    const { ranked } = rankBugFix([model]);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]!.score, 0.72);
    assert.match(ranked[0]!.scoreLabel, /SWE-bench Verified 72\.0%.*no Pro score/);
  });

  test("ties on score break cheapest-input-price-first", () => {
    const expensive = makeModel({ name: "Expensive", benchmarks: [bench("swe-bench-pro", 0.6)], inputPricePerM: 10 });
    const cheap = makeModel({ name: "Cheap", benchmarks: [bench("swe-bench-pro", 0.6)], inputPricePerM: 1 });
    const { ranked } = rankBugFix([expensive, cheap]);
    assert.deepEqual(ranked.map((r) => r.model.name), ["Cheap", "Expensive"]);
  });

  test("a model with neither score is unscored, not ranked or excluded", () => {
    const model = makeModel({ name: "No score" });
    const { ranked, excluded, unscored } = rankBugFix([model]);
    assert.equal(ranked.length, 0);
    assert.equal(excluded.length, 0);
    assert.equal(unscored.length, 1);
    assert.equal(unscored[0]!.name, "No score");
  });
});

// ---------------------------------------------------------------------------
// SCO-330 — minScore quality bar (from SCO-329's honest gap review, §2b)
// ---------------------------------------------------------------------------

describe("rankBugFix minScore", () => {
  test("SCO-329's exact live example is fixed BY DEFAULT now, with no rules file needed: GPT-5.6 Sol (96.2%, $5/M) vs o4-mini (68%, $1.1/M)", () => {
    const gpt56Sol = makeModel({ name: "GPT-5.6 Sol", benchmarks: [bench("swe-bench-verified", 0.962)], inputPricePerM: 5 });
    const o4Mini = makeModel({ name: "o4-mini", benchmarks: [bench("swe-bench-verified", 0.68)], inputPricePerM: 1.1 });

    // No minScore argument at all -- this is now what every existing user
    // gets with zero configuration. DEFAULT_MIN_SCORE_BY_BENCHMARK's
    // swe-bench-verified bar (0.6) lets both qualify (96.2% and 68% both
    // clear it) -- cheapest of the qualifiers wins, which is o4-mini. This
    // is the exact case SCO-329 flagged and SCO-330 originally only fixed
    // via an opt-in minScore rule; this second pass makes it the default.
    const noRule = rankBugFix([o4Mini, gpt56Sol]);
    assert.equal(noRule.ranked[0]!.model.name, "o4-mini");
    assert.equal(noRule.excluded.length, 0);

    // An explicit, higher minScore (routing-rules.json) still overrides the
    // default and behaves exactly as SCO-330 originally shipped.
    const explicitHigherBar = rankBugFix([o4Mini, gpt56Sol], 0.9);
    assert.equal(explicitHigherBar.ranked[0]!.model.name, "GPT-5.6 Sol");
    assert.equal(explicitHigherBar.excluded.length, 1);
    assert.equal(explicitHigherBar.excluded[0]!.model.name, "o4-mini");
  });

  test("a model below the threshold is excluded with a reason, not silently dropped or ranked", () => {
    const strong = makeModel({ name: "Strong", benchmarks: [bench("swe-bench-pro", 0.7)], inputPricePerM: 10 });
    const belowBar = makeModel({ name: "BelowBar", benchmarks: [bench("swe-bench-pro", 0.4)], inputPricePerM: 1 });

    const { ranked, excluded } = rankBugFix([strong, belowBar], 0.5);

    assert.deepEqual(ranked.map((r) => r.model.name), ["Strong"]);
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0]!.model.name, "BelowBar");
    assert.match(excluded[0]!.reason, /below the minScore quality bar/);
  });

  test("no qualifying model at all yields an empty ranked list, all moved to excluded — an EXPLICIT minScore gets no safety net", () => {
    const a = makeModel({ name: "A", benchmarks: [bench("swe-bench-pro", 0.3)] });
    const b = makeModel({ name: "B", benchmarks: [bench("swe-bench-pro", 0.2)] });

    const { ranked, excluded } = rankBugFix([a, b], 0.9);

    assert.equal(ranked.length, 0);
    assert.equal(excluded.length, 2);
  });

  // SCO-330 (default-flip) — the safety valve. An EXPLICIT minScore that
  // excludes everyone (above) stays genuinely empty; the DEFAULT bar
  // excluding everyone falls back to score-descending instead, so a
  // temporarily weak pool doesn't just look broken.
  test("when EVERY model falls below the default bar, falls back to score-descending over the whole pool instead of an empty ranking", () => {
    const weaker = makeModel({ name: "Weaker", benchmarks: [bench("swe-bench-pro", 0.2)], inputPricePerM: 1 });
    const stronger = makeModel({ name: "Stronger", benchmarks: [bench("swe-bench-pro", 0.35)], inputPricePerM: 10 });

    // No minScore argument -- both are below the default 0.5 bar.
    const { ranked, excluded } = rankBugFix([weaker, stronger]);

    assert.deepEqual(ranked.map((r) => r.model.name), ["Stronger", "Weaker"]);
    assert.equal(excluded.length, 0);
  });

  test("an unscored model (no benchmark at all) stays unscored, not excluded, when a threshold is set", () => {
    const noScore = makeModel({ name: "NoScore" });
    const qualifies = makeModel({ name: "Qualifies", benchmarks: [bench("swe-bench-pro", 0.8)] });

    const { ranked, excluded, unscored } = rankBugFix([noScore, qualifies], 0.5);

    assert.deepEqual(ranked.map((r) => r.model.name), ["Qualifies"]);
    assert.equal(excluded.length, 0);
    assert.equal(unscored.length, 1);
    assert.equal(unscored[0]!.name, "NoScore");
  });

  test("among multiple qualifiers, sorts cheapest-first regardless of how much each clears the bar by", () => {
    const barelyQualifies = makeModel({ name: "Barely", benchmarks: [bench("swe-bench-pro", 0.51)], inputPricePerM: 1 });
    const comfortablyQualifies = makeModel({ name: "Comfortable", benchmarks: [bench("swe-bench-pro", 0.95)], inputPricePerM: 8 });

    const { ranked } = rankBugFix([comfortablyQualifies, barelyQualifies], 0.5);

    assert.deepEqual(ranked.map((r) => r.model.name), ["Barely", "Comfortable"]);
  });
});

describe("rankTerminalCli minScore", () => {
  test("an explicit minScore still filters before banding, and an off-harness score stays excluded for its own reason", () => {
    const weak = makeModel({ name: "Weak", benchmarks: [bench("terminal-bench-4-0", 0.3, { harness: "mini-swe-agent", stderr: 0.02 })] });
    const offHarness = makeModel({ name: "OffHarness", benchmarks: [bench("terminal-bench-4-0", 0.9, { harness: "terminus-2" })] });
    const strong = makeModel({ name: "Strong", benchmarks: [bench("terminal-bench-4-0", 0.6, { harness: "mini-swe-agent", stderr: 0.02 })] });

    const { ranked, excluded } = rankTerminalCli([weak, offHarness, strong], 0.5);

    assert.deepEqual(ranked.map((r) => r.model.name), ["Strong"]);
    assert.equal(excluded.length, 2);
    assert.ok(excluded.some((e) => e.model.name === "OffHarness" && e.reason.includes("not comparable")));
    assert.ok(excluded.some((e) => e.model.name === "Weak" && e.reason.includes("minScore")));
  });
});

// ---------------------------------------------------------------------------
// 3.2 / 3.3 — tie bands (ADR-0027 §6), the same cases as Modelglass's
// route_task tests (modelglass #1027)
// ---------------------------------------------------------------------------

describe("tie bands: new-code-generation (Vibe Code Bench) and terminal-cli (Terminal-Bench 4.0)", () => {
  const vcb = (name: string, score: number, stderr: number | undefined, price: number) =>
    makeModel({
      name,
      inputPricePerM: price,
      benchmarks: [bench("vibe-code-bench", score, { harness: "openhands", ...(stderr === undefined ? {} : { stderr }) })],
    });
  const tb4 = (name: string, score: number, stderr: number | undefined, price: number) =>
    makeModel({
      name,
      inputPricePerM: price,
      benchmarks: [bench("terminal-bench-4-0", score, { harness: "mini-swe-agent", ...(stderr === undefined ? {} : { stderr }) })],
    });
  const bands = (r: { ranked: { band?: number; model: RoutableModel }[] }) => r.ranked.map((x) => `${x.band}:${x.model.name}`);

  test("tiesWithAnchor: statistical tie AND within 3 points", () => {
    assert.equal(tiesWithAnchor({ score: 0.9, stderr: 0.01 }, { score: 0.88, stderr: 0.01 }), true);
    assert.equal(tiesWithAnchor({ score: 0.9, stderr: 0.01 }, { score: 0.87, stderr: 0.01 }), false);
    assert.equal(tiesWithAnchor({ score: 0.9, stderr: 0.03 }, { score: 0.865, stderr: 0.03 }), false);
    assert.equal(tiesWithAnchor({ score: 0.9, stderr: 0.03 }, { score: 0.87, stderr: 0.03 }), true);
  });

  test("a reported stderr of 0 is real: it narrows the test, and two zeros tie only an exact score", () => {
    assert.equal(tiesWithAnchor({ score: 0.65, stderr: 0 }, { score: 0.635, stderr: 0.01 }), true);
    assert.equal(tiesWithAnchor({ score: 0.65, stderr: 0 }, { score: 0.625, stderr: 0.01 }), false);
    assert.equal(tiesWithAnchor({ score: 0.65, stderr: 0 }, { score: 0.649, stderr: 0 }), false);
    const r = rankTerminalCli([tb4("top", 0.65, 0, 4), tb4("near", 0.635, 0.01, 2), tb4("far", 0.625, 0.01, 1)]);
    assert.deepEqual(bands(r), ["1:near", "1:top", "2:far"]);
  });

  test("a missing stderr falls back to strict order: it ties only an exact score", () => {
    const r = rankNewCodeGeneration([vcb("top", 0.9, 0.02, 8), vcb("nose", 0.899, undefined, 1), vcb("same", 0.9, undefined, 2)]);
    assert.deepEqual(bands(r), ["1:same", "1:top", "2:nose"]);
    assert.match(r.ranked.find((x) => x.model.name === "nose")!.scoreLabel, /no standard error published/);
  });

  test("an exact tie at the top: higher score, then lower price, then model id picks the anchor", () => {
    const r = rankTerminalCli([tb4("pricey", 0.6515, 0.0231, 8), tb4("cheap", 0.6515, 0, 4), tb4("close", 0.6414, 0.0101, 2), tb4("tight", 0.6315, 0.009, 2)]);
    assert.deepEqual(bands(r), ["1:close", "1:cheap", "1:pricey", "2:tight"]);
    const s = rankNewCodeGeneration([vcb("b", 0.9, 0.01, 2), vcb("a", 0.9, 0.01, 2)]);
    assert.deepEqual(bands(s), ["1:a", "1:b"]);
  });

  test("a model that ties statistically but sits more than 3 points behind stays out of band 1", () => {
    // Haiku 5.5 vs Fable 5.2 on Vibe Code Bench (2026-11-16 board).
    const r = rankNewCodeGeneration([vcb("fable", 0.9377, 0.0115, 8), vcb("haiku", 0.9044, 0.0173, 0.1)]);
    assert.deepEqual(bands(r), ["1:fable", "2:haiku"]);
  });

  test("the 3-point rule applies in band 2 too", () => {
    const r = rankNewCodeGeneration([vcb("top", 0.95, 0.005, 5), vcb("second", 0.9, 0.03, 5), vcb("stat-tie-far", 0.86, 0.03, 0.1), vcb("near", 0.88, 0.03, 1)]);
    assert.deepEqual(bands(r), ["1:top", "2:near", "2:second", "3:stat-tie-far"]);
  });

  test("bands are anchored, not chained, and cheapest first inside each band", () => {
    const r = rankNewCodeGeneration([vcb("a", 0.9, 0.01, 10), vcb("b", 0.885, 0.01, 1), vcb("c", 0.87, 0.01, 0.5)]);
    assert.deepEqual(bands(r), ["1:b", "1:a", "2:c"]);
  });

  test("only the evaluator's harness counts: off-harness rows are excluded (terminal-cli) or unscored (new-code-generation)", () => {
    const off = makeModel({ name: "Off", benchmarks: [bench("terminal-bench-4-0", 0.7, { harness: "terminus-2" })] });
    const r = rankTerminalCli([off]);
    assert.equal(r.ranked.length, 0);
    assert.match(r.excluded[0]!.reason, /not comparable/);
    assert.deepEqual(rankNewCodeGeneration([off]).unscored.map((m) => m.name), ["Off"]);
  });

  test("the old inputs (Aider Polyglot, LiveCodeBench, Terminal-Bench 2.1) no longer rank", () => {
    const old = makeModel({
      name: "Old",
      benchmarks: [bench("aider-polyglot", 0.7), bench("livecodebench", 0.9), bench("terminal-bench-2-1", 0.8, { harness: "terminus-2" })],
    });
    assert.deepEqual(rankNewCodeGeneration([old]).unscored.map((m) => m.name), ["Old"]);
    assert.deepEqual(rankTerminalCli([old]).unscored.map((m) => m.name), ["Old"]);
  });

  test("other categories carry no band", () => {
    const m = makeModel({ name: "M", benchmarks: [bench("swe-bench-pro", 0.6, { stderr: 0.02 })] });
    assert.equal(rankBugFix([m]).ranked[0]!.band, undefined);
  });

  test("snapshot: today's bands from the 2026-11-16 Vals AI boards (current-generation models)", () => {
    const vcbRows: [string, number, number, number][] = [
      ["Claude Fable 5.2", 0.93771, 0.01152, 8], ["Claude Sonnet 5.5", 0.92392, 0.0126, 2], ["Gemini 4 Argon", 0.91907, 0.01899, 2],
      ["Claude Haiku 5.5", 0.90444, 0.01725, 0.1], ["Claude Opus 5.5", 0.90289, 0.01531, 4], ["GPT-6.2 Astra", 0.89898, 0.0204, 8],
      ["Gemini 4 Carbon", 0.89061, 0.02291, 2], ["Gemini 4 Hydrogen", 0.87782, 0.02288, 1.5], ["GPT-6.2 Sol", 0.87616, 0.02195, 2],
      ["Grok 4.7", 0.86172, 0.0218, 2],
    ];
    const r = rankNewCodeGeneration(vcbRows.map(([n, s, e, p]) => vcb(n, s, e, p)));
    assert.deepEqual(bands(r).filter((b) => /^[12]:/.test(b)), [
      "1:Claude Sonnet 5.5", "1:Gemini 4 Argon", "1:Claude Fable 5.2",
      "2:Claude Haiku 5.5", "2:Gemini 4 Hydrogen", "2:Gemini 4 Carbon", "2:GPT-6.2 Sol", "2:Claude Opus 5.5", "2:GPT-6.2 Astra",
    ]);
    const tbRows: [string, number, number, number][] = [
      ["Claude Fable 5.2", 0.65152, 0.02314, 8], ["Claude Opus 5.5", 0.65152, 0, 4], ["Claude Sonnet 5.5", 0.64141, 0.0101, 2],
      ["Kimi K3.1 Pro", 0.63636, 0.0175, 2], ["Gemini 4 Carbon", 0.63131, 0.02201, 2], ["GPT-6.2 Astra", 0.63131, 0.01336, 8],
      ["GPT-6.2 Sol", 0.60606, 0, 2], ["Gemini 4 Argon", 0.57576, 0.02314, 2],
    ];
    const t = rankTerminalCli(tbRows.map(([n, s, e, p]) => tb4(n, s, e, p)));
    assert.deepEqual(bands(t).filter((b) => /^[12]:/.test(b)), [
      "1:Claude Sonnet 5.5", "1:Kimi K3.1 Pro", "1:Gemini 4 Carbon", "1:Claude Opus 5.5", "1:Claude Fable 5.2", "1:GPT-6.2 Astra",
      "2:GPT-6.2 Sol",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

describe("rankModelsForCategory", () => {
  test("dispatches to the matching leaf ranker for every category", () => {
    const model = makeModel({
      name: "All-rounder",
      benchmarks: [
        bench("swe-bench-pro", 0.6),
        bench("vibe-code-bench", 0.6, { harness: "openhands" }),
        bench("terminal-bench-4-0", 0.6, { harness: "mini-swe-agent" }),
        bench("bigcodebench", 0.6, { variant: "hard" }),
      ],
      capability: new Map([
        ["coding", "moderate"],
        ["instruction-following", "moderate"],
        ["speed", "moderate"],
      ]),
    });
    const categories = [
      "bug-fix",
      "new-code-generation",
      "terminal-cli",
      "library-aware-feature-work",
      "refactor",
      "test-gen",
      "doc-gen",
      "chat-explain",
      "autocomplete",
    ] as const;
    for (const category of categories) {
      const { ranked, category: returned } = rankModelsForCategory([model], category);
      assert.equal(returned, category);
      assert.equal(ranked.length, 1, `expected ${category} to rank the all-rounder model`);
    }
  });
});

// ---------------------------------------------------------------------------
// SCO-260 quick-win #1 — this was the one Modelglass API fetch in the Run
// Task path with no bounded timeout (run-task-lib.ts's stale-cache fallback,
// SCO-264, only fires on a *rejected* fetch — a *hung* one never reached it).
// Same hangingFetch convention as provider-execute.test.ts: the stub mirrors
// real fetch's AbortSignal behavior instead of just asserting a timeoutMs is
// threaded through.
// ---------------------------------------------------------------------------
describe("fetchLLMModels — timeout (SCO-260 quick-win #1)", () => {
  function hangingFetch(): typeof fetch {
    return ((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as typeof fetch;
  }

  test("a hung request times out with a clear error instead of hanging forever", async () => {
    globalThis.fetch = hangingFetch();
    await assert.rejects(() => fetchLLMModels("mg_test", 20), /timed out after 20ms/i);
  });

  test("defaults to DEFAULT_MODELGLASS_FETCH_TIMEOUT_MS when no timeoutMs is passed", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ ok: true, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await fetchLLMModels("mg_test");
    assert.ok(calls[0]!.signal instanceof AbortSignal);
    assert.equal(DEFAULT_MODELGLASS_FETCH_TIMEOUT_MS, 15_000);
  });
});

// ---------------------------------------------------------------------------
// SCO-646 — headline price comes from the Standard tier (the SCO-640 rule,
// same as modelglass.com.au / the MCP tools). Fixtures mirror modelglass-llm:
// gpt-5-5-pro-openai (Batch $15/$90 cheaper than Standard $30/$180) and
// inkling-thinking-machines (context-length tiers only, no `input` tier).
// ---------------------------------------------------------------------------

describe("normaliseOfferings headline price (SCO-646)", () => {
  const p = (id: string, amount: number, unit: string, attributes?: Record<string, unknown>) => ({
    id,
    ...(attributes ? { attributes } : {}),
    pricing: [{ amount, unit, effective_from: "2026-01-01" }],
  });

  test("Batch cheaper than Standard: priced at Standard $30/$180", () => {
    const [m] = normaliseOfferings(
      makeModelEntry({
        model_id: "openai/gpt-5.5-pro",
        name: "GPT-5.5 Pro",
        offerings: [
          makeOffering({
            provider: "openai",
            tiers: [
              p("batch-input", 15, "per_1m_tokens_input", { processing: "batch" }),
              p("batch-output", 90, "per_1m_tokens_output", { processing: "batch" }),
              p("input", 30, "per_1m_tokens_input"),
              p("output", 180, "per_1m_tokens_output"),
            ],
          }),
        ],
      }),
    );
    assert.equal(m!.inputPricePerM, 30);
    assert.equal(m!.outputPricePerM, 180);
  });

  test("context-length tiers only: priced at $1.87/$4.68, not null (so it no longer sorts last)", () => {
    const [m] = normaliseOfferings(
      makeModelEntry({
        model_id: "thinking-machines/inkling",
        name: "Inkling",
        offerings: [
          makeOffering({
            provider: "thinking-machines",
            tiers: [
              p("input-64k", 1.87, "per_1m_tokens_input"),
              p("output-64k", 4.68, "per_1m_tokens_output"),
              p("input-256k", 3.74, "per_1m_tokens_input"),
              p("output-256k", 9.36, "per_1m_tokens_output"),
            ],
          }),
        ],
      }),
    );
    assert.equal(m!.inputPricePerM, 1.87);
    assert.equal(m!.outputPricePerM, 4.68);
  });
});
