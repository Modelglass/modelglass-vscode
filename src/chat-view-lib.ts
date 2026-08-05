import { randomBytes } from "node:crypto";
import { CATEGORY_LABELS, LEAF_CATEGORIES } from "./run-task-lib.js";
import type { LeafTaskCategory } from "./routing-engine.js";
import type { ChatOutcome, MinimalChatMessage } from "./lm-provider-lib.js";

/**
 * SCO-377/SCO-378 — pure half of the standalone chat webview (no `vscode`
 * import, same lib/non-lib split as pro-gate-lib.ts/lm-provider-lib.ts) so
 * both the HTML shell and the message contract are directly unit-testable
 * without an Extension Host. ./chat-view.ts holds the one vscode-coupled
 * piece (the WebviewViewProvider registration + the actual
 * onDidReceiveMessage handler body, which needs secrets/fetch/output —
 * same "not unit-tested directly" convention as lm-provider.ts).
 *
 * SCO-377 shipped the bare shell. SCO-378 wires real postMessage /
 * onDidReceiveMessage plumbing on top of it, reusing lm-provider-lib.ts's
 * `MinimalChatMessage`/`ChatOutcome`/`describeChatOutcome` as-is (the
 * message shape a chat surface needs is identical regardless of whether
 * it's vscode.lm or a webview) rather than redefining an equivalent type
 * here. Deliberately NOT in scope here: a category picker UI or
 * multi-turn conversation history/state — those are SCO-379 and SCO-380.
 * The webview sends a single hardcoded category ("chat-explain" — the
 * only one of the 9 LeafTaskCategory values that fits a general-purpose
 * chat box) until SCO-379 replaces it with a real picker.
 */

export const CHAT_VIEW_CONTAINER_ID = "modelglass-chat-container";
export const CHAT_VIEW_ID = "modelglass.chatView";

// ---------------------------------------------------------------------------
// Message contract (webview <-> extension host).
// ---------------------------------------------------------------------------

/** Webview -> host. The one message type this pass needs — a single-turn
 *  send. `messages` is already an array (not a bare string) so SCO-380's
 *  real conversation-history tracking has a shape to fill in later without
 *  changing this contract; today the webview only ever sends one element. */
export interface ChatSendMessage {
  type: "sendMessage";
  category: string;
  messages: MinimalChatMessage[];
}

/** Host -> webview. Reuses `ChatOutcome`'s own `kind`/`text` shape directly
 *  (lm-provider-lib.ts) rather than redefining an equivalent type — same
 *  outcome, same fields, just wrapped with a `type` discriminant for the
 *  webview's message listener to switch on. */
export type ChatResponseMessage = { type: "chatResponse" } & ChatOutcome;

export type ParsedChatSendMessage =
  | { valid: true; category: LeafTaskCategory; messages: MinimalChatMessage[] }
  | { valid: false; error: string };

/**
 * Defensive parsing at the webview->host boundary — `onDidReceiveMessage`'s
 * payload is untyped (`any`) from VS Code's own API, so nothing about its
 * shape can be trusted without checking. Rejects anything that isn't
 * exactly the `ChatSendMessage` shape, with a human-readable reason the
 * host can relay back to the webview rather than throwing.
 */
export function parseChatSendMessage(raw: unknown): ParsedChatSendMessage {
  if (typeof raw !== "object" || raw === null) {
    return { valid: false, error: "malformed message (not an object)." };
  }
  const msg = raw as Record<string, unknown>;
  if (msg.type !== "sendMessage") {
    return { valid: false, error: `unrecognized message type "${String(msg.type)}".` };
  }
  if (typeof msg.category !== "string" || !(LEAF_CATEGORIES as readonly string[]).includes(msg.category)) {
    return { valid: false, error: `unrecognized category "${String(msg.category)}".` };
  }
  if (!Array.isArray(msg.messages) || msg.messages.length === 0) {
    return { valid: false, error: "no message text provided." };
  }
  const messages: MinimalChatMessage[] = [];
  for (const m of msg.messages) {
    if (typeof m !== "object" || m === null) {
      return { valid: false, error: "malformed message entry (expected {role, text})." };
    }
    const entry = m as Record<string, unknown>;
    const hasValidRole = entry.role === "user" || entry.role === "assistant";
    const hasValidText = typeof entry.text === "string";
    if (!hasValidRole || !hasValidText) {
      return { valid: false, error: "malformed message entry (expected {role, text})." };
    }
    messages.push(m as MinimalChatMessage);
  }
  return { valid: true, category: msg.category as LeafTaskCategory, messages };
}

/** The single hardcoded category the webview sends today — see this file's
 *  header for why (SCO-379 replaces this with a real picker). Exported so
 *  both the HTML template below and any test asserting on it read from one
 *  source, not a string literal duplicated in two places. */
export const DEFAULT_CHAT_CATEGORY: LeafTaskCategory = "chat-explain";

export function categoryLabelFor(category: LeafTaskCategory): string {
  return CATEGORY_LABELS[category];
}

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
 * SCO-378: the inline script now actually sends/receives — `postMessage`
 * on submit (Enter or the Send button), `window.addEventListener("message",
 * ...)` for the host's response. Deliberately NOT conversation UI (SCO-379
 * owns that): one input, one output area, no message history rendered, no
 * category picker (every send uses `DEFAULT_CHAT_CATEGORY`). This exists so
 * the message-passing plumbing is actually exercisable end-to-end in a real
 * Extension Host, not just unit-tested in isolation — SCO-379 replaces this
 * whole markup block with real conversation UI, not just adds to it.
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
    #modelglass-chat-input {
      width: 100%;
      box-sizing: border-box;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      padding: 6px;
      font-family: inherit;
      font-size: inherit;
      resize: vertical;
    }
    #modelglass-chat-send {
      align-self: flex-end;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      padding: 4px 12px;
      cursor: pointer;
    }
    #modelglass-chat-send:disabled {
      opacity: 0.6;
      cursor: default;
    }
    #modelglass-chat-output {
      white-space: pre-wrap;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
      padding-top: 8px;
    }
    #modelglass-chat-output.error {
      color: var(--vscode-errorForeground);
    }
  </style>
</head>
<body>
  <div id="modelglass-chat-root">
    <p id="modelglass-chat-placeholder">Modelglass Chat — SCO-378 message-passing test shell (real conversation UI lands in SCO-379).</p>
    <textarea id="modelglass-chat-input" rows="3" placeholder="Type a message…"></textarea>
    <button id="modelglass-chat-send" type="button">Send</button>
    <div id="modelglass-chat-output"></div>
  </div>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const input = document.getElementById("modelglass-chat-input");
    const sendButton = document.getElementById("modelglass-chat-send");
    const output = document.getElementById("modelglass-chat-output");

    function sendMessage() {
      const text = input.value.trim();
      if (!text) return;
      sendButton.disabled = true;
      output.classList.remove("error");
      output.textContent = "Sending…";
      vscodeApi.postMessage({
        type: "sendMessage",
        category: "${DEFAULT_CHAT_CATEGORY}",
        messages: [{ role: "user", text: text }],
      });
    }

    sendButton.addEventListener("click", sendMessage);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.type !== "chatResponse") return;
      sendButton.disabled = false;
      output.classList.toggle("error", message.kind === "error");
      output.textContent = message.text;
    });
  </script>
</body>
</html>`;
}
