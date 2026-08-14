/**
 * SCO-430 — shared execution primitives for the video/audio generation
 * providers (Runway, ElevenLabs), grounded in ADR-0012 Amendments 2 and 3.
 * vscode-free (no `vscode` import anywhere in this file), directly
 * unit-testable via monkey-patched global `fetch` — same convention
 * provider-execute.ts already established.
 *
 * A deliberately independent error/classification type from
 * provider-execute.ts's `ProviderExecutionError`/`FailureKind`, not a reuse
 * or an extension of them — same "deliberately independent module" call
 * this codebase already makes elsewhere for similar-but-not-identical
 * shapes (see switch-check-lib.ts's and routing-engine.ts's own file
 * headers). The two failure vocabularies genuinely diverge: this one adds
 * five async-only classes (Amendment 2 Decision 3) that have no equivalent
 * on the sync chat-completion path, and reusing FailureKind would mean
 * either widening it for every existing coding-router caller or building an
 * awkward subtype relationship for no real benefit — the sync submission
 * classes (invalid-key/rate-limited/network-error/provider-error/
 * model-not-found) are duplicated here structurally, not imported.
 */

export type MediaFailureKind =
  // Submission-level — Decision 4's original table (ADR-0012), unchanged,
  // reapplied here to the submit call. Amendment 2 Decision 1: "this path
  // introduces no new failure surface" for sync-binary providers either.
  | "invalid-key"
  | "rate-limited"
  | "network-error"
  | "provider-error"
  | "model-not-found"
  // Async-only — Amendment 2 Decision 3, surfaced via a 200 OK poll
  // response rather than an HTTP error, which Decision 4's original table
  // has no vocabulary for.
  | "job-failed"
  | "job-canceled"
  | "job-not-found"
  | "result-expired"
  | "poll-budget-exceeded";

export class MediaExecutionError extends Error {
  readonly kind: MediaFailureKind;
  readonly provider: string;

