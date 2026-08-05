/**
 * SCO-377 — tests for the standalone chat webview's pure HTML-shell half.
 * No vscode API involved, same "test the -lib.ts, not the vscode-coupled
 * wrapper" convention as pro-gate-lib.test.ts / lm-provider-lib.test.ts.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { CHAT_VIEW_CONTAINER_ID, CHAT_VIEW_ID, generateNonce, getWebviewHtml } from "./chat-view-lib.js";

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

  test("acquires the webview API handle but sends no messages", () => {
    assert.ok(html.includes("acquireVsCodeApi()"));
    assert.ok(!html.includes("postMessage("));
  });

  test("uses VS Code theme CSS variables, not hardcoded colors", () => {
    assert.ok(html.includes("var(--vscode-foreground)"));
    assert.ok(html.includes("var(--vscode-editor-background)"));
  });

  test("renders placeholder content, not real chat UI", () => {
    assert.ok(html.includes("Modelglass Chat"));
  });
});

describe("view identifiers", () => {
  test("container and view ids are non-empty and namespaced under modelglass", () => {
    assert.match(CHAT_VIEW_CONTAINER_ID, /^modelglass-/);
    assert.match(CHAT_VIEW_ID, /^modelglass\./);
  });
});
