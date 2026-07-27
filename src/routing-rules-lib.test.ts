/**
 * SCO-231 — tests for the routing-rules override logic. Fixture-based, same
 * makeModel() convention as routing-engine.test.ts. Covers the four cases
 * the card calls out explicitly: a rule overriding one category without
 * affecting others, a provider-exclusion rule, custom priority ordering,
 * and the no-matching-rule fallthrough to SCO-230's default ranking —
 * plus the config validator's structural checks.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { resolveCategoryRanking, validateRoutingRulesConfig, type RoutingRule } from "./routing-rules-lib.js";
import { rankModelsForCategory, type RoutableModel } from "./routing-engine.js";

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

function bench(benchmark: string, score: number) {
  return { benchmark, score, source: { url: "https://example.test", type: "vendor" } };
}

// ---------------------------------------------------------------------------
// validateRoutingRulesConfig
// ---------------------------------------------------------------------------

describe("validateRoutingRulesConfig", () => {
  test("accepts a well-formed config", () => {
    const result = validateRoutingRulesConfig({
      version: 1,
      rules: [{ category: "autocomplete", strategy: "cheapest" }],
    });
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.rulesByCategory.get("autocomplete"));
  });

  test("rejects a non-object root", () => {
    const result = validateRoutingRulesConfig("not an object");
    assert.equal(result.ok, false);
  });

  test("rejects an unsupported version", () => {
    const result = validateRoutingRulesConfig({ version: 2, rules: [] });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.includes("version")));
  });

  test("rejects an unknown category", () => {
    const result = validateRoutingRulesConfig({ version: 1, rules: [{ category: "agentic-multi-step" }] });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.includes("category")));
  });

  test("rejects a duplicate category across rules", () => {
    const result = validateRoutingRulesConfig({
      version: 1,
      rules: [{ category: "bug-fix", strategy: "cheapest" }, { category: "bug-fix", excludeProviders: ["x"] }],
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.includes("duplicate")));
  });

  test("rejects priority and strategy set together", () => {
    const result = validateRoutingRulesConfig({
      version: 1,
      rules: [{ category: "bug-fix", strategy: "cheapest", priority: ["test/a"] }],
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.includes("mutually exclusive")));
  });

  test("rejects an unsupported strategy", () => {
    const result = validateRoutingRulesConfig({ version: 1, rules: [{ category: "bug-fix", strategy: "fastest" }] });
    assert.equal(result.ok, false);
  });

  // SCO-330 — minScore quality bar
  test("accepts a well-formed minScore rule", () => {
    const result = validateRoutingRulesConfig({ version: 1, rules: [{ category: "bug-fix", minScore: 0.65 }] });
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.rulesByCategory.get("bug-fix")?.minScore === 0.65);
  });

  test("rejects a minScore outside 0-1", () => {
    const tooHigh = validateRoutingRulesConfig({ version: 1, rules: [{ category: "bug-fix", minScore: 1.5 }] });
    assert.equal(tooHigh.ok, false);
    const negative = validateRoutingRulesConfig({ version: 1, rules: [{ category: "bug-fix", minScore: -0.1 }] });
    assert.equal(negative.ok, false);
  });

  test("rejects a non-numeric minScore", () => {
    const result = validateRoutingRulesConfig({ version: 1, rules: [{ category: "bug-fix", minScore: "0.65" }] });
    assert.equal(result.ok, false);
  });

  test("rejects minScore combined with priority", () => {
    const result = validateRoutingRulesConfig({
      version: 1,
      rules: [{ category: "bug-fix", minScore: 0.65, priority: ["test/a"] }],
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.includes("mutually exclusive")));
  });

  test("rejects minScore combined with strategy", () => {
    const result = validateRoutingRulesConfig({
      version: 1,
      rules: [{ category: "bug-fix", minScore: 0.65, strategy: "cheapest" }],
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.includes("mutually exclusive")));
  });
});

// ---------------------------------------------------------------------------
// resolveCategoryRanking
// ---------------------------------------------------------------------------

describe("resolveCategoryRanking", () => {
  test("no matching rule falls through to SCO-230's default ranking, unmodified", () => {
    const strong = makeModel({ name: "Strong", benchmarks: [bench("swe-bench-pro", 0.7)] });
    const weak = makeModel({ name: "Weak", benchmarks: [bench("swe-bench-pro", 0.4)] });

    const withoutRule = resolveCategoryRanking([weak, strong], "bug-fix", undefined);
    const defaultRanking = rankModelsForCategory([weak, strong], "bug-fix");

    assert.equal(withoutRule.ruleApplied, false);
    assert.deepEqual(
      withoutRule.ranked.map((r) => r.model.name),
      defaultRanking.ranked.map((r) => r.model.name),
    );
  });

  test("a rule for one category doesn't affect another category's ranking", () => {
    const cheap = makeModel({ name: "Cheap", benchmarks: [bench("swe-bench-pro", 0.5)], inputPricePerM: 1 });
    const strongExpensive = makeModel({
      name: "StrongExpensive",
      benchmarks: [bench("swe-bench-pro", 0.9)],
      inputPricePerM: 20,
    });

    const autocompleteRule: RoutingRule = { category: "autocomplete", strategy: "cheapest" };

    // The rule is scoped to "autocomplete" — applying it (or not) to a
    // "bug-fix" lookup must be a no-op because the caller simply wouldn't
    // pass this rule in for that category. Simulate the real call site
    // (run-task-lib.ts only looks up the rule matching the chosen category).
    const bugFixRuleForThisCategory = undefined; // no autocomplete rule applies to bug-fix
    const bugFixRanking = resolveCategoryRanking([cheap, strongExpensive], "bug-fix", bugFixRuleForThisCategory);
    const defaultBugFixRanking = rankModelsForCategory([cheap, strongExpensive], "bug-fix");

    assert.equal(bugFixRanking.ruleApplied, false);
    assert.deepEqual(
      bugFixRanking.ranked.map((r) => r.model.name),
      defaultBugFixRanking.ranked.map((r) => r.model.name),
    );
    assert.deepEqual(bugFixRanking.ranked.map((r) => r.model.name), ["StrongExpensive", "Cheap"]); // benchmark-ranked, unaffected

    // Meanwhile autocomplete's own rule DOES flip cheapest to the top.
    const autocompleteModels = [
      makeModel({ name: "Cheap", inputPricePerM: 1, capability: new Map([["speed", "moderate"]]) }),
      makeModel({ name: "StrongExpensive", inputPricePerM: 20, capability: new Map([["speed", "moderate"]]) }),
    ];
    const autocompleteRanking = resolveCategoryRanking(autocompleteModels, "autocomplete", autocompleteRule);
    assert.equal(autocompleteRanking.ruleApplied, true);
    assert.equal(autocompleteRanking.ranked[0]!.model.name, "Cheap");
  });

  test('"never route to provider X" excludes that provider but still composes with the default ranking', () => {
    const bannedProviderStrong = makeModel({
      name: "BannedStrong",
      provider: "banned-provider",
      benchmarks: [bench("swe-bench-pro", 0.95)],
    });
    const allowedWeaker = makeModel({
      name: "AllowedWeaker",
      provider: "ok-provider",
      benchmarks: [bench("swe-bench-pro", 0.5)],
    });

    const rule: RoutingRule = { category: "bug-fix", excludeProviders: ["banned-provider"] };
    const result = resolveCategoryRanking([bannedProviderStrong, allowedWeaker], "bug-fix", rule);

    assert.equal(result.ruleApplied, true);
    assert.deepEqual(result.ranked.map((r) => r.model.name), ["AllowedWeaker"]);
    assert.ok(result.excluded.some((e) => e.model.name === "BannedStrong" && e.reason.includes("excludeProviders")));
    // Composition, not full replacement: the default engine's own scoring
    // (benchmark-based) still produced this ranking — a rankByBenchmark-shaped
    // label survives on the one remaining model.
    assert.match(result.ranked[0]!.scoreLabel, /SWE-bench/);
  });

  test("custom priority ordering fully overrides the default ranking for that category", () => {
    const highBenchmarkButLowPriority = makeModel({
      name: "HighBenchmark",
      benchmarks: [bench("swe-bench-pro", 0.99)],
    });
    const lowBenchmarkButTopPriority = makeModel({
      name: "TopPriority",
      benchmarks: [bench("swe-bench-pro", 0.1)],
    });
    const notNamedAtAll = makeModel({ name: "NotNamed", benchmarks: [bench("swe-bench-pro", 0.5)] });

    const rule: RoutingRule = {
      category: "bug-fix",
      priority: [lowBenchmarkButTopPriority.modelId, highBenchmarkButLowPriority.modelId],
    };
    const result = resolveCategoryRanking(
      [highBenchmarkButLowPriority, lowBenchmarkButTopPriority, notNamedAtAll],
      "bug-fix",
      rule,
    );

    assert.equal(result.ruleApplied, true);
    assert.deepEqual(result.ranked.map((r) => r.model.name), ["TopPriority", "HighBenchmark"]);
    assert.equal(result.unscored.length, 0);
    assert.ok(result.excluded.some((e) => e.model.name === "NotNamed"));
    assert.equal(result.unmatchedPriorityIds.length, 0);
  });

  test("priority entries with no matching model are reported, not silently dropped", () => {
    const onlyModel = makeModel({ name: "OnlyModel" });
    const rule: RoutingRule = { category: "bug-fix", priority: ["test/does-not-exist", onlyModel.modelId] };
    const result = resolveCategoryRanking([onlyModel], "bug-fix", rule);

    assert.deepEqual(result.ranked.map((r) => r.model.name), ["OnlyModel"]);
    assert.deepEqual(result.unmatchedPriorityIds, ["test/does-not-exist"]);
  });

  // SCO-330 — minScore composes with the default engine (and with
  // excludeProviders), reproducing SCO-329's exact live finding via the
  // rules-file path rather than calling rankBugFix directly.
  test("minScore flips the default engine from best-first to cheapest-among-qualifying for its category", () => {
    const gpt56Sol = makeModel({ name: "GPT-5.6 Sol", benchmarks: [bench("swe-bench-verified", 0.962)], inputPricePerM: 5 });
    const o4Mini = makeModel({ name: "o4-mini", benchmarks: [bench("swe-bench-verified", 0.68)], inputPricePerM: 1.1 });

    const rule: RoutingRule = { category: "bug-fix", minScore: 0.65 };
    const result = resolveCategoryRanking([gpt56Sol, o4Mini], "bug-fix", rule);

    assert.equal(result.ruleApplied, true);
    assert.equal(result.ranked[0]!.model.name, "o4-mini");
  });

  test("minScore composes with excludeProviders (both filter the pool before the default engine ranks it)", () => {
    const bannedCheap = makeModel({
      name: "BannedCheap",
      provider: "banned-provider",
      benchmarks: [bench("swe-bench-pro", 0.7)],
      inputPricePerM: 1,
    });
    const allowedExpensive = makeModel({
      name: "AllowedExpensive",
      provider: "ok-provider",
      benchmarks: [bench("swe-bench-pro", 0.9)],
      inputPricePerM: 10,
    });
    const allowedBelowBar = makeModel({
      name: "AllowedBelowBar",
      provider: "ok-provider",
      benchmarks: [bench("swe-bench-pro", 0.3)],
      inputPricePerM: 1,
    });

    const rule: RoutingRule = { category: "bug-fix", excludeProviders: ["banned-provider"], minScore: 0.5 };
    const result = resolveCategoryRanking([bannedCheap, allowedExpensive, allowedBelowBar], "bug-fix", rule);

    assert.equal(result.ruleApplied, true);
    assert.deepEqual(result.ranked.map((r) => r.model.name), ["AllowedExpensive"]);
    assert.ok(result.excluded.some((e) => e.model.name === "BannedCheap" && e.reason.includes("excludeProviders")));
    assert.ok(result.excluded.some((e) => e.model.name === "AllowedBelowBar" && e.reason.includes("minScore")));
  });

  test("excludeProviders composes with priority — an excluded provider's model is never eligible even if named in priority", () => {
    const banned = makeModel({ name: "Banned", provider: "banned-provider" });
    const allowed = makeModel({ name: "Allowed", provider: "ok-provider" });
    const rule: RoutingRule = {
      category: "bug-fix",
      excludeProviders: ["banned-provider"],
      priority: [banned.modelId, allowed.modelId],
    };
    const result = resolveCategoryRanking([banned, allowed], "bug-fix", rule);

    assert.deepEqual(result.ranked.map((r) => r.model.name), ["Allowed"]);
    assert.ok(result.excluded.some((e) => e.model.name === "Banned" && e.reason.includes("excludeProviders")));
  });
});
