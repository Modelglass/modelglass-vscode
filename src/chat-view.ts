import * as vscode from "vscode";
import { ensureApiKey, output } from "./auth.js";
import { getConfiguredProviders } from "./provider-keys-lib.js";
import { checkProAccess, isFreeTierExcluded, isGateSatisfied, proGatedValue, selectProvidersForRun } from "./pro-gate-lib.js";
import { loadRoutingRules } from "./routing-rules.js";
import { CATEGORY_LABELS, fetchRoutableModels, routeAndExecuteWithFallback } from "./run-task-lib.js";
import { describeChatOutcome, toChatMessages } from "./lm-provider-lib.js";
import { CHAT_VIEW_ID, generateNonce, getWebviewHtml, parseChatSendMessage, type ChatResponseMessage } from "./chat-view-lib.js";
import type { RoutableModel } from "./routing-engine.js";
import type { SupportedProvider } from "./provider-keys-lib.js";

/**
 * SCO-378 — vscode-coupled half (see ./chat-view-lib.ts's header for the
 * pure message contract this wraps). Not unit-tested directly — same "no
 * Extension Host harness" convention as extension.ts/lm-provider.ts/
 * run-task.ts.
 *
 * `handleChatSendMessage` is essentially a webview-flavored rewrite of
 * lm-provider.ts's `provideLanguageModelChatResponse` — same call into
 * `routeAndExecuteWithFallback` (run-task-lib.ts), same
 * checkProAccess/proGatedValue/selectProvidersForRun/isGateSatisfied
 * sequence, just swapping the vscode.lm progress-reporting adapter for a
 * `webview.postMessage` one. routing-engine.ts/run-task-lib.ts/
 * provider-execute.ts needed no changes — already fully decoupled from
 * vscode types.
 *
 * One addition beyond the lm-provider.ts template: SCO-381's recorded
 * decision (Starter+Pro, not Free) is checked FIRST, before any of the
 * per-provider gating below — `isFreeTierExcluded` blocks the whole
 * feature for a confirmed Free tier, where `isGateSatisfied` only narrows
 * *within* an already-permitted call (single-provider Starter vs.
 * multi-provider Pro). Applying it here, not left for a later pass, per
 * this card's explicit "don't leave it ungated by default" requirement.
 */
export class ModelglassChatViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.html = getWebviewHtml(webviewView.webview.cspSource, generateNonce());

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      void this.handleChatSendMessage(webviewView.webview, raw);
    });
  }

  private async handleChatSendMessage(webview: vscode.Webview, raw: unknown): Promise<void> {
    const parsed = parseChatSendMessage(raw);
    if (!parsed.valid) {
      webview.postMessage({ type: "chatResponse", kind: "error", text: `Modelglass: ${parsed.error}` } satisfies ChatResponseMessage);
      return;
    }
    const { category, messages } = parsed;
    const categoryLabel = CATEGORY_LABELS[category];

    const configuredProviders = await getConfiguredProviders(this.context.secrets);
    if (configuredProviders.length === 0) {
      webview.postMessage({
        type: "chatResponse",
        kind: "error",
        text: 'Modelglass: no provider API key is configured yet. Run "Modelglass: Set Provider API Key" first.',
      } satisfies ChatResponseMessage);
      return;
    }

    // A genuinely user-initiated moment (the user sent a chat message), so
    // ensureApiKey (which may provision/prompt) is appropriate here, same
    // reasoning as lm-provider.ts's provideLanguageModelChatResponse.
    const modelglassApiKey = await ensureApiKey(this.context);
    if (!modelglassApiKey) return; // user declined every recovery option

    // SCO-381 — Starter+Pro only, checked before anything provider/routing
    // related. Fails open on an unverifiable status, same documented
    // philosophy as isGateSatisfied below (see pro-gate-lib.ts).
    const proStatus = await checkProAccess(modelglassApiKey, fetch);
    if (isFreeTierExcluded(proStatus)) {
      webview.postMessage({
        type: "chatResponse",
        kind: "error",
        text: "Modelglass: the chat panel is available on Starter and Pro plans. Upgrade at https://modelglass.com.au/signup to use it.",
      } satisfies ChatResponseMessage);
      return;
    }

    let allModels: RoutableModel[];
    try {
      allModels = await fetchRoutableModels(modelglassApiKey, undefined, undefined, (message) =>
        output.appendLine(`[chat-view] ${message}`),
      );
    } catch (e) {
      webview.postMessage({
        type: "chatResponse",
        kind: "error",
        text: `Modelglass: couldn't fetch model data (${e instanceof Error ? e.message : String(e)}).`,
      } satisfies ChatResponseMessage);
      return;
    }

    const rules = await loadRoutingRules();
    const loadedRule = rules.found ? rules.rulesByCategory.get(category) : undefined;
    const rule = proGatedValue(proStatus, loadedRule);
    const providersForThisRun = selectProvidersForRun(
      configuredProviders as { provider: SupportedProvider; apiKey: string }[],
      proStatus,
    );

    const chatMessages = toChatMessages(messages);

    const outcome = await routeAndExecuteWithFallback(
      allModels,
      providersForThisRun,
      category,
      chatMessages,
      undefined,
      rule,
      isGateSatisfied(proStatus),
    );

    const result = describeChatOutcome(outcome, categoryLabel);
    webview.postMessage({ type: "chatResponse", kind: result.kind, text: result.text } satisfies ChatResponseMessage);
  }
}

/**
 * Registered defensively, same pattern as lm-provider.ts's
 * registerModelglassChatProvider: try/catch-guarded so a registration
 * failure never blocks the commands/providers that follow it in
 * extension.ts's activate(). `registerWebviewViewProvider` itself is a
 * long-stable API (no feature-detection needed, unlike SCO-331's
 * vscode.lm.registerLanguageModelChatProvider) — the try/catch is here for
 * defense-in-depth consistency with the rest of this file's registration
 * pattern, not because failure is expected.
 */
export function registerModelglassChatView(context: vscode.ExtensionContext): void {
  try {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, new ModelglassChatViewProvider(context)),
    );
    output.appendLine(`[chat-view] registered the standalone chat webview view (id: ${CHAT_VIEW_ID}).`);
  } catch (e) {
    output.appendLine(
      `[chat-view] failed to register the standalone chat webview view (${e instanceof Error ? e.message : String(e)}) — ` +
        "every other Modelglass command is unaffected.",
    );
  }
}
