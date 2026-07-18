# Changelog

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
