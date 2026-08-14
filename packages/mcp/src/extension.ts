import * as vscode from "vscode";
import { registerModelglassMcpProvider } from "./mcp-provider.js";

export function activate(context: vscode.ExtensionContext): void {
  registerModelglassMcpProvider(context);
}

export function deactivate(): void {
  // No teardown needed — no timers, listeners, or open connections held outside `context.subscriptions`.
}
