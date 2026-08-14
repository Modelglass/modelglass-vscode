# Changelog

## 0.6.2 — 2026-08-14

Docs only, no functional change. This is the first publish since the
SCO-434 repo restructure (this extension now lives at `packages/router/`
in the `modelglass-vscode` repo, alongside a new standalone **Modelglass
MCP** extension sharing this extension's SecretStorage auth) — same
publisher, extension ID (`modelglass.cost-aware-router`), commands, and
behaviour throughout, existing installs unaffected. That restructure did
have one live side effect worth a release on its own: both README
screenshots had gone dark on the Marketplace listing, discovered publishing
`modelglass-mcp` — `vsce` rewrites relative README image links to GitHub
raw URLs but doesn't account for `repository.directory` in this monorepo,
so it dropped the `packages/router/` path segment and pointed at a 404
(the underlying files moved when the restructure merged, so this had been
broken since then, independent of this release). Fixed by using explicit
absolute `raw.githubusercontent.com` URLs instead of relative paths.

## 0.6.1 — 2026-08-13

Docs only, no functional change — 0.6.0 published to the Marketplace with
its short description and README still describing LLM routing only. This
release updates both to mention Generate Video (Runway) and Generate Audio
(ElevenLabs), and adds `video`/`audio` to the Marketplace search keywords.

## 0.6.0 — 2026-08-13

**The router now generates video and audio, not just LLM completions
(SCO-430, implementing ADR-0012 Amendments 2/3).** Two new commands:
**Generate Video (Runway)** and **Generate Audio (ElevenLabs)** — both
BYOK, Starter/Pro only, no fallback chain (a deliberate reliability-first
simplification, not an oversight). Video generation is async
job-submit-and-poll (submit → poll `/v1/tasks/{id}` → signed result URL,
cancellable via `DELETE /v1/tasks/{id}`), with a 12-minute total wait
budget separate from the existing 60s per-call timeout. Audio splits by
*endpoint*, not provider: core TTS and Instant Voice Cloning are
synchronous (same request/response contract as LLM chat completions, just
a binary body); dubbing is async like video, but with no confirmed
cancel endpoint — canceling stops this extension from polling, but the
job may keep running and billing on ElevenLabs' side, disclosed in the
progress UI rather than assumed away. Generated files save to
`.modelglass/generated/` in the current workspace (or the OS temp
directory with none open) and reveal in the OS file explorer by default,
rather than auto-opening. Runway/ElevenLabs keys are stored separately
from the LLM router's provider keys (`src/media-provider-keys-lib.ts`) —
deliberately NOT sharing Starter's single-LLM-key exclusivity, since a
Runway key and a coding-router key are unrelated capabilities a user can
reasonably want configured at the same time. Image generation (fal.ai) is
explicitly out of scope for this release — a separate future addition
once fal.ai is confirmed as the provider.

**Generate Video offers 5 Runway models** (Gen-4.5, Gen-4 Turbo, Seedance 2,
Aleph 2, HappyHorse 1.0) — two of the seven in the Modelglass registry are
not offered: **Gen-3 Alpha** has been retired from Runway's API and no
longer has a working model identifier; **Act-Two** needs a different
Runway endpoint (Character Performance) than this release supports. Video
output ratio currently defaults to a fixed 1280:720 landscape — not yet
user-selectable.

## 0.5.0 — 2026-07-29

**The router's default is now genuinely cheapest-capable, not
best-regardless-of-price (SCO-330, round 2).** Original SCO-330 (0.3.1)
diagnosed the bug — `routing-engine.ts` ranked score-descending with price
only a tie-break, so "Run Task on Cheapest Capable Model" could pick a
$5/M 96.2%-scoring model over a $1.1/M 68%-scoring one — and shipped a fix,
but only as an opt-in `minScore` field in `.modelglass/routing-rules.json`
(Pro-only). Every existing user with no rules file still got the old
score-first behavior by default. This release flips the DEFAULT itself:
the five benchmark-scored categories (bug fix, new code generation,
terminal/CLI, library-aware feature work, refactor) now each apply a
built-in quality bar calibrated to that specific benchmark's real score
range (checked against the live feed, not guessed — e.g. 60% on SWE-bench
Verified, 50% on Aider Polyglot), then rank cheapest-first among whatever
clears it. No configuration needed — every user gets this out of the box.

An explicit `minScore` in `.modelglass/routing-rules.json` still works
exactly as before, now as an override of the built-in default rather than
the only way to get one. If every model happens to fall below the default
bar (a thin/weak pool right now), the extension falls back to the
old score-descending order rather than reporting nothing — an *explicit*
`minScore` that excludes everyone still returns genuinely empty, since
that's a deliberate choice the user should see plainly.

## 0.4.0 — 2026-07-29

**The router is now available directly inside Copilot Chat (SCO-331).** No
more Command Palette-only — Modelglass registers as a `vscode.lm` chat
provider ("Modelglass Router" in the model picker), exposing 9 selectable
models, one per task category (Bug fix / debug, New code generation,
Terminal/CLI/DevOps, Library-aware feature work, Refactor, Test generation,
Documentation generation, Chat/explain, Autocomplete — matching Run Task's
existing taxonomy exactly, deliberately no auto-classifier). Pick one, send
a message, and it routes through the exact same ranking + Pro/Starter
fallback-chain + tier-gating logic Run Task already uses — same keys, same
`.modelglass/routing-rules.json` support, same client-side-only execution
(ADR-0012 unchanged: still no Modelglass proxy in the request path). Requires
VS Code 1.104+ (bumped from 1.85 — this is the first release needing it);
gracefully no-ops on older installs, every existing command is unaffected
either way.

New capability underneath this, usable from Run Task too in the future:
`provider-execute.ts`'s adapters now accept a full multi-turn conversation
(`ChatMessage[]`), not just one flattened string — necessary since Copilot
Chat forwards real conversation history on every call, something Run Task
itself has never sent.

**Also folds in the SCO-332 unroutable-category/provider design** decided
alongside this: the provider setup picker (**Set/Add Provider API Key**) now
shows each provider's live routable-category coverage ("7/9 categories
routable today") right in the picker, before you paste a key — not only as
a warning afterward. **Run Task**'s category picker does the same, plus
notes when a category (like Library-aware feature work) is empty for
*every* provider due to an industry-wide benchmark gap, not a Modelglass
one. Nothing is hidden — every option stays selectable; the gap is just
visible earlier.

## 0.3.2 — 2026-07-27

The remaining two pre-video fixes from SCO-329's honest gap review (SCO-330),
both about what a Run Task demo actually looks like on camera:

- **Editor context (SCO-330).** Run Task now attaches your current
  selection — or the whole file, if nothing's selected — as context when it
  routes and calls a model, size-capped at ~8,000 characters (cut on a line
  boundary, not mid-line). Previously the model never saw the code at all,
  only your typed description of the task. No active editor: the prompt is
  unchanged from before this release.
- **Results open in an editor tab, not the Output channel (SCO-330).** The
  response now opens beside your code in its own tab — labeled with the
  category and model that produced it — instead of landing as a full text
  dump in the Output panel with nothing to do but read and copy it. Still
  non-streaming in this release; real token-by-token streaming across every
  provider adapter is a larger, separate piece of work.
- **Truncation is now detectable, not silent.** `executeAnthropic`'s
  hardcoded 4,096-token cap (with no check of whether a response was cut
  off) is raised to 8,192, and every provider adapter now reports whether a
  response was cut off at the model's max output limit. Run Task warns
  about it in both the Output channel and the result document itself, since
  the whole point of the previous fix is that you might only ever look at
  the document.

## 0.3.1 — 2026-07-27

Fourteen commits of reliability, transparency, and quality-of-ranking fixes
to Run Task, from a full honest-gap review of the 0.3.0 release (SCO-260,
SCO-329):

- **A real quality bar (SCO-330).** `.modelglass/routing-rules.json` gains a
  `minScore` field (0–1): the ranked category now picks the *cheapest model
  that clears the bar*, not the highest-scoring model regardless of price —
  fixes the case where a bug-fix task picked a $5/M, 96.2%-SWE-bench model
  over a $1.1/M, 68% one under a command literally named "Run Task on
  Cheapest Capable Model." Applies to the five benchmark-scored categories;
  a documented no-op for the four capability-rating ones. Pro-only, opt-in
  — default (no-rule) ranking is unchanged.
- **Run Task's output now shows its work (SCO-260 quick-wins #2, #5).**
  Prints the winning model's `scoreLabel` ("SWE-bench Pro 69.2%"), its
  price, and the actual run cost computed from the provider's own returned
  token usage — previously computed and silently discarded. Also surfaces
  `routing-rules.json` rule-transparency signals: stale/typo'd `priority`
  entries that matched no model, and how many models a rule excluded.
- **Setup-time capability preview (SCO-263, SCO-302).** After storing a
  provider key, immediately see which of the nine task categories it can
  actually route (and with how many models) — turns a silent zero-model
  failure into an informed setup decision. With 2+ keys configured, the
  preview shows *combined* Pro fallback-chain coverage, not just the
  just-added key's own.
- **Per-hop fallback logging + a real recovery button (SCO-277, SCO-279).**
  Each hop's classified failure now logs as it happens, not just folded
  into a final summary. An invalid-key failure notification gets a "Set
  Provider API Key" button instead of just an instruction to re-run.
- **A real upgrade prompt (SCO-261).** A Starter user with a
  `routing-rules.json` rule for the category they're running now gets the
  same real upgrade notification the second-provider-key flow already
  shows, not just an Output-channel log line.
- **Bounded timeouts everywhere (SCO-262, SCO-260 quick-win #1).** Every
  Modelglass API fetch and every provider call now has an explicit timeout
  wired into the fallback chain — a hung connection no longer spins the
  progress notification indefinitely.
- **Feed caching (SCO-264).** The model/benchmark feed is cached for ~5
  minutes; a Modelglass API blip past that window falls back to the last
  known-good feed instead of failing the run outright.
- **One `RoutableModel` per offering, not per model (SCO-280).** A model
  hosted by more than one provider (e.g. Llama 3.3 70B via Groq *and*
  Together AI) is now routable through every provider that actually offers
  it, not just whichever host happens to be cheapest.
- **`model-not-found` failure class + Pro same-provider retry (SCO-281,
  ADR-0012 Amendment 1).** A bad model-string heuristic result is now
  distinguished from a real provider error and gets one same-provider
  retry against the next-best model before the fallback chain advances.
- **Explicit `provider_model_id` support (SCO-283).** The registry can now
  set the real provider-native model string directly on an offering,
  overriding the derive-by-heuristic fallback for the cases where it was
  wrong (confirmed live for a Together AI and an OpenRouter offering).

## 0.3.0 — 2026-07-18

BYOK task router (SCO-230–234) — routes a task to the cheapest capable model
and **executes the call directly against the provider**, using your own key.
Fully client-side: no Modelglass proxy in the request path, ever.

- `Modelglass: Run Task on Cheapest Capable Model` (SCO-230/232) — picks one
  of nine task categories (bug fix/debug, new code generation, terminal/CLI/
  DevOps, library-aware feature work, refactor, test generation, doc
  generation, chat/explain, autocomplete), ranks the configured provider's
  models against Modelglass's live benchmark/capability feed
  (SWE-bench Pro/Verified, Terminal-Bench 2.1, Aider Polyglot/LiveCodeBench,
  BigCodeBench, or a capability-rating fallback per category), and calls the
  top-ranked model. Supports OpenAI, Anthropic, DeepSeek, xAI, Mistral, Groq,
  Together AI, and OpenRouter.
- `Modelglass: Set Provider API Key` / `Modelglass: Add Provider API Key`
  (SCO-232/233) — provider keys stored via `SecretStorage`, same mechanism as
  the existing free Modelglass key. **Set** is Starter's exclusive single-key
  flow; **Add** builds a multi-key set for Pro's fallback chain.
- **Starter**: one configured provider key, Modelglass-default ranking, one
  execution attempt — an invalid-key/rate-limited/network/provider failure
  surfaces clearly, no automatic retry.
- **Pro**: automatic fallback to the next-best-ranked model on a *different*
  configured provider on a failure (never retries the same provider twice),
  up to one attempt per configured provider (SCO-233). Also unlocks an
  optional `.modelglass/routing-rules.json` workspace file to override the
  default ranking per task category — exclude a provider, force
  cheapest-first, or set a custom model priority order, composing with
  (not replacing) the default engine (SCO-231).
- Pro-only capabilities are gated behind a real Pro-plan key check against
  the same free Modelglass key already in use (`POST /v1/keys/validate`,
  the same endpoint the iOS app's key-unlock flow uses) — a Starter user
  hitting a Pro action gets an explicit upgrade prompt, not a silent failure
  or confusing error (SCO-234).

## 0.2.0 — 2026-07-15

- `Modelglass: Compare Two Models` (SCO-216) — grounded model-migration diff,
  vendored from `modelglass-router-examples/switch-check`: unit-matched price
  delta + price stability (from the append-only, provenance-stamped price
  history), per-dimension capability diff, billing-unit change warnings, and
  lifecycle checks. Two-step QuickPick flow (from model, then to model or the
  feed's own suggested competitors); results render in the shared
  **Modelglass** Output panel. Cross-modality (image/llm/video/audio) and
  works on every plan tier including Free — reuses the existing
  auto-provisioned key, no new auth.

## 0.1.0 — 2026-07-15

Initial MVP (SCO-211):

- `Modelglass: Route Task to Cheapest Capable Model` — single-subtask LLM
  routing (coding + writing/general), ranked by SWE-bench Verified or
  instruction-following against the live Modelglass feed.
- `Modelglass: Set API Key` — manual entry/reset.
- Silent free-key auto-provisioning on first use, stored via `SecretStorage`.
