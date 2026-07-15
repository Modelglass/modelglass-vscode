import * as vscode from "vscode";
import { ensureApiKey, output } from "./auth.js";
import {
  type ModelEntry,
  type KeyRecord,
  type CapabilityChange,
  fetchAllModels,
  fetchCompetitors,
  fetchTier,
  comparePrices,
  collectCurrentPrices,
  analyzeModelHistory,
  historyWindowLabel,
  capabilityDiff,
  unitWarnings,
  lifecycleCheck,
  fmtPrice,
  fmtPct,
  hr,
} from "./switch-check-lib.js";

/**
 * "Modelglass: Compare Two Models" (SCO-216) — brings switch-check's
 * grounded model-migration diff into the extension as a second command.
 * Collapses the upstream CLI's two invocation modes (`--from --to` and
 * `--from` alone, the latter pulling candidates from
 * GET /v1/models/:modelId/competitors) into one QuickPick flow: pick a
 * "from" model, then either pick a specific "to" model or the pinned
 * "Suggested competitors" entry.
 */

const MODALITY_LABELS: Record<string, string> = {
  "text-to-image": "Image",
  "text-generation": "LLM",
  "text-to-video": "Video",
  "image-to-video": "Video",
  tts: "TTS",
  stt: "STT",
  music: "Music",
};

function modalityLabel(model: ModelEntry): string {
  const raw = model.offerings[0]?.model.modality;
  return (raw && MODALITY_LABELS[raw]) ?? raw ?? "unknown";
}

function priceSummary(model: ModelEntry): string {
  const prices = collectCurrentPrices(model);
  if (!prices.length) return "no current price";
  const cheapest = [...prices].sort((a, b) => a.amount - b.amount)[0]!;
  return `${fmtPrice(cheapest.amount, cheapest.unit)} (${cheapest.provider})`;
}

function describeModel(model: ModelEntry): string {
  return [modalityLabel(model), model.offerings.map((o) => o.provider).join(", "), priceSummary(model)]
    .filter(Boolean)
    .join("  ·  ");
}

interface ModelQuickPickItem extends vscode.QuickPickItem {
  model: ModelEntry;
}

