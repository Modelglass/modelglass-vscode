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

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { routeAndExecute } from "./run-task-lib.js";
import { ProviderExecutionError, type ExecuteResult } from "./provider-execute.js";
import type { RoutingRule } from "./routing-rules-lib.js";
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
