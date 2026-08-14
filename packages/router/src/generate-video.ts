import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname } from "node:path";
import { ensureApiKey, output } from "@modelglass/vscode-shared";
import { checkProAccess, isFreeTierExcluded } from "./pro-gate-lib.js";
import { getMediaProviderKey, setMediaProviderKey } from "./media-provider-keys-lib.js";
import { fetchMediaModels, normaliseMediaOfferings, rankMediaModelsByPrice, type RoutableMediaModel } from "./media-routing-lib.js";
import {
  downloadRunwayResult,
  resolveRunwayModelId,
  runRunwayJobToCompletion,
  type RunwayEndpoint,
  type RunwaySubmitParams,
} from "./runway-execute.js";
import { describeMediaFailure } from "./media-execute-lib.js";
import { buildResultFilename, inferExtensionFromContentType, writeResultToDisk } from "./media-file-save-lib.js";

/**
 * SCO-430 — "Modelglass: Generate Video (Runway)". vscode-coupled command
 * glue, not unit-tested directly (same "no Extension Host harness"
 * convention as run-task.ts/switch-check.ts/chat-view.ts) — every function
 * it calls into (media-routing-lib.ts, runway-execute.ts, media-execute-lib.ts,
 * media-file-save-lib.ts) is independently unit-tested instead.
 *
 * QuickPick + result-document-family pattern (per this ticket's explicit
 * instruction not to build a new panel/wizard) — here the "result document"
 * is a file on disk revealed in the OS file explorer (ADR-0012 Amendment 3
 * item 3), not an editor tab, since Decision 5 already established binary
 * results can't reuse run-task.ts's openTextDocument path.
 */

const RUNWAY_PROVIDER = "runway";

/** Maps a registry offering's raw model.modality to the Runway endpoint that
 *  serves it. Registry-observed values as of this ticket's build (checked
 *  directly against packages/data-video/registry/models/*.yaml, 2026-08-13):
 *  "text-to-video", "image-to-video", "video-to-video". Any other value is
 *  treated as unsupported here (surfaced as an error, not silently
 *  defaulted to one of the three) — a future new sub-modality shouldn't
 *  silently execute against the wrong endpoint. */
function endpointForSubModality(subModality: string): RunwayEndpoint | undefined {
  switch (subModality) {
    case "text-to-video":
      return "text_to_video";
    case "image-to-video":
      return "image_to_video";
    case "video-to-video":
      return "video_to_video";
    default:
      return undefined;
  }
}

async function ensureRunwayKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const existing = await getMediaProviderKey(context.secrets, RUNWAY_PROVIDER);
  if (existing) return existing;

  const choice = await vscode.window.showWarningMessage(
    "Modelglass: no Runway API key is configured yet.",
    "Enter Runway API Key",
  );
  if (choice !== "Enter Runway API Key") return undefined;

  const apiKey = await vscode.window.showInputBox({
    title: "Modelglass: Runway API Key",
    prompt: "Paste your Runway API key. Stored only in this machine's SecretStorage (OS keychain) — never sent to Modelglass.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "API key can't be empty"),
  });
  if (!apiKey) return undefined;
  await setMediaProviderKey(context.secrets, RUNWAY_PROVIDER, apiKey);
  vscode.window.showInformationMessage("Modelglass: Runway key saved.");
  return apiKey.trim();
}

/** Reads a local file and returns it as a data URI — Runway's promptImage/
 *  videoUri fields accept a public URL OR a data URI; a data URI is the
 *  only option that needs no additional hosting step for a file that's
 *  just sitting on the user's own disk. */
async function fileToDataUri(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  const ext = extname(filePath).slice(1).toLowerCase();
  const mime =
    { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" }[ext] ??
    "application/octet-stream";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

async function promptForInputFile(kind: "image" | "video"): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: `Select input ${kind}`,
    filters: kind === "image" ? { Images: ["png", "jpg", "jpeg", "webp", "gif"] } : { Videos: ["mp4", "mov", "webm"] },
  });
  return picked?.[0]?.fsPath;
}

/** ADR-0012 Amendment 2 Decision 5 / this repo's own media-file-save-lib.ts
 *  header: `.modelglass/generated/` under the primary workspace folder,
 *  falling back to the OS temp directory with no workspace open. */
function resolveOutputDirectory(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? vscode.Uri.joinPath(vscode.Uri.file(root), ".modelglass", "generated").fsPath : tmpdir();
}

