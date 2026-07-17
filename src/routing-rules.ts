import * as vscode from "vscode";
import { output } from "./auth.js";
import { validateRoutingRulesConfig, type RoutingRule } from "./routing-rules-lib.js";
import type { LeafTaskCategory } from "./routing-engine.js";

/**
 * SCO-231 — vscode-coupled workspace-rules-file loader. The pure validation
 * + ranking-override logic lives in ./routing-rules-lib.ts (no vscode
 * import there, so it's directly unit-testable); this file is the thin
 * glue — reading the file via vscode.workspace.fs (works over remote/virtual
 * filesystems, unlike Node's fs) and reporting problems — not tested
 * directly, same split as switch-check-lib.ts/switch-check.ts.
 */

const RULES_RELATIVE_PATH = [".modelglass", "routing-rules.json"];

export type LoadedRules = { found: true; rulesByCategory: Map<LeafTaskCategory, RoutingRule> } | { found: false };

/**
 * Loads and validates .modelglass/routing-rules.json from the first
 * workspace folder, if any. Fails OPEN: no workspace folder, no file,
 * invalid JSON, or a structural validation error all resolve to
 * `{ found: false }` — SCO-230's default engine, unmodified — rather than
 * blocking task routing entirely. A typo in a hand-edited rules file
 * shouldn't make the extension unusable; it should degrade to default
 * routing and tell the user why, not silently and not fatally.
 */
export async function loadRoutingRules(): Promise<LoadedRules> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return { found: false };

  const uri = vscode.Uri.joinPath(folder.uri, ...RULES_RELATIVE_PATH);
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return { found: false }; // no rules file configured — the common case, not an error
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    output.appendLine(`[routing-rules] .modelglass/routing-rules.json is not valid JSON (${message}) — using default routing.`);
    vscode.window.showWarningMessage(
      "Modelglass: .modelglass/routing-rules.json isn't valid JSON — using default routing for this run.",
    );
    return { found: false };
  }

  const result = validateRoutingRulesConfig(parsed);
  if (!result.ok) {
    output.appendLine(
      `[routing-rules] .modelglass/routing-rules.json failed validation:\n  - ${result.errors.join("\n  - ")}\nUsing default routing.`,
    );
    vscode.window.showWarningMessage(
      "Modelglass: .modelglass/routing-rules.json has errors — see the Modelglass output channel. Using default routing for this run.",
    );
    return { found: false };
  }

  return { found: true, rulesByCategory: result.rulesByCategory };
}
