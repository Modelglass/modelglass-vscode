import { randomBytes } from "node:crypto";

/**
 * SCO-377 — pure half of the standalone chat webview (no `vscode` import,
 * same lib/non-lib split as pro-gate-lib.ts/lm-provider-lib.ts) so the HTML
 * shell itself is directly unit-testable without an Extension Host.
 * ./chat-view.ts holds the one vscode-coupled piece (the
 * WebviewViewProvider registration).
 *
 * Scaffold only, per the card: registers a persistent sidebar webview view
 * (not an editor-panel `createWebviewPanel`) for the always-present,
 * Copilot-Chat-like UX SCO-342 targets. No message-passing or chat logic
 * lives here yet — that's SCO-378. This just needs to render a real,
 * CSP-compliant HTML/CSS/JS shell that looks native to the VS Code sidebar.
 */

export const CHAT_VIEW_CONTAINER_ID = "modelglass-chat-container";
export const CHAT_VIEW_ID = "modelglass.chatView";

/** VS Code webview CSP requires a per-render nonce on any inline <script> —
 *  documented pattern in VS Code's own webview sample extension. 16 random
 *  bytes, hex-encoded, regenerated on every resolveWebviewView call (never
 *  cached/reused across renders). */
export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The webview's HTML shell. `cspSource` is `webview.cspSource` from the
 * real `vscode.Webview` instance (a webview-scoped URI VS Code assigns per
 * session) — passed in rather than imported so this stays pure/testable.
 * No external stylesheet/script files yet: everything's inline, matching
 * "bare shell" scope — a real webview-relative asset loading path (via
 * `webview.asWebviewUri`) is follow-on work once there's an actual asset to
 * load, not needed for a shell with no content beyond placeholder text.
 *
 * Styling uses VS Code's own theme CSS custom properties
 * (--vscode-foreground, --vscode-editor-background, etc.) rather than
 * hardcoded colors, so the panel matches the user's active theme
 * automatically — the same approach VS Code's official webview samples use.
 *
 * The inline script only acquires the webview API handle and stores it —
 * it does not send or handle any messages. That's deliberate: message
 * passing is SCO-378's scope, not this one. This just leaves the hook
 * point (`vscodeApi`) in place for SCO-378 to build on.
 */
export function getWebviewHtml(cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Modelglass Chat</title>
  <style>
    body {
      margin: 0;
      padding: 12px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
    }
    #modelglass-chat-root {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #modelglass-chat-placeholder {
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div id="modelglass-chat-root">
    <p id="modelglass-chat-placeholder">Modelglass Chat — coming soon.</p>
  </div>
  <script nonce="${nonce}">
    // SCO-377 scaffold only — acquires the webview API handle so SCO-378
    // (message-passing + host-side handler wiring) has it available.
    // Sends/receives nothing yet.
    const vscodeApi = acquireVsCodeApi();
  </script>
</body>
</html>`;
}
