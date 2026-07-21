import {
  fetchLLMModels,
  normaliseOfferings,
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
 * already populated by routing-engine.ts's own `normaliseOfferings()` (one
 * entry per offering as of SCO-280 — a model hosted by more than one
 * provider produces one `RoutableModel` per host, not just its cheapest),
 * so filtering to the configured provider before ranking is a plain
 * `.filter()`, nothing more). No user override/weighting (SCO-231) and no multi-key/fallback
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
      /** SCO-260 quick-win #2 — why topModel won, already computed by the
       *  ranking engine (e.g. "SWE-bench Pro 69.2%") and previously dropped
       *  here rather than surfaced to the caller. */
      scoreLabel: string;
      /** SCO-260 quick-win #5 — routing-rules.json `priority` entries that
       *  matched no model in the pool (typo, retired/renamed model). Empty
       *  when no rule applied or the rule wasn't a priority override. */
      unmatchedPriorityIds: string[];
      /** SCO-260 quick-win #5 — count of models a rule excluded from
       *  ranking for this category. Individual reasons live on
       *  resolveCategoryRanking's own `excluded` array; only the count is
       *  threaded through here to keep this outcome type small. */
      excludedCount: number;
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

// ---------------------------------------------------------------------------
// SCO-233 (Pro) — multi-key fallback chain. Extends routeAndExecute rather
// than duplicating its orchestration: routeAndExecuteWithFallback below
// calls the SAME routeAndExecute once per provider in the chain, unchanged.
// routeAndExecute itself is untouched — its signature, behavior, and every
// existing SCO-232/SCO-231 test against it keep passing unmodified.
// ---------------------------------------------------------------------------

export interface ConfiguredProviderKey {
  provider: SupportedProvider;
  apiKey: string;
}

export interface ProviderAttempt {
  provider: SupportedProvider;
  result: RouteAndExecuteOutcome;
}

export type FallbackOutcome =
  | ({ outcome: "success"; attempts: ProviderAttempt[] } & Extract<RouteAndExecuteOutcome, { outcome: "success" }>)
  | { outcome: "no-configured-providers"; category: LeafTaskCategory }
  | { outcome: "no-ranked-models"; category: LeafTaskCategory }
  | { outcome: "all-providers-failed"; category: LeafTaskCategory; attempts: ProviderAttempt[] };

/**
 * SCO-233 fallback contract, decided here (flagged per the card's own
 * request to flag ambiguous design calls rather than pick silently):
 *
 * "Next in chain" means the next-ranked model on a DIFFERENT configured
 * provider, never a second model on a provider that already failed. ADR-0012's
 * original four failure kinds (invalid-key, rate-limited, network-error,
 * provider-error) are ALL connection/key-level failures, not per-model ones —
 * an invalid key or a rate limit applies identically to every model call
 * against that same host. Retrying a second model on the SAME provider after
 * any of these would almost certainly reproduce the identical failure, which
 * is exactly the "pointless retry" the card asks to avoid.
 *
 * ADR-0012 Amendment 1 (SCO-281) carves out exactly one named exception to
 * that rule: `model-not-found` is specific to the one model string tried,
 * not the provider or key, so a different model on the same provider is
 * likely to work where an invalid-key/rate-limit/network/provider-error
 * retry would not be. See the `allowSameProviderRetry`-gated block below —
 * every other failure class is unchanged by this. So the chain is
 * built by ranking ALL configured providers' models together for this
 * category (via resolveCategoryRanking — the same rule-composed ranking
 * SCO-231 already built, so an excludeProviders/priority rule composes here
 * for free), then deduping to one entry per provider — that provider's own
 * top-ranked model — in first-occurrence order. Each provider is tried AT
 * MOST ONCE. This is also the attempt cap (item 3): chain length is bounded
 * by the number of DISTINCT configured providers with at least one ranked
 * model for this category, never more — "try every configured provider once,
 * in ranked order, then surface the final failure," exactly as suggested.
 *
 * Chain-order UX (item 4): zero-config default is simply the combined
 * ranking's provider order — no manual setup needed for working fallback.
 * Manual override is ALREADY available, additively, via SCO-231's existing
 * `priority` rule: since resolveCategoryRanking (rule-aware) is what
 * determines chain order here, a user who writes a `priority` list for a
 * category directly controls fallback order too — no new config surface was
 * built for this, reusing SCO-231's mechanism instead of inventing a second
 * one.
 */
