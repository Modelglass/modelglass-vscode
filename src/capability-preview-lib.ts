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

/** One line per category, e.g. "Bug fix / debug: 4 model(s)" / "Autocomplete: none routable". */
export function formatCategoryLines(preview: CapabilityPreview): string[] {
  return preview.categories.map(
    (c) => `${c.label}: ${c.routableCount > 0 ? `${c.routableCount} model(s)` : "none routable"}`,
  );
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
