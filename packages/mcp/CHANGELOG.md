# Changelog

## 0.1.0 — 2026-08-14

Initial release (SCO-434). Registers the live Modelglass HTTP MCP transport
(`POST /mcp`) via `vscode.lm.registerMcpServerDefinitionProvider`, so all
seven Modelglass tools appear automatically in Copilot Chat's agent mode.
Shares SecretStorage-backed auth with Cost-Aware Router (same account, same
free-key auto-provisioning on first use). No Free-tier gating.
