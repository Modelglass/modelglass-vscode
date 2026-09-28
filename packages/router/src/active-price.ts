/**
 * SCO-663 — the current-price rule, shared by every pricing path (Run Task /
 * Modelglass Chat via routing-engine.ts, Route Task via lib.ts, Switch Check
 * via switch-check-lib.ts, and video / audio via media-routing-lib.ts), so the
 * four can't drift apart — same reasoning as headline-tier.ts (SCO-646).
 *
 * A row in a tier's append-only pricing[] history (ADR-0002) is current when
 * it has started (`effective_from <= today`), hasn't passed an explicit
 * `effective_to`, and no later-started row exists in the same
 * region/currency/unit (the later row implicitly supersedes it, even after
 * that later row has itself ended). When several rows are current (different
 * units), the latest wins. Null when nothing is current: a retired tier has no
 * current price.
 *
 * Before this, the copies took the FIRST row without an effective_to
 * (DeepSeek V4-Pro routed at its superseded $0.435 instead of $1.32), fell
 * back to the most recent row when all had ended, or read the LAST array
 * element (a retired tier kept its last price).
 *
 * Identical to modelglass.com.au / the API / the MCP tools (@modelglass/core
 * activePrice, SCO-661) and upstream modelglass-router-examples (pricing-math
 * and cost-aware-vscode-router's lib.ts, SCO-662). Keep them in sync by hand.
 */
export interface HasPriceWindow {
  unit: string;
  effective_from: string;
  effective_to?: string;
  currency?: string;
  region?: string;
}

export function activePrice<P extends HasPriceWindow>(
  pricing: readonly P[],
  today: string = new Date().toISOString().slice(0, 10),
): P | null {
  const scope = (p: HasPriceWindow) => `${p.region ?? "global"}\0${p.currency ?? "USD"}\0${p.unit}`;
  const started = pricing.filter((p) => p.effective_from <= today);
  const current = started.filter(
    (p) =>
      (!p.effective_to || p.effective_to >= today) &&
      !started.some((q) => q !== p && scope(q) === scope(p) && q.effective_from > p.effective_from),
  );
  current.sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  return current[current.length - 1] ?? null;
}
