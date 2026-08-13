import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { MediaExecutionError } from "./media-execute-lib.js";
import {
  ELEVENLABS_BASE_URL,
  executeElevenLabsIvc,
  executeElevenLabsTts,
  pollElevenLabsDubbing,
  resolveElevenLabsModelId,
  runElevenLabsDubbingToCompletion,
  submitElevenLabsDubbing,
} from "./elevenlabs-execute.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("resolveElevenLabsModelId", () => {
  test("matches all three registered ElevenLabs model IDs", () => {
    assert.equal(resolveElevenLabsModelId("elevenlabs/flash-v2-5"), "eleven_flash_v2_5");
    assert.equal(resolveElevenLabsModelId("elevenlabs/eleven-v3"), "eleven_v3");
    assert.equal(resolveElevenLabsModelId("elevenlabs/multilingual-v2"), "eleven_multilingual_v2");
  });

  test("does not double-prefix a name already starting with eleven", () => {
    assert.equal(resolveElevenLabsModelId("elevenlabs/eleven-v3"), "eleven_v3");
    assert.ok(!resolveElevenLabsModelId("elevenlabs/eleven-v3").startsWith("eleven_eleven"));
  });
});

describe("executeElevenLabsTts", () => {
  test("posts JSON to /v1/text-to-speech/{voice_id} with xi-api-key, not Bearer, and returns raw bytes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch;

    const result = await executeElevenLabsTts("el-key", { voiceId: "voice-1", text: "hello", modelId: "eleven_flash_v2_5" });

    assert.equal(calls[0]!.url, `${ELEVENLABS_BASE_URL}/v1/text-to-speech/voice-1`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["xi-api-key"], "el-key");
    assert.equal(headers["authorization"], undefined);
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.text, "hello");
    assert.equal(body.model_id, "eleven_flash_v2_5");
    assert.deepEqual([...result.bytes], [1, 2, 3]);
    assert.equal(result.contentType, "audio/mpeg");
  });

  test("a 401 is classified as invalid-key, matching the shared submission-level table", async () => {
    globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
    await assert.rejects(
      () => executeElevenLabsTts("bad-key", { voiceId: "voice-1", text: "hi" }),
      (e: unknown) => e instanceof MediaExecutionError && e.kind === "invalid-key",
    );
  });
});

describe("executeElevenLabsIvc", () => {
  test("posts multipart form data to /v1/voices/add and returns the voice id", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { voice_id: "voice-abc", requires_verification: true });
    }) as typeof fetch;

    const result = await executeElevenLabsIvc("el-key", {
      name: "My Voice",
      files: [{ bytes: new Uint8Array([1, 2]), filename: "sample.mp3" }],
    });

    assert.equal(calls[0]!.url, `${ELEVENLABS_BASE_URL}/v1/voices/add`);
    assert.ok(calls[0]!.init.body instanceof FormData);
    assert.equal(result.voiceId, "voice-abc");
    assert.equal(result.requiresVerification, true);
  });
});

describe("submitElevenLabsDubbing / pollElevenLabsDubbing", () => {
  test("submit posts multipart form data with target_lang and returns the dubbing handle", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { dubbing_id: "dub-1", expected_duration_sec: 30 });
    }) as typeof fetch;

    const handle = await submitElevenLabsDubbing("el-key", {
      file: { bytes: new Uint8Array([1]), filename: "clip.mp4" },
      targetLang: "es",
    });

    assert.equal(calls[0]!.url, `${ELEVENLABS_BASE_URL}/v1/dubbing`);
    assert.equal(handle.dubbingId, "dub-1");
    assert.equal(handle.expectedDurationSec, 30);
  });

  test("poll returns the current status", async () => {
    globalThis.fetch = (async () => jsonResponse(200, { dubbing_id: "dub-1", status: "dubbing" })) as typeof fetch;
    const state = await pollElevenLabsDubbing("el-key", "dub-1");
    assert.equal(state.status, "dubbing");
  });

  test("a 404 mid-poll is classified as job-not-found", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    await assert.rejects(
      () => pollElevenLabsDubbing("el-key", "dub-1"),
      (e: unknown) => e instanceof MediaExecutionError && e.kind === "job-not-found",
    );
  });
});

