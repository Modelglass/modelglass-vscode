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
  | "unsupported-provider"
  | "model-not-found";

/**
 * SCO-331 — multi-turn conversation support. Every caller before this card
 * only ever sent one flattened user turn (Run Task has no conversation
 * memory at all), so `prompt` being a bare `string` was sufficient. The
 * vscode.lm chat surface hands this adapter a FULL conversation on every
 * call (system/user/assistant turns already interleaved by VS Code), which
 * a single string can't represent without losing role information.
 *
 * `prompt` widens to `string | ChatMessage[]` rather than becoming
 * `ChatMessage[]`-only, specifically so every existing call site (Run
 * Task's one-shot flow, and every existing test in this file and
 * run-task.test.ts) keeps compiling and passing completely unchanged --
 * `toMessages()` below normalises a bare string to the exact one-element
 * array those call sites already produced implicitly, so behavior for them
 * is provably identical, not just "probably fine."
 */
export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

function toMessages(prompt: string | ChatMessage[]): ChatMessage[] {
  return typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;
}

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

/**
 * SCO-260 quick-win #2 — both provider response shapes already carry token
 * usage; it was being parsed as far as `text` and discarded from there.
 * Optional because a provider response could theoretically omit or
 * malform the usage block — callers must not assume it's always present.
 */
export interface ExecuteUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ExecuteResult {
  text: string;
  modelIdUsed: string;
  usage?: ExecuteUsage;
  /** SCO-330 (fix #4 bonus) — true when the provider's own stop/finish
   *  reason says the response was cut off at the max-output-token limit,
   *  not because the model was actually done. Previously unchecked
   *  entirely for Anthropic (a hardcoded low max_tokens made this common
   *  and silent); undefined when the provider's response didn't include a
   *  usable stop/finish reason at all, which is not the same claim as
   *  "definitely not truncated" -- callers should treat undefined as
   *  unknown, not false. Matters more once (SCO-330 fix #4 itself) output
   *  streams straight into an editor document instead of an Output-channel
   *  log line: a silently truncated response there reads as a complete
   *  answer sitting in the user's editor. */
  truncated?: boolean;
}

/**
 * SCO-262 — ADR-0012 names "no response within a bounded timeout" as one of
 * the five classified failure kinds (folded into "network-error" — a
 * timeout and an unreachable host are the same signal to a fallback chain:
 * this provider isn't answering, try the next one), but nothing enforced it
 * until now: a hung request just hung, forever, never reaching the
 * catch/classify path that drives Pro's fallback chain at all.
 *
 * One global default rather than a per-category budget: every Run Task
 * category here is a single one-shot chat completion (not an agentic/
 * tool-calling loop — `agentic-multi-step` fans out to per-subtask leaf
 * calls elsewhere, each independently subject to this same timeout, see
 * run-task-lib.ts's header), so how long a call legitimately takes is
 * driven by the model's own generation speed and output length, not by
 * which of the nine task categories the caller picked. 60s is generous
 * enough for a slower/reasoning model's single completion while still
 * bounding how long Pro's fallback chain can hang on one dead provider
 * before advancing.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/**
 * SCO-283: the Modelglass registry now carries an explicit, optional
 * `provider_model_id` per offering — the real, provider-native model
 * string, set directly on the registry entry when the heuristic below
 * would derive the wrong thing. When present, it wins outright; the
 * heuristic never runs. This is the actual fix for the gap this function
 * used to just document -- see the two confirmed-live cases backfilled
 * with SCO-283: Together AI (Llama 4 Scout/Maverick/Qwen 2.5 72B are
 * NOT in Together's current serverless catalog at all -- deliberately
 * not backfilled, a bigger question than this field can answer alone)
 * and Qwen 3 235B-A22B on OpenRouter (registry model.id
 * `alibaba/qwen-3-235b-a22b` vs OpenRouter's real `qwen/qwen3-235b-a22b`
 * -- confirmed via a live fetch of OpenRouter's own /api/v1/models).
 *
 * Historical context, still accurate for every offering that HASN'T been
 * backfilled: the Modelglass registry previously had no field for the
 * literal provider-API model identifier at all — `model.id`
 * (`creator-org/model-name`) and the registry `slug` are both internal
 * Modelglass conventions. This heuristic strips the `creator-org/` prefix
 * by default, which matches OpenAI/DeepSeek/xAI/Mistral/Groq/Anthropic's
 * own model-string conventions closely enough to work for their current
 * lineups (Anthropic specifically: confirmed live 2026-07-22 that its
 * undated alias form, e.g. `claude-sonnet-5`, is a real supported string
 * — the stripped heuristic output happens to already be correct there).
 * OpenRouter is a documented exception: it expects the FULL
 * `creator-org/model-name` string by default (its own routing convention
 * happens to match Modelglass's `model.id` shape for some models) — that
 * fallback is still wrong for any OpenRouter offering without an explicit
 * `provider_model_id`, per the Qwen 3 235B case above.
 */