  constructor(kind: MediaFailureKind, provider: string, message: string) {
    super(message);
    this.name = "MediaExecutionError";
    this.kind = kind;
    this.provider = provider;
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/**
 * SCO-430 — same per-call timeout provider-execute.ts already uses
 * (DEFAULT_PROVIDER_TIMEOUT_MS = 60_000), duplicated here rather than
 * imported: ADR-0012 Amendment 2 Decision 4 is explicit that this constant
 * "is unchanged — it still applies to each individual HTTP call (the submit
 * call, and each individual poll call)" — it is NOT the total job budget
 * (see DEFAULT_MEDIA_JOB_TIMEOUT_MS below for that). Duplicated (not
 * imported from provider-execute.ts) to keep this module's only coupling to
 * the rest of the codebase at the type level, matching this file's header.
 */
export const DEFAULT_MEDIA_CALL_TIMEOUT_MS = 60_000;

/**
 * SCO-430 — ADR-0012 Amendment 3 item 4: "10-15 minutes total wait budget
 * as a starting constant... ship a single constant within this range." 12
 * minutes: roughly the midpoint, generous relative to Runway jobs' typical
 * minutes-not-hours duration while still short enough that a genuinely
 * stuck job surfaces a failure rather than hanging indefinitely. Tune from
 * real usage once live, per Amendment 3's own framing — not required to be
 * exact on day one.
 */
export const DEFAULT_MEDIA_JOB_TIMEOUT_MS = 12 * 60 * 1000;

/**
 * SCO-430 — poll interval. Not decided by either amendment (out of scope
 * for an ADR-level decision) — 5 seconds matches Runway's own documented
 * guidance ("don't expect updates more frequent than once every five
 * seconds for a given task"); used for ElevenLabs dubbing too in the
 * absence of any documented alternative, since no evidence suggests a
 * different cadence is needed there.
 */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

const MODEL_NOT_FOUND_BODY_PATTERN =
  /model[^.]*(not[ _-]?found|does not exist|is not a valid model|invalid model)/i;

/**
 * Classifies a submission-call HTTP failure. Structurally identical to
 * provider-execute.ts's classifyHttpFailure (same status-code table, same
 * ADR-0012 table) but returns this file's own MediaExecutionError — see
 * this file's header for why that's a duplication, not a missed reuse.
 */
/**
 * SCO-430 hotfix (2026-08-13) — was 300 chars, which cut a real Runway
 * validation error off mid-JSON (its structured `issues[].values` array of
 * accepted model strings is exactly the diagnostic detail a user needs to
 * see, and it's longer than a typical LLM provider's plain-text error).
 * 800 is a deliberate widen, not an arbitrary bump — generous enough for a
 * multi-field Zod-style validation body while still bounded (this goes into
 * a notification/Output-channel line, not an unbounded dump).
 */
const ERROR_BODY_PREVIEW_CHARS = 800;

export function classifyMediaHttpFailure(
  provider: string,
  status: number,
  bodyText: string,
): MediaExecutionError {
  if (status === 401 || status === 403) {
    return new MediaExecutionError("invalid-key", provider, `${provider} rejected the API key (HTTP ${status}).`);
  }
  if (status === 429) {
    return new MediaExecutionError("rate-limited", provider, `${provider} is rate-limiting this key (HTTP 429).`);
  }
  if (status === 404 || MODEL_NOT_FOUND_BODY_PATTERN.test(bodyText)) {
    return new MediaExecutionError(
      "model-not-found",
      provider,
      `${provider} doesn't recognize this model string (HTTP ${status}): ${bodyText.slice(0, ERROR_BODY_PREVIEW_CHARS)}`,
    );
  }
  return new MediaExecutionError(
    "provider-error",
    provider,
    `${provider} returned HTTP ${status}: ${bodyText.slice(0, ERROR_BODY_PREVIEW_CHARS)}`,
  );
}

/**
 * `fetch` wrapped with a per-call AbortController timeout and the shared
 * network-error/timeout classification — every submit/poll/cancel/download
 * call in runway-execute.ts and elevenlabs-execute.ts goes through this, so
 * that classification logic exists exactly once.
 */
export async function timedFetch(
  provider: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (isAbortError(e)) {
      throw new MediaExecutionError(
        "network-error",
        provider,
        `timed out waiting for a response after ${timeoutMs}ms`,
      );
    }
    throw new MediaExecutionError("network-error", provider, e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

export interface DownloadedResult {
  bytes: Uint8Array;
  contentType: string | null;
}

/**
 * Downloads a binary result (a Runway signed output URL, or an ElevenLabs
 * TTS/dubbing-result response body). Shared by both provider adapters and
 * by generate-video.ts/generate-audio.ts's save-to-disk step (ADR-0012
 * Amendment 2 Decision 5) rather than duplicated per provider.
 *
 * This is deliberately where "result expired" (Amendment 2 Decision 3 — "the
 * returned output URL itself 4xx's when fetched") is actually detected: a
 * Runway task reaching SUCCEEDED just means the output array is populated,
 * not that the signed URL is still live by the time this function runs a
 * moment later — verifying it with a separate HEAD round trip first would
 * just be a second network call for the same answer this GET already gives.
 */
export async function downloadMediaResult(
  provider: string,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_MEDIA_CALL_TIMEOUT_MS,
): Promise<DownloadedResult> {
  const response = await timedFetch(provider, url, init, timeoutMs);
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      throw new MediaExecutionError(
        "result-expired",
        provider,
        `the result URL returned HTTP ${response.status} — it may have expired`,
      );
    }
    throw new MediaExecutionError("provider-error", provider, `${provider} returned HTTP ${response.status} fetching the result`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return { bytes: new Uint8Array(arrayBuffer), contentType: response.headers.get("content-type") };
}

/** Human-readable description of a classified failure — same purpose as
 *  run-task-lib.ts's describeFailure, extended with the five async-only
 *  classes. Shared by generate-video.ts and generate-audio.ts so the two
 *  commands' error copy doesn't drift independently. */
export function describeMediaFailure(error: MediaExecutionError): string {
  switch (error.kind) {
    case "invalid-key":
      return `your stored ${error.provider} key was rejected (invalid or revoked)`;
    case "rate-limited":
      return `${error.provider} is rate-limiting this key right now`;
    case "network-error":
      return `couldn't reach ${error.provider} (${error.message})`;
    case "provider-error":
      return `${error.provider} returned an error (${error.message})`;
    case "model-not-found":
      return `${error.provider} doesn't recognize this model string`;
    case "job-failed":
      return `the job failed (${error.message})`;
    case "job-canceled":
      return error.message;
    case "job-not-found":
      return `the job could not be found mid-poll (${error.message})`;
    case "result-expired":
      return `the result is no longer available (${error.message})`;
    case "poll-budget-exceeded":
      return "the job didn't finish within the wait budget — it may still complete on the provider's side, but this command has stopped waiting";
  }
}
