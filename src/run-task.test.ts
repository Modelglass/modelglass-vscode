/**
 * SCO-232 — tests for the pure route→execute orchestration core
 * (routeAndExecute), imported from ./run-task-lib.ts (the vscode-free half —
 * ./run-task.ts itself imports `vscode` for the command wrapper and can't
 * resolve outside the Extension Host). Same split convention as
 * lib.ts/task.ts and switch-check-lib.ts/switch-check.ts: the vscode command
 * wrapper (runTask, in run-task.ts) stays thin and untested directly,
 * matching this repo's "no Extension Host harness" convention (see
 * lib.test.ts's header / the absence of any @vscode/test-electron dependency
 * in package.json).
 *
 * executeFn is injected (a stub, never real fetch) — these tests exercise
 * routing + orchestration logic, not the HTTP adapters (see
 * provider-execute.test.ts for those).
 */

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  __resetFeedCacheForTests,
  FEED_CACHE_TTL_MS,
  fetchRoutableModels,
  routeAndExecute,
  routeAndExecuteWithFallback,
  type ConfiguredProviderKey,
} from "./run-task-lib.js";
import { ProviderExecutionError, type ExecuteResult } from "./provider-execute.js";
import type { RoutingRule } from "./routing-rules-lib.js";
import type { ModelEntry, RoutableModel } from "./routing-engine.js";

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

