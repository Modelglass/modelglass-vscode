<p align="center"><strong>Modelglass's VS Code extensions — route dev tasks (and generate video/audio) to the cheapest capable option against your own provider keys, or bring the live Modelglass pricing/capability feed into Copilot's agent mode as MCP tools.</strong></p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://code.visualstudio.com/"><img src="https://img.shields.io/badge/VS%20Code-%E2%89%A51.104-green.svg?style=flat-square" alt="VS Code >= 1.104"></a>
  <a href="https://modelglass.com.au/api-docs"><img src="https://img.shields.io/badge/Documentation-modelglass.com.au%2Fapi--docs-blue.svg?style=flat-square" alt="Documentation"></a>
  <a href="https://modelglass.com.au/routers"><img src="https://img.shields.io/badge/See%20it%20on%20the%20site-modelglass.com.au%2Frouters-blue.svg?style=flat-square" alt="See it on the site"></a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=modelglass.cost-aware-router"><img src="https://img.shields.io/visual-studio-marketplace/v/modelglass.cost-aware-router?label=Cost-Aware%20Router&logo=visualstudiocode&style=flat-square" alt="Cost-Aware Router version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=modelglass.cost-aware-router"><img src="https://img.shields.io/visual-studio-marketplace/i/modelglass.cost-aware-router?label=installs&style=flat-square" alt="Cost-Aware Router installs"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=modelglass.modelglass-mcp"><img src="https://img.shields.io/visual-studio-marketplace/v/modelglass.modelglass-mcp?label=Modelglass%20MCP&logo=visualstudiocode&style=flat-square" alt="Modelglass MCP version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=modelglass.modelglass-mcp"><img src="https://img.shields.io/visual-studio-marketplace/i/modelglass.modelglass-mcp?label=installs&style=flat-square" alt="Modelglass MCP installs"></a>
</p>

# modelglass-vscode

## What Modelglass is

[Modelglass](https://modelglass.com.au) is a pricing-and-capability data
layer for AI models — image, video, audio, and LLM — built as a sourced,
append-only registry: every price carries a source URL and the date it was
verified, and a repricing is a new dated entry, never a silent overwrite.
It's served two ways: a free comparison site, and a paid **read API + MCP
server** (`https://modelglass-api.vercel.app`, `POST /mcp`) for operators
wiring model pricing into their own tooling. Modelglass itself doesn't proxy
your traffic or pick a model at runtime — it's the data other people's
tools (including both extensions in this repo) read.

## What this repo is

An npm workspaces monorepo publishing **two independent VS Code
extensions**, each installable on its own:

| Package | What it is | Marketplace |
|---|---|---|
| [`packages/router`](packages/router) | **Modelglass Cost-Aware Router** — routes dev tasks to the cheapest capable LLM (and generates video via Runway, audio via ElevenLabs) directly against your own provider keys, BYOK, no Modelglass proxy in the request path. Also available directly inside Copilot Chat's model picker. | [`modelglass.cost-aware-router`](https://marketplace.visualstudio.com/items?itemName=modelglass.cost-aware-router) |
| [`packages/mcp`](packages/mcp) | **Modelglass MCP** — registers the live Modelglass MCP server directly in Copilot's agent mode, no manual `.vscode/mcp.json` editing. Seven read-only tools (models, pricing history, competitors, account/tier info) — Copilot's agent decides when to use them, this extension just makes them discoverable. | [`modelglass.modelglass-mcp`](https://marketplace.visualstudio.com/items?itemName=modelglass.modelglass-mcp) |
| [`packages/shared`](packages/shared) | Internal only, not published. `SecretStorage`-backed auth (`ensureApiKey`/`peekApiKey`) and the Modelglass API base URL, shared by both extensions above. | — |

Both extensions use the same Modelglass account/API key — installing one
doesn't require separately authenticating the other. See each package's own
`README.md` for full usage docs, including a screenshot of it in action.

![Modelglass: Route Task recommendation](https://raw.githubusercontent.com/Modelglass/modelglass-vscode/main/packages/router/docs/screenshot.png)

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

To run an extension locally: open `packages/router` or `packages/mcp` as
the VS Code workspace root and press **F5** to launch an Extension
Development Host with your changes loaded — standard VS Code extension
tooling, no custom launch config needed. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full local-dev + PR flow.

The router/mcp split is tracked as SCO-434 in the main `modelglass` repo's
Linear project.

## Contributing

Bug reports, fixes, and new features are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md).

To report a security vulnerability, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.

## Talk to us

Questions about Modelglass itself or either extension — email
**scott@modelglass.com.au**.

---

Copyright © 2026 Modelglass Pty Ltd. Licensed under the MIT License — see [LICENSE](LICENSE).
