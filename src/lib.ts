/**
 * Vendored from modelglass-router-examples/cost-aware-vscode-router/src/lib.ts
 * (SCO-211). Only the pure selection/normalisation logic and the Modelglass
 * feed-fetching function — no CLI-coupled pieces. Two things deliberately NOT
 * vendored:
 *   - LogEntry / deviationType() — belong to the CLI's `report` command
 *     (escalation/cost-delta tracking), out of this extension's MVP scope.
 *   - requireApiKey() — reads process.env and calls process.exit(1) on
 *     failure, which would crash the whole Extension Host if reused as-is.
 *     Replaced entirely by ./auth.ts (SecretStorage + auto-provision).
 * Keep this file's logic in sync with the upstream CLI's lib.ts by hand;
 * there's no published package to depend on instead (see SCO-211).
 */

// ---------------------------------------------------------------------------
// Types — task
// ---------------------------------------------------------------------------

export type SubtaskTag = "coding" | "writing" | "general";

export interface Subtask {
  description: string;
  tag: SubtaskTag;
  /**
   * Minimum SWE-bench Verified score (0-100) a coding-tagged subtask requires
   * of its selected model. Ignored for non-coding subtasks. Omit for no
   * threshold (any confirmed-score model qualifies).
   */
  minSweBenchVerified?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface Task {
  description: string;
  subtasks: Subtask[];
}

/** Built-in demo task — used for a first-run "try it" fixture, not core to the routing flow. */
export const DEMO_TASK: Task = {
  description:
    "Add per-endpoint rate limiting middleware to the Modelglass API " +
    "(Redis KV, 429/Retry-After, unit tests, PR description, Slack summary).",
  subtasks: [
    {
      description: "Implement rate-limit middleware (Upstash KV, 429/Retry-After)",
      tag: "coding",
      minSweBenchVerified: 65,
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_500,
    },
    {
      description: "Write unit tests (pass/reject/tier-boundary)",
      tag: "coding",
      minSweBenchVerified: 65,
      estimatedInputTokens: 8_000,
      estimatedOutputTokens: 2_000,
    },
    {
      description: "Write PR description explaining the change and testing approach",
      tag: "writing",
      estimatedInputTokens: 3_000,
      estimatedOutputTokens: 500,
    },
    {
      description: "Write Slack summary for the team announcing the change",
      tag: "writing",
      estimatedInputTokens: 2_000,
      estimatedOutputTokens: 200,
    },
  ],
};

// ---------------------------------------------------------------------------
// Types — Modelglass feed
// ---------------------------------------------------------------------------

export interface CapabilityDim {
  dimension: string;
  rating: string;
  notes?: string;
}

/**
 * A curated benchmark score from the feed's `knowledge.benchmarks` — every
 * score carries provenance: the source URL and its type (vendor / leaderboard
 * / paper / independent).
 */
export interface BenchmarkScore {
  benchmark: string;
  score: number; // 0-1 fraction
  score_date?: string;
  harness?: string;
  variant?: string;
  source: { url: string; type: string; verified_at?: string };
  notes?: string;
}

export interface PricingEntry {
  amount: number;
  currency: string;
  unit: string;
  effective_from: string;
}

export interface Tier {
  id: string;
  pricing: PricingEntry[];
}

export interface Offering {
  slug: string;
  provider: string;
  quality_tier: string;
  tiers: Tier[];
  /** SCO-283: the provider-native model string to call, when it genuinely
   *  differs from what resolveProviderModelId()'s heuristic would derive.
   *  Optional -- absent for the common case where the heuristic already
   *  works. */
  provider_model_id?: string;
}

export interface ModelEntry {
  model_id: string;
  name: string;
  knowledge?: {
    capability_profile?: CapabilityDim[];
    benchmarks?: BenchmarkScore[];
  };
  offerings: Offering[];
}

export interface ApiResponse {
  ok: boolean;
  data: ModelEntry[];
}

export interface NormalisedModel {
  name: string;
  slug: string;
  /** Which host serves the selected (cheapest) offering. Empty string only if a model has zero offerings. */
  provider: string;
  qualityTier: string;
  codingRating: string | null;
  instrRating: string | null;
  sweBenchVerified: number | null;
  sweBenchSource: string;
  /** Model has a curated SWE-bench Pro score (a different benchmark). */
  hasSweBenchPro: boolean;
  inputPricePerM: number | null;
  outputPricePerM: number | null;
}

// ---------------------------------------------------------------------------
// Modelglass API
// ---------------------------------------------------------------------------

export const MODELGLASS_API =
  process.env.MODELGLASS_API ?? "https://modelglass-api.vercel.app";

export async function fetchLLMModels(apiKey: string): Promise<NormalisedModel[]> {
  const res = await fetch(`${MODELGLASS_API}/v1/models?modality=llm`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Modelglass API ${res.status}: ${body}`);
  }
  const json = (await res.json()) as ApiResponse;
  if (!json.ok) throw new Error("Modelglass API returned ok=false");
  return json.data.map(normalise);
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Read a model's curated SWE-bench Verified score from the structured
 * `knowledge.benchmarks` field — score + provenance as curated in the
 * Modelglass coding-capability registry, not parsed out of prose.
 */
export function sweBenchVerifiedScore(
  benchmarks: BenchmarkScore[] | undefined,
): { score: number | null; source: string } {
  const entry = benchmarks?.find((b) => b.benchmark === "swe-bench-verified");
  if (!entry) return { score: null, source: "" };
  let host = entry.source.url;
  try {
    host = new URL(entry.source.url).hostname.replace(/^www\./, "");
  } catch {
    // keep the raw URL if it doesn't parse
  }
  return {
    score: Math.round(entry.score * 1000) / 10, // 0-1 fraction -> percent, 1 dp
    source: `${host}, ${entry.source.type}`,
  };
}

export function currentPrice(tiers: Tier[], id: string): number | null {
  const tier = tiers.find((t) => t.id === id);
  if (!tier || !tier.pricing.length) return null;
  return tier.pricing[tier.pricing.length - 1].amount;
}

export function normalise(m: ModelEntry): NormalisedModel {
  const cap = m.knowledge?.capability_profile ?? [];
  let codingRating: string | null = null;
  let instrRating: string | null = null;
  for (const dim of cap) {
    if (dim.dimension === "coding") codingRating = dim.rating;
    if (dim.dimension === "instruction-following") instrRating = dim.rating;
  }
  const benchmarks = m.knowledge?.benchmarks;
  const { score: sweBenchVerified, source: sweBenchSource } = sweBenchVerifiedScore(benchmarks);
  const hasSweBenchPro = benchmarks?.some((b) => b.benchmark === "swe-bench-pro") ?? false;
  const offering = [...m.offerings].sort(
    (a, b) =>
      (currentPrice(a.tiers, "input") ?? Infinity) -
      (currentPrice(b.tiers, "input") ?? Infinity),
  )[0];
  return {
    name: m.name,
    slug: offering?.slug ?? m.model_id,
    provider: offering?.provider ?? "",
    qualityTier: offering?.quality_tier ?? "",
    codingRating,
    instrRating,
    sweBenchVerified,
    sweBenchSource,
    hasSweBenchPro,
    inputPricePerM: offering ? currentPrice(offering.tiers, "input") : null,
    outputPricePerM: offering ? currentPrice(offering.tiers, "output") : null,
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface CodingSelection {
  selected: NormalisedModel | null;
  ranked: NormalisedModel[]; // every confirmed-score model, sorted desc by SWE-bench Verified
  qualifying: NormalisedModel[]; // ranked models that also clear minSweBenchVerified
  excluded: { model: NormalisedModel; reason: string }[];
  mostExpensive: NormalisedModel | null;
  minSweBenchVerified: number | null; // the threshold actually applied, for display
}

/**
 * Highest `minSweBenchVerified` set across a task's coding-tagged subtasks,
 * or null if none set any threshold.
 */
export function codingQualityBar(task: Task): number | null {
  const bars = task.subtasks
    .filter((s) => s.tag === "coding" && s.minSweBenchVerified !== undefined)
    .map((s) => s.minSweBenchVerified!);
  return bars.length ? Math.max(...bars) : null;
}

export function selectCodingModel(
  models: NormalisedModel[],
  minSweBenchVerified: number | null = null,
): CodingSelection {
  const strong = models.filter((m) => m.codingRating === "strong");
  const ranked: NormalisedModel[] = [];
  const excluded: { model: NormalisedModel; reason: string }[] = [];

  for (const m of strong) {
    if (m.sweBenchVerified !== null) {
      ranked.push(m);
    } else if (m.hasSweBenchPro) {
      excluded.push({
        model: m,
        reason: "has a curated SWE-bench Pro score (different benchmark) — not SWE-bench Verified",
      });
    } else {
      excluded.push({
        model: m,
        reason: "no curated SWE-bench Verified score in the Modelglass registry",
      });
    }
  }

  ranked.sort((a, b) => {
    const d = (b.sweBenchVerified ?? 0) - (a.sweBenchVerified ?? 0);
    return d !== 0 ? d : (a.inputPricePerM ?? Infinity) - (b.inputPricePerM ?? Infinity);
  });

  const qualifying = ranked.filter(
    (m) => minSweBenchVerified === null || (m.sweBenchVerified ?? 0) >= minSweBenchVerified,
  );
  if (minSweBenchVerified !== null) {
    for (const m of ranked) {
      if (!qualifying.includes(m)) {
        excluded.push({
          model: m,
          reason: `SWE-bench Verified ${m.sweBenchVerified}% is below the required threshold of ${minSweBenchVerified}%`,
        });
      }
    }
  }

  const cheapestFirst = [...qualifying].sort(
    (a, b) => (a.inputPricePerM ?? Infinity) - (b.inputPricePerM ?? Infinity),
  );
  const selected = cheapestFirst[0] ?? null;

  const allStrong = [...ranked, ...excluded.map((e) => e.model)];
  const mostExpensive = allStrong.sort(
    (a, b) => (b.inputPricePerM ?? 0) - (a.inputPricePerM ?? 0),
  )[0] ?? null;

  return { selected, ranked, qualifying, excluded, mostExpensive, minSweBenchVerified };
}

export function selectWritingModel(models: NormalisedModel[]): NormalisedModel | null {
  const candidates = models.filter(
    (m) => m.instrRating === "strong" || m.instrRating === "good",
  );
  if (!candidates.length) return null;
  return candidates.sort(
    (a, b) => (a.inputPricePerM ?? Infinity) - (b.inputPricePerM ?? Infinity),
  )[0];
}

/** Most expensive model across the full pool — used as the summary baseline. */
export function mostExpensiveInPool(models: NormalisedModel[]): NormalisedModel | null {
  return [...models].sort(
    (a, b) => (b.inputPricePerM ?? 0) - (a.inputPricePerM ?? 0),
  )[0] ?? null;
}

// ---------------------------------------------------------------------------
// Cost helpers
// ---------------------------------------------------------------------------

export function estimateCost(m: NormalisedModel, inTok: number, outTok: number): number {
  return (
    ((m.inputPricePerM ?? 0) * inTok) / 1_000_000 +
    ((m.outputPricePerM ?? 0) * outTok) / 1_000_000
  );
}

export function fmtCost(usd: number): string {
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export function fmtPrice(p: number | null): string {
  return p !== null ? `$${p}` : "N/A";
}
