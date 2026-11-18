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

  test("ga and deprecated offerings stay routable (deprecated still works until its retirement date)", () => {
    for (const status of ["ga", "deprecated"]) {
      assert.equal(isRoutableOffering({ model: { status } }), true, status);
    }
  });

  test("a preview offering is not routable by default (SCO-897, same rule as the API's route_task)", () => {
    assert.equal(isRoutableOffering({ model: { status: "preview" } }), false);
  });

  test("includePreview keeps a preview offering, but never a retired one", () => {
    assert.equal(isRoutableOffering({ model: { status: "preview" } }, { includePreview: true }), true);
    assert.equal(isRoutableOffering({ model: { status: "retired" } }, { includePreview: true }), false);
  });

  test("Array.filter's index argument doesn't change the result", () => {
    const offerings = [{ model: { status: "ga" } }, { model: { status: "preview" } }];
    assert.deepEqual(offerings.filter((o) => isRoutableOffering(o)).length, 1);
  });

  test("an offering with no lifecycle info (older feed shapes, fixtures) is treated as routable", () => {
    assert.equal(isRoutableOffering({}), true);
    assert.equal(isRoutableOffering({ model: {} }), true);
    assert.equal(isRoutableOffering({ model: null }), true);
  });
});

describe("normaliseOfferings with a preview model (SCO-897)", () => {
  test("Gemini 3.1 Pro (every offering preview) contributes nothing to LLM routing", async () => {
    const { normaliseOfferings } = await import("./routing-engine.js");
    const gemini = {
      model_id: "google-deepmind/gemini-3.1-pro",
      name: "Gemini 3.1 Pro",
      knowledge: null,
      offerings: [{ slug: "gemini-3-1-pro-google", provider: "google", model: { status: "preview" }, tiers: [] }],
    } as unknown as Parameters<typeof normaliseOfferings>[0];
    assert.deepEqual(normaliseOfferings(gemini), []);
    const ga = { ...gemini, offerings: [{ ...gemini.offerings[0]!, model: { status: "ga" } }] } as typeof gemini;
    assert.equal(normaliseOfferings(ga).length, 1);
  });
});
