import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { MediaExecutionError } from "./media-execute-lib.js";
import {
  RUNWAY_BASE_URL,
  cancelRunwayTask,
  pollRunwayTask,
  runRunwayJobToCompletion,
  submitRunwayJob,
} from "./runway-execute.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("submitRunwayJob", () => {
  test("posts to the right endpoint with Runway's required headers and returns the task id", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { id: "task-123" });
    }) as typeof fetch;

    const result = await submitRunwayJob("rw-key", "text_to_video", { model: "gen4.5", promptText: "a cat" });

    assert.equal(result.taskId, "task-123");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `${RUNWAY_BASE_URL}/v1/text_to_video`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["authorization"], "Bearer rw-key");
    assert.equal(headers["x-runway-version"], "2024-11-06");
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.model, "gen4.5");
    assert.equal(body.promptText, "a cat");
  });

  test("image_to_video includes promptImage in the body", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return jsonResponse(200, { id: "task-456" });
    }) as typeof fetch;

    await submitRunwayJob("rw-key", "image_to_video", { model: "gen4-5", promptText: "animate this", promptImage: "data:image/png;base64,AAAA" });
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.promptImage, "data:image/png;base64,AAAA");
    assert.equal(body.videoUri, undefined);
  });

  test("a 401 response is classified as invalid-key", async () => {
    globalThis.fetch = (async () => jsonResponse(401, { error: "bad key" })) as typeof fetch;
    await assert.rejects(
      () => submitRunwayJob("bad-key", "text_to_video", { model: "gen4.5", promptText: "x" }),
      (e: unknown) => e instanceof MediaExecutionError && e.kind === "invalid-key",
    );
  });
});

describe("pollRunwayTask", () => {
  test("returns the parsed task state", async () => {
    globalThis.fetch = (async () => jsonResponse(200, { id: "task-1", status: "RUNNING", progress: 0.4 })) as typeof fetch;
    const state = await pollRunwayTask("rw-key", "task-1");
    assert.equal(state.status, "RUNNING");
    assert.equal(state.progress, 0.4);
  });

  test("a 404 mid-poll is classified as job-not-found, not model-not-found", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    await assert.rejects(
      () => pollRunwayTask("rw-key", "task-1"),
      (e: unknown) => e instanceof MediaExecutionError && e.kind === "job-not-found",
    );
  });
});

describe("cancelRunwayTask", () => {
  test("calls DELETE /v1/tasks/{id} and reports success", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const result = await cancelRunwayTask("rw-key", "task-1");
    assert.equal(result.cancelRequestSucceeded, true);
    assert.equal(calls[0]!.url, `${RUNWAY_BASE_URL}/v1/tasks/task-1`);
    assert.equal(calls[0]!.init.method, "DELETE");
  });

  test("swallows a network failure and reports cancelRequestSucceeded: false, rather than throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await cancelRunwayTask("rw-key", "task-1");
    assert.equal(result.cancelRequestSucceeded, false);
  });
});

describe("runRunwayJobToCompletion", () => {
  function fakeClock() {
    let now = 0;
    return { nowFn: () => now, sleepFn: async (ms: number) => { now += ms; } };
  }

  test("polls until SUCCEEDED and returns the result URLs", async () => {
    let pollCount = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (init.method === "POST") return jsonResponse(200, { id: "task-1" });
      pollCount++;
      if (pollCount < 3) return jsonResponse(200, { id: "task-1", status: "RUNNING" });
      return jsonResponse(200, { id: "task-1", status: "SUCCEEDED", output: ["https://example.test/out.mp4"] });
    }) as typeof fetch;

    const { nowFn, sleepFn } = fakeClock();
    const result = await runRunwayJobToCompletion(
      "rw-key",
      "text_to_video",
      { model: "gen4.5", promptText: "x" },
      { nowFn, sleepFn },
    );

    assert.equal(result.outcome, "success");
    if (result.outcome === "success") {
      assert.deepEqual(result.resultUrls, ["https://example.test/out.mp4"]);
    }
    assert.equal(pollCount, 3);
  });

  test("a FAILED terminal status is reported as job-failed", async () => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      if (init.method === "POST") return jsonResponse(200, { id: "task-1" });
      return jsonResponse(200, { id: "task-1", status: "FAILED", failure: "content policy violation" });
    }) as typeof fetch;

    const { nowFn, sleepFn } = fakeClock();
    const result = await runRunwayJobToCompletion("rw-key", "text_to_video", { model: "gen4.5", promptText: "x" }, { nowFn, sleepFn });

    assert.equal(result.outcome, "failed");
    if (result.outcome === "failed") {
      assert.equal(result.error.kind, "job-failed");
      assert.match(result.error.message, /content policy violation/);
    }
  });

  test("exceeding the total job timeout returns poll-budget-exceeded without ever succeeding", async () => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      if (init.method === "POST") return jsonResponse(200, { id: "task-1" });
      return jsonResponse(200, { id: "task-1", status: "RUNNING" });
    }) as typeof fetch;

    const { nowFn, sleepFn } = fakeClock();
    const result = await runRunwayJobToCompletion(
      "rw-key",
      "text_to_video",
      { model: "gen4.5", promptText: "x" },
      { nowFn, sleepFn, totalJobTimeoutMs: 20_000, pollIntervalMs: 5_000 },
    );

    assert.equal(result.outcome, "failed");
    if (result.outcome === "failed") assert.equal(result.error.kind, "poll-budget-exceeded");
  });

  test("cancellation stops polling, calls the cancel endpoint, and reports job-canceled", async () => {
    let pollCount = 0;
    let cancelCalled = false;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      if (init.method === "POST") return jsonResponse(200, { id: "task-1" });
      if (init.method === "DELETE") {
        cancelCalled = true;
        return new Response(null, { status: 200 });
      }
      pollCount++;
      return jsonResponse(200, { id: "task-1", status: "RUNNING" });
    }) as typeof fetch;

    const { nowFn, sleepFn } = fakeClock();
    let cancelled = false;
    const result = await runRunwayJobToCompletion(
      "rw-key",
      "text_to_video",
      { model: "gen4.5", promptText: "x" },
      { nowFn, sleepFn, isCancelled: () => cancelled, onProgress: () => { cancelled = true; } },
    );

    assert.equal(result.outcome, "failed");
    if (result.outcome === "failed") assert.equal(result.error.kind, "job-canceled");
    assert.equal(cancelCalled, true);
    assert.equal(pollCount, 1);
  });

  test("a submission failure (e.g. invalid key) short-circuits before any poll", async () => {
    globalThis.fetch = (async () => jsonResponse(401, {})) as typeof fetch;
    const { nowFn, sleepFn } = fakeClock();
    const result = await runRunwayJobToCompletion("bad-key", "text_to_video", { model: "gen4.5", promptText: "x" }, { nowFn, sleepFn });
    assert.equal(result.outcome, "failed");
    if (result.outcome === "failed") assert.equal(result.error.kind, "invalid-key");
  });
});