async function pickFromModel(models: ModelEntry[]): Promise<ModelEntry | undefined> {
  const items: ModelQuickPickItem[] = models.map((m) => ({
    label: m.name,
    description: m.model_id,
    detail: describeModel(m),
    model: m,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "Modelglass: Compare Two Models — From",
    placeHolder: "The model you're on today — type to search (name, id, provider)",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.model;
}

const SUGGESTED_COMPETITORS = Symbol("suggested-competitors");

async function pickToModel(
  models: ModelEntry[],
  fromModel: ModelEntry,
): Promise<ModelEntry | typeof SUGGESTED_COMPETITORS | undefined> {
  const suggestedItem: vscode.QuickPickItem & { choice: typeof SUGGESTED_COMPETITORS } = {
    label: "$(sparkle) Suggested competitors",
    description: `from the feed's competitor list for ${fromModel.name}`,
    alwaysShow: true,
    choice: SUGGESTED_COMPETITORS,
  };
  const modelItems: (vscode.QuickPickItem & { choice: ModelEntry })[] = models
    .filter((m) => m.model_id !== fromModel.model_id)
    .map((m) => ({
      label: m.name,
      description: m.model_id,
      detail: describeModel(m),
      choice: m,
    }));

  const picked = await vscode.window.showQuickPick([suggestedItem, ...modelItems], {
    title: "Modelglass: Compare Two Models — To",
    placeHolder: `Comparing against ${fromModel.name} — pick a model, or use the feed's own suggestions`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.choice;
}

// ---------------------------------------------------------------------------
// Report rendering — ported from switch-check's check.ts as directly as
// possible (console.log -> output.appendLine), preserving the CLI's actual
// field-citing report text rather than reformatting it.
// ---------------------------------------------------------------------------

function twelveMonthsAgo(today: Date): string {
  const d = new Date(today);
  d.setMonth(d.getMonth() - 12);
  return d.toISOString().slice(0, 10);
}

/** The in-context window framing for the stability section. On Free/App this
 *  names, for THIS run's two models, exactly what Starter and Pro would add.
 *  It never claims hidden entries exist — a gated key cannot know that —
 *  only what a wider window would show if the history holds any. */
function windowFraming(tier: KeyRecord["tier"], fromModel: ModelEntry, toModel: ModelEntry): string[] {
  const today = new Date();
  const names = `${fromModel.name} and ${toModel.name}`;
  if (tier === "free" || tier === "app") {
    const windowDesc = tier === "free" ? "≈2-day Free window" : "90-day App window";
    return [
      `  This key's ${windowDesc} shows each price's current entry only (unless it changed`,
      `  within the window). The current entry keeps its real effective_from — so the price AGES`,
      `  above are honest — but anything a price changed FROM is outside the window.`,
      ``,
      `  On this exact run, Starter (12-month window) would show every price change since`,
      `  ${twelveMonthsAgo(today)} for ${names} (if any) — including whether either`,
      `  current price is a recent cut or a long-standing rate. Pro removes the window entirely:`,
      `  the full append-only history, every entry with effective_from + source provenance.`,
      `  Upgrade: https://modelglass.com.au/signup — fields unlocked: tiers.pricing[] (earlier entries)`,
    ];
  }
  if (tier === "starter") {
    return [
      `  This key's 12-month Starter window covers changes since ${twelveMonthsAgo(today)}.`,
      `  Anything older is out of view — Pro removes the window (full append-only history).`,
    ];
  }
  return []; // pro/internal — the numbers above are the full history; nothing to caveat.
}

function printDiff(fromModel: ModelEntry, toModel: ModelEntry, tier: KeyRecord["tier"]): void {
  const today = new Date();
  output.appendLine("\n" + hr());
  output.appendLine(`  switch-check — ${fromModel.model_id} → ${toModel.model_id}`);
  output.appendLine(`  (${fromModel.name} → ${toModel.name})`);
  output.appendLine(hr());

  // -- Section 1: price delta + stability ----------------------------------
  const prices = comparePrices(fromModel, toModel);

  output.appendLine(`\n  1. PRICE — current, unit-matched (fields: tiers.pricing[].amount, .unit)`);
  if (!prices.shared.length) {
    output.appendLine(
      `  No billing unit is priced on BOTH sides — no honest same-unit delta exists.` +
        `\n  See section 3 for what each side prices in and how the cost curve differs.`,
    );
  }
  for (const cmp of prices.shared) {
    output.appendLine(
      `  ${cmp.unit}: ${fmtPrice(cmp.from.amount, cmp.from.unit)} (${cmp.from.provider}) → ` +
        `${fmtPrice(cmp.to.amount, cmp.to.unit)} (${cmp.to.provider})  ${fmtPct(cmp.delta_pct)}` +
        (cmp.delta_pct < 0 ? " cheaper" : cmp.delta_pct > 0 ? " dearer" : " (no change)"),
    );
  }

  output.appendLine(`\n  PRICE STABILITY — window: ${historyWindowLabel(tier)}`);
  output.appendLine(`  (fields: tiers.pricing[].effective_from, .effective_to, .source.url)`);
  for (const { label, model } of [
    { label: "from", model: fromModel },
    { label: "to  ", model: toModel },
  ]) {
    output.appendLine(`  [${label}] ${model.name}:`);
    for (const h of analyzeModelHistory(model, today)) {
      const cur = h.current;
      let line =
        `    ${h.provider}/${h.tier_id}: ${fmtPrice(cur.amount, cur.unit)} since ` +
        `${cur.effective_from} (${cur.age_days} days)`;
      if (h.previous) {
        const p = h.previous;
        line +=
          ` — ${p.direction.toUpperCase()} from ${fmtPrice(p.amount, cur.unit)} (${fmtPct(p.delta_pct)})`;
      } else {
        line += ` — no earlier entry in window`;
      }
      if (cur.source_url) line += ` — source: ${cur.source_url}`;
      output.appendLine(line);
    }
  }
  const framing = windowFraming(tier, fromModel, toModel);
  if (framing.length) {
    output.appendLine("");
    for (const line of framing) output.appendLine(line);
  }

  // -- Section 2: capability diff ------------------------------------------
  const caps = capabilityDiff(fromModel, toModel);
  output.appendLine(`\n  2. CAPABILITY DIFF (fields: knowledge.capability_profile[].dimension, .rating)`);
  if (!caps.length) {
    output.appendLine(
      `  Neither model has a capability_profile in the registry — nothing to compare.` +
        `\n  (join_status: ${fromModel.join_status ?? "unknown"} / ${toModel.join_status ?? "unknown"})`,
    );
  }
  const byKind = (kind: CapabilityChange["kind"]) => caps.filter((c) => c.kind === kind);
  for (const c of byKind("lose")) {
    output.appendLine(`  LOSE  ${c.dimension}: ${c.from} → ${c.to}`);
  }
  for (const c of byKind("gain")) {
    output.appendLine(`  GAIN  ${c.dimension}: ${c.from} → ${c.to}`);
  }
  for (const c of byKind("unverifiable")) {
    const missing = c.from === null ? fromModel.name : toModel.name;
    output.appendLine(
      `  ?     ${c.dimension}: ${c.from ?? "(no rating)"} → ${c.to ?? "(no rating)"} — ` +
        `${missing} has no rating for this dimension; cannot verify, not assumed`,
    );
  }
  const same = byKind("same");
  if (same.length) {
    output.appendLine(`  same  ${same.map((c) => `${c.dimension}: ${c.to}`).join("; ")}`);
  }

  // -- Section 3: billing units ---------------------------------------------
  const warnings = unitWarnings(prices);
  output.appendLine(`\n  3. BILLING UNITS (fields: tiers.pricing[].unit)`);
  if (!warnings.length) {
    const units = [...new Set(prices.shared.map((c) => c.unit))].join(", ");
    output.appendLine(
      `  No cost-curve change: every unit priced on one side is also priced on the other` +
        (units ? ` (${units})` : "") +
        `. Deltas in section 1 are all same-unit.`,
    );
  }
  for (const w of warnings) {
    const label = w.from_unit === w.to_unit ? w.from_unit : `${w.from_unit} → ${w.to_unit}`;
    output.appendLine(`  ⚠ ${label}: ${w.note}`);
  }

  // -- Section 4: lifecycle --------------------------------------------------
  const flags = lifecycleCheck(fromModel, toModel);
  output.appendLine(`\n  4. LIFECYCLE (fields: model.status, model.generation)`);
  if (!flags.length) {
    output.appendLine(`  Both directions clear: every offering on both sides is status=ga, generation=current.`);
  }
  for (const f of flags) {
    output.appendLine(`  ${f.severity === "warn" ? "⚠" : "ℹ"} [${f.side}] ${f.model_id}: ${f.note}`);
  }

  output.appendLine("\n" + hr());
  output.appendLine(
    `  Evidence, not a verdict — every line above cites the feed field it came from;` +
      `\n  whether to migrate stays your call.`,
  );
  output.appendLine(hr() + "\n");
}

// ---------------------------------------------------------------------------
// Suggested-competitors flow — mirrors check.ts's --from-alone mode
// ---------------------------------------------------------------------------

async function runSuggestedCompetitors(
  apiKey: string,
  models: ModelEntry[],
  fromModel: ModelEntry,
  tier: KeyRecord["tier"],
): Promise<void> {
  output.appendLine(`\nNo specific "to" model chosen — pulling candidates from GET /v1/models/:modelId/competitors ...`);
  let competitors: Awaited<ReturnType<typeof fetchCompetitors>>;
  try {
    competitors = await fetchCompetitors(apiKey, fromModel.model_id);
  } catch (e) {
    vscode.window.showErrorMessage(
      `Modelglass: couldn't fetch competitors for ${fromModel.name} (${e instanceof Error ? e.message : String(e)}).`,
    );
    return;
  }

  if (!competitors.length) {
    vscode.window.showInformationMessage(
      `Modelglass: the feed lists no competitors for ${fromModel.name} — nothing to diff against. ` +
        `Pick a specific "to" model instead.`,
    );
    return;
  }

  const skipReason = (c: (typeof competitors)[number]): string | null => {
    if (c.model_id === fromModel.model_id) return "same model (a different host, not a migration)";
    if (!c.model_id || !models.some((m) => m.model_id === c.model_id))
      return "no resolvable model_id in the feed";
    return null;
  };
  const resolvable = competitors.filter((c) => skipReason(c) === null);
  const skipped = competitors.filter((c) => skipReason(c) !== null);

  output.appendLine(
    `Feed lists ${competitors.length} competitor(s); running the full diff for ` +
      `${resolvable.length} that resolve to a distinct model in the feed.`,
  );
  if (skipped.length) {
    output.appendLine(
      `Skipped (listed, not silently dropped):` +
        `\n${skipped
          .map(
            (c) =>
              `  · ${c.model_name ?? c.slug} — ${skipReason(c)}${c.notes ? ` — feed notes: ${c.notes}` : ""}`,
          )
          .join("\n")}`,
    );
  }

  for (const comp of resolvable) {
    const toModel = models.find((m) => m.model_id === comp.model_id)!;
    printDiff(fromModel, toModel, tier);
  }
  output.show(true);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function switchCheck(context: vscode.ExtensionContext): Promise<void> {
  const apiKey = await ensureApiKey(context);
  if (!apiKey) return; // user declined every recovery option — nothing more to do

  let tier: KeyRecord["tier"];
  let models: ModelEntry[];
  try {
    [tier, models] = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Modelglass: fetching the model feed…" },
      () => Promise.all([fetchTier(apiKey), fetchAllModels(apiKey)]),
    );
  } catch (e) {
    vscode.window.showErrorMessage(
      `Modelglass: couldn't fetch the model feed (${e instanceof Error ? e.message : String(e)}).`,
    );
    return;
  }

  const fromModel = await pickFromModel(models);
  if (!fromModel) return;

  const toChoice = await pickToModel(models, fromModel);
  if (toChoice === undefined) return;

  if (toChoice === SUGGESTED_COMPETITORS) {
    await runSuggestedCompetitors(apiKey, models, fromModel, tier);
    return;
  }

  printDiff(fromModel, toChoice, tier);
  output.show(true);
}
