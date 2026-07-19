import * as vscode from "vscode";
import { ensureApiKey, output } from "./auth.js";
import {
  PROVIDER_LABELS,
  SUPPORTED_PROVIDERS,
  addProviderKey,
  clearProviderKey,
  getConfiguredProvider,
  getConfiguredProviders,
  setProviderKeyValue,
  type SupportedProvider,
} from "./provider-keys-lib.js";
import { checkProAccess, wouldExceedSingleKeyLimit, isGateSatisfied } from "./pro-gate-lib.js";
import { promptUpgradeToPro } from "./pro-gate.js";
import { fetchRoutableModels } from "./run-task-lib.js";
import { previewProviderCapabilities, summarizeCapabilityPreview, formatCategoryLines } from "./capability-preview-lib.js";
import type { RoutableModel } from "./routing-engine.js";

/**
 * SCO-232/233/234 — vscode-coupled provider-key prompting UI. The pure
 * storage logic lives in ./provider-keys-lib.ts (no vscode import there, so
 * it's directly unit-testable); this file is the thin glue, not tested
 * directly — same split as switch-check-lib.ts/switch-check.ts and
 * lib.ts/task.ts.
 *
 * promptAndSetProviderKey (SCO-232, Starter) is UNCHANGED below — exclusive
 * single-key replace, with a warning before clearing a different provider's
 * key, still available to any plan (it never grows past one key). Growing
 * past one simultaneously-configured provider is the actual Pro capability
 * (SCO-233) — promptAndAddProviderKey gates ONLY that specific case
 * (SCO-234): adding your first key at all, or rotating an already-configured
 * provider's own key, is never gated.
 */

/**
 * SCO-263 — best-effort setup-time capability preview, run right after a
 * provider key is stored (Starter's "Set" and Pro's "Add" flows both call
 * this). Reuses the SAME feed fetch Run Task itself uses
 * (fetchRoutableModels, SCO-264-cached) so the preview can't show something
 * Run Task wouldn't actually see, and never blocks or fails key storage —
 * the key is already saved by the time this runs; a feed-fetch failure here
 * just means no preview this time; logged, not surfaced as an error.
 */
async function showCapabilityPreview(
  context: vscode.ExtensionContext,
  provider: SupportedProvider,
): Promise<void> {
  const modelglassApiKey = await ensureApiKey(context);
  if (!modelglassApiKey) return;

  let allModels: RoutableModel[];
  try {
    allModels = await fetchRoutableModels(modelglassApiKey);
  } catch (e) {
    output.appendLine(
      `[provider-keys] couldn't fetch the model feed to preview ${provider}'s task-category coverage ` +
        `(${e instanceof Error ? e.message : String(e)}) — skipping the preview this time.`,
    );
    return;
  }

  const preview = previewProviderCapabilities(allModels, provider);
  output.appendLine(`[provider-keys] ${provider} capability preview:`);
  for (const line of formatCategoryLines(preview)) {
    output.appendLine(`  - ${line}`);
  }

  if (preview.routable.length === 0) {
    vscode.window.showWarningMessage(
      `Modelglass: ${PROVIDER_LABELS[provider]} has no routable models for ANY task category right now ` +
        `(${summarizeCapabilityPreview(preview)}) — Run Task will never find a match with just this key ` +
        "until registry benchmark coverage improves. See the Modelglass output channel for the full breakdown.",
    );
  } else if (preview.zeroRoutable.length > 0) {
    vscode.window.showInformationMessage(
      `Modelglass: ${PROVIDER_LABELS[provider]} is ${summarizeCapabilityPreview(preview)}. ` +
        "See the Modelglass output channel for the full breakdown.",
    );
  }
}

/**
 * "Modelglass: Set Provider API Key" (SCO-232) — pick a supported provider,
 * enter its key, store it. If a different provider was already configured,
 * warns before replacing it (Starter's single-key invariant made visible to
 * the user, not just silently enforced underneath them).
 */
