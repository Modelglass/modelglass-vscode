/**
 * SCO-430 — save-to-disk step ADR-0012 Amendment 2 Decision 5 requires
 * ("the async (and sync-binary) paths need a save-to-disk step instead")
 * but deliberately did not pin a save location/naming convention — flagged
 * as an open question in that amendment, not decided in Amendment 3 either
 * (which only settled reveal-vs-open-with-default-player). This module is
 * where that still-open question gets a concrete, defensible answer:
 *
 * DECISION (made here, not upstream in an ADR — flagged in the PR
 * description for visibility): generated files are written under
 * `<workspace-root>/.modelglass/generated/`, falling back to the OS temp
 * directory when no workspace folder is open. `.modelglass/` already exists
 * as this extension's own namespace for extension-owned files (routing-
 * rules.ts's `.modelglass/routing-rules.json`) — reusing it for generated
 * output keeps every artifact this extension creates in one predictable,
 * already-gitignorable location rather than inventing a second convention.
 * Filenames are `{category}-{provider}-{timestamp}.{ext}` — collision-proof
 * (millisecond timestamp) and self-describing without opening the file.
 *
 * vscode-free (only node:fs/promises + node:path) so the filename/write
 * logic is directly unit-testable; the workspace-root resolution and
 * reveal-in-explorer call are vscode-coupled and live in
 * generate-video.ts/generate-audio.ts instead, same lib/non-lib split as
 * every other module in this repo.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Best-effort file extension from a Content-Type header, falling back to a
 *  caller-supplied default when the header is missing or unrecognized —
 *  never blocks a save over an unresolved extension. */
export function inferExtensionFromContentType(contentType: string | null, fallbackExtension: string): string {
  if (!contentType) return fallbackExtension;
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  const KNOWN: Record<string, string> = {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
  };
  return KNOWN[mime] ?? fallbackExtension;
}

/** `nowFn` injectable for deterministic tests, same convention as
 *  run-task-lib.ts's fetchRoutableModels/routeAndExecuteWithFallback. */
export function buildResultFilename(
  category: string,
  provider: string,
  extension: string,
  nowFn: () => Date = () => new Date(),
): string {
  const timestamp = nowFn().toISOString().replace(/[:.]/g, "-");
  return `${category}-${provider}-${timestamp}.${extension}`;
}

/** Joins `directory` (already resolved by the caller — see this file's
 *  header for the resolution policy) with `filename`, creating the
 *  directory first if it doesn't exist, then writes `bytes`. Returns the
 *  full path written, for the caller to reveal/report. */
export async function writeResultToDisk(directory: string, filename: string, bytes: Uint8Array): Promise<string> {
  const fullPath = join(directory, filename);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, bytes);
  return fullPath;
}
