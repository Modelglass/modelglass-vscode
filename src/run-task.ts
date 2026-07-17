import * as vscode from "vscode";
import { ensureApiKey, output } from "./auth.js";
import type { LeafTaskCategory, RoutableModel } from "./routing-engine.js";
import { promptAndSetProviderKey } from "./provider-keys.js";
import { getConfiguredProvider } from "./provider-keys-lib.js";
import {
  CATEGORY_LABELS,
  LEAF_CATEGORIES,
  describeFailure,
  fetchRoutableModels,
  routeAndExecute,
} from "./run-task-lib.js";

/**
 * SCO-232 — vscode-coupled command: "Modelglass: Run Task on Cheapest
 * Capable Model". The testable orchestration core (routeAndExecute and
 * friends) lives in ./run-task-lib.ts; this file is the thin glue — QuickPick
 * prompting, progress notification, output-channel reporting — and is not
 * tested directly, same convention as switch-check.ts/recommend.ts.
 */

async function promptForCategory(): Promise<LeafTaskCategory | undefined> {
  const picked = await vscode.window.showQuickPick(
    LEAF_CATEGORIES.map((category) => ({ label: CATEGORY_LABELS[category], category })),
    { title: "Modelglass: Run Task — Task Category" },
  );
  return picked?.category;
}

export async function runTask(context: vscode.ExtensionContext): Promise<void> {
  const configured = await getConfiguredProvider(context.secrets);
  if (!configured) {
    const choice = await vscode.window.showWarningMessage(
      "Modelglass: no provider API key is configured yet — set one first.",
      "Set Provider API Key",
    );
    if (choice === "Set Provider API Key") await promptAndSetProviderKey(context);
    return;
  }

  const category = await promptForCategory();
  if (!category) return;

  const prompt = await vscode.window.showInputBox({
    title: "Modelglass: Run Task",
    prompt: "What should the model do?",
    placeHolder: "e.g. Add input validation to the signup form handler",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Task description can't be empty"),
  });
  if (!prompt) return;

  const modelglassApiKey = await ensureApiKey(context);
  if (!modelglassApiKey) return; // free Modelglass key is for reading pricing/benchmark data, distinct from the provider key above

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Modelglass: routing and running your task…" },
    async () => {
      let allModels: RoutableModel[];
      try {
        allModels = await fetchRoutableModels(modelglassApiKey);
      } catch (e) {
        vscode.window.showErrorMessage(
          `Modelglass: couldn't fetch model data (${e instanceof Error ? e.message : String(e)}).`,
        );
        return;
      }

      const result = await routeAndExecute(allModels, configured.provider, configured.apiKey, category, prompt.trim());

      switch (result.outcome) {
        case "no-provider-models":
          vscode.window.showErrorMessage(
            `Modelglass: no current-generation models found for ${result.provider} in the pricing feed.`,
          );
          return;
        case "no-ranked-models":
          vscode.window.showErrorMessage(
            `Modelglass: none of ${result.provider}'s models have scoring data for "${CATEGORY_LABELS[result.category]}".`,
          );
          return;
        case "execution-failed":
          output.appendLine(
            `[run-task] execution failed for ${result.topModel.modelId} (${result.error.kind}): ${result.error.message}`,
          );
          // ADR-0012 Starter contract: surface clearly, no auto-retry/fallback —
          // that behaviour is Pro/SCO-233's, not built here even partially.
          vscode.window.showErrorMessage(
            `Modelglass: routed to ${result.topModel.name}, but the call failed — ${describeFailure(result.error)}. ` +
              "No automatic retry was attempted (Starter runs one attempt per invocation) — fix the key or try again by re-running the command.",
          );
          return;
        case "success":
          output.appendLine(
            `[run-task] ${CATEGORY_LABELS[result.category]} -> ${result.topModel.name} (${result.execution.modelIdUsed}), ` +
              `ranked #1 of ${result.rankedCount} ${configured.provider} model(s)`,
          );
          output.appendLine(result.execution.text);
          output.show(true);
          vscode.window.showInformationMessage(`Modelglass: ran on ${result.topModel.name} — see the Modelglass output channel.`);
          return;
      }
    },
  );
}