export async function promptAndSetProviderKey(context: vscode.ExtensionContext): Promise<void> {
  const existing = await getConfiguredProvider(context.secrets);

  const picked = await vscode.window.showQuickPick(
    SUPPORTED_PROVIDERS.map((p) => ({
      label: PROVIDER_LABELS[p],
      description: p === existing?.provider ? "(currently configured)" : undefined,
      provider: p,
    })),
    { title: "Modelglass: Set Provider API Key — Choose a provider" },
  );
  if (!picked) return;

  if (existing && existing.provider !== picked.provider) {
    const choice = await vscode.window.showWarningMessage(
      `Modelglass: Starter supports one provider key at a time. You currently have a ` +
        `${PROVIDER_LABELS[existing.provider]} key configured — setting a ${PROVIDER_LABELS[picked.provider]} ` +
        `key will remove it.`,
      "Continue",
      "Cancel",
    );
    if (choice !== "Continue") return;
  }

  const apiKey = await vscode.window.showInputBox({
    title: `Modelglass: ${PROVIDER_LABELS[picked.provider]} API Key`,
    prompt: `Paste your ${PROVIDER_LABELS[picked.provider]} API key. Stored only in this machine's ` +
      "SecretStorage (OS keychain) — never sent to Modelglass.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "API key can't be empty"),
  });
  if (!apiKey) return;

  const { replaced } = await setProviderKeyValue(context.secrets, picked.provider, apiKey);
  output.appendLine(
    `[provider-keys] stored a ${picked.provider} key` +
      (replaced ? ` (replaced the previously-configured ${replaced} key)` : ""),
  );
  vscode.window.showInformationMessage(
    `Modelglass: ${PROVIDER_LABELS[picked.provider]} key saved.` +
      (replaced ? ` Your previous ${PROVIDER_LABELS[replaced]} key was removed.` : ""),
  );

  await showCapabilityPreview(context, picked.provider);
}

/**
 * "Modelglass: Add Provider API Key" (SCO-233) — pick a provider, enter its
 * key, store it ALONGSIDE any other already-configured provider keys (no
 * clearing). Use this to build up a multi-key fallback chain; use "Set
 * Provider API Key" instead for the exclusive single-key replace.
 */
export async function promptAndAddProviderKey(context: vscode.ExtensionContext): Promise<void> {
  const configured = await getConfiguredProviders(context.secrets);
  const configuredSet = new Set(configured.map((c) => c.provider));

  const picked = await vscode.window.showQuickPick(
    SUPPORTED_PROVIDERS.map((p) => ({
      label: PROVIDER_LABELS[p],
      description: configuredSet.has(p) ? "(already configured — this replaces its key)" : undefined,
      provider: p,
    })),
    { title: "Modelglass: Add Provider API Key — Choose a provider" },
  );
  if (!picked) return;

  // SCO-234: only genuinely GROWING past one simultaneously-configured
  // provider requires Pro — a first key, or rotating an already-configured
  // provider's own key, is Starter's own baseline and is never gated here.
  if (wouldExceedSingleKeyLimit(configured.map((c) => c.provider), picked.provider)) {
    const modelglassApiKey = await ensureApiKey(context);
    const status = modelglassApiKey
      ? await checkProAccess(modelglassApiKey, fetch)
      : ({ isPro: false, reason: "no-modelglass-key" } as const);

    if (!isGateSatisfied(status)) {
      await promptUpgradeToPro("Configuring more than one provider key (multi-key fallback)");
      return;
    }
    if (!status.isPro) {
      output.appendLine(
        `[provider-keys] couldn't verify Pro status (${status.reason}) — allowing this multi-key add for now`,
      );
    }
  }

  const apiKey = await vscode.window.showInputBox({
    title: `Modelglass: ${PROVIDER_LABELS[picked.provider]} API Key`,
    prompt:
      `Paste your ${PROVIDER_LABELS[picked.provider]} API key. Stored only in this machine's SecretStorage ` +
      "(OS keychain) — never sent to Modelglass. Added alongside any other configured provider keys, not a replacement.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "API key can't be empty"),
  });
  if (!apiKey) return;

  await addProviderKey(context.secrets, picked.provider, apiKey);
  const nowConfigured = await getConfiguredProviders(context.secrets);
  output.appendLine(`[provider-keys] added a ${picked.provider} key — ${nowConfigured.length} provider key(s) configured`);
  vscode.window.showInformationMessage(
    `Modelglass: ${PROVIDER_LABELS[picked.provider]} key saved. ${nowConfigured.length} provider key(s) configured.`,
  );

  await showCapabilityPreview(context, picked.provider);
}

/**
 * Clears a configured provider key. With exactly one configured (Starter's
 * usual case), clears it directly — identical to SCO-232's original
 * behavior. With more than one configured (Pro), prompts for which one.
 */
export async function promptAndClearProviderKey(context: vscode.ExtensionContext): Promise<void> {
  const configured = await getConfiguredProviders(context.secrets);
  if (configured.length === 0) {
    vscode.window.showInformationMessage("Modelglass: no provider key is currently configured.");
    return;
  }

  let target: SupportedProvider;
  if (configured.length === 1) {
    target = configured[0]!.provider;
  } else {
    const picked = await vscode.window.showQuickPick(
      configured.map((c) => ({ label: PROVIDER_LABELS[c.provider], provider: c.provider })),
      { title: "Modelglass: Clear Provider API Key — choose which one" },
    );
    if (!picked) return;
    target = picked.provider;
  }

  await clearProviderKey(context.secrets, target);
  output.appendLine(`[provider-keys] cleared the ${target} key`);
  vscode.window.showInformationMessage(`Modelglass: ${PROVIDER_LABELS[target]} key cleared.`);
}
