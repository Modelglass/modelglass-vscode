/**
 * SCO-430 — Runway execution adapter: async job-submit-and-poll (ADR-0012
 * Amendment 2 Decision 1's second contract). vscode-free, directly
 * unit-testable via monkey-patched global `fetch`, same convention as
 * provider-execute.ts / media-execute-lib.ts.
 *
 * API shapes grounded directly against Runway's own Node SDK source
 * (github.com/runwayml/sdk-node, checked 2026-08-13 — same "trace to a
 * primary/vendor source, don't guess" bar this codebase's ADR/CONTRIBUTING
 * conventions already hold registry data to):
 *  - Base URL: https://api.dev.runwayml.com
 *  - Headers: `Authorization: Bearer <key>`, `X-Runway-Version: 2024-11-06`,
 *    `Content-Type: application/json` on POST bodies.
 *  - Submit: POST /v1/{text_to_video|image_to_video|video_to_video} ->
 *    `{ id: string }`.
 *  - Poll: GET /v1/tasks/{id} -> `{ id, status, progress?, output?: string[],
 *    failure?: string, failureCode?: string }`. Status enum: PENDING,
 *    THROTTLED, RUNNING, SUCCEEDED, FAILED, CANCELLED (Runway's own
 *    spelling — two Ls).
 *  - Cancel: DELETE /v1/tasks/{id} -> void. Confirmed by ADR-0012 Amendment
 *    3 item 1 against Runway's public API reference directly.
 */

import {
  DEFAULT_MEDIA_CALL_TIMEOUT_MS,
  DEFAULT_MEDIA_JOB_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MediaExecutionError,
  classifyMediaHttpFailure,
  downloadMediaResult,
  timedFetch,
  type DownloadedResult,
} from "./media-execute-lib.js";

export const RUNWAY_BASE_URL = "https://api.dev.runwayml.com";
export const RUNWAY_API_VERSION = "2024-11-06";

export type RunwayEndpoint = "text_to_video" | "image_to_video" | "video_to_video";

/** The three request-body shapes this adapter supports, one per endpoint —
 *  matching Amendment 2 Decision 1's "which contract is a property of the
 *  provider's integration, not a runtime choice" framing extended down to
 *  endpoint-shape too: a caller picks the endpoint that matches the target
 *  model's registry `model.modality` (image-to-video/text-to-video/
 *  video-to-video), not a single "maybe has an image" params blob. */
export interface RunwaySubmitParams {
  model: string;
  promptText: string;
  ratio?: string;
  duration?: number;
  /** Required for image_to_video — a public URL or data URI, per Runway's
   *  own `promptImage` field name. */
  promptImage?: string;
  /** Required for video_to_video (e.g. Aleph 2) — a public URL or data URI. */
  videoUri?: string;
  seed?: number;
}

interface RunwaySubmitResponse {
  id: string;
}

function runwayHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "x-runway-version": RUNWAY_API_VERSION,
    ...extra,
  };
}

/**
 * SCO-430 hotfix — found live (2026-08-13): this file was sending the
 * Modelglass REGISTRY model_id (e.g. "runway/gen-4-5") straight through as
 * Runway's `model` field, unmodified. Runway rejects it with a 400 —
 * its own API uses a genuinely different naming convention (no creator
 * prefix, underscores not hyphens, some abbreviated: "gen4.5", "gen4_turbo",
 * "seedance2"). This is the same class of problem
 * elevenlabs-execute.ts's resolveElevenLabsModelId already solves for
 * ElevenLabs — this file never got the equivalent, until now.
 *
 * An explicit lookup table, not a generic string-transform heuristic:
 * checked directly against Runway's own Node SDK source
 * (github.com/runwayml/sdk-node's text-to-video.ts/image-to-video.ts/
 * character-performance.ts, 2026-08-13) because the naming isn't a single
 * consistent pattern a heuristic could derive reliably (gen4.5 keeps its
 * dot; gen4_turbo/seedance2 don't) — guessing wrong here just trades one
 * 400 for another.
 *
 * Two of this repo's seven registered Runway offerings are deliberately
 * UNSUPPORTED (mapped to `undefined`), not guessed at:
 *  - runway/gen-3-alpha — Gen-3 Alpha Turbo was retired from Runway's API
 *    2026-07-30 (confirmed via Runway's own API changelog); no valid
 *    `model` string exists anymore for it on any endpoint. The registry
 *    entry itself is stale (still status: ga) — a separate, adjacent data
 *    problem this fix doesn't touch, flagged here for whoever picks that up.
 *  - runway/act-two — genuinely a different endpoint (`/v1/character_
 *    performance`, confirmed via the SDK source), not `image_to_video` as
 *    this repo's endpointForSubModality mapping (generate-video.ts) assumes
 *    from the registry's `model.modality: image-to-video` classification.
 *    Character Performance takes a reference performance video + a
 *    character image, a different input shape than every other model this
 *    adapter supports — building that properly is a real follow-up, not a
 *    same-file fix.
 */
