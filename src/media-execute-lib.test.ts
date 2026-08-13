import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  MediaExecutionError,
  classifyMediaHttpFailure,
  describeMediaFailure,
  downloadMediaResult,
  timedFetch,
} from "./media-execute-lib.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("classifyMediaHttpFailure", () => {
  test("401/403 -> invalid-key", () => {
    assert.equal(classifyMediaHttpFailure("runway", 401, "").kind, "invalid-key");
    assert.equal(classifyMediaHttpFailure("runway", 403, "").kind, "invalid-key");
  });

  test("429 -> rate-limited", () => {
    assert.equal(classifyMediaHttpFailure("elevenlabs", 429, "").kind, "rate-limited");
  });

  test("404 -> model-not-found", () => {
    assert.equal(classifyMediaHttpFailure("runway", 404, "").kind, "model-not-found");
  });

  test("a 400 with a model-not-found-shaped body -> model-not-found", () => {
    const error = classifyMediaHttpFailure("runway", 400, "Error: model does not exist");
    assert.equal(error.kind, "model-not-found");
  });

  test("other 5xx -> provider-error", () => {
    assert.equal(classifyMediaHttpFailure("elevenlabs", 503, "").kind, "provider-error");
  });
});

describe("timedFetch", () => {
  test("returns the response on success", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    const res = await timedFetch("runway", "https://example.test", {}, 1000);
    assert.equal(res.status, 200);
  });

  test("classifies a thrown network error as MediaExecutionError network-error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    await assert.rejects(
      () => timedFetch("runway", "https://example.test", {}, 1000),
      (e: unknown) => e instanceof MediaExecutionError && e.kind === "network-error" && e.message.includes("boom"),
    );
  });

  test("classifies an abort (timeout) as network-error with a timeout message", async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;
    await assert.rejects(
      () => timedFetch("runway", "https://example.test", {}, 5),
      (e: unknown) => e instanceof MediaExecutionError && e.kind === "network-error" && e.message.includes("timed out"),
    );
  });
});

describe("downloadMediaResult", () => {
  test("happy path returns bytes and content-type", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "video/mp4" } })) as typeof fetch;
    const result = await downloadMediaResult("runway", "https://example.test/result.mp4");
    assert.deepEqual([...result.bytes], [1, 2, 3]);
    assert.equal(result.contentType, "video/mp4");
  });

  test("a 4xx on the result URL is classified as result-expired", async () => {
    globalThis.fetch = (async () => new Response("gone", { status: 403 })) as typeof fetch;
    await assert.rejects(
      () => downloadMediaResult("runway", "https://example.test/result.mp4"),
      (e: unknown) => e instanceof MediaExecutionError && e.kind === "result-expired",
    );
  });

  test("a 5xx on the result URL is classified as provider-error, not result-expired", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await assert.rejects(
      () => downloadMediaResult("runway", "https://example.test/result.mp4"),
      (e: unknown) => e instanceof MediaExecutionError && e.kind === "provider-error",
    );
  });
});

describe("describeMediaFailure", () => {
  test("covers every failure kind with a non-empty description", () => {
    const kinds = [
      "invalid-key",
      "rate-limited",
      "network-error",
      "provider-error",
      "model-not-found",
      "job-failed",
      "job-canceled",
      "job-not-found",
      "result-expired",
      "poll-budget-exceeded",
    ] as const;
    for (const kind of kinds) {
      const description = describeMediaFailure(new MediaExecutionError(kind, "runway", "detail"));
      assert.ok(description.length > 0, `expected a description for ${kind}`);
    }
  });
});
