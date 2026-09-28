import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { activePrice } from "./active-price.js";
import { headlinePrice } from "./routing-engine.js";
import { currentPrice as libCurrentPrice, headlinePrice as libHeadlinePrice } from "./lib.js";

// SCO-663: same rule as @modelglass/core activePrice() since SCO-661.
const TODAY = "2026-09-28";
const row = (amount: number, from: string, to?: string, unit = "per_1m_tokens_input") => ({
  amount, currency: "USD", unit, effective_from: from, ...(to ? { effective_to: to } : {}),
});
// DeepSeek V4-Pro (superseded row listed LAST on purpose) and V4-Flash (retired 2026-09-10).
const v4Pro = [row(1.32, "2026-08-16"), row(0.435, "2026-08-04")];
const v4Flash = [row(0.14, "2026-08-04"), row(0.44, "2026-08-16", "2026-09-09")];

describe("activePrice (SCO-663)", () => {
  test("V4-Pro: the later open row wins ($1.32, not $0.435)", () => {
    assert.equal(activePrice(v4Pro, TODAY)?.amount, 1.32);
  });
  test("V4-Flash: superseded open row + ended later row = no current price", () => {
    assert.equal(activePrice(v4Flash, TODAY), null);
  });
  test("o3 shape unchanged; per-unit scope; future rows don't count yet", () => {
    assert.equal(activePrice([row(10, "2025-04-16", "2026-08-28"), row(2, "2026-08-29")], TODAY)?.amount, 2);
    assert.equal(activePrice([row(1, "2026-01-01", undefined, "per_image"), row(2, "2026-02-01", "2026-03-01", "per_megapixel")], TODAY)?.amount, 1);
    assert.equal(activePrice([row(1, "2026-01-01"), row(2, "2026-12-01")], TODAY)?.amount, 1);
  });
});

describe("pricing paths use it (SCO-663)", () => {
  // These read today's real date; the fixtures are all in the past, so the result is the same.
  test("routing-engine headlinePrice: V4-Pro $1.32, V4-Flash none", () => {
    assert.equal(headlinePrice([{ id: "input", pricing: v4Pro }], "per_1m_tokens_input"), 1.32);
    assert.equal(headlinePrice([{ id: "input", pricing: v4Flash }], "per_1m_tokens_input"), null);
  });
  test("lib.ts currentPrice/headlinePrice: no longer the last array element", () => {
    assert.equal(libHeadlinePrice([{ id: "input", pricing: v4Pro }], "per_1m_tokens_input"), 1.32);
    assert.equal(libCurrentPrice([{ id: "input", pricing: v4Flash }], "input"), null);
  });
});
