import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  MEDIA_MODELGLASS_API,
  fetchMediaModels,
  normaliseMediaOfferings,
  rankMediaModelsByPrice,
  type MediaModelEntry,
} from "./media-routing-lib.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("fetchMediaModels", () => {
  test("requests the right modality filter with the Bearer key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { ok: true, data: [] });
    }) as typeof fetch;

    await fetchMediaModels("mg-key", "video");
    assert.equal(calls[0]!.url, `${MEDIA_MODELGLASS_API}/v1/models?modality=video`);
    assert.equal((calls[0]!.init.headers as Record<string, string>)["Authorization"], "Bearer mg-key");
  });

  test("throws with the status/body on a non-ok response", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await assert.rejects(() => fetchMediaModels("mg-key", "audio"), /500/);
  });
});

describe("normaliseMediaOfferings", () => {
  const entry: MediaModelEntry = {
    model_id: "runway/gen-4-5",
    name: "Gen-4.5",
    offerings: [
      {
        slug: "gen-4-5-runway",
        provider: "runway",
        quality_tier: "standard",
        model: { id: "runway/gen-4-5", modality: "image-to-video", status: "ga" },
        tiers: [
          {
            id: "standard",
            pricing: [{ amount: 0.05, currency: "USD", unit: "per_second", effective_from: "2026-01-01" }],
          },
        ],
      },
    ],
  };

  test("produces one RoutableMediaModel per offering with the current price", () => {
    const [model] = normaliseMediaOfferings(entry);
    assert.equal(model!.provider, "runway");
    assert.equal(model!.subModality, "image-to-video");
    assert.deepEqual(model!.price, { amount: 0.05, unit: "per_second", currency: "USD" });
  });

  test("prefers the tier with no effective_to (currently active) over an expired one", () => {
    const withHistory: MediaModelEntry = {
      ...entry,
      offerings: [
        {
          ...entry.offerings[0]!,
          tiers: [
            {
              id: "standard",
              pricing: [
                { amount: 0.08, currency: "USD", unit: "per_second", effective_from: "2025-01-01", effective_to: "2026-01-01" },
                { amount: 0.05, currency: "USD", unit: "per_second", effective_from: "2026-01-01" },
              ],
            },
          ],
        },
      ],
    };
    const [model] = normaliseMediaOfferings(withHistory);
    assert.equal(model!.price!.amount, 0.05);
  });

  test("an offering with no pricing at all normalises to a null price, not a crash", () => {
    const noPricing: MediaModelEntry = {
      ...entry,
      offerings: [{ ...entry.offerings[0]!, tiers: [] }],
    };
    const [model] = normaliseMediaOfferings(noPricing);
    assert.equal(model!.price, null);
  });
});

describe("rankMediaModelsByPrice", () => {
  const models = [
    { name: "A", slug: "a", provider: "runway", modelId: "runway/a", subModality: "text-to-video", price: { amount: 0.2, unit: "per_second", currency: "USD" } },
    { name: "B", slug: "b", provider: "runway", modelId: "runway/b", subModality: "text-to-video", price: { amount: 0.05, unit: "per_second", currency: "USD" } },
    { name: "C", slug: "c", provider: "fal", modelId: "fal/c", subModality: "text-to-video", price: { amount: 0.01, unit: "per_second", currency: "USD" } },
    { name: "D", slug: "d", provider: "runway", modelId: "runway/d", subModality: "image-to-video", price: null },
  ];

  test("filters to the given provider and sorts cheapest-first", () => {
    const ranked = rankMediaModelsByPrice(models, "runway");
    assert.deepEqual(ranked.map((m) => m.name), ["B", "A", "D"]);
  });

  test("a null-priced model sorts last, not dropped", () => {
    const ranked = rankMediaModelsByPrice(models, "runway");
    assert.equal(ranked[ranked.length - 1]!.name, "D");
  });

  test("an out-of-scope provider (fal.ai) never appears even though it's in the pool", () => {
    const ranked = rankMediaModelsByPrice(models, "runway");
    assert.ok(!ranked.some((m) => m.provider === "fal"));
  });

  test("an optional subModality filter narrows further", () => {
    const ranked = rankMediaModelsByPrice(models, "runway", "text-to-video");
    assert.deepEqual(ranked.map((m) => m.name), ["B", "A"]);
  });
});
