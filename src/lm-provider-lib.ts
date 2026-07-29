/**
 * SCO-331 — vscode.lm `LanguageModelChatProvider` registration, pure half.
 * No `vscode` import anywhere in this file (same lib/non-lib split as every
 * other module in this repo — auth.ts/lib.ts, provider-keys.ts/-lib.ts,
 * pro-gate.ts/-lib.ts) so it's directly unit-testable; the vscode-coupled
 * provider class lives in ./lm-provider.ts.
 *
 * Spike findings this implements (see SCO-331's Linear card for the full
 * verified findings, checked directly against Microsoft's own docs, the
 * proposed chatProvider.d.ts source, and the official sample extension's
 * real source — not summarized secondhand):
 *
 * - Streaming is NOT mandatory (the official sample calls `progress.report`
 *   exactly once per response) — this module produces one complete text
 *   result per call, same shape `provider-execute.ts`'s adapters already
 *   return. A real token-by-token streaming rewrite is a later, separate
 *   pass, not required to ship v1.
 * - Copilot Chat has no structured task-category input — free text in, free
 *   text out. Per Scott's decision (2026-07-29), this is closed via the
 *   **9-pseudo-model approach**: one selectable "model" per
 *   `LeafTaskCategory`, using the API's native one-provider-to-many-models
 *   support (confirmed via the official sample's own Dog/Cat two-model
 *   example) — no classifier, no new cost/latency/complexity, matching the
 *   router's existing light-touch philosophy. Some picker clutter (9
 *   entries) is the accepted tradeoff.
 * - Copilot Chat forwards the FULL conversation on every call, unlike Run
 *   Task (which has never sent more than one turn) — `toChatMessages` below
 *   is the new mapping layer, feeding `provider-execute.ts`'s newly-widened
 *   `ChatMessage[]` support (see that file's SCO-331 notes).
 */

import {
  CATEGORY_LABELS,
  LEAF_CATEGORIES,
  describeAttempt,
  type ConfiguredProviderKey,
  type FallbackOutcome,
} from "./run-task-lib.js";
import { rankModelsForCategory, type LeafTaskCategory, type RoutableModel } from "./routing-engine.js";
import type { SupportedProvider } from "./provider-keys-lib.js";
import type { ChatMessage, ChatRole } from "./provider-execute.js";
import { INDUSTRY_WIDE_GAP_NOTE } from "./capability-preview-lib.js";

// ---------------------------------------------------------------------------
// Pseudo-model identity — one "model" per LeafTaskCategory.
// ---------------------------------------------------------------------------

/** vscode.lm model ids are opaque strings scoped to this extension's own
 *  vendor namespace — no collision risk with any other provider's ids, so a
 *  simple, readable prefix is all this needs (no hashing/encoding). */
export const PSEUDO_MODEL_PREFIX = "modelglass-";

export function pseudoModelId(category: LeafTaskCategory): string {
  return `${PSEUDO_MODEL_PREFIX}${category}`;
}

/** Inverse of pseudoModelId — undefined for any id this provider didn't
 *  itself mint (defensive: `provideLanguageModelChatResponse` receives back
 *  whichever `LanguageModelChatInformation.id` VS Code says the user picked,
 *  which should always be one of ours, but "should always be" isn't the
 *  same guarantee as a checked round-trip). */
export function categoryForPseudoModelId(id: string): LeafTaskCategory | undefined {
  if (!id.startsWith(PSEUDO_MODEL_PREFIX)) return undefined;
  const category = id.slice(PSEUDO_MODEL_PREFIX.length);
  return (LEAF_CATEGORIES as readonly string[]).includes(category) ? (category as LeafTaskCategory) : undefined;
}

/**
 * A provider-agnostic description of one pseudo-model — deliberately NOT
 * `vscode.LanguageModelChatInformation` itself (this module has no `vscode`
 * import at all); `lm-provider.ts` maps this onto the real type. Keeping the
 * "what should this say" decision here, pure and tested, and the "how does
 * vscode's exact interface want it shaped" decision there, matches this
 * repo's established split.
 */
export interface PseudoModelInfo {
  id: string;
  category: LeafTaskCategory;
  name: string;
  /** SCO-332 — folded in here rather than bolted on separately: a
   *  zero-routable category is annotated in its own description (visible
   *  in the model picker itself, the actual decision point), reusing the
   *  exact same routability computation and industry-wide-gap note the
   *  Output-channel preview and Run Task's category QuickPick also use —
   *  one source of truth, surfaced in a third place, not a fourth
   *  independent copy. */
  description: string;
  routableCount: number;
}

/**
 * Builds all 9 pseudo-models, each annotated with how many models are
 * actually routable for it across the CURRENTLY CONFIGURED provider(s) —
 * mirrors `routeAndExecuteWithFallback`'s own combined-pool computation
 * (run-task-lib.ts: filter to configured providers, then rank once) so this
 * preview can't drift from what a real call will actually do.
 */
