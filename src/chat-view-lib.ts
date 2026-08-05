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

/** The default pre-selected category in SCO-379's dropdown — "chat-explain"
 *  is the one LeafTaskCategory that fits a general-purpose chat box.
 *  Exported so both the HTML template below and any test asserting on it
 *  read from one source, not a string literal duplicated in two places. */
export const DEFAULT_CHAT_CATEGORY: LeafTaskCategory = "chat-explain";

export function categoryLabelFor(category: LeafTaskCategory): string {
  return CATEGORY_LABELS[category];
}

// ---------------------------------------------------------------------------
// SCO-379 — category picker + conversation rendering, pure half.
// ---------------------------------------------------------------------------

export interface CategoryOption {
  value: LeafTaskCategory;
  label: string;
}

/** All 9 LeafTaskCategory values as {value, label} pairs, in
 *  run-task-lib.ts's own CATEGORY_LABELS declaration order — the plain
 *  `<select>` this card asks for, not SCO-331's 9-pseudo-model workaround
 *  (a webview isn't constrained by vscode.lm's one-model-per-selectable-item
 *  shape, per this card's own description). Pure and tested so a category
 *  added/renamed in run-task-lib.ts is caught here rather than silently
 *  missing from the dropdown. */
export function categoryOptions(): CategoryOption[] {
  return LEAF_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }));
}

/** Only "user"/"assistant" — the only two roles parseChatSendMessage
 *  accepts (this webview's contract deliberately excludes "system", even
 *  though ChatRole itself has a third value; see parseChatSendMessage's
 *  validation). Baked into the generated HTML as a JSON literal (below) so
 *  the client-side render logic reads labels computed by tested TS, not a
 *  second hardcoded copy inside the inline <script>. */
export const ROLE_LABELS: Record<"user" | "assistant", string> = {
  user: "You",
  assistant: "Modelglass",
};

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
 * load, not needed for content this small.
 *
 * Styling uses VS Code's own theme CSS custom properties
 * (--vscode-foreground, --vscode-editor-background, etc.) rather than
 * hardcoded colors, so the panel matches the user's active theme
 * automatically — the same approach VS Code's official webview samples use.
 *
 * SCO-379: real category picker (a plain `<select>` built from
 * `categoryOptions()`, not SCO-331's 9-pseudo-model workaround — a webview
 * isn't shape-constrained the way vscode.lm's picker is) and real
 * conversation-history rendering. The in-memory `conversation` array is
 * kept in the webview's own JS closure, not this module — deliberately NOT
 * persisted across a hide/show or reload (that's SCO-380); a fresh
 * `resolveWebviewView` call (and therefore a fresh script evaluation)
 * starts empty every time. Every send posts the FULL accumulated
 * conversation, not just the latest turn (matching this card's own
 * description: "message list, sent alongside category in each postMessage
 * payload") — `ChatSendMessage.messages` already typed as an array in
 * SCO-378 specifically so this needed no contract change.
 *
 * Message bubbles are built via `document.createElement`/`.textContent`,
 * not raw HTML string concatenation — sidesteps needing a manual
 * HTML-escaping function entirely (a model's response could contain
 * arbitrary text, including HTML-like content) rather than hand-rolling
 * escaping in inline script text, which is easy to get subtly wrong.
 *
 * Error responses are shown in a separate area, not appended to the
 * conversation array — an error string isn't a real assistant turn, and
 * sending it back as one on the next round-trip would corrupt what the
 * model actually said.
 */
export function getWebviewHtml(cspSource: string, nonce: string): string {
  const optionsHtml = categoryOptions()
    .map(
      (opt) =>
        `<option value="${opt.value}"${opt.value === DEFAULT_CHAT_CATEGORY ? " selected" : ""}>${opt.label}</option>`,
    )
    .join("");

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
      height: calc(100vh - 24px);
    }
    #modelglass-chat-placeholder {
      color: var(--vscode-descriptionForeground);
      margin: 0;
    }
    #modelglass-chat-category {
      background-color: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, transparent);
      border-radius: 2px;
      padding: 4px;
      font-family: inherit;
      font-size: inherit;
    }
    #modelglass-chat-messages {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
      padding-top: 8px;
    }
    .modelglass-message {
      white-space: pre-wrap;
    }
    .modelglass-message .modelglass-message-role {
      font-weight: 600;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    .modelglass-message-role-assistant {
      background-color: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-focusBorder));
      padding: 6px 8px;
      border-radius: 2px;
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
    #modelglass-chat-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    #modelglass-chat-send {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      padding: 4px 12px;
      cursor: pointer;
    }
    #modelglass-chat-send:disabled,
    #modelglass-chat-category:disabled,
    #modelglass-chat-input:disabled {
      opacity: 0.6;
      cursor: default;
    }
    #modelglass-chat-error {
      color: var(--vscode-errorForeground);
      white-space: pre-wrap;
      display: none;
    }
    #modelglass-chat-error.visible {
      display: block;
    }
  </style>
</head>
<body>
  <div id="modelglass-chat-root">
    <p id="modelglass-chat-placeholder">Modelglass Chat</p>
    <select id="modelglass-chat-category">${optionsHtml}</select>
    <div id="modelglass-chat-messages"></div>
    <div id="modelglass-chat-error"></div>
    <textarea id="modelglass-chat-input" rows="3" placeholder="Type a message…"></textarea>
    <div id="modelglass-chat-controls">
      <button id="modelglass-chat-send" type="button">Send</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const ROLE_LABELS = ${JSON.stringify(ROLE_LABELS)};
    const vscodeApi = acquireVsCodeApi();
    const categorySelect = document.getElementById("modelglass-chat-category");
    const messagesEl = document.getElementById("modelglass-chat-messages");
    const errorEl = document.getElementById("modelglass-chat-error");
    const input = document.getElementById("modelglass-chat-input");
    const sendButton = document.getElementById("modelglass-chat-send");

    // In-memory only, per this card's scope — a fresh script evaluation
    // (webview reload/re-show) starts this empty again. Persisting it
    // across that is SCO-380.
    let conversation = [];

    function setControlsEnabled(enabled) {
      sendButton.disabled = !enabled;
      categorySelect.disabled = !enabled;
      input.disabled = !enabled;
    }

    function appendMessageToDom(message) {
      const wrapper = document.createElement("div");
      wrapper.className = "modelglass-message modelglass-message-role-" + message.role;
      const roleLabel = document.createElement("div");
      roleLabel.className = "modelglass-message-role";
      roleLabel.textContent = ROLE_LABELS[message.role] || message.role;
      const body = document.createElement("div");
      body.textContent = message.text;
      wrapper.appendChild(roleLabel);
      wrapper.appendChild(body);
      messagesEl.appendChild(wrapper);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function showError(text) {
      errorEl.textContent = text;
      errorEl.classList.add("visible");
    }

    function clearError() {
      errorEl.textContent = "";
      errorEl.classList.remove("visible");
    }

    function sendMessage() {
      const text = input.value.trim();
      if (!text) return;
      clearError();
      const userMessage = { role: "user", text: text };
      conversation.push(userMessage);
      appendMessageToDom(userMessage);
      input.value = "";
      setControlsEnabled(false);
      vscodeApi.postMessage({
        type: "sendMessage",
        category: categorySelect.value,
        messages: conversation,
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
      setControlsEnabled(true);
      if (message.kind === "error") {
        showError(message.text);
        return;
      }
      const assistantMessage = { role: "assistant", text: message.text };
      conversation.push(assistantMessage);
      appendMessageToDom(assistantMessage);
    });
  </script>
</body>
</html>`;
}
