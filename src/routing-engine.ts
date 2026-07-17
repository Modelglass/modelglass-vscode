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

/** Every current-generation LLM model — the routing pool. Deliberately
 *  ?modality=llm (matching ./lib.ts's fetchLLMModels), not switch-check's
 *  cross-modality ?generation=all: every taxonomy category routes an
 *  in-editor coding task to an LLM, never to an image/video/audio model,
 *  and a superseded previous-gen model has no place in a "which model
 *  should I use right now" recommendation. */
export async function fetchLLMModels(apiKey: string): Promise<ModelEntry[]> {
  const res = await fetch(`${MODELGLASS_API}/v1/models?modality=llm`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
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

export function normalise(m: ModelEntry): RoutableModel {
  const offering = [...m.offerings].sort(
    (a, b) => (currentPrice(a.tiers, "input") ?? Infinity) - (currentPrice(b.tiers, "input") ?? Infinity),
  )[0];
  const capability = new Map(
    (m.knowledge?.capability_profile ?? []).map((d) => [d.dimension, d.rating] as const),
  );
  return {
    name: m.name,
    slug: offering?.slug ?? m.model_id,
    provider: offering?.provider ?? "",
    modelId: m.model_id,
    benchmarks: m.knowledge?.benchmarks ?? [],
    capability,
    inputPricePerM: offering ? currentPrice(offering.tiers, "input") : null,
    outputPricePerM: offering ? currentPrice(offering.tiers, "output") : null,
  };
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
 * Shared shape for every "rank by a benchmark score, cheapest-first
 * tie-break" category (bug-fix, new-code-generation, library-aware feature
 * work). `pickScore` returns the score + label to use for one model, or
 * null if this model has no usable signal for this benchmark preference —
 * callers supply the specific benchmark id(s)/variant preference; this
 * function only owns the shared sort/exclude/unscore mechanics.
 */
function rankByBenchmark(
  category: TaskCategory,
  models: RoutableModel[],
  pickScore: (m: RoutableModel) => { score: number; label: string } | null,
): CategoryRanking {
  const ranked: RankedModel[] = [];
  const unscored: RoutableModel[] = [];
  for (const m of models) {
    const picked = pickScore(m);
    if (!picked) {
      unscored.push(m);
      continue;
    }
    ranked.push({ model: m, score: picked.score, scoreKind: "benchmark", scoreLabel: picked.label });
  }
  ranked.sort((a, b) => {
    const d = b.score - a.score;
    return d !== 0 ? d : cheaperFirst(a.model, b.model);
  });
  return { category, ranked, excluded: [], unscored };
}

// --- 3.1 Bug-fix / debug ---------------------------------------------------
// Clean mapping: SWE-bench Pro preferred (the more current signal — major
// labs report Pro over Verified for flagship launches as of mid-2026, per
// swe-bench-pro.yaml's own notes), falling back to SWE-bench Verified when
// a model has no Pro score. Cheapest-input-price tie-break, matching
// ./lib.ts's selectCodingModel() convention.
export function rankBugFix(models: RoutableModel[]): CategoryRanking {
  return rankByBenchmark("bug-fix", models, (m) => {
    const pro = benchmarkScore(m, "swe-bench-pro");
    if (pro) return { score: pro.score, label: `SWE-bench Pro ${(pro.score * 100).toFixed(1)}%` };
    const verified = benchmarkScore(m, "swe-bench-verified");
    if (verified) {
      return { score: verified.score, label: `SWE-bench Verified ${(verified.score * 100).toFixed(1)}% (no Pro score available)` };
    }
    return null;
  });
}

// --- 3.2 New code generation (spec -> code, greenfield) -------------------
// Clean mapping: Aider Polyglot preferred (closer to typical application
// code across a broad language set), falling back to LiveCodeBench (skews
// algorithmic/competitive-programming — the taxonomy's stated reason to
// prefer Aider when both exist).
export function rankNewCodeGeneration(models: RoutableModel[]): CategoryRanking {
  return rankByBenchmark("new-code-generation", models, (m) => {
    const aider = benchmarkScore(m, "aider-polyglot");
    if (aider) return { score: aider.score, label: `Aider Polyglot ${(aider.score * 100).toFixed(1)}%` };
    const lcb = benchmarkScore(m, "livecodebench");
    if (lcb) return { score: lcb.score, label: `LiveCodeBench ${(lcb.score * 100).toFixed(1)}% (no Aider Polyglot score available)` };
    return null;
  });
}

// --- 3.3 Terminal / CLI / DevOps -------------------------------------------
// Clean mapping: Terminal-Bench 2.1, but ONLY the Terminus-2-harness score —
// terminal-bench-2-1.yaml's own notes document native-harness and
// Terminus-2-harness scores as NOT comparable (10+ pp swings), so a model
// with only a native-harness entry is excluded here with a stated reason
// rather than silently mixed into a ranking it would distort. This is a
// default-rules scoring decision (which harness to trust), not a user
// override — still in SCO-230's scope.
export function rankTerminalCli(models: RoutableModel[]): CategoryRanking {
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
      });
    } else {
      excluded.push({
        model: m,
        reason: `only has a native-harness (${matches[0]!.harness ?? "unspecified"}) Terminal-Bench 2.1 score — ` +
          "not comparable to Terminus-2-harness scores, per the benchmark's own documented 10+ pp harness gap",
      });
    }
  }
  ranked.sort((a, b) => {
    const d = b.score - a.score;
    return d !== 0 ? d : cheaperFirst(a.model, b.model);
  });
  return { category: "terminal-cli", ranked, excluded, unscored };
}

