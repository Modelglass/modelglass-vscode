/**
 * SCO-430 — key storage for the video/audio generation providers (Runway,
 * ElevenLabs). Deliberately a SEPARATE module from ./provider-keys-lib.ts,
 * not an extension of SUPPORTED_PROVIDERS there — checked directly against
 * that file's actual semantics before reusing it:
 *
 * provider-keys-lib.ts's `setProviderKeyValue` enforces Starter's coding-
 * router single-key EXCLUSIVITY invariant — storing a new provider's key
 * clears every other configured provider's key. That invariant exists for
 * ONE reason: the LLM fallback chain (ADR-0012 Decision 1/SCO-233) needs a
 * single, unambiguous "which provider(s) is Run Task allowed to try"
 * answer. It has nothing to do with video/audio generation, which (per
 * ADR-0012 Amendment 2 Decision 6) has NO fallback chain at all, for any
 * tier — there is exactly one supported provider per modality in this
 * ticket's scope (Runway for video, ElevenLabs for audio), so there is
 * nothing to chain or exclude between. Naively adding "runway"/"elevenlabs"
 * to SUPPORTED_PROVIDERS would be an active bug: configuring a Runway key
 * would silently wipe a user's already-configured OpenAI/Anthropic/etc. key
 * (and vice versa) via that exclusivity clear-loop, even though the two
 * capabilities are unrelated. A user very plausibly wants a coding-router
 * key AND a Runway key AND an ElevenLabs key all configured simultaneously.
 *
 * Reuses the exact same underlying mechanism (VS Code `SecretStorage`,
 * ADR-0012 Decision 2) and the same `SecretStore` structural interface as
 * provider-keys-lib.ts, just with its own namespace
 * (`modelglass.mediaProviderKey.<provider-id>`) and no cross-provider
 * clearing — each media provider's key is stored and cleared independently.
 * No `vscode` import here (same lib/non-lib split as every other module in
 * this repo) so this is directly unit-testable with a plain in-memory fake.
 */

export const MEDIA_PROVIDERS = ["runway", "elevenlabs"] as const;

export type MediaProvider = (typeof MEDIA_PROVIDERS)[number];

export const MEDIA_PROVIDER_LABELS: Record<MediaProvider, string> = {
  runway: "Runway",
  elevenlabs: "ElevenLabs",
};

function secretKeyFor(provider: MediaProvider): string {
  return `modelglass.mediaProviderKey.${provider}`;
}

/** Same minimal shape provider-keys-lib.ts's SecretStore names — structurally
 *  compatible with vscode.SecretStorage without importing vscode. */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export async function getMediaProviderKey(
  secrets: SecretStore,
  provider: MediaProvider,
): Promise<string | undefined> {
  return secrets.get(secretKeyFor(provider));
}

/** Stores `provider`'s key. Never touches any other provider's slot — no
 *  exclusivity, unlike provider-keys-lib.ts's setProviderKeyValue (see this
 *  file's header for why that invariant doesn't apply here). */
export async function setMediaProviderKey(
  secrets: SecretStore,
  provider: MediaProvider,
  apiKey: string,
): Promise<void> {
  await secrets.store(secretKeyFor(provider), apiKey.trim());
}

export async function clearMediaProviderKey(secrets: SecretStore, provider: MediaProvider): Promise<void> {
  await secrets.delete(secretKeyFor(provider));
}
