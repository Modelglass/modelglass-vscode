/**
 * SCO-377/SCO-378 — tests for the standalone chat webview's pure half: the
 * HTML shell (SCO-377) and the message contract (SCO-378). No vscode API
 * involved, same "test the -lib.ts, not the vscode-coupled wrapper"
 * convention as pro-gate-lib.test.ts / lm-provider-lib.test.ts.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_VIEW_CONTAINER_ID,
  CHAT_VIEW_ID,
  DEFAULT_CHAT_CATEGORY,
  categoryLabelFor,
  generateNonce,
  getWebviewHtml,
  parseChatSendMessage,
} from "./chat-view-lib.js";

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

  test("renders placeholder content, not real chat UI", () => {
    assert.ok(html.includes("Modelglass Chat"));
  });

  // SCO-378 — the shell now actually wires postMessage/addEventListener.
  test("acquires the webview API handle", () => {
    assert.ok(html.includes("acquireVsCodeApi()"));
  });

  test("sends a sendMessage postMessage carrying the default category", () => {
    assert.ok(html.includes('type: "sendMessage"'));
    assert.ok(html.includes(`category: "${DEFAULT_CHAT_CATEGORY}"`));
    assert.ok(html.includes("vscodeApi.postMessage("));
  });

  test("listens for chatResponse messages from the host", () => {
    assert.match(html, /addEventListener\("message"/);
    assert.ok(html.includes('message.type !== "chatResponse"'));
  });

  test("has an input, send control, and output area — but no message-history rendering (SCO-379's job)", () => {
    assert.ok(html.includes('id="modelglass-chat-input"'));
    assert.ok(html.includes('id="modelglass-chat-send"'));
    assert.ok(html.includes('id="modelglass-chat-output"'));
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

  test("accepts multiple messages (future multi-turn shape, even though the webview sends one today)", () => {
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

  test("every value in LEAF_CATEGORIES round-trips through parseChatSendMessage", async () => {
    const { LEAF_CATEGORIES } = await import("./run-task-lib.js");
    for (const category of LEAF_CATEGORIES) {
      const result = parseChatSendMessage({ ...validMessage, category });
      assert.equal(result.valid, true, `expected "${category}" to be accepted`);
    }
  });
});