// --- 3.4 Library/dependency-aware feature work -----------------------------
// Clean mapping (the sixth benchmark, per the taxonomy's own note that it's
// added beyond the card's named five since it's part of the coding
// vertical's existing set): BigCodeBench, Hard variant preferred (Full is
// approaching saturation for frontier models per bigcodebench.yaml's own
// notes), falling back to Full if Hard is absent for a model.
export function rankLibraryAwareFeatureWork(models: RoutableModel[]): CategoryRanking {
  return rankByBenchmark("library-aware-feature-work", models, (m) => {
    const hard = benchmarkScore(m, "bigcodebench", "hard");
    if (hard?.variant === "hard") return { score: hard.score, label: `BigCodeBench Hard ${(hard.score * 100).toFixed(1)}%` };
    const any = benchmarkScore(m, "bigcodebench");
    if (any) return { score: any.score, label: `BigCodeBench ${any.variant ?? "?"} ${(any.score * 100).toFixed(1)}% (no Hard-variant score available)` };
    return null;
  });
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
export function rankRefactor(models: RoutableModel[]): CategoryRanking {
  const benchmarkRanking = rankByBenchmark("refactor", models, (m) => {
    const pro = benchmarkScore(m, "swe-bench-pro");
    if (pro) return { score: pro.score, label: `SWE-bench Pro ${(pro.score * 100).toFixed(1)}% (imperfect proxy — measures bug-fix, not refactor)` };
    const verified = benchmarkScore(m, "swe-bench-verified");
    if (verified) return { score: verified.score, label: `SWE-bench Verified ${(verified.score * 100).toFixed(1)}% (imperfect proxy — measures bug-fix, not refactor)` };
    return null;
  });
  const capabilityRanking = rankByCapability("refactor", benchmarkRanking.unscored, "coding");
  return {
    category: "refactor",
    // Every benchmark-scored model outranks every capability-only one —
    // concatenation, not a merged sort, is deliberate: score=0.9 on the
    // 0-1 benchmark scale and score=2 ("strong") on the 0-2 rating scale
    // are not on a shared axis, so sorting them together would compare
    // incommensurable numbers.
    ranked: [...benchmarkRanking.ranked, ...capabilityRanking.ranked],
    excluded: [],
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
 */
export function rankModelsForCategory(models: RoutableModel[], category: LeafTaskCategory): CategoryRanking {
  switch (category) {
    case "bug-fix": return rankBugFix(models);
    case "new-code-generation": return rankNewCodeGeneration(models);
    case "terminal-cli": return rankTerminalCli(models);
    case "library-aware-feature-work": return rankLibraryAwareFeatureWork(models);
    case "refactor": return rankRefactor(models);
    case "test-gen": return rankTestGen(models);
    case "doc-gen": return rankDocGen(models);
    case "chat-explain": return rankChatExplain(models);
    case "autocomplete": return rankAutocomplete(models);
  }
}
