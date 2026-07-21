import * as vscode from "vscode";
import { ensureApiKey, output } from "./auth.js";
import type { LeafTaskCategory, RoutableModel } from "./routing-engine.js";
import { promptAndSetProviderKey } from "./provider-keys.js";
import { getConfiguredProviders } from "./provider-keys-lib.js";
import {
  CATEGORY_LABELS,
  LEAF_CATEGORIES,
  describeAttempt,
  fetchRoutableModels,
  routeAndExecuteWithFallback,
} from "./run-task-lib.js";
import { loadRoutingRules } from "./routing-rules.js";
import { checkProAccess, proGatedValue, selectProvidersForRun } from "./pro-gate-lib.js";
import { promptUpgradeToPro } from "./pro-gate.js";

/**
 * SCO-232 — vscode-coupled command: "Modelglass: Run Task on Cheapest
 * Capable Model". The testable orchestration core (routeAndExecuteWithFallback
 * and friends) lives in ./run-task-lib.ts; this file is the thin glue —
 * QuickPick prompting, progress notification, output-channel reporting —
 * and is not tested directly, same convention as switch-check.ts/recommend.ts.
 *
 * SCO-231's .modelglass/routing-rules.json override and SCO-233's multi-
 * key/fallback are both now gated behind a Pro key (SCO-234): the rules
 * file is still loaded and validated as before (so a Starter user still
 * gets useful feedback if it's malformed), but the parsed rule is only
 * actually applied when the gate is satisfied — proGatedValue falls
 * through to `undefined`, which resolveCategoryRanking already defines as
 * identical to SCO-230's default ranking. Similarly, every configured
 * provider is only used when the gate is satisfied; otherwise only the
 * first is passed to routeAndExecuteWithFallback, which behaves exactly
 * like SCO-232's original one-shot flow when given a single-entry array —
 * Starter's enforced ceiling, not just its unconfigured default. Neither
 * SCO-231's nor SCO-233's own logic is touched here — this file only
 * decides WHAT to pass into them.
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
        allModels = await fetchRoutableModels(modelglassApiKey, undefined, undefined, (message) =>
          output.appendLine(`[run-task] ${message}`),
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `Modelglass: couldn't fetch model data (${e instanceof Error ? e.message : String(e)}).`,
        );
        return;
      }

      const proStatus = await checkProAccess(modelglassApiKey, fetch);

      const rules = await loadRoutingRules();
      const loadedRule = rules.found ? rules.rulesByCategory.get(category) : undefined;
      const rule = proGatedValue(proStatus, loadedRule);
      if (loadedRule && !rule) {
        output.appendLine(
          `[run-task] .modelglass/routing-rules.json has a rule for "${CATEGORY_LABELS[category]}", but routing overrides ` +
            "are a Pro feature — ignoring it for this run (default routing applies).",
        );
        // SCO-261: this used to be Output-channel-only — invisible to anyone
        // without that channel open, for what's otherwise a monetization-
        // relevant moment (Pro upsell). Reuses the same real upgrade
        // notification provider-keys.ts already shows for the "second
        // provider key" case, so the README's "gets a clear upgrade prompt"
        // claim is now true for BOTH cases it covers, not just one.
        // Fire-and-forget (not awaited) — the task still runs immediately
        // with default routing regardless of whether/how the user responds.
        void promptUpgradeToPro(`Applying your .modelglass/routing-rules.json override for "${CATEGORY_LABELS[category]}"`);
      }

      const providersForThisRun = selectProvidersForRun(configuredProviders, proStatus);

      const result = await routeAndExecuteWithFallback(
        allModels,
        providersForThisRun,
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
          // SCO-260 quick-win #4: each hop logged as it's known, not just
          // folded into a summary after everything has already failed.
          for (const attempt of result.attempts) {
            output.appendLine(`[run-task] ${attempt.provider}: ${describeAttempt(attempt)}`);
          }
          const summary = result.attempts.map((a) => `${a.provider}: ${describeAttempt(a)}`).join("; ");
          output.appendLine(`[run-task] every configured provider failed for "${CATEGORY_LABELS[result.category]}" — ${summary}`);

          // SCO-260 quick-win #7: an actual re-entry path, not just a
          // "fix a key" instruction with nothing to click. Not scoped to
          // the specific invalid-key provider(s) — promptAndSetProviderKey
          // is a single-key-replace flow (Starter's model); which key a
          // multi-provider Pro user should re-enter isn't unambiguous when
          // more than one provider in the chain failed on invalid-key, so
          // that refinement is left for a future pass rather than guessed
          // at here.
          const hasInvalidKey = result.attempts.some(
            (a) => a.result.outcome === "execution-failed" && a.result.error.kind === "invalid-key",
          );
          const choice = await vscode.window.showErrorMessage(
            `Modelglass: tried ${result.attempts.length} configured provider(s) for "${CATEGORY_LABELS[result.category]}" — ` +
              `all failed (${summary}). No further automatic retry — try again by re-running the command.`,
            ...(hasInvalidKey ? ["Set Provider API Key"] : []),
          );
          if (choice === "Set Provider API Key") await promptAndSetProviderKey(context);
          return;
        }
        case "success": {
          // SCO-260 quick-win #4: log each hop that failed before the one
          // that succeeded, not just a bare fallback count.
          if (result.attempts.length > 1) {
            for (const attempt of result.attempts.slice(0, -1)) {
              output.appendLine(`[run-task] ${attempt.provider} failed, trying next provider — ${describeAttempt(attempt)}`);
            }
          }
          output.appendLine(
            `[run-task] ${CATEGORY_LABELS[result.category]} -> ${result.topModel.name} (${result.execution.modelIdUsed}), ` +
              `ranked #1 of ${result.rankedCount} model(s) from ${result.topModel.provider}` +
              (result.attempts.length > 1 ? ` — succeeded after ${result.attempts.length - 1} provider fallback(s)` : "") +
              (result.ruleApplied ? " — .modelglass/routing-rules.json override applied for this category" : ""),
          );
          output.appendLine(`[run-task] selected on: ${result.scoreLabel}`);

          const { inputPricePerM, outputPricePerM } = result.topModel;
          if (inputPricePerM !== null && outputPricePerM !== null) {
            output.appendLine(`[run-task] price: $${inputPricePerM}/M input, $${outputPricePerM}/M output`);
            if (result.execution.usage) {
              const { inputTokens, outputTokens } = result.execution.usage;
              const cost = (inputTokens * inputPricePerM + outputTokens * outputPricePerM) / 1_000_000;
              output.appendLine(
                `[run-task] actual cost: $${cost.toFixed(4)} (${inputTokens} in / ${outputTokens} out tokens)`,
              );
            }
          }

          if (result.unmatchedPriorityIds.length > 0) {
            output.appendLine(
              `[run-task] warning: routing-rules.json's priority list for "${CATEGORY_LABELS[result.category]}" has ` +
                `${result.unmatchedPriorityIds.length} entr${result.unmatchedPriorityIds.length === 1 ? "y" : "ies"} ` +
                `that matched no configured model: ${result.unmatchedPriorityIds.join(", ")}`,
            );
          }
          if (result.excludedCount > 0) {
            output.appendLine(
              `[run-task] ${result.excludedCount} model(s) excluded from ranking by routing-rules.json for this category`,
            );
          }

          output.appendLine(result.execution.text);
          output.show(true);
          vscode.window.showInformationMessage(`Modelglass: ran on ${result.topModel.name} — see the Modelglass output channel.`);
          return;
        }
      }
    },
  );
}