export async function routeAndExecuteWithFallback(
  allModels: RoutableModel[],
  configuredProviders: ConfiguredProviderKey[],
  category: LeafTaskCategory,
  prompt: string,
  executeFn: ExecuteFn = executeProviderCall,
  rule?: RoutingRule,
  /**
   * ADR-0012 Amendment 1 (SCO-281) — defaults to false. The caller decides
   * this, not this function: Starter's "no retry, one attempt, full stop"
   * contract must stay untouched even though Starter's single-provider
   * calls go through this exact same function (a truncated one-provider
   * chain, per SCO-234's `selectProvidersForRun`). Same pattern SCO-234
   * already established for tier gating elsewhere in this codebase —
   * "gating lives entirely in the calling code, deciding WHAT to pass in,"
   * not a tier check inside the shared orchestration logic itself.
   * run-task.ts passes `isGateSatisfied(proStatus)` here.
   */
  allowSameProviderRetry: boolean = false,
): Promise<FallbackOutcome> {
  if (configuredProviders.length === 0) {
    return { outcome: "no-configured-providers", category };
  }

  const configuredSet = new Set(configuredProviders.map((c) => c.provider));
  const combinedPool = allModels.filter((m) => configuredSet.has(m.provider as SupportedProvider));
  const combinedRanking = resolveCategoryRanking(combinedPool, category, rule);

  const chainOrder: SupportedProvider[] = [];
  for (const ranked of combinedRanking.ranked) {
    const provider = ranked.model.provider as SupportedProvider;
    if (!chainOrder.includes(provider)) chainOrder.push(provider);
  }

  if (chainOrder.length === 0) {
    return { outcome: "no-ranked-models", category };
  }

  const keyByProvider = new Map(configuredProviders.map((c) => [c.provider, c.apiKey]));
  const attempts: ProviderAttempt[] = [];

  for (const provider of chainOrder) {
    const apiKey = keyByProvider.get(provider)!;
    const result = await routeAndExecute(allModels, provider, apiKey, category, prompt, executeFn, rule);
    attempts.push({ provider, result });
    if (result.outcome === "success") {
      return { ...result, attempts };
    }

    // ADR-0012 Amendment 1 (SCO-281): model-not-found is specific to the
    // one model just tried, not this provider or key — retry ONCE against
    // this same provider's next-best model (excluding the one that just
    // failed) before advancing the chain. Pro-only, per the docstring
    // above; every other failure class falls straight through unchanged.
    if (allowSameProviderRetry && result.outcome === "execution-failed" && result.error.kind === "model-not-found") {
      const retryResult = await routeAndExecute(
        allModels,
        provider,
        apiKey,
        category,
        prompt,
        executeFn,
        rule,
        new Set([result.topModel.modelId]),
      );
      attempts.push({ provider, result: retryResult });
      if (retryResult.outcome === "success") {
        return { ...retryResult, attempts };
      }
    }
    // execution-failed (including a failed same-provider retry above), or
    // (defensively) no-ranked-models if this provider's own pool somehow
    // scored nothing despite appearing in the combined ranking — either
    // way, fall through to the next provider in the chain.
  }

  return { outcome: "all-providers-failed", category, attempts };
}

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
 *
 * `excludeModelIds` (ADR-0012 Amendment 1 / SCO-281) — optional, filters
 * these model IDs out of the pool before ranking. This function itself
 * still only ever calls one model and never loops, matching the contract
 * above unchanged; the parameter exists so `routeAndExecuteWithFallback`
 * can call this same function a SECOND time for a provider that already
 * failed on `model-not-found`, to reach that provider's next-best model
 * instead of the same one that just failed. Starter's call sites never
 * pass this — the retry is built entirely in the Pro-only fallback chain,
 * not here.
 */
export async function routeAndExecute(
  allModels: RoutableModel[],
  provider: SupportedProvider,
  providerApiKey: string,
  category: LeafTaskCategory,
  prompt: string,
  executeFn: ExecuteFn = executeProviderCall,
  rule?: RoutingRule,
  excludeModelIds?: ReadonlySet<string>,
): Promise<RouteAndExecuteOutcome> {
  const providerModels = allModels.filter(
    (m) => m.provider === provider && !excludeModelIds?.has(m.modelId),
  );
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
      scoreLabel: top.scoreLabel,
      unmatchedPriorityIds: ranking.unmatchedPriorityIds,
      excludedCount: ranking.excluded.length,
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
    case "model-not-found":
      return `${error.provider} doesn't recognize this model string`;
    case "provider-error":
      return `${error.provider} returned an error (${error.message})`;
  }
}

