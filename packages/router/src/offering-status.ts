/**
 * SCO-633 — lifecycle filter shared by every routing path (Run Task /
 * Modelglass Chat via routing-engine.ts, Route Task via lib.ts, and video /
 * audio via media-routing-lib.ts), so the three can't drift apart.
 *
 * A `retired` offering can no longer be called on its provider's API (e.g.
 * Anthropic retired claude-sonnet-4-20250514 and claude-opus-4-20250514 on
 * 2026-06-15), so routing to one would only ever fail. Excluding it up front
 * is better than letting a BYOK request 404 and fall through the fallback
 * chain. And because a retired offering's price is closed out, its "latest"
 * price can still look cheap; a status check is the only reliable filter.
 *
 * `deprecated` stays routable: it still works until its retirement date, and
 * the registry marks it deprecated precisely so users can migrate on their
 * own schedule. Offerings with no `model.status` (older feed shapes, test
 * fixtures) are treated as routable.
 */
export interface HasLifecycle {
  model?: { status?: string } | null;
}

export function isRoutableOffering(offering: HasLifecycle): boolean {
  return offering.model?.status !== "retired";
}
