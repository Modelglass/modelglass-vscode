/**
 * SCO-430 — ElevenLabs execution adapter. Splits by ENDPOINT, not provider
 * (ADR-0012 Amendment 3 item 2 — "which contract a provider uses is
 * correctly scoped to the endpoint, not the provider"): core TTS and
 * Instant Voice Cloning (IVC) are sync binary-response (Amendment 2
 * Decision 1's first contract); dubbing is async job-submit-and-poll (the
 * second contract), with no confirmed cancel endpoint. vscode-free,
 * directly unit-testable via monkey-patched global `fetch`.
 *
 * API shapes grounded directly against ElevenLabs' own API reference
 * (elevenlabs.io/docs/api-reference, checked 2026-08-13):
 *  - Base URL: https://api.elevenlabs.io. Auth header: `xi-api-key`, NOT
 *    `Authorization: Bearer` (genuinely different from every other
 *    provider adapter in this codebase — Runway and every LLM provider use
 *    Bearer; ElevenLabs does not).
 *  - TTS: POST /v1/text-to-speech/{voice_id}, JSON body `{text, model_id?,
 *    voice_settings?}` -> raw audio bytes (Amendment 2's confirmed sync
 *    contract).
 *  - Dubbing submit: POST /v1/dubbing, multipart/form-data (`file` +
 *    `target_lang`, optional `source_lang`/`name`) -> `{dubbing_id,
 *    expected_duration_sec}`.
 *  - Dubbing poll: GET /v1/dubbing/{dubbing_id} -> `{status, error?}`.
 *    Terminal states: "dubbed" (success), "failed" (failure); anything else
 *    (e.g. "dubbing") is still in progress.
 *  - Dubbing result: GET /v1/dubbing/{dubbing_id}/audio/{language_code} ->
 *    raw audio/video bytes.
 *  - No dubbing cancel/delete endpoint found in the checked documentation —
 *    matches Amendment 3 item 2's own finding exactly; not re-guessed here.
 *  - IVC: POST /v1/voices/add, multipart/form-data (`name` + `files`) ->
 *    `{voice_id, requires_verification}`.
 */

import {
  DEFAULT_MEDIA_CALL_TIMEOUT_MS,
  DEFAULT_MEDIA_JOB_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MediaExecutionError,
  classifyMediaHttpFailure,
  timedFetch,
  type DownloadedResult,
} from "./media-execute-lib.js";

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

function elevenLabsHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  return { "xi-api-key": apiKey, ...extra };
}

/**
 * SCO-430 — the Modelglass registry has no `provider_model_id` override set
 * on any of its three ElevenLabs entries (checked directly,
 * packages/data-audio/registry/models/*-elevenlabs.yaml, 2026-08-13), and
 * provider-execute.ts's generic "strip creator-org/" heuristic
 * (resolveProviderModelId) does NOT produce ElevenLabs' real model_id
 * strings — `elevenlabs/flash-v2-5` strips to `flash-v2-5`, but ElevenLabs'
 * actual identifier is `eleven_flash_v2_5`. This is a second, ElevenLabs-
 * specific heuristic instead: hyphens -> underscores, then an `eleven_`
 * prefix UNLESS the name already starts with `eleven` (so `eleven-v3` ->
 * `eleven_v3`, not `eleven_eleven_v3`). Verified against all three
 * registered entries as of this ticket: flash-v2-5 -> eleven_flash_v2_5,
 * eleven-v3 -> eleven_v3, multilingual-v2 -> eleven_multilingual_v2 — all
 * three match ElevenLabs' own documented model IDs. Same honesty this
 * codebase already holds resolveProviderModelId to: a heuristic confirmed
 * against today's known cases, not guaranteed for a model added later with
 * a differently-shaped slug — revisit if/when the registry gains a
 * `provider_model_id` override for this provider.
 */
export function resolveElevenLabsModelId(registryModelId: string): string {
  const afterSlash = registryModelId.includes("/") ? registryModelId.slice(registryModelId.indexOf("/") + 1) : registryModelId;
  const underscored = afterSlash.replace(/-/g, "_");
  return underscored.startsWith("eleven") ? underscored : `eleven_${underscored}`;
}

// ---------------------------------------------------------------------------
// Core TTS — sync (Amendment 2 Decision 1, first contract)
// ---------------------------------------------------------------------------

export interface ElevenLabsTtsParams {
  voiceId: string;
  text: string;
  modelId?: string;
}

export async function executeElevenLabsTts(
  apiKey: string,
  params: ElevenLabsTtsParams,
  timeoutMs: number = DEFAULT_MEDIA_CALL_TIMEOUT_MS,
): Promise<DownloadedResult> {
  const response = await timedFetch(
    "elevenlabs",
    `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(params.voiceId)}`,
    {
      method: "POST",
      headers: elevenLabsHeaders(apiKey, { "content-type": "application/json" }),
      body: JSON.stringify({
        text: params.text,
        ...(params.modelId ? { model_id: params.modelId } : {}),
      }),
    },
    timeoutMs,
  );
  if (!response.ok) {
    throw classifyMediaHttpFailure("elevenlabs", response.status, await response.text());
  }
  const arrayBuffer = await response.arrayBuffer();
  return { bytes: new Uint8Array(arrayBuffer), contentType: response.headers.get("content-type") };
}

