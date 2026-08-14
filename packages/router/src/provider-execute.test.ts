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

import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  ProviderExecutionError,
  executeProviderCall,
  resolveProviderModelId,
  type ChatMessage,
} from "./provider-execute.js";

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

  // SCO-283
  test("an explicit provider_model_id wins outright, even for a provider the heuristic would otherwise handle fine", () => {
    assert.equal(
      resolveProviderModelId("openai", "openai/gpt-5.5", "gpt-5.5-turbo-preview"),
      "gpt-5.5-turbo-preview",
    );
  });

  test("an explicit provider_model_id overrides openrouter's full-string default too", () => {
    assert.equal(
      resolveProviderModelId("openrouter", "alibaba/qwen-3-235b-a22b", "qwen/qwen3-235b-a22b"),
      "qwen/qwen3-235b-a22b",
    );
  });

  test("falls through to the heuristic when no explicit id is passed (undefined)", () => {
    assert.equal(resolveProviderModelId("together-ai", "meta/llama-3.3-70b", undefined), "llama-3.3-70b");
  });

  test("falls through to the heuristic when the explicit id is an empty string", () => {
    assert.equal(resolveProviderModelId("together-ai", "meta/llama-3.3-70b", ""), "llama-3.3-70b");
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

  // SCO-283
  test("an explicit provider_model_id (6th arg) reaches the actual API call, not the heuristic-derived string", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { choices: [{ message: { content: "42" } }] });
    }) as typeof fetch;

    const result = await executeProviderCall(
      "together-ai",
      "sk-test",
      "meta/llama-3.3-70b",
      "What is 6*7?",
      DEFAULT_PROVIDER_TIMEOUT_MS,
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    );

    assert.equal(result.modelIdUsed, "meta-llama/Llama-3.3-70B-Instruct-Turbo");
    const body = JSON.parse(calls[0]!.init.body as string);
    // Confirms the explicit id, not the heuristic's "llama-3.3-70b", was sent.
    assert.equal(body.model, "meta-llama/Llama-3.3-70B-Instruct-Turbo");
  });

  test("without an explicit provider_model_id, the heuristic-derived string still reaches the API call unchanged", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { choices: [{ message: { content: "42" } }] });
    }) as typeof fetch;

    await executeProviderCall("together-ai", "sk-test", "meta/llama-3.3-70b", "What is 6*7?");

    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.model, "llama-3.3-70b");
  });

  test("SCO-260 quick-win #2: parses usage.prompt_tokens/completion_tokens into result.usage", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        choices: [{ message: { content: "42" } }],
        usage: { prompt_tokens: 120, completion_tokens: 8 },
      })) as typeof fetch;

    const result = await executeProviderCall("openai", "sk-test", "openai/gpt-5.5", "What is 6*7?");

    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 8 });
  });

  test("SCO-260 quick-win #2: usage is undefined, not crashed on, when the response omits it", async () => {
    globalThis.fetch = (async () => jsonResponse(200, { choices: [{ message: { content: "42" } }] })) as typeof fetch;

    const result = await executeProviderCall("openai", "sk-test", "openai/gpt-5.5", "What is 6*7?");

    assert.equal(result.usage, undefined);
  });

  // SCO-330 (fix #4 bonus)
  test("finish_reason: 'length' sets truncated: true", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { choices: [{ message: { content: "42" }, finish_reason: "length" }] })) as typeof fetch;

    const result = await executeProviderCall("openai", "sk-test", "openai/gpt-5.5", "hi");

    assert.equal(result.truncated, true);
  });

  test("a present finish_reason other than 'length' sets truncated: false, not undefined", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { choices: [{ message: { content: "42" }, finish_reason: "stop" }] })) as typeof fetch;

    const result = await executeProviderCall("openai", "sk-test", "openai/gpt-5.5", "hi");

    assert.equal(result.truncated, false);
  });

  test("no finish_reason at all leaves truncated undefined -- unknown, not a claimed false", async () => {
    globalThis.fetch = (async () => jsonResponse(200, { choices: [{ message: { content: "42" } }] })) as typeof fetch;

    const result = await executeProviderCall("openai", "sk-test", "openai/gpt-5.5", "hi");

    assert.equal(result.truncated, undefined);
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

  test("ADR-0012 Amendment 1 (SCO-281): 404 classifies as model-not-found, not provider-error", async () => {
    globalThis.fetch = (async () => jsonResponse(404, { error: "not found" })) as typeof fetch;
    await assert.rejects(
      () => executeProviderCall("together-ai", "tk-test", "meta/llama-4-nonexistent", "hi"),
      (e: unknown) => {
        assert.ok(e instanceof ProviderExecutionError);
        assert.equal(e.kind, "model-not-found");
        return true;
      },
    );
  });

  test("ADR-0012 Amendment 1 (SCO-281): a 400 with a 'model does not exist' body also classifies as model-not-found, since the HTTP status alone is ambiguous", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(400, { error: { message: "The model `gpt-9000` does not exist" } })) as typeof fetch;
    await assert.rejects(
      () => executeProviderCall("openai", "sk-test", "openai/gpt-9000", "hi"),
      (e: unknown) => {
        assert.ok(e instanceof ProviderExecutionError);
        assert.equal(e.kind, "model-not-found");
        return true;
      },
    );
  });

  test("a genuine 400 with no model-not-found wording still classifies as provider-error, not swept into model-not-found", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(400, { error: { message: "max_tokens must be a positive integer" } })) as typeof fetch;
    await assert.rejects(
      () => executeProviderCall("openai", "sk-test", "openai/gpt-5.5", "hi"),
      (e: unknown) => {
        assert.ok(e instanceof ProviderExecutionError);
        assert.equal(e.kind, "provider-error");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// SCO-331 — multi-turn conversation support (vscode.lm forwards a full
// message history, not one flattened string). A bare `string` prompt still
// works identically everywhere (covered by every pre-existing test above,
// unmodified); these tests cover the new `ChatMessage[]` path specifically.
// ---------------------------------------------------------------------------

describe("executeProviderCall — multi-turn messages (SCO-331)", () => {
  test("OpenAI-compatible adapter forwards a full ChatMessage[] conversation as-is, roles included", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return jsonResponse(200, { choices: [{ message: { content: "42" } }] });
    }) as typeof fetch;

    const conversation: ChatMessage[] = [
      { role: "system", content: "You are a helpful coding assistant." },
      { role: "user", content: "What is 6*7?" },
      { role: "assistant", content: "Let me think." },
      { role: "user", content: "Well?" },
    ];

    await executeProviderCall("openai", "sk-test", "openai/gpt-5.5", conversation);

    const body = JSON.parse(calls[0]!.init.body as string);
    assert.deepEqual(body.messages, conversation);
  });

  test("Anthropic adapter splits system messages into the top-level system field, not the messages array", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return jsonResponse(200, { content: [{ text: "hello there" }] });
    }) as typeof fetch;

    const conversation: ChatMessage[] = [
      { role: "system", content: "You are a helpful coding assistant." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you?" },
    ];

    await executeProviderCall("anthropic", "sk-ant-test", "anthropic/claude-sonnet-5", conversation);

    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.system, "You are a helpful coding assistant.");
    assert.deepEqual(body.messages, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you?" },
    ]);
  });

  test("Anthropic adapter omits the system field entirely when no system message is present", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return jsonResponse(200, { content: [{ text: "hello there" }] });
    }) as typeof fetch;

    const conversation: ChatMessage[] = [{ role: "user", content: "hi" }];
    await executeProviderCall("anthropic", "sk-ant-test", "anthropic/claude-sonnet-5", conversation);

    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal("system" in body, false);
  });

  test("a bare string prompt (every pre-existing caller) still produces the exact one-element user-message array as before", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return jsonResponse(200, { choices: [{ message: { content: "42" } }] });
    }) as typeof fetch;

    await executeProviderCall("openai", "sk-test", "openai/gpt-5.5", "What is 6*7?");

    const body = JSON.parse(calls[0]!.init.body as string);
    assert.deepEqual(body.messages, [{ role: "user", content: "What is 6*7?" }]);
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

  test("SCO-260 quick-win #2: parses usage.input_tokens/output_tokens into result.usage", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        content: [{ text: "hello there" }],
        usage: { input_tokens: 45, output_tokens: 12 },
      })) as typeof fetch;

    const result = await executeProviderCall("anthropic", "sk-ant-test", "anthropic/claude-sonnet-5", "hi");

    assert.deepEqual(result.usage, { inputTokens: 45, outputTokens: 12 });
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

  // SCO-330 (fix #4 bonus)
  test("requests max_tokens: 8192, not the old hardcoded 4096", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return jsonResponse(200, { content: [{ text: "hi" }] });
    }) as typeof fetch;

    await executeProviderCall("anthropic", "sk-ant-test", "anthropic/claude-sonnet-5", "hi");

    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.max_tokens, 8192);
  });

  test("stop_reason: 'max_tokens' sets truncated: true", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { content: [{ text: "cut off mid-sen" }], stop_reason: "max_tokens" })) as typeof fetch;

    const result = await executeProviderCall("anthropic", "sk-ant-test", "anthropic/claude-sonnet-5", "hi");

    assert.equal(result.truncated, true);
  });

  test("a present stop_reason other than 'max_tokens' (e.g. end_turn) sets truncated: false", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { content: [{ text: "complete." }], stop_reason: "end_turn" })) as typeof fetch;

    const result = await executeProviderCall("anthropic", "sk-ant-test", "anthropic/claude-sonnet-5", "hi");

    assert.equal(result.truncated, false);
  });

  test("no stop_reason at all leaves truncated undefined", async () => {
    globalThis.fetch = (async () => jsonResponse(200, { content: [{ text: "hi" }] })) as typeof fetch;

    const result = await executeProviderCall("anthropic", "sk-ant-test", "anthropic/claude-sonnet-5", "hi");

    assert.equal(result.truncated, undefined);
  });
});