export function resolveRunwayModelId(registryModelId: string): string | undefined {
  const RUNWAY_MODEL_IDS: Record<string, string | undefined> = {
    "runway/gen-4-5": "gen4.5",
    "runway/gen-4-turbo": "gen4_turbo",
    "runway/seedance-2": "seedance2",
    "runway/aleph2": "aleph2",
    "happyhorse/happyhorse-1-0": "happyhorse_1_0",
    "runway/gen-3-alpha": undefined, // retired 2026-07-30 — see this function's header
    "runway/act-two": undefined, // needs /v1/character_performance — see this function's header
  };
  return RUNWAY_MODEL_IDS[registryModelId];
}

/**
 * SCO-430 hotfix 2 (2026-08-13) — found live, second real Runway 400 after
 * the model-ID fix above: this file omitted `ratio`/`duration` entirely,
 * on the assumption Runway would apply its own defaults when they're
 * absent. Wrong for some models — confirmed by the actual error hitting
 * gen4.5 (the cheapest, so the QuickPick's default pick): `ratio` has NO
 * server-side default for gen4.5/gen4_turbo specifically, so omitting it
 * is a guaranteed 400, not a graceful fallback.
 *
 * Checked per-model, not assumed uniform — Runway's own SDK source
 * (image-to-video.ts/text-to-video.ts/video-to-video.ts, same commit as
 * resolveRunwayModelId above) shows this genuinely varies by model:
 *  - gen4.5: `ratio` REQUIRED (6-value enum), `duration` REQUIRED (2-10s
 *    integer, no default).
 *  - gen4_turbo: `ratio` REQUIRED (same 6-value enum), `duration` optional.
 *  - seedance2, happyhorse_1_0 (on the text_to_video endpoint this repo
 *    calls them through), aleph2: both optional — Runway's own default
 *    applies, matching this repo's original (correct, for these three)
 *    assumption. Left alone; only gen4.5/gen4_turbo needed a fix.
 *
 * Landscape 1280:720 was picked as the default ratio (present in every
 * one of these models' enums, including gen4_turbo's) rather than a
 * per-endpoint aspect choice — a real creative decision a future ratio
 * QuickPick could expose, not attempted here to keep this a scoped fix
 * for the crash, not a new prompt step. 5s duration for gen4.5 matches
 * the worked example in Runway's own API documentation.
 */
const RUNWAY_REQUIRED_DEFAULTS: Record<string, { ratio?: string; duration?: number }> = {
  "gen4.5": { ratio: "1280:720", duration: 5 },
  gen4_turbo: { ratio: "1280:720" },
};

function buildSubmitBody(endpoint: RunwayEndpoint, model: string, params: RunwaySubmitParams): Record<string, unknown> {
  const defaults = RUNWAY_REQUIRED_DEFAULTS[model];
  const ratio = params.ratio ?? defaults?.ratio;
  const duration = params.duration ?? defaults?.duration;
  const base: Record<string, unknown> = { model, promptText: params.promptText };
  if (ratio !== undefined) base["ratio"] = ratio;
  if (duration !== undefined) base["duration"] = duration;
  if (params.seed !== undefined) base["seed"] = params.seed;
  if (endpoint === "image_to_video") base["promptImage"] = params.promptImage;
  if (endpoint === "video_to_video") base["videoUri"] = params.videoUri;
  return base;
}