// ---------------------------------------------------------------------------
// Instant Voice Cloning — sync, same contract as TTS (Amendment 3 item 2)
// ---------------------------------------------------------------------------

export interface ElevenLabsIvcParams {
  name: string;
  files: { bytes: Uint8Array; filename: string }[];
}

export interface ElevenLabsIvcResult {
  voiceId: string;
  requiresVerification: boolean;
}

export async function executeElevenLabsIvc(
  apiKey: string,
  params: ElevenLabsIvcParams,
  timeoutMs: number = DEFAULT_MEDIA_CALL_TIMEOUT_MS,
): Promise<ElevenLabsIvcResult> {
  const form = new FormData();
  form.set("name", params.name);
  for (const file of params.files) {
    form.append("files", new Blob([Buffer.from(file.bytes)]), file.filename);
  }
  const response = await timedFetch(
    "elevenlabs",
    `${ELEVENLABS_BASE_URL}/v1/voices/add`,
    { method: "POST", headers: elevenLabsHeaders(apiKey), body: form },
    timeoutMs,
  );
  if (!response.ok) {
    throw classifyMediaHttpFailure("elevenlabs", response.status, await response.text());
  }
  const json = (await response.json()) as { voice_id: string; requires_verification: boolean };
  return { voiceId: json.voice_id, requiresVerification: json.requires_verification };
}

// ---------------------------------------------------------------------------
// Dubbing — async job-submit-and-poll (Amendment 2 Decision 1, second
// contract), NO confirmed cancel endpoint (Amendment 3 item 2).
// ---------------------------------------------------------------------------

export interface ElevenLabsDubbingSubmitParams {
  file: { bytes: Uint8Array; filename: string };
  targetLang: string;
  sourceLang?: string;
  name?: string;
}

export interface ElevenLabsDubbingHandle {
  dubbingId: string;
  expectedDurationSec: number;
}

export async function submitElevenLabsDubbing(
  apiKey: string,
  params: ElevenLabsDubbingSubmitParams,
  timeoutMs: number = DEFAULT_MEDIA_CALL_TIMEOUT_MS,
): Promise<ElevenLabsDubbingHandle> {
  const form = new FormData();
  form.set("target_lang", params.targetLang);
  if (params.sourceLang) form.set("source_lang", params.sourceLang);
  if (params.name) form.set("name", params.name);
  form.append("file", new Blob([Buffer.from(params.file.bytes)]), params.file.filename);

  const response = await timedFetch(
    "elevenlabs",
    `${ELEVENLABS_BASE_URL}/v1/dubbing`,
    { method: "POST", headers: elevenLabsHeaders(apiKey), body: form },
    timeoutMs,
  );
  if (!response.ok) {
    throw classifyMediaHttpFailure("elevenlabs", response.status, await response.text());
  }
  const json = (await response.json()) as { dubbing_id: string; expected_duration_sec: number };
  return { dubbingId: json.dubbing_id, expectedDurationSec: json.expected_duration_sec };
}

export interface ElevenLabsDubbingState {
  dubbingId: string;
  status: string;
  error?: string | null;
}

const DUBBING_TERMINAL_SUCCESS = "dubbed";
const DUBBING_TERMINAL_FAILURE = "failed";

export async function pollElevenLabsDubbing(
  apiKey: string,
  dubbingId: string,
  timeoutMs: number = DEFAULT_MEDIA_CALL_TIMEOUT_MS,
): Promise<ElevenLabsDubbingState> {
  const response = await timedFetch(
    "elevenlabs",
    `${ELEVENLABS_BASE_URL}/v1/dubbing/${encodeURIComponent(dubbingId)}`,
    { method: "GET", headers: elevenLabsHeaders(apiKey) },
    timeoutMs,
  );
  if (!response.ok) {
    if (response.status === 404) {
      throw new MediaExecutionError(
        "job-not-found",
        "elevenlabs",
        `dubbing job ${dubbingId} was not found (HTTP 404) — it may have expired or been purged`,
      );
    }
    throw classifyMediaHttpFailure("elevenlabs", response.status, await response.text());
  }
  const json = (await response.json()) as { dubbing_id: string; status: string; error?: string | null };
  return { dubbingId: json.dubbing_id, status: json.status, error: json.error };
}