// ---------------------------------------------------------------------------
// SCO-262 — a hung request has no response to classify without a bounded
// timeout. This fetch stub mirrors real fetch's own AbortSignal behavior
// (reject with an AbortError once the passed signal aborts) rather than just
// asserting a timeoutMs is threaded through — it exercises the actual
// setTimeout/AbortController wiring in provider-execute.ts, not a stand-in
// for it.
// ---------------------------------------------------------------------------
describe("executeProviderCall — timeout (SCO-262)", () => {
  function hangingFetch(): typeof fetch {
    return ((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as typeof fetch;
  }

  test("OpenAI-compatible adapter: a hung request times out and classifies as network-error", async () => {
    globalThis.fetch = hangingFetch();
    await assert.rejects(
      () => executeProviderCall("openai", "sk-test", "openai/gpt-5.5", "hi", 20),
      (e: unknown) => {
        assert.ok(e instanceof ProviderExecutionError);
        assert.equal(e.kind, "network-error");
        assert.match(e.message, /timed out/i);
        return true;
      },
    );
  });

  test("Anthropic adapter: a hung request times out and classifies as network-error", async () => {
    globalThis.fetch = hangingFetch();
    await assert.rejects(
      () => executeProviderCall("anthropic", "sk-test", "anthropic/claude-sonnet-5", "hi", 20),
      (e: unknown) => {
        assert.ok(e instanceof ProviderExecutionError);
        assert.equal(e.kind, "network-error");
        assert.match(e.message, /timed out/i);
        return true;
      },
    );
  });

  test("defaults to DEFAULT_PROVIDER_TIMEOUT_MS when no timeoutMs is passed", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse(200, { choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    await executeProviderCall("openai", "sk-test", "openai/gpt-5.5", "hi");
    // The signal exists (a timer was armed); the default constant itself is
    // asserted directly rather than by racing a real 60s clock.
    assert.ok(calls[0]!.signal instanceof AbortSignal);
    assert.equal(DEFAULT_PROVIDER_TIMEOUT_MS, 60_000);
  });
});