/**
 * SCO-260 quick-win #4 — a single hop's outcome, human-readable, for both
 * the per-hop "as it happens" log line and the terminal joined summary
 * (both now built from this one function instead of two separately-
 * maintained copies of the same conditional). Distinguishes an actual
 * execution failure (classified via describeFailure) from a provider that
 * was skipped entirely for having no ranked models for this category, per
 * SCO-260's own phrasing ("also worth noting providers skipped entirely for
 * having no ranked models").
 */
export function describeAttempt(attempt: ProviderAttempt): string {
  if (attempt.result.outcome === "execution-failed") {
    return describeFailure(attempt.result.error);
  }
  if (attempt.result.outcome === "no-ranked-models") {
    return "skipped — no ranked models for this category";
  }
  return attempt.result.outcome;
}

// ---------------------------------------------------------------------------
// SCO-264 — quick-win local cache for the model/benchmark feed. Every Run
// Task invocation used to make its own uncached GET /v1/models?modality=llm
// call before ever touching a provider — the router's own pitch ("no proxy
// in the request path, no outage surface you don't control") didn't hold up
// against that: a Modelglass API blip killed the run at the routing hop
// instead of the execution hop, which is exactly the kind of outage surface
// the pitch claims doesn't exist. Two effects from one cache: (1) within the
// TTL, back-to-back Run Task calls share one fetch instead of hitting the
// API every time; (2) on a fetch failure past the TTL, the last known-good
// feed is served instead of failing the whole run — a transient blip no
// longer blocks anything as long as ONE fetch has ever succeeded this
// session. A module-level singleton is deliberate, not an oversight: it's
// meant to persist across every Run Task invocation for the life of the
// Extension Host, the same lifetime `output` (auth.ts) already assumes.
// 5 minutes: pricing/benchmark data changes on a registry-PR cadence (hours
// to days), not seconds, so this is generous slack for the failure-tolerance
// benefit without meaningfully risking staleness within one editing session.
// ---------------------------------------------------------------------------

export const FEED_CACHE_TTL_MS = 5 * 60 * 1000;

interface FeedCacheEntry {
  models: RoutableModel[];
  fetchedAt: number;
}

let feedCache: FeedCacheEntry | undefined;

/** Test-only: no real command path calls this — it exists so each test can
 *  start from a cold cache regardless of run order. */
export function __resetFeedCacheForTests(): void {
  feedCache = undefined;
}

/**
 * Fetch + normalise in one step (re-exported for run-task.ts's convenience),
 * now cache-backed per the header above. `fetchFn`/`nowFn` are injectable
 * for tests, same convention as `executeFn` elsewhere in this file.
 * `onStaleFallback` is an optional hook (run-task.ts wires it to the shared
 * Output channel) so a stale-cache fallback is visible somewhere, matching
 * ADR-0012's "evidence, not a verdict" logging convention used for provider
 * fallback — silently serving stale data with zero signal would hide a real
 * outage rather than tolerate it gracefully.
 */
export async function fetchRoutableModels(
  modelglassApiKey: string,
  fetchFn: (apiKey: string) => ReturnType<typeof fetchLLMModels> = fetchLLMModels,
  nowFn: () => number = Date.now,
  onStaleFallback?: (message: string) => void,
): Promise<RoutableModel[]> {
  const now = nowFn();
  if (feedCache && now - feedCache.fetchedAt < FEED_CACHE_TTL_MS) {
    return feedCache.models;
  }

  try {
    const models = (await fetchFn(modelglassApiKey)).flatMap(normaliseOfferings);
    feedCache = { models, fetchedAt: now };
    return models;
  } catch (e) {
    if (feedCache) {
      onStaleFallback?.(
        `couldn't refresh the model/benchmark feed (${e instanceof Error ? e.message : String(e)}) — ` +
          `serving the last cached copy from ${new Date(feedCache.fetchedAt).toISOString()} instead.`,
      );
      return feedCache.models;
    }
    throw e;
  }
}
