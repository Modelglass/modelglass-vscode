# Modelglass Cost-Aware Router

A VS Code extension that routes a task to the cheapest LLM that clears a
confirmed benchmark bar, using the live [Modelglass](https://modelglass.com.au)
pricing and capability feed.

![Modelglass: Route Task recommendation](docs/screenshot.png)

## What it does

1. Run **Modelglass: Route Task to Cheapest Capable Model** from the Command Palette.
2. Describe what you're about to do; the extension infers a starting task type
   (coding / writing / general) from your active file's language — always
   overridable.
3. It fetches the current LLM pricing/capability feed and recommends the
   cheapest model that clears the relevant quality bar — coding tasks are
   ranked by SWE-bench Verified, writing/general tasks by
   instruction-following rating.

## Install

From the Marketplace (once published): search **Modelglass Cost-Aware
Router** in VS Code's Extensions view, or run:

```bash
code --install-extension modelglass.cost-aware-router
```

From a `.vsix` file directly (e.g. for testing a pre-release build):

```bash
code --install-extension path/to/cost-aware-router-0.1.0.vsix
```

### First run

No account or setup needed: the extension silently provisions its own free
Modelglass API key the first time you run a command, stored in VS Code's
`SecretStorage` — never in a settings file or anything synced elsewhere.
Look in the **Modelglass** output channel (View → Output) to confirm it
provisioned successfully. If the API is unreachable, it offers to retry or
let you enter a key manually instead.

## Commands

| Command | What it does |
|---|---|
| **Modelglass: Route Task to Cheapest Capable Model** | Prompts for a task description, then recommends the cheapest LLM that clears the relevant quality bar for it. |
| **Modelglass: Compare Two Models** | Grounded migration diff between two models — pick a "from" model, then a "to" model (or the feed's own suggested competitors). Reports the unit-matched price delta and price *stability* (from the append-only price history), a per-dimension capability diff, billing-unit change warnings, and lifecycle checks, in the **Modelglass** Output panel. Works across image/llm/video/audio, and on every plan tier including Free. |
| **Modelglass: Set API Key** | Enter an existing Modelglass API key, or clear the stored one (forcing re-provisioning on next use). |

![Modelglass: Compare Two Models diff output](docs/screenshot-compare.png)

## Scope (v1 / MVP)

- **Route Task** is LLM routing only (coding + writing/general) — no image,
  video, or audio modality there. **Compare Two Models** is cross-modality
  (image/llm/video/audio all resolve) — a migration diff doesn't need to pick
  a "best" model the way routing does, so there's no reason to scope it down.
- Single-subtask routing — "what should I use for this next chunk of work,"
  once per invocation. The CLI's full multi-subtask task/JSON-file/cost-table
  view is not reproduced here.
- No escalation/usage-logging (the CLI's `report` command's feature set) — out
  of scope for this extension.

## Relationship to `cost-aware-vscode-router`

The core selection logic (`src/lib.ts`) is vendored from
[`modelglass-router-examples/cost-aware-vscode-router/src/lib.ts`](https://github.com/Modelglass/modelglass-router-examples/tree/main/cost-aware-vscode-router) —
same pricing/quality-bar logic, same tests. There's no published shared
package to depend on instead, so this is a deliberate copy, kept in sync by
hand. `requireApiKey()` (that repo's CLI-only key handling, which calls
`process.exit(1)` on failure — not safe inside an Extension Host) is replaced
entirely by `src/auth.ts`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build      # bundles src/extension.ts -> dist/extension.cjs via esbuild
npm run watch       # same, rebuilding on change
npm run package     # builds + bundles a .vsix via vsce
```

Press `F5` in VS Code (with this folder open) to launch an Extension
Development Host for manual testing.

## License

MIT — see [LICENSE](LICENSE). Consistent with `modelglass-router-examples`
(SCO-170) — this extension is meant to be installed, read, and adapted.