describe("runElevenLabsDubbingToCompletion", () => {
  function fakeClock() {
    let now = 0;
    return { nowFn: () => now, sleepFn: async (ms: number) => { now += ms; } };
  }

  test("polls until dubbed, then downloads and returns the result", async () => {
    let pollCount = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (init.method === "POST") return jsonResponse(200, { dubbing_id: "dub-1", expected_duration_sec: 10 });
      if (url.includes("/audio/")) return new Response(new Uint8Array([9, 9]), { status: 200, headers: { "content-type": "audio/mpeg" } });
      pollCount++;
      if (pollCount < 2) return jsonResponse(200, { dubbing_id: "dub-1", status: "dubbing" });
      return jsonResponse(200, { dubbing_id: "dub-1", status: "dubbed" });
    }) as typeof fetch;

    const { nowFn, sleepFn } = fakeClock();
    const result = await runElevenLabsDubbingToCompletion(
      "el-key",
      { file: { bytes: new Uint8Array([1]), filename: "clip.mp4" }, targetLang: "es" },
      "es",
      { nowFn, sleepFn },
    );

    assert.equal(result.outcome, "success");
    if (result.outcome === "success") assert.deepEqual([...result.result.bytes], [9, 9]);
  });

  test("a failed terminal status is reported as job-failed", async () => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      if (init.method === "POST") return jsonResponse(200, { dubbing_id: "dub-1", expected_duration_sec: 10 });
      return jsonResponse(200, { dubbing_id: "dub-1", status: "failed", error: "unsupported language" });
    }) as typeof fetch;

    const { nowFn, sleepFn } = fakeClock();
    const result = await runElevenLabsDubbingToCompletion(
      "el-key",
      { file: { bytes: new Uint8Array([1]), filename: "clip.mp4" }, targetLang: "xx" },
      "xx",
      { nowFn, sleepFn },
    );

    assert.equal(result.outcome, "failed");
    if (result.outcome === "failed") {
      assert.equal(result.error.kind, "job-failed");
      assert.match(result.error.message, /unsupported language/);
    }
  });

  test("cancellation never calls DELETE (no confirmed cancel endpoint) and reports job-canceled", async () => {
    let deleteCalled = false;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      if (init.method === "POST") return jsonResponse(200, { dubbing_id: "dub-1", expected_duration_sec: 10 });
      if (init.method === "DELETE") {
        deleteCalled = true;
        return new Response(null, { status: 200 });
      }
      return jsonResponse(200, { dubbing_id: "dub-1", status: "dubbing" });
    }) as typeof fetch;

    const { nowFn, sleepFn } = fakeClock();
    const result = await runElevenLabsDubbingToCompletion(
      "el-key",
      { file: { bytes: new Uint8Array([1]), filename: "clip.mp4" }, targetLang: "es" },
      "es",
      { nowFn, sleepFn, isCancelled: () => true },
    );

    assert.equal(result.outcome, "failed");
    if (result.outcome === "failed") assert.equal(result.error.kind, "job-canceled");
    assert.equal(deleteCalled, false, "no cancel endpoint should ever be called for dubbing");
  });

  test("exceeding the total job timeout returns poll-budget-exceeded", async () => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      if (init.method === "POST") return jsonResponse(200, { dubbing_id: "dub-1", expected_duration_sec: 10 });
      return jsonResponse(200, { dubbing_id: "dub-1", status: "dubbing" });
    }) as typeof fetch;

    const { nowFn, sleepFn } = fakeClock();
    const result = await runElevenLabsDubbingToCompletion(
      "el-key",
      { file: { bytes: new Uint8Array([1]), filename: "clip.mp4" }, targetLang: "es" },
      "es",
      { nowFn, sleepFn, totalJobTimeoutMs: 10_000, pollIntervalMs: 5_000 },
    );

    assert.equal(result.outcome, "failed");
    if (result.outcome === "failed") assert.equal(result.error.kind, "poll-budget-exceeded");
  });
});
