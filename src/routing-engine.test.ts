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

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  rankAgenticMultiStep,
  rankAutocomplete,
  rankBugFix,
  rankDocGen,
  rankLibraryAwareFeatureWork,
  rankModelsForCategory,
  rankNewCodeGeneration,
  rankRefactor,
  rankTerminalCli,
  rankTestGen,
  type RoutableModel,
} from "./routing-engine.js";

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

function bench(benchmark: string, score: number, extra: Partial<{ variant: string; harness: string }> = {}) {
  return { benchmark, score, source: { url: "https://example.test", type: "vendor" }, ...extra };
}

// ---------------------------------------------------------------------------
// 3.1 Bug-fix — clean mapping (SWE-bench Pro preferred, Verified fallback)
// ---------------------------------------------------------------------------

describe("rankBugFix", () => {
  test("ranks by SWE-bench Pro descending when present", () => {
    const strong = makeModel({ name: "Strong", benchmarks: [bench("swe-bench-pro", 0.69)], inputPricePerM: 10 });
    const weaker = makeModel({ name: "Weaker", benchmarks: [bench("swe-bench-pro", 0.58)], inputPricePerM: 1 });
    const { ranked } = rankBugFix([weaker, strong]);
    assert.deepEqual(ranked.map((r) => r.model.name), ["Strong", "Weaker"]);
    assert.match(ranked[0]!.scoreLabel, /SWE-bench Pro 69\.0%/);
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
// 3.2 New code generation — clean mapping (Aider preferred, LCB fallback)
// ---------------------------------------------------------------------------

describe("rankNewCodeGeneration", () => {
  test("prefers Aider Polyglot over LiveCodeBench when both present", () => {
    const model = makeModel({
      name: "Both",
      benchmarks: [bench("aider-polyglot", 0.7), bench("livecodebench", 0.95)],
    });
    const { ranked } = rankNewCodeGeneration([model]);
    assert.equal(ranked[0]!.score, 0.7);
    assert.match(ranked[0]!.scoreLabel, /Aider Polyglot/);
  });

  test("falls back to LiveCodeBench when Aider Polyglot is absent", () => {
    const model = makeModel({ name: "LCB only", benchmarks: [bench("livecodebench", 0.5)] });
    const { ranked } = rankNewCodeGeneration([model]);
    assert.equal(ranked[0]!.score, 0.5);
    assert.match(ranked[0]!.scoreLabel, /LiveCodeBench 50\.0%.*no Aider Polyglot/);
  });
});

// ---------------------------------------------------------------------------
// 3.3 Terminal / CLI — harness comparability is the real behaviour to test
// ---------------------------------------------------------------------------

describe("rankTerminalCli", () => {
  test("ranks Terminus-2-harness scores", () => {
    const model = makeModel({ name: "T2", benchmarks: [bench("terminal-bench-2-1", 0.8, { harness: "terminus-2" })] });
    const { ranked } = rankTerminalCli([model]);
    assert.equal(ranked.length, 1);
    assert.match(ranked[0]!.scoreLabel, /Terminus 2 harness/);
  });

  test("excludes a native-harness-only score rather than ranking it against Terminus-2 scores", () => {
    const native = makeModel({
      name: "Native only",
      benchmarks: [bench("terminal-bench-2-1", 0.95, { harness: "claude-code-native" })],
    });
    const t2 = makeModel({ name: "T2", benchmarks: [bench("terminal-bench-2-1", 0.8, { harness: "terminus-2" })] });
    const { ranked, excluded } = rankTerminalCli([native, t2]);
    // The native-harness model's 0.95 must NOT outrank the Terminus-2 model's
    // 0.80 — if it did, that would be exactly the "10+ pp harness gap"
    // miscomparison the benchmark's own docs warn about.
    assert.deepEqual(ranked.map((r) => r.model.name), ["T2"]);
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0]!.model.name, "Native only");
    assert.match(excluded[0]!.reason, /not comparable/);
  });

  test("a model with no Terminal-Bench score at all is unscored, not excluded", () => {
    const { unscored, excluded } = rankTerminalCli([makeModel({ name: "None" })]);
    assert.equal(unscored.length, 1);
    assert.equal(excluded.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3.4 Library-aware feature work — BigCodeBench Hard preferred over Full
// ---------------------------------------------------------------------------

describe("rankLibraryAwareFeatureWork", () => {
  test("prefers the Hard variant over Full when both present", () => {
    const model = makeModel({
      name: "Both variants",
      benchmarks: [bench("bigcodebench", 0.75, { variant: "full" }), bench("bigcodebench", 0.55, { variant: "hard" })],
    });
    const { ranked } = rankLibraryAwareFeatureWork([model]);
    assert.equal(ranked[0]!.score, 0.55);
    assert.match(ranked[0]!.scoreLabel, /BigCodeBench Hard/);
  });

  test("falls back to Full when Hard is absent", () => {
    const model = makeModel({ name: "Full only", benchmarks: [bench("bigcodebench", 0.75, { variant: "full" })] });
    const { ranked } = rankLibraryAwareFeatureWork([model]);
    assert.equal(ranked[0]!.score, 0.75);
    assert.match(ranked[0]!.scoreLabel, /no Hard-variant/);
  });
});

// ---------------------------------------------------------------------------
// 3.5 Refactor — the benchmark-then-capability cascade
// ---------------------------------------------------------------------------

describe("rankRefactor", () => {
  test("a SWE-bench-scored model always outranks a capability-only model, regardless of raw numbers", () => {
    // Deliberately picked so a naive shared-axis sort would get this backwards:
    // 0.4 (a weak SWE-bench score) vs. "strong" capability rating, which
    // ratingValue() would represent as 2 — if these were sorted on one axis,
    // the capability-only model would wrongly win.
    const benchmarked = makeModel({ name: "Weak SWE-bench", benchmarks: [bench("swe-bench-verified", 0.4)] });
    const capabilityOnly = makeModel({ name: "Strong capability only", capability: new Map([["coding", "strong"]]) });
    const { ranked } = rankRefactor([capabilityOnly, benchmarked]);
    assert.deepEqual(ranked.map((r) => r.model.name), ["Weak SWE-bench", "Strong capability only"]);
    assert.equal(ranked[0]!.scoreKind, "benchmark");
    assert.equal(ranked[1]!.scoreKind, "capability-rating");
  });

  test("a model with neither signal is unscored", () => {
    const { ranked, unscored } = rankRefactor([makeModel({ name: "Nothing" })]);
    assert.equal(ranked.length, 0);
    assert.equal(unscored.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 3.6 / 3.9 Fallback categories — autocomplete's inverted priority is the
// one most likely to regress silently, so it gets the deepest coverage.
// ---------------------------------------------------------------------------

describe("rankAutocomplete", () => {
  test("ranks primarily on capability_profile.speed, not on coding benchmark strength", () => {
    // A model with a stronger SWE-bench score but slower `speed` rating must
    // still lose to a faster model — this is the taxonomy's explicitly
    // inverted axis, the one bug that would be easy to introduce by copying
    // rankBugFix's pattern without re-reading the spec.
    const slowButStrongCoder = makeModel({
      name: "Slow strong coder",
      benchmarks: [bench("swe-bench-pro", 0.9)],
      capability: new Map([["speed", "weak"], ["coding", "strong"]]),
    });
    const fast = makeModel({
      name: "Fast",
      benchmarks: [bench("swe-bench-pro", 0.3)],
      capability: new Map([["speed", "strong"], ["coding", "weak"]]),
    });
    const { ranked } = rankAutocomplete([slowButStrongCoder, fast]);
    assert.deepEqual(ranked.map((r) => r.model.name), ["Fast", "Slow strong coder"]);
  });

  test("ties on speed break cheapest-price-first, then coding rating as a final tie-break only", () => {
    const a = makeModel({
      name: "A",
      capability: new Map([["speed", "strong"], ["coding", "weak"]]),
      inputPricePerM: 5,
    });
    const b = makeModel({
      name: "B",
      capability: new Map([["speed", "strong"], ["coding", "strong"]]),
      inputPricePerM: 1,
    });
    const { ranked } = rankAutocomplete([a, b]);
    // Same speed rating -> price decides (B cheaper), even though A has a
    // worse coding rating than B — coding is the LAST tie-break, not first.
    assert.deepEqual(ranked.map((r) => r.model.name), ["B", "A"]);
  });

  test("a model with no speed rating is unscored even if it has a coding rating", () => {
    const model = makeModel({ name: "No speed rating", capability: new Map([["coding", "strong"]]) });
    const { ranked, unscored } = rankAutocomplete([model]);
    assert.equal(ranked.length, 0);
    assert.equal(unscored.length, 1);
  });
});

describe("rankTestGen / rankDocGen — no-benchmark fallback categories", () => {
  test("test-gen ranks by capability_profile.coding, never by Aider Polyglot despite the shape looking similar", () => {
    const model = makeModel({
      name: "Aider-scored but not coding-rated",
      benchmarks: [bench("aider-polyglot", 0.95)],
    });
    const { ranked, unscored } = rankTestGen([model]);
    // The taxonomy is explicit that Aider Polyglot is the WRONG shape for
    // test-gen (inverse task) — a model scored only on Aider Polyglot, with
    // no capability_profile.coding rating, must NOT be ranked by that score.
    assert.equal(ranked.length, 0);
    assert.equal(unscored.length, 1);
  });

  test("doc-gen ranks by capability_profile.instruction-following", () => {
    const strong = makeModel({ name: "Strong writer", capability: new Map([["instruction-following", "strong"]]) });
    const weak = makeModel({ name: "Weak writer", capability: new Map([["instruction-following", "weak"]]) });
    const { ranked } = rankDocGen([weak, strong]);
    assert.deepEqual(ranked.map((r) => r.model.name), ["Strong writer", "Weak writer"]);
  });
});

// ---------------------------------------------------------------------------
// 3.10 Agentic multi-step — composite decomposition, not its own leaf metric
// ---------------------------------------------------------------------------

describe("rankAgenticMultiStep", () => {
  test("fans out each subtask to its own category's ranking rather than scoring the task holistically", () => {
    const bugFixSpecialist = makeModel({ name: "Bug-fix specialist", benchmarks: [bench("swe-bench-pro", 0.8)] });
    const docSpecialist = makeModel({ name: "Doc specialist", capability: new Map([["instruction-following", "strong"]]) });
    const models = [bugFixSpecialist, docSpecialist];

    const results = rankAgenticMultiStep(models, [
      { id: "step-1", category: "bug-fix" },
      { id: "step-2", category: "doc-gen" },
    ]);

    assert.equal(results.length, 2);
    const step1 = results.find((r) => r.subtaskId === "step-1")!;
    const step2 = results.find((r) => r.subtaskId === "step-2")!;
    assert.equal(step1.ranking.ranked[0]!.model.name, "Bug-fix specialist");
    assert.equal(step2.ranking.ranked[0]!.model.name, "Doc specialist");
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
        bench("aider-polyglot", 0.6),
        bench("terminal-bench-2-1", 0.6, { harness: "terminus-2" }),
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
