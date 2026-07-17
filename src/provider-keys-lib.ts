/**
 * SCO-232 — Starter-tier provider key storage, pure half. No `vscode` import
 * anywhere in this file (same lib/non-lib split as lib.ts/switch-check-lib.ts)
 * so it's directly unit-testable; the vscode-coupled prompting UI lives in
 * ./provider-keys.ts.
 *
 * Follows auth.ts's existing SecretStorage pattern exactly (ADR-0012 names
 * this as the established convention) rather than introducing a second
 * storage approach. Namespaced per provider
 * (`modelglass.providerKey.<provider-id>`), exactly the pattern ADR-0012
 * itself specifies.
 *
 * Starter is explicitly single-key (SCO-232's own scope: "one key, automated
 * routing, nothing configurable") — enforced here, not left as an accidental
 * property: setting a new provider's key clears any previously-configured
 * different provider's key, so `getConfiguredProvider()` never has to guess
 * which of several stored keys is "the" one. This is NOT the multi-key
 * storage SCO-233 (Pro) will need — no hook or extension point for that is
 * added here, per the card's explicit instruction not to invite it.
 */

/**
 * Providers with a real execution adapter (provider-execute.ts) — deliberately
 * NOT every provider in the Modelglass registry. Google/Cohere/MiniMax/Qwen/
 * Meta all have genuinely different API shapes (or, for Qwen/Meta, are
 * typically only reached via a hosting platform in this registry, not a
 * direct API of their own) with no adapter built for them yet. Restricting
 * the setup picker to this list rather than every registry provider avoids a
 * dead-end setup — storing a key for a provider that can never execute would
 * be a confusing trap, not a feature.
 */
export const SUPPORTED_PROVIDERS = [
  "openai",
  "anthropic",
  "deepseek",
  "xai",
  "mistral",
  "groq",
  "together-ai",
  "openrouter",
] as const;

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<SupportedProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  xai: "xAI (Grok)",
  mistral: "Mistral AI",
  groq: "Groq",
  "together-ai": "Together AI",
  openrouter: "OpenRouter",
};

function secretKeyFor(provider: SupportedProvider): string {
  return `modelglass.providerKey.${provider}`;
}

/**
 * The minimal shape this module actually needs from `vscode.SecretStorage` —
 * structurally compatible with the real thing (so `context.secrets` satisfies
 * it directly) but not importing `vscode` itself, so the storage functions
 * below are unit-testable with a plain in-memory fake.
 */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

/** The one provider currently configured, and its key — or undefined if none
 *  is set. Scans all supported providers' secret slots; the single-key
 *  invariant (enforced by setProviderKeyValue below) means at most one will
 *  ever be found, but this doesn't assume that itself — it returns the
 *  first match and stops, rather than trusting the invariant blindly. */
export async function getConfiguredProvider(
  secrets: SecretStore,
): Promise<{ provider: SupportedProvider; apiKey: string } | undefined> {
  for (const provider of SUPPORTED_PROVIDERS) {
    const apiKey = await secrets.get(secretKeyFor(provider));
    if (apiKey) return { provider, apiKey };
  }
  return undefined;
}

export async function getProviderKey(
  secrets: SecretStore,
  provider: SupportedProvider,
): Promise<string | undefined> {
  return secrets.get(secretKeyFor(provider));
}

/**
 * Stores a key for `provider`, first clearing every OTHER supported
 * provider's stored key — the single-key enforcement. Returns the provider
 * that was previously configured (if any, and if different), so a caller
 * can tell the user what changed.
 */
export async function setProviderKeyValue(
  secrets: SecretStore,
  provider: SupportedProvider,
  apiKey: string,
): Promise<{ replaced: SupportedProvider | null }> {
  let replaced: SupportedProvider | null = null;
  for (const other of SUPPORTED_PROVIDERS) {
    if (other === provider) continue;
    const existing = await secrets.get(secretKeyFor(other));
    if (existing) {
      await secrets.delete(secretKeyFor(other));
      replaced = other;
    }
  }
  await secrets.store(secretKeyFor(provider), apiKey.trim());
  return { replaced };
}

export async function clearProviderKey(secrets: SecretStore, provider: SupportedProvider): Promise<void> {
  await secrets.delete(secretKeyFor(provider));
}
