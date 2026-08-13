import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import { ensureApiKey, output } from "./auth.js";
import { checkProAccess, isFreeTierExcluded } from "./pro-gate-lib.js";
import { getMediaProviderKey, setMediaProviderKey } from "./media-provider-keys-lib.js";
import { fetchMediaModels, normaliseMediaOfferings, rankMediaModelsByPrice, type RoutableMediaModel } from "./media-routing-lib.js";
import {
  executeElevenLabsIvc,
  executeElevenLabsTts,
  resolveElevenLabsModelId,
  runElevenLabsDubbingToCompletion,
} from "./elevenlabs-execute.js";
import { MediaExecutionError, describeMediaFailure } from "./media-execute-lib.js";
import { buildResultFilename, inferExtensionFromContentType, writeResultToDisk } from "./media-file-save-lib.js";

/**
 * SCO-430 — "Modelglass: Generate Audio (ElevenLabs)". vscode-coupled
 * command glue, not unit-tested directly, same convention as
 * generate-video.ts.
 *
 * A single command fanning out to THREE sub-actions via an inner QuickPick
 * (still QuickPick-family UI, not a new panel/wizard) — Text to Speech
 * (sync), Dub Audio/Video (async), Clone a Voice / IVC (sync) — because
 * ADR-0012 Amendment 3 item 2 confirms these are genuinely different
 * ElevenLabs endpoints with different input shapes (text vs. an uploaded
 * media file vs. uploaded voice samples), not three "models" a single
 * ranked picker could pick between. This keeps the total new-command count
 * at exactly two (generate-video.ts is the other), per this ticket's "two
 * new commands" instruction — a dedicated command per sub-action would have
 * made four commands total instead.
 */

const ELEVENLABS_PROVIDER = "elevenlabs";

async function ensureElevenLabsKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const existing = await getMediaProviderKey(context.secrets, ELEVENLABS_PROVIDER);
  if (existing) return existing;

  const choice = await vscode.window.showWarningMessage(
    "Modelglass: no ElevenLabs API key is configured yet.",
    "Enter ElevenLabs API Key",
  );
  if (choice !== "Enter ElevenLabs API Key") return undefined;

  const apiKey = await vscode.window.showInputBox({
    title: "Modelglass: ElevenLabs API Key",
    prompt: "Paste your ElevenLabs API key. Stored only in this machine's SecretStorage (OS keychain) — never sent to Modelglass.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "API key can't be empty"),
  });
  if (!apiKey) return undefined;
  await setMediaProviderKey(context.secrets, ELEVENLABS_PROVIDER, apiKey);
  vscode.window.showInformationMessage("Modelglass: ElevenLabs key saved.");
  return apiKey.trim();
}

function resolveOutputDirectory(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? vscode.Uri.joinPath(vscode.Uri.file(root), ".modelglass", "generated").fsPath : tmpdir();
}

async function saveAndReveal(category: string, bytes: Uint8Array, contentType: string | null, fallbackExt: string): Promise<void> {
  const extension = inferExtensionFromContentType(contentType, fallbackExt);
  const filename = buildResultFilename(category, ELEVENLABS_PROVIDER, extension);
  const fullPath = await writeResultToDisk(resolveOutputDirectory(), filename, bytes);
  output.appendLine(`[generate-audio] saved to ${fullPath}`);
  const choice = await vscode.window.showInformationMessage(`Modelglass: audio saved to ${fullPath}.`, "Reveal in Explorer");
  if (choice === "Reveal in Explorer" || choice === undefined) {
    // ADR-0012 Amendment 3 item 3: reveal-in-explorer is the default action.
    vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(fullPath));
  }
}

async function runTextToSpeech(context: vscode.ExtensionContext, apiKey: string, modelglassApiKey: string): Promise<void> {
  let allModels: RoutableMediaModel[];
  try {
    allModels = (await fetchMediaModels(modelglassApiKey, "audio")).flatMap(normaliseMediaOfferings);
  } catch (e) {
    vscode.window.showErrorMessage(`Modelglass: couldn't fetch audio model data (${e instanceof Error ? e.message : String(e)}).`);
    return;
  }

  const ranked = rankMediaModelsByPrice(allModels, ELEVENLABS_PROVIDER, "tts");
  if (ranked.length === 0) {
    vscode.window.showErrorMessage("Modelglass: no ElevenLabs TTS models are currently available in the Modelglass feed.");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    ranked.map((m) => ({
      label: m.name,
      description: m.price ? `$${m.price.amount}/${m.price.unit.replace("per_", "")}` : undefined,
      model: m,
    })),
    { title: "Modelglass: Text to Speech — Choose a model" },
  );
  if (!picked) return;

  const text = await vscode.window.showInputBox({
    title: "Modelglass: Text to Speech",
    prompt: "Text to convert to speech",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Text can't be empty"),
  });
  if (!text) return;

  // ElevenLabs voices are per-account library items, not Modelglass registry
  // entries — there's no feed data to rank/pick from, so this is a direct
  // ID entry (same "keep v1 simple" scoping as generate-video.ts's omitted
  // ratio/duration prompts), pointed at ElevenLabs' own voice library.
  const voiceId = await vscode.window.showInputBox({
    title: "Modelglass: Text to Speech",
    prompt: "ElevenLabs Voice ID (find yours at elevenlabs.io/app/voice-library)",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Voice ID can't be empty"),
  });
  if (!voiceId) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Modelglass: generating speech via ElevenLabs…" },
    async () => {
      try {
        const result = await executeElevenLabsTts(apiKey, {
          voiceId: voiceId.trim(),
          text: text.trim(),
          modelId: resolveElevenLabsModelId(picked.model.modelId),
        });
        await saveAndReveal("tts", result.bytes, result.contentType, "mp3");
      } catch (e) {
        const error = e instanceof MediaExecutionError ? e : new MediaExecutionError("provider-error", "elevenlabs", e instanceof Error ? e.message : String(e));
        output.appendLine(`[generate-audio] TTS failed: ${describeMediaFailure(error)}`);
        vscode.window.showErrorMessage(`Modelglass: text-to-speech failed — ${describeMediaFailure(error)}.`);
      }
    },
  );
}