export async function downloadElevenLabsDubbingResult(
  apiKey: string,
  dubbingId: string,
  languageCode: string,
  timeoutMs: number = DEFAULT_MEDIA_CALL_TIMEOUT_MS,
): Promise<DownloadedResult> {
  const response = await timedFetch(
    "elevenlabs",
    `${ELEVENLABS_BASE_URL}/v1/dubbing/${encodeURIComponent(dubbingId)}/audio/${encodeURIComponent(languageCode)}`,
    { method: "GET", headers: elevenLabsHeaders(apiKey) },
    timeoutMs,
  );
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      throw new MediaExecutionError(
        "result-expired",
        "elevenlabs",
        `the dubbing result returned HTTP ${response.status} — it may have expired`,
      );
    }
    throw classifyMediaHttpFailure("elevenlabs", response.status, await response.text());
  }
  const arrayBuffer = await response.arrayBuffer();
  return { bytes: new Uint8Array(arrayBuffer), contentType: response.headers.get("content-type") };
}

export interface ElevenLabsDubbingProgress {
  status: string;
  elapsedMs: number;
}

export type ElevenLabsDubbingOutcome =
  | { outcome: "success"; dubbingId: string; result: DownloadedResult }
  | { outcome: "failed"; dubbingId?: string; error: MediaExecutionError };

/**
 * Full submit -> poll-until-terminal -> download orchestration. Same
 * injectable sleepFn/nowFn/isCancelled shape as
 * runway-execute.ts's runRunwayJobToCompletion, with ONE deliberate
 * difference: on cancellation, this does NOT attempt a provider-side cancel
 * call at all — Amendment 3 item 2 confirms none was found in ElevenLabs'
 * documented dubbing endpoints (not "not yet implemented here"; genuinely
 * not confirmed to exist). Per Amendment 2 Decision 4, the extension stops
 * polling and the job may continue running and billing on ElevenLabs' side
 * — the caller (generate-audio.ts) is responsible for disclosing this in
 * the cancellation UI copy, not silently assuming it away.
 */
export async function runElevenLabsDubbingToCompletion(
  apiKey: string,
  submitParams: ElevenLabsDubbingSubmitParams,
  languageCode: string,
  options: {
    perCallTimeoutMs?: number;
    totalJobTimeoutMs?: number;
    pollIntervalMs?: number;
    onProgress?: (update: ElevenLabsDubbingProgress) => void;
    isCancelled?: () => boolean;
    sleepFn?: (ms: number) => Promise<void>;
    nowFn?: () => number;
  } = {},
): Promise<ElevenLabsDubbingOutcome> {
  const {
    perCallTimeoutMs = DEFAULT_MEDIA_CALL_TIMEOUT_MS,
    totalJobTimeoutMs = DEFAULT_MEDIA_JOB_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    onProgress,
    isCancelled = () => false,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowFn = Date.now,
  } = options;

  const startedAt = nowFn();
  let dubbingId: string | undefined;

  try {
    const handle = await submitElevenLabsDubbing(apiKey, submitParams, perCallTimeoutMs);
    dubbingId = handle.dubbingId;
  } catch (e) {
    const error = e instanceof MediaExecutionError ? e : new MediaExecutionError("provider-error", "elevenlabs", e instanceof Error ? e.message : String(e));
    return { outcome: "failed", error };
  }

  for (;;) {
    if (isCancelled()) {
      // No cancel endpoint (see this function's header) — stop polling
      // client-side only. The dubbing job itself may still be running.
      return {
        outcome: "failed",
        dubbingId,
        error: new MediaExecutionError(
          "job-canceled",
          "elevenlabs",
          "canceled by the user client-side — ElevenLabs has no confirmed dubbing-cancel endpoint, so the job may continue running (and billing) on their side",
        ),
      };
    }

    const elapsedMs = nowFn() - startedAt;
    if (elapsedMs >= totalJobTimeoutMs) {
      return {
        outcome: "failed",
        dubbingId,
        error: new MediaExecutionError(
          "poll-budget-exceeded",
          "elevenlabs",
          `dubbing job did not reach a terminal state within the ${totalJobTimeoutMs}ms wait budget`,
        ),
      };
    }

    let state: ElevenLabsDubbingState;
    try {
      state = await pollElevenLabsDubbing(apiKey, dubbingId, perCallTimeoutMs);
    } catch (e) {
      const error = e instanceof MediaExecutionError ? e : new MediaExecutionError("provider-error", "elevenlabs", e instanceof Error ? e.message : String(e));
      return { outcome: "failed", dubbingId, error };
    }

    onProgress?.({ status: state.status, elapsedMs });

    if (state.status === DUBBING_TERMINAL_SUCCESS) {
      try {
        const result = await downloadElevenLabsDubbingResult(apiKey, dubbingId, languageCode, perCallTimeoutMs);
        return { outcome: "success", dubbingId, result };
      } catch (e) {
        const error = e instanceof MediaExecutionError ? e : new MediaExecutionError("provider-error", "elevenlabs", e instanceof Error ? e.message : String(e));
        return { outcome: "failed", dubbingId, error };
      }
    }
    if (state.status === DUBBING_TERMINAL_FAILURE) {
      return {
        outcome: "failed",
        dubbingId,
        error: new MediaExecutionError("job-failed", "elevenlabs", state.error ?? `dubbing job ${dubbingId} failed`),
      };
    }

    await sleepFn(pollIntervalMs);
  }
}
