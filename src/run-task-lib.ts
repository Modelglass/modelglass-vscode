import {
  fetchLLMModels,
  normalise,
  type LeafTaskCategory,
  type RoutableModel,
} from "./routing-engine.js";
import { executeProviderCall, ProviderExecutionError, type ExecuteResult } from "./provider-execute.js";
import type { SupportedProvider } from "./provider-keys-lib.js";
import { resolveCategoryRanking, type RoutingRule } from "./routing-rules-lib.js";

/**
 * SCO-232 — Starter tier: single-key setup + fixed routing. Pure half (no
 * `vscode` import — same lib/non-lib split as lib.ts/task.ts and
 * switch-check-lib.ts/switch-check.ts) so it's directly unit-testable; the
 * vscode-coupled command wrapper lives in ./run-task.ts.
 *
 * Modelglass-default rules only (SCO-230's rankModelsForCategory, unmodified
 * — no awkwardness found calling it from here: `RoutableModel.provider` is
 * already populated by routing-engine.ts's own `normalise()`, so filtering
 * to the configured provider before ranking is a plain `.filter()`, nothing
 * more). No user override/weighting (SCO-231) and no multi-key/fallback
 * chains (SCO-233) — deliberately not built here, per the card's explicit
 * instruction not to add hooks inviting either even where the code would
 * make it tempting (e.g. `routeAndExecute` takes exactly one provider + one
 * key, not an array).
 *
 * `agentic-multi-step` (the composite, decomposition-requiring category) is
 * intentionally out of scope here — SCO-230 itself treats it as "fan a
 * subtask list out to the nine leaf rankers," which needs its own
 * subtask-decomposition UI (a bigger surface, same "deferred" reasoning
 * task.ts's own header already gives for not reproducing the CLI's full
 * multi-subtask flow). This module routes and executes ONE task against ONE
 * of the nine leaf categories.
 */

export const CATEGORY_LABELS: Record<LeafTaskCategory, string> = {
  "bug-fix": "Bug fix / debug",
  "new-code-generation": "New code generation (spec → code)",
  "terminal-cli": "Terminal / CLI / DevOps",
  "library-aware-feature-work": "Library-aware feature work",
  refactor: "Refactor",
  "test-gen": "Test generation",
  "doc-gen": "Documentation generation",
  "chat-explain": "Chat / explain",
  autocomplete: "Autocomplete",
};

export const LEAF_CATEGORIES = Object.keys(CATEGORY_LABELS) as LeafTaskCategory[];

export type RouteAndExecuteOutcome =
  | {
      outcome: "success";
      category: LeafTaskCategory;
      topModel: RoutableModel;
      rankedCount: number;
      execution: ExecuteResult;
      /** SCO-231 — whether a .modelglass/routing-rules.json rule changed
       *  this category's ranking (vs. SCO-230's default engine, untouched). */
      ruleApplied: boolean;
    }
  | {
      outcome: "no-provider-models";
      category: LeafTaskCategory;
      provider: SupportedProvider;
    }
  | {
      outcome: "no-ranked-models";
      category: LeafTaskCategory;
      provider: SupportedProvider;
    }
  | {
      outcome: "execution-failed";
      category: LeafTaskCategory;
      topModel: RoutableModel;
      error: ProviderExecutionError;
    };

export type ExecuteFn = (
  provider: SupportedProvider,
  apiKey: string,
  modelId: string,
  prompt: string,
) => Promise<ExecuteResult>;

/**
 * Filters the model pool to the configured provider, ranks by SCO-230's
 * rankModelsForCategory — or, if `rule` is supplied (SCO-231), by
 * resolveCategoryRanking's rule-composed ranking, which falls through to
 * the exact same default engine when the rule doesn't fully override this
 * category — and executes the call against the top-ranked model.
 * `executeFn` is injectable (defaults to the real provider-execute.ts
 * adapter) so tests can supply a stub — no live network call, no live key
 * needed to exercise this path.
 *
 * `rule` defaults to undefined, so every existing SCO-232 call site/test
 * (no rule argument) behaves identically to before SCO-231 — passing
 * undefined through resolveCategoryRanking is defined to be exactly
 * rankModelsForCategory, unmodified.
 *
 * Starter's no-retry failure contract (ADR-0012) lives here: on an
 * execution failure, this returns a single "execution-failed" outcome and
 * does NOT attempt a second model or a second call — one attempt per
 * invocation, full stop. The caller (the vscode command in run-task.ts)
 * surfaces it; nothing here loops. (No Pro-tier gating on rule application
 * itself — SCO-234's scope, not this card's; see run-task.ts's header.)
 */
export async function routeAndExecute(
  allModels: RoutableModel[],
  provider: SupportedProvider,
  providerApiKey: string,
  category: LeafTaskCategory,
  prompt: string,
  executeFn: ExecuteFn = executeProviderCall,
  rule?: RoutingRule,
): Promise<RouteAndExecuteOutcome> {
  const providerModels = allModels.filter((m) => m.provider === provider);
  if (providerModels.length === 0) {
    return { outcome: "no-provider-models", category, provider };
  }

  const ranking = resolveCategoryRanking(providerModels, category, rule);
  const top = ranking.ranked[0];
  if (!top) {
    return { outcome: "no-ranked-models", category, provider };
  }

  try {
    const execution = await executeFn(provider, providerApiKey, top.model.modelId, prompt);
    return {
      outcome: "success",
      category,
      topModel: top.model,
      rankedCount: ranking.ranked.length,
      execution,
      ruleApplied: ranking.ruleApplied,
    };
  } catch (e) {
    const error =
      e instanceof ProviderExecutionError
        ? e
        : new ProviderExecutionError("provider-error", provider, e instanceof Error ? e.message : String(e));
    return { outcome: "execution-failed", category, topModel: top.model, error };
  }
}

export function describeFailure(error: ProviderExecutionError): string {
  switch (error.kind) {
    case "invalid-key":
      return `your stored ${error.provider} key was rejected (invalid or revoked)`;
    case "rate-limited":
      return `${error.provider} is rate-limiting this key right now`;
    case "network-error":
      return `couldn't reach ${error.provider} (${error.message})`;
    case "unsupported-provider":
      return `no execution adapter exists yet for ${error.provider}`;
    case "provider-error":
      return `${error.provider} returned an error (${error.message})`;
  }
}

/** Re-exported for run-task.ts's convenience — fetch + normalise in one step. */
export async function fetchRoutableModels(modelglassApiKey: string): Promise<RoutableModel[]> {
  return (await fetchLLMModels(modelglassApiKey)).map(normalise);
}
