/**
 * SCO-430 — the "new modality/category/fetch layer for video and audio
 * targets" this ticket calls for, deliberately NOT a reuse of
 * routing-engine.ts. Checked why before writing this: routing-engine.ts's
 * entire ranking system (rankBugFix, rankByBenchmark, DEFAULT_MIN_SCORE_BY_
 * BENCHMARK, etc.) is built around the coding vertical's SIX capability
 * benchmarks (SWE-bench, Aider Polyglot, ...) — video/audio generation
 * offerings in the Modelglass registry carry no such benchmark data at all
 * (there is no "video generation quality" or "TTS naturalness" score in
 * this feed), so there is nothing for that machinery to rank ON. This
 * module's ranking is simpler by necessity, not by omission: cheapest-first
 * by price, the same tie-break routing-engine.ts already uses as its OWN
 * secondary sort — just promoted to primary here since it's the only signal
 * that exists.
 *
 * Also deliberately narrower in scope than a general multi-provider router:
 * this ticket supports exactly ONE provider per modality (Runway for video,
 * ElevenLabs for audio) — fal.ai is explicitly out of scope (unconfirmed
 * provider, separate future ticket). So "routing" here reduces to "rank
 * Runway's (or ElevenLabs') OWN registered offerings by price" — there is
 * no fallback chain to build (ADR-0012 Amendment 2 Decision 6: no fallback
 * chain for this feature, any tier), so this module owns fetch + normalise
 * + price-rank only, not a multi-provider chain like run-task-lib.ts's
 * routeAndExecuteWithFallback.
 */

// ---------------------------------------------------------------------------
// Types — Modelglass feed (independent copy, same "deliberately independent
// module" precedent routing-engine.ts's own header already establishes for
// switch-check-lib.ts vs. routing-engine.ts's slightly different shapes).
// ---------------------------------------------------------------------------

export interface MediaPricingEntry {
  amount: number;
  currency: string;
  unit: string;
  effective_from: string;
  effective_to?: string;
}

export interface MediaTier {
  id: string;
  pricing: MediaPricingEntry[];
}

export interface MediaOffering {
  slug: string;
  provider: string;
  quality_tier?: string;
  tiers: MediaTier[];
  model: {
    id: string;
    /** Raw sub-modality, e.g. "text-to-video" / "image-to-video" /
     *  "video-to-video" / "tts" / "stt" / "music". */
    modality: string;
    status: string;
  };
}

export interface MediaModelEntry {
  model_id: string;
  name: string;
  offerings: MediaOffering[];
}

interface MediaApiResponse {
  ok: boolean;
  data: MediaModelEntry[];
}

export type MediaModality = "video" | "audio";

export const MEDIA_MODELGLASS_API =
  process.env["MODELGLASS_API_URL"] || "https://modelglass-api.vercel.app";

/** Same small metadata-fetch budget as routing-engine.ts's
 *  DEFAULT_MODELGLASS_FETCH_TIMEOUT_MS — this is a feed fetch, not a
 *  generation call. */
export const DEFAULT_MEDIA_FEED_TIMEOUT_MS = 15_000;

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/**
 * `?modality=video` / `?modality=audio` — confirmed live against
 * packages/api/src/handlers/models.ts's own MODALITY_GROUPS mapping
 * (video -> text-to-video/image-to-video; audio -> tts/stt/music) before
 * writing this, not assumed from routing-engine.ts's `?modality=llm`
 * precedent alone.
 */
export async function fetchMediaModels(
  apiKey: string,
  modality: MediaModality,
  timeoutMs: number = DEFAULT_MEDIA_FEED_TIMEOUT_MS,
): Promise<MediaModelEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${MEDIA_MODELGLASS_API}/v1/models?modality=${modality}`, {
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
  const json = (await res.json()) as MediaApiResponse;
  if (!json.ok) throw new Error("Modelglass API returned ok=false");
  return json.data;
}

export interface RoutableMediaModel {
  name: string;
  slug: string;
  provider: string;
  modelId: string;
  subModality: string;
  qualityTier?: string;
  /** The cheapest currently-active tier's price, or null if this offering
   *  has no active price (mirrors routing-engine.ts's currentPrice —
   *  null-price offerings sort last, never dropped silently). */
  price: { amount: number; unit: string; currency: string } | null;
}

function currentTierPrice(tiers: MediaTier[]): { amount: number; unit: string; currency: string } | null {
  let cheapest: { amount: number; unit: string; currency: string } | null = null;
  for (const tier of tiers) {
    if (!tier.pricing.length) continue;
    const active = tier.pricing.find((p) => !p.effective_to);
    const chosen = active ?? [...tier.pricing].sort((a, b) => (a.effective_from > b.effective_from ? -1 : 1))[0]!;
    if (cheapest === null || chosen.amount < cheapest.amount) {
      cheapest = { amount: chosen.amount, unit: chosen.unit, currency: chosen.currency };
    }
  }
  return cheapest;
}

/** One RoutableMediaModel per offering, same "don't collapse to one entry
 *  per model_id" reasoning as routing-engine.ts's normaliseOfferings (SCO-280)
 *  — a model could in principle be hosted by more than one provider. */
export function normaliseMediaOfferings(entry: MediaModelEntry): RoutableMediaModel[] {
  return entry.offerings.map((offering) => ({
    name: entry.name,
    slug: offering.slug,
    provider: offering.provider,
    modelId: entry.model_id,
    subModality: offering.model.modality,
    qualityTier: offering.quality_tier,
    price: currentTierPrice(offering.tiers),
  }));
}

const cheaperFirst = (a: RoutableMediaModel, b: RoutableMediaModel) =>
  (a.price?.amount ?? Infinity) - (b.price?.amount ?? Infinity);

/**
 * Filters to one provider (and, when given, one sub-modality) and sorts
 * cheapest-first. This is the entirety of this module's "ranking" — no
 * quality bar, no benchmark cascade, matching this file's header on why
 * routing-engine.ts's machinery doesn't apply here.
 */
export function rankMediaModelsByPrice(
  models: RoutableMediaModel[],
  provider: string,
  subModality?: string,
): RoutableMediaModel[] {
  return models
    .filter((m) => m.provider === provider && (subModality === undefined || m.subModality === subModality))
    .sort(cheaperFirst);
}
