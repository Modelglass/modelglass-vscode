# Changelog

## 0.1.1 — 2026-08-14

Docs only, no functional change. The README screenshot didn't render on
the Marketplace listing — `vsce` rewrites relative README image links to
GitHub raw URLs, but doesn't account for `repository.directory` in this
monorepo, so it dropped the `packages/mcp/` path segment and pointed at a
404. Fixed by using an explicit absolute `raw.githubusercontent.com` URL
instead of a relative path.

## 0.1.0 — 2026-08-14

Initial release (SCO-434). Registers the live Modelglass HTTP MCP transport
(`POST /mcp`) via `vscode.lm.registerMcpServerDefinitionProvider`, so all
seven Modelglass tools appear automatically in Copilot Chat's agent mode.
Shares SecretStorage-backed auth with Cost-Aware Router (same account, same
free-key auto-provisioning on first use). No Free-tier gating.
