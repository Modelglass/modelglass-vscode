# Changelog

## 0.1.0 — Unreleased

Initial MVP (SCO-211):

- `Modelglass: Route Task to Cheapest Capable Model` — single-subtask LLM
  routing (coding + writing/general), ranked by SWE-bench Verified or
  instruction-following against the live Modelglass feed.
- `Modelglass: Set API Key` — manual entry/reset.
- Silent free-key auto-provisioning on first use, stored via `SecretStorage`.
