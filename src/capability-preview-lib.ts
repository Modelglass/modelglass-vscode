import { CATEGORY_LABELS, LEAF_CATEGORIES } from "./run-task-lib.js";
import { rankModelsForCategory, type LeafTaskCategory, type RoutableModel } from "./routing-engine.js";
import type { SupportedProvider } from "./provider-keys-lib.js";

/**
 * SCO-263 — quick-win setup-time capability preview. Registry benchmark
 * coverage is sparse enough that several real provider configs silently
 * resolve to zero routable models for some (Groq's only offering is
 * previous-gen and filtered out; DeepSeek/Mistral error on every category)
 * or even ALL nine categories — a new user currently only discovers this
 * mid-task, when Run Task returns "no-ranked-models" with no earlier
 * warning. This module computes the same per-category ranking Run Task
 * itself uses (rankModelsForCategory, unmodified — no new scoring logic),
 * scoped to one provider's models, so the gap is visible the moment a key
 * is configured instead of hidden until first use.
 *
 * Deliberately NOT a fix for the underlying sparse-coverage problem (that's
 * a benchmark-backfill initiative, out of scope here per the card) — this
 * only makes the existing gap visible earlier, using data the engine
 * already produces.
 *
 * Pure/vscode-free (same lib/non-lib split as every other module in this
 * repo) so it's directly unit-testable; the vscode-coupled display (Output
 * channel + notification) lives in provider-keys.ts.
 */

export interface CategoryPreview {
  category: LeafTaskCategory;
  label: string;
  routableCount: number;
}

export interface CapabilityPreview {
  provider: SupportedProvider;
  /** True if the provider has no models in the feed at all — a distinct,
   *  more fundamental gap than "has models but none rank for any category". */
  noModelsForProvider: boolean;
  categories: CategoryPreview[];
  routable: CategoryPreview[];
  zeroRoutable: CategoryPreview[];
}

/**
 * `allModels` is the full feed (any provider) — this filters to `provider`
 * itself, mirroring exactly what routeAndExecute (run-task-lib.ts) does
 * before ranking, so the preview can't drift from what Run Task will
 * actually see.
 */
export function previewProviderCapabilities(
  allModels: RoutableModel[],
  provider: SupportedProvider,
): CapabilityPreview {
  const providerModels = allModels.filter((m) => m.provider === provider);

  const categories: CategoryPreview[] = LEAF_CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    routableCount: rankModelsForCategory(providerModels, category).ranked.length,
  }));

  return {
    provider,
    noModelsForProvider: providerModels.length === 0,
    categories,
    routable: categories.filter((c) => c.routableCount > 0),
    zeroRoutable: categories.filter((c) => c.routableCount === 0),
  };
}

/**
 * SCO-302 — combined fallback-chain coverage across every currently-
 * configured provider (Pro's multi-key case). A category the just-added
 * key alone doesn't cover can still be resolved by a DIFFERENT configured
 * provider's models — SCO-263's per-key preview above has no way to show
 * that, so a Pro user building up a fallback chain only ever sees "here's
 * what THIS key covers," never "here's what your chain covers combined."
 *
 * Filters to the UNION of every provider in `providers`, then ranks ONCE
 * over that combined pool — deliberately mirroring
 * run-task-lib.ts's routeAndExecuteWithFallback, which builds its own
 * chain the exact same way (`combinedPool = allModels.filter(m =>
 * configuredSet.has(m.provider))`, then ranks that pool once per category).
 * Ranking the union in one pass, rather than ranking each provider
 * separately and summing counts, is what keeps this a faithful preview of
 * what the real fallback chain will do, not a parallel approximation of it.
 *
 * Only meaningful with 2+ configured providers — a single provider's
 * combined view is identical to its own previewProviderCapabilities result,
 * so callers should skip this for the first-key-ever case (nothing new to
 * show) rather than call it needlessly.
 */
export interface CombinedCapabilityPreview {
  providers: SupportedProvider[];
  categories: CategoryPreview[];
  routable: CategoryPreview[];
  zeroRoutable: CategoryPreview[];
}

export function previewCombinedCapabilities(
  allModels: RoutableModel[],
  providers: SupportedProvider[],
): CombinedCapabilityPreview {
  const providerSet = new Set(providers);
  const combinedModels = allModels.filter((m) => providerSet.has(m.provider as SupportedProvider));

  const categories: CategoryPreview[] = LEAF_CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    routableCount: rankModelsForCategory(combinedModels, category).ranked.length,
  }));

  return {
    providers,
    categories,
    routable: categories.filter((c) => c.routableCount > 0),
    zeroRoutable: categories.filter((c) => c.routableCount === 0),
  };
}

/** A single-line summary for the combined view, same tone as
 *  summarizeCapabilityPreview but naming the provider set instead of one
 *  provider (there's no single-provider "no models at all" case to special-
 *  case here — an empty combined pool just reads as 0-of-N routable, same
 *  as any other fully-zero category set). */
export function summarizeCombinedCapabilityPreview(preview: CombinedCapabilityPreview): string {
  if (preview.zeroRoutable.length === 0) {
    return `your combined fallback chain is routable for all ${preview.categories.length} task categories`;
  }
  return (
    `your combined fallback chain is routable for ${preview.routable.length} of ${preview.categories.length} task categories — ` +
    `still no routable models for: ${preview.zeroRoutable.map((c) => c.label).join(", ")}`
  );
}

/**
 * Categories where a zero-routable result reflects a known, industry-wide
 * benchmark gap (SCO-272) rather than a Modelglass-specific coverage hole —
 * worth a one-line note so it doesn't read as "we haven't built this yet".
 * `library-aware-feature-work` maps to BigCodeBench, whose own leaderboard
 * dataset hasn't been updated since April 2025 (confirmed directly against
 * its Hugging Face dataset metadata) — no current-gen model anywhere has a
 * published score for it, so this stays empty for every provider, not just
 * ones Modelglass has thin data for.
 */
const INDUSTRY_WIDE_GAP_NOTE: Partial<Record<LeafTaskCategory, string>> = {
  "library-aware-feature-work":
    "no current-gen model anywhere has a published score for this yet, not just here",
};

/** One line per category, e.g. "Bug fix / debug: 4 model(s)" / "Autocomplete: none routable".
 *  Takes just the `categories` shape both CapabilityPreview and
 *  CombinedCapabilityPreview carry, so it's reusable for either without
 *  duplicating this formatting logic. */
export function formatCategoryLines(preview: { categories: CategoryPreview[] }): string[] {
  return preview.categories.map((c) => {
    const base = `${c.label}: ${c.routableCount > 0 ? `${c.routableCount} model(s)` : "none routable"}`;
    const note = c.routableCount === 0 ? INDUSTRY_WIDE_GAP_NOTE[c.category] : undefined;
    return note ? `${base} (${note})` : base;
  });
}

/** A single-line summary suitable for a notification/info message. */
export function summarizeCapabilityPreview(preview: CapabilityPreview): string {
  if (preview.noModelsForProvider) {
    return `no models for this provider in the current Modelglass feed at all`;
  }
  if (preview.zeroRoutable.length === 0) {
    return `routable for all ${preview.categories.length} task categories`;
  }
  return (
    `routable for ${preview.routable.length} of ${preview.categories.length} task categories — ` +
    `no routable models yet for: ${preview.zeroRoutable.map((c) => c.label).join(", ")}`
  );
}
