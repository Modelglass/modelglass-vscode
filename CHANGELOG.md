# Changelog

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
