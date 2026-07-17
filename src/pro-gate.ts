import * as vscode from "vscode";

/**
 * SCO-234 — the one genuinely vscode-coupled piece of Pro gating: showing an
 * explicit upgrade prompt (item 3 — "a clear in-extension upgrade prompt...
 * not a silent failure"). Everything else (the tier check itself, and every
 * gating decision) lives in ./pro-gate-lib.ts and needs no vscode API at
 * all — `checkProAccess` there is called directly with the real global
 * `fetch` from run-task.ts/provider-keys.ts, no wrapper needed here.
 */

const UPGRADE_URL = "https://modelglass.com.au/signup";

export async function promptUpgradeToPro(featureDescription: string): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `Modelglass: ${featureDescription} requires a Pro plan.`,
    "Upgrade to Pro",
  );
  if (choice === "Upgrade to Pro") {
    vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
  }
}
