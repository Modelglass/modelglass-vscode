/**
 * SCO-646 — tests for the shared headline-tier rule.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as PricingMath from "modelglass-router-examples/pricing-math";
import { isHeadlineTier, NON_HEADLINE_UNITS, type HasTierIdentity } from "./headline-tier.js";
import { headlinePrice } from "./lib.js";

describe("isHeadlineTier (SCO-646)", () => {
  test("accepts standard and context-length tiers", () => {
    assert.equal(isHeadlineTier({ id: "input" }), true);
    assert.equal(isHeadlineTier({ id: "input-256k" }), true);
    assert.equal(isHeadlineTier({ id: "input", attributes: { processing: "standard" } }), true);
    // Audio STT's standard mode can be named after "batch" transcription —
    // only the id prefix / processing attribute count, not the word itself.
    assert.equal(isHeadlineTier({ id: "prerecorded" }), true);
  });

  test("rejects batch / flex / cached tiers, by attribute or by id prefix", () => {
    assert.equal(isHeadlineTier({ id: "batch-input", attributes: { processing: "batch" } }), false);
    assert.equal(isHeadlineTier({ id: "input", attributes: { processing: "flex" } }), false);
    assert.equal(isHeadlineTier({ id: "batch-input" }), false);
    assert.equal(isHeadlineTier({ id: "cached-input" }), false);
  });

  test("rejects prompt-cache units whatever the tier id (ADR-0015)", () => {
    assert.equal(isHeadlineTier({ id: "cached-input", pricing: [{ unit: "per_1m_tokens_cache_read" }] }), false);
    assert.equal(isHeadlineTier({ id: "prompt-cache", pricing: [{ unit: "per_1m_tokens_cache_read" }] }), false);
    assert.equal(isHeadlineTier({ id: "writes", pricing: [{ unit: "per_1m_tokens_cache_write" }] }), false);
    assert.equal(isHeadlineTier({ id: "input", pricing: [{ unit: "per_1m_tokens_input" }] }), true);
  });
});

describe("NON_HEADLINE_UNITS (SCO-653)", () => {
  test("is pricing-math's list (generated from @modelglass/core), not a copy", () => {
    assert.equal(NON_HEADLINE_UNITS, PricingMath.NON_HEADLINE_UNITS);
  });
  test("every unit on it makes a tier non-headline, whatever the tier is called", () => {
    for (const unit of PricingMath.NON_HEADLINE_UNIT_LIST) {
      assert.equal(isHeadlineTier({ id: "input", pricing: [{ unit }] }), false, unit);
    }
  });
});

describe("attributes.headline: false (ADR-0026)", () => {
  const flaggedTiers: HasTierIdentity[] = [
    { id: "image-output", attributes: { headline: false, token_modality: "image" }, pricing: [{ unit: "per_1m_tokens_output" }] },
    { id: "standard", attributes: { headline: false }, pricing: [{ unit: "per_image" }] },
    { id: "input", attributes: { headline: "false" }, pricing: [{ unit: "per_1m_tokens_input" }] },
    { id: "batch-input", attributes: { headline: true }, pricing: [{ unit: "per_1m_tokens_input" }] },
    { id: "input", attributes: { headline: true }, pricing: [{ unit: "per_1m_tokens_input" }] },
  ];

  test("a tier marked headline: false is never a headline price, whatever its unit or id", () => {
    assert.equal(isHeadlineTier(flaggedTiers[0]!), false);
    assert.equal(isHeadlineTier(flaggedTiers[1]!), false);
  });

  test("only the literal false counts, and headline: true overrides nothing", () => {
    assert.equal(isHeadlineTier(flaggedTiers[2]!), true);
    assert.equal(isHeadlineTier(flaggedTiers[3]!), false);
    assert.equal(isHeadlineTier(flaggedTiers[4]!), true);
  });

  test("agrees with the pinned pricing-math (v0.9.0) on every flagged case", () => {
    for (const t of flaggedTiers) assert.equal(isHeadlineTier(t), PricingMath.isHeadlineTier(t as never), t.id);
  });

  test("headlinePrice ranks on the text rate, not a cheaper flagged input rate", () => {
    const row = (amount: number) => [{ amount, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-01-01" }];
    const tiers = [
      { id: "audio-input", attributes: { headline: false, token_modality: "audio" }, pricing: row(0.5) },
      { id: "input", pricing: row(2) },
    ];
    assert.equal(headlinePrice(tiers as never, "per_1m_tokens_input"), 2);
  });
});

