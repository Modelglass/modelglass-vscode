/**
 * SCO-331 — tests for the pure half of the vscode.lm provider registration.
 * Same conventions as run-task.test.ts: a stub RoutableModel factory, plain
 * node:test/assert, no vscode import anywhere here or in the module under
 * test.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  PSEUDO_MODEL_PREFIX,
  approximateTokenCount,
  buildPseudoModels,
  categoryForPseudoModelId,
  describeChatOutcome,
  pseudoModelId,
  toChatMessages,
} from "./lm-provider-lib.js";
import { LEAF_CATEGORIES, type ProviderAttempt } from "./run-task-lib.js";
import { ProviderExecutionError, type ExecuteResult } from "./provider-execute.js";
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

describe("pseudoModelId / categoryForPseudoModelId", () => {
  test("round-trips every leaf category", () => {
    for (const category of LEAF_CATEGORIES) {
      const id = pseudoModelId(category);
      assert.ok(id.startsWith(PSEUDO_MODEL_PREFIX));
      assert.equal(categoryForPseudoModelId(id), category);
    }
  });

  test("a completely unrelated id is not mistaken for one of ours", () => {
    assert.equal(categoryForPseudoModelId("gpt-5.5"), undefined);
    assert.equal(categoryForPseudoModelId("anthropic/claude-sonnet-5"), undefined);
  });

  test("a prefixed but bogus suffix is rejected, not silently coerced", () => {
    assert.equal(categoryForPseudoModelId(`${PSEUDO_MODEL_PREFIX}not-a-real-category`), undefined);
  });
});

describe("buildPseudoModels", () => {
  test("produces exactly one entry per leaf category, in taxonomy order", () => {
    const models = buildPseudoModels([], ["openai"]);
    assert.equal(models.length, LEAF_CATEGORIES.length);
    assert.deepEqual(
      models.map((m) => m.category),
      [...LEAF_CATEGORIES],
    );
  });

  test("a category with a routable model reports a positive count and no gap warning", () => {
    const strong = makeModel({ name: "Strong", provider: "openai", benchmarks: [bench("swe-bench-pro", 0.8)] });
    const models = buildPseudoModels([strong], ["openai"]);
    const bugFix = models.find((m) => m.category === "bug-fix")!;
    assert.equal(bugFix.routableCount, 1);
    assert.match(bugFix.description, /top-ranked of 1 model/);
  });

  test("SCO-332: a genuinely dead category (no configured provider has any signal) is annotated as zero-routable", () => {
    // No models supplied at all -- every category is zero-routable.
    const models = buildPseudoModels([], ["openai"]);
    const bugFix = models.find((m) => m.category === "bug-fix")!;
    assert.equal(bugFix.routableCount, 0);
    assert.match(bugFix.description, /No routable model for your configured provider/);
  });

  test("SCO-332: library-aware-feature-work carries the industry-wide-gap note when zero-routable", () => {
    const models = buildPseudoModels([], ["openai"]);
    const libraryAware = models.find((m) => m.category === "library-aware-feature-work")!;
    assert.equal(libraryAware.routableCount, 0);
    assert.match(libraryAware.description, /no current-gen model anywhere has a published score/);
  });

  test("only configured providers' models count -- an unconfigured provider's strong model doesn't make a category look routable", () => {
    const anthropicOnly = makeModel({
      name: "Anthropic Strong",
      provider: "anthropic",
      benchmarks: [bench("swe-bench-pro", 0.9)],
    });
    const models = buildPseudoModels([anthropicOnly], ["openai"]); // configured: openai, not anthropic
    const bugFix = models.find((m) => m.category === "bug-fix")!;
    assert.equal(bugFix.routableCount, 0);
  });

  test("every pseudo-model id is prefixed and its name/description reference the category label", () => {
    const models = buildPseudoModels([], ["openai"]);
    for (const m of models) {
      assert.ok(m.id.startsWith(PSEUDO_MODEL_PREFIX));
      assert.ok(m.name.startsWith("Modelglass: "));
    }
  });
});

describe("toChatMessages", () => {
  test("maps role/text onto role/content, preserving order and every role", () => {
    const result = toChatMessages([
      { role: "system", text: "You are helpful." },
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
      { role: "user", text: "how are you?" },
    ]);
    assert.deepEqual(result, [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you?" },
    ]);
  });

  test("an empty conversation maps to an empty array, not an error", () => {
    assert.deepEqual(toChatMessages([]), []);
  });
});

describe("approximateTokenCount", () => {
  test("roughly 4 chars per token, rounded up", () => {
    assert.equal(approximateTokenCount("abcd"), 1);
    assert.equal(approximateTokenCount("abcde"), 2);
    assert.equal(approximateTokenCount(""), 0);
  });
});

describe("describeChatOutcome", () => {
  test("no-configured-providers points at the setup command", () => {
    const result = describeChatOutcome({ outcome: "no-configured-providers", category: "bug-fix" }, "Bug fix / debug");
    assert.equal(result.kind, "error");
    assert.match(result.text, /Set Provider API Key/);
  });

  test("no-ranked-models names the category", () => {
    const result = describeChatOutcome({ outcome: "no-ranked-models", category: "test-gen" }, "Test generation");
    assert.equal(result.kind, "error");
    assert.match(result.text, /Test generation/);
  });

  test("all-providers-failed summarises every attempt", () => {
    const attempts: ProviderAttempt[] = [
      {
        provider: "openai",
        result: {
          outcome: "execution-failed",
          category: "bug-fix",
          topModel: makeModel({ name: "M", provider: "openai" }),
          error: new ProviderExecutionError("invalid-key", "openai", "OpenAI rejected the API key (HTTP 401)."),
        },
      },
    ];
    const result = describeChatOutcome(
      { outcome: "all-providers-failed", category: "bug-fix", attempts },
      "Bug fix / debug",
    );
    assert.equal(result.kind, "error");
    assert.match(result.text, /openai: your stored openai key was rejected/);
  });

  test("success returns the execution text plus a Modelglass attribution footer, no fallback note for a single attempt", () => {
    const execution: ExecuteResult = { text: "Here's the fix.", modelIdUsed: "gpt-5.5" };
    const outcome = {
      outcome: "success" as const,
      category: "bug-fix" as const,
      topModel: makeModel({ name: "GPT-5.5", provider: "openai" }),
      rankedCount: 3,
      execution,
      ruleApplied: false,
      scoreLabel: "SWE-bench Pro 70.0%",
      unmatchedPriorityIds: [],
      excludedCount: 0,
      attempts: [{ provider: "openai" as const, result: { outcome: "success" as const } as never }],
    };
    const result = describeChatOutcome(outcome, "Bug fix / debug");
    assert.equal(result.kind, "success");
    assert.match(result.text, /^Here's the fix\./);
    assert.match(result.text, /Bug fix \/ debug → GPT-5\.5, selected on SWE-bench Pro 70\.0%/);
    assert.ok(!result.text.includes("fallback"));
  });

  test("success with more than one attempt notes the fallback count", () => {
    const execution: ExecuteResult = { text: "Done.", modelIdUsed: "claude-sonnet-5" };
    const outcome = {
      outcome: "success" as const,
      category: "bug-fix" as const,
      topModel: makeModel({ name: "Claude Sonnet 5", provider: "anthropic" }),
      rankedCount: 1,
      execution,
      ruleApplied: false,
      scoreLabel: "SWE-bench Pro 50.0%",
      unmatchedPriorityIds: [],
      excludedCount: 0,
      attempts: [
        { provider: "openai" as const, result: {} as never },
        { provider: "anthropic" as const, result: {} as never },
      ],
    };
    const result = describeChatOutcome(outcome, "Bug fix / debug");
    assert.match(result.text, /after 1 provider fallback/);
  });

  test("success with a routing-rules.json override notes it", () => {
    const execution: ExecuteResult = { text: "Done.", modelIdUsed: "m" };
    const outcome = {
      outcome: "success" as const,
      category: "bug-fix" as const,
      topModel: makeModel({ name: "M", provider: "openai" }),
      rankedCount: 1,
      execution,
      ruleApplied: true,
      scoreLabel: "cheapest",
      unmatchedPriorityIds: [],
      excludedCount: 0,
      attempts: [{ provider: "openai" as const, result: {} as never }],
    };
    const result = describeChatOutcome(outcome, "Bug fix / debug");
    assert.match(result.text, /routing-rules\.json override applied/);
  });
});