describe("routeAndExecute", () => {
  test("happy path: filters by provider, ranks, and executes against the top model", async () => {
    const openaiStrong = makeModel({
      name: "OpenAI Strong",
      provider: "openai",
      benchmarks: [bench("swe-bench-pro", 0.7)],
    });
    const openaiWeak = makeModel({
      name: "OpenAI Weak",
      provider: "openai",
      benchmarks: [bench("swe-bench-pro", 0.4)],
    });
    const anthropicOnly = makeModel({
      name: "Not This Provider",
      provider: "anthropic",
      benchmarks: [bench("swe-bench-pro", 0.99)],
    });

    const calls: Array<{ provider: string; apiKey: string; modelId: string; prompt: string }> = [];
    const stubExecute = async (provider: string, apiKey: string, modelId: string, prompt: string): Promise<ExecuteResult> => {
      calls.push({ provider, apiKey, modelId, prompt });
      return { text: "the fix is...", modelIdUsed: modelId };
    };

    const outcome = await routeAndExecute(
      [openaiWeak, anthropicOnly, openaiStrong],
      "openai",
      "sk-test",
      "bug-fix",
      "Fix the off-by-one in the paginator",
      stubExecute,
    );

    assert.equal(outcome.outcome, "success");
    assert.equal(outcome.outcome === "success" && outcome.topModel.name, "OpenAI Strong");
    assert.equal(outcome.outcome === "success" && outcome.rankedCount, 2); // only the two openai models
    assert.equal(outcome.outcome === "success" && outcome.execution.text, "the fix is...");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.provider, "openai");
    assert.equal(calls[0]!.apiKey, "sk-test");
    assert.equal(calls[0]!.modelId, openaiStrong.modelId);
    assert.equal(calls[0]!.prompt, "Fix the off-by-one in the paginator");
  });

  test("no models at all for the configured provider", async () => {
    const anthropicOnly = makeModel({ name: "Anthropic Model", provider: "anthropic", benchmarks: [bench("swe-bench-pro", 0.9)] });
    const stubExecute = async (): Promise<ExecuteResult> => {
      throw new Error("should never be called");
    };

    const outcome = await routeAndExecute([anthropicOnly], "openai", "sk-test", "bug-fix", "task", stubExecute);
    assert.equal(outcome.outcome, "no-provider-models");
  });

  test("provider has models but none carry scoring signal for the category", async () => {
    // test-gen falls back purely to capability_profile.coding — no capability set here, so unscored.
    const openaiNoSignal = makeModel({ name: "No Signal", provider: "openai" });
    const stubExecute = async (): Promise<ExecuteResult> => {
      throw new Error("should never be called");
    };

    const outcome = await routeAndExecute([openaiNoSignal], "openai", "sk-test", "test-gen", "write tests", stubExecute);
    assert.equal(outcome.outcome, "no-ranked-models");
  });

  test("invalid-key failure surfaces correctly with no retry attempted", async () => {
    const model = makeModel({ name: "Top Model", provider: "openai", benchmarks: [bench("swe-bench-pro", 0.7)] });

    let callCount = 0;
    const stubExecute = async (): Promise<ExecuteResult> => {
      callCount += 1;
      throw new ProviderExecutionError("invalid-key", "openai", "OpenAI rejected the API key (HTTP 401).");
    };

    const outcome = await routeAndExecute([model], "openai", "sk-bad", "bug-fix", "task", stubExecute);

    assert.equal(outcome.outcome, "execution-failed");
    assert.equal(outcome.outcome === "execution-failed" && outcome.error.kind, "invalid-key");
    assert.equal(outcome.outcome === "execution-failed" && outcome.topModel.name, "Top Model");
    // The whole point of the no-retry contract: exactly one execution attempt.
    assert.equal(callCount, 1);
  });

  test("SCO-231: a routing rule changes which model actually gets executed", async () => {
    const benchmarkWinner = makeModel({
      name: "BenchmarkWinner",
      provider: "openai",
      benchmarks: [bench("swe-bench-pro", 0.9)],
      inputPricePerM: 20,
    });
    const ruleWinner = makeModel({
      name: "RuleWinner",
      provider: "openai",
      benchmarks: [bench("swe-bench-pro", 0.5)],
      inputPricePerM: 1,
    });

    const calls: string[] = [];
    const stubExecute = async (_p: string, _k: string, modelId: string): Promise<ExecuteResult> => {
      calls.push(modelId);
      return { text: "done", modelIdUsed: modelId };
    };

    // Without a rule, the benchmark-stronger (but pricier) model wins.
    const withoutRule = await routeAndExecute(
      [benchmarkWinner, ruleWinner],
      "openai",
      "sk-test",
      "bug-fix",
      "task",
      stubExecute,
    );
    assert.equal(withoutRule.outcome === "success" && withoutRule.topModel.name, "BenchmarkWinner");
    assert.equal(withoutRule.outcome === "success" && withoutRule.ruleApplied, false);

    // With a "cheapest" override rule for bug-fix, the cheaper model wins instead.
    const rule: RoutingRule = { category: "bug-fix", strategy: "cheapest" };
    const withRule = await routeAndExecute(
      [benchmarkWinner, ruleWinner],
      "openai",
      "sk-test",
      "bug-fix",
      "task",
      stubExecute,
      rule,
    );
    assert.equal(withRule.outcome === "success" && withRule.topModel.name, "RuleWinner");
    assert.equal(withRule.outcome === "success" && withRule.ruleApplied, true);

    assert.deepEqual(calls, [benchmarkWinner.modelId, ruleWinner.modelId]);
  });

  test("a non-ProviderExecutionError thrown by executeFn is wrapped, not left uncaught", async () => {
    const model = makeModel({ name: "Top Model", provider: "openai", benchmarks: [bench("swe-bench-pro", 0.7)] });
    const stubExecute = async (): Promise<ExecuteResult> => {
      throw new Error("unexpected boom");
    };

    const outcome = await routeAndExecute([model], "openai", "sk-test", "bug-fix", "task", stubExecute);
    assert.equal(outcome.outcome, "execution-failed");
    assert.equal(outcome.outcome === "execution-failed" && outcome.error.kind, "provider-error");
    assert.match(outcome.outcome === "execution-failed" ? outcome.error.message : "", /unexpected boom/);
  });
});

// ---------------------------------------------------------------------------
// SCO-233 (Pro) — multi-key fallback chain. routeAndExecuteWithFallback calls
// routeAndExecute internally (unchanged, see the suite above); these tests
// exercise the chain-building/fallback/cap logic on top of it.
// ---------------------------------------------------------------------------

