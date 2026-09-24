/**
 * SCO-646 — the SCO-640 headline-price rule, shared by every pricing path
 * (Run Task / Modelglass Chat via routing-engine.ts, Route Task via lib.ts,
 * Switch Check via switch-check-lib.ts, and video / audio via
 * media-routing-lib.ts), so the four can't drift apart — same reasoning as
 * offering-status.ts (SCO-633).
 *
 * A tier's price may stand in for a model's headline (list) price unless it's
 * a discounted processing mode: `attributes.processing` other than
 * "standard", or a `batch-` / `flex-` / `cached-` / `cache-` id prefix.
 * Otherwise a half-price Batch tier silently becomes the headline (e.g.
 * gpt-5.5-pro: Batch $15/$90 vs list $30/$180). Context-length tiers
 * (`input-64k` / `input-256k`) stay eligible, so the lowest base rate wins
 * by convention.
 *
 * Identical to modelglass.com.au / the MCP tools (@modelglass/core
 * isHeadlineTier) and upstream modelglass-router-examples (pricing-math and
 * cost-aware-vscode-router's lib.ts). Keep them in sync by hand.
 */
export interface HasTierIdentity {
  id: string;
  attributes?: Record<string, unknown>;
}

const NON_HEADLINE_TIER_ID = /^(batch|flex|cached|cache)-/;

export function isHeadlineTier(tier: HasTierIdentity): boolean {
  const processing = tier.attributes?.processing;
  if (processing !== undefined && processing !== null && processing !== "standard") return false;
  return !NON_HEADLINE_TIER_ID.test(tier.id);
}
