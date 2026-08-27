# Contributing to modelglass-vscode

Thanks for your interest in contributing. Unlike the main Modelglass
registry (proprietary, all rights reserved), **this repo is MIT-licensed**
— see [`LICENSE`](./LICENSE).

## What this repo is

An npm workspaces monorepo publishing two independent VS Code extensions to
the Marketplace — [`packages/router`](packages/router) (**Modelglass
Cost-Aware Router**) and [`packages/mcp`](packages/mcp) (**Modelglass
MCP**) — plus [`packages/shared`](packages/shared), an internal-only package
(not published) holding the SecretStorage-backed auth both extensions share.
See [`README.md`](./README.md) for what each one does.

## How to contribute

**Bug reports and fixes** — open an issue or a PR. Include your VS Code
version, which extension (`router` or `mcp`), and the exact steps to
reproduce.

**New features** — open an issue describing what you want to add before
starting work, especially for `router`: it's deliberately opinionated (see
its own README's "Scope" section — explicit task categories over a hidden
classifier, no proxy in the request path, BYOK only) and not every idea fits
that philosophy.

**Docs fixes** — typos, unclear setup steps, broken links — small PRs
welcome, no need to open an issue first.

### Running an extension locally

Both packages are standard VS Code extensions — no custom launch
configuration needed, VS Code's own tooling handles it:

```bash
npm install                                # installs + links all 3 workspace packages
npm run watch --workspace packages/router  # or packages/mcp — esbuild watch mode
```

Then open `packages/router` (or `packages/mcp`) as the VS Code workspace
root and press **F5** — this launches an Extension Development Host window
with your changes loaded. Both packages require VS Code 1.104+
(`engines.vscode` in each `package.json`) — an older VS Code won't load
them.

### Before opening a PR

```bash
npm install
npm run typecheck --workspace packages/<router|mcp>
npm run test --workspace packages/<router|mcp>   # skipped automatically where no test script exists
npm run build --workspace packages/<router|mcp>
```

CI (`.github/workflows/validate.yml`) runs all of the above per package,
plus `npx vsce package --no-dependencies` and a check that the resulting
`.vsix` only contains an explicit allowlist of files — added after a real
incident (SCO-430/433) where local-dev files leaked into a published
package. **If your change touches `.vscodeignore`, the `files` field, or
anything under a package's `docs/`/`dist/` output, run `npm run package
--workspace packages/<router|mcp>` locally and sanity-check the resulting
`.vsix` before opening the PR** — CI will catch a leak, but catching it
yourself first saves a round-trip.

### PR checklist

- [ ] Typecheck, test, and build all pass locally for the package(s) you touched
- [ ] If you added or changed user-facing behavior, that package's own
      `README.md` documents it
- [ ] No secrets, API keys, or `.env` files committed — provider keys are
      read via VS Code's `SecretStorage` API at runtime, never hardcoded or
      written to disk

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md) — please
read it before participating in issues, PRs, or discussions.

## Security issues

Found a security vulnerability rather than a bug? Don't open a public issue
— see [`SECURITY.md`](./SECURITY.md) instead.

## Questions

Open an issue, or email **scott@modelglass.com.au**.
