import { MODELGLASS_API } from "./routing-engine.js";

/**
 * SCO-234 — Pro-tier gating, pure half (no `vscode` import — same lib/non-lib
 * split as every other module today) so it's directly unit-testable.
 * ./pro-gate.ts holds the one vscode-coupled piece (the upgrade prompt).
 *
 * GATING MECHANISM (item 4): checks against the SAME free Modelglass API key
 * already stored/managed by auth.ts — not a second credential. Confirmed by
 * reading packages/api's actual source in the main modelglass repo before
 * writing anything here: `KeyRecord.tier` (ADR-0004's Plan type:
 * free/starter/pro/internal/app) is the single source of truth per key, a
 * user upgrades via Stripe against their EXISTING key (ADR-0010), and
 * `POST /v1/keys/validate` (public, `{key}` -> `{valid, tier}`) is the one
 * client-facing endpoint that exposes it — its own doc comment names its
 * "primary consumer" as the iOS app's UnlockScreen, confirming this is a
 * genuinely reused mechanism, not a new one invented for this card.
 *
 * WHERE THE "iOS PATTERN" DOESN'T TRANSLATE, FLAGGED: the iOS app itself
 * does NOT do a client-side tier check anywhere (confirmed by reading its
 * source, modelglass-pro-ios) — it relies entirely on the API enforcing
 * different behavior server-side (e.g. the pricing-history gate) and never
 * asks "am I Pro?" to decide whether to show a feature. A VS Code command
 * genuinely needs that yes/no decision up front (to decide whether to even
 * attempt a Pro action, and to show an upgrade prompt instead of a
 * confusing failure) — there is no existing CLIENT gating pattern to mirror
 * for that specific need. What IS reused is the underlying DATA SOURCE
 * (`/v1/keys/validate`'s `tier` field) — the same one iOS calls, just for a
 * different purpose (confirming a key works before saving it, not tier
 * gating). This module is a new integration of that existing endpoint, not
 * a port of existing client logic that didn't exist to port.
 *
 * "app" tier deliberately does NOT count as Pro here, even though
 * require-news-access.ts (packages/api/src/middleware) broadens ITS gate to
 * include `app` alongside pro/internal. That broadening is a documented,
 * narrow exception for one feature (free news content for the iOS app's own
 * auto-provisioned, non-paid key) — it doesn't generalize. `app` is
 * literally "the ModelglassPro iOS app's auto-provisioned, non-paid tier"
 * (that middleware's own comment) — treating it as Pro-equivalent here
 * would mean anyone whose iOS app silently provisioned a free key could use
 * it to unlock paid VS Code features, which defeats this card's entire
 * purpose. Flagging this explicitly since "app" passing elsewhere might
 * look like a precedent to follow, but it isn't one that applies here.
 */

export type ProGateStatus =
  | { isPro: true; tier: string }
  | { isPro: false; reason: "not-pro"; tier: string }
  | { isPro: false; reason: "invalid-key" }
  | { isPro: false; reason: "no-modelglass-key" }
  | { isPro: false; reason: "network-error"; message: string };

const PRO_TIERS = new Set(["pro", "internal"]);

export function isProTierValue(tier: string): boolean {
  return PRO_TIERS.has(tier);
}

/**
 * SCO-260 quick-win #1 — this call had no bounded timeout: a hung Modelglass
 * API response left checkProAccess (and everything gated behind it in
 * run-task.ts) waiting indefinitely instead of failing open per its own
 * documented contract below. 15s, not provider-execute.ts's 60s: this is a
 * small metadata round-trip (one key validity check), not a model completion
 * whose latency depends on generation length.
 */
export const DEFAULT_PRO_GATE_TIMEOUT_MS = 15_000;

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/**
 * Calls the same public `POST /v1/keys/validate` endpoint the iOS app's
 * UnlockScreen uses, with the user's own free Modelglass API key (from
 * auth.ts), and classifies the result. `fetchImpl` is injectable so this is
 * testable without a live network call, same pattern as provider-execute.ts.
 */
export async function checkProAccess(
  apiKey: string,
  fetchImpl: typeof fetch,
  apiBaseUrl: string = MODELGLASS_API,
  timeoutMs: number = DEFAULT_PRO_GATE_TIMEOUT_MS,
): Promise<ProGateStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${apiBaseUrl}/v1/keys/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: apiKey }),
      signal: controller.signal,
    });
  } catch (e) {
    if (isAbortError(e)) {
      return { isPro: false, reason: "network-error", message: `timed out waiting for a response after ${timeoutMs}ms` };
    }
    return { isPro: false, reason: "network-error", message: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return { isPro: false, reason: "network-error", message: `HTTP ${response.status}` };
  }

  const json = (await response.json().catch(() => null)) as
    | { ok?: boolean; data?: { valid?: boolean; tier?: string } }
    | null;
  const data = json?.data;

  if (!data || data.valid !== true || typeof data.tier !== "string") {
    return { isPro: false, reason: "invalid-key" };
  }

  return isProTierValue(data.tier) ? { isPro: true, tier: data.tier } : { isPro: false, reason: "not-pro", tier: data.tier };
}

/**
 * Whether a Pro-gated action should proceed. Fails OPEN when tier couldn't
 * be determined at all (network error, or no Modelglass key to check
 * against) — deliberate, flagged design call: this is a client-side UX gate,
 * not a security boundary (nothing stops a user from bypassing client-side
 * logic in an extension running locally on their own machine), so the
 * failure asymmetry matters. Wrongly blocking a paying Pro user because of a
 * transient network hiccup — telling them to pay for something they already
 * pay for — is a worse mistake than wrongly allowing a few extra seconds of
 * Pro behavior for a tier we simply couldn't verify this instant. Only a
 * CONFIRMED non-Pro tier (a successful validate call reporting free/starter/
 * app) blocks the action.
 */
export function isGateSatisfied(status: ProGateStatus): boolean {
  if (status.isPro) return true;
  return status.reason === "network-error" || status.reason === "no-modelglass-key";
}

/** Gates an already-resolved value: returns it unchanged when the gate is
 *  satisfied, otherwise undefined. Used for routing-rules.json (SCO-231) —
 *  a Starter user's rule is discarded here, falling through to SCO-230's
 *  default ranking (resolveCategoryRanking's own contract for `rule ===
 *  undefined`), never erroring. */
export function proGatedValue<T>(status: ProGateStatus, value: T | undefined): T | undefined {
  return isGateSatisfied(status) ? value : undefined;
}

/** Gates the multi-key/fallback capability (SCO-233): returns every
 *  configured provider when the gate is satisfied, otherwise only the
 *  first — Starter's enforced ceiling (one key, one attempt, no fallback),
 *  regardless of how many keys happen to be stored (e.g. after a downgrade). */
export function selectProvidersForRun<T>(configuredProviders: T[], status: ProGateStatus): T[] {
  return isGateSatisfied(status) ? configuredProviders : configuredProviders.slice(0, 1);
}

/**
 * Whether adding `providerBeingAdded` would grow the configured set past a
 * single provider — the specific action SCO-233's "Add Provider API Key"
 * command must gate. Rotating an already-configured provider's own key, or
 * adding a first key from zero, is never gated (harmless / Starter's own
 * baseline capability) — only genuinely GROWING past one simultaneous
 * provider requires Pro.
 */
export function wouldExceedSingleKeyLimit(alreadyConfigured: string[], providerBeingAdded: string): boolean {
  return alreadyConfigured.length >= 1 && !alreadyConfigured.includes(providerBeingAdded);
}
