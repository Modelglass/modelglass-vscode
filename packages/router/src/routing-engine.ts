/**
 * SCO-230 — routing engine v1: Modelglass-default scoring rules.
 *
 * Scores available LLM models against docs/specs/sco-229-task-taxonomy.md's
 * ten task categories and returns a ranked, best-to-worst recommendation.
 * Default rules only — no user override/weighting (that's SCO-231, a
 * separate card; flagged, not built here even where it would be tempting to
 * add a "weight" parameter while already in this code).
 *
 * A deliberately independent module from ./lib.ts and ./switch-check-lib.ts,
 * same reasoning SCO-216 already established for keeping those two separate:
 * this needs a richer normalised shape (six benchmark ids instead of one,
 * plus a `speed` capability dimension neither existing file reads) than
 * either of them carries, and consolidating would let this module's needs
 * constrain theirs. Fetches via ?modality=llm (not switch-check's
 * cross-modality ?generation=all) — every category in the taxonomy is an
 * LLM/code-editor task; there is no image/video/audio routing target here.
 *
 * The taxonomy's own benchmark mappings, restated at the point each is used
 * below rather than only here, so a reader of one category's scoring
 * function doesn't have to cross-reference the doc to see why that
 * benchmark was picked.
 */

// ---------------------------------------------------------------------------
// Types — Modelglass feed (independent copy, see file header)
// ---------------------------------------------------------------------------

export interface CapabilityDim {
  dimension: string;
  rating: string;
}

export interface BenchmarkScore {
  benchmark: string;
  score: number; // 0-1 fraction
  variant?: string;
  harness?: string;
  source: { url: string; type: string };
}

export interface PricingEntry {
  amount: number;
  unit: string;
  effective_from: string;
  effective_to?: string;
}

export interface Tier {
  id: string;
  pricing: PricingEntry[];
}

export interface Offering {
  slug: string;
  provider: string;
  tiers: Tier[];
  /** SCO-283: the provider-native model string to call, when it genuinely
   *  differs from what resolveProviderModelId()'s heuristic would derive. */
  provider_model_id?: string;
}

export interface ModelEntry {
  model_id: string;
  name: string;
  knowledge?: {
    capability_profile?: CapabilityDim[];
    benchmarks?: BenchmarkScore[];
  } | null;
  offerings: Offering[];
}

interface ApiResponse {
  ok: boolean;
  data: ModelEntry[];
}

// ---------------------------------------------------------------------------
// Modelglass API
// ---------------------------------------------------------------------------

export const MODELGLASS_API =
  process.env["MODELGLASS_API_URL"] || "https://modelglass-api.vercel.app";

/**
 * SCO-260 quick-win #1 — this was the one Modelglass API fetch in the whole
 * Run Task path with no bounded timeout: run-task-lib.ts's
 * fetchRoutableModels wraps this function and already has a stale-cache
 * fallback for a *rejected* fetch (SCO-264), but a *hung* one never rejects,
 * so that fallback path was unreachable for exactly the failure mode it was
 * built for. 15s — the same small metadata-fetch budget used for
 * pro-gate-lib.ts/auth.ts's Modelglass API calls, not a model completion.
 */
export const DEFAULT_MODELGLASS_FETCH_TIMEOUT_MS = 15_000;

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/** Every current-generation LLM model — the routing pool. Deliberately
 *  ?modality=llm (matching ./lib.ts's fetchLLMModels), not switch-check's
 *  cross-modality ?generation=all: every taxonomy category routes an
 *  in-editor coding task to an LLM, never to an image/video/audio model,
 *  and a superseded previous-gen model has no place in a "which model
 *  should I use right now" recommendation. */
