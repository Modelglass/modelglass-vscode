import * as vscode from "vscode";
import {
  codingQualityBar,
  estimateCost,
  fmtCost,
  fmtPrice,
  selectCodingModel,
  selectWritingModel,
  type NormalisedModel,
  type Subtask,
  type Task,
} from "./lib.js";

/**
 * Same routing rule as the upstream CLI's printRoutingTable (route.ts):
 * "coding"-tagged subtasks get the coding pool, everything else ("writing"
 * and "general" alike) gets the writing/instruction-following pool — the CLI
 * never had a separate general-purpose selector, so this doesn't invent one
 * either.
 */
function pickModel(subtask: Subtask, models: NormalisedModel[]): NormalisedModel | null {
  if (subtask.tag === "coding") {
    const task: Task = { description: subtask.description, subtasks: [subtask] };
    return selectCodingModel(models, codingQualityBar(task)).selected;
  }
  return selectWritingModel(models);
}

function describeModel(m: NormalisedModel): string {
  const price = `${fmtPrice(m.inputPricePerM)}/1M in · ${fmtPrice(m.outputPricePerM)}/1M out`;
  const quality =
    m.sweBenchVerified !== null ? `SWE-bench Verified ${m.sweBenchVerified}%` : m.instrRating ?? "";
  return [m.provider, quality, price].filter(Boolean).join("  ·  ");
}

/**
 * Shows the recommendation for one subtask as a QuickPick: the top pick plus
 * up to two runner-ups (coding only — selectWritingModel returns a single
 * model, there's no ranked list for that pool). Selecting an alternative is
 * informational only in this MVP (no re-routing state to update yet).
 */
export async function showRecommendation(
  subtask: Subtask,
  models: NormalisedModel[],
): Promise<void> {
  const selected = pickModel(subtask, models);
  if (!selected) {
    vscode.window.showWarningMessage(
      `Modelglass: no qualifying model found for "${subtask.description}".`,
    );
    return;
  }

  const inTok = subtask.estimatedInputTokens ?? 0;
  const outTok = subtask.estimatedOutputTokens ?? 0;
  const cost = inTok || outTok ? estimateCost(selected, inTok, outTok) : null;

  const items: (vscode.QuickPickItem & { model: NormalisedModel })[] = [
    {
      label: `$(check) ${selected.name}`,
      description: cost !== null ? `est. ${fmtCost(cost)}` : undefined,
      detail: describeModel(selected),
      model: selected,
    },
  ];

  if (subtask.tag === "coding") {
    const alternatives = selectCodingModel(models, null)
      .qualifying.filter((m) => m.slug !== selected.slug)
      .slice(0, 2);
    for (const alt of alternatives) {
      items.push({
        label: alt.name,
        detail: describeModel(alt),
        model: alt,
      });
    }
  }

  await vscode.window.showQuickPick(items, {
    title: `Modelglass: ${subtask.description}`,
    placeHolder: `Recommended: ${selected.name}`,
  });
}
