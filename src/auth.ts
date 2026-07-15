import * as vscode from "vscode";
import { MODELGLASS_API } from "./lib.js";

/**
 * Replaces the upstream CLI's requireApiKey() (SCO-211) — that function reads
 * process.env and calls process.exit(1) on failure, which would take down the
 * whole Extension Host (every other running extension, not just this one) if
 * reused here. This module owns the key lifecycle instead: SecretStorage for
 * persistence, silent auto-provisioning via POST /v1/keys/provision on first
 * use (same pattern the Modelglass iOS app already uses), and a manual
 * entry/reset path via the modelglass.setApiKey command.
 */

const SECRET_KEY = "modelglassApiKey";
const SIGNUP_URL = "https://modelglass.com.au/signup";

interface ProvisionResponse {
  key: string;
  plan: string;
  rate_limit: number;
  warning?: string;
}

type ProvisionResult =
  | { ok: true; key: string }
  | { ok: false; reason: "network" | "rate_limited" | "other"; message: string };

/**
 * Shared across every command (SCO-216) — one "Modelglass" channel a user
 * finds in one place, rather than a per-command channel they'd have to know
 * to switch between. Created here since auth (this module) always runs
 * first on any command's first activation.
 */
export const output = vscode.window.createOutputChannel("Modelglass");

async function callProvision(): Promise<ProvisionResult> {
  let res: Response;
  try {
    res = await fetch(`${MODELGLASS_API}/v1/keys/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "free" }),
    });
  } catch (e) {
    return {
      ok: false,
      reason: "network",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  if (res.status === 429) {
    const body = await res.json().catch(() => null);
    return {
      ok: false,
      reason: "rate_limited",
      message: body?.error?.message ?? "Rate limited.",
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, reason: "other", message: `${res.status}: ${text}` };
  }

  const json = (await res.json()) as ProvisionResponse;
  if (json.warning) {
    // Server-side transient-storage caveat (KV not configured) — not
    // actionable by the user, so it goes to the output channel, not a popup.
    output.appendLine(`[auth] provision warning: ${json.warning}`);
  }
  return { ok: true, key: json.key };
}

/**
 * Silently provisions a free key on first use. Called from activate() —
 * because this extension activates only via contributes.commands (no
 * onStartupFinished/*), "on activation" and "on first command invocation"
 * are the same moment in practice; there's no earlier point to hook.
 *
 * Failure handling, distinct per cause (SCO-211's plan):
 *  - network error -> warning with [Retry] / [Enter key manually]
 *  - 429 rate limited -> point at manual signup, no auto-retry (won't help
 *    within the same window)
 *  - other 4xx/5xx -> generic error, same manual-entry fallback
 * No automatic retry loop in any case — one attempt per activation, the user
 * drives any further attempt via re-running a command.
 */
export async function ensureApiKey(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const existing = await context.secrets.get(SECRET_KEY);
  if (existing) return existing;

  const result = await callProvision();
  if (result.ok) {
    await context.secrets.store(SECRET_KEY, result.key);
    output.appendLine("[auth] provisioned a free API key automatically.");
    return result.key;
  }

  if (result.reason === "network") {
    const choice = await vscode.window.showWarningMessage(
      "Modelglass: couldn't reach the pricing API to set up your free key.",
      "Retry",
      "Enter key manually",
    );
    if (choice === "Retry") return ensureApiKey(context);
    if (choice === "Enter key manually") return promptForKey(context);
    return undefined;
  }

  if (result.reason === "rate_limited") {
    const choice = await vscode.window.showWarningMessage(
      `Modelglass: free-key setup is rate-limited right now (${result.message}). ` +
        "Get one manually instead, or try again later.",
      "Open signup page",
      "Enter key manually",
    );
    if (choice === "Open signup page") {
      vscode.env.openExternal(vscode.Uri.parse(SIGNUP_URL));
    } else if (choice === "Enter key manually") {
      return promptForKey(context);
    }
    return undefined;
  }

  // reason === "other"
  const choice = await vscode.window.showErrorMessage(
    `Modelglass: couldn't set up your free key (${result.message}).`,
    "Enter key manually",
  );
  if (choice === "Enter key manually") return promptForKey(context);
  return undefined;
}

/** Manual entry/reset path — bound to the modelglass.setApiKey command. */
export async function promptForKey(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: "Modelglass API Key",
    prompt: `Paste an existing key, or get a free one at ${SIGNUP_URL}`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "API key can't be empty"),
  });
  if (!key) return undefined;
  await context.secrets.store(SECRET_KEY, key.trim());
  vscode.window.showInformationMessage("Modelglass: API key saved.");
  return key.trim();
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
}
