/**
 * SCO-646 — tests for the shared headline-tier rule.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { isHeadlineTier } from "./headline-tier.js";

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
});
