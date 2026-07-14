# Modelglass Cost-Aware Router

A VS Code extension that routes a task to the cheapest LLM that clears a
confirmed benchmark bar, using the live [Modelglass](https://modelglass.com.au)
pricing and capability feed — the in-editor surface layer that
[`modelglass-router-examples/cost-aware-vscode-router`](https://github.com/Modelglass/modelglass-router-examples/tree/main/cost-aware-vscode-router)'s
own README names but doesn't build.

## What it does

1. Run **Modelglass: Route Task to Cheapest Capable Model** from the Command Palette.
2. Describe what you're about to do; the extension infers a starting task type
   (coding / writing / general) from your active file's language — always
   overridable.
3. It fetches the current LLM pricing/capability feed and recommends the
   cheapest model that clears the relevant quality bar — coding tasks are
   ranked by SWE-bench Verified, writing/general tasks by
   instruction-following rating.

No account needed: the extension silently provisions its own free Modelglass
API key on first use (same pattern the
[Modelglass Pro iOS app](https://apps.apple.com/app/modelglasspro/id6782248610)
uses), stored in VS Code's `SecretStorage`. Use **Modelglass: Set API Key** to
enter an existing key or reset it.

## Scope (v1 / MVP)

- LLM routing only (coding + writing/general) — no image, video, or audio
  modality. The underlying feed covers those too; this extension doesn't
  surface them yet.
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
```

Press `F5` in VS Code (with this folder open) to launch an Extension
Development Host for manual testing.

## License

MIT — see [LICENSE](LICENSE). Consistent with `modelglass-router-examples`
(SCO-170) — this extension is meant to be installed, read, and adapted.