export async function submitRunwayJob(
  apiKey: string,
  endpoint: RunwayEndpoint,
  params: RunwaySubmitParams,
  timeoutMs: number = DEFAULT_MEDIA_CALL_TIMEOUT_MS,
): Promise<{ taskId: string }> {
  const runwayModelId = resolveRunwayModelId(params.model);
  if (!runwayModelId) {
    throw new MediaExecutionError(
      "model-not-found",
      "runway",
      `no Runway API model string is known for "${params.model}" — it may be retired, or need an endpoint this adapter doesn't support yet`,
    );
  }
  const response = await timedFetch(
    "runway",
    `${RUNWAY_BASE_URL}/v1/${endpoint}`,
    {
      method: "POST",
      headers: runwayHeaders(apiKey, { "content-type": "application/json" }),
      body: JSON.stringify(buildSubmitBody(endpoint, runwayModelId, params)),
    },
    timeoutMs,
  );
  if (!response.ok) {
    throw classifyMediaHttpFailure("runway", response.status, await response.text());
  }
  const json = (await response.json()) as RunwaySubmitResponse;
  return { taskId: json.id };
}

export type RunwayTaskStatus = "PENDING" | "THROTTLED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface RunwayTaskState {
  id: string;
  status: RunwayTaskStatus;
  progress?: number;
  output?: string[];
  failure?: string;
  failureCode?: string;
}

/** Throws `job-not-found` on a 404 (Amendment 2 Decision 3: "the job expired
 *  or was purged server-side, not a client bug") rather than the generic
 *  submission-level classification — a 404 mid-poll means something
 *  different here than a 404 on the submit call. */
export async function pollRunwayTask(
  apiKey: string,
  taskId: string,
  timeoutMs: number = DEFAULT_MEDIA_CALL_TIMEOUT_MS,
): Promise<RunwayTaskState> {
  const response = await timedFetch(
    "runway",
    `${RUNWAY_BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}`,
    { method: "GET", headers: runwayHeaders(apiKey) },
    timeoutMs,
  );
  if (!response.ok) {
    if (response.status === 404) {
      throw new MediaExecutionError("job-not-found", "runway", `task ${taskId} was not found (HTTP 404) — it may have expired or been purged`);
    }
    throw classifyMediaHttpFailure("runway", response.status, await response.text());
  }
  return (await response.json()) as RunwayTaskState;
}

/**
 * Cancels (or deletes, per Runway's own single-endpoint framing) a task.
 * Amendment 3 item 1 confirms this endpoint exists — always attempted on
 * user cancellation, never treated as "no cancel support" the way
 * ElevenLabs dubbing is (see elevenlabs-execute.ts). Swallows any failure
 * here rather than throwing: cancellation is already in progress client-side
 * regardless of whether the provider-side cancel call itself succeeds, and
 * ADR-0012 Amendment 2 Decision 4 already requires disclosing that a job MAY
 * keep running if the cancel call doesn't land — that disclosure lives in
 * the caller (generate-video.ts), not as a thrown error here.
 */
