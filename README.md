# modelglass-vscode

Modelglass's VS Code extensions. npm workspaces monorepo — each package
publishes independently to the Marketplace under its own extension ID.

| Package | What it is | Marketplace |
|---|---|---|
| [`packages/router`](packages/router) | **Modelglass Cost-Aware Router** — routes dev tasks to the cheapest capable LLM (and generates video/audio) against your own provider keys, BYOK. | `modelglass.cost-aware-router` |
| [`packages/mcp`](packages/mcp) | **Modelglass MCP** — registers the live Modelglass MCP server directly in Copilot's agent mode. | `modelglass.mcp` |
| [`packages/shared`](packages/shared) | Internal only, not published. SecretStorage-backed auth (`ensureApiKey`/`peekApiKey`) and the Modelglass API base URL, shared by both extensions above. | — |

Both extensions use the same Modelglass account/API key (`packages/shared`'s
`auth.ts`) — installing one doesn't require separately authenticating the
other.

## Development

```bash
npm install                              # installs + links all three workspace packages
npm run typecheck                        # all packages
npm run test                             # all packages (packages without a test script are skipped)
npm run build                            # all packages

# per-package:
npm run build --workspace packages/router
npm run package --workspace packages/mcp   # -> packages/mcp/*.vsix
```

See each package's own `README.md` for what it does. The router/mcp split is
tracked as SCO-434 in the main `modelglass` repo's Linear project.
