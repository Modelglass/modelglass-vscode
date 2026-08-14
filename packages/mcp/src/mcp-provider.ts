import * as vscode from "vscode";
import { MODELGLASS_API, ensureApiKey, output, peekApiKey } from "@modelglass/vscode-shared";

/**
 * SCO-434 — registers the live Modelglass HTTP MCP transport
 * (`POST /mcp` on modelglass-api.vercel.app, see CLAUDE.md) directly via
 * `vscode.lm.registerMcpServerDefinitionProvider`, so the 7 Modelglass
 * tools show up in Copilot's agent mode with no manual `.vscode/mcp.json`
 * editing. No new server to build or host — this is a declaration pointing
 * at an endpoint that already exists, mirroring lm-provider.ts's
 * registration style in the router package (feature-detected, try/catch
 * guarded, never lets a registration failure block anything else).
 *
 * `McpHttpServerDefinition` is a real, stable (non-@proposed) API as of
 * VS Code 1.102 — confirmed by reading the actual `vscode.d.ts`, not a
 * summary (see SCO-434's scoping comment). Its `headers` field is sent on
 * every request, not just the first, so a Bearer token set once here is
 * enough — no per-call re-authentication needed.
 *
 * The two-method split on `McpServerDefinitionProvider` mirrors the
 * existing peek/ensure split this codebase already uses for the same
 * reason in lm-provider.ts (SCO-331):
 *  - `provideMcpServerDefinitions` is called EAGERLY by the editor (e.g. on
 *    activation, or whenever the server list is refreshed) — it must never
 *    prompt or provision, so it uses `peekApiKey` (silent, may return
 *    undefined) and ships a definition with no Authorization header yet.
 *  - `resolveMcpServerDefinition` is called only when the editor is about
 *    to actually START the server — a genuinely user-initiated moment,
 *    where auth IS allowed. This uses `ensureApiKey` (may auto-provision a
 *    free key or prompt), matching every other command in the router
 *    package. Returning `undefined` here is documented API contract for
 *    "don't start this server" — used when the user declines every
 *    recovery option `ensureApiKey` offers.
 *
 * No Free-tier gating (Scott's decision, SCO-434): every one of the 7
 * Modelglass tools already works on every plan today (server-side, via the
 * REST API, the stdio MCP server, and this same HTTP transport) — adding a
 * client-side block here would be a NEW, more restrictive behaviour than
 * every existing consumer, not a continuation of an existing pattern. A
 * Free-key user gets the same tools as everyone else; the API's own
 * per-plan history-window gating (ADR 0004) still applies server-side,
 * unchanged, same as it does for every other client.
 */

const PROVIDER_ID = "modelglass.mcpServerProvider";
const MCP_URL = `${MODELGLASS_API}/mcp`;
const SERVER_LABEL = "Modelglass";

function buildDefinition(headers?: Record<string, string>): vscode.McpHttpServerDefinition {
  return new vscode.McpHttpServerDefinition(SERVER_LABEL, vscode.Uri.parse(MCP_URL), headers);
}

class ModelglassMcpServerDefinitionProvider implements vscode.McpServerDefinitionProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Eager, silent — no provisioning, no popups. If a key is already
   * stored, ship it now so the tool list can populate immediately without
   * waiting on the (also eager) resolve step; otherwise ship a definition
   * with no Authorization header, which `resolveMcpServerDefinition` fills
   * in when the server is actually started.
   */
  async provideMcpServerDefinitions(
    _token: vscode.CancellationToken,
  ): Promise<vscode.McpServerDefinition[]> {
    const existing = await peekApiKey(this.context);
    return [buildDefinition(existing ? { Authorization: `Bearer ${existing}` } : undefined)];
  }

  /**
   * Called only when the editor is about to start this server — the
   * genuinely user-initiated moment where `ensureApiKey`'s prompt/
   * auto-provision flow is appropriate (same reasoning as
   * `provideLanguageModelChatResponse` in lm-provider.ts, not
   * `provideLanguageModelChatInformation`).
   */
  async resolveMcpServerDefinition(
    server: vscode.McpServerDefinition,
    _token: vscode.CancellationToken,
  ): Promise<vscode.McpServerDefinition | undefined> {
    const key = await ensureApiKey(this.context);
    if (!key) return undefined; // user declined every recovery option — don't start the server
    if (server instanceof vscode.McpHttpServerDefinition) {
      server.headers = { Authorization: `Bearer ${key}` };
    }
    return server;
  }
}

/**
 * Registered defensively, same as `registerModelglassChatProvider` in the
 * router package: feature-detected (an older VS Code simply won't have
 * this function) and try/catch-guarded so a registration failure never
 * blocks activation.
 */
export function registerModelglassMcpProvider(context: vscode.ExtensionContext): void {
  if (typeof vscode.lm.registerMcpServerDefinitionProvider !== "function") {
    output.appendLine(
      "[mcp-provider] vscode.lm.registerMcpServerDefinitionProvider isn't available on this VS Code version " +
        "(needs 1.102+) — the Modelglass MCP server won't be auto-registered this run.",
    );
    return;
  }

  try {
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider(
        PROVIDER_ID,
        new ModelglassMcpServerDefinitionProvider(context),
      ),
    );
    output.appendLine(`[mcp-provider] registered the Modelglass MCP server definition provider (${MCP_URL}).`);
  } catch (e) {
    output.appendLine(
      `[mcp-provider] failed to register the MCP server definition provider (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
}
