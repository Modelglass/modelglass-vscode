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

/** SCO-380 — the `context.workspaceState` key conversation history is
 *  persisted under. Defined here (pure) rather than inline in
 *  chat-view.ts's vscode-coupled calls so it's a single source of truth,
 *  same reasoning as CHAT_VIEW_ID above. */
export const CHAT_HISTORY_STATE_KEY = "modelglass.chatHistory";

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

/** Whether `value` is a well-formed `MinimalChatMessage` — only "user"/
 *  "assistant" roles, a string `text`. Shared by `parseChatSendMessage`
 *  (the webview->host boundary) and `parseMessageHistory` (SCO-380, the
 *  workspaceState->webview boundary) — one validation rule for "is this a
 *  real message", not two copies that could drift. */
export function isValidMinimalChatMessage(value: unknown): value is MinimalChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const hasValidRole = entry.role === "user" || entry.role === "assistant";
  const hasValidText = typeof entry.text === "string";
  return hasValidRole && hasValidText;
}

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
    if (!isValidMinimalChatMessage(m)) {
      return { valid: false, error: "malformed message entry (expected {role, text})." };
    }
    messages.push(m);
  }
  return { valid: true, category: msg.category as LeafTaskCategory, messages };
}

/**
 * SCO-380 — sanitises whatever `context.workspaceState.get(CHAT_HISTORY_STATE_KEY)`
 * returns before it's trusted to seed a fresh webview render. This key has
 * never held any other shape (a new feature, not a migration), but
 * `workspaceState` is untyped storage VS Code doesn't validate on read —
 * defensive by the same principle as `parseChatSendMessage`, not because a
 * specific corruption path is known. Returns an empty array (never throws)
 * for anything that isn't cleanly an array of valid messages, so a
 * corrupted value degrades to "start fresh" rather than crashing the view.
 */
export function parseMessageHistory(raw: unknown): MinimalChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.every(isValidMinimalChatMessage) ? raw : [];
}

/**
 * SCO-380 — persisted history gets embedded into the generated HTML as a
 * JSON literal inside an inline `<script>` (see `getWebviewHtml`). A
 * message whose text happens to contain the literal substring `</script>`
 * (or `</SCRIPT>`, case-insensitively — HTML tag matching isn't
 * case-sensitive) would otherwise prematurely close that tag when the HTML
 * parser processes it, before the JS engine ever sees the JSON — a classic
 * script-embedding bug, not XSS exactly (no execution risk here, that's
 * what `.textContent` in the render path already prevents) but a real
 * render/parse corruption risk. Standard mitigation: escape `</` to `<\/`
 * in the JSON text — `<\/script>` is valid inside a JS string literal
 * (the backslash is simply redundant there) but the HTML parser no longer
 * reads it as a closing tag.
 */
export function escapeForInlineScript(json: string): string {
  return json.replace(/<\//gi, "<\\/");
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
 * conversation-history rendering. Every send posts the FULL accumulated
 * conversation, not just the latest turn (matching that card's own
 * description: "message list, sent alongside category in each postMessage
 * payload") — `ChatSendMessage.messages` already typed as an array in
 * SCO-378 specifically so this needed no contract change.
 *
 * SCO-380: `persistedMessages` seeds the webview's `conversation` array and
 * renders each one at load, instead of always starting empty. Without
 * this, VS Code's own default `WebviewView` behavior already loses
 * conversation state on a routine Activity Bar switch, not just a full
 * restart — hiding a `WebviewView` (retainContextWhenHidden left at its
 * SCO-377 default of false) deallocates and recreates its underlying
 * document, tearing down this exact JS closure, every time. `chat-view.ts`
 * reads/writes `persistedMessages` via `context.workspaceState` — chosen
 * over `retainContextWhenHidden: true` (keeps the memory cost VS Code's
 * own docs warn about, and still wouldn't survive a real restart) and over
 * the webview-side `getState()`/`setState()` API (survives hide/show, but
 * not a restart either, and isn't wired to any extension-host persistence
 * for `WebviewView` the way it partially is for `WebviewPanel`).
 * `workspaceState` alone covers both cases this card's "across panel
 * reloads" wording actually implies, with no in-memory cost while hidden.
 *
 * Message bubbles are built via `document.createElement`/`.textContent`,
 * not raw HTML string concatenation — sidesteps needing a manual
 * HTML-escaping function entirely (a model's response could contain
 * arbitrary text, including HTML-like content) rather than hand-rolling
 * escaping in inline script text, which is easy to get subtly wrong. The
 * one place raw text IS embedded as markup is the JSON seed for
 * `persistedMessages` itself, inside the `<script>` tag — `escapeForInlineScript`
 * (above) guards that specific spot.
 *
 * Error responses are shown in a separate area, not appended to the
 * conversation array — an error string isn't a real assistant turn, and
 * sending it back as one on the next round-trip would corrupt what the
 * model actually said. `chat-view.ts` mirrors this on the persistence
 * side: it writes the user's own message to workspaceState immediately
 * (matching what the webview already shows optimistically), then
 * re-writes with the assistant's reply appended only on success — an
 * error leaves that correct partial state as final.
 */
export function getWebviewHtml(cspSource: string, nonce: string, persistedMessages: MinimalChatMessage[] = []): string {
  const optionsHtml = categoryOptions()
    .map(
      (opt) =>
        `<option value="${opt.value}"${opt.value === DEFAULT_CHAT_CATEGORY ? " selected" : ""}>${opt.label}</option>`,
    )
    .join("");
  const persistedMessagesJson = escapeForInlineScript(JSON.stringify(persistedMessages));

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

    // SCO-380: seeded from persisted history the host looked up
    // (chat-view.ts), not always empty — a fresh script evaluation
    // (webview reload/re-show) now rehydrates instead of starting over.
    let conversation = ${persistedMessagesJson};
    for (const message of conversation) {
      appendMessageToDom(message);
    }

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
