import * as vscode from "vscode";
import { clearApiKey, ensureApiKey, promptForKey } from "./auth.js";
import { fetchLLMModels } from "./lib.js";
import { promptForSubtask } from "./task.js";
import { showRecommendation } from "./recommend.js";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("modelglass.routeTask", async () => {
      const apiKey = await ensureApiKey(context);
      if (!apiKey) return; // user declined every recovery option — nothing more to do

      const subtask = await promptForSubtask();
      if (!subtask) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Modelglass: fetching current pricing…" },
        async () => {
          try {
            const models = await fetchLLMModels(apiKey);
            await showRecommendation(subtask, models);
          } catch (e) {
            vscode.window.showErrorMessage(
              `Modelglass: couldn't fetch model data (${e instanceof Error ? e.message : String(e)}).`,
            );
          }
        },
      );
    }),

    vscode.commands.registerCommand("modelglass.setApiKey", async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: "Enter a key", action: "enter" as const },
          { label: "Clear the stored key", action: "clear" as const },
        ],
        { title: "Modelglass API Key" },
      );
      if (choice?.action === "enter") await promptForKey(context);
      else if (choice?.action === "clear") {
        await clearApiKey(context);
        vscode.window.showInformationMessage("Modelglass: API key cleared.");
      }
    }),
  );
}

export function deactivate(): void {
  // No teardown needed — no timers, listeners, or open connections held outside `context.subscriptions`.
}
