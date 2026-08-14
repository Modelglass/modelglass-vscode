import * as vscode from "vscode";
import { ensureApiKey, output, peekApiKey } from "@modelglass/vscode-shared";
import { getConfiguredProviders } from "./provider-keys-lib.js";
import { checkProAccess, isGateSatisfied, proGatedValue, selectProvidersForRun } from "./pro-gate-lib.js";
import { loadRoutingRules } from "./routing-rules.js";
import { CATEGORY_LABELS, fetchRoutableModels, routeAndExecuteWithFallback } from "./run-task-lib.js";
import {
  approximateTokenCount,
  buildPseudoModels,
  categoryForPseudoModelId,
  describeChatOutcome,
  toChatMessages,
  type MinimalChatMessage,
  type PseudoModelInfo,
} from "./lm-provider-lib.js";
import type { RoutableModel } from "./routing-engine.js";
import type { SupportedProvider } from "./provider-keys-lib.js";

/**
 * SCO-331 — vscode.lm `LanguageModelChatProvider` registration, the thin
 * vscode-coupled half (see ./lm-provider-lib.ts's header for the pure logic
 * this wraps, and its own SCO-331 notes for the verified API findings this
 * implements against). Not unit-tested directly — same "no Extension Host
 * harness" convention as every other vscode-coupled command wrapper in this
 * repo (extension.ts, provider-keys.ts, run-task.ts).
 *
 * Registered under a single vendor ("modelglass") exposing 9 pseudo-models,
 * one per `LeafTaskCategory` (Scott's decision, 2026-07-29: no classifier —
 * matches the router's existing light-touch philosophy, accepting some
 * picker clutter as the tradeoff). Each pseudo-model's
 * `provideLanguageModelChatResponse` call reuses the EXACT SAME
 * `routeAndExecuteWithFallback` orchestration (ranking, Pro/Starter
 * fallback chain, tier gating, ADR-0012-compliant client-side execution)
 * Run Task already uses — this is a new entry point into that logic, not a
 * parallel reimplementation of it.
 *
 * v1 scope, deliberately: text-only (no tool calling, no image input — see
 * `toInformation`'s `capabilities: {}`), non-streaming (one
 * `progress.report()` call per response — confirmed acceptable by VS Code's
 * own official sample, see SCO-331's Linear card), and no deep
 * `CancellationToken` propagation into the underlying fetch/execute chain
 * (checked once before reporting the final result, not threaded through
 * every network call) — all named as later, separate follow-ups, not
 * silently dropped.
 */

const VENDOR = "modelglass";

function extractText(part: unknown): string | undefined {
  return part instanceof vscode.LanguageModelTextPart ? part.value : undefined;
}

/** VS Code's own chat message role enum has exactly two values (User,
 *  Assistant) — no "system" role exists on the wire from Copilot Chat's
 *  side, unlike provider-execute.ts's ChatMessage type (which supports
 *  "system" for cases where THIS extension wants to inject its own system
 *  prompt later — not done in this pass). Every incoming vscode message
 *  therefore maps to "user" or "assistant", never "system". */
function toMinimalMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): MinimalChatMessage[] {
  return messages.map((m) => ({
    role: m.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user",
    // v1 is text-only (see file header) — tool-call/tool-result/data parts
    // are silently skipped here, not mishandled; a message with only
    // non-text parts maps to an empty string rather than throwing, since a
    // pure tool-turn with no text is a real (if currently unsupported)
    // shape this shouldn't crash on.
    text: m.content
      .map((part) => extractText(part))
      .filter((t): t is string => t !== undefined)
      .join("\n"),
  }));
}

/** A conservative, SHARED ceiling across all 9 pseudo-models rather than a
 *  per-underlying-model figure — genuinely can't be exact up front, since
 *  which real model actually answers a given pseudo-model is decided
 *  per-call by the router, not fixed at registration time. 128K covers
 *  every currently-supported provider's typical context window without
 *  overselling; maxOutputTokens matches provider-execute.ts's own Anthropic
 *  max_tokens ceiling (8192) so this at least isn't inconsistent with what
 *  the adapters actually request. */
const SHARED_MAX_INPUT_TOKENS = 128_000;
const SHARED_MAX_OUTPUT_TOKENS = 8_192;

function toInformation(p: PseudoModelInfo): vscode.LanguageModelChatInformation {
  return {
    id: p.id,
    name: p.name,
    family: "modelglass-router",
    version: "1.0.0",
    tooltip: p.description,
    detail: p.routableCount > 0 ? `${p.routableCount} model(s) routable today` : "no routable model right now",
    maxInputTokens: SHARED_MAX_INPUT_TOKENS,
    maxOutputTokens: SHARED_MAX_OUTPUT_TOKENS,
    // v1: text-only, no tool calling, no image input (file header).
    capabilities: {},
  };
}

