import * as vscode from "vscode";
import { ensureApiKey, output } from "./auth.js";
import type { LeafTaskCategory, RoutableModel } from "./routing-engine.js";
import { promptAndSetProviderKey } from "./provider-keys.js";
import { getConfiguredProviders } from "./provider-keys-lib.js";
import {
  CATEGORY_LABELS,
  LEAF_CATEGORIES,
  describeFailure,
  fetchRoutableModels,
  routeAndExecuteWithFallback,
} from "./run-task-lib.js";
import { loadRoutingRules } from "./routing-rules.js";

/**
 * SCO-232 — vscode-coupled command: "Modelglass: Run Task on Cheapest
 * Capable Model". The testable orchestration core (routeAndExecuteWithFallback
 * and friends) lives in ./run-task-lib.ts; this file is the thin glue —
 * QuickPick prompting, progress notification, output-channel reporting —
 * and is not tested directly, same convention as switch-check.ts/recommend.ts.
 *
 * SCO-231 (Pro scope) adds an optional .modelglass/routing-rules.json
 * override, loaded here and passed through. No tier gating is applied — this
 * runs for any plan today. Gating Pro-only features behind an actual plan
 * check is SCO-234's separate scope; guessing at how to check Pro status
 * here would risk conflicting with however that card ends up wiring it, so
 * it's deliberately left undone.
 *
 * SCO-233 (Pro scope) always routes through routeAndExecuteWithFallback now,
 * regardless of how many provider keys are configured — with exactly one
 * key configured (Starter's usual case) the fallback chain has exactly one
 * entry, so behavior is unchanged from before: one attempt, immediately
 * surfaced failure, no retry. run-task-lib.ts's own routeAndExecute (the
 * single-provider function SCO-232/231's tests exercise) is untouched and
 * still the thing routeAndExecuteWithFallback calls under the hood.
 */

async function promptForCategory(): Promise<LeafTaskCategory | undefined> {
  const picked = await vscode.window.showQuickPick(
    LEAF_CATEGORIES.map((category) => ({ label: CATEGORY_LABELS[category], category })),
    { title: "Modelglass: Run Task — Task Category" },
  );
  return picked?.category;
}

export async function runTask(context: vscode.ExtensionContext): Promise<void> {
  const configuredProviders = await getConfiguredProviders(context.secrets);
  if (configuredProviders.length === 0) {
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
  if (!modelglassApiKey) return; // free Modelglass key is for reading pricing/benchmark data, distinct from the provider key(s) above

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

      const rules = await loadRoutingRules();
      const rule = rules.found ? rules.rulesByCategory.get(category) : undefined;

      const result = await routeAndExecuteWithFallback(
        allModels,
        configuredProviders,
        category,
        prompt.trim(),
        undefined,
        rule,
      );

      switch (result.outcome) {
        case "no-configured-providers":
          // Unreachable in practice — the zero-key check above already
          // returned early — but handled rather than assumed impossible.
          vscode.window.showErrorMessage("Modelglass: no provider API key is configured.");
          return;
        case "no-ranked-models":
          vscode.window.showErrorMessage(
            `Modelglass: none of your configured providers' models have scoring data for "${CATEGORY_LABELS[result.category]}".`,
          );
          return;
        case "all-providers-failed": {
          const summary = result.attempts
            .map((a) => `${a.provider}: ${a.result.outcome === "execution-failed" ? describeFailure(a.result.error) : a.result.outcome}`)
            .join("; ");
          output.appendLine(`[run-task] every configured provider failed for "${CATEGORY_LABELS[result.category]}" — ${summary}`);
          vscode.window.showErrorMessage(
            `Modelglass: tried ${result.attempts.length} configured provider(s) for "${CATEGORY_LABELS[result.category]}" — ` +
              `all failed (${summary}). No further automatic retry — fix a key or try again by re-running the command.`,
          );
          return;
        }
        case "success":
          output.appendLine(
            `[run-task] ${CATEGORY_LABELS[result.category]} -> ${result.topModel.name} (${result.execution.modelIdUsed}), ` +
              `ranked #1 of ${result.rankedCount} model(s) from ${result.topModel.provider}` +
              (result.attempts.length > 1 ? ` — succeeded after ${result.attempts.length - 1} provider fallback(s)` : "") +
              (result.ruleApplied ? " — .modelglass/routing-rules.json override applied for this category" : ""),
          );
          output.appendLine(result.execution.text);
          output.show(true);
          vscode.window.showInformationMessage(`Modelglass: ran on ${result.topModel.name} — see the Modelglass output channel.`);
          return;
      }
    },
  );
}