export async function generateVideo(context: vscode.ExtensionContext): Promise<void> {
  const modelglassApiKey = await ensureApiKey(context);
  if (!modelglassApiKey) return;

  // ADR-0012 Amendment 2 Decision 7 / Amendment 3 item 5: Starter+Pro, not
  // Free — checked first, same placement as chat-view.ts's SCO-381 gate.
  const proStatus = await checkProAccess(modelglassApiKey, fetch);
  if (isFreeTierExcluded(proStatus)) {
    vscode.window.showErrorMessage(
      "Modelglass: video generation is available on Starter and Pro plans. Upgrade at https://modelglass.com.au/signup to use it.",
    );
    return;
  }

  const runwayKey = await ensureRunwayKey(context);
  if (!runwayKey) return;

  let allModels: RoutableMediaModel[];
  try {
    allModels = (await fetchMediaModels(modelglassApiKey, "video")).flatMap(normaliseMediaOfferings);
  } catch (e) {
    vscode.window.showErrorMessage(`Modelglass: couldn't fetch video model data (${e instanceof Error ? e.message : String(e)}).`);
    return;
  }

  const ranked = rankMediaModelsByPrice(allModels, RUNWAY_PROVIDER);
  // SCO-430 hotfix (2026-08-13) — filter to models this adapter can actually
  // call: a known endpoint AND a known Runway API model string
  // (resolveRunwayModelId — see runway-execute.ts's header for why two of
  // this repo's registered Runway models are deliberately excluded here
  // rather than offered and left to 400).
  const supported = ranked.filter(
    (m) => endpointForSubModality(m.subModality) !== undefined && resolveRunwayModelId(m.modelId) !== undefined,
  );
  if (supported.length === 0) {
    vscode.window.showErrorMessage("Modelglass: no Runway video models are currently available in the Modelglass feed.");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    supported.map((m) => ({
      label: m.name,
      description: m.price ? `$${m.price.amount}/${m.price.unit.replace("per_", "")} · ${m.subModality}` : m.subModality,
      model: m,
    })),
    { title: "Modelglass: Generate Video — Choose a Runway model" },
  );
  if (!picked) return;

  const endpoint = endpointForSubModality(picked.model.subModality)!;

  const promptText = await vscode.window.showInputBox({
    title: "Modelglass: Generate Video",
    prompt: "Describe the video you want generated",
    placeHolder: "e.g. A drone shot flying over a misty mountain range at dawn",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Prompt can't be empty"),
  });
  if (!promptText) return;

  const submitParams: RunwaySubmitParams = { model: picked.model.modelId, promptText: promptText.trim() };
  if (endpoint === "image_to_video") {
    const imagePath = await promptForInputFile("image");
    if (!imagePath) return;
    submitParams.promptImage = await fileToDataUri(imagePath);
  } else if (endpoint === "video_to_video") {
    const videoPath = await promptForInputFile("video");
    if (!videoPath) return;
    submitParams.videoUri = await fileToDataUri(videoPath);
  }

  output.appendLine(
    `[generate-video] submitting ${endpoint} to Runway (${picked.model.name}) — ` +
      "note: canceling stops this extension from polling, but if Runway has no way to confirm the cancel, the job may keep running and billing on Runway's side.",
  );

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Modelglass: generating video via Runway (${picked.model.name})…`,
      cancellable: true,
    },
    async (progress, token) => {
      const result = await runRunwayJobToCompletion(runwayKey, endpoint, submitParams, {
        isCancelled: () => token.isCancellationRequested,
        onProgress: (update) => {
          progress.report({ message: `${update.status}${update.progress !== undefined ? ` (${Math.round(update.progress * 100)}%)` : ""}` });
          output.appendLine(`[generate-video] ${update.status} — ${Math.round(update.elapsedMs / 1000)}s elapsed`);
        },
        onCancelled: (cancelResult) => {
          output.appendLine(
            `[generate-video] cancel requested — Runway ${cancelResult.cancelRequestSucceeded ? "confirmed the cancel" : "did NOT confirm the cancel; the job may still be running and billing"}.`,
          );
        },
      });

      if (result.outcome === "failed") {
        output.appendLine(`[generate-video] failed: ${describeMediaFailure(result.error)}`);
        vscode.window.showErrorMessage(`Modelglass: video generation failed — ${describeMediaFailure(result.error)}.`);
        return;
      }

      const resultUrl = result.resultUrls[0];
      if (!resultUrl) {
        vscode.window.showErrorMessage("Modelglass: Runway reported success but returned no result URL.");
        return;
      }

      try {
        const downloaded = await downloadRunwayResult(resultUrl);
        const extension = inferExtensionFromContentType(downloaded.contentType, "mp4");
        const filename = buildResultFilename("video", RUNWAY_PROVIDER, extension);
        const fullPath = await writeResultToDisk(resolveOutputDirectory(), filename, downloaded.bytes);
        output.appendLine(`[generate-video] saved to ${fullPath}`);
        vscode.window.showInformationMessage(`Modelglass: video saved to ${fullPath}.`, "Reveal in Explorer").then((choice) => {
          if (choice === "Reveal in Explorer" || choice === undefined) {
            // ADR-0012 Amendment 3 item 3: reveal-in-explorer is the DEFAULT
            // action, not opt-in — fires regardless of whether the user
            // clicked the button or dismissed the toast, matching "default
            // to reveal, don't wait for an explicit click."
            vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(fullPath));
          }
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        output.appendLine(`[generate-video] couldn't download/save the result: ${message}`);
        vscode.window.showErrorMessage(`Modelglass: generated the video but couldn't save it (${message}).`);
      }
    },
  );
}