export class ModelglassChatProvider implements vscode.LanguageModelChatProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Always returns all 9 entries, regardless of configured-key state (SCO-332
   * principle: never hide, always surface the why) — a zero-configured-key
   * user sees them annotated as non-routable rather than seeing nothing at
   * all, which would look like the extension doesn't work inside Copilot
   * Chat rather than "you haven't set a provider key yet."
   *
   * Never provisions or prompts (`peekApiKey`, not `ensureApiKey`) — this can
   * be called with `options.silent: true` for a background model-list
   * refresh, and popping a dialog at an arbitrary unprompted moment would be
   * poor UX. Best-effort throughout: any fetch failure here just falls back
   * to a routable-count-free listing rather than failing the whole picker.
   */
  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const configuredProviders = (await getConfiguredProviders(this.context.secrets)).map((c) => c.provider);

    const modelglassApiKey = await peekApiKey(this.context);
    if (!modelglassApiKey) {
      return buildPseudoModels([], configuredProviders).map(toInformation);
    }

    let allModels: RoutableModel[] = [];
    try {
      allModels = await fetchRoutableModels(modelglassApiKey);
    } catch (e) {
      output.appendLine(
        `[lm-provider] couldn't fetch model data for the chat-provider model list (${e instanceof Error ? e.message : String(e)}) — listing without live routable-count annotations this time.`,
      );
    }

    return buildPseudoModels(allModels, configuredProviders).map(toInformation);
  }

  /**
   * The actual call. Resolves which category the user picked (from
   * `model.id`), then routes through the EXACT SAME
   * `routeAndExecuteWithFallback` Run Task uses — same ranking, same
   * Pro/Starter fallback chain, same tier gating, same
   * `.modelglass/routing-rules.json` support. A genuinely user-initiated
   * moment (the user sent a chat message), so `ensureApiKey` (which may
   * provision/prompt) is appropriate here, unlike
   * `provideLanguageModelChatInformation` above.
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const category = categoryForPseudoModelId(model.id);
    if (!category) {
      progress.report(new vscode.LanguageModelTextPart(`Modelglass: unrecognized model id "${model.id}".`));
      return;
    }
    const categoryLabel = CATEGORY_LABELS[category];

    const configuredProviders = await getConfiguredProviders(this.context.secrets);
    if (configuredProviders.length === 0) {
      progress.report(
        new vscode.LanguageModelTextPart(
          'Modelglass: no provider API key is configured yet. Run "Modelglass: Set Provider API Key" first.',
        ),
      );
      return;
    }

    const modelglassApiKey = await ensureApiKey(this.context);
    if (!modelglassApiKey) return; // user declined every recovery option, same as run-task.ts's identical check

    let allModels: RoutableModel[];
    try {
      allModels = await fetchRoutableModels(modelglassApiKey, undefined, undefined, (message) =>
        output.appendLine(`[lm-provider] ${message}`),
      );
    } catch (e) {
      progress.report(
        new vscode.LanguageModelTextPart(
          `Modelglass: couldn't fetch model data (${e instanceof Error ? e.message : String(e)}).`,
        ),
      );
      return;
    }

    if (token.isCancellationRequested) return; // cancelled while fetching -- nothing more to do

    const proStatus = await checkProAccess(modelglassApiKey, fetch);
    const rules = await loadRoutingRules();
    const loadedRule = rules.found ? rules.rulesByCategory.get(category) : undefined;
    const rule = proGatedValue(proStatus, loadedRule);
    const providersForThisRun = selectProvidersForRun(
      configuredProviders as { provider: SupportedProvider; apiKey: string }[],
      proStatus,
    );

    const chatMessages = toChatMessages(toMinimalMessages(messages));

    const outcome = await routeAndExecuteWithFallback(
      allModels,
      providersForThisRun,
      category,
      chatMessages,
      undefined,
      rule,
      isGateSatisfied(proStatus),
    );

    if (token.isCancellationRequested) return; // cancelled during execution -- reporting now would be pointless

    const result = describeChatOutcome(outcome, categoryLabel);
    progress.report(new vscode.LanguageModelTextPart(result.text));
  }

  /**
   * No unified tokenizer exists across the 7 supported providers (see
   * lm-provider-lib.ts's `approximateTokenCount` header) — this is
   * advisory, not billing-accurate, same caveat as that function.
   */
  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === "string") return approximateTokenCount(text);
    const combined = text.content
      .map((part) => extractText(part))
      .filter((t): t is string => t !== undefined)
      .join("\n");
    return approximateTokenCount(combined);
  }
}

/**
 * Registers the provider, defensively: `vscode.lm.registerLanguageModelChatProvider`
 * requires a recent VS Code (confirmed via the installed @types/vscode@1.125.0
 * that this is now a STABLE, non-proposed API as of ~1.104 — see SCO-331's
 * Linear card for the full verification trail, which corrected an earlier,
 * unconfirmed "still proposed" assumption). Feature-detected and
 * try/catch-guarded anyway: an older VS Code install simply won't have this
 * function at all, and registration failing for any other reason must never
 * take down activation — every other command (Route Task, Run Task, Compare
 * Two Models, key management) has to keep working regardless.
 */
export function registerModelglassChatProvider(context: vscode.ExtensionContext): void {
  if (typeof vscode.lm.registerLanguageModelChatProvider !== "function") {
    output.appendLine(
      "[lm-provider] vscode.lm.registerLanguageModelChatProvider isn't available on this VS Code version — " +
        "skipping the Copilot Chat integration this run. Every other Modelglass command is unaffected.",
    );
    return;
  }

  try {
    context.subscriptions.push(
      vscode.lm.registerLanguageModelChatProvider(VENDOR, new ModelglassChatProvider(context)),
    );
    output.appendLine(`[lm-provider] registered the Modelglass router as a vscode.lm chat provider (vendor: ${VENDOR}).`);
  } catch (e) {
    output.appendLine(
      `[lm-provider] failed to register the Copilot Chat provider (${e instanceof Error ? e.message : String(e)}) — ` +
        "every other Modelglass command is unaffected.",
    );
  }
}