export function resolveProviderModelId(
  provider: SupportedProvider,
  modelId: string,
  explicitProviderModelId?: string,
): string {
  if (explicitProviderModelId) return explicitProviderModelId;
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

/**
 * ADR-0012 Amendment 1 (SCO-281) — a bad model string (the acknowledged
 * least-reliable case for Together AI/OpenRouter in resolveProviderModelId's
 * own header) is specific to that ONE model, not the provider or key, so it
 * needs to be distinguishable from a real provider-error: retrying a
 * different model on the SAME provider is likely to work, unlike every
 * other classified failure here. 404 is the clean, common signal every
 * REST-shaped provider here uses for an unknown model. Some providers
 * (Anthropic in particular) can validate a bad `model` field as a 400
 * instead of a clean 404 -- covered by a body-text pattern match rather
 * than assumed to only ever be a 404, per the ADR's own "or a
 * provider-specific 'model does not exist' error body where the HTTP
 * status alone is ambiguous" wording.
 */
const MODEL_NOT_FOUND_BODY_PATTERN = /model[^.]*(not[ _-]?found|does not exist|is not a valid model|invalid model)/i;

function classifyHttpFailure(provider: string, status: number, bodyText: string): ProviderExecutionError {
  if (status === 401 || status === 403) {
    return new ProviderExecutionError("invalid-key", provider, `${provider} rejected the API key (HTTP ${status}).`);
  }
  if (status === 429) {
    return new ProviderExecutionError("rate-limited", provider, `${provider} is rate-limiting this key (HTTP 429).`);
  }
  if (status === 404 || MODEL_NOT_FOUND_BODY_PATTERN.test(bodyText)) {
    return new ProviderExecutionError(
      "model-not-found",
      provider,
      `${provider} doesn't recognize this model string (HTTP ${status}): ${bodyText.slice(0, 300)}`,
    );
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
  prompt: string | ChatMessage[],
  timeoutMs: number,
): Promise<ExecuteResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        // OpenAI-compatible chat/completions accepts system/user/assistant
        // roles directly in one array -- no per-provider translation needed
        // here, unlike Anthropic below.
        messages: toMessages(prompt),
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (isAbortError(e)) {
      throw new ProviderExecutionError(
        "network-error",
        provider,
        `timed out waiting for a response after ${timeoutMs}ms`,
      );
    }
    throw new ProviderExecutionError(
      "network-error",
      provider,
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw classifyHttpFailure(provider, response.status, await response.text());
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new ProviderExecutionError("provider-error", provider, "Response had no choices[0].message.content.");
  }
  const usage =
    typeof json.usage?.prompt_tokens === "number" && typeof json.usage?.completion_tokens === "number"
      ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens }
      : undefined;
  // SCO-330 (fix #4 bonus) -- the OpenAI-compatible finish_reason equivalent
  // of Anthropic's stop_reason, same "length" == cut-off-by-limit meaning
  // across every provider behind this adapter (OpenAI, DeepSeek, xAI,
  // Mistral, Groq, Together AI, OpenRouter). A present-but-different reason
  // (e.g. "stop") is a real "no, it wasn't" -- only a genuinely absent
  // field collapses to unknown (undefined), not "stop".
  const finishReason = json.choices?.[0]?.finish_reason;
  const truncated = finishReason === undefined ? undefined : finishReason === "length";
  return { text, modelIdUsed: modelId, usage, truncated };
}

/**
 * SCO-625 -- the Messages API's `max_tokens` is a hard limit on ALL output,
 * thinking plus response text. It was 8192 when no Claude model thought by
 * default. Since Claude Opus 5 (thinking on by default when the request has
 * no `thinking` field) and Opus 5.5 (thinking always on, can't be disabled),
 * thinking tokens eat into that budget before any answer text is written.
 *
 * 16000: roughly double the old budget, and the value Anthropic's own
 * Opus 5 / 5.5 migration-guide examples use. It's under the lowest max
 * output of every Claude 4+ model (Opus 4 / 4.1 cap at 32K; the rest at
 * 64K-128K), so it can't trigger a "max_tokens exceeds the model limit"
 * 400. Only generated tokens are billed, so a higher cap doesn't cost more
 * on normal responses. Larger values buy little here: DEFAULT_PROVIDER_TIMEOUT_MS
 * (60s) usually ends a long generation before 16K tokens would. Anthropic
 * suggests 64K+ only for xhigh/max effort, which this adapter never sets.
 */