export function buildPseudoModels(
  allModels: RoutableModel[],
  configuredProviders: SupportedProvider[],
): PseudoModelInfo[] {
  const configuredSet = new Set(configuredProviders);
  const pool = allModels.filter((m) => configuredSet.has(m.provider as SupportedProvider));

  return LEAF_CATEGORIES.map((category) => {
    const routableCount = rankModelsForCategory(pool, category).ranked.length;
    const label = CATEGORY_LABELS[category];
    const gapNote = INDUSTRY_WIDE_GAP_NOTE[category];

    const description =
      routableCount > 0
        ? `Modelglass router: ${label}. Routes to the top-ranked of ${routableCount} model(s) from your configured provider(s).`
        : `Modelglass router: ${label}. No routable model for your configured provider(s) right now` +
          (gapNote ? ` (${gapNote})` : "") +
          ".";

    return { id: pseudoModelId(category), category, name: `Modelglass: ${label}`, description, routableCount };
  });
}

// ---------------------------------------------------------------------------
// Conversation mapping (SCO-331's multi-turn gap).
// ---------------------------------------------------------------------------

/**
 * The minimal shape this module needs from a vscode chat message — already
 * reduced to plain role + flattened text by the thin vscode-coupled caller
 * (which extracts text from vscode's richer `LanguageModelTextPart`/tool-call
 * union). v1 is text-only, matching every other command in this extension —
 * tool-call/tool-result parts are out of scope for this pass, not silently
 * mishandled: `lm-provider.ts` filters to text parts before calling this.
 */
export interface MinimalChatMessage {
  role: ChatRole;
  text: string;
}

/** Maps a normalised vscode conversation onto `provider-execute.ts`'s
 *  `ChatMessage[]` — a rename of the field (`text` -> `content`), not a
 *  transformation; kept as its own function (rather than inlined at the
 *  call site) so it's independently testable and the naming seam is
 *  explicit about where "vscode's shape" ends and "provider-execute.ts's
 *  shape" begins. */
export function toChatMessages(messages: MinimalChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.text }));
}

// ---------------------------------------------------------------------------
// Approximate token counting (provideTokenCount).
// ---------------------------------------------------------------------------

/**
 * No unified tokenizer exists across the 7 supported providers' different
 * tokenization schemes (OpenAI's tiktoken, Anthropic's own, etc.) — this is
 * a documented approximation, not a precise count, same ~4-chars/token
 * ratio `run-task-lib.ts`'s `MAX_CONTEXT_CHARS` comment already uses
 * elsewhere in this codebase. Good enough for vscode.lm's own
 * budget-management use of `provideTokenCount` (it's advisory, not
 * billing-accurate); a genuinely precise per-provider count is out of scope
 * for this pass.
 */
export function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Turning a routing outcome into what the chat surface should show.
// ---------------------------------------------------------------------------

export type ChatOutcome = { kind: "success"; text: string } | { kind: "error"; text: string };

/**
 * Converts `routeAndExecuteWithFallback`'s own `FallbackOutcome` (unchanged,
 * reused as-is — see this file's header) into exactly one chat-surface
 * message. Pure/tested mirror of `run-task.ts`'s existing switch-on-outcome
 * handling for the Command Palette path — deliberately a SEPARATE function
 * rather than a shared one, since the two surfaces render failure very
 * differently (Run Task: Output-channel log lines + a `showErrorMessage`
 * with action buttons; chat: a single response string, no buttons, no
 * separate output channel to point to) — forcing them through one shared
 * renderer would need surface-specific branches inside it anyway, so two
 * small pure functions reading their own outcome is clearer than one that
 * takes a "which surface" flag.
 */
export function describeChatOutcome(outcome: FallbackOutcome, categoryLabel: string): ChatOutcome {
  switch (outcome.outcome) {
    case "no-configured-providers":
      return {
        kind: "error",
        text: `Modelglass: no provider API key is configured yet. Run "Modelglass: Set Provider API Key" first.`,
      };
    case "no-ranked-models":
      return {
        kind: "error",
        text: `Modelglass: none of your configured providers' models have scoring data for "${categoryLabel}" right now.`,
      };
    case "all-providers-failed": {
      const summary = outcome.attempts.map((a) => `${a.provider}: ${describeAttempt(a)}`).join("; ");
      return {
        kind: "error",
        text: `Modelglass: tried ${outcome.attempts.length} configured provider(s) for "${categoryLabel}" — all failed (${summary}).`,
      };
    }
    case "success": {
      const fallbackNote =
        outcome.attempts.length > 1 ? ` (after ${outcome.attempts.length - 1} provider fallback(s))` : "";
      const ruleNote = outcome.ruleApplied ? " — .modelglass/routing-rules.json override applied" : "";
      return {
        kind: "success",
        text:
          `${outcome.execution.text}\n\n` +
          `---\n*Modelglass: ${categoryLabel} → ${outcome.topModel.name}${fallbackNote}${ruleNote}, selected on ${outcome.scoreLabel}.*`,
      };
    }
  }
}

export type { ConfiguredProviderKey };
