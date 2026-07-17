/**
 * SCO-232 — tests for the client-side execution adapters. Monkey-patches
 * global `fetch` for the duration of each test (restored in `afterEach`) —
 * this repo has no mocking library, and node:test's own `t.mock` targets a
 * per-test context rather than module-level globals cleanly here, so a
 * manual save/restore is the simplest approach that matches the rest of the
 * codebase's plain-node:test style.
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { ProviderExecutionError, executeProviderCall, resolveProviderModelId } from "./provider-execute.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("resolveProviderModelId", () => {
  test("strips the creator-org/ prefix by default", () => {
    assert.equal(resolveProviderModelId("openai", "openai/gpt-5.5"), "gpt-5.5");
    assert.equal(resolveProviderModelId("deepseek", "deepseek/deepseek-v4"), "deepseek-v4");
  });

  test("openrouter uses the full creator-org/model-name string, unstripped", () => {
    assert.equal(resolveProviderModelId("openrouter", "openai/gpt-5.5"), "openai/gpt-5.5");
  });

  test("returns the id as-is when it has no prefix to strip", () => {
    assert.equal(resolveProviderModelId("mistral", "mistral-large-3"), "mistral-large-3");
  });
});

describe("executeProviderCall — OpenAI-compatible adapter", () => {
  test("happy path: posts to /chat/completions and returns the message content", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { choices: [{ message: { content: "42" } }] });
    }) as typeof fetch;

    const result = await executeProviderCall("openai", "sk-test", "openai/gpt-5.5", "What is 6*7?");

    assert.equal(result.text, "42");
    assert.equal(result.modelIdUsed, "gpt-5.5");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.openai.com/v1/chat/completions");
    assert.equal((calls[0]!.init.headers as Record<string, string>)["authorization"], "Bearer sk-test");
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.model, "gpt-5.5");
  });

  test("401 classifies as invalid-key", async () => {
    globalThis.fetch = (async () => jsonResponse(401, { error: "bad key" })) as typeof fetch;
    await assert.rejects(
      () => executeProviderCall("openai", "sk-bad", "openai/gpt-5.5", "hi"),
      (e: unknown) => {
        assert.ok(e instanceof ProviderExecutionError);
        assert.equal(e.kind, "invalid-key");
        return true;
      },
    );
  });

  test("429 classifies as rate-limited", async () => {
    globalThis.fetch = (async () => jsonResponse(429, { error: "slow down" })) as typeof fetch;
    await assert.rejects(
      () => executeProviderCall("groq", "gk-test", "meta/llama-4", "hi"),
      (e: unknown) => {
        assert.ok(e instanceof ProviderExecutionError);
        assert.equal(e.kind, "rate-limited");
        return true;
      },
    );
  });

  test("network failure classifies as network-error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    await assert.rejects(
      () => executeProviderCall("xai", "xk-test", "xai/grok-5", "hi"),
      (e: unknown) => {
        assert.ok(e instanceof ProviderExecutionError);
        assert.equal(e.kind, "network-error");
        return true;
      },
    );
  });

  test("unexpected response shape classifies as provider-error", async () => {
    globalThis.fetch = (async () => jsonResponse(200, { choices: [] })) as typeof fetch;
    await assert.rejects(
      () => executeProviderCall("mistral", "mk-test", "mistral/mistral-large-3", "hi"),
      (e: unknown) => {
        assert.ok(e instanceof ProviderExecutionError);
        assert.equal(e.kind, "provider-error");
        return true;
      },
    );
  });
});

describe("executeProviderCall — Anthropic adapter", () => {
  test("happy path: posts to /v1/messages with x-api-key and returns content[0].text", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { content: [{ text: "hello there" }] });
    }) as typeof fetch;

    const result = await executeProviderCall("anthropic", "sk-ant-test", "anthropic/claude-sonnet-5", "hi");

    assert.equal(result.text, "hello there");
    assert.equal(result.modelIdUsed, "claude-sonnet-5");
    assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
    assert.equal((calls[0]!.init.headers as Record<string, string>)["x-api-key"], "sk-ant-test");
  });

  test("403 classifies as invalid-key", async () => {
    globalThis.fetch = (async () => jsonResponse(403, { error: "forbidden" })) as typeof fetch;
    await assert.rejects(
      () => executeProviderCall("anthropic", "sk-bad", "anthropic/claude-sonnet-5", "hi"),
      (e: unknown) => {
        assert.ok(e instanceof ProviderExecutionError);
        assert.equal(e.kind, "invalid-key");
        return true;
      },
    );
  });
});