describe("routeAndExecuteWithFallback", () => {
  function rateLimited(provider: string) {
    return new ProviderExecutionError("rate-limited", provider, `${provider} is rate-limiting this key (HTTP 429).`);
  }

  test("a first-provider failure correctly falls back to the second", async () => {
    const openaiModel = makeModel({ name: "OpenAIModel", provider: "openai", benchmarks: [bench("swe-bench-pro", 0.9)] });
    const anthropicModel = makeModel({
      name: "AnthropicModel",
      provider: "anthropic",
      benchmarks: [bench("swe-bench-pro", 0.5)],
    });

    const calls: string[] = [];
    const stubExecute = async (provider: string, _k: string, modelId: string): Promise<ExecuteResult> => {
      calls.push(provider);
      if (provider === "openai") throw rateLimited("openai");
      return { text: "done", modelIdUsed: modelId };
    };

    const configured: ConfiguredProviderKey[] = [
      { provider: "openai", apiKey: "sk-openai" },
      { provider: "anthropic", apiKey: "sk-anthropic" },
    ];

    const result = await routeAndExecuteWithFallback(
      [openaiModel, anthropicModel],
      configured,
      "bug-fix",
      "task",
      stubExecute,
    );

    assert.equal(result.outcome, "success");
    assert.equal(result.outcome === "success" && result.topModel.name, "AnthropicModel");
    assert.equal(result.outcome === "success" && result.attempts.length, 2);
    assert.deepEqual(calls, ["openai", "anthropic"]); // openai (ranked #1, benchmark-stronger) tried first, then anthropic
  });

  test("never retries the same provider that just failed — advances to a different provider, not a second model on the same one", async () => {
    // Two openai models (one ranked above the other) plus one anthropic model.
    const openaiTop = makeModel({ name: "OpenAITop", provider: "openai", benchmarks: [bench("swe-bench-pro", 0.9)] });
    const openaiSecond = makeModel({ name: "OpenAISecond", provider: "openai", benchmarks: [bench("swe-bench-pro", 0.8)] });
    const anthropicModel = makeModel({ name: "AnthropicModel", provider: "anthropic", benchmarks: [bench("swe-bench-pro", 0.5)] });

    const calls: string[] = [];
    const stubExecute = async (provider: string, _k: string, modelId: string): Promise<ExecuteResult> => {
      calls.push(modelId);
      if (provider === "openai") throw rateLimited("openai"); // key-level failure -- would fail identically for ANY openai model
      return { text: "done", modelIdUsed: modelId };
    };

    const configured: ConfiguredProviderKey[] = [
      { provider: "openai", apiKey: "sk-openai" },
      { provider: "anthropic", apiKey: "sk-anthropic" },
    ];

    const result = await routeAndExecuteWithFallback(
      [openaiTop, openaiSecond, anthropicModel],
      configured,
      "bug-fix",
      "task",
      stubExecute,
    );

    assert.equal(result.outcome, "success");
    // Exactly one openai attempt (its top-ranked model), never openaiSecond.
    assert.deepEqual(calls, [openaiTop.modelId, anthropicModel.modelId]);
  });

  test("the attempt cap is respected — no more than one attempt per configured provider, ever", async () => {
    const models = [
      makeModel({ name: "A", provider: "openai", benchmarks: [bench("swe-bench-pro", 0.9)] }),
      makeModel({ name: "B", provider: "anthropic", benchmarks: [bench("swe-bench-pro", 0.8)] }),
      makeModel({ name: "C", provider: "groq", benchmarks: [bench("swe-bench-pro", 0.7)] }),
    ];
    const configured: ConfiguredProviderKey[] = [
      { provider: "openai", apiKey: "key-a" },
      { provider: "anthropic", apiKey: "key-b" },
      { provider: "groq", apiKey: "key-c" },
    ];

    let callCount = 0;
    const stubExecute = async (provider: string): Promise<ExecuteResult> => {
      callCount += 1;
      throw rateLimited(provider);
    };

    const result = await routeAndExecuteWithFallback(models, configured, "bug-fix", "task", stubExecute);

    assert.equal(result.outcome, "all-providers-failed");
    assert.equal(callCount, 3); // exactly one attempt per configured provider, no more
    assert.equal(result.outcome === "all-providers-failed" && result.attempts.length, 3);
  });

  test("final-failure case: every configured provider fails", async () => {
    const models = [
      makeModel({ name: "A", provider: "openai", benchmarks: [bench("swe-bench-pro", 0.9)] }),
      makeModel({ name: "B", provider: "anthropic", benchmarks: [bench("swe-bench-pro", 0.5)] }),
    ];
    const configured: ConfiguredProviderKey[] = [
      { provider: "openai", apiKey: "key-a" },
      { provider: "anthropic", apiKey: "key-b" },
    ];

    const stubExecute = async (provider: string): Promise<ExecuteResult> => {
      throw new ProviderExecutionError("invalid-key", provider, `${provider} rejected the key.`);
    };

    const result = await routeAndExecuteWithFallback(models, configured, "bug-fix", "task", stubExecute);

    assert.equal(result.outcome, "all-providers-failed");
    assert.equal(result.outcome === "all-providers-failed" && result.attempts.length, 2);
    assert.ok(
      result.outcome === "all-providers-failed" &&
        result.attempts.every((a) => a.result.outcome === "execution-failed"),
    );
  });

  test("no configured providers at all", async () => {
    const model = makeModel({ name: "Solo", provider: "openai" });
    const result = await routeAndExecuteWithFallback([model], [], "bug-fix", "task", async () => {
      throw new Error("should never be called");
    });
    assert.equal(result.outcome, "no-configured-providers");
  });

  test("a single configured provider behaves exactly like SCO-232's original one-shot flow", async () => {
    const model = makeModel({ name: "Solo", provider: "openai", benchmarks: [bench("swe-bench-pro", 0.7)] });
    let callCount = 0;
    const stubExecute = async (): Promise<ExecuteResult> => {
      callCount += 1;
      throw new ProviderExecutionError("invalid-key", "openai", "bad key");
    };

    const result = await routeAndExecuteWithFallback(
      [model],
      [{ provider: "openai", apiKey: "sk-bad" }],
      "bug-fix",
      "task",
      stubExecute,
    );

    assert.equal(result.outcome, "all-providers-failed");
    assert.equal(callCount, 1); // exactly one attempt -- no fallback possible with only one provider configured
  });
});

