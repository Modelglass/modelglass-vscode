import * as vscode from "vscode";
import { output } from "./auth.js";
import { CHAT_VIEW_ID, generateNonce, getWebviewHtml } from "./chat-view-lib.js";

/**
 * SCO-377 — vscode-coupled half (see ./chat-view-lib.ts's header for the
 * pure HTML shell this wraps). Not unit-tested directly — same "no
 * Extension Host harness" convention as extension.ts/lm-provider.ts/
 * run-task.ts.
 *
 * `registerWebviewViewProvider` (not `createWebviewPanel`) — a sidebar
 * view persists across activity-bar switches and reuses the same webview
 * instance rather than being torn down/recreated, the closer fit for the
 * always-present, Copilot-Chat-like UX SCO-342 targets. `retainContextWhenHidden`
 * is left at its default (false) for this scaffold: there's no state yet
 * worth preserving across a hide/show cycle (SCO-380 is where that
 * decision actually matters).
 */
export class ModelglassChatViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.html = getWebviewHtml(webviewView.webview.cspSource, generateNonce());
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
      vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, new ModelglassChatViewProvider()),
    );
    output.appendLine(`[chat-view] registered the standalone chat webview view (id: ${CHAT_VIEW_ID}).`);
  } catch (e) {
    output.appendLine(
      `[chat-view] failed to register the standalone chat webview view (${e instanceof Error ? e.message : String(e)}) — ` +
        "every other Modelglass command is unaffected.",
    );
  }
}
