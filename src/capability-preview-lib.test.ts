/**
 * SCO-263 — tests for the setup-time capability preview. Pure module (no
 * vscode import), same testing convention as run-task-lib.ts's tests: real
 * RoutableModel fixtures through the real rankModelsForCategory, no stubs —
 * this is exactly the calculation Run Task itself does, just surfaced
 * earlier.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  previewProviderCapabilities,
  summarizeCapabilityPreview,
  previewCombinedCapabilities,
  summarizeCombinedCapabilityPreview,
  formatCategoryLines,
} from "./capability-preview-lib.js";
import type { RoutableModel } from "./routing-engine.js";

function makeModel(overrides: Partial<RoutableModel> & { name: string; provider: string }): RoutableModel {
  return {
    slug: overrides.name.toLowerCase().replace(/\s+/g, "-"),
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

describe("previewProviderCapabilities", () => {
  test("a provider with no models at all in the feed: noModelsForProvider, every category zero", () => {
    const anthropicOnly = makeModel({ name: "Claude", provider: "anthropic", benchmarks: [bench("swe-bench-pro", 0.9)] });

    const preview = previewProviderCapabilities([anthropicOnly], "groq");

    assert.equal(preview.noModelsForProvider, true);
    assert.equal(preview.routable.length, 0);
    assert.equal(preview.zeroRoutable.length, preview.categories.length);
  });

  test("a provider with models but no scoring signal for a specific category — that category shows zero, others can still route", () => {
    // bug-fix scores via SWE-bench; test-gen falls back purely to
    // capability_profile.coding, which this model doesn't set — so it's
    // routable for bug-fix but not test-gen.
    const model = makeModel({ name: "Groq Model", provider: "groq", benchmarks: [bench("swe-bench-pro", 0.6)] });

    const preview = previewProviderCapabilities([model], "groq");

    assert.equal(preview.noModelsForProvider, false);
    const bugFix = preview.categories.find((c) => c.category === "bug-fix")!;
    const testGen = preview.categories.find((c) => c.category === "test-gen")!;
    assert.equal(bugFix.routableCount, 1);
    assert.equal(testGen.routableCount, 0);
    assert.ok(preview.zeroRoutable.some((c) => c.category === "test-gen"));
    assert.ok(preview.routable.some((c) => c.category === "bug-fix"));
  });

  test("a provider that's only ever filtered to its own models — another provider's strong models don't leak in", () => {
    const openaiStrong = makeModel({ name: "OpenAI Strong", provider: "openai", benchmarks: [bench("swe-bench-pro", 0.95)] });
    const groqWeak = makeModel({ name: "Groq Weak", provider: "groq", benchmarks: [bench("swe-bench-pro", 0.3)] });

    const preview = previewProviderCapabilities([openaiStrong, groqWeak], "groq");

    const bugFix = preview.categories.find((c) => c.category === "bug-fix")!;
    assert.equal(bugFix.routableCount, 1); // only groqWeak, never openaiStrong
  });

  test("fully covered provider: every category routable, zeroRoutable is empty", () => {
    // Give this one model every signal every category needs, so nothing is unscored.
    const fullyCovered = makeModel({
      name: "Covers Everything",
      provider: "openai",
      benchmarks: [
        bench("swe-bench-pro", 0.9),
        bench("aider-polyglot", 0.8),
        bench("terminal-bench-2-1", 0.7),
        bench("bigcodebench", 0.6),
      ],
      capability: new Map([
        ["coding", "strong"],
        ["instruction-following", "strong"],
        ["speed", "strong"],
      ]),
    });
    // terminal-cli only accepts the terminus-2 harness — add that explicitly.
    fullyCovered.benchmarks[2] = { ...fullyCovered.benchmarks[2]!, harness: "terminus-2" };

    const preview = previewProviderCapabilities([fullyCovered], "openai");

    assert.equal(preview.zeroRoutable.length, 0);
    assert.equal(preview.routable.length, preview.categories.length);
  });
});

describe("summarizeCapabilityPreview", () => {
  test("no models for the provider at all", () => {
    const preview = previewProviderCapabilities([], "mistral");
    assert.match(summarizeCapabilityPreview(preview), /no models for this provider/i);
  });

  test("partial coverage names the uncovered categories", () => {
    const model = makeModel({ name: "M", provider: "deepseek", benchmarks: [bench("swe-bench-pro", 0.5)] });
    const preview = previewProviderCapabilities([model], "deepseek");
    const summary = summarizeCapabilityPreview(preview);
    assert.match(summary, /of 9 task categories/);
    assert.match(summary, /no routable models yet for/i);
  });
});

describe("formatCategoryLines", () => {
  test("one line per category, with a model count or 'none routable'", () => {
    const model = makeModel({ name: "M", provider: "openai", benchmarks: [bench("swe-bench-pro", 0.5)] });
    const preview = previewProviderCapabilities([model], "openai");
    const lines = formatCategoryLines(preview);

    assert.equal(lines.length, preview.categories.length);
    assert.ok(lines.some((l) => l.includes("1 model(s)")));
    assert.ok(lines.some((l) => l.includes("none routable")));
  });

  test("SCO-272: a zero-routable library-aware-feature-work line notes the gap is industry-wide, not Modelglass-specific", () => {
    const model = makeModel({ name: "M", provider: "openai", benchmarks: [bench("swe-bench-pro", 0.5)] });
    const preview = previewProviderCapabilities([model], "openai");
    const lines = formatCategoryLines(preview);

    const libraryLine = lines.find((l) => l.startsWith("Library-aware feature work:"))!;
    assert.match(libraryLine, /none routable/);
    assert.match(libraryLine, /not just here/i);
  });

  test("a different zero-routable category (no industry-wide note defined) stays plain — no note text leaks onto it", () => {
    const model = makeModel({ name: "M", provider: "openai", benchmarks: [bench("swe-bench-pro", 0.5)] });
    const preview = previewProviderCapabilities([model], "openai");
    const lines = formatCategoryLines(preview);

    const testGenLine = lines.find((l) => l.startsWith("Test generation:"))!;
    assert.equal(testGenLine, "Test generation: none routable");
  });
});

// ---------------------------------------------------------------------------
// SCO-302 — combined fallback-chain coverage across every configured
// provider, additive to SCO-263's single-key preview above.
// ---------------------------------------------------------------------------

describe("previewCombinedCapabilities", () => {
  test("first key ever (a single configured provider): combined coverage is identical to that provider's own preview — nothing to combine yet", () => {
    const model = makeModel({ name: "Groq Model", provider: "groq", benchmarks: [bench("swe-bench-pro", 0.6)] });
    const single = previewProviderCapabilities([model], "groq");
    const combined = previewCombinedCapabilities([model], ["groq"]);

    assert.equal(combined.routable.length, single.routable.length);
    assert.equal(combined.zeroRoutable.length, single.zeroRoutable.length);
    // Caller-side gating (provider-keys.ts) skips showing this case at all —
    // this test just confirms the computation itself has no surprise
    // divergence from the single-key result if it WERE called.
  });

  test("second key fills a gap the first key alone had", () => {
    // Groq alone: routable for bug-fix (SWE-bench Pro), nothing else.
    // OpenAI alone: only test-gen routable (capability_profile.coding), not bug-fix.
    // Combined: both bug-fix AND test-gen resolved, neither alone had both.
    const groqModel = makeModel({ name: "Groq Model", provider: "groq", benchmarks: [bench("swe-bench-pro", 0.6)] });
    const openaiModel = makeModel({
      name: "OpenAI Model",
      provider: "openai",
      capability: new Map([["coding", "strong"]]),
    });

    const groqAlone = previewProviderCapabilities([groqModel, openaiModel], "groq");
    assert.ok(groqAlone.zeroRoutable.some((c) => c.category === "test-gen"));

    const combined = previewCombinedCapabilities([groqModel, openaiModel], ["groq", "openai"]);
    const bugFix = combined.categories.find((c) => c.category === "bug-fix")!;
    const testGen = combined.categories.find((c) => c.category === "test-gen")!;
    assert.equal(bugFix.routableCount, 1); // groqModel
    assert.equal(testGen.routableCount, 1); // openaiModel — a gap groqAlone had
    assert.ok(!combined.zeroRoutable.some((c) => c.category === "test-gen"));
  });

  test("second key adds no improvement — the first key already covered everything the second one would", () => {
    const strongOpenAi = makeModel({
      name: "Strong OpenAI",
      provider: "openai",
      benchmarks: [bench("swe-bench-pro", 0.9)],
      capability: new Map([["coding", "strong"]]),
    });
    const weakerGroq = makeModel({ name: "Weaker Groq", provider: "groq", benchmarks: [bench("swe-bench-pro", 0.3)] });

    const openaiAlone = previewProviderCapabilities([strongOpenAi, weakerGroq], "openai");
    const combined = previewCombinedCapabilities([strongOpenAi, weakerGroq], ["openai", "groq"]);

    // Adding Groq doesn't shrink zeroRoutable further than OpenAI alone already achieved.
    assert.equal(combined.zeroRoutable.length, openaiAlone.zeroRoutable.length);
    const bugFix = combined.categories.find((c) => c.category === "bug-fix")!;
    assert.equal(bugFix.routableCount, 2); // both still rank, just no NEW category unlocked
  });

  test("fully-zero-coverage combined case: neither configured provider has any scoring signal, still zero across the board", () => {
    const bareGroq = makeModel({ name: "Bare Groq", provider: "groq" });
    const bareMistral = makeModel({ name: "Bare Mistral", provider: "mistral" });

    const combined = previewCombinedCapabilities([bareGroq, bareMistral], ["groq", "mistral"]);

    assert.equal(combined.routable.length, 0);
    assert.equal(combined.zeroRoutable.length, combined.categories.length);
  });
});

describe("summarizeCombinedCapabilityPreview", () => {
  test("full combined coverage reads as resolved, not a warning", () => {
    const fullyCovered = makeModel({
      name: "Covers Everything",
      provider: "openai",
      benchmarks: [
        bench("swe-bench-pro", 0.9),
        bench("aider-polyglot", 0.8),
        bench("terminal-bench-2-1", 0.7),
        bench("bigcodebench", 0.6),
      ],
      capability: new Map([
        ["coding", "strong"],
        ["instruction-following", "strong"],
        ["speed", "strong"],
      ]),
    });
    fullyCovered.benchmarks[2] = { ...fullyCovered.benchmarks[2]!, harness: "terminus-2" };

    const combined = previewCombinedCapabilities([fullyCovered], ["openai"]);
    assert.match(summarizeCombinedCapabilityPreview(combined), /routable for all \d+ task categories/);
  });

  test("partial combined coverage names the still-uncovered categories", () => {
    const groqModel = makeModel({ name: "Groq Model", provider: "groq", benchmarks: [bench("swe-bench-pro", 0.6)] });
    const combined = previewCombinedCapabilities([groqModel], ["groq"]);
    const summary = summarizeCombinedCapabilityPreview(combined);
    assert.match(summary, /of \d+ task categories/);
    assert.match(summary, /still no routable models for/i);
  });
});