export async function cancelRunwayTask(
  apiKey: string,
  taskId: string,
  timeoutMs: number = DEFAULT_MEDIA_CALL_TIMEOUT_MS,
): Promise<{ cancelRequestSucceeded: boolean }> {
  try {
    const response = await timedFetch(
      "runway",
      `${RUNWAY_BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: "DELETE", headers: runwayHeaders(apiKey) },
      timeoutMs,
    );
    return { cancelRequestSucceeded: response.ok };
  } catch {
    return { cancelRequestSucceeded: false };
  }
}

export interface RunwayJobProgress {
  status: RunwayTaskStatus;
  progress?: number;
  elapsedMs: number;
}

export type RunwayJobOutcome =
  | { outcome: "success"; taskId: string; resultUrls: string[] }
  | { outcome: "failed"; taskId?: string; error: MediaExecutionError };

/**
 * Full submit -> poll-until-terminal -> result orchestration (ADR-0012
 * Amendment 2 Decisions 1/3/4). Injectable `sleepFn`/`nowFn`/`isCancelled`
 * so this is testable with zero real elapsed time and no live network call
 * — same injection convention as run-task-lib.ts's `executeFn`/`fetchFn`.
 *
 * Cancellation (Decision 4): checked once per poll cycle. On cancellation,
 * this stops polling AND calls Runway's confirmed cancel endpoint (Amendment
 * 3 item 1) — but returns "failed"/"job-canceled" regardless of whether that
 * cancel call itself succeeded, since from the caller's perspective the run
 * is over either way; whether the provider-side job also stopped (and thus
 * whether billing continues) is a separate fact the caller surfaces via
 * `cancelRequestSucceeded`, not folded into the outcome type.
 */
export async function runRunwayJobToCompletion(
  apiKey: string,
  endpoint: RunwayEndpoint,
  params: RunwaySubmitParams,
  options: {
    perCallTimeoutMs?: number;
    totalJobTimeoutMs?: number;
    pollIntervalMs?: number;
    onProgress?: (update: RunwayJobProgress) => void;
    isCancelled?: () => boolean;
    onCancelled?: (result: { cancelRequestSucceeded: boolean }) => void;
    sleepFn?: (ms: number) => Promise<void>;
    nowFn?: () => number;
  } = {},
): Promise<RunwayJobOutcome> {
  const {
    perCallTimeoutMs = DEFAULT_MEDIA_CALL_TIMEOUT_MS,
    totalJobTimeoutMs = DEFAULT_MEDIA_JOB_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    onProgress,
    isCancelled = () => false,
    onCancelled,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowFn = Date.now,
  } = options;

  const startedAt = nowFn();
  let taskId: string | undefined;

  try {
    const submitted = await submitRunwayJob(apiKey, endpoint, params, perCallTimeoutMs);
    taskId = submitted.taskId;
  } catch (e) {
    const error = e instanceof MediaExecutionError ? e : new MediaExecutionError("provider-error", "runway", e instanceof Error ? e.message : String(e));
    return { outcome: "failed", error };
  }

  for (;;) {
    if (isCancelled()) {
      const cancelResult = await cancelRunwayTask(apiKey, taskId, perCallTimeoutMs);
      onCancelled?.(cancelResult);
      return {
        outcome: "failed",
        taskId,
        error: new MediaExecutionError("job-canceled", "runway", "canceled by the user"),
      };
    }

    const elapsedMs = nowFn() - startedAt;
    if (elapsedMs >= totalJobTimeoutMs) {
      return {
        outcome: "failed",
        taskId,
        error: new MediaExecutionError(
          "poll-budget-exceeded",
          "runway",
          `job did not reach a terminal state within the ${totalJobTimeoutMs}ms wait budget`,
        ),
      };
    }

    let state: RunwayTaskState;
    try {
      state = await pollRunwayTask(apiKey, taskId, perCallTimeoutMs);
    } catch (e) {
      const error = e instanceof MediaExecutionError ? e : new MediaExecutionError("provider-error", "runway", e instanceof Error ? e.message : String(e));
      return { outcome: "failed", taskId, error };
    }

    onProgress?.({ status: state.status, progress: state.progress, elapsedMs });

    if (state.status === "SUCCEEDED") {
      return { outcome: "success", taskId, resultUrls: state.output ?? [] };
    }
    if (state.status === "FAILED") {
      return {
        outcome: "failed",
        taskId,
        error: new MediaExecutionError(
          "job-failed",
          "runway",
          state.failure ?? `task ${taskId} failed${state.failureCode ? ` (${state.failureCode})` : ""}`,
        ),
      };
    }
    if (state.status === "CANCELLED") {
      return { outcome: "failed", taskId, error: new MediaExecutionError("job-canceled", "runway", "the task was canceled") };
    }

    await sleepFn(pollIntervalMs);
  }
}

/** Downloads the first result URL to bytes — Decision 5's save-to-disk step
 *  starts here; the actual disk write is vscode-coupled (generate-video.ts). */
export async function downloadRunwayResult(
  resultUrl: string,
  timeoutMs: number = DEFAULT_MEDIA_CALL_TIMEOUT_MS,
): Promise<DownloadedResult> {
  return downloadMediaResult("runway", resultUrl, {}, timeoutMs);
}