async function runDubbing(apiKey: string): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Select audio or video to dub",
    filters: { "Audio/Video": ["mp3", "wav", "mp4", "mov", "webm", "m4a"] },
  });
  const filePath = picked?.[0]?.fsPath;
  if (!filePath) return;

  const targetLang = await vscode.window.showInputBox({
    title: "Modelglass: Dub Audio/Video",
    prompt: "Target language code (ISO 639-1/639-3, e.g. es, fr, de)",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Target language can't be empty"),
  });
  if (!targetLang) return;

  const fileBytes = await readFile(filePath);

  output.appendLine(
    "[generate-audio] submitting dubbing job to ElevenLabs — note: ElevenLabs has no confirmed dubbing-cancel endpoint " +
      "(ADR-0012 Amendment 3), so canceling only stops this extension from polling; the job will keep running and " +
      "billing on ElevenLabs' side regardless.",
  );

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Modelglass: dubbing via ElevenLabs (canceling won't stop billing — no cancel endpoint exists)…",
      cancellable: true,
    },
    async (progress, token) => {
      const result = await runElevenLabsDubbingToCompletion(
        apiKey,
        { file: { bytes: fileBytes, filename: basename(filePath) }, targetLang: targetLang.trim() },
        targetLang.trim(),
        {
          isCancelled: () => token.isCancellationRequested,
          onProgress: (update) => {
            progress.report({ message: update.status });
            output.appendLine(`[generate-audio] dubbing: ${update.status} — ${Math.round(update.elapsedMs / 1000)}s elapsed`);
          },
        },
      );

      if (result.outcome === "failed") {
        output.appendLine(`[generate-audio] dubbing failed: ${describeMediaFailure(result.error)}`);
        vscode.window.showErrorMessage(`Modelglass: dubbing failed — ${describeMediaFailure(result.error)}.`);
        return;
      }

      await saveAndReveal("dubbing", result.result.bytes, result.result.contentType, "mp4");
    },
  );
}

async function runVoiceCloning(apiKey: string): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "Modelglass: Clone a Voice",
    prompt: "Name for the cloned voice",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Name can't be empty"),
  });
  if (!name) return;

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: "Select voice sample(s)",
    filters: { Audio: ["mp3", "wav", "m4a"] },
  });
  if (!picked || picked.length === 0) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Modelglass: cloning voice via ElevenLabs…" },
    async () => {
      try {
        const files = await Promise.all(
          picked.map(async (uri) => ({ bytes: await readFile(uri.fsPath), filename: basename(uri.fsPath) })),
        );
        const result = await executeElevenLabsIvc(apiKey, { name: name.trim(), files });
        // Unlike TTS/dubbing, IVC's result is account metadata (a new voice
        // ID registered against the caller's ElevenLabs account), not a
        // binary file — there is nothing to save-to-disk/reveal here.
        // ADR-0012 Amendment 2 Decision 5's save-to-disk requirement is
        // scoped to binary generation results; a voice registration is a
        // different result shape this ticket's design docs don't address,
        // handled as a plain information message instead.
        output.appendLine(`[generate-audio] cloned voice "${name}" -> voice_id ${result.voiceId} (requiresVerification: ${result.requiresVerification})`);
        vscode.window.showInformationMessage(
          `Modelglass: voice cloned — ID ${result.voiceId}.` +
            (result.requiresVerification ? " ElevenLabs requires verification before this voice is usable." : ""),
        );
      } catch (e) {
        const error = e instanceof MediaExecutionError ? e : new MediaExecutionError("provider-error", "elevenlabs", e instanceof Error ? e.message : String(e));
        output.appendLine(`[generate-audio] voice cloning failed: ${describeMediaFailure(error)}`);
        vscode.window.showErrorMessage(`Modelglass: voice cloning failed — ${describeMediaFailure(error)}.`);
      }
    },
  );
}

export async function generateAudio(context: vscode.ExtensionContext): Promise<void> {
  const modelglassApiKey = await ensureApiKey(context);
  if (!modelglassApiKey) return;

  const proStatus = await checkProAccess(modelglassApiKey, fetch);
  if (isFreeTierExcluded(proStatus)) {
    vscode.window.showErrorMessage(
      "Modelglass: audio generation is available on Starter and Pro plans. Upgrade at https://modelglass.com.au/signup to use it.",
    );
    return;
  }

  const elevenLabsKey = await ensureElevenLabsKey(context);
  if (!elevenLabsKey) return;

  const action = await vscode.window.showQuickPick(
    [
      { label: "Text to Speech", description: "Synchronous — convert text to spoken audio", action: "tts" as const },
      { label: "Dub Audio/Video", description: "Async — translate speech in a media file to another language", action: "dubbing" as const },
      { label: "Clone a Voice", description: "Synchronous — create a voice from audio samples (Instant Voice Cloning)", action: "ivc" as const },
    ],
    { title: "Modelglass: Generate Audio — Choose an action" },
  );
  if (!action) return;

  switch (action.action) {
    case "tts":
      return runTextToSpeech(context, elevenLabsKey, modelglassApiKey);
    case "dubbing":
      return runDubbing(elevenLabsKey);
    case "ivc":
      return runVoiceCloning(elevenLabsKey);
  }
}