export async function fetchLLMModels(
  apiKey: string,
  timeoutMs: number = DEFAULT_MODELGLASS_FETCH_TIMEOUT_MS,
): Promise<ModelEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${MODELGLASS_API}/v1/models?modality=llm`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
  } catch (e) {
    if (isAbortError(e)) {
      throw new Error(`Modelglass API request timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Modelglass API ${res.status}: ${body}`);
  }
  const json = (await res.json()) as ApiResponse;
  if (!json.ok) throw new Error("Modelglass API returned ok=false");
  return json.data;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Rating vocabulary as used elsewhere in this codebase (switch-check-lib.ts's
 *  RATING_ORDER) — a second independent copy per the same SCO-216 precedent
 *  as the rest of this file, not imported from that module. Ratings outside
 *  this scale (e.g. "variable", "unknown") are unscored, not crashed on. */
const RATING_ORDER = ["weak", "moderate", "strong"] as const;

function ratingValue(rating: string | null): number | null {
  if (rating === null) return null;
  const i = RATING_ORDER.indexOf(rating as (typeof RATING_ORDER)[number]);
  return i === -1 ? null : i;
}

export interface RoutableModel {
  name: string;
  slug: string;
  provider: string;
  modelId: string;
  benchmarks: BenchmarkScore[];
  capability: Map<string, string>; // dimension -> rating, as authored (not yet numeric)
  inputPricePerM: number | null;
  outputPricePerM: number | null;
  /** SCO-283: the offering's explicit provider_model_id, when the registry
   *  sets one -- undefined for the common case, in which case
   *  resolveProviderModelId()'s heuristic derives it from modelId instead. */
  providerModelId?: string;
}

/** Active price: the entry with no effective_to (still in force), falling
 *  back to the most recent by effective_from — mirrors switch-check-lib.ts's
 *  currentPrice() convention, applied here to whichever offering is cheapest
 *  on input price (same "pick the cheapest offering, then read its current
 *  price" two-step ./lib.ts's normalise() already uses). */
function currentPrice(tiers: Tier[], id: string): number | null {
  const tier = tiers.find((t) => t.id === id);
  if (!tier || !tier.pricing.length) return null;
  const active = tier.pricing.find((p) => !p.effective_to);
  if (active) return active.amount;
  return [...tier.pricing].sort((a, b) => (a.effective_from > b.effective_from ? -1 : 1))[0]!.amount;
}

/**
 * SCO-260 item #9 / SCO-280 — one `RoutableModel` per offering, not one per
 * model collapsed to its cheapest offering. The previous behavior
 * (`normalise`, singular — picked the single cheapest-input-price offering
 * and used only that offering's provider) meant a model hosted by more than
 * one provider was only ever routable through whichever host happened to be
 * cheapest: a user keyed to the *other* provider couldn't route to it at
 * all, even though that provider genuinely offers it (confirmed live,
 * `llama-3.3-70b` via Groq + Together — Together is cheaper, so a
 * Groq-keyed user saw zero offerings for it before this change). Every
 * caller already filters `RoutableModel[]` by `.provider` before ranking
 * (`run-task-lib.ts`'s `routeAndExecute`), so returning multiple entries —
 * one per offering, each carrying that offering's own price — composes with
 * the existing filter-then-rank pipeline with no other changes needed.
 *
 * A model with zero offerings (benchmark/capability data only, no priced
 * hosting) still produces exactly one entry, matching the old function's
 * behavior for that case: empty `provider`, null prices, keyed by
 * `model_id` since there's no offering `slug` to use.
 */
export function normaliseOfferings(m: ModelEntry): RoutableModel[] {
  const capability = new Map(
    (m.knowledge?.capability_profile ?? []).map((d) => [d.dimension, d.rating] as const),
  );
  const benchmarks = m.knowledge?.benchmarks ?? [];

  if (m.offerings.length === 0) {
    return [
      {
        name: m.name,
        slug: m.model_id,
        provider: "",
        modelId: m.model_id,
        benchmarks,
        capability,
        inputPricePerM: null,
        outputPricePerM: null,
      },
    ];
  }

  return m.offerings.map((offering) => ({
    name: m.name,
    slug: offering.slug,
    provider: offering.provider,
    modelId: m.model_id,
    benchmarks,
    capability,
    inputPricePerM: currentPrice(offering.tiers, "input"),
    outputPricePerM: currentPrice(offering.tiers, "output"),
    providerModelId: offering.provider_model_id,
  }));
}

/**
 * A model's score on one benchmark id, honouring a preferred `variant` when
 * the benchmark has one (e.g. BigCodeBench Hard vs Full — the taxonomy
 * prefers Hard, falling back to Full only if Hard is absent for a given
 * model). Returns null with no matching entry at all.
 */
export function benchmarkScore(
  m: RoutableModel,
  benchmarkId: string,
  preferVariant?: string,
): { score: number; harness?: string; variant?: string } | null {
  const matches = m.benchmarks.filter((b) => b.benchmark === benchmarkId);
  if (!matches.length) return null;
  const preferred = preferVariant ? matches.find((b) => b.variant === preferVariant) : undefined;
  const b = preferred ?? matches[0]!;
  return { score: b.score, harness: b.harness, variant: b.variant };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface RankedModel {
  model: RoutableModel;
  /** The value actually used to rank this model — a 0-1 benchmark score, or
   *  a 0-2 rating index (weak/moderate/strong) when falling back to
   *  capability_profile. Not directly comparable across the two kinds — see
   *  `scoreKind`. */
  score: number;
  scoreKind: "benchmark" | "capability-rating";
  /** Human-readable justification, e.g. "SWE-bench Pro 69.2%" or
   *  "capability_profile.coding = strong (no SWE-bench score available)". */
  scoreLabel: string;
  /** SCO-330 (default-flip) — internal-use only, set exclusively by
   *  rankByBenchmark/rankTerminalCli so `applyQualityBar` knows which
   *  DEFAULT_MIN_SCORE_BY_BENCHMARK entry applies to THIS model's score
   *  when no explicit `minScore` override is set. Absent for
   *  capability-rating scores (that 0-2 scale isn't threshold-comparable to
   *  a 0-1 default, same reasoning `rankModelsForCategory`'s own dispatcher
   *  comment already gives for why minScore is a no-op there). Not meant to
   *  be read by any caller outside this file. */
  defaultMinScoreKey?: string;
}

export interface CategoryRanking {
  category: TaskCategory;
  /** Best-to-worst. */
  ranked: RankedModel[];
  /** Had some signal (benchmark or capability rating) for this category but
   *  were excluded from `ranked` — e.g. a Terminal-Bench 2.1 score on a
   *  non-Terminus-2 harness (see terminal-cli's own scoring notes). Every
   *  exclusion here carries a stated reason; nothing is silently dropped. */
  excluded: { model: RoutableModel; reason: string }[];
  /** Had no signal at all for this category — no benchmark score, no
   *  relevant capability_profile dimension rated. */
  unscored: RoutableModel[];
}

const cheaperFirst = (a: RoutableModel, b: RoutableModel) =>
  (a.inputPricePerM ?? Infinity) - (b.inputPricePerM ?? Infinity);

/**
 * SCO-330 (default-flip, 2026-07-29) — the router's DEFAULT is now
 * cheapest-among-comparably-capable, not best-score-regardless-of-price.
 * History: SCO-329's honest gap review (§2b) found this file ranked
 * score-descending with price only a tie-break, so "Run Task on Cheapest
 * Capable Model" could pick a 96.2% $5/M model over a 68% $1.1/M one —
 * cheaper-and-still-capable never got a look-in once anything scored
 * higher. The first fix (SCO-330, 2026-07-27) added `minScore` as an
 * OPT-IN field in `.modelglass/routing-rules.json` — real, but it left the
 * default untouched, so the gap the command's own name promises
 * ("cheapest capable") was still only available to Pro users who'd
 * written a rules file. This pass closes that: the default itself now
 * applies a quality bar, not just an explicit one.
 *
 * One absolute number PER BENCHMARK, not one shared global number, and not
 * a percentile/relative-margin cutoff. Checked directly against the live
 * feed (2026-07-29, GET /v1/models?modality=llm): SWE-bench Verified scores
 * currently span 21%-96.2%, Aider Polyglot spans 15.6%-72% — one shared
 * threshold would be far too loose for the easy end of one benchmark or
 * far too strict for the hard end of another. A percentile cutoff (e.g.
 * "top half of today's pool") was considered and rejected: it would make a
 * model's qualification depend on which OTHER models happen to be
 * currently registered, an unstable property with no clear meaning a user
 * could reason about — an absolute bar means "clears at least X% on this
 * benchmark," true or false independent of the rest of the pool, and
 * reuses the exact semantic the already-shipped explicit `minScore` field
 * already established rather than inventing a second mental model for
 * defaults specifically.
 */
const DEFAULT_MIN_SCORE_BY_BENCHMARK: Record<string, number> = {
  // 58.1%-63.2% in the live feed (only 2 models scored) — a bar low enough
  // to keep both in play; SWE-bench Pro is the harder/newer benchmark, so
  // its natural range sits well below Verified's.
  "swe-bench-pro": 0.5,
  // 21%-96.2% in the live feed (15 models) — 0.6 cleanly separates the
  // genuinely weak end (Llama 4 Maverick 21%, Mistral Large 3 41.4%) from
  // everything else, and is exactly the bar that lets o4-mini (68.1%)
  // qualify alongside pricier 90%+ models — the concrete case SCO-329's
  // review named.
  "swe-bench-verified": 0.6,
  // 15.6%-72% in the live feed (5 models) — 0.5 excludes only the clear
  // outlier (Llama 4 Maverick, 15.6%), keeping the rest (53.3%-72%) in play.
  "aider-polyglot": 0.5,
  // 43.4%-72.8% in the live feed (4 models) — same reasoning as Aider
  // Polyglot; 0.5 excludes only Llama 4 Maverick (43.4%).
  livecodebench: 0.5,
  // 67%-80.4% in the live feed (2 models, Terminus-2 harness only) — 0.6
  // keeps both in play, same shape as swe-bench-pro above.
  "terminal-bench-2-1": 0.6,
  // LOW-CONFIDENCE PLACEHOLDER: the live feed has ZERO current-gen models
  // with a BigCodeBench score at all (its dataset hasn't been updated
  // since April 2025 — see capability-preview-lib.ts's
  // INDUSTRY_WIDE_GAP_NOTE), so there's no real data to calibrate against
  // yet. 0.3 is a guess, not a measurement — revisit the moment a model
  // actually gets scored on this benchmark.
  bigcodebench: 0.3,
};

/**
 * Applies a quality bar to an already-scored `ranked` list, partitioning
 * into qualifying (sorted cheapest-first) and sub-threshold (moved to
 * `excluded` with a stated reason — never silently dropped, matching this
 * file's existing "every exclusion carries a reason" convention).
 *
 * Two modes, both ending in the same cheapest-first sort:
 *  - explicit `minScore` (routing-rules.json, SCO-330's original scope):
 *    ONE absolute bar applied to every model in the category, regardless of
 *    which benchmark backed its score. A user who set this made a
 *    deliberate choice; a category where nothing clears it returns
 *    genuinely empty — no safety net (see below), since silently
 *    overriding an explicit choice would be worse than an honest "nothing
 *    qualifies your bar."
 *  - no `minScore` (the default): each model is checked against ITS OWN
 *    benchmark's default via `defaultMinScoreKey` — necessary because one
 *    category can mix benchmarks with very different natural ranges (e.g.
 *    bug-fix: some models scored via SWE-bench Pro, others via Verified
 *    fallback — see `DEFAULT_MIN_SCORE_BY_BENCHMARK`'s own header).
 *
 * SAFETY VALVE (default mode only): if the default bar excludes every
 * single scored model in this pool, that's a sign the bar doesn't fit
 * today's pool (e.g. every current offering for this provider/category
 * happens to be genuinely weak) — falls back to the pre-this-change
 * score-descending order over the full pool, rather than returning a
 * category that looks completely dead. This fallback is deliberately NOT
 * applied when `minScore` is explicit: a user's own deliberate bar
 * excluding everyone is a real, honest result they should see plainly, not
 * have silently second-guessed.
 */
function applyQualityBar(
  ranked: RankedModel[],
  minScore: number | undefined,
): { ranked: RankedModel[]; excluded: { model: RoutableModel; reason: string }[] } {
  if (ranked.length === 0) return { ranked: [], excluded: [] };

  const qualifying: RankedModel[] = [];
  const subThreshold: { model: RoutableModel; reason: string }[] = [];

  for (const r of ranked) {
    const bar = minScore ?? (r.defaultMinScoreKey !== undefined ? DEFAULT_MIN_SCORE_BY_BENCHMARK[r.defaultMinScoreKey] : undefined) ?? 0;
    if (r.score >= bar) {
      qualifying.push(r);
    } else {
      subThreshold.push({
        model: r.model,
        reason:
          minScore !== undefined
            ? `below the minScore quality bar (${r.scoreLabel} < required ${(minScore * 100).toFixed(0)}%)`
            : `below the default quality bar for this benchmark (${r.scoreLabel} < ${(bar * 100).toFixed(0)}%) — cheapest-among-comparably-capable is the default; set an explicit minScore in .modelglass/routing-rules.json for a different bar`,
      });
    }
  }

  if (minScore === undefined && qualifying.length === 0) {
    const fallback = [...ranked].sort((a, b) => {
      const d = b.score - a.score;
      return d !== 0 ? d : cheaperFirst(a.model, b.model);
    });
    return { ranked: fallback, excluded: [] };
  }

  qualifying.sort((a, b) => cheaperFirst(a.model, b.model));
  return { ranked: qualifying, excluded: subThreshold };
}

/**
 * Shared shape for every "rank by a benchmark score, cheapest-first
 * tie-break" category (bug-fix, new-code-generation, library-aware feature
 * work). `pickScore` returns the score + label + which
 * `DEFAULT_MIN_SCORE_BY_BENCHMARK` entry applies (`defaultMinScoreKey`) to
 * use for one model, or null if this model has no usable signal for this
 * benchmark preference — callers supply the specific benchmark id(s)/variant
 * preference; this function only owns the shared sort/exclude/unscore
 * mechanics, delegating the actual bar logic to `applyQualityBar`.
 *
 * `minScore` (SCO-330) — see `applyQualityBar`'s header above.
 */
function rankByBenchmark(
  category: TaskCategory,
  models: RoutableModel[],
  pickScore: (m: RoutableModel) => { score: number; label: string; defaultMinScoreKey: string } | null,
  minScore?: number,
): CategoryRanking {
  const ranked: RankedModel[] = [];
  const unscored: RoutableModel[] = [];
  for (const m of models) {
    const picked = pickScore(m);
    if (!picked) {
      unscored.push(m);
      continue;
    }
    ranked.push({
      model: m,
      score: picked.score,
      scoreKind: "benchmark",
      scoreLabel: picked.label,
      defaultMinScoreKey: picked.defaultMinScoreKey,
    });
  }

  const { ranked: finalRanked, excluded } = applyQualityBar(ranked, minScore);
  return { category, ranked: finalRanked, excluded, unscored };
}

// --- 3.1 Bug-fix / debug ---------------------------------------------------
// Clean mapping: SWE-bench Pro preferred (the more current signal — major
// labs report Pro over Verified for flagship launches as of mid-2026, per
// swe-bench-pro.yaml's own notes), falling back to SWE-bench Verified when
// a model has no Pro score. Cheapest-input-price tie-break, matching
// ./lib.ts's selectCodingModel() convention.
export function rankBugFix(models: RoutableModel[], minScore?: number): CategoryRanking {
  return rankByBenchmark("bug-fix", models, (m) => {
    const pro = benchmarkScore(m, "swe-bench-pro");
    if (pro) return { score: pro.score, label: `SWE-bench Pro ${(pro.score * 100).toFixed(1)}%`, defaultMinScoreKey: "swe-bench-pro" };
    const verified = benchmarkScore(m, "swe-bench-verified");
    if (verified) {
      return {
        score: verified.score,
        label: `SWE-bench Verified ${(verified.score * 100).toFixed(1)}% (no Pro score available)`,
        defaultMinScoreKey: "swe-bench-verified",
      };
    }
    return null;
  }, minScore);
}

// --- 3.2 New code generation (spec -> code, greenfield) -------------------
// Clean mapping: Aider Polyglot preferred (closer to typical application
// code across a broad language set), falling back to LiveCodeBench (skews
// algorithmic/competitive-programming — the taxonomy's stated reason to
// prefer Aider when both exist).
export function rankNewCodeGeneration(models: RoutableModel[], minScore?: number): CategoryRanking {
  return rankByBenchmark("new-code-generation", models, (m) => {
    const aider = benchmarkScore(m, "aider-polyglot");
    if (aider) return { score: aider.score, label: `Aider Polyglot ${(aider.score * 100).toFixed(1)}%`, defaultMinScoreKey: "aider-polyglot" };
    const lcb = benchmarkScore(m, "livecodebench");
    if (lcb) {
      return {
        score: lcb.score,
        label: `LiveCodeBench ${(lcb.score * 100).toFixed(1)}% (no Aider Polyglot score available)`,
        defaultMinScoreKey: "livecodebench",
      };
    }
    return null;
  }, minScore);
}

// --- 3.3 Terminal / CLI / DevOps -------------------------------------------
// Clean mapping: Terminal-Bench 2.1, but ONLY the Terminus-2-harness score —
// terminal-bench-2-1.yaml's own notes document native-harness and
// Terminus-2-harness scores as NOT comparable (10+ pp swings), so a model
// with only a native-harness entry is excluded here with a stated reason
// rather than silently mixed into a ranking it would distort. This is a
// default-rules scoring decision (which harness to trust), not a user
// override — still in SCO-230's scope.
export function rankTerminalCli(models: RoutableModel[], minScore?: number): CategoryRanking {
  const ranked: RankedModel[] = [];
  const excluded: { model: RoutableModel; reason: string }[] = [];
  const unscored: RoutableModel[] = [];
  for (const m of models) {
    const matches = m.benchmarks.filter((b) => b.benchmark === "terminal-bench-2-1");
    if (!matches.length) {
      unscored.push(m);
      continue;
    }
    const terminus2 = matches.find((b) => b.harness === "terminus-2");
    if (terminus2) {
      ranked.push({
        model: m,
        score: terminus2.score,
        scoreKind: "benchmark",
        scoreLabel: `Terminal-Bench 2.1 ${(terminus2.score * 100).toFixed(1)}% (Terminus 2 harness)`,
        defaultMinScoreKey: "terminal-bench-2-1",
      });
    } else {
      excluded.push({
        model: m,
        reason: `only has a native-harness (${matches[0]!.harness ?? "unspecified"}) Terminal-Bench 2.1 score — ` +
          "not comparable to Terminus-2-harness scores, per the benchmark's own documented 10+ pp harness gap",
      });
    }
  }

  // SCO-330: same quality-bar mechanism as rankByBenchmark
  // (applyQualityBar), called directly here (not routed through that
  // function) because this category's harness-exclusion pass above already
  // needs its own bespoke loop.
  const { ranked: finalRanked, excluded: barExcluded } = applyQualityBar(ranked, minScore);
  return { category: "terminal-cli", ranked: finalRanked, excluded: [...excluded, ...barExcluded], unscored };
}

// --- 3.4 Library/dependency-aware feature work -----------------------------
// Clean mapping (the sixth benchmark, per the taxonomy's own note that it's
// added beyond the card's named five since it's part of the coding
// vertical's existing set): BigCodeBench, Hard variant preferred (Full is
// approaching saturation for frontier models per bigcodebench.yaml's own
// notes), falling back to Full if Hard is absent for a model.
export function rankLibraryAwareFeatureWork(models: RoutableModel[], minScore?: number): CategoryRanking {
  return rankByBenchmark("library-aware-feature-work", models, (m) => {
    const hard = benchmarkScore(m, "bigcodebench", "hard");
    if (hard?.variant === "hard") {
      return { score: hard.score, label: `BigCodeBench Hard ${(hard.score * 100).toFixed(1)}%`, defaultMinScoreKey: "bigcodebench" };
    }
    const any = benchmarkScore(m, "bigcodebench");
    if (any) {
      return {
        score: any.score,
        label: `BigCodeBench ${any.variant ?? "?"} ${(any.score * 100).toFixed(1)}% (no Hard-variant score available)`,
        defaultMinScoreKey: "bigcodebench",
      };
    }
    return null;
  }, minScore);
}

// --- Shared fallback: rank by a capability_profile dimension --------------
// Backs refactor's secondary tier, test-gen, doc-gen, and chat-explain — all
// four fall back to a qualitative rating rather than a benchmark, per the
// taxonomy's explicit notes for each. doc-gen and chat-explain share this
// exact call (same dimension, same function) rather than each getting a
// bespoke implementation, matching the taxonomy's own "SCO-230 can keep
// that precedent — chat/explain and doc-gen sharing one non-coding pool."
function rankByCapability(
  category: TaskCategory,
  models: RoutableModel[],
  dimension: string,
): CategoryRanking {
  const ranked: RankedModel[] = [];
  const unscored: RoutableModel[] = [];
  for (const m of models) {
    const rating = m.capability.get(dimension) ?? null;
    const value = ratingValue(rating);
    if (value === null) {
      unscored.push(m);
      continue;
    }
    ranked.push({
      model: m,
      score: value,
      scoreKind: "capability-rating",
      scoreLabel: `capability_profile.${dimension} = ${rating}`,
    });
  }
  ranked.sort((a, b) => {
    const d = b.score - a.score;
    return d !== 0 ? d : cheaperFirst(a.model, b.model);
  });
  return { category, ranked, excluded: [], unscored };
}

// --- 3.5 Refactor -----------------------------------------------------------
// Fuzzy: no coding benchmark measures "preserve behaviour while
// restructuring." The taxonomy names SWE-bench Verified/Pro as "the closest
// available proxy" with capability_profile.coding "a reasonable secondary
// signal alongside it" — implemented as a cascade: benchmark-scored models
// (Pro preferred, Verified fallback, same as bug-fix) rank first since a
// benchmark is more concrete evidence than a qualitative rating; models with
// NO SWE-bench score at all fall further back to capability_profile.coding
// rather than being excluded outright, ranked below every benchmark-scored
// model. Cheapest-price tie-break throughout.
export function rankRefactor(models: RoutableModel[], minScore?: number): CategoryRanking {
  // SCO-330: minScore applies only to the benchmark-scored half below —
  // the capability_profile.coding fallback is a 0-2 rating scale, not
  // comparable to a 0-1 minScore threshold, same reasoning as excluding
  // test-gen/doc-gen/chat-explain/autocomplete from this fix entirely.
  const benchmarkRanking = rankByBenchmark("refactor", models, (m) => {
    const pro = benchmarkScore(m, "swe-bench-pro");
    if (pro) {
      return {
        score: pro.score,
        label: `SWE-bench Pro ${(pro.score * 100).toFixed(1)}% (imperfect proxy — measures bug-fix, not refactor)`,
        defaultMinScoreKey: "swe-bench-pro",
      };
    }
    const verified = benchmarkScore(m, "swe-bench-verified");
    if (verified) {
      return {
        score: verified.score,
        label: `SWE-bench Verified ${(verified.score * 100).toFixed(1)}% (imperfect proxy — measures bug-fix, not refactor)`,
        defaultMinScoreKey: "swe-bench-verified",
      };
    }
    return null;
  }, minScore);
  const capabilityRanking = rankByCapability("refactor", benchmarkRanking.unscored, "coding");
  return {
    category: "refactor",
    // Every benchmark-scored model outranks every capability-only one —
    // concatenation, not a merged sort, is deliberate: score=0.9 on the
    // 0-1 benchmark scale and score=2 ("strong") on the 0-2 rating scale
    // are not on a shared axis, so sorting them together would compare
    // incommensurable numbers.
    ranked: [...benchmarkRanking.ranked, ...capabilityRanking.ranked],
    // SCO-330: benchmarkRanking.excluded now carries below-minScore models
    // when a threshold is set (empty otherwise, matching prior behavior).
    excluded: benchmarkRanking.excluded,
    unscored: capabilityRanking.unscored,
  };
}

// --- 3.6 Test-gen -----------------------------------------------------------
// No match: the taxonomy explicitly warns Aider Polyglot LOOKS like a fit
// but is the inverse task shape (given tests, write the implementation —
// test-gen needs the reverse). Falls back to capability_profile.coding +
// cost only, with no benchmark cascade at all — using Aider Polyglot here
// would be scoring the wrong skill, per the taxonomy's own stated reasoning.
export function rankTestGen(models: RoutableModel[]): CategoryRanking {
  return rankByCapability("test-gen", models, "coding");
}

// --- 3.7 Doc-gen -------------------------------------------------------------
// No match: none of the six benchmarks score documentation quality. Falls
// back to capability_profile.instruction_following — the same signal
// ./lib.ts's selectWritingModel() already ranks the shipped extension's
// `writing` tag on, reused rather than inventing a new fallback mechanism.
export function rankDocGen(models: RoutableModel[]): CategoryRanking {
  return rankByCapability("doc-gen", models, "instruction-following");
}

// --- 3.8 Chat / explain -------------------------------------------------------
// No match, same reasoning as doc-gen. Shares doc-gen's exact scoring call
// per the taxonomy's own note that these two can share one non-coding pool.
export function rankChatExplain(models: RoutableModel[]): CategoryRanking {
  return rankByCapability("chat-explain", models, "instruction-following");
}

// --- 3.9 Autocomplete ---------------------------------------------------------
// No match, and not a coverage gap — a wrong-axis mismatch: none of the six
// benchmarks are latency-sensitive, but autocomplete's dominant quality bar
// IS latency. Ranks primarily on capability_profile.speed (NOT coding
// ability), cheapest-price second, coding rating only as a final
// tie-breaker — the taxonomy's explicitly inverted priority order relative
// to every other category in this file.
export function rankAutocomplete(models: RoutableModel[]): CategoryRanking {
  const ranked: RankedModel[] = [];
  const unscored: RoutableModel[] = [];
  for (const m of models) {
    const speedRating = m.capability.get("speed") ?? null;
    const speedValue = ratingValue(speedRating);
    if (speedValue === null) {
      unscored.push(m);
      continue;
    }
    ranked.push({
      model: m,
      score: speedValue,
      scoreKind: "capability-rating",
      scoreLabel: `capability_profile.speed = ${speedRating} (autocomplete ranks on speed, not coding benchmark score)`,
    });
  }
  ranked.sort((a, b) => {
    const speedDelta = b.score - a.score;
    if (speedDelta !== 0) return speedDelta;
    const priceDelta = cheaperFirst(a.model, b.model);
    if (priceDelta !== 0) return priceDelta;
    // Final tie-break only: coding rating, never the primary axis here.
    const codingDelta = (ratingValue(b.model.capability.get("coding") ?? null) ?? -1) -
      (ratingValue(a.model.capability.get("coding") ?? null) ?? -1);
    return codingDelta;
  });
  return { category: "autocomplete", ranked, excluded: [], unscored };
}

// --- 3.10 Agentic multi-step (composite, not a leaf) ------------------------
// Not benchmark-mappable as its own leaf, per the taxonomy: decompose into
// the other nine categories and route each subtask independently, matching
// SCO-139's own validated "tag each subtask at decomposition time — no
// separate router call" finding. This function does not add a tenth scoring
// bucket; it fans a subtask list out to the nine leaf rankers above.
export type LeafTaskCategory = Exclude<TaskCategory, "agentic-multi-step">;

export interface Subtask {
  id: string;
  category: LeafTaskCategory;
}

export function rankAgenticMultiStep(
  models: RoutableModel[],
  subtasks: Subtask[],
): { subtaskId: string; ranking: CategoryRanking }[] {
  return subtasks.map((s) => ({ subtaskId: s.id, ranking: rankModelsForCategory(models, s.category) }));
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export type TaskCategory =
  | "bug-fix"
  | "new-code-generation"
  | "terminal-cli"
  | "library-aware-feature-work"
  | "refactor"
  | "test-gen"
  | "doc-gen"
  | "chat-explain"
  | "autocomplete"
  | "agentic-multi-step";

/**
 * The single entry point SCO-232 (Starter tier) is expected to call directly
 * for any leaf category. `agentic-multi-step` has no ranking of its own
 * (see rankAgenticMultiStep above) — calling this with that category is a
 * caller error, not a silent empty ranking, since it would otherwise look
 * like "no model qualifies" rather than "wrong function for this category."
 *
 * `minScore` (SCO-330) is forwarded only to the five benchmark-scored
 * categories — silently ignored for test-gen/doc-gen/chat-explain/
 * autocomplete, whose capability_profile rating scale (0-2) a 0-1 score
 * threshold can't meaningfully apply to (those four already achieve
 * cheapest-among-the-top-rating-tier naturally, via cheaperFirst breaking
 * the frequent exact ties a coarse 3-level scale produces — no separate
 * default-bar mechanism needed there). See `applyQualityBar`'s header for
 * the five categories that do get one.
 */
export function rankModelsForCategory(
  models: RoutableModel[],
  category: LeafTaskCategory,
  minScore?: number,
): CategoryRanking {
  switch (category) {
    case "bug-fix": return rankBugFix(models, minScore);
    case "new-code-generation": return rankNewCodeGeneration(models, minScore);
    case "terminal-cli": return rankTerminalCli(models, minScore);
    case "library-aware-feature-work": return rankLibraryAwareFeatureWork(models, minScore);
    case "refactor": return rankRefactor(models, minScore);
    case "test-gen": return rankTestGen(models);
    case "doc-gen": return rankDocGen(models);
    case "chat-explain": return rankChatExplain(models);
    case "autocomplete": return rankAutocomplete(models);
  }
}