// ---------------------------------------------------------------------------
// SCO-264 — the local feed cache. fetchFn/nowFn are injected so these tests
// never touch real network or wall-clock time (same convention as
// executeFn above); __resetFeedCacheForTests keeps the module-level cache
// from leaking state between tests in this file.
// ---------------------------------------------------------------------------

describe("fetchRoutableModels — feed cache (SCO-264)", () => {
  beforeEach(() => {
    __resetFeedCacheForTests();
  });

  function entry(name: string): ModelEntry {
    return { model_id: `test/${name}`, name, offerings: [] };
  }

  test("a second call within the TTL is served from cache — no refetch", async () => {
    let calls = 0;
    const fetchFn = async (): Promise<ModelEntry[]> => {
      calls += 1;
      return [entry("Model A")];
    };
    let now = 1_000_000;

    const first = await fetchRoutableModels("key", fetchFn, () => now);
    now += 1_000; // well inside FEED_CACHE_TTL_MS
    const second = await fetchRoutableModels("key", fetchFn, () => now);

    assert.equal(calls, 1);
    assert.deepEqual(second, first);
  });

  test("a call after the TTL elapses refetches", async () => {
    let calls = 0;
    const fetchFn = async (): Promise<ModelEntry[]> => {
      calls += 1;
      return [entry(`Model ${calls}`)];
    };
    let now = 1_000_000;

    await fetchRoutableModels("key", fetchFn, () => now);
    now += FEED_CACHE_TTL_MS + 1;
    await fetchRoutableModels("key", fetchFn, () => now);

    assert.equal(calls, 2);
  });

  test("a fetch failure after a prior success falls back to the last cached feed instead of failing the run", async () => {
    let now = 1_000_000;
    const primed = await fetchRoutableModels("key", async () => [entry("Cached Model")], () => now);

    now += FEED_CACHE_TTL_MS + 1; // force the cache stale so the next call attempts a real refetch
    const failingFetch = async (): Promise<ModelEntry[]> => {
      throw new Error("Modelglass API 503");
    };
    const messages: string[] = [];
    const served = await fetchRoutableModels("key", failingFetch, () => now, (m) => messages.push(m));

    assert.deepEqual(served, primed);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /couldn't refresh/i);
  });

  test("a fetch failure with nothing cached yet still throws — no stale copy to fall back to", async () => {
    const failingFetch = async (): Promise<ModelEntry[]> => {
      throw new Error("Modelglass API 503");
    };
    await assert.rejects(() => fetchRoutableModels("key", failingFetch), /Modelglass API 503/);
  });
});
