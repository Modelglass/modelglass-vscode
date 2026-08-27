# Security Policy

This repo publishes two VS Code extensions that run inside your editor and,
for `router`, handle your own provider API keys (OpenAI, Anthropic, Runway,
ElevenLabs) directly — that's a meaningfully different surface than a pure
code-examples repo. Both extensions store credentials exclusively via VS
Code's `SecretStorage` API (backed by your OS keychain), never in plaintext
settings, `globalState`, or written to disk — verified directly in
`packages/shared/src/auth.ts` and `packages/router/src/provider-keys.ts`.

If you're looking for the security policy of the live Modelglass API, MCP
server, or site these extensions call into, that's a separate, proprietary
repo — email **scott@modelglass.com.au** for that too, the process below
covers both.

## Supported versions

| Extension | Current version | Supported |
|---|---|---|
| Modelglass Cost-Aware Router (`packages/router`) | 0.6.x | ✅ latest only |
| Modelglass MCP (`packages/mcp`) | 0.1.x | ✅ latest only |

Only the latest published version of each extension is supported. There are
no maintained older releases — update via the Marketplace to get a fix.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email **`scott@modelglass.com.au`** with:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept),
- which extension is affected (`router` or `mcp`) and its version.

We will **acknowledge your report within 48 hours** and aim to ship a fix for
**critical issues within 14 days**. We'll keep you updated on progress and
credit you on request once the fix is released.

## Scope

**In scope:**

- Credentials handled insecurely — anything that logs, writes to disk
  outside `SecretStorage`, or transmits a provider key or Modelglass API key
  anywhere other than that key's own provider (never to Modelglass itself,
  for BYOK provider keys — see `router`'s own README).
- A published `.vsix` containing files it shouldn't (this has happened
  before — SCO-430/433, a `.vscodeignore` miss that shipped local-dev files
  in a release; CI now gates on an explicit file allowlist per package, but
  a bypass of that gate is a real report).
- Anything that lets workspace content (a prompt, a `.modelglass/routing-rules.json`
  file, a shot list) cause unintended file writes, command execution, or
  network calls outside the extension's documented behavior.

**Out of scope:**

- The live Modelglass API, MCP server, or site's own security — those are a
  separate, proprietary repo; report the same way (email above), we'll route
  it internally.
- The third-party providers themselves (OpenAI, Anthropic, Runway,
  ElevenLabs) — you're calling them directly with your own key; their
  security is theirs.
- Vulnerabilities in third-party dependencies with no realistic exploit path
  through how this repo actually calls them — a bare `npm audit` finding
  isn't automatically a report, though a genuinely reachable one is welcome.
- Requiring a VS Code environment that's already compromised (a malicious
  extension already installed, an already-compromised machine).

## Known, intentional non-issues

- **Provider keys never reach Modelglass.** Both extensions are BYOK
  (bring-your-own-key) — `router`'s own code and README state this
  explicitly for every provider it supports, and it's verified in
  `provider-keys.ts`. Modelglass has no proxy in the request path.
- **`packages/shared` is unpublished, internal-only** by design — it's not
  a supply-chain surface beyond this repo's own two published extensions.
