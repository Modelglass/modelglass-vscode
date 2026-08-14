# Modelglass MCP

Registers the live [Modelglass](https://modelglass.com.au) pricing/capability
MCP server directly in VS Code, so its tools show up automatically in
Copilot Chat's agent mode — no manual `.vscode/mcp.json` editing required.

This extension does exactly one thing: it declares the Modelglass MCP server
(`POST /mcp` on `modelglass-api.vercel.app`) via VS Code's native
[`mcpServerDefinitionProviders`](https://code.visualstudio.com/api/extension-guides/ai/mcp)
API. There's no new server here — the server side is the same MCP endpoint
Modelglass already runs; this just makes it discoverable without hand-editing
config files.

## What you get

Seven read-only tools, backed by the live Modelglass pricing feed:

- List and search models across every tracked provider
- Look up a specific model's current and historical pricing
- Compare two models
- Find a model's closest competitors
- Check your own account/tier

All tools carry `readOnlyHint: true` — nothing this extension registers can
write to your Modelglass account or any third-party service.

## Setup

1. Install the extension.
2. Open Copilot Chat, switch to **Agent mode**, and open the tools picker —
   "Modelglass" should appear alongside your other MCP servers.
3. The first time you actually use a Modelglass tool, you'll be prompted to
   set up a Modelglass API key. If you don't have one, a free key is
   provisioned automatically (same flow as [modelglass.com.au/signup](https://modelglass.com.au/signup)) —
   no separate signup step required.

Free-plan keys work here the same as every other Modelglass surface (the
REST API, the stdio MCP server, the site) — nothing in this extension is
gated to Starter/Pro.

## How this differs from Modelglass Cost-Aware Router

[**Modelglass Cost-Aware Router**](https://marketplace.visualstudio.com/items?itemName=modelglass.cost-aware-router)
is a separate extension that *actively routes and executes* dev tasks
against the cheapest capable LLM (and generates video/audio), using your own
provider keys. It's an opinionated, hands-on-the-wheel router.

**Modelglass MCP** (this extension) does none of that. It's a thin,
declarative bridge that hands Copilot's own agent the same pricing data as a
set of callable tools, so *Copilot* — not this extension — decides when and
how to use them. If you want the router's automatic model selection and
execution, install Cost-Aware Router. If you just want Copilot's agent to be
able to answer "what's the cheapest model that can do X" or "how has this
model's pricing changed" on its own, this is the smaller, single-purpose
extension for that.

Both extensions use the same Modelglass account and API key — installing
both doesn't require separate setup.

## Links

- [Modelglass](https://modelglass.com.au)
- [MCP client setup docs](https://github.com/Modelglass/modelglass/blob/main/docs/mcp-usage.md)
- [Report an issue](https://github.com/Modelglass/modelglass-vscode/issues)
