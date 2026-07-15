# Changelog

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
