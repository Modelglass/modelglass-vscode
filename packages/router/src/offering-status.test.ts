/**
 * SCO-633 — tests for the shared retired-offering filter.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { isRoutableOffering } from "./offering-status.js";

describe("isRoutableOffering (SCO-633)", () => {
  test("a retired offering is not routable", () => {
    assert.equal(isRoutableOffering({ model: { status: "retired" } }), false);
  });

  test("ga, preview and deprecated offerings stay routable (deprecated still works until its retirement date)", () => {
    for (const status of ["ga", "preview", "deprecated"]) {
      assert.equal(isRoutableOffering({ model: { status } }), true, status);
    }
  });

  test("an offering with no lifecycle info (older feed shapes, fixtures) is treated as routable", () => {
    assert.equal(isRoutableOffering({}), true);
    assert.equal(isRoutableOffering({ model: {} }), true);
    assert.equal(isRoutableOffering({ model: null }), true);
  });
});
