import type { SupportedProvider } from "./provider-keys-lib.js";

/**
 * SCO-232 — client-side execution adapters. Fully vscode-free (no `vscode`
 * import anywhere in this file) so it's directly unit-testable via
 * monkey-patched global `fetch`, matching this repo's established
 * "vscode-free modules get node:test coverage" convention.
 *
 * ADR-0012: execution happens entirely client-side — the request goes
 * straight from this extension to the provider's own API using the user's
 * own key. No Modelglass proxy is anywhere in this request path.
 */

export type FailureKind =
  | "invalid-key"
  | "rate-limited"
  | "network-error"
  | "provider-error"
  | "unsupported-provider";

export class ProviderExecutionError extends Error {
  readonly kind: FailureKind;
  readonly provider: string;

  constructor(kind: FailureKind, provider: string, message: string) {
    super(message);
    this.name = "ProviderExecutionError";
    this.kind = kind;
    this.provider = provider;
  }
}

export interface ExecuteResult {
  text: string;
  modelIdUsed: string;
}

/**
 * Known gap, documented rather than silently assumed correct: the
 * Modelglass registry has no field for the literal provider-API model
 * identifier — `model.id` (`creator-org/model-name`) and the registry
 * `slug` are both internal Modelglass conventions. This heuristic strips
 * the `creator-org/` prefix by default, which matches OpenAI/DeepSeek/xAI/
 * Mistral/Groq's own model-string conventions closely enough to work for
 * their current lineups. Two known-unreliable cases:
 *  - OpenRouter expects the FULL `creator-org/model-name` string (its own
 *    routing convention happens to match Modelglass's `model.id` shape
 *    exactly) — handled as an explicit exception below, not a coincidence
 *    to rely on elsewhere.
 *  - Together AI's model strings don't reliably match either the stripped
 *    or full form (they carry their own suffixes/casing); Anthropic's real
 *    model strings are often date-suffixed (e.g. `claude-...-20250219`)
 *    which the registry doesn't track. Both are left as-is (best-effort
 *    strip) with the gap called out here and in the PR description — not
 *    papered over with an invented mapping table this module can't verify.
 */
export function resolveProviderModelId(provider: SupportedProvider, modelId: string): string {
  if (provider === "openrouter") return modelId;
  const slashIndex = modelId.indexOf("/");
  return slashIndex === -1 ? modelId : modelId.slice(slashIndex + 1);
}

interface OpenAiCompatibleConfig {
  baseUrl: string;
}

const OPENAI_COMPATIBLE: Partial<Record<SupportedProvider, OpenAiCompatibleConfig>> = {
  openai: { baseUrl: "https://api.openai.com/v1" },
  deepseek: { baseUrl: "https://api.deepseek.com" },
  xai: { baseUrl: "https://api.x.ai/v1" },
  mistral: { baseUrl: "https://api.mistral.ai/v1" },
  groq: { baseUrl: "https://api.groq.com/openai/v1" },
  "together-ai": { baseUrl: "https://api.together.ai/v1" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
};

function classifyHttpFailure(provider: string, status: number, bodyText: string): ProviderExecutionError {
  if (status === 401 || status === 403) {
    return new ProviderExecutionError("invalid-key", provider, `${provider} rejected the API key (HTTP ${status}).`);
  }
  if (status === 429) {
    return new ProviderExecutionError("rate-limited", provider, `${provider} is rate-limiting this key (HTTP 429).`);
  }
  return new ProviderExecutionError(
    "provider-error",
    provider,
    `${provider} returned HTTP ${status}: ${bodyText.slice(0, 300)}`,
  );
}

async function executeOpenAiCompatible(
  provider: SupportedProvider,
  config: OpenAiCompatibleConfig,
  apiKey: string,
  modelId: string,
  prompt: string,
): Promise<ExecuteResult> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    throw new ProviderExecutionError(
      "network-error",
      provider,
      e instanceof Error ? e.message : String(e),
    );
  }

  if (!response.ok) {
    throw classifyHttpFailure(provider, response.status, await response.text());
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new ProviderExecutionError("provider-error", provider, "Response had no choices[0].message.content.");
  }
  return { text, modelIdUsed: modelId };
}

async function executeAnthropic(apiKey: string, modelId: string, prompt: string): Promise<ExecuteResult> {
  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    throw new ProviderExecutionError("network-error", "anthropic", e instanceof Error ? e.message : String(e));
  }

  if (!response.ok) {
    throw classifyHttpFailure("anthropic", response.status, await response.text());
  }

  const json = (await response.json()) as { content?: Array<{ text?: string }> };
  const text = json.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new ProviderExecutionError("provider-error", "anthropic", "Response had no content[0].text.");
  }
  return { text, modelIdUsed: modelId };
}

/**
 * Runs `prompt` against `modelId` (a Modelglass `model.id`) using `apiKey`
 * for `provider`. Resolves the provider-specific model string via
 * `resolveProviderModelId` and dispatches to the matching adapter.
 */
export async function executeProviderCall(
  provider: SupportedProvider,
  apiKey: string,
  modelId: string,
  prompt: string,
): Promise<ExecuteResult> {
  const providerModelId = resolveProviderModelId(provider, modelId);

  if (provider === "anthropic") {
    return executeAnthropic(apiKey, providerModelId, prompt);
  }

  const config = OPENAI_COMPATIBLE[provider];
  if (!config) {
    throw new ProviderExecutionError("unsupported-provider", provider, `No execution adapter for "${provider}".`);
  }
  return executeOpenAiCompatible(provider, config, apiKey, providerModelId, prompt);
}
