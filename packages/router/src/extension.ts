import * as vscode from "vscode";
import { clearApiKey, ensureApiKey, promptForKey } from "@modelglass/vscode-shared";
import { fetchLLMModels } from "./lib.js";
import { promptForSubtask } from "./task.js";
import { showRecommendation } from "./recommend.js";
import { switchCheck } from "./switch-check.js";
import { promptAndSetProviderKey, promptAndAddProviderKey, promptAndClearProviderKey } from "./provider-keys.js";
import { runTask } from "./run-task.js";
import { registerModelglassChatProvider } from "./lm-provider.js";
import { registerModelglassChatView } from "./chat-view.js";
import { generateVideo } from "./generate-video.js";
import { generateAudio } from "./generate-audio.js";

export function activate(context: vscode.ExtensionContext): void {
  // SCO-331 -- registers separately from the command subscriptions below
  // (it manages its own subscription internally, feature-detected and
  // try/catch-guarded so an older VS Code or a registration failure never
  // blocks the commands that follow).
  registerModelglassChatProvider(context);

  // SCO-377 -- same reasoning: the standalone chat sidebar view manages its
  // own subscription and must never block the commands that follow it.
  registerModelglassChatView(context);

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

    vscode.commands.registerCommand("modelglass.compareModels", () => switchCheck(context)),

    vscode.commands.registerCommand("modelglass.setProviderKey", async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: "Set a provider key", action: "enter" as const },
          { label: "Clear the stored provider key", action: "clear" as const },
        ],
        { title: "Modelglass Provider API Key" },
      );
      if (choice?.action === "enter") await promptAndSetProviderKey(context);
      else if (choice?.action === "clear") await promptAndClearProviderKey(context);
    }),

    vscode.commands.registerCommand("modelglass.runTask", () => runTask(context)),

    vscode.commands.registerCommand("modelglass.addProviderKey", () => promptAndAddProviderKey(context)),

    // SCO-430 — video/audio generation (ADR-0012 Amendments 2/3).
    vscode.commands.registerCommand("modelglass.generateVideo", () => generateVideo(context)),
    vscode.commands.registerCommand("modelglass.generateAudio", () => generateAudio(context)),
  );
}

export function deactivate(): void {
  // No teardown needed — no timers, listeners, or open connections held outside `context.subscriptions`.
}