export const ANTHROPIC_MAX_TOKENS = 16_000;

/**
 * SCO-625 -- the reply's text, read by block `type`, never by position.
 * With thinking on, a response can begin with one or more `thinking`
 * blocks before the first `text` block (their `thinking` field is empty at
 * the default `display: "omitted"`). The old `content[0].text` read threw
 * on every such response: that's every Opus 5 request with no `thinking`
 * field and every Opus 5.5 request. Anthropic's Opus 5 migration guide
 * names exactly this pattern as one that "breaks on these responses".
 * Multiple text blocks (e.g. one split by citations) are concatenated in
 * order, the documented way to reassemble them. Non-text blocks
 * (`thinking`, `redacted_thinking`, anything newer) are ignored.
 * Returns undefined when there's no text block at all.
 */
export function anthropicResponseText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

async function executeAnthropic(
  apiKey: string,
  modelId: string,
  prompt: string | ChatMessage[],
  timeoutMs: number,
): Promise<ExecuteResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // SCO-331 -- unlike the OpenAI-compatible adapter, Anthropic's Messages API
  // doesn't accept a "system" role inside the messages array at all; it's a
  // separate top-level `system` string. Every prior caller only ever sent a
  // single user turn, so this split was never needed until the vscode.lm
  // surface started forwarding real conversations (which can include a
  // system turn). Multiple system messages (unusual, but not prevented by
  // the type) are joined -- Anthropic's `system` field is a single string.
  const allMessages = toMessages(prompt);
  const systemText = allMessages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const conversationMessages = allMessages
    .filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
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
        // SCO-330 (fix #4 bonus) made a cut-off response DETECTABLE (see
        // stop_reason parsing below). SCO-625 raised the cap itself now that
        // thinking tokens count against it -- see ANTHROPIC_MAX_TOKENS.
        max_tokens: ANTHROPIC_MAX_TOKENS,
        ...(systemText ? { system: systemText } : {}),
        messages: conversationMessages,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (isAbortError(e)) {
      throw new ProviderExecutionError(
        "network-error",
        "anthropic",
        `timed out waiting for a response after ${timeoutMs}ms`,
      );
    }
    throw new ProviderExecutionError("network-error", "anthropic", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw classifyHttpFailure("anthropic", response.status, await response.text());
  }

  const json = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };
  const text = anthropicResponseText(json.content);
  if (text === undefined) {
    const blockTypes = Array.isArray(json.content)
      ? json.content.map((b) => b?.type ?? "untyped").join(", ") || "none"
      : "none";
    const reason = json.stop_reason ?? "unknown";
    const hint =
      reason === "max_tokens"
        ? " The output limit was used up (most likely by thinking) before any answer text was written."
        : reason === "refusal"
          ? " The model declined the request."
          : "";
    throw new ProviderExecutionError(
      "provider-error",
      "anthropic",
      `Response had no text content block (stop_reason: ${reason}; blocks: ${blockTypes}).${hint}`,
    );
  }
  const usage =
    typeof json.usage?.input_tokens === "number" && typeof json.usage?.output_tokens === "number"
      ? { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens }
      : undefined;
  // SCO-330 (fix #4 bonus) -- "max_tokens" is Anthropic's stop_reason value
  // for exactly this cutoff; any other present reason (e.g. "end_turn") is
  // a real "no," only a genuinely absent field is unknown.
  const truncated = json.stop_reason === undefined ? undefined : json.stop_reason === "max_tokens";
  return { text, modelIdUsed: modelId, usage, truncated };
}

/**
 * Runs `prompt` against `modelId` (a Modelglass `model.id`) using `apiKey`
 * for `provider`. Resolves the provider-specific model string via
 * `resolveProviderModelId` — preferring `explicitProviderModelId` (SCO-283,
 * threaded from the registry offering's own `provider_model_id`) when the
 * caller has one — and dispatches to the matching adapter.
 */
export async function executeProviderCall(
  provider: SupportedProvider,
  apiKey: string,
  modelId: string,
  prompt: string | ChatMessage[],
  timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
  explicitProviderModelId?: string,
): Promise<ExecuteResult> {
  const providerModelId = resolveProviderModelId(provider, modelId, explicitProviderModelId);

  if (provider === "anthropic") {
    return executeAnthropic(apiKey, providerModelId, prompt, timeoutMs);
  }

  const config = OPENAI_COMPATIBLE[provider];
  if (!config) {
    throw new ProviderExecutionError("unsupported-provider", provider, `No execution adapter for "${provider}".`);
  }
  return executeOpenAiCompatible(provider, config, apiKey, providerModelId, prompt, timeoutMs);
}
