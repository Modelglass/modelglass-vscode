/**
 * SCO-377/SCO-378/SCO-379/SCO-380 — tests for the standalone chat webview's
 * pure half: the HTML shell (SCO-377), the message contract (SCO-378), the
 * category picker + conversation-rendering logic (SCO-379), and history
 * persistence validation/embedding (SCO-380). No vscode API involved, same
 * "test the -lib.ts, not the vscode-coupled wrapper" convention as
 * pro-gate-lib.test.ts / lm-provider-lib.test.ts.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_HISTORY_STATE_KEY,
  CHAT_VIEW_CONTAINER_ID,
  CHAT_VIEW_ID,
  DEFAULT_CHAT_CATEGORY,
  ROLE_LABELS,
  categoryLabelFor,
  categoryOptions,
  escapeForInlineScript,
  generateNonce,
  getWebviewHtml,
  isValidMinimalChatMessage,
  parseChatSendMessage,
  parseMessageHistory,
} from "./chat-view-lib.js";
import { CATEGORY_LABELS, LEAF_CATEGORIES } from "./run-task-lib.js";

describe("generateNonce", () => {
  test("returns a 32-character hex string", () => {
    const nonce = generateNonce();
    assert.equal(nonce.length, 32);
    assert.match(nonce, /^[0-9a-f]+$/);
  });

  test("returns a different value on every call", () => {
    const a = generateNonce();
    const b = generateNonce();
    assert.notEqual(a, b);
  });
});

describe("categoryOptions", () => {
  test("returns exactly the 9 LeafTaskCategory values, in CATEGORY_LABELS order", () => {
    const options = categoryOptions();
    assert.equal(options.length, LEAF_CATEGORIES.length);
    assert.deepEqual(
      options.map((o) => o.value),
      LEAF_CATEGORIES,
    );
  });

  test("every option's label matches CATEGORY_LABELS", () => {
    for (const option of categoryOptions()) {
      assert.equal(option.label, CATEGORY_LABELS[option.value]);
    }
  });

  test("includes the default category", () => {
    const values = categoryOptions().map((o) => o.value);
    assert.ok(values.includes(DEFAULT_CHAT_CATEGORY));
  });
});

describe("ROLE_LABELS", () => {
  test("covers exactly user and assistant, matching what parseChatSendMessage accepts", () => {
    assert.deepEqual(Object.keys(ROLE_LABELS).sort(), ["assistant", "user"]);
  });

  test("neither label is empty", () => {
    assert.ok(ROLE_LABELS.user.length > 0);
    assert.ok(ROLE_LABELS.assistant.length > 0);
  });
});

describe("getWebviewHtml", () => {
  const cspSource = "vscode-webview://abc123";
  const nonce = generateNonce();
  const html = getWebviewHtml(cspSource, nonce);

  test("is a well-formed HTML document", () => {
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<\/html>$/);
  });

  test("includes a CSP meta tag scoped to the given cspSource and nonce", () => {
    assert.match(html, /Content-Security-Policy/);
    assert.ok(html.includes(cspSource));
    assert.ok(html.includes(`'nonce-${nonce}'`));
    // default-src 'none' is the documented VS Code webview baseline —
    // nothing should load outside the explicit style-src/script-src allowances.
    assert.match(html, /default-src 'none'/);
  });

  test("the inline script carries the same nonce as the CSP header", () => {
    assert.match(html, new RegExp(`<script nonce="${nonce}">`));
  });

  test("uses VS Code theme CSS variables, not hardcoded colors", () => {
    assert.ok(html.includes("var(--vscode-foreground)"));
    assert.ok(html.includes("var(--vscode-editor-background)"));
  });

  test("acquires the webview API handle", () => {
    assert.ok(html.includes("acquireVsCodeApi()"));
  });

  test("renders a category <select> with all 9 options, default pre-selected", () => {
    assert.match(html, /<select id="modelglass-chat-category">/);
    for (const option of categoryOptions()) {
      assert.ok(html.includes(`<option value="${option.value}"`), `missing option for ${option.value}`);
      assert.ok(html.includes(`>${option.label}</option>`), `missing label for ${option.value}`);
    }
    assert.ok(html.includes(`<option value="${DEFAULT_CHAT_CATEGORY}" selected>`));
  });

  test("sends the SELECTED category (not a hardcoded literal) and the full accumulated conversation", () => {
    assert.ok(html.includes("category: categorySelect.value"));
    assert.ok(html.includes("messages: conversation"));
    // the send payload must not hardcode a single-element array literal —
    // that was SCO-378's placeholder shape, replaced here.
    assert.ok(!html.includes('messages: [{ role: "user", text: text }]'));
  });

  test("listens for chatResponse messages from the host", () => {
    assert.match(html, /addEventListener\("message"/);
    assert.ok(html.includes('message.type !== "chatResponse"'));
  });

  test("renders conversation history in a dedicated messages container, separate from the error area", () => {
    assert.match(html, /<div id="modelglass-chat-messages">/);
    assert.match(html, /<div id="modelglass-chat-error">/);
    assert.ok(html.includes("appendMessageToDom("));
  });

  test("error responses are shown separately, not pushed into the conversation array", () => {
    // the error branch must return before touching `conversation`
    const errorBranchMatch = html.match(/if \(message\.kind === "error"\) \{[^}]*\}/);
    assert.ok(errorBranchMatch, "expected an if(message.kind === 'error') branch");
    assert.ok(!errorBranchMatch![0].includes("conversation.push"));
  });

  test("successful responses ARE pushed into the conversation array and rendered", () => {
    assert.ok(html.includes('const assistantMessage = { role: "assistant"'));
    assert.ok(html.includes("conversation.push(assistantMessage)"));
    assert.ok(html.includes("appendMessageToDom(assistantMessage)"));
  });

  test("bakes ROLE_LABELS in as a JSON literal for the client script to read, not a duplicated hardcoded copy", () => {
    assert.ok(html.includes(`const ROLE_LABELS = ${JSON.stringify(ROLE_LABELS)};`));
  });

  test("builds message bubbles via textContent, not raw innerHTML string concatenation", () => {
    assert.ok(html.includes(".textContent = message.text"));
    assert.ok(!html.includes("innerHTML"));
  });

  test("no persistence API called from inside the webview itself — that's chat-view.ts's job (host-side workspaceState)", () => {
    assert.ok(!/getState|setState|localStorage|workspaceState/.test(html));
  });

  test("with no persisted messages (the default), conversation seeds empty and nothing is pre-rendered", () => {
    assert.ok(html.includes("let conversation = [];"));
  });
});

describe("getWebviewHtml — SCO-380 persisted-history seeding", () => {
  const cspSource = "vscode-webview://abc123";
  const nonce = generateNonce();
  const persisted = [
    { role: "user" as const, text: "earlier question" },
    { role: "assistant" as const, text: "earlier answer" },
  ];
  const html = getWebviewHtml(cspSource, nonce, persisted);

  test("seeds the conversation array from the persisted messages, not an empty array", () => {
    assert.ok(html.includes(`let conversation = ${JSON.stringify(persisted)};`));
  });

  test("renders each persisted message at load via the same appendMessageToDom used for live sends", () => {
    assert.match(html, /for \(const message of conversation\) \{\s*appendMessageToDom\(message\);\s*\}/);
  });

  test("escapes a </script>-containing message so it can't break out of the inline <script> tag", () => {
    const dangerous = [{ role: "user" as const, text: "</script><script>alert(1)</script>" }];
    const dangerousHtml = getWebviewHtml(cspSource, nonce, dangerous);
    // the literal, unescaped sequence must never appear inside the seeded JSON
    assert.ok(!dangerousHtml.includes('let conversation = [{"role":"user","text":"</script>'));
    // the parser-safe escaped form must be present instead
    assert.ok(dangerousHtml.includes("<\\/script>"));
  });
});

describe("view identifiers", () => {
  test("container and view ids are non-empty and namespaced under modelglass", () => {
    assert.match(CHAT_VIEW_CONTAINER_ID, /^modelglass-/);
    assert.match(CHAT_VIEW_ID, /^modelglass\./);
  });
});

describe("categoryLabelFor", () => {
  test("returns the human-readable label for the default category", () => {
    assert.equal(categoryLabelFor(DEFAULT_CHAT_CATEGORY), "Chat / explain");
  });
});

describe("parseChatSendMessage", () => {
  const validMessage = {
    type: "sendMessage",
    category: "chat-explain",
    messages: [{ role: "user", text: "hello" }],
  };

  test("accepts a well-formed sendMessage payload", () => {
    const result = parseChatSendMessage(validMessage);
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.category, "chat-explain");
      assert.deepEqual(result.messages, [{ role: "user", text: "hello" }]);
    }
  });

  test("accepts a full multi-turn conversation history, as SCO-379's webview now sends on every send", () => {
    const result = parseChatSendMessage({
      type: "sendMessage",
      category: "chat-explain",
      messages: [
        { role: "user", text: "first" },
        { role: "assistant", text: "reply" },
        { role: "user", text: "second" },
      ],
    });
    assert.equal(result.valid, true);
    if (result.valid) assert.equal(result.messages.length, 3);
  });

  test("rejects a non-object payload", () => {
    assert.equal(parseChatSendMessage(null).valid, false);
    assert.equal(parseChatSendMessage("hello").valid, false);
    assert.equal(parseChatSendMessage(42).valid, false);
  });

  test("rejects an unrecognized message type", () => {
    const result = parseChatSendMessage({ ...validMessage, type: "somethingElse" });
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.error, /unrecognized message type/);
  });

  test("rejects an unrecognized category", () => {
    const result = parseChatSendMessage({ ...validMessage, category: "not-a-real-category" });
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.error, /unrecognized category/);
  });

  test("rejects an empty messages array", () => {
    const result = parseChatSendMessage({ ...validMessage, messages: [] });
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.error, /no message text/);
  });

  test("rejects a missing messages field", () => {
    const result = parseChatSendMessage({ type: "sendMessage", category: "chat-explain" });
    assert.equal(result.valid, false);
  });

  test("rejects a message entry with a bad role", () => {
    const result = parseChatSendMessage({
      ...validMessage,
      messages: [{ role: "system", text: "hi" }],
    });
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.error, /malformed message entry/);
  });

  test("rejects a message entry with non-string text", () => {
    const result = parseChatSendMessage({
      ...validMessage,
      messages: [{ role: "user", text: 123 }],
    });
    assert.equal(result.valid, false);
  });

  test("every value in LEAF_CATEGORIES round-trips through parseChatSendMessage", () => {
    for (const category of LEAF_CATEGORIES) {
      const result = parseChatSendMessage({ ...validMessage, category });
      assert.equal(result.valid, true, `expected "${category}" to be accepted`);
    }
  });
});

describe("isValidMinimalChatMessage", () => {
  test("accepts well-formed user/assistant messages", () => {
    assert.equal(isValidMinimalChatMessage({ role: "user", text: "hi" }), true);
    assert.equal(isValidMinimalChatMessage({ role: "assistant", text: "hello" }), true);
  });

  test("rejects a system role — this contract deliberately excludes it", () => {
    assert.equal(isValidMinimalChatMessage({ role: "system", text: "hi" }), false);
  });

  test("rejects non-string text, missing fields, and non-objects", () => {
    assert.equal(isValidMinimalChatMessage({ role: "user", text: 123 }), false);
    assert.equal(isValidMinimalChatMessage({ role: "user" }), false);
    assert.equal(isValidMinimalChatMessage("hi"), false);
    assert.equal(isValidMinimalChatMessage(null), false);
    assert.equal(isValidMinimalChatMessage(undefined), false);
  });
});

describe("parseMessageHistory — SCO-380 workspaceState read-side validation", () => {
  test("returns a well-formed array unchanged", () => {
    const history = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ];
    assert.deepEqual(parseMessageHistory(history), history);
  });

  test("returns an empty array for undefined (nothing persisted yet — the common case)", () => {
    assert.deepEqual(parseMessageHistory(undefined), []);
  });

  test("returns an empty array for a non-array value, rather than throwing", () => {
    assert.deepEqual(parseMessageHistory("not an array"), []);
    assert.deepEqual(parseMessageHistory({ role: "user", text: "hi" }), []);
    assert.deepEqual(parseMessageHistory(42), []);
  });

  test("returns an empty array if ANY entry is malformed — no partial/corrupted history rendered", () => {
    const history = [{ role: "user", text: "hi" }, { role: "system", text: "bad" }];
    assert.deepEqual(parseMessageHistory(history), []);
  });

  test("an empty persisted array round-trips to an empty array", () => {
    assert.deepEqual(parseMessageHistory([]), []);
  });
});

describe("escapeForInlineScript", () => {
  test("escapes </script> so it can't prematurely close the enclosing <script> tag", () => {
    const json = '{"text":"</script><script>alert(1)</script>"}';
    const escaped = escapeForInlineScript(json);
    assert.ok(!escaped.includes("</script>"));
    assert.ok(escaped.includes("<\\/script>"));
  });

  test("is case-insensitive (HTML tag matching isn't case-sensitive)", () => {
    assert.ok(!escapeForInlineScript('"</SCRIPT>"').includes("</SCRIPT>"));
  });

  test("leaves ordinary JSON with no closing-tag-like substrings untouched", () => {
    const json = JSON.stringify({ role: "user", text: "just a normal message" });
    assert.equal(escapeForInlineScript(json), json);
  });
});

describe("CHAT_HISTORY_STATE_KEY", () => {
  test("is a non-empty, namespaced key", () => {
    assert.match(CHAT_HISTORY_STATE_KEY, /^modelglass\./);
  });
});
